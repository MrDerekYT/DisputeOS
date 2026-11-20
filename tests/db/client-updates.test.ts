import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { POST as twilioWebhook } from '@/app/api/webhooks/twilio/route';
import { runScheduledJobs } from '@/lib/automation/jobs';
import {
  deliverClientUpdates, grantSmsConsent, pendingSmsReplies, queueClientUpdate, recordInboundSms, recordSmsStatus, reviewSmsReplies, revokeSmsConsent, runClientUpdateJobs, SHARED_REPLY_NOTE, unmatchedInboundCount,
} from '@/lib/client-updates/service';
import { DAILY_CAP, UPDATE_EVENTS, type UpdateEvent } from '@/lib/client-updates/templates';
import { addDays, noResponseAfter } from '@/lib/disputes/clock';
import { recordResponse } from '@/lib/disputes/service';
import { businessToday } from '@/lib/letters/service';
import type { Db } from '@/lib/db';
import { resetEnvCache } from '@/lib/env';
import { smsLog, twilioSignature, twilioWebhookUrl, type Sms, type SmsResult } from '@/lib/sms';
import { addClient, addDispute, addMember, asUser, closePool, makeOrg, uniq, withSystem, type TestOrg } from './helpers';

const saved = { ...process.env };
// The development stand-in: texts are written to a log, nothing leaves the machine.
beforeAll(() => { process.env.SMS_DRIVER = 'log'; resetEnvCache(); });
afterAll(async () => { process.env = { ...saved }; resetEnvCache(); await closePool(); });

/** A US mobile number nobody else in the (never truncated) test database has. */
const phone = () => `+1${2 + Math.floor(Math.random() * 8)}${String(Math.floor(Math.random() * 100)).padStart(2, '0')}555${String(Math.floor(Math.random() * 10_000)).padStart(4, '0')}`;
/** Midday and the middle of the night in the agency timezone (America/New_York), on today's date. */
const at = (utcHour: number) => new Date(`${new Date().toISOString().slice(0, 10)}T${String(utcHour).padStart(2, '0')}:00:00Z`);
const NOON = at(17);
const NIGHT = at(8);

type Channels = { sms?: boolean; email?: boolean };
async function agency(label: string, on: Partial<Record<UpdateEvent, Channels>> = {}, windowSince: string | null = null): Promise<TestOrg> {
  const o = await makeOrg(label);
  const switches = Object.fromEntries(UPDATE_EVENTS.map((e) => [e, { sms: !!on[e]?.sms, email: !!on[e]?.email }]));
  await withSystem((db) => db.run("update public.organizations set settings = settings || jsonb_build_object('client_updates', $2::jsonb) where id = $1", [o.orgId, JSON.stringify({ switches, window_since: windowSince })]));
  return o;
}
const ALL_SMS = Object.fromEntries(UPDATE_EVENTS.map((e) => [e, { sms: true }])) as Record<UpdateEvent, Channels>;

/** A client with a portal sign-in and a phone number; `consent` records their own agreement through the portal path. */
async function portalClient(o: TestOrg, opts: { consent?: boolean; number?: string } = {}) {
  const user = await addMember(o.orgId, 'client', 'portal');
  const clientId = await addClient(o.orgId, 'Jordan Rivera', { portalUserId: user.id });
  const number = opts.number ?? phone();
  await withSystem((db) => db.run('update public.clients set phone = $2 where id = $1', [clientId, number]));
  if (opts.consent) expect(await asUser(user.id, (db) => grantSmsConsent(db, { orgId: o.orgId, clientId, userId: user.id, source: 'portal', ip: '10.0.0.1', userAgent: 'vitest' }))).toEqual({ ok: true, phone: number });
  return { clientId, userId: user.id, number };
}
const queue = (o: TestOrg, clientId: string, event: UpdateEvent, subjectId = `s-${uniq()}`) =>
  asUser(o.ownerId, (db) => queueClientUpdate(db, { orgId: o.orgId, clientId, event, subjectId }));
const updates = (clientId: string) => withSystem((db) => db.rows<{ event: string; channel: string; status: string; provider: string | null; error: string | null; communication_id: string | null }>(
  'select event, channel, status, provider, error, communication_id from public.client_updates where client_id = $1 order by created_at, channel', [clientId]));
const comms = (clientId: string) => withSystem((db) => db.rows<{ direction: string; channel: string; status: string; body: string; provider_ref: string | null }>(
  'select direction, channel, status, body, provider_ref from public.communications where client_id = $1 order by created_at', [clientId]));
const consent = (clientId: string) => withSystem((db) => db.row<{ source: string; phone: string; consent_text: string; revoked_at: string | null; revoked_via: string | null; ip: string | null }>(
  'select source, phone, consent_text, revoked_at, revoked_via, ip from public.sms_consents where client_id = $1 order by granted_at desc limit 1', [clientId]));
const textsTo = (number: string) => smsLog.filter((m) => m.to === number);

