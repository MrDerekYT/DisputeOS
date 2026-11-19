import { z } from 'zod';
import { audit } from '@/lib/audit';
import { fireTrigger } from '@/lib/automation/engine';
import { logEvent } from '@/lib/crm';
import { UserError } from '@/lib/errors';
import { apiError, ok, withApi } from '@/lib/api/route';
import { can, PermissionError } from '@/lib/rbac';

export const dynamic = 'force-dynamic';

const COLS = 'id, full_name, email, phone, status, stage, preferred_language, created_at';

export function GET(req: Request) {
  return withApi(req, 'clients:read', async (c) => {
    const q = c.url.searchParams;
    const limit = Math.min(Math.max(Number(q.get('limit')) || 25, 1), 100);
    const offset = Math.max(Number(q.get('offset')) || 0, 0);
    const where: string[] = [];
    const p: (string | number)[] = [];
    if (q.get('email')) { p.push(q.get('email')!.trim().toLowerCase()); where.push(`email = $${p.length}`); }
    if (q.get('status')) { p.push(q.get('status')!); where.push(`status = $${p.length}`); }
    const w = where.length ? `where ${where.join(' and ')}` : '';
    const out = await c.tx(async (db) => ({
      data: await db.rows(`select ${COLS} from public.clients ${w} order by created_at desc limit ${limit} offset ${offset}`, p),
      total: (await db.row<{ n: number }>(`select count(*)::int as n from public.clients ${w}`, p))?.n ?? 0,
    }));
    return ok({ ...out, limit, offset });
  });
}

const create = z.object({
  full_name: z.string().trim().min(1).max(160),
  email: z.string().trim().toLowerCase().email().max(254).optional(),
  phone: z.string().trim().max(30).optional(),
  preferred_language: z.enum(['en', 'es']).default('en'),
  status: z.enum(['lead', 'onboarding', 'active']).default('lead'),
  source: z.string().trim().max(80).optional(),
});

export function POST(req: Request) {
  return withApi(req, 'clients:write', async (c) => {
    if (!can(c.actor.role, 'clients:write')) throw new PermissionError('clients:write');
    const parsed = create.safeParse(await c.json());
    if (!parsed.success) throw new UserError(`${parsed.error.issues[0]?.path.join('.') || 'body'}: ${parsed.error.issues[0]?.message}`);
    const d = parsed.data;
    const row = await c.tx(async (db) => {
      if (d.email && (await db.row('select 1 from public.clients where email = $1', [d.email]))) return null;
      const r = await db.row<{ id: string }>(
        `insert into public.clients (org_id, full_name, email, phone, preferred_language, status, source) values ($1,$2,$3,$4,$5,$6,$7) returning ${COLS}`,
        [c.actor.orgId, d.full_name, d.email ?? null, d.phone ?? null, d.preferred_language, d.status, d.source ?? `api:${c.principal.prefix}`]);
      await logEvent(db, c.actor, r!.id, 'client_created', `Client created via API (${c.principal.name})`);
      await audit(db, { orgId: c.actor.orgId, actorId: c.actor.userId, actorLabel: c.actor.label, action: 'client.created', entityType: 'client', entityId: r!.id, ip: c.actor.meta.ip });
      await fireTrigger(db, c.actor, 'client_created', { type: 'client', id: r!.id });
      return r;
    });
    if (!row) return apiError(409, 'conflict', 'A client with that email already exists.');
    return ok(row, 201);
  });
}
