import { cache } from 'react';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { withTenant, type Db } from '../db';
import { cookieSecure, getEnv } from '../env';
import { can, isStaffRole, PermissionError, type Permission, type Role } from '../rbac';
import { getSession, type RequestMeta, type SessionInfo } from './service';

export const SESSION_COOKIE = 'dos_session';

export async function setSessionCookie(token: string, role: Role) {
  const maxAge = role === 'client' ? 7 * 86400 : 12 * 3600;
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: cookieSecure(),
    path: '/',
    maxAge,
  });
}

export async function clearSessionCookie() {
  (await cookies()).delete(SESSION_COOKIE);
}

export async function sessionToken(): Promise<string | undefined> {
  return (await cookies()).get(SESSION_COOKIE)?.value;
}

export async function requestMeta(): Promise<RequestMeta> {
  const h = await headers();
  const fwd = h.get('x-forwarded-for')?.split(',')[0]?.trim();
  return { ip: fwd || h.get('x-real-ip') || null, userAgent: h.get('user-agent') };
}

export const currentSession = cache(async (): Promise<SessionInfo | null> => getSession(await sessionToken()));

export interface Ctx {
  session: SessionInfo;
  userId: string;
  orgId: string;
  role: Role;
  /** Run queries as this user with PostgreSQL row-level security enforced. */
  tx<T>(fn: (db: Db) => Promise<T>): Promise<T>;
  can(perm: Permission): boolean;
  /** Throws PermissionError (caught by the action wrapper) when the role lacks the permission. */
  need(perm: Permission): void;
  meta: RequestMeta;
}

async function build(session: SessionInfo): Promise<Ctx> {
  return {
    session,
    userId: session.userId,
    orgId: session.orgId,
    role: session.role,
    tx: (fn) => withTenant(session.userId, fn),
    can: (p) => can(session.role, p),
    need: (p) => {
      if (!can(session.role, p)) throw new PermissionError(p);
    },
    meta: await requestMeta(),
  };
}

/** Pages and actions for agency staff. Redirects unauthenticated users and enforces second-factor policy. */
export async function requireStaff(perm?: Permission): Promise<Ctx> {
  const s = await currentSession();
  if (!s) redirect('/login');
  if (!isStaffRole(s.role) || s.role === 'client') redirect('/portal');
  const mfaRequired = getEnv().REQUIRE_STAFF_MFA === 'true';
  if (mfaRequired && !s.totpEnabled) redirect('/mfa/setup');
  if (s.totpEnabled && !s.mfaVerified) redirect('/mfa');
  const ctx = await build(s);
  if (perm && !ctx.can(perm)) redirect('/app?denied=1');
  return ctx;
}

/** Client-portal pages: the signed-in user must hold the `client` role. */
export async function requireClient(): Promise<Ctx & { clientId: string }> {
  const s = await currentSession();
  if (!s) redirect('/portal/login');
  if (s.role !== 'client') redirect('/app');
  if (s.totpEnabled && !s.mfaVerified) redirect('/mfa');
  const ctx = await build(s);
  const client = await ctx.tx((db) => db.row<{ id: string }>('select id from public.clients where portal_user_id = $1', [s.userId]));
  if (!client) redirect('/portal/login?error=no-record');
  return Object.assign(ctx, { clientId: client.id });
}

/** For the MFA pages: a signed-in user who may not have completed the second factor yet. */
export async function requireSessionAnyStage(): Promise<SessionInfo> {
  const s = await currentSession();
  if (!s) redirect('/login');
  return s;
}
