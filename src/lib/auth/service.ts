import { auditSystem } from '../audit';
import { decryptPII, encryptPII, hashToken, randomToken } from '../crypto';
import { withSystem, type Db } from '../db';
import { getEnv } from '../env';
import { sendEmail } from '../mailer';
import { STAFF_ROLES, type Role } from '../rbac';
import { slugify } from '../util';
import { dummyHash, hashPassword, passwordProblem, verifyPassword } from './password';
import { rateLimit } from './rate-limit';
import { generateTotpSecret, otpauthUri, verifyTotp } from './totp';
import { PRODUCT } from '../product';

const STAFF_SESSION_HOURS = 12;
const CLIENT_SESSION_DAYS = 7;
const CLIENT_IDLE_MINUTES = 24 * 60;
const LOCK_AFTER = 5;
const LOCK_MINUTES = 15;

export const normEmail = (e: string) => e.trim().toLowerCase();

export interface RequestMeta {
  ip?: string | null;
  userAgent?: string | null;
}

export interface SessionInfo {
  sessionId: string;
  userId: string;
  orgId: string;
  role: Role;
  email: string;
  fullName: string;
  mfaVerified: boolean;
  totpEnabled: boolean;
  orgName: string;
  orgSlug: string;
  orgMode: 'agency' | 'personal';
  orgPlan: string;
}

type Fail = { ok: false; error: string };

// ------------------------------------------------------------------ sign up
export async function signUp(
  input: { email: string; password: string; fullName: string; orgName: string; mode: 'agency' | 'personal'; stateCode?: string },
  meta: RequestMeta = {},
): Promise<{ ok: true; userId: string; orgId: string } | Fail> {
  const email = normEmail(input.email);
  const rl = await rateLimit(`signup:ip:${meta.ip ?? 'unknown'}`, 10, 3600);
  if (!rl.allowed) return { ok: false, error: 'Too many sign-up attempts. Try again later.' };
  const problem = passwordProblem(input.password, email);
  if (problem) return { ok: false, error: problem };
  const hash = await hashPassword(input.password);

  return withSystem(async (db) => {
    if (await db.row('select 1 from public.users where email = $1', [email]))
      return { ok: false, error: 'An account with this email already exists. Sign in instead.' } as Fail;
    const user = await db.row<{ id: string }>(
      'insert into public.users (email, password_hash, full_name) values ($1, $2, $3) returning id',
      [email, hash, input.fullName.trim()],
    );
    const slug = `${slugify(input.orgName)}-${randomToken(3).toLowerCase().replace(/[^a-z0-9]/g, 'x')}`;
    const org = await db.row<{ id: string }>(
      `insert into public.organizations (name, slug, mode, state_code, trial_ends_at, settings)
       values ($1, $2, $3, $4, now() + interval '14 days', $5) returning id`,
      [input.orgName.trim(), slug, input.mode, input.stateCode || null, JSON.stringify({ retention_days: 2555 })],
    );
    await db.run("insert into public.memberships (org_id, user_id, role) values ($1, $2, 'owner')", [org!.id, user!.id]);
    if (input.mode === 'personal') {
      await db.run(
        "insert into public.clients (org_id, full_name, email, status) values ($1, $2, $3, 'active')",
        [org!.id, input.fullName.trim() || 'Me', email],
      );
    }
    await db.run(
      `insert into public.audit_logs (org_id, actor_id, action, entity_type, entity_id, ip) values ($1, $2, 'org.created', 'organization', $1, $3)`,
      [org!.id, user!.id, meta.ip ?? null],
    );
    return { ok: true, userId: user!.id, orgId: org!.id } as const;
  });
}

// ------------------------------------------------------------------ sessions
export async function createSession(
  userId: string,
  orgId: string,
  role: Role,
  meta: RequestMeta,
  mfaVerified = false,
): Promise<string> {
  const token = randomToken(32);
  const hours = role === 'client' ? CLIENT_SESSION_DAYS * 24 : STAFF_SESSION_HOURS;
  await withSystem((db) =>
    db.run(
      `insert into public.sessions (user_id, org_id, token_hash, mfa_verified, ip, user_agent, expires_at)
       values ($1, $2, $3, $4, $5, $6, now() + ($7 || ' hours')::interval)`,
      [userId, orgId, hashToken(token), mfaVerified, meta.ip ?? null, meta.userAgent?.slice(0, 300) ?? null, String(hours)],
    ),
  );
  return token;
}