describe('SMS consent', () => {
  it('a client grants it in the portal: the exact wording, the number, the time and the source are stored, and they can withdraw', async () => {
    const o = await agency('ConsentPortal');
    const c = await portalClient(o, { consent: true });
    const row = (await consent(c.clientId))!;
    expect(row).toMatchObject({ source: 'portal', phone: c.number, revoked_at: null, ip: '10.0.0.1' });
    for (const re of [/ConsentPortal/, new RegExp(c.number.replace('+', '\\+')), /Message frequency varies/, /Message and data rates may apply/, /Reply STOP to stop/, /not a condition of service/]) expect(row.consent_text).toMatch(re);
    // Agreeing again changes nothing; withdrawing stamps the record instead of deleting it.
    await asUser(c.userId, (db) => grantSmsConsent(db, { orgId: o.orgId, clientId: c.clientId, userId: c.userId, source: 'portal' }));
    expect(await withSystem((db) => db.row<{ n: number }>('select count(*)::int as n from public.sms_consents where client_id = $1', [c.clientId]))).toEqual({ n: 1 });
    expect(await asUser(c.userId, (db) => revokeSmsConsent(db, { orgId: o.orgId, clientId: c.clientId, userId: c.userId, via: 'portal' }))).toBe(true);
    expect(await consent(c.clientId)).toMatchObject({ revoked_via: 'portal' });
    const timeline = await withSystem((db) => db.rows<{ summary: string }>("select summary from public.client_events where client_id = $1 and kind = 'sms_consent' order by created_at", [c.clientId]));
    expect(timeline.map((t) => t.summary)).toEqual(['Client agreed to text message updates in the portal', 'Client turned off text message updates in the portal']);
  });

  it('staff can record a verbal consent only with a note, and it is labelled as recorded by staff', async () => {
    const o = await agency('ConsentStaff');
    const c = await portalClient(o);
    const record = (note: string | null) => asUser(o.ownerId, (db) => grantSmsConsent(db, { orgId: o.orgId, clientId: c.clientId, userId: o.ownerId, source: 'staff', note }));
    await expect(record(null)).rejects.toThrow(/sms_consents_staff_note_check/);
    await expect(record('ok')).rejects.toThrow(/sms_consents_staff_note_check/);
    expect(await record('Agreed on a call with me on 14 March, about 2 p.m.')).toEqual({ ok: true, phone: c.number });
    expect(await consent(c.clientId)).toMatchObject({ source: 'staff', phone: c.number });
    // A staff member cannot pass a consent off as the client's own.
    await asUser(o.ownerId, (db) => revokeSmsConsent(db, { orgId: o.orgId, clientId: c.clientId, userId: o.ownerId, via: 'staff' }));
    await expect(asUser(o.ownerId, (db) => grantSmsConsent(db, { orgId: o.orgId, clientId: c.clientId, userId: o.ownerId, source: 'portal' }))).rejects.toThrow(/row-level security/);
  });

  it('needs a readable mobile number, and the record cannot be edited or forged', async () => {
    const o = await agency('ConsentGuard');
    const c = await portalClient(o, { consent: true });
    const other = await portalClient(o);
    await withSystem((db) => db.run("update public.clients set phone = '555-0134' where id = $1", [other.clientId]));
    expect(await asUser(other.userId, (db) => grantSmsConsent(db, { orgId: o.orgId, clientId: other.clientId, userId: other.userId, source: 'portal' }))).toEqual({ ok: false, reason: 'no_phone' });
    // The client cannot rewrite what they agreed to, cannot write a staff-labelled record, and cannot consent for someone else.
    await expect(asUser(c.userId, (db) => db.run("update public.sms_consents set consent_text = 'I agreed to everything forever' where client_id = $1", [c.clientId]))).rejects.toThrow(/only be revoked/);
    await expect(asUser(other.userId, (db) => db.run("insert into public.sms_consents (org_id, client_id, phone, consent_text, source, note, recorded_by) values ($1, $2, $3, repeat('y', 30), 'staff', 'a note long enough', $4)", [o.orgId, other.clientId, c.number, other.userId]))).rejects.toThrow(/row-level security/);
    await expect(asUser(c.userId, (db) => grantSmsConsent(db, { orgId: o.orgId, clientId: other.clientId, userId: c.userId, source: 'portal' }))).resolves.toEqual({ ok: false, reason: 'not_found' });
    // Nobody can delete from the ledger through a tenant request.
    await expect(asUser(o.ownerId, (db) => db.run('delete from public.sms_consents where client_id = $1', [c.clientId]))).rejects.toThrow(/permission denied/);
  });
});

