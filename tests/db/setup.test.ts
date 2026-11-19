import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetEnvCache } from '@/lib/env';
import type { Email, SendResult } from '@/lib/mailer';
import { PermissionError, type Role } from '@/lib/rbac';
import { buildSetupChecklist } from '@/lib/setup/checklist';
import { EMAIL_TEST_KEY, loadSetupSnapshot, SMS_TEST_KEY } from '@/lib/setup/snapshot';
import { sendTestEmail, sendTestSms, TEST_EMAIL_LIMIT, TEST_EMAIL_ORG_LIMIT, TEST_SMS_ALL_LIMIT, TEST_SMS_LIMIT, TEST_SMS_ORG_LIMIT, type TestActor } from '@/lib/setup/test-send';
import type { Sms, SmsResult } from '@/lib/sms';
import { addClient, addMember, asUser, closePool, makeOrg, withSystem, type TestOrg } from './helpers';

const saved = { ...process.env };
function useEnv(env: Record<string, string>) { process.env = { ...saved, ...env }; resetEnvCache(); }
afterEach(() => { process.env = { ...saved }; resetEnvCache(); });
// The deployment-wide counter is shared by every test (and every run on the same day): start each test from zero.
const ALL_SMS = 'setup-test-sms:all';
beforeEach(() => withSystem((db) => db.run('delete from public.rate_limits where key = $1', [ALL_SMS])));
afterAll(async () => { await closePool(); });

const TWILIO = { SMS_DRIVER: 'twilio', TWILIO_ACCOUNT_SID: 'ACtest', TWILIO_AUTH_TOKEN: 'token-for-tests', TWILIO_FROM_NUMBER: '+15552345678' };
const RESEND = { EMAIL_DRIVER: 'resend', RESEND_API_KEY: 're_test_key', EMAIL_FROM: 'Agency <hello@agency.test>' };

const actor = (o: TestOrg, userId = o.ownerId, role: Role = 'owner', email = o.ownerEmail): TestActor =>
  ({ userId, orgId: o.orgId, role, email, orgName: 'Setup Agency', tx: (fn) => asUser(userId, fn) });
const settings = async (o: TestOrg) => (await withSystem((db) => db.row<{ settings: Record<string, unknown> }>('select settings from public.organizations where id = $1', [o.orgId])))!.settings;
/** Everything a test send must NOT write. */
const traces = (o: TestOrg) => withSystem(async (db) => ({
  communications: (await db.row<{ n: number }>('select count(*)::int as n from public.communications where org_id = $1', [o.orgId]))!.n,
  updates: (await db.row<{ n: number }>('select count(*)::int as n from public.client_updates where org_id = $1', [o.orgId]))!.n,
  consents: (await db.row<{ n: number }>('select count(*)::int as n from public.sms_consents where org_id = $1', [o.orgId]))!.n,
  events: (await db.row<{ n: number }>('select count(*)::int as n from public.client_events where org_id = $1', [o.orgId]))!.n,
}));
const audits = (o: TestOrg, action: string) => withSystem((db) => db.rows<{ metadata: Record<string, unknown> }>('select metadata from public.audit_logs where org_id = $1 and action = $2 order by created_at', [o.orgId, action]));

function fakeEmail(result: SendResult) { const sent: Email[] = []; return { sent, send: async (m: Email) => { sent.push(m); return result; } }; }
function fakeSms(result: SmsResult) { const sent: Sms[] = []; return { sent, send: async (m: Sms) => { sent.push(m); return result; } }; }