export async function getSession(token: string | undefined): Promise<SessionInfo | null> {
  if (!token || token.length < 20 || token.length > 200) return null;
  return withSystem(async (db) => {
    const r = await db.row<{
      id: string; user_id: string; org_id: string; mfa_verified: boolean; last_seen_at: string;
      email: string; full_name: string; totp_enabled: boolean; disabled_at: string | null;
      role: Role; org_name: string; org_slug: string; org_mode: 'agency' | 'personal'; org_status: string; plan: string;
    }>(
      `select s.id, s.user_id, s.org_id, s.mfa_verified, s.last_seen_at, u.email, u.full_name, u.totp_enabled, u.disabled_at,
              m.role, o.name as org_name, o.slug as org_slug, o.mode as org_mode, o.status as org_status, o.plan
         from public.sessions s
         join public.users u on u.id = s.user_id
         join public.organizations o on o.id = s.org_id
         join public.memberships m on m.org_id = s.org_id and m.user_id = s.user_id
        where s.token_hash = $1 and s.revoked_at is null and s.expires_at > now()`,
      [hashToken(token)],
    );
    if (!r || r.disabled_at || r.org_status !== 'active') return null;
    const idleMin = r.role === 'client' ? CLIENT_IDLE_MINUTES : getEnv().STAFF_IDLE_MINUTES;
    const idleMs = Date.now() - new Date(r.last_seen_at).getTime();
    if (idleMs > idleMin * 60_000) {
      await db.run('update public.sessions set revoked_at = now() where id = $1', [r.id]);
      return null;
    }
    if (idleMs > 60_000) await db.run('update public.sessions set last_seen_at = now() where id = $1', [r.id]);
    return {
      sessionId: r.id, userId: r.user_id, orgId: r.org_id, role: r.role, email: r.email, fullName: r.full_name,
      mfaVerified: r.mfa_verified, totpEnabled: r.totp_enabled, orgName: r.org_name, orgSlug: r.org_slug, orgMode: r.org_mode, orgPlan: r.plan,
    };
  });
}

export const revokeSession = (token: string) =>
  withSystem((db) => db.run('update public.sessions set revoked_at = now() where token_hash = $1 and revoked_at is null', [hashToken(token)]));

export const revokeAllSessions = (userId: string, exceptSessionId?: string) =>
  withSystem((db) =>
    db.run('update public.sessions set revoked_at = now() where user_id = $1 and revoked_at is null and ($2::uuid is null or id <> $2)', [userId, exceptSessionId ?? null]),
  );