describe('client updates by text', () => {
  it('no consent: nothing is queued, nothing is sent, nothing is recorded', async () => {
    const o = await agency('NoConsent', ALL_SMS);
    const c = await portalClient(o);
    expect(await queue(o, c.clientId, 'dispute_sent')).toBe(0);
    expect(await deliverClientUpdates(o.orgId, { now: NOON })).toEqual({ sent: 0, failed: 0, skipped: 0, waiting: 0 });
    expect(await updates(c.clientId)).toEqual([]);
    expect(await comms(c.clientId)).toEqual([]);
    expect(textsTo(c.number)).toEqual([]);
  });

  it('everything is off by default: consent alone sends nothing', async () => {
    const o = await agency('SwitchOff');
    const c = await portalClient(o, { consent: true });
    for (const e of UPDATE_EVENTS) expect(await queue(o, c.clientId, e)).toBe(0);
    expect(await updates(c.clientId)).toEqual([]);
    expect(textsTo(c.number)).toEqual([]);
  });

  it('consent and the switch on: one text through the log driver, recorded with its channel, status and provider', async () => {
    const o = await agency('OneText', { dispute_sent: { sms: true } });
    const c = await portalClient(o, { consent: true });
    expect(await queue(o, c.clientId, 'dispute_sent', 'dispute-1')).toBe(1);
    expect(await queue(o, c.clientId, 'response_recorded')).toBe(0); // that switch is off
    expect(await deliverClientUpdates(o.orgId, { now: NOON })).toEqual({ sent: 1, failed: 0, skipped: 0, waiting: 0 });
    const sent = textsTo(c.number);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toMatch(/^OneText \w+: There is an update on your file\. Sign in to see it: http:\/\/localhost:3000\/portal\/login\?org=\S+ Reply STOP to stop, HELP for help\.$/);
    const rows = await updates(c.clientId);
    expect(rows).toEqual([{ event: 'dispute_sent', channel: 'sms', status: 'sent', provider: 'log', error: null, communication_id: expect.any(String) }]);
    // The log driver delivers nothing, so the message is saved as not delivered ("queued"), never as sent.
    expect(await comms(c.clientId)).toEqual([{ direction: 'outbound', channel: 'sms', status: 'queued', body: sent[0]!.body, provider_ref: null }]);
    // Running again sends nothing more.
    expect(await deliverClientUpdates(o.orgId, { now: NOON })).toEqual({ sent: 0, failed: 0, skipped: 0, waiting: 0 });
    expect(textsTo(c.number)).toHaveLength(1);
  });

  it('a real trigger queues it: recording a response on a dispute, in the same transaction', async () => {
    const o = await agency('RealTrigger', { response_recorded: { sms: true } });
    const c = await portalClient(o, { consent: true });
    const disputeId = await addDispute(o.orgId, c.clientId, 'submitted');
    await asUser(o.ownerId, (db) => recordResponse(db, { orgId: o.orgId, userId: o.ownerId, role: 'owner' }, disputeId, { outcome: 'verified' }));
    expect(await updates(c.clientId)).toMatchObject([{ event: 'response_recorded', channel: 'sms', status: 'queued' }]);
    // A rolled-back transaction leaves nothing behind to send.
    const second = await addDispute(o.orgId, c.clientId, 'submitted');
    await expect(asUser(o.ownerId, async (db) => { await recordResponse(db, { orgId: o.orgId, userId: o.ownerId, role: 'owner' }, second, { outcome: 'verified' }); throw new Error('rolled back'); })).rejects.toThrow('rolled back');
    expect(await updates(c.clientId)).toHaveLength(1);
    await deliverClientUpdates(o.orgId, { now: NOON });
    expect(textsTo(c.number)).toHaveLength(1);
    expect(textsTo(c.number)[0]!.body).not.toMatch(/verified|Acme|1234|Experian/i);
  });

  it('quiet hours: a text queued at night waits and goes out in the morning', async () => {
    const o = await agency('Quiet', { team_message: { sms: true, email: true } });
    const c = await portalClient(o, { consent: true });
    expect(await queue(o, c.clientId, 'team_message')).toBe(2);
    // The email goes at once (written to the email log here); the text waits.
    expect(await deliverClientUpdates(o.orgId, { now: NIGHT })).toEqual({ sent: 1, failed: 0, skipped: 0, waiting: 1 });
    expect(textsTo(c.number)).toEqual([]);
    expect((await updates(c.clientId)).map((u) => [u.channel, u.status])).toEqual([['email', 'sent'], ['sms', 'queued']]);
    expect(await deliverClientUpdates(o.orgId, { now: NOON })).toEqual({ sent: 1, failed: 0, skipped: 0, waiting: 0 });
    expect(textsTo(c.number)).toHaveLength(1);
  });

  it('two triggers at the same moment queue one row, and two deliveries at the same moment send one text', async () => {
    const o = await agency('Concurrent', { dispute_sent: { sms: true } });
    const c = await portalClient(o, { consent: true });
    const added = await Promise.all([queue(o, c.clientId, 'dispute_sent', 'same-dispute'), queue(o, c.clientId, 'dispute_sent', 'same-dispute'), queue(o, c.clientId, 'dispute_sent', 'same-dispute')]);
    expect(added.reduce((a, b) => a + b, 0)).toBe(1);
    const results = await Promise.all([deliverClientUpdates(o.orgId, { now: NOON }), deliverClientUpdates(o.orgId, { now: NOON }), deliverClientUpdates(o.orgId, { now: NOON })]);
    expect(results.reduce((a, r) => a + r.sent, 0)).toBe(1);
    expect(textsTo(c.number)).toHaveLength(1);
    expect(await updates(c.clientId)).toHaveLength(1);
    expect(await comms(c.clientId)).toHaveLength(1);
  });

  it('daily cap: no more than three texts to one client in 24 hours; the rest are skipped, not saved up', async () => {
    const o = await agency('Cap', ALL_SMS);
    const c = await portalClient(o, { consent: true });
    for (let i = 0; i < DAILY_CAP.sms + 2; i++) expect(await queue(o, c.clientId, 'dispute_sent', `d-${i}`)).toBe(1);
    expect(await deliverClientUpdates(o.orgId, { now: NOON })).toEqual({ sent: DAILY_CAP.sms, failed: 0, skipped: 2, waiting: 0 });
    expect(textsTo(c.number)).toHaveLength(DAILY_CAP.sms);
    expect((await updates(c.clientId)).filter((u) => u.status === 'skipped').map((u) => u.error)).toEqual(['Daily limit for this client reached', 'Daily limit for this client reached']);
  });

  it('a provider failure is recorded as failed, with the reason, and is not retried', async () => {
    const o = await agency('Fails', { dispute_sent: { sms: true } });
    const c = await portalClient(o, { consent: true });
    await queue(o, c.clientId, 'dispute_sent');
    const refuse = async (_: Sms): Promise<SmsResult> => ({ ok: false, provider: 'twilio', error: 'Attempt to send to unsubscribed recipient (Twilio error 21610)' });
    expect(await deliverClientUpdates(o.orgId, { now: NOON, sms: refuse })).toEqual({ sent: 0, failed: 1, skipped: 0, waiting: 0 });
    expect(await updates(c.clientId)).toMatchObject([{ status: 'failed', provider: 'twilio', error: 'Attempt to send to unsubscribed recipient (Twilio error 21610)' }]);
    expect(await comms(c.clientId)).toMatchObject([{ direction: 'outbound', channel: 'sms', status: 'failed' }]);
    expect(await deliverClientUpdates(o.orgId, { now: NOON })).toEqual({ sent: 0, failed: 0, skipped: 0, waiting: 0 });
    // A delivery report that says the carrier dropped a text that was accepted marks it failed too.
    const o2 = await agency('Undelivered', { dispute_sent: { sms: true } });
    const c2 = await portalClient(o2, { consent: true });
    await queue(o2, c2.clientId, 'dispute_sent');
    const sid = `SM${uniq()}${uniq()}`;
    await deliverClientUpdates(o2.orgId, { now: NOON, sms: async () => ({ ok: true, provider: 'twilio', providerRef: sid }) });
    expect(await comms(c2.clientId)).toMatchObject([{ status: 'sent', provider_ref: sid }]);
    expect(await recordSmsStatus(sid, 'undelivered', '30034')).toEqual({ kind: 'status', matched: 1 });
    expect(await comms(c2.clientId)).toMatchObject([{ status: 'failed' }]);
    expect(await updates(c2.clientId)).toMatchObject([{ status: 'failed', error: 'The carrier did not deliver it (Twilio error 30034)' }]);
  });

  it('a changed phone number or a missing portal sign-in stops the text', async () => {
    const o = await agency('Changed', ALL_SMS);
    const c = await portalClient(o, { consent: true });
    await queue(o, c.clientId, 'dispute_sent');
    await withSystem((db) => db.run('update public.clients set phone = $2 where id = $1', [c.clientId, phone()]));
    expect(await deliverClientUpdates(o.orgId, { now: NOON })).toEqual({ sent: 0, failed: 0, skipped: 1, waiting: 0 });
    expect(await updates(c.clientId)).toMatchObject([{ status: 'skipped', error: 'The phone number changed since consent was given' }]);
    expect(await queue(o, c.clientId, 'dispute_sent')).toBe(0);
    expect(textsTo(c.number)).toEqual([]);
    // A client who cannot sign in is not told to sign in.
    const noPortal = await addClient(o.orgId, 'No Portal');
    await withSystem((db) => db.run('update public.clients set phone = $2 where id = $1', [noPortal, phone()]));
    await asUser(o.ownerId, (db) => grantSmsConsent(db, { orgId: o.orgId, clientId: noPortal, userId: o.ownerId, source: 'staff', note: 'Agreed in the office on Monday morning.' }));
    expect(await queue(o, noPortal, 'dispute_sent')).toBe(0);
  });

  it('“no response recorded” is announced once by the scheduled job: only after 5 business days and a week for the mail, and only if the period ended after the switch went on', async () => {
    // 15 U.S.C. § 1681i(a)(6)(A): the agency generally has 5 business days after completing its reinvestigation to send
    // written results. The client is not told "no response" the day after the period ends.
    const today = businessToday();
    // A period-end day whose allowance (noResponseAfter) ran out between yesterday and six days ago.
    const endedDay = Array.from({ length: 20 }, (_, k) => addDays(today, -(k + 12))).find((d) => noResponseAfter(d) < today && noResponseAfter(d) >= addDays(today, -6))!;
    expect(endedDay).toBeTruthy();
    const since = new Date(Date.now() - 24 * 86_400_000).toISOString();
    const o = await agency('Window', { window_passed: { sms: true } }, since);
    const c = await portalClient(o, { consent: true });
    const [ended, justEnded, old, open, answered] = await Promise.all([1, 2, 3, 4, 5].map(() => addDispute(o.orgId, c.clientId, 'submitted')));
    await withSystem(async (db) => {
      await db.run('update public.disputes set due_at = $2::timestamptz where id = $1', [ended, `${endedDay}T17:00:00Z`]);
      await db.run("update public.disputes set due_at = now() - interval '1 day' where id = $1", [justEnded]); // the period ended yesterday: results may still be in the mail
      await db.run("update public.disputes set due_at = now() - interval '26 days' where id = $1", [old]); // before the switch went on
      await db.run("update public.disputes set due_at = now() + interval '9 days' where id = $1", [open]);
      await db.run('update public.disputes set due_at = $2::timestamptz, response_at = now(), status = \'response_received\' where id = $1', [answered, `${endedDay}T17:00:00Z`]);
    });
    // "Now" for the job: the real moment (the due dates above are relative to it), moved to midday so the text is not held for quiet hours.
    const midday = new Date(); midday.setUTCHours(17, 0, 0, 0);
    expect(await runClientUpdateJobs(o.orgId, { now: midday })).toMatchObject({ sent: 1 });
    expect(await runClientUpdateJobs(o.orgId, { now: midday })).toMatchObject({ sent: 0 });
    expect(await withSystem((db) => db.rows('select subject_id, status from public.client_updates where client_id = $1', [c.clientId]))).toEqual([{ subject_id: ended, status: 'sent' }]);
    expect(textsTo(c.number)).toHaveLength(1);
    // The job result reports it, and an organization with nothing switched on reports nothing.
    expect((await runScheduledJobs({ onlyOrgIds: [o.orgId] })).clientUpdates).toBe(0);
  });
});

