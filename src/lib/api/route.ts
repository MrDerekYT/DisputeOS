import { NextResponse } from 'next/server';
import { PermissionError } from '../rbac';
import { UserError } from '../errors';
import { withTenant, type Db } from '../db';
import { authenticateApiKey, type ApiPrincipal, type ApiScope } from './keys';

export interface ApiCtx {
  principal: ApiPrincipal;
  /** Run queries as the key's owner with row-level security enforced. */
  tx<T>(fn: (db: Db) => Promise<T>): Promise<T>;
  actor: { orgId: string; userId: string; role: ApiPrincipal['role']; label: string; meta: { ip: string | null } };
  json<T = unknown>(): Promise<T>;
  url: URL;
}

const MAX_BODY = 2_000_000;

const err = (status: number, code: string, message: string, headers: Record<string, string> = {}) =>
  NextResponse.json({ error: { code, message } }, { status, headers: { 'cache-control': 'no-store', ...headers } });

/** Wraps an API handler: authentication, scope check, rate limits, body limits and uniform JSON errors. */
export async function withApi(req: Request, scope: ApiScope, handler: (ctx: ApiCtx) => Promise<Response>): Promise<Response> {
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || null;
  const auth = await authenticateApiKey(req.headers.get('authorization'), ip);
  if (!auth.ok) return err(auth.status, auth.status === 429 ? 'rate_limited' : 'unauthorized', auth.error, auth.retryAfter ? { 'retry-after': String(auth.retryAfter) } : {});
  const p = auth.principal;
  if (!p.scopes.includes(scope)) return err(403, 'forbidden', `This key lacks the "${scope}" permission.`);

  const ctx: ApiCtx = {
    principal: p, url: new URL(req.url),
    tx: (fn) => withTenant(p.userId, fn),
    actor: { orgId: p.orgId, userId: p.userId, role: p.role, label: `api:${p.prefix}`, meta: { ip } },
    json: async <T>() => {
      const text = await req.text();
      if (text.length > MAX_BODY) throw new UserError('Request body is too large (2 MB max).');
      try { return JSON.parse(text) as T; } catch { throw new UserError('Body must be valid JSON.'); }
    },
  };
  try {
    return await handler(ctx);
  } catch (e) {
    if (e instanceof UserError) return err(422, 'invalid_request', e.message);
    if (e instanceof PermissionError) return err(403, 'forbidden', 'The key owner’s role does not allow that.');
    const code = (e as { code?: string }).code;
    if (code === '42501') return err(404, 'not_found', 'Not found.');
    console.error('[api]', e);
    return err(500, 'server_error', 'Something went wrong.');
  }
}

export const ok = (data: unknown, status = 200) => NextResponse.json(data, { status, headers: { 'cache-control': 'no-store' } });
export const notFound = () => err(404, 'not_found', 'Not found.');
export { err as apiError };