// ------------------------------------------------------------------ sign in
export async function authenticate(
  input: { email: string; password: string; portal?: boolean },
  meta: RequestMeta = {},
): Promise<{ ok: true; token: string; role: Role; needsMfa: boolean; needsEnrollment: boolean } | Fail> {
  const email = normEmail(input.email);
  const generic: Fail = { ok: false, error: 'Incorrect email or password.' };
  const ipLimit = await rateLimit(`login:ip:${meta.ip ?? 'unknown'}`, 30, 900);
  const mailLimit = await rateLimit(`login:email:${email}`, 10, 900);
  if (!ipLimit.allowed || !mailLimit.allowed) {
    return { ok: false, error: `Too many attempts. Try again in ${Math.ceil(Math.max(ipLimit.retryAfterSec, mailLimit.retryAfterSec) / 60)} minute(s).` };
  }

  const user = await withSystem((db) =>
    db.row<{ id: string; password_hash: string; failed_logins: number; locked_until: string | null; disabled_at: string | null; totp_enabled: boolean }>(
      'select id, password_hash, failed_logins, locked_until, disabled_at, totp_enabled from public.users where email = $1',
      [email],
    ),
  );
  if (!user) {
    await verifyPassword(input.password, await dummyHash()); // equalise timing
    return generic;
  }
  if (user.locked_until && new Date(user.locked_until) > new Date()) {
    return { ok: false, error: 'This account is temporarily locked after repeated failures. Try again later or reset your password.' };
  }
  const good = !user.disabled_at && (await verifyPassword(input.password, user.password_hash));
  if (!good) {
    const locked = await withSystem(async (db) => {
      const r = await db.row<{ failed_logins: number }>(
        `update public.users set failed_logins = failed_logins + 1 where id = $1 returning failed_logins`,
        [user.id],
      );
      if ((r?.failed_logins ?? 0) >= LOCK_AFTER) {
        await db.run(`update public.users set failed_logins = 0, locked_until = now() + ($2 || ' minutes')::interval where id = $1`, [user.id, String(LOCK_MINUTES)]);
        return true;
      }
      return false;
    });
    await auditSystem({ orgId: null, actorId: user.id, action: locked ? 'auth.locked' : 'auth.failed', entityType: 'user', entityId: user.id, ip: meta.ip });
    return generic;
  }

  const membership = await withSystem(async (db) => {
    await db.run('update public.users set failed_logins = 0, locked_until = null, last_login_at = now() where id = $1', [user.id]);
    return db.row<{ org_id: string; role: Role }>(
      `select m.org_id, m.role from public.memberships m join public.organizations o on o.id = m.org_id
        where m.user_id = $1 and o.status = 'active'
        order by (m.role = 'client') asc, m.created_at asc limit 1`,
      [user.id],
    );
  });
  if (!membership) return generic;
  const isStaff = (STAFF_ROLES as string[]).includes(membership.role);
  if (input.portal && isStaff) return { ok: false, error: 'This sign-in is for clients. Staff sign in at /login.' };
  if (!input.portal && !isStaff) return { ok: false, error: 'Clients sign in through the client portal.' };

  const token = await createSession(user.id, membership.org_id, membership.role, meta, false);
  await auditSystem({ orgId: membership.org_id, actorId: user.id, action: 'auth.login', entityType: 'user', entityId: user.id, ip: meta.ip });
  const mfaRequired = isStaff && getEnv().REQUIRE_STAFF_MFA === 'true';
  return {
    ok: true, token, role: membership.role,
    needsMfa: user.totp_enabled,
    needsEnrollment: mfaRequired && !user.totp_enabled,
  };
}

// ------------------------------------------------------------------ MFA (TOTP)
export async function beginTotpEnrollment(userId: string): Promise<{ secret: string; uri: string } | Fail> {
  return withSystem(async (db) => {
    const u = await db.row<{ email: string; totp_enabled: boolean }>('select email, totp_enabled from public.users where id = $1', [userId]);
    if (!u) return { ok: false, error: 'User not found.' } as Fail;
    if (u.totp_enabled) return { ok: false, error: 'Two-step verification is already on.' } as Fail;
    // Idempotent: re-rendering the setup page must not replace the secret the user just added to their app.
    const pending = await db.row<{ totp_secret_encrypted: string | null }>('select totp_secret_encrypted from public.users where id = $1', [userId]);
    if (pending?.totp_secret_encrypted) {
      const existing = decryptPII(pending.totp_secret_encrypted);
      return { secret: existing, uri: otpauthUri(existing, u.email) };
    }
    const secret = generateTotpSecret();
    await db.run('update public.users set totp_secret_encrypted = $2, totp_last_step = null where id = $1', [userId, encryptPII(secret)]);
    return { secret, uri: otpauthUri(secret, u.email) };
  });
}

export async function confirmTotp(userId: string, sessionId: string, code: string, enroll: boolean): Promise<{ ok: true } | Fail> {
  const rl = await rateLimit(`mfa:user:${userId}`, 10, 600);
  if (!rl.allowed) return { ok: false, error: 'Too many attempts. Wait a few minutes and try again.' };
  return withSystem(async (db) => {
    const u = await db.row<{ totp_secret_encrypted: string | null; totp_enabled: boolean; totp_last_step: number | null }>(
      'select totp_secret_encrypted, totp_enabled, totp_last_step from public.users where id = $1', [userId]);
    if (!u?.totp_secret_encrypted) return { ok: false, error: 'Start setup again to get a new secret.' } as Fail;
    if (enroll === u.totp_enabled) return { ok: false, error: enroll ? 'Already enabled.' : 'Two-step verification is not set up.' } as Fail;
    const step = verifyTotp(decryptPII(u.totp_secret_encrypted), code.trim(), u.totp_last_step);
    if (step == null) return { ok: false, error: 'That code is not valid. Check your authenticator app and try again.' } as Fail;
    await db.run('update public.users set totp_enabled = true, totp_last_step = $2 where id = $1', [userId, step]);
    await db.run('update public.sessions set mfa_verified = true where id = $1', [sessionId]);
    return { ok: true } as const;
  });
}

