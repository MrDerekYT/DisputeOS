import { afterAll, describe, expect, it } from 'vitest';
import {
  acceptInvite, adminResetMfa, authenticate, beginTotpEnrollment, changePassword, confirmTotp, createInviteToken, getInvite,
  getSession, requestPasswordReset, resetPassword, revokeSession, signUp,
} from '@/lib/auth/service';
import { rateLimit } from '@/lib/auth/rate-limit';
import { totpNow } from '@/lib/auth/totp';
import { sentLog } from '@/lib/mailer';
import { PASSWORD, addClient, asUser, closePool, makeOrg, testIp, uniq, withSystem } from './helpers';

afterAll(closePool);

const newUser = async (ip = testIp()) => {
  const email = `u-${uniq()}@test.dev`;
  const r = await signUp({ email, password: PASSWORD, fullName: 'Pat Example', orgName: 'Pat Agency', mode: 'agency' }, { ip });
  if (!r.ok) throw new Error(r.error);
  return { email, ...r, ip };
};

describe('sign up', () => {
  it('creates an organization with the creator as owner and a trial', async () => {
    const u = await newUser();
    const row = await withSystem((db) => db.row<{ role: string; plan: string; trial: boolean }>(
      `select m.role, o.plan, o.trial_ends_at > now() as trial from public.memberships m join public.organizations o on o.id = m.org_id where m.user_id = $1`, [u.userId]));
    expect(row).toEqual({ role: 'owner', plan: 'trial', trial: true });
  });
  it('rejects duplicate emails (case-insensitively) and weak passwords', async () => {
    const u = await newUser();
    const dup = await signUp({ email: u.email.toUpperCase(), password: PASSWORD, fullName: 'x', orgName: 'x', mode: 'agency' }, { ip: testIp() });
    expect(dup.ok).toBe(false);
    const weak = await signUp({ email: `w-${uniq()}@test.dev`, password: 'password123', fullName: 'x', orgName: 'x', mode: 'agency' }, { ip: testIp() });
    expect(weak).toMatchObject({ ok: false });
  });
  it('personal mode also creates the person’s own client record', async () => {
    const email = `p-${uniq()}@test.dev`;
    const r = await signUp({ email, password: PASSWORD, fullName: 'Solo Saver', orgName: 'Solo', mode: 'personal' }, { ip: testIp() });
    if (!r.ok) throw new Error(r.error);
    const clients = await asUser(r.userId, (db) => db.rows<{ full_name: string }>('select full_name from public.clients'));
    expect(clients.map((c) => c.full_name)).toEqual(['Solo Saver']);
  });
  it('rate limits sign-ups per IP', async () => {
    const ip = testIp();
    let blocked = false;
    for (let i = 0; i < 12; i++) {
      const r = await signUp({ email: `rl-${uniq()}@test.dev`, password: PASSWORD, fullName: 'x', orgName: 'x', mode: 'agency' }, { ip });
      if (!r.ok && /Too many/.test(r.error)) blocked = true;
    }
    expect(blocked).toBe(true);
  });
});

describe('sign in', () => {
  it('issues a revocable session for correct credentials', async () => {
    const u = await newUser();
    const r = await authenticate({ email: u.email, password: PASSWORD }, { ip: u.ip });
    if (!r.ok) throw new Error(r.error);
    expect(r.needsEnrollment).toBe(true); // staff must set up MFA
    const s = await getSession(r.token);
    expect(s).toMatchObject({ userId: u.userId, orgId: u.orgId, role: 'owner', mfaVerified: false });
    await revokeSession(r.token);
    expect(await getSession(r.token)).toBeNull();
  });
  it('gives the same answer for unknown emails and wrong passwords', async () => {
    const u = await newUser();
    const a = await authenticate({ email: u.email, password: 'Wrong-Password-1!' }, { ip: testIp() });
    const b = await authenticate({ email: `nobody-${uniq()}@test.dev`, password: 'Wrong-Password-1!' }, { ip: testIp() });
    expect(a).toEqual(b);
  });
  it('locks the account after repeated failures, even for the right password', async () => {
    const u = await newUser();
    for (let i = 0; i < 5; i++) await authenticate({ email: u.email, password: 'Nope-Nope-Nope-1' }, { ip: testIp() });
    const r = await authenticate({ email: u.email, password: PASSWORD }, { ip: testIp() });
    expect(r).toMatchObject({ ok: false });
    expect((r as { error: string }).error).toMatch(/locked/);
  });
  it('rate limits by email regardless of source IP', async () => {
    const u = await newUser();
    const results = [];
    for (let i = 0; i < 14; i++) results.push(await authenticate({ email: u.email, password: 'Bad-Password-Xx1' }, { ip: testIp() }));
    expect(results.some((r) => !r.ok && /Too many/.test(r.error))).toBe(true);
  });
  it('keeps staff and portal sign-ins separate', async () => {
    const u = await newUser();
    const r = await authenticate({ email: u.email, password: PASSWORD, portal: true }, { ip: u.ip });
    expect(r).toMatchObject({ ok: false });
  });
  it('expires idle sessions', async () => {
    const u = await newUser();
    const r = await authenticate({ email: u.email, password: PASSWORD }, { ip: u.ip });
    if (!r.ok) throw new Error('login');
    await withSystem((db) => db.run("update public.sessions set last_seen_at = now() - interval '3 hours' where user_id = $1", [u.userId]));
    expect(await getSession(r.token)).toBeNull();
  });
  it('rejects sessions of disabled users and suspended organizations', async () => {
    const u = await newUser();
    const r = await authenticate({ email: u.email, password: PASSWORD }, { ip: u.ip });
    if (!r.ok) throw new Error('login');
    await withSystem((db) => db.run("update public.organizations set status = 'suspended' where id = $1", [u.orgId]));
    expect(await getSession(r.token)).toBeNull();
  });
});