describe('setup test sends', () => {
  it('need settings:manage: a manager, a specialist and a client are refused before anything is sent', async () => {
    const o = await makeOrg('SetupPerm');
    useEnv({ ...RESEND, ...TWILIO });
    for (const role of ['manager', 'specialist', 'client'] as Role[]) {
      const m = await addMember(o.orgId, role);
      const mail = fakeEmail({ ok: true, provider: 'resend', providerRef: 'x' });
      const sms = fakeSms({ ok: true, provider: 'twilio', providerRef: 'SMx' });
      await expect(sendTestEmail(actor(o, m.id, role, m.email), mail)).rejects.toBeInstanceOf(PermissionError);
      await expect(sendTestSms(actor(o, m.id, role, m.email), { phone: '+15552345679', confirmed: true }, sms)).rejects.toBeInstanceOf(PermissionError);
      expect([mail.sent.length, sms.sent.length]).toEqual([0, 0]);
    }
    const admin = await addMember(o.orgId, 'admin');
    expect((await sendTestEmail(actor(o, admin.id, 'admin', admin.email), fakeEmail({ ok: true, provider: 'resend', providerRef: 'id_1' }))).ok).toBe(true);
  });

  it('email: goes only to the signed-in person, reports the real provider answer, and writes no client communication', async () => {
    const o = await makeOrg('SetupEmail');
    await addClient(o.orgId, 'Someone Else');
    const before = await traces(o);
    useEnv(RESEND);

    const refused = fakeEmail({ ok: false, provider: 'resend', error: 'The agency.test domain is not verified. Please, add and verify your domain on https://resend.com/domains' });
    const no = await sendTestEmail(actor(o), refused);
    expect(no.ok).toBe(false);
    expect(no.message).toMatch(/Resend refused it: “The agency\.test domain is not verified/);
    expect(no.message).toMatch(/sending domain is not verified in Resend yet/);
    expect((await settings(o))[EMAIL_TEST_KEY]).toBeUndefined();

    const accepted = fakeEmail({ ok: true, provider: 'resend', providerRef: 'id_123' });
    const yes = await sendTestEmail(actor(o), accepted);
    expect(yes).toMatchObject({ ok: true });
    expect(yes.message).toMatch(/Resend accepted it \(id id_123\)/);
    expect(accepted.sent).toHaveLength(1);
    expect(accepted.sent[0]!.to).toBe(o.ownerEmail);
    expect(typeof (await settings(o))[EMAIL_TEST_KEY]).toBe('string');

    // A later refusal withdraws the proof, so the checklist stops showing the step as done.
    await sendTestEmail(actor(o), refused);
    expect((await settings(o))[EMAIL_TEST_KEY]).toBeUndefined();

    expect(await traces(o)).toEqual(before);
    expect((await audits(o, 'setup.test_email')).map((a) => a.metadata)).toEqual([{ provider: 'resend', accepted: false }, { provider: 'resend', accepted: true }, { provider: 'resend', accepted: false }]);
  });

  it('email: says so when email is not connected or is only a local log, and never claims a delivery', async () => {
    const o = await makeOrg('SetupEmailOff');
    const mail = fakeEmail({ ok: true, provider: 'resend' });
    useEnv({ EMAIL_DRIVER: 'disabled' });
    expect(await sendTestEmail(actor(o), mail)).toEqual({ ok: false, message: 'Not sent: email is not connected (EMAIL_DRIVER=disabled).' });
    useEnv({ EMAIL_DRIVER: 'resend', RESEND_API_KEY: '' });
    expect((await sendTestEmail(actor(o), mail)).message).toMatch(/RESEND_API_KEY is missing/);
    expect(mail.sent).toHaveLength(0);
    useEnv({ EMAIL_DRIVER: 'log' });
    const logged = await sendTestEmail(actor(o));
    expect(logged.ok).toBe(false);
    expect(logged.message).toMatch(/written to a local log/);
    expect((await settings(o))[EMAIL_TEST_KEY]).toBeUndefined();
  });

  it('email: rate limited per person', async () => {
    const o = await makeOrg('SetupEmailLimit');
    useEnv(RESEND);
    const mail = fakeEmail({ ok: true, provider: 'resend', providerRef: 'id' });
    for (let i = 0; i < TEST_EMAIL_LIMIT.max; i++) expect((await sendTestEmail(actor(o), mail)).ok).toBe(true);
    await expect(sendTestEmail(actor(o), mail)).rejects.toThrow(/test emails in the last hour/);
    expect(mail.sent).toHaveLength(TEST_EMAIL_LIMIT.max);
  });

  it('text: needs the person to confirm the number is theirs, reports the real provider answer, stores no number and no client record', async () => {
    const o = await makeOrg('SetupSms');
    await addClient(o.orgId, 'Someone Else');
    const before = await traces(o);
    useEnv(TWILIO);
    const sms = fakeSms({ ok: true, provider: 'twilio', providerRef: 'SM123' });
    await expect(sendTestSms(actor(o), { phone: '(555) 234-5679', confirmed: false }, sms)).rejects.toThrow(/confirm this is your own/);
    await expect(sendTestSms(actor(o), { phone: 'not a number', confirmed: true }, sms)).rejects.toThrow(/Enter a US or Canadian mobile number/);
    // Only +1 numbers: the test is never sent abroad, however the number is written.
    for (const abroad of ['+44 7700 900123', '+8613800138000', '+252 61 2345678']) await expect(sendTestSms(actor(o), { phone: abroad, confirmed: true }, sms)).rejects.toThrow(/not sent to other countries/);
    expect(sms.sent).toHaveLength(0);

    const yes = await sendTestSms(actor(o), { phone: '(555) 234-5679', confirmed: true }, sms);
    expect(yes.ok).toBe(true);
    expect(yes.message).toMatch(/Twilio accepted it \(id SM123\)\. Accepted is not delivered/);
    expect(sms.sent).toEqual([{ to: '+15552345679', body: expect.stringMatching(/test for Setup Agency: text messaging is connected\..*Reply STOP to opt out\.$/) }]);
    expect(typeof (await settings(o))[SMS_TEST_KEY]).toBe('string');

    const no = await sendTestSms(actor(o), { phone: '+15552345679', confirmed: true }, fakeSms({ ok: false, provider: 'twilio', error: 'The number +1555 is unverified (Twilio error 21608)' }));
    expect(no).toEqual({ ok: false, message: 'Twilio refused it: “The number +1555 is unverified (Twilio error 21608)”.' });
    expect((await settings(o))[SMS_TEST_KEY]).toBeUndefined();

    expect(await traces(o)).toEqual(before);
    const log = await audits(o, 'setup.test_sms');
    expect(log.map((a) => a.metadata)).toEqual([{ provider: 'twilio', accepted: true }, { provider: 'twilio', accepted: false }]);
    expect(JSON.stringify([log, await settings(o)])).not.toContain('5552345679');
  });

  it('text: says what is missing when texting is not connected, and is limited to a few a day', async () => {
    const o = await makeOrg('SetupSmsLimit');
    const sms = fakeSms({ ok: true, provider: 'twilio', providerRef: 'SM1' });
    useEnv({ SMS_DRIVER: 'disabled' });
    expect(await sendTestSms(actor(o), { phone: '+15552345679', confirmed: true }, sms)).toEqual({ ok: false, message: 'Not sent: text messaging is not connected (SMS_DRIVER=disabled).' });
    useEnv({ SMS_DRIVER: 'twilio', TWILIO_ACCOUNT_SID: 'ACtest' });
    const partial = await sendTestSms(actor(o), { phone: '+15552345679', confirmed: true }, sms);
    expect(partial.message).toMatch(/Still to set: TWILIO_AUTH_TOKEN, TWILIO_MESSAGING_SERVICE_SID or TWILIO_FROM_NUMBER/);
    expect(partial.message).not.toContain('ACtest');
    expect(sms.sent).toHaveLength(0);

    useEnv(TWILIO);
    for (let i = 0; i < TEST_SMS_LIMIT.max; i++) expect((await sendTestSms(actor(o), { phone: '+15552345679', confirmed: true }, sms)).ok).toBe(true);
    await expect(sendTestSms(actor(o), { phone: '+15552345679', confirmed: true }, sms)).rejects.toThrow(/test texts today/);
    expect(sms.sent).toHaveLength(TEST_SMS_LIMIT.max);
  });

  it('the tests are also capped per workspace, and texts for the whole deployment, so new accounts cannot multiply them', async () => {
    const o = await makeOrg('SetupOrgLimit');
    useEnv({ ...RESEND, ...TWILIO });
    const sms = fakeSms({ ok: true, provider: 'twilio', providerRef: 'SM1' });
    const text = (a: TestActor) => sendTestSms(a, { phone: '+15552345679', confirmed: true }, sms);
    // Another admin of the same workspace does not get a fresh allowance.
    for (let i = 0; i < TEST_SMS_ORG_LIMIT.max; i++) expect((await text(actor(o))).ok).toBe(true);
    const admin = await addMember(o.orgId, 'admin');
    await expect(text(actor(o, admin.id, 'admin', admin.email))).rejects.toThrow(/Your workspace has sent 3 test texts today/);
    expect(sms.sent).toHaveLength(TEST_SMS_ORG_LIMIT.max);

    const mail = fakeEmail({ ok: true, provider: 'resend', providerRef: 'id' });
    const people = [actor(o), actor(o, admin.id, 'admin', admin.email)];
    for (let i = 0; i < TEST_EMAIL_ORG_LIMIT.max; i++) expect((await sendTestEmail(people[i % 2]!, mail)).ok).toBe(true);
    const third = await addMember(o.orgId, 'admin', 'admin2');
    await expect(sendTestEmail(actor(o, third.id, 'admin', third.email), mail)).rejects.toThrow(/Your workspace has sent 10 test emails/);
    expect(mail.sent).toHaveLength(TEST_EMAIL_ORG_LIMIT.max);

    // Once the deployment's allowance for the day is used, a brand-new workspace is refused too.
    const windowStart = new Date(Math.floor(Date.now() / 1000 / TEST_SMS_ALL_LIMIT.windowSec) * TEST_SMS_ALL_LIMIT.windowSec * 1000);
    await withSystem((db) => db.run('insert into public.rate_limits (key, window_start, hits) values ($1, $2, $3) on conflict (key, window_start) do update set hits = excluded.hits', [ALL_SMS, windowStart, TEST_SMS_ALL_LIMIT.max]));
    const fresh = await makeOrg('SetupAllLimit');
    await expect(text(actor(fresh))).rejects.toThrow(/paused for today across the platform/);
    expect(sms.sent).toHaveLength(TEST_SMS_ORG_LIMIT.max);
  });

  it('the snapshot is read from real state and holds no secret or setting value', async () => {
    const o = await makeOrg('SetupSnap');
    useEnv({ ...RESEND, ...TWILIO, APP_URL: 'https://app.example.test', CRON_SECRET: 'cron-secret-value-0123456789abcdef' });
    const ctx = { orgId: o.orgId, tx: actor(o).tx };
    let snap = await loadSetupSnapshot(ctx);
    expect(snap.email).toEqual({ driver: 'resend', hasApiKey: true, fromSet: true, testAcceptedAt: null });
    expect(snap.sms).toMatchObject({ state: 'connected', webhookUrl: 'https://app.example.test/api/webhooks/twilio', webhookReachable: true, testAcceptedAt: null });
    expect(snap.agency).toEqual({ isAgency: true, mailingAddress: false, replyEmail: false, timezoneChosen: false });
    expect(snap.jobs).toEqual({ cronSecretSet: true, lastRunAt: null, lastRunOk: false });
    const json = JSON.stringify([snap, buildSetupChecklist(snap)]);
    for (const secret of ['re_test_key', 'token-for-tests', 'ACtest', 'cron-secret-value', 'hello@agency.test', '+15552345678']) expect(json).not.toContain(secret);

    await withSystem(async (db) => {
      await db.run("update public.organizations set settings = settings || jsonb_build_object('lead_mailing_address', '1 Main St, Austin, TX 78701', 'lead_reply_email', 'hello@agency.test', 'timezone', 'America/Chicago') where id = $1", [o.orgId]);
      await db.run("insert into public.job_runs (org_id, started_at, finished_at, status) values ($1, now(), now(), 'ok')", [o.orgId]);
    });
    await sendTestEmail(actor(o), fakeEmail({ ok: true, provider: 'resend', providerRef: 'id' }));
    snap = await loadSetupSnapshot(ctx);
    expect(snap.agency).toEqual({ isAgency: true, mailingAddress: true, replyEmail: true, timezoneChosen: true });
    expect(snap.jobs).toMatchObject({ lastRunOk: true });
    expect(snap.email.testAcceptedAt).not.toBeNull();
    const list = buildSetupChecklist(snap);
    expect(list.groups.find((g) => g.key === 'email')!.remaining).toBe(0);
    expect(list.groups.find((g) => g.key === 'basics')!.remaining).toBe(0);
  });
});