/** Admins can reset a teammate's second factor (lost phone). Owners cannot be reset this way. */
export async function adminResetMfa(orgId: string, targetUserId: string): Promise<boolean> {
  return withSystem(async (s) => {
    const t = await s.row<{ role: Role }>('select role from public.memberships where org_id = $1 and user_id = $2', [orgId, targetUserId]);
    if (!t || t.role === 'owner') return false;
    await s.run('update public.users set totp_enabled = false, totp_secret_encrypted = null, totp_last_step = null where id = $1', [targetUserId]);
    await s.run('update public.sessions set revoked_at = now() where user_id = $1 and revoked_at is null', [targetUserId]);
    return true;
  });
}

// ------------------------------------------------------------------ password reset
export async function requestPasswordReset(emailIn: string, meta: RequestMeta = {}): Promise<void> {
  const email = normEmail(emailIn);
  const rl = await rateLimit(`reset:email:${email}`, 3, 3600);
  const rlIp = await rateLimit(`reset:ip:${meta.ip ?? 'unknown'}`, 10, 3600);
  if (!rl.allowed || !rlIp.allowed) return; // silent: never reveal limits or existence
  const user = await withSystem((db) =>
    db.row<{ id: string }>('select id from public.users where email = $1 and disabled_at is null', [email]));
  if (!user) return;
  const token = randomToken(32);
  await withSystem((db) =>
    db.run(`insert into public.password_resets (user_id, token_hash, expires_at) values ($1, $2, now() + interval '1 hour')`, [user.id, hashToken(token)]));
  const link = `${getEnv().APP_URL}/reset-password?token=${token}`;
  await sendEmail({
    to: email,
    subject: `Reset your ${PRODUCT.name} password`,
    text: `We received a request to reset your password.\n\nUse this link within 1 hour:\n${link}\n\nIf you did not request this, you can ignore this email — your password will not change.`,
  });
  await auditSystem({ orgId: null, actorId: user.id, action: 'auth.reset_requested', entityType: 'user', entityId: user.id, ip: meta.ip });
}

export async function resetPassword(token: string, newPassword: string): Promise<{ ok: true } | Fail> {
  const row = await withSystem((db) =>
    db.row<{ id: string; user_id: string; email: string }>(
      `select r.id, r.user_id, u.email from public.password_resets r join public.users u on u.id = r.user_id
        where r.token_hash = $1 and r.used_at is null and r.expires_at > now()`, [hashToken(token)]));
  if (!row) return { ok: false, error: 'This reset link is invalid or has expired. Request a new one.' };
  const problem = passwordProblem(newPassword, row.email);
  if (problem) return { ok: false, error: problem };
  const hash = await hashPassword(newPassword);
  await withSystem(async (db) => {
    await db.run('update public.users set password_hash = $2, failed_logins = 0, locked_until = null where id = $1', [row.user_id, hash]);
    await db.run('update public.password_resets set used_at = now() where user_id = $1 and used_at is null', [row.user_id]);
    await db.run('update public.sessions set revoked_at = now() where user_id = $1 and revoked_at is null', [row.user_id]);
  });
  await auditSystem({ orgId: null, actorId: row.user_id, action: 'auth.password_reset', entityType: 'user', entityId: row.user_id });
  return { ok: true };
}

export async function changePassword(userId: string, current: string, next: string, keepSessionId?: string): Promise<{ ok: true } | Fail> {
  const u = await withSystem((db) => db.row<{ password_hash: string; email: string }>('select password_hash, email from public.users where id = $1', [userId]));
  if (!u || !(await verifyPassword(current, u.password_hash))) return { ok: false, error: 'Your current password is incorrect.' };
  const problem = passwordProblem(next, u.email);
  if (problem) return { ok: false, error: problem };
  const hash = await hashPassword(next);
  await withSystem((db) => db.run('update public.users set password_hash = $2 where id = $1', [userId, hash]));
  await revokeAllSessions(userId, keepSessionId);
  return { ok: true };
}