describe('two-step verification', () => {
  it('enrols, verifies the first code, blocks replay, and marks the session verified', async () => {
    const u = await newUser();
    const login = await authenticate({ email: u.email, password: PASSWORD }, { ip: u.ip });
    if (!login.ok) throw new Error('login');
    const s = (await getSession(login.token))!;
    const enrol = await beginTotpEnrollment(u.userId);
    if ('ok' in enrol) throw new Error('enrol');
    expect((await confirmTotp(u.userId, s.sessionId, '000000', true)).ok).toBe(false);
    const code = totpNow(enrol.secret);
    expect((await confirmTotp(u.userId, s.sessionId, code, true)).ok).toBe(true);
    expect(await getSession(login.token)).toMatchObject({ mfaVerified: true, totpEnabled: true });

    // next login now asks for a code, and the same code cannot be used twice
    const again = await authenticate({ email: u.email, password: PASSWORD }, { ip: testIp() });
    if (!again.ok) throw new Error('login2');
    expect(again.needsMfa).toBe(true);
    const s2 = (await getSession(again.token))!;
    expect(s2.mfaVerified).toBe(false);
    expect((await confirmTotp(u.userId, s2.sessionId, code, false)).ok).toBe(false); // replay
  });
  it('lets an admin reset a teammate’s factor but never an owner’s', async () => {
    const o = await makeOrg('Reset');
    const mate = await withSystem(async (db) => {
      const x = await db.row<{ id: string }>("insert into public.users (email, password_hash, totp_enabled, totp_secret_encrypted) values ($1, 'x', true, 'v1.x') returning id", [`m-${uniq()}@test.dev`]);
      await db.run("insert into public.memberships (org_id, user_id, role) values ($1, $2, 'specialist')", [o.orgId, x!.id]);
      return x!.id;
    });
    expect(await adminResetMfa(o.orgId, mate)).toBe(true);
    expect(await adminResetMfa(o.orgId, o.ownerId)).toBe(false);
  });
});

describe('password reset', () => {
  it('emails a single-use link, replaces the password, and revokes existing sessions', async () => {
    const u = await newUser();
    const login = await authenticate({ email: u.email, password: PASSWORD }, { ip: u.ip });
    if (!login.ok) throw new Error('login');
    sentLog.length = 0;
    await requestPasswordReset(u.email, { ip: testIp() });
    const mail = sentLog.find((m) => m.to === u.email);
    expect(mail).toBeTruthy();
    const token = /token=([\w-]+)/.exec(mail!.text)![1]!;

    expect((await resetPassword(token, 'password123')).ok).toBe(false); // policy still applies
    expect((await resetPassword(token, 'A-Brand-New-Passphrase-7')).ok).toBe(true);
    expect((await resetPassword(token, 'Another-Passphrase-8')).ok).toBe(false); // single use
    expect(await getSession(login.token)).toBeNull(); // old sessions revoked
    expect((await authenticate({ email: u.email, password: PASSWORD }, { ip: testIp() })).ok).toBe(false);
    expect((await authenticate({ email: u.email, password: 'A-Brand-New-Passphrase-7' }, { ip: testIp() })).ok).toBe(true);
  });
  it('does not reveal whether an email exists', async () => {
    sentLog.length = 0;
    await expect(requestPasswordReset(`ghost-${uniq()}@test.dev`, { ip: testIp() })).resolves.toBeUndefined();
    expect(sentLog).toHaveLength(0);
  });
  it('rejects expired tokens', async () => {
    const u = await newUser();
    sentLog.length = 0;
    await requestPasswordReset(u.email, { ip: testIp() });
    const token = /token=([\w-]+)/.exec(sentLog.find((m) => m.to === u.email)!.text)![1]!;
    await withSystem((db) => db.run("update public.password_resets set expires_at = now() - interval '1 minute' where user_id = $1", [u.userId]));
    expect((await resetPassword(token, 'A-Brand-New-Passphrase-7')).ok).toBe(false);
  });
  it('changing a password signs out other sessions but keeps the current one', async () => {
    const u = await newUser();
    const a = await authenticate({ email: u.email, password: PASSWORD }, { ip: testIp() });
    const b = await authenticate({ email: u.email, password: PASSWORD }, { ip: testIp() });
    if (!a.ok || !b.ok) throw new Error('login');
    const keep = (await getSession(a.token))!.sessionId;
    expect((await changePassword(u.userId, 'wrong', 'Another-Passphrase-8', keep)).ok).toBe(false);
    expect((await changePassword(u.userId, PASSWORD, 'Another-Passphrase-8', keep)).ok).toBe(true);
    expect(await getSession(a.token)).not.toBeNull();
    expect(await getSession(b.token)).toBeNull();
  });
});

