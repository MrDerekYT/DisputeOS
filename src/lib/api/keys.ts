import { randomBytes } from 'node:crypto';
import { audit } from '../audit';
import { hashToken, safeEqual } from '../crypto';
import { withSystem, type Db } from '../db';
import { UserError } from '../errors';
import { isStaffRole, type Role } from '../rbac';
import { rateLimit } from '../auth/rate-limit';

export const API_SCOPES = ['clients:read', 'clients:write', 'reports:write', 'disputes:read'] as const;
export type ApiScope = (typeof API_SCOPES)[number];
export const SCOPE_LABEL: Record<ApiScope, string> = {
  'clients:read': 'Read clients', 'clients:write': 'Create clients', 'reports:write': 'Push credit reports', 'disputes:read': 'Read disputes',
};

const KEY_RE = /^dosk_([a-z0-9]{8})_([A-Za-z0-9_-]{40,})$/;

export interface ApiPrincipal { keyId: string; prefix: string; orgId: string; userId: string; role: Role; scopes: ApiScope[]; name: string }

/**
 * Keys look like `dosk_ab12cd34_<secret>`. Only a SHA-256 of the whole key is stored, so a database leak does not expose
 * working keys, and the plaintext is shown exactly once at creation. A key acts as the admin who created it, inside that
 * user's row-level security — and stops working the moment that user leaves the organization.
 */
export async function createApiKey(db: Db, actor: { orgId: string; userId: string; meta?: { ip?: string | null } }, input: { name: string; scopes: ApiScope[] }): Promise<{ id: string; key: string; prefix: string }> {
  const scopes = [...new Set(input.scopes)].filter((s) => (API_SCOPES as readonly string[]).includes(s));
  if (!scopes.length) throw new UserError('Choose at least one permission for the key.');
  const prefix = randomBytes(6).toString('hex').slice(0, 8).replace(/[^a-z0-9]/g, 'a');
  const key = `dosk_${prefix}_${randomBytes(32).toString('base64url')}`;
  const row = await db.row<{ id: string }>(
    'insert into public.api_keys (org_id, name, prefix, key_hash, scopes, created_by) values ($1,$2,$3,$4,$5,$6) returning id',
    [actor.orgId, input.name.trim().slice(0, 80), prefix, hashToken(key), scopes, actor.userId]);
  await audit(db, { orgId: actor.orgId, actorId: actor.userId, action: 'api_key.created', entityType: 'api_key', entityId: row!.id, ip: actor.meta?.ip, meta: { prefix, scopes: scopes.join(',') } });
  return { id: row!.id, key, prefix };
}

export async function revokeApiKey(db: Db, actor: { orgId: string; userId: string; meta?: { ip?: string | null } }, id: string): Promise<void> {
  const r = await db.row<{ prefix: string }>('update public.api_keys set revoked_at = now() where id = $1 and revoked_at is null returning prefix', [id]);
  if (r) await audit(db, { orgId: actor.orgId, actorId: actor.userId, action: 'api_key.revoked', entityType: 'api_key', entityId: id, ip: actor.meta?.ip, meta: { prefix: r.prefix } });
}

export type AuthResult = { ok: true; principal: ApiPrincipal } | { ok: false; status: 401 | 429; error: string; retryAfter?: number };

export async function authenticateApiKey(authorization: string | null, ip: string | null): Promise<AuthResult> {
  const given = /^Bearer (.+)$/.exec(authorization ?? '')?.[1]?.trim() ?? '';
  const m = KEY_RE.exec(given);
  const ipLimit = await rateLimit(`api:ip:${ip ?? 'unknown'}`, 300, 60);
  if (!ipLimit.allowed) return { ok: false, status: 429, error: 'Too many requests', retryAfter: ipLimit.retryAfterSec };
  if (!m) return { ok: false, status: 401, error: 'Missing or malformed API key. Send "Authorization: Bearer dosk_…".' };

  const row = await withSystem((db) =>
    db.row<{ id: string; org_id: string; name: string; key_hash: string; scopes: string[]; created_by: string; revoked_at: string | null; last_used_at: string | null; role: Role | null; org_status: string }>(
      `select k.id, k.org_id, k.name, k.key_hash, k.scopes, k.created_by, k.revoked_at, k.last_used_at, m.role, o.status as org_status
         from public.api_keys k join public.organizations o on o.id = k.org_id left join public.memberships m on m.org_id = k.org_id and m.user_id = k.created_by
        where k.prefix = $1`, [m[1]]));
  // Compare against a hash even when the prefix is unknown so response time does not reveal which prefixes exist.
  const expected = row?.key_hash ?? hashToken('dosk_unknown');
  const good = safeEqual(hashToken(given), expected) && !!row;
  if (!good || !row || row.revoked_at || row.org_status !== 'active' || !row.role || !isStaffRole(row.role) || row.role === 'client')
    return { ok: false, status: 401, error: 'Invalid, revoked or expired API key.' };

  const keyLimit = await rateLimit(`api:key:${row.id}`, 120, 60);
  if (!keyLimit.allowed) return { ok: false, status: 429, error: 'Rate limit exceeded for this key (120 requests/minute)', retryAfter: keyLimit.retryAfterSec };
  if (!row.last_used_at || Date.now() - new Date(row.last_used_at).getTime() > 60_000)
    await withSystem((db) => db.run('update public.api_keys set last_used_at = now() where id = $1', [row.id]));
  return { ok: true, principal: { keyId: row.id, prefix: m[1]!, orgId: row.org_id, userId: row.created_by, role: row.role, scopes: row.scopes as ApiScope[], name: row.name } };
}