// ------------------------------------------------------------------ invitations (staff + client portal)
export interface InviteView {
  id: string; orgId: string; orgName: string; email: string; role: Role; clientId: string | null; clientName: string | null;
}

export async function createInviteToken(db: Db, args: { orgId: string; email: string; role: Exclude<Role, 'owner'>; clientId?: string | null; invitedBy: string }): Promise<string> {
  const token = randomToken(32);
  await db.run(
    `insert into public.invites (org_id, email, role, client_id, token_hash, invited_by, expires_at)
     values ($1, $2, $3, $4, $5, $6, now() + interval '7 days')`,
    [args.orgId, normEmail(args.email), args.role, args.clientId ?? null, hashToken(token), args.invitedBy],
  );
  return token;
}

export async function getInvite(token: string): Promise<InviteView | null> {
  const r = await withSystem((db) =>
    db.row<{ id: string; org_id: string; org_name: string; email: string; role: Role; client_id: string | null; client_name: string | null }>(
      `select i.id, i.org_id, o.name as org_name, i.email, i.role, i.client_id, c.full_name as client_name
         from public.invites i join public.organizations o on o.id = i.org_id left join public.clients c on c.id = i.client_id
        where i.token_hash = $1 and i.accepted_at is null and i.expires_at > now() and o.status = 'active'`, [hashToken(token)]));
  return r ? { id: r.id, orgId: r.org_id, orgName: r.org_name, email: r.email, role: r.role, clientId: r.client_id, clientName: r.client_name } : null;
}

export async function acceptInvite(token: string, input: { fullName: string; password: string }, meta: RequestMeta = {}): Promise<{ ok: true; token: string; role: Role } | Fail> {
  const inv = await getInvite(token);
  if (!inv) return { ok: false, error: 'This invitation is invalid or has expired.' };
  const rl = await rateLimit(`invite:ip:${meta.ip ?? 'unknown'}`, 20, 3600);
  if (!rl.allowed) return { ok: false, error: 'Too many attempts. Try again later.' };

  const result = await withSystem(async (db): Promise<Fail | { ok: true; userId: string }> => {
    const existing = await db.row<{ id: string; password_hash: string }>('select id, password_hash from public.users where email = $1', [inv.email]);
    let userId: string;
    if (existing) {
      if (!(await verifyPassword(input.password, existing.password_hash))) return { ok: false, error: 'An account with this email exists; enter its current password to join.' };
      userId = existing.id;
    } else {
      const problem = passwordProblem(input.password, inv.email);
      if (problem) return { ok: false, error: problem };
      const created = await db.row<{ id: string }>(
        'insert into public.users (email, password_hash, full_name, email_verified_at) values ($1, $2, $3, now()) returning id',
        [inv.email, await hashPassword(input.password), input.fullName.trim()],
      );
      userId = created!.id;
    }
    if (await db.row('select 1 from public.memberships where org_id = $1 and user_id = $2', [inv.orgId, userId]))
      return { ok: false, error: 'You are already a member of this organization.' };
    await db.run('insert into public.memberships (org_id, user_id, role) values ($1, $2, $3)', [inv.orgId, userId, inv.role]);
    if (inv.role === 'client' && inv.clientId) {
      const linked = await db.run(
        `update public.clients set portal_user_id = $2, status = case when status = 'lead' then 'onboarding' else status end
          where id = $1 and org_id = $3 and portal_user_id is null`, [inv.clientId, userId, inv.orgId]);
      if (!linked) throw new Error('Client record is already linked to a portal account');
      await db.run(
        `insert into public.client_events (org_id, client_id, actor_id, kind, summary) values ($1, $2, $3, 'portal_joined', 'Client activated their portal account')`,
        [inv.orgId, inv.clientId, userId]);
    }
    await db.run('update public.invites set accepted_at = now() where id = $1', [inv.id]);
    return { ok: true, userId };
  }).catch((e: Error) => ({ ok: false, error: e.message }) as Fail);
  if (!result.ok) return result;
  const session = await createSession(result.userId, inv.orgId, inv.role, meta, false);
  await auditSystem({ orgId: inv.orgId, actorId: result.userId, action: 'invite.accepted', entityType: 'invite', entityId: inv.id, ip: meta.ip, meta: { role: inv.role } });
  return { ok: true, token: session, role: inv.role };
}