describe('invitations', () => {
  it('onboards a staff member into the inviting organization only', async () => {
    const o = await makeOrg('Invite');
    const email = `new-${uniq()}@test.dev`;
    const token = await asUser(o.ownerId, (db) => createInviteToken(db, { orgId: o.orgId, email, role: 'specialist', invitedBy: o.ownerId }));
    expect(await getInvite(token)).toMatchObject({ orgId: o.orgId, role: 'specialist', email });
    const r = await acceptInvite(token, { fullName: 'New Hire', password: PASSWORD }, { ip: testIp() });
    if (!r.ok) throw new Error(r.error);
    expect(await getSession(r.token)).toMatchObject({ orgId: o.orgId, role: 'specialist' });
    expect(await getInvite(token)).toBeNull(); // single use
    expect((await acceptInvite(token, { fullName: 'x', password: PASSWORD }, { ip: testIp() })).ok).toBe(false);
  });
  it('only admins can create invitations (enforced by RLS)', async () => {
    const o = await makeOrg('InviteRls');
    const spec = await withSystem(async (db) => {
      const u = await db.row<{ id: string }>("insert into public.users (email, password_hash) values ($1, 'x') returning id", [`s-${uniq()}@test.dev`]);
      await db.run("insert into public.memberships (org_id, user_id, role) values ($1, $2, 'specialist')", [o.orgId, u!.id]);
      return u!.id;
    });
    await expect(asUser(spec, (db) => createInviteToken(db, { orgId: o.orgId, email: 'x@y.dev', role: 'admin', invitedBy: spec }))).rejects.toThrow(/row-level security/);
  });
  it('links a client invitation to exactly that client record', async () => {
    const o = await makeOrg('Portal');
    const clientId = await addClient(o.orgId, 'Casey Client', { status: 'lead' });
    const email = `casey-${uniq()}@client.dev`;
    const token = await asUser(o.ownerId, (db) => createInviteToken(db, { orgId: o.orgId, email, role: 'client', clientId, invitedBy: o.ownerId }));
    const r = await acceptInvite(token, { fullName: 'Casey Client', password: PASSWORD }, { ip: testIp() });
    if (!r.ok) throw new Error(r.error);
    const s = (await getSession(r.token))!;
    expect(s.role).toBe('client');
    const mine = await asUser(s.userId, (db) => db.rows<{ id: string; status: string }>('select id, status from public.clients'));
    expect(mine).toEqual([{ id: clientId, status: 'onboarding' }]);
    // the portal account can sign in via the portal but not through the staff door
    expect((await authenticate({ email, password: PASSWORD, portal: true }, { ip: testIp() })).ok).toBe(true);
    expect((await authenticate({ email, password: PASSWORD }, { ip: testIp() })).ok).toBe(false);
  });
});

describe('rate limiter', () => {
  it('counts per key and window, and resets in the next window', async () => {
    const key = `t:${uniq()}`;
    const t0 = Date.UTC(2030, 0, 1, 12, 0, 5);
    expect((await rateLimit(key, 2, 60, t0)).allowed).toBe(true);
    expect((await rateLimit(key, 2, 60, t0 + 1000)).allowed).toBe(true);
    const third = await rateLimit(key, 2, 60, t0 + 2000);
    expect(third.allowed).toBe(false);
    expect(third.retryAfterSec).toBeGreaterThan(0);
    expect((await rateLimit(key, 2, 60, t0 + 61_000)).allowed).toBe(true);
  });
});