describe('inbound texts (the Twilio webhook)', () => {
  const TOKEN = 'webhook-test-auth-token';
  const ACCOUNT = 'ACwebhooktest00000000000000000000';
  /** A request exactly as Twilio would sign it: this URL, these form fields, this account's Auth Token. */
  async function post(fields: Record<string, string>, opts: { signWith?: string; ip?: string } = {}) {
    const params = { AccountSid: ACCOUNT, MessageSid: `SM${uniq()}${uniq()}`, SmsStatus: 'received', NumMedia: '0', ...fields };
    process.env.SMS_DRIVER = 'twilio'; process.env.TWILIO_AUTH_TOKEN = TOKEN; process.env.TWILIO_ACCOUNT_SID = ACCOUNT; resetEnvCache();
    try {
      return await twilioWebhook(new Request('http://localhost:3000/api/webhooks/twilio', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': twilioSignature(opts.signWith ?? TOKEN, twilioWebhookUrl(), params), 'x-forwarded-for': opts.ip ?? `10.9.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}` },
        body: new URLSearchParams(params).toString(),
      }));
    } finally {
      process.env.SMS_DRIVER = 'log'; delete process.env.TWILIO_AUTH_TOKEN; delete process.env.TWILIO_ACCOUNT_SID; resetEnvCache();
    }
  }

  it('answers 404 while Twilio is not configured, and 403 to a request that is not signed with the Auth Token or names another account', async () => {
    const res = await twilioWebhook(new Request('http://localhost:3000/api/webhooks/twilio', { method: 'POST', body: 'From=%2B14155550134&Body=STOP' }));
    expect(res.status).toBe(404);
    const o = await agency('Forged', ALL_SMS);
    const c = await portalClient(o, { consent: true });
    expect((await post({ From: c.number, To: '+14155550100', Body: 'STOP' }, { signWith: 'not-the-token' })).status).toBe(403);
    expect((await post({ From: c.number, To: '+14155550100', Body: 'STOP', AccountSid: 'ACsomeoneelse000000000000000000000' })).status).toBe(403);
    expect((await consent(c.clientId))!.revoked_at).toBeNull();
  });

  it('STOP revokes consent, drops a text still waiting, and blocks every later send; START does not switch it back on', async () => {
    const o = await agency('Stop', ALL_SMS);
    const c = await portalClient(o, { consent: true });
    expect(await queue(o, c.clientId, 'dispute_sent')).toBe(1); // waiting when the STOP arrives
    const res = await post({ From: c.number, To: '+14155550100', Body: 'Stop' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/xml/);
    expect(await res.text()).toMatch(/<Response><\/Response>/);
    expect(await consent(c.clientId)).toMatchObject({ revoked_via: 'sms_stop', revoked_at: expect.any(String) });
    expect(await updates(c.clientId)).toMatchObject([{ status: 'skipped', error: 'The client replied STOP' }]);
    expect(await queue(o, c.clientId, 'response_recorded')).toBe(0);
    expect(await deliverClientUpdates(o.orgId, { now: NOON })).toEqual({ sent: 0, failed: 0, skipped: 0, waiting: 0 });
    expect(textsTo(c.number)).toEqual([]);
    // The reply is on the client's thread and timeline for staff.
    expect(await comms(c.clientId)).toMatchObject([{ direction: 'inbound', channel: 'sms', status: 'received', body: 'Stop' }]);
    const summaries = async () => (await withSystem((db) => db.rows<{ summary: string }>("select summary from public.client_events where client_id = $1 order by created_at", [c.clientId]))).map((e) => e.summary);
    expect(await summaries()).toEqual(expect.arrayContaining(['Client replied STOP by text: text message updates are off', 'Client sent a text message']));
    // START is only noted. Consent comes back when the client agrees again in the portal, and only then.
    expect((await post({ From: c.number, To: '+14155550100', Body: 'START' })).status).toBe(200);
    expect((await consent(c.clientId))!.revoked_at).not.toBeNull();
    expect(await queue(o, c.clientId, 'dispute_sent')).toBe(0);
    expect(await summaries()).toContain('Client replied START by text. Texts stay off until they turn them on again in the portal.');
    await asUser(c.userId, (db) => grantSmsConsent(db, { orgId: o.orgId, clientId: c.clientId, userId: c.userId, source: 'portal' }));
    expect(await queue(o, c.clientId, 'dispute_sent')).toBe(1);
  });

  it('a retried webhook is stored once, and an ordinary reply lands on the right client', async () => {
    const o = await agency('Reply');
    const c = await portalClient(o);
    const sid = `SM${uniq()}${uniq()}`;
    expect((await post({ MessageSid: sid, From: c.number, To: '+14155550100', Body: 'I uploaded my ID, thanks' })).status).toBe(200);
    expect((await post({ MessageSid: sid, From: c.number, To: '+14155550100', Body: 'I uploaded my ID, thanks' })).status).toBe(200);
    expect(await comms(c.clientId)).toEqual([{ direction: 'inbound', channel: 'sms', status: 'received', body: 'I uploaded my ID, thanks', provider_ref: sid }]);
  });

  it('a number on two client records of one workspace, both with consent: the reply is filed on both, for the same staff; a number nobody has belongs to no one', async () => {
    const o = await agency('Ambiguous', ALL_SMS);
    const shared = phone();
    const a = await portalClient(o, { number: shared, consent: true });
    const b = await portalClient(o, { number: shared, consent: true });
    // A third record carries the number with no consent: it is not told anything.
    const c = await portalClient(o, { number: shared });
    const sid = `SM${uniq()}${uniq()}`;
    // Neither has been texted, so nothing says which record the reply is for. A reply nobody can see would leave texts
    // going out, so both records get it; texts to both pause until someone has read it.
    expect(await recordInboundSms({ sid, from: shared, to: '+14155550100', body: 'Which letter was this about?' })).toEqual({ kind: 'message', matched: 2 });
    for (const x of [a, b]) expect(await comms(x.clientId)).toEqual([{ direction: 'inbound', channel: 'sms', status: 'received', body: 'Which letter was this about?', provider_ref: sid }]);
    expect(await comms(c.clientId)).toEqual([]);
    const seen = await asUser(o.ownerId, (db) => db.rows<{ client_id: string | null; body: string; reviewed: boolean }>('select client_id, body, (reviewed_at is not null) as reviewed from public.sms_inbound where provider_ref like $1 order by provider_ref', [`${sid}%`]));
    expect(seen.map((r) => r.client_id).sort()).toEqual([a.clientId, b.clientId].sort());
    expect(seen.every((r) => r.body === 'Which letter was this about?' && !r.reviewed)).toBe(true);
    // The webhook retried: nothing is filed twice.
    expect(await recordInboundSms({ sid, from: shared, to: '+14155550100', body: 'Which letter was this about?' })).toEqual({ kind: 'duplicate', matched: 0 });
    expect(await comms(a.clientId)).toHaveLength(1);
    // A number nobody has is unmatched, and belongs to no organization: no tenant can read it.
    const orphan = `SM${uniq()}${uniq()}`;
    expect(await recordInboundSms({ sid: orphan, from: phone(), body: 'hello?' })).toEqual({ kind: 'message', matched: 0 });
    expect(await asUser(o.ownerId, (db) => db.rows('select 1 from public.sms_inbound where provider_ref = $1', [orphan]))).toEqual([]);
    await recordInboundSms({ sid: `SM${uniq()}${uniq()}`, from: shared, body: 'STOP' });
    expect((await consent(a.clientId))!.revoked_via).toBe('sms_stop');
    expect((await consent(b.clientId))!.revoked_via).toBe('sms_stop');
  });
});

describe('a STOP can only be undone by the client', () => {
  const NOTE = 'Agreed again on a call with me on Tuesday afternoon.';
  it('staff cannot record a consent over a STOP reply, in the app or in the database; the client can agree again in the portal', async () => {
    const o = await agency('StopStaff', ALL_SMS);
    const c = await portalClient(o, { consent: true });
    await recordInboundSms({ sid: `SM${uniq()}${uniq()}`, from: c.number, body: 'STOP' });
    const staff = () => asUser(o.ownerId, (db) => grantSmsConsent(db, { orgId: o.orgId, clientId: c.clientId, userId: o.ownerId, source: 'staff', note: NOTE }));
    expect(await staff()).toEqual({ ok: false, reason: 'stopped' });
    expect(await asUser(o.ownerId, (db) => db.row('select app.sms_stop_blocks_staff($1, $2) as blocked', [c.clientId, c.number]))).toEqual({ blocked: true });
    // Straight to the table, as staff and as the system connection: the trigger refuses both.
    const raw = (db: Db) => db.run(
      "insert into public.sms_consents (org_id, client_id, phone, consent_text, source, note, recorded_by) values ($1, $2, $3, 'I agree to receive text messages from this business.', 'staff', $4, $5)", [o.orgId, c.clientId, c.number, NOTE, o.ownerId]);
    await expect(asUser(o.ownerId, raw)).rejects.toThrow(/client replied STOP/);
    await expect(withSystem(raw)).rejects.toThrow(/client replied STOP/);
    expect((await consent(c.clientId))!.revoked_via).toBe('sms_stop');
    expect(await queue(o, c.clientId, 'dispute_sent')).toBe(0);
    // The client's own act in the portal is what turns texts back on. After that an ordinary staff record works again.
    expect(await asUser(c.userId, (db) => grantSmsConsent(db, { orgId: o.orgId, clientId: c.clientId, userId: c.userId, source: 'portal' }))).toEqual({ ok: true, phone: c.number });
    expect(await asUser(o.ownerId, (db) => db.row('select app.sms_stop_blocks_staff($1, $2) as blocked', [c.clientId, c.number]))).toEqual({ blocked: false });
    expect(await asUser(c.userId, (db) => revokeSmsConsent(db, { orgId: o.orgId, clientId: c.clientId, userId: c.userId, via: 'portal' }))).toBe(true);
    expect(await staff()).toEqual({ ok: true, phone: c.number });
  });

  it('a number that replied STOP cannot be switched on by staff through another record that never had a consent', async () => {
    const a = await agency('StopA', ALL_SMS);
    const b = await agency('StopB', ALL_SMS);
    const ca = await portalClient(a, { consent: true });
    await recordInboundSms({ sid: `SM${uniq()}${uniq()}`, from: ca.number, body: 'please stop' });
    expect((await consent(ca.clientId))!.revoked_via).toBe('sms_stop');
    const cb = await portalClient(b, { number: ca.number }); // the same number typed into another workspace afterwards
    expect(await asUser(b.ownerId, (db) => grantSmsConsent(db, { orgId: b.orgId, clientId: cb.clientId, userId: b.ownerId, source: 'staff', note: NOTE }))).toEqual({ ok: false, reason: 'stopped' });
    expect(await consent(cb.clientId)).toBeNull();
    // The helper answers only for the caller's own clients.
    expect(await asUser(b.ownerId, (db) => db.row('select app.sms_stop_blocks_staff($1, $2) as blocked', [ca.clientId, ca.number]))).toEqual({ blocked: false });
    expect(await asUser(cb.userId, (db) => db.row('select app.sms_stop_blocks_staff($1, $2) as blocked', [cb.clientId, ca.number]))).toEqual({ blocked: false });
    await expect(asUser(b.ownerId, (db) => db.row('select app.sms_stopped($1, $2)', [cb.clientId, ca.number]))).rejects.toThrow(/permission denied/);
  });

  it('a reply worded as a refusal is a STOP: "opt out", "cancel please", "no more texts"', async () => {
    const o = await agency('StopWords', ALL_SMS);
    for (const body of ['opt out', 'Cancel please', 'please stop', 'no more texts']) {
      const c = await portalClient(o, { consent: true });
      expect(await recordInboundSms({ sid: `SM${uniq()}${uniq()}`, from: c.number, body }), body).toEqual({ kind: 'stop', matched: 1 });
      expect((await consent(c.clientId))!.revoked_via, body).toBe('sms_stop');
    }
  });

  it('any other reply pauses texts to that client until staff have read it; "it asks to stop" ends consent as a STOP', async () => {
    const o = await agency('Paused', ALL_SMS);
    const c = await portalClient(o, { consent: true });
    expect(await recordInboundSms({ sid: `SM${uniq()}${uniq()}`, from: c.number, body: 'I would rather you called me from now on' })).toEqual({ kind: 'message', matched: 1 });
    expect(await asUser(o.ownerId, (db) => pendingSmsReplies(db, c.clientId))).toMatchObject([{ body: 'I would rather you called me from now on' }]);
    expect(await queue(o, c.clientId, 'dispute_sent')).toBe(1);
    expect(await deliverClientUpdates(o.orgId, { now: NOON })).toEqual({ sent: 0, failed: 0, skipped: 0, waiting: 1 });
    expect(textsTo(c.number)).toEqual([]);
    // Staff of another workspace can neither see nor clear it.
    const other = await agency('PausedOther');
    expect(await asUser(other.ownerId, (db) => pendingSmsReplies(db, c.clientId))).toEqual([]);
    await asUser(other.ownerId, (db) => reviewSmsReplies(db, { orgId: other.orgId, clientId: c.clientId, userId: other.ownerId, asksToStop: false }));
    expect(await deliverClientUpdates(o.orgId, { now: NOON })).toMatchObject({ sent: 0, waiting: 1 });
    // "It does not ask to stop": texts resume.
    await asUser(o.ownerId, (db) => reviewSmsReplies(db, { orgId: o.orgId, clientId: c.clientId, userId: o.ownerId, asksToStop: false }));
    expect(await deliverClientUpdates(o.orgId, { now: NOON })).toMatchObject({ sent: 1, waiting: 0 });
    expect(textsTo(c.number)).toHaveLength(1);
    // A second reply, read as a request to stop: consent ends as a STOP, so staff cannot switch it back on.
    await recordInboundSms({ sid: `SM${uniq()}${uniq()}`, from: c.number, body: 'Enough of these, thanks' });
    await asUser(o.ownerId, (db) => reviewSmsReplies(db, { orgId: o.orgId, clientId: c.clientId, userId: o.ownerId, asksToStop: true }));
    expect((await consent(c.clientId))!.revoked_via).toBe('sms_stop');
    expect(await asUser(o.ownerId, (db) => pendingSmsReplies(db, c.clientId))).toEqual([]);
    expect(await asUser(o.ownerId, (db) => grantSmsConsent(db, { orgId: o.orgId, clientId: c.clientId, userId: o.ownerId, source: 'staff', note: NOTE }))).toEqual({ ok: false, reason: 'stopped' });
  });
});

describe('quiet hours where the client is', () => {
  it('holds a text that is inside the window for the workspace but not in the client’s state, and the other way round', async () => {
    const o = await agency('Zones', ALL_SMS); // deployment default zone: Eastern
    const west = await portalClient(o, { consent: true });
    const east = await portalClient(o, { consent: true });
    await withSystem(async (db) => {
      await db.run(`update public.clients set address = '{"state":"CA"}' where id = $1`, [west.clientId]);
      await db.run(`update public.clients set address = '{"state":"NY"}' where id = $1`, [east.clientId]);
    });
    await queue(o, west.clientId, 'dispute_sent');
    await queue(o, east.clientId, 'dispute_sent');
    // 13:30 UTC in mid-January: 8:30 a.m. in New York, 5:30 a.m. in California.
    const early = new Date('2026-01-15T13:30:00Z');
    await withSystem((db) => db.run('update public.client_updates set created_at = $2 where org_id = $1', [o.orgId, new Date('2026-01-15T13:00:00Z')]));
    expect(await deliverClientUpdates(o.orgId, { now: early })).toEqual({ sent: 1, failed: 0, skipped: 0, waiting: 1 });
    expect(textsTo(east.number)).toHaveLength(1);
    expect(textsTo(west.number)).toEqual([]);
    expect(await deliverClientUpdates(o.orgId, { now: new Date('2026-01-15T16:05:00Z') })).toMatchObject({ sent: 1, waiting: 0 }); // 8:05 a.m. Pacific
    // A Pacific workspace does not text its New York client at 8:30 p.m. Pacific (11:30 p.m. Eastern).
    await withSystem((db) => db.run(`update public.organizations set settings = settings || '{"timezone":"America/Los_Angeles"}' where id = $1`, [o.orgId]));
    await queue(o, west.clientId, 'response_recorded');
    await queue(o, east.clientId, 'response_recorded');
    await withSystem((db) => db.run("update public.client_updates set created_at = $2 where org_id = $1 and status = 'queued'", [o.orgId, new Date('2026-01-16T04:00:00Z')]));
    expect(await deliverClientUpdates(o.orgId, { now: new Date('2026-01-16T04:30:00Z') })).toEqual({ sent: 1, failed: 0, skipped: 0, waiting: 1 });
    expect(textsTo(west.number)).toHaveLength(2);
    expect(textsTo(east.number)).toHaveLength(1);
  });
});

describe('another workspace cannot pull a client’s replies away', () => {
  it('a reply goes to the client whose consent is in force for that number, whatever other records carry it', async () => {
    const a = await agency('ReplyA', ALL_SMS);
    const b = await agency('ReplyB', ALL_SMS);
    const ca = await portalClient(a, { consent: true });
    // Workspace B types the same number onto a client of its own, and once recorded (then withdrew) a staff consent for it.
    const cb = await portalClient(b, { number: ca.number });
    await asUser(b.ownerId, (db) => grantSmsConsent(db, { orgId: b.orgId, clientId: cb.clientId, userId: b.ownerId, source: 'staff', note: 'Agreed in the office on Monday morning.' }));
    await asUser(b.ownerId, (db) => revokeSmsConsent(db, { orgId: b.orgId, clientId: cb.clientId, userId: b.ownerId, via: 'staff' }));
    const sid = `SM${uniq()}${uniq()}`;
    expect(await recordInboundSms({ sid, from: ca.number, body: 'Which letter was this about?' })).toEqual({ kind: 'message', matched: 1 });
    expect(await comms(ca.clientId)).toMatchObject([{ direction: 'inbound', body: 'Which letter was this about?' }]);
    expect(await comms(cb.clientId)).toEqual([]);
    expect(await asUser(b.ownerId, (db) => db.rows('select 1 from public.sms_inbound where provider_ref = $1', [sid]))).toEqual([]);
  });

  it('with consent in force in two workspaces, it goes to the one texted most recently; with no way to tell, each is told a reply arrived and neither is shown its wording', async () => {
    const a = await agency('RecentA', ALL_SMS);
    const b = await agency('RecentB', ALL_SMS);
    const ca = await portalClient(a, { consent: true });
    const cb = await portalClient(b, { number: ca.number });
    await asUser(b.ownerId, (db) => grantSmsConsent(db, { orgId: b.orgId, clientId: cb.clientId, userId: b.ownerId, source: 'staff', note: 'Agreed in the office on Monday morning.' }));
    // Nobody has been texted yet: it cannot be told which business the reply was for. Each record is told that a reply
    // arrived, so texts to the number pause in both workspaces, and neither is shown what the person wrote to the other.
    const before = await unmatchedInboundCount();
    const first = `SM${uniq()}${uniq()}`;
    expect(await recordInboundSms({ sid: first, from: ca.number, body: 'Hello, who is this? My card ends 4421.' })).toEqual({ kind: 'message', matched: 2 });
    for (const x of [ca, cb]) {
      expect(await comms(x.clientId)).toEqual([{ direction: 'inbound', channel: 'sms', status: 'received', body: SHARED_REPLY_NOTE, provider_ref: first }]);
      expect((await asUser(x === ca ? a.ownerId : b.ownerId, (db) => pendingSmsReplies(db, x.clientId))).map((r) => r.body)).toEqual([SHARED_REPLY_NOTE]);
    }
    expect(SHARED_REPLY_NOTE).toMatch(/its wording is not shown here\. Texts to this number are paused\./);
    // No tenant can read the message itself: it is kept with no workspace, and the count the scheduled job reports goes up.
    for (const owner of [a.ownerId, b.ownerId]) expect(await asUser(owner, (db) => db.rows<{ body: string }>('select body from public.sms_inbound where provider_ref like $1', [`${first}%`]))).toEqual([{ body: SHARED_REPLY_NOTE }]);
    expect(await withSystem((db) => db.row('select org_id, client_id, body from public.sms_inbound where provider_ref = $1', [first]))).toEqual({ org_id: null, client_id: null, body: 'Hello, who is this? My card ends 4421.' });
    expect(await unmatchedInboundCount()).toBe(before + 1);
    expect((await runScheduledJobs({ onlyOrgIds: [a.orgId] })).unmatchedInboundTexts).toBeGreaterThanOrEqual(1);
    // Staff of each workspace read the note, and texts resume.
    await asUser(a.ownerId, (db) => reviewSmsReplies(db, { orgId: a.orgId, clientId: ca.clientId, userId: a.ownerId, asksToStop: false }));
    await asUser(b.ownerId, (db) => reviewSmsReplies(db, { orgId: b.orgId, clientId: cb.clientId, userId: b.ownerId, asksToStop: false }));
    // A texted its client; the reply that follows is A's, wording and all.
    await queue(a, ca.clientId, 'dispute_sent');
    expect(await deliverClientUpdates(a.orgId, { now: NOON })).toMatchObject({ sent: 1 });
    expect(await recordInboundSms({ sid: `SM${uniq()}${uniq()}`, from: ca.number, body: 'Thanks, I will look tonight' })).toEqual({ kind: 'message', matched: 1 });
    expect((await comms(cb.clientId)).map((m) => m.body)).toEqual([SHARED_REPLY_NOTE]);
    expect((await comms(ca.clientId)).filter((m) => m.direction === 'inbound').map((m) => m.body)).toEqual([SHARED_REPLY_NOTE, 'Thanks, I will look tonight']);
    // STOP still ends consent for the number in both workspaces.
    await recordInboundSms({ sid: `SM${uniq()}${uniq()}`, from: ca.number, body: 'STOP' });
    expect((await consent(ca.clientId))!.revoked_via).toBe('sms_stop');
    expect((await consent(cb.clientId))!.revoked_via).toBe('sms_stop');
  });
});

describe('another organization is unaffected', () => {
  it('one agency’s events, switches, consents and STOP replies never reach another agency’s clients or records', async () => {
    const a = await agency('TenantA', ALL_SMS);
    const b = await agency('TenantB', ALL_SMS);
    const ca = await portalClient(a, { consent: true });
    const cb = await portalClient(b, { consent: true });
    expect(await queue(a, ca.clientId, 'dispute_sent')).toBe(1);
    await deliverClientUpdates(a.orgId, { now: NOON });
    expect(textsTo(ca.number)).toHaveLength(1);
    expect(textsTo(cb.number)).toEqual([]);
    expect(await updates(cb.clientId)).toEqual([]);
    expect(await comms(cb.clientId)).toEqual([]);
    // Staff of B cannot queue for, read or change anything of A's.
    expect(await asUser(b.ownerId, (db) => queueClientUpdate(db, { orgId: a.orgId, clientId: ca.clientId, event: 'dispute_sent', subjectId: 'x' }))).toBe(0);
    expect(await asUser(b.ownerId, (db) => queueClientUpdate(db, { orgId: b.orgId, clientId: ca.clientId, event: 'dispute_sent', subjectId: 'x' }))).toBe(0);
    expect(await asUser(b.ownerId, (db) => db.rows('select 1 from public.client_updates where client_id = $1', [ca.clientId]))).toEqual([]);
    expect(await asUser(b.ownerId, (db) => db.rows('select 1 from public.sms_consents where client_id = $1', [ca.clientId]))).toEqual([]);
    expect(await asUser(b.ownerId, (db) => db.run("update public.sms_consents set revoked_at = now(), revoked_via = 'staff' where client_id = $1", [ca.clientId]))).toBe(0);
    await expect(asUser(b.ownerId, (db) => grantSmsConsent(db, { orgId: a.orgId, clientId: ca.clientId, userId: b.ownerId, source: 'staff', note: 'Trying to record for another agency.' }))).resolves.toEqual({ ok: false, reason: 'not_found' });
    // A's client cannot read B's client's consent either.
    expect(await asUser(ca.userId, (db) => db.rows('select 1 from public.sms_consents where client_id = $1', [cb.clientId]))).toEqual([]);
    // STOP from A's client leaves B's client's consent alone, and B still sends.
    await recordInboundSms({ sid: `SM${uniq()}${uniq()}`, from: ca.number, body: 'STOP' });
    expect((await consent(ca.clientId))!.revoked_via).toBe('sms_stop');
    expect((await consent(cb.clientId))!.revoked_at).toBeNull();
    expect(await queue(b, cb.clientId, 'dispute_sent')).toBe(1);
    await deliverClientUpdates(b.orgId, { now: NOON });
    expect(textsTo(cb.number)).toHaveLength(1);
    expect(textsTo(ca.number)).toHaveLength(1);
  });
});
