import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AiProvider } from '@/lib/ai/provider';
import { getBalance } from '@/lib/ai/credits';
import { runScheduledJobs } from '@/lib/automation/jobs';
import { addDays, isBusinessDay } from '@/lib/business-days';
import { grantSmsConsent, recordInboundSms } from '@/lib/client-updates/service';
import { resetEnvCache } from '@/lib/env';
import { leadTextsOffered, runLeadOutreach, runLeadTexts } from '@/lib/lead-outreach';
import { LEAD_SMS_NEEDS_PHONE, leadSmsConsentText, leadText } from '@/lib/lead-texts';
import { submitLead } from '@/lib/leads';
import { sentLog, type Email, type SendResult } from '@/lib/mailer';
import { PARTNER_CATEGORIES, PARTNER_DAILY_CAP, PARTNER_PER_RUN_CAP, partnerEmail } from '@/lib/partner-emails';
import { parsePartnerList, type PartnerInput } from '@/lib/partner-import';
import { addPartners, optOutPartner, partnerFailureHold, partnerOptOutToken, runPartnerOutreach, type PartnerRunOptions } from '@/lib/partner-outreach';
import { markPartner, partnerAskedToStop, pausePartner, removePartner, resumePartner, retryPartnerStep, setReferredBy, updatePartner } from '@/lib/partners';
import { smsLog, type Sms, type SmsResult } from '@/lib/sms';
import { addClient, addMember, addPortalClient, asUser, closePool, makeOrg, testIp, uniq, withSystem, type TestOrg } from './helpers';

const saved = { ...process.env };
// The development stand-in for texts: written to a log, nothing leaves the machine. Partners must never appear in it.
beforeAll(() => { process.env.SMS_DRIVER = 'log'; resetEnvCache(); });
afterAll(async () => { process.env = { ...saved }; resetEnvCache(); await closePool(); });

const ADDRESS = '12 Main St, Austin, TX 78701';
const REPLY = 'hello@agency.example.test';
type Agency = TestOrg & { slug: string; name: string };

async function agency(label: string, settings: Record<string, unknown> | null = null): Promise<Agency> {
  const o = await makeOrg(label);
  const r = (await withSystem((db) => db.row<{ slug: string; name: string }>('update public.organizations set settings = settings || $2::jsonb where id = $1 returning slug, name', [o.orgId, JSON.stringify(settings ?? {})])))!;
  return { ...o, ...r };
}
/** The partner sequence switched on, with the postal and reply addresses saved. */
const ON = { partner_outreach_enabled: true, lead_mailing_address: ADDRESS, lead_reply_email: REPLY };

// 2026-03-02 is a Monday; 15:00 UTC is mid-morning in New York (the workspace time zone unless one is chosen).
const MON = new Date('2026-03-02T15:00:00Z');
const day = (n: number) => new Date(MON.getTime() + n * 86_400_000);

const P = (over: Partial<PartnerInput> = {}): PartnerInput => ({
  businessName: `Hill Realty ${uniq()}`, contactName: 'Dana Whitfield', category: 'real_estate_agent', email: `p-${uniq()}@biz.example.test`,
  phone: null, city: 'Austin', state: 'TX', language: 'en', sourceNote: null, ...over,
});
const actor = (a: TestOrg) => ({ orgId: a.orgId, userId: a.ownerId, ip: '10.0.0.9' });
const add = async (a: Agency, rows: PartnerInput[]) => (await asUser(a.ownerId, (db) => addPartners(db, actor(a), rows, 'Added by hand.'))).ids;
/** A stand-in for a connected email service: records what would be delivered. */
function outbox(result: Partial<SendResult> = {}) {
  const mails: Email[] = [];
  const send = async (m: Email): Promise<SendResult> => { mails.push(m); return { ok: true, provider: 'resend', providerRef: `ref-${mails.length}`, ...result }; };
  return { mails, opts: { live: true, send } satisfies PartnerRunOptions };
}
const partner = (id: string) => withSystem((db) => db.row<{ status: string; paused: boolean; opted_out: boolean; attested_by: string | null; email: string }>(
  'select status, (paused_at is not null) as paused, (opted_out_at is not null) as opted_out, attested_by, email from public.partners where id = $1', [id]));
const steps = (id: string) => withSystem((db) => db.rows<{ step: string; status: string; attempts: number; subject: string | null; body: string | null; ai_used: boolean; error: string | null }>(
  'select step, status, attempts, subject, body, ai_used, error from public.partner_outreach where partner_id = $1 order by created_at', [id]));
const events = (id: string) => withSystem((db) => db.rows<{ kind: string; summary: string }>('select kind, summary from public.partner_events where partner_id = $1 order by created_at', [id]));
const count = (sql: string, p: unknown[]) => withSystem((db) => db.row<{ n: number }>(sql, p as never[])).then((r) => r!.n);
const sum = (rs: { sent: number }[]) => rs.reduce((n, r) => n + r.sent, 0);

describe('referral partners: the automatic email sequence', () => {
  it('is off by default: a partner on file and a scheduled run send and record nothing', async () => {
    const a = await agency('PartnersOff');
    const [id] = await add(a, [P()]);
    const box = outbox();
    expect(await runPartnerOutreach(a.orgId, { ...box.opts, now: MON })).toEqual({ sent: 0, failed: 0, blocked: 'off', held: null });
    expect((await runScheduledJobs({ onlyOrgIds: [a.orgId], now: MON })).partnerEmails).toBe(0);
    expect(box.mails).toEqual([]);
    expect(await steps(id!)).toEqual([]);
    expect(await partner(id!)).toMatchObject({ status: 'new', paused: false, opted_out: false });
    // The address and reply address alone (saved for the lead follow-up) do not switch it on either.
    await withSystem((db) => db.run('update public.organizations set settings = settings || $2::jsonb where id = $1', [a.orgId, JSON.stringify({ lead_mailing_address: ADDRESS, lead_reply_email: REPLY, lead_followup_enabled: true })]));
    expect((await runPartnerOutreach(a.orgId, { ...box.opts, now: MON })).blocked).toBe('off');
    expect(box.mails).toEqual([]);
  });

  it('needs a postal address, a reply address and a connected email service, even when switched on', async () => {
    const a = await agency('PartnersNeeds', { ...ON, lead_mailing_address: '' });
    const [id] = await add(a, [P()]);
    const box = outbox();
    expect((await runPartnerOutreach(a.orgId, { ...box.opts, now: MON })).blocked).toBe('no_address');
    await withSystem((db) => db.run('update public.organizations set settings = settings || $2::jsonb where id = $1', [a.orgId, JSON.stringify({ lead_mailing_address: ADDRESS, lead_reply_email: '' })]));
    expect((await runPartnerOutreach(a.orgId, { ...box.opts, now: MON })).blocked).toBe('no_reply');
    await withSystem((db) => db.run('update public.organizations set settings = settings || $2::jsonb where id = $1', [a.orgId, JSON.stringify({ lead_reply_email: REPLY })]));
    // Email is not connected in this environment (the log driver delivers nothing): nothing is sent or recorded as sent.
    const before = sentLog.length;
    expect(await runPartnerOutreach(a.orgId, { now: MON })).toEqual({ sent: 0, failed: 0, blocked: 'email_not_connected', held: null });
    expect((await runScheduledJobs({ onlyOrgIds: [a.orgId], now: MON })).partnerEmails).toBe(0);
    expect(sentLog.length).toBe(before);
    expect(box.mails).toEqual([]);
    expect(await steps(id!)).toEqual([]);
  });

  it('a business name that makes a promise blocks the sequence instead of putting the claim in every email', async () => {
    const a = await agency('PartnersName', ON);
    await withSystem((db) => db.run("update public.organizations set name = 'Guaranteed Credit Fixers' where id = $1", [a.orgId]));
    await add(a, [P()]);
    const box = outbox();
    expect((await runPartnerOutreach(a.orgId, { ...box.opts, now: MON })).blocked).toBe('name_claim');
    expect(box.mails).toEqual([]);
  });

  it('switched on: each step goes out once, on its business day, even when runs overlap, and every send is recorded', async () => {
    const a = await agency('PartnersOn', ON);
    const [en, es, bare] = await add(a, [
      P(), P({ contactName: 'Ana Ruiz', category: 'car_dealership', city: null, state: null, language: 'es' }), P({ contactName: null, category: 'other' }),
    ]) as [string, string, string];
    const box = outbox();
    const run = (now: Date) => runPartnerOutreach(a.orgId, { ...box.opts, now });

    // Three runs at the same moment and a retry still send one introduction per partner.
    expect(sum(await Promise.all([run(MON), run(MON), run(MON)]))).toBe(3);
    expect(await run(MON)).toEqual({ sent: 0, failed: 0, blocked: null, held: null });
    expect(box.mails).toHaveLength(3);
    const to = async (id: string) => box.mails.filter((m) => m.to === (rows[id]!));
    const rows: Record<string, string> = {};
    for (const id of [en, es, bare]) rows[id] = (await partner(id))!.email;

    const intro = (await to(en))[0]!;
    expect(intro.subject).toBe(`Introducing ${a.name}: credit report help for your buyers`);
    expect(intro.replyTo).toBe(REPLY);
    expect(intro.fromName).toBe(a.name); // the From line names the agency, not the platform
    expect(intro.text).toContain('Hello Dana,');
    expect(intro.text).toContain('you work as a real estate agent in Austin, TX.');
    expect(intro.text).toContain(`This is a business solicitation from ${a.name}.`);
    expect(intro.text).toContain(`${a.name} · ${ADDRESS}`);
    expect(intro.text).toContain(`Stop these emails: http://localhost:3000/unsubscribe/partner/${partnerOptOutToken(en)}`);
    // It is exactly the standard wording for this partner: nothing else was added on the way out.
    expect(intro.text).toBe(partnerEmail('intro', 'en', { contactName: 'Dana Whitfield', category: 'real_estate_agent', city: 'Austin', state: 'TX', orgName: a.name, address: ADDRESS, optOutUrl: `http://localhost:3000/unsubscribe/partner/${partnerOptOutToken(en)}`, siteUrl: null }).text);
    expect((await to(es))[0]!.text).toContain('Hola Ana:');
    expect((await to(es))[0]!.text).toContain(`Este mensaje es una oferta comercial de ${a.name}.`);
    expect((await to(bare))[0]!.text.startsWith('Hello,\n\n')).toBe(true);
    // Recorded: the step, the email exactly as sent, the status and the timeline.
    expect(await steps(en)).toEqual([{ step: 'intro', status: 'sent', attempts: 1, subject: intro.subject, body: intro.text, ai_used: false, error: null }]);
    expect(await partner(en)).toMatchObject({ status: 'in_sequence' });
    expect((await events(en)).map((e) => e.kind)).toEqual(['added', 'email_sent']);

    // Tuesday to Thursday nothing is due; Friday (4 business days) the follow-up; Saturday nothing at all.
    for (const n of [1, 2, 3]) expect((await run(day(n))).sent).toBe(0);
    expect(sum(await Promise.all([run(day(4)), run(day(4))]))).toBe(3);
    expect(await run(day(4))).toEqual({ sent: 0, failed: 0, blocked: null, held: null });
    expect(await run(day(5))).toEqual({ sent: 0, failed: 0, blocked: null, held: 'not_business_day' });
    // The last note is due 9 business days after the introduction (Friday 13 March), not before.
    expect((await run(day(10))).sent).toBe(0);
    expect(sum(await Promise.all([run(day(11)), run(day(11))]))).toBe(3);
    for (const n of [14, 21, 60]) expect((await run(day(n))).sent).toBe(0);

    for (const id of [en, es, bare]) {
      expect((await steps(id)).map((s) => `${s.step}:${s.status}:${s.attempts}`)).toEqual(['intro:sent:1', 'followup:sent:1', 'final:sent:1']);
      expect(await partner(id)).toMatchObject({ status: 'finished' });
      expect(await to(id)).toHaveLength(3);
    }
    expect((await to(en)).map((m) => m.subject)).toEqual([`Introducing ${a.name}: credit report help for your buyers`, `Following up: ${a.name} and your buyers`, `Last note from ${a.name}`]);
    expect(box.mails).toHaveLength(9);
    // Every email of every step carries the agency name, the postal address and that partner's own opt-out link.
    for (const id of [en, es, bare]) for (const m of await to(id)) {
      expect(m.text).toContain(`${a.name} · ${ADDRESS}`);
      expect(m.text).toContain(`/unsubscribe/partner/${partnerOptOutToken(id)}`);
    }
  });

  it('stops on an opt-out, a recorded reply, interested, not interested, a bounce and a manual pause', async () => {
    const a = await agency('PartnersStop', ON);
    const ids = await add(a, [P(), P(), P(), P(), P(), P(), P()]);
    const [optedOut, replied, interested, declined, bounced, paused, untouched] = ids as [string, string, string, string, string, string, string];
    const box = outbox();
    expect((await runPartnerOutreach(a.orgId, { ...box.opts, now: MON })).sent).toBe(7);

    expect(await optOutPartner('not-a-token')).toBeNull();
    expect(await optOutPartner(partnerOptOutToken(optedOut).slice(0, -2) + 'xx')).toBeNull();
    expect(await optOutPartner(partnerOptOutToken(optedOut))).toEqual({ orgId: a.orgId, orgName: a.name, lang: 'en' });
    await optOutPartner(partnerOptOutToken(optedOut)); // opening the link twice changes nothing
    expect((await events(optedOut)).filter((e) => e.kind === 'opted_out')).toHaveLength(1);
    expect(await partner(optedOut)).toMatchObject({ status: 'opted_out', opted_out: true });
    await asUser(a.ownerId, async (db) => {
      expect(await markPartner(db, actor(a), replied, 'replied')).toBe(true);
      expect(await markPartner(db, actor(a), interested, 'interested')).toBe(true);
      expect(await markPartner(db, actor(a), declined, 'not_interested')).toBe(true);
      expect(await markPartner(db, actor(a), bounced, 'bounced')).toBe(true);
      expect(await pausePartner(db, actor(a), paused)).toBe(true);
      expect(await markPartner(db, actor(a), replied, 'replied')).toBe(false); // already recorded
    });

    // On the day the follow-up is due only the partner nobody stopped gets it.
    expect(await runPartnerOutreach(a.orgId, { ...box.opts, now: day(4) })).toEqual({ sent: 1, failed: 0, blocked: null, held: null });
    expect((await steps(untouched)).map((s) => s.step)).toEqual(['intro', 'followup']);
    for (const id of [optedOut, replied, interested, declined, bounced, paused]) expect((await steps(id)).map((s) => s.step)).toEqual(['intro']);
    // Resuming a pause lets that one continue; the others stay stopped for good.
    await asUser(a.ownerId, (db) => resumePartner(db, actor(a), paused));
    expect((await runPartnerOutreach(a.orgId, { ...box.opts, now: day(7) })).sent).toBe(1);
    expect((await steps(paused)).map((s) => s.step)).toEqual(['intro', 'followup']);
    expect((await runPartnerOutreach(a.orgId, { ...box.opts, now: day(21) })).sent).toBe(2); // the last notes for the two still in the sequence
    expect(box.mails).toHaveLength(7 + 1 + 1 + 2);
    expect((await events(replied)).at(-1)).toEqual({ kind: 'replied', summary: 'Marked as replied. The automatic emails stopped; the reply itself is in your own mailbox.' });
  });

  it('re-checks every stop condition at the moment of sending, not only when the run started', async () => {
    const a = await agency('PartnersRecheck', ON);
    const [first, second] = await add(a, [P(), P()]) as [string, string];
    const mails: Email[] = [];
    // While the first email is with the email service, the other partner opts out and the switch is turned off.
    const send = async (m: Email): Promise<SendResult> => {
      mails.push(m);
      const other = (await partner(first))!.email === m.to ? second : first;
      await optOutPartner(partnerOptOutToken(other));
      return { ok: true, provider: 'resend', providerRef: 'ref' };
    };
    expect(await runPartnerOutreach(a.orgId, { live: true, send, now: MON })).toEqual({ sent: 1, failed: 0, blocked: null, held: null });
    expect(mails).toHaveLength(1);
    const stopped = (await partner(first))!.email === mails[0]!.to ? second : first;
    expect(await steps(stopped)).toEqual([]);
    expect(await partner(stopped)).toMatchObject({ status: 'opted_out' });

    // Turning the switch off mid-run stops the rest of the run.
    const b = await agency('PartnersSwitch', ON);
    await add(b, [P(), P(), P()]);
    const sent: Email[] = [];
    const off = async (m: Email): Promise<SendResult> => {
      sent.push(m);
      await withSystem((db) => db.run("update public.organizations set settings = settings || '{\"partner_outreach_enabled\": false}'::jsonb where id = $1", [b.orgId]));
      return { ok: true, provider: 'resend' };
    };
    expect(await runPartnerOutreach(b.orgId, { live: true, send: off, now: MON })).toEqual({ sent: 1, failed: 0, blocked: null, held: 'switched_off' });
    expect(sent).toHaveLength(1);
  });

  it('an opt-out is permanent for that address within the agency: it cannot be undone, edited away or re-added', async () => {
    const a = await agency('PartnersForever', ON);
    const row = P();
    const [id] = await add(a, [row]) as [string];
    await asUser(a.ownerId, (db) => partnerAskedToStop(db, actor(a), id)); // asked by phone, recorded by the team, nothing was ever sent
    expect(await partner(id)).toMatchObject({ status: 'opted_out', opted_out: true });
    expect((await events(id)).at(-1)!.summary).toBe('Asked not to be emailed (recorded by the team). No further email is sent to this address.');

    // Staff cannot lift it, and neither can the system connection.
    await expect(asUser(a.ownerId, (db) => db.run("update public.partners set status = 'new', opted_out_at = null where id = $1", [id]))).rejects.toThrow(/opt-out cannot be undone/);
    await expect(withSystem((db) => db.run("update public.partners set status = 'in_sequence', opted_out_at = null where id = $1", [id]))).rejects.toThrow(/opt-out cannot be undone/);
    await expect(asUser(a.ownerId, (db) => db.run("update public.partners set status = 'interested' where id = $1", [id]))).rejects.toThrow(/partners_opt_out_check|opt-out cannot be undone/);
    expect(await asUser(a.ownerId, (db) => markPartner(db, actor(a), id, 'interested'))).toBe(false);
    // The address the opt-out belongs to cannot be changed, for any partner.
    await expect(asUser(a.ownerId, (db) => db.run("update public.partners set email = 'someone-else@biz.example.test' where id = $1", [id]))).rejects.toThrow(/email address of a partner cannot be changed/);
    // It cannot be removed and added again, and adding the address again is simply skipped.
    expect(await asUser(a.ownerId, (db) => removePartner(db, actor(a), id))).toBe(false);
    expect(await asUser(a.ownerId, (db) => addPartners(db, actor(a), [{ ...row, businessName: 'Same Address, New Name' }], 'Imported'))).toEqual({ added: 0, existing: 1, ids: [] });
    expect(await count('select count(*)::int as n from public.partners where org_id = $1 and email = $2', [a.orgId, row.email])).toBe(1);

    const box = outbox();
    for (const n of [0, 4, 11]) expect((await runPartnerOutreach(a.orgId, { ...box.opts, now: day(n) })).sent).toBe(0);
    expect(box.mails).toEqual([]);
    // Editing the other details is still possible and never touches the opt-out.
    expect(await asUser(a.ownerId, (db) => updatePartner(db, actor(a), id, { ...row, businessName: 'Renamed Realty', city: 'Dallas' }))).toBe(true);
    expect(await partner(id)).toMatchObject({ status: 'opted_out', opted_out: true, email: row.email });
  });

  it('a failed send stops the sequence for that partner, two in a row stop the run, and a person can ask for another try', async () => {
    const a = await agency('PartnersFail', ON);
    const ids = await add(a, [P(), P(), P(), P()]);
    const bad = outbox({ ok: false, error: 'domain not verified' });
    expect(await runPartnerOutreach(a.orgId, { ...bad.opts, now: MON })).toEqual({ sent: 0, failed: 2, blocked: null, held: 'failures' });
    expect(bad.mails).toHaveLength(2);
    const all = await Promise.all(ids.map(async (id) => ({ id, steps: await steps(id), email: (await partner(id))!.email })));
    const failed = all.filter((p) => p.steps.length);
    const waiting = all.filter((p) => !p.steps.length);
    expect(failed).toHaveLength(2);
    for (const f of failed) {
      expect(f.steps).toMatchObject([{ step: 'intro', status: 'failed', attempts: 1, error: 'domain not verified' }]);
      expect(await partner(f.id)).toMatchObject({ status: 'new' }); // never recorded as sent or in sequence
      expect((await events(f.id)).at(-1)).toEqual({ kind: 'email_failed', summary: 'Introduction email was not sent: domain not verified. The sequence stopped for this partner.' });
    }

    // The owner is told, once, with the reason; and the sequence holds instead of stopping two more partners with every run.
    const told = () => withSystem((db) => db.rows<{ user_id: string; body: string; href: string }>("select user_id, body, href from public.notifications where org_id = $1 and title = 'Partner emails are not going out'", [a.orgId]));
    expect(await told()).toEqual([{ user_id: a.ownerId, href: '/app/partners', body: 'The email service refused 2 partner emails in a row (domain not verified). Nothing more is tried for 24 hours, or until you press “Try again” on one of those partners.' }]);
    expect(await withSystem((db) => partnerFailureHold(db, a.orgId, MON))).toBe('domain not verified');
    const good = outbox();
    for (const now of [MON, new Date(MON.getTime() + 23 * 3_600_000)]) expect(await runPartnerOutreach(a.orgId, { ...good.opts, now })).toEqual({ sent: 0, failed: 0, blocked: null, held: 'failures' });
    expect(bad.mails).toHaveLength(2);
    expect(good.mails).toEqual([]);
    for (const w of waiting) expect(await steps(w.id)).toEqual([]); // untouched, not stopped

    // "Try again" on one of them lifts the hold: it goes out as a second attempt, and the two untouched partners get theirs.
    const again = failed[0]!;
    expect(await asUser(a.ownerId, (db) => retryPartnerStep(db, actor(a), again.id))).toBe(true);
    expect(await asUser(a.ownerId, (db) => retryPartnerStep(db, actor(a), again.id))).toBe(false);
    expect(await withSystem((db) => partnerFailureHold(db, a.orgId, MON))).toBeNull();
    expect(await runPartnerOutreach(a.orgId, { ...good.opts, now: day(1) })).toEqual({ sent: 3, failed: 0, blocked: null, held: null });
    expect(good.mails.map((m) => m.to).sort()).toEqual([again.email, ...waiting.map((w) => w.email)].sort());
    expect(await steps(again.id)).toMatchObject([{ step: 'intro', status: 'sent', attempts: 2, error: null }]);
    expect(await partner(again.id)).toMatchObject({ status: 'in_sequence' });
    expect((await runPartnerOutreach(a.orgId, { ...good.opts, now: day(1) })).sent).toBe(0);
    expect(await told()).toHaveLength(1);

    // Three attempts in all, then it stays stopped whatever is pressed.
    const stuck = failed[1]!;
    for (const attempts of [2, 3]) {
      await asUser(a.ownerId, (db) => retryPartnerStep(db, actor(a), stuck.id));
      expect((await runPartnerOutreach(a.orgId, { ...bad.opts, now: day(1), partnerId: stuck.id })).failed).toBe(1);
      expect(await steps(stuck.id)).toMatchObject([{ status: 'failed', attempts }]);
    }
    await asUser(a.ownerId, (db) => retryPartnerStep(db, actor(a), stuck.id));
    expect(await runPartnerOutreach(a.orgId, { ...good.opts, now: day(2), partnerId: stuck.id })).toEqual({ sent: 0, failed: 0, blocked: null, held: null });
    // A staff member can only ask for a retry: the log itself cannot be rewritten through a tenant request.
    await expect(asUser(a.ownerId, (db) => db.run("update public.partner_outreach set status = 'sent' where partner_id = $1", [again.id]))).resolves.toBe(0);
    await expect(asUser(a.ownerId, (db) => db.run("update public.partner_outreach set body = 'x' where partner_id = $1", [again.id]))).rejects.toThrow(/permission denied/);
    await expect(asUser(a.ownerId, (db) => db.run("insert into public.partner_outreach (org_id, partner_id, step, status) values ($1, $2, 'final', 'sent')", [a.orgId, again.id]))).rejects.toThrow(/permission denied/);
  });

  it('after two refusals in a row the sequence holds for a day, then tries again by itself', async () => {
    const a = await agency('PartnersHold', ON);
    await add(a, [P(), P(), P(), P(), P()]);
    const bad = outbox({ ok: false, error: 'API key is invalid' });
    const good = outbox();
    expect(await runPartnerOutreach(a.orgId, { ...bad.opts, now: MON })).toEqual({ sent: 0, failed: 2, blocked: null, held: 'failures' });
    // However often the job runs that day, nobody else is tried and stopped.
    for (const hours of [0, 1, 6, 23]) expect(await runPartnerOutreach(a.orgId, { ...bad.opts, now: new Date(MON.getTime() + hours * 3_600_000) })).toEqual({ sent: 0, failed: 0, blocked: null, held: 'failures' });
    expect(bad.mails).toHaveLength(2);
    expect(await count("select count(*)::int as n from public.partner_outreach where org_id = $1", [a.orgId])).toBe(2);
    // A day later it tries again without anyone doing anything; the two that failed stay stopped until someone asks.
    expect(await runPartnerOutreach(a.orgId, { ...good.opts, now: new Date(MON.getTime() + 25 * 3_600_000) })).toEqual({ sent: 3, failed: 0, blocked: null, held: null });
    expect(await count("select count(*)::int as n from public.partner_outreach where org_id = $1 and status = 'failed'", [a.orgId])).toBe(2);
    // One notification per owner or admin, not one per run.
    expect(await count("select count(*)::int as n from public.notifications where org_id = $1 and title = 'Partner emails are not going out'", [a.orgId])).toBe(1);
  });

  it('if the outcome of a send is never recorded, that step is not sent again and nothing follows it', async () => {
    const a = await agency('PartnersCrash', ON);
    const [id] = await add(a, [P()]) as [string];
    // What a run leaves behind when the process dies after handing the email over and before writing the result.
    await withSystem((db) => db.run("insert into public.partner_outreach (org_id, partner_id, step, status, claimed_at) values ($1, $2, 'intro', 'sending', $3)", [a.orgId, id, MON]));
    const box = outbox();
    for (const n of [0, 4, 11, 30]) expect(await runPartnerOutreach(a.orgId, { ...box.opts, now: day(n) })).toEqual({ sent: 0, failed: 0, blocked: null, held: null });
    expect(box.mails).toEqual([]);
    expect(await steps(id)).toMatchObject([{ step: 'intro', status: 'sending', attempts: 1 }]);
  });

  it('the claim is on record before the email is handed over, and no transaction is open during the send', async () => {
    const a = await agency('PartnersClaimFirst', ON);
    const [id] = await add(a, [P()]) as [string];
    let seen: { step: string; status: string }[] = [];
    const send = async (): Promise<SendResult> => {
      seen = (await steps(id)).map(({ step, status }) => ({ step, status })); // a separate connection can already see the committed claim
      // …and can change the partner: neither the row nor the per-agency lock is held while the email service is called.
      await withSystem(async (db) => {
        await db.run("set local lock_timeout = '2s'");
        await db.run('update public.partners set source_note = $2 where id = $1', [id, 'edited during the send']);
        await db.run('select pg_advisory_xact_lock(hashtextextended($1, 28))', [`partner-outreach:${a.orgId}`]);
      });
      return { ok: true, provider: 'resend', providerRef: 'r1' };
    };
    expect((await runPartnerOutreach(a.orgId, { live: true, send, now: MON })).sent).toBe(1);
    expect(seen).toEqual([{ step: 'intro', status: 'sending' }]);
    expect(await steps(id)).toMatchObject([{ step: 'intro', status: 'sent' }]);
  });

  it(`sends at most ${PARTNER_PER_RUN_CAP} in one run and ${PARTNER_DAILY_CAP} in any 24 hours, however many runs overlap`, async () => {
    const a = await agency('PartnersCap', ON);
    await add(a, Array.from({ length: PARTNER_DAILY_CAP + 5 }, () => P()));
    const box = outbox();
    const run = (now: Date) => runPartnerOutreach(a.orgId, { ...box.opts, now });

    const first = await run(MON);
    expect(first).toEqual({ sent: PARTNER_PER_RUN_CAP, failed: 0, blocked: null, held: null }); // a list is spread over runs, never sent at once
    // Six runs at the same moment could send sixty more; the limit holds at exactly forty for the day.
    const burst = await Promise.all(Array.from({ length: 6 }, () => run(MON)));
    expect(first.sent + sum(burst)).toBe(PARTNER_DAILY_CAP);
    expect(burst.some((r) => r.held === 'daily_cap')).toBe(true);
    expect(await run(MON)).toEqual({ sent: 0, failed: 0, blocked: null, held: 'daily_cap' });
    expect(await run(new Date(MON.getTime() + 23 * 3_600_000))).toMatchObject({ sent: 0, held: 'daily_cap' });
    expect(box.mails).toHaveLength(PARTNER_DAILY_CAP);
    expect(new Set(box.mails.map((m) => m.to)).size).toBe(PARTNER_DAILY_CAP); // nobody was written to twice
    expect(await count("select count(*)::int as n from public.partner_outreach where org_id = $1 and status = 'sent'", [a.orgId])).toBe(PARTNER_DAILY_CAP);
    // A day later the rest go out.
    expect(await run(new Date(MON.getTime() + 25 * 3_600_000))).toEqual({ sent: 5, failed: 0, blocked: null, held: null });
    expect(new Set(box.mails.map((m) => m.to)).size).toBe(PARTNER_DAILY_CAP + 5);
  });

  it('the 24-hour limit is exact when two runs claim different partners at the same moment', async () => {
    const a = await agency('PartnersCapRace', ON);
    // One short of the limit already sent today.
    const done = await add(a, Array.from({ length: PARTNER_DAILY_CAP - 1 }, () => P()));
    await withSystem(async (db) => {
      await db.run("insert into public.partner_outreach (org_id, partner_id, step, status, claimed_at, sent_at) select $1, id, 'intro', 'sent', $3, $3 from unnest($2::uuid[]) as id", [a.orgId, done, MON]);
      await db.run("update public.partners set status = 'in_sequence' where id = any($1::uuid[])", [done]);
    });
    for (let round = 0; round < 3; round++) {
      const [one, two] = await add(a, [P(), P()]) as [string, string];
      const box = outbox();
      const now = new Date(MON.getTime() + round * 25 * 3_600_000); // Monday, Tuesday, Wednesday: a fresh window each round
      await withSystem((db) => db.run('update public.partner_outreach set claimed_at = $2, sent_at = $2 where partner_id = any($1::uuid[])', [done, now]));
      // Each run is limited to its own partner, so nothing but the limit itself stands between them.
      const runs = await Promise.all([runPartnerOutreach(a.orgId, { ...box.opts, now, partnerId: one }), runPartnerOutreach(a.orgId, { ...box.opts, now, partnerId: two })]);
      expect(sum(runs)).toBe(1);
      expect(runs.filter((r) => r.held === 'daily_cap')).toHaveLength(1);
      expect(box.mails).toHaveLength(1);
      // Take both out of the way for the next round.
      await asUser(a.ownerId, async (db) => { await markPartner(db, actor(a), one, 'not_interested'); await markPartner(db, actor(a), two, 'not_interested'); });
      await withSystem((db) => db.run('delete from public.partner_outreach where partner_id = any($1::uuid[])', [[one, two]]));
    }
  });

  it('nothing is ever texted or queued for a partner, and no call exists: a phone number is only stored', async () => {
    const number = `+1512555${String(Math.floor(Math.random() * 10_000)).padStart(4, '0')}`;
    // Text follow-up for leads is on and a text service is "connected" here, so anything that could text would.
    const a = await agency('PartnersNoText', { ...ON, lead_followup_enabled: true, lead_followup_since: new Date(Date.now() - 60_000).toISOString(), lead_text_followup: true });
    const [id] = await add(a, [P({ phone: number })]) as [string];
    const texts = smsLog.length;
    const box = outbox();
    expect((await runPartnerOutreach(a.orgId, { ...box.opts, now: MON })).sent).toBe(1);
    expect((await runLeadTexts(a.orgId, { now: MON })).sent).toBe(0);
    const jobs = await runScheduledJobs({ onlyOrgIds: [a.orgId], now: day(4) });
    expect(jobs.leadTexts).toBe(0);
    expect(jobs.clientUpdates).toBe(0);
    expect(smsLog.length).toBe(texts);
    expect(smsLog.some((m) => m.to === number)).toBe(false);
    expect(box.mails.every((m) => !m.text.includes(number) && !/\b(text|call) you\b/i.test(m.text))).toBe(true);
    // A partner is not a client: nothing that carries a text or a call can point at one.
    expect(await count('select count(*)::int as n from public.communications where org_id = $1', [a.orgId])).toBe(0);
    expect(await count('select count(*)::int as n from public.client_updates where org_id = $1', [a.orgId])).toBe(0);
    expect(await count('select count(*)::int as n from public.sms_consents where org_id = $1', [a.orgId])).toBe(0);
    expect(await count("select count(*)::int as n from information_schema.columns where table_schema = 'public' and table_name like 'partner%' and column_name in ('channel', 'sms', 'call', 'to_phone')", [])).toBe(0);
    expect(await steps(id)).toMatchObject([{ step: 'intro', status: 'sent' }]);
    expect((await partner(id))!.status).toBe('in_sequence');
  });

  it('another agency is unaffected, and cannot see or change the partners of this one', async () => {
    const a = await agency('PartnersA', ON);
    const b = await agency('PartnersB');
    const shared = `shared-${uniq()}@biz.example.test`;
    const [pa] = await add(a, [P({ email: shared })]) as [string];
    const [pb] = await add(b, [P({ email: shared })]) as [string]; // the same address may be on two agencies' lists
    const box = outbox();
    expect((await runPartnerOutreach(a.orgId, { ...box.opts, now: MON })).sent).toBe(1);
    expect((await runPartnerOutreach(b.orgId, { ...box.opts, now: MON })).blocked).toBe('off');
    expect(box.mails).toHaveLength(1);
    expect(await steps(pb)).toEqual([]);
    // An opt-out from agency A's email only ever stops agency A.
    await optOutPartner(partnerOptOutToken(pa));
    expect(await partner(pb)).toMatchObject({ status: 'new', opted_out: false });
    // Row-level security: B's owner sees none of A's partners, log or timeline, and cannot write to them.
    expect(await asUser(b.ownerId, (db) => db.rows('select id from public.partners where id = $1', [pa]))).toEqual([]);
    expect(await asUser(b.ownerId, (db) => db.rows('select id from public.partner_outreach where partner_id = $1', [pa]))).toEqual([]);
    expect(await asUser(b.ownerId, (db) => db.rows('select id from public.partner_events where partner_id = $1', [pa]))).toEqual([]);
    expect(await asUser(b.ownerId, (db) => markPartner(db, actor(b), pa, 'interested'))).toBe(false);
    expect(await asUser(b.ownerId, (db) => db.run("update public.partners set business_name = 'Taken' where id = $1", [pa]))).toBe(0);
    await expect(asUser(b.ownerId, (db) => addPartners(db, { orgId: a.orgId, userId: b.ownerId }, [P()], 'x'))).rejects.toThrow(/row-level security/);
    await expect(asUser(b.ownerId, (db) => db.run("insert into public.partner_events (org_id, partner_id, actor_id, kind, summary) values ($1, $2, $3, 'note', 'x')", [b.orgId, pa, b.ownerId]))).rejects.toThrow(/row-level security/);
  });
});

describe('adding partners', () => {
  it('a pasted list is validated, repeated addresses are dropped, and addresses already on file are skipped', async () => {
    const a = await agency('PartnersImport');
    const u = uniq();
    const list = [
      'Business name,Contact name,Email,Category,City,State,Phone',
      `"Hill, Dale & Co",Dana Hill,DANA@hill-${u}.example,Realtor,Austin,tx,(512) 555-0134`,
      `Key Motors,,sales@key-${u}.example,car dealer,Round Rock,TX,`,
      `Hill Dale again,,dana@HILL-${u}.example,realtor,,,`,
      'No Address Co,,not-an-email,loan officer,,,',
      `Odd Co,,odd@odd-${u}.example,astronaut,,,`,
    ].join('\n');
    const parsed = parsePartnerList(list, null);
    expect(parsed.rows.map((r) => r.email)).toEqual([`dana@hill-${u}.example`, `sales@key-${u}.example`]);
    expect(parsed.repeated).toBe(1);
    expect(parsed.issues.map((i) => i.line)).toEqual([5, 6]);

    const specialist = await addMember(a.orgId, 'specialist');
    const first = await asUser(specialist.id, (db) => addPartners(db, { orgId: a.orgId, userId: specialist.id }, parsed.rows, 'Imported from a list.'));
    expect(first).toMatchObject({ added: 2, existing: 0 });
    // Importing the same list again, or a list that overlaps, adds only what is new.
    const more = parsePartnerList(`business,email,category\nKey Motors,SALES@key-${u}.example,car dealer\nNorth Tax,hello@north-${u}.example,tax preparer`, null);
    expect(await asUser(a.ownerId, (db) => addPartners(db, actor(a), more.rows, 'Imported from a list.'))).toMatchObject({ added: 1, existing: 1 });
    expect(await count('select count(*)::int as n from public.partners where org_id = $1', [a.orgId])).toBe(3);
    // Each row records who attested it, and starts as "new" with nothing sent.
    const rows = await withSystem((db) => db.rows<{ email: string; category: string; state: string | null; status: string; attested_by: string }>('select email, category, state, status, attested_by from public.partners where org_id = $1 order by email', [a.orgId]));
    expect(rows).toEqual([
      { email: `dana@hill-${u}.example`, category: 'real_estate_agent', state: 'TX', status: 'new', attested_by: specialist.id },
      { email: `hello@north-${u}.example`, category: 'tax_preparer', state: null, status: 'new', attested_by: a.ownerId },
      { email: `sales@key-${u}.example`, category: 'car_dealership', state: 'TX', status: 'new', attested_by: specialist.id },
    ]);
    expect(await count("select count(*)::int as n from public.partner_events e join public.partners p on p.id = e.partner_id where p.org_id = $1 and e.kind = 'added'", [a.orgId])).toBe(3);
    // Every category the form offers is one the table accepts.
    expect((await add(a, PARTNER_CATEGORIES.map((category) => P({ category })))).length).toBe(PARTNER_CATEGORIES.length);
  });

  it('only staff of the agency can add, nobody can attest for someone else, and a row cannot start part-way through', async () => {
    const a = await agency('PartnersGuard');
    const portal = await addPortalClient(a.orgId);
    await expect(asUser(portal.userId, (db) => addPartners(db, { orgId: a.orgId, userId: portal.userId }, [P()], 'x'))).rejects.toThrow(/row-level security/);
    const other = await addMember(a.orgId, 'specialist');
    await expect(asUser(a.ownerId, (db) => addPartners(db, { orgId: a.orgId, userId: other.id }, [P()], 'x'))).rejects.toThrow(/row-level security/);
    const ins = (cols: string, vals: string) => asUser(a.ownerId, (db) => db.run(
      `insert into public.partners (org_id, business_name, category, email, attested_by${cols}) values ($1, 'X Co', 'other', $2, $3${vals})`, [a.orgId, `x-${uniq()}@biz.example.test`, a.ownerId]));
    await expect(ins(', status', ", 'finished'")).rejects.toThrow(/row-level security/);
    await expect(ins(', status, opted_out_at', ", 'opted_out', now()")).rejects.toThrow(/row-level security/);
    await expect(asUser(a.ownerId, (db) => db.run("insert into public.partners (org_id, business_name, category, email, attested_by) values ($1, 'X', 'astronaut', $2, $3)", [a.orgId, `x-${uniq()}@biz.example.test`, a.ownerId]))).rejects.toThrow(/partners_category_check/);
    await expect(asUser(a.ownerId, (db) => db.run("insert into public.partners (org_id, business_name, category, email, attested_by) values ($1, 'X', 'other', 'Not-Lowercase@x.example', $2)", [a.orgId, a.ownerId]))).rejects.toThrow(/partners_email_check/);
    expect(await ins('', '')).toBe(1);
    // The record of who added a partner cannot be rewritten afterwards.
    await expect(asUser(a.ownerId, (db) => db.run('update public.partners set attested_by = $2 where org_id = $1', [a.orgId, other.id]))).rejects.toThrow(/who added a partner cannot be edited/);
  });

  it('a partner nothing was sent to can be removed; one that was emailed, or has a referred client, cannot', async () => {
    const a = await agency('PartnersRemove', ON);
    const [typo, emailed, referrer] = await add(a, [P(), P(), P()]) as [string, string, string];
    await asUser(a.ownerId, (db) => pausePartner(db, actor(a), typo));
    await asUser(a.ownerId, (db) => pausePartner(db, actor(a), referrer));
    const box = outbox();
    expect((await runPartnerOutreach(a.orgId, { ...box.opts, now: MON })).sent).toBe(1);
    const clientId = await addClient(a.orgId, 'Referred Client');
    await asUser(a.ownerId, (db) => setReferredBy(db, actor(a), clientId, referrer));
    expect(await asUser(a.ownerId, (db) => removePartner(db, actor(a), emailed))).toBe(false);
    expect(await asUser(a.ownerId, (db) => removePartner(db, actor(a), referrer))).toBe(false);
    expect(await asUser(a.ownerId, (db) => removePartner(db, actor(a), typo))).toBe(true);
    expect(await partner(typo)).toBeNull();
    expect(await partner(emailed)).not.toBeNull();
  });
});

describe('referred by', () => {
  it('a client can be linked to the partner who sent them, counted on the partner, changed and cleared', async () => {
    const a = await agency('PartnersReferral');
    const b = await agency('PartnersReferralB');
    const [p1, p2] = await add(a, [P(), P()]) as [string, string];
    const [foreign] = await add(b, [P()]) as [string];
    const c1 = await addClient(a.orgId, 'First Client');
    const c2 = await addClient(a.orgId, 'Second Client');
    const referred = (id: string) => count('select count(*)::int as n from public.partner_referrals where partner_id = $1', [id]);
    await asUser(a.ownerId, async (db) => { await setReferredBy(db, actor(a), c1, p1); await setReferredBy(db, actor(a), c2, p1); await setReferredBy(db, actor(a), c1, p1); });
    expect(await referred(p1)).toBe(2);
    await asUser(a.ownerId, (db) => setReferredBy(db, actor(a), c2, p2)); // one partner per client: changing replaces
    expect([await referred(p1), await referred(p2)]).toEqual([1, 1]);
    await asUser(a.ownerId, (db) => setReferredBy(db, actor(a), c2, null));
    expect(await referred(p2)).toBe(0);
    expect(await count("select count(*)::int as n from public.client_events where client_id = $1 and kind = 'referred_by'", [c2])).toBe(3);
    // A partner of another agency cannot be linked, and another agency cannot link or read these.
    await expect(asUser(a.ownerId, (db) => setReferredBy(db, actor(a), c1, foreign))).rejects.toThrow(/row-level security/);
    await expect(asUser(b.ownerId, (db) => setReferredBy(db, actor(b), c1, foreign))).rejects.toThrow(/row-level security/);
    expect(await asUser(b.ownerId, (db) => db.rows('select client_id from public.partner_referrals where partner_id = $1', [p1]))).toEqual([]);
    expect(await referred(p1)).toBe(1);
  });
});

describe('optional AI wording for partner emails', () => {
  const grant = (orgId: string, n: number) => withSystem((db) => db.run("insert into public.ai_credit_ledger (org_id, delta, reason, note) values ($1, $2, 'grant', 'test')", [orgId, n]));
  /** A model that edits the text it is shown and returns it. */
  const model = (edit: (masked: string) => string): AiProvider & { calls: number } => {
    const p = { name: 'fake', calls: 0, async complete(req: { user: string }) { p.calls++; return edit(/<source>\n([\s\S]*)\n<\/source>/.exec(req.user)![1]!); } };
    return p;
  };
  const polite = model((m) => m.replace('Thank you for your time.', 'Thank you for taking a moment to read this.'));
  const familiar = model((m) => m.replace('Thank you for your time.', 'I saw your recent listing and wanted to say hello. Thank you for your time.'));

  it('is off unless the agency turns it on, costs a credit only when AI wording is sent, and never sends fabricated familiarity', async () => {
    const a = await agency('PartnersAi', ON);
    await grant(a.orgId, 3);
    const box = outbox();
    const [off] = await add(a, [P()]) as [string];
    // Not switched on: the model is never called, whatever is connected.
    expect((await runPartnerOutreach(a.orgId, { ...box.opts, now: MON, ai: polite })).sent).toBe(1);
    expect(polite.calls).toBe(0);
    expect(await steps(off)).toMatchObject([{ ai_used: false }]);
    expect(await getBalance(a.orgId)).toBe(3);

    await withSystem((db) => db.run("update public.organizations set settings = settings || '{\"partner_outreach_ai\": true}'::jsonb where id = $1", [a.orgId]));
    // A plain rewording of a connecting sentence is sent, marked as AI, and costs one credit.
    const [good] = await add(a, [P()]) as [string];
    expect((await runPartnerOutreach(a.orgId, { ...box.opts, now: MON, ai: polite })).sent).toBe(1);
    const sent = box.mails.at(-1)!;
    expect(sent.text).toContain('Thank you for taking a moment to read this.');
    expect(sent.text).toContain('we cannot promise a result, a particular credit score or a loan approval for anyone');
    expect(sent.text).toContain(`${a.name} · ${ADDRESS}`);
    expect(sent.text).toContain(`/unsubscribe/partner/${partnerOptOutToken(good)}`);
    expect(await steps(good)).toMatchObject([{ status: 'sent', ai_used: true, body: sent.text }]);
    expect((await events(good)).at(-1)!.summary).toBe('Introduction email sent automatically (connecting sentences reworded by AI)');
    expect(await getBalance(a.orgId)).toBe(2);

    // "I saw your recent listing…" is discarded: the standard wording goes out and the credit is given back.
    const [fake] = await add(a, [P()]) as [string];
    expect((await runPartnerOutreach(a.orgId, { ...box.opts, now: MON, ai: familiar })).sent).toBe(1);
    expect(familiar.calls).toBe(1);
    const plain = box.mails.at(-1)!;
    expect(plain.text).not.toMatch(/listing|I saw/);
    expect(plain.text).toContain('Thank you for your time.');
    expect(await steps(fake)).toMatchObject([{ status: 'sent', ai_used: false }]);
    expect(await getBalance(a.orgId)).toBe(2);
    expect(await count("select count(*)::int as n from public.ai_credit_ledger where org_id = $1 and feature = 'partner_email' and reason = 'refund'", [a.orgId])).toBe(1);

    // With no credits left the model is not called and the standard wording is sent.
    await withSystem((db) => db.run("insert into public.ai_credit_ledger (org_id, delta, reason, note) values ($1, -2, 'adjust', 'test')", [a.orgId]));
    const calls = polite.calls;
    const [broke] = await add(a, [P()]) as [string];
    expect((await runPartnerOutreach(a.orgId, { ...box.opts, now: MON, ai: polite })).sent).toBe(1);
    expect(polite.calls).toBe(calls);
    expect(await steps(broke)).toMatchObject([{ status: 'sent', ai_used: false }]);
    expect(await getBalance(a.orgId)).toBe(0);
    // The last note is never sent through the model.
    await grant(a.orgId, 5);
    const before = polite.calls;
    expect((await runPartnerOutreach(a.orgId, { ...box.opts, now: day(4), ai: polite, partnerId: good })).sent).toBe(1);
    expect(polite.calls).toBe(before + 1);
    expect((await runPartnerOutreach(a.orgId, { ...box.opts, now: day(11), ai: polite, partnerId: good })).sent).toBe(1);
    expect(polite.calls).toBe(before + 1);
  });
});

// ================================================================ people who asked to be contacted: text follow-up
describe('lead follow-up by text: only with a text consent from the enquiry form', () => {
  /** A US mobile number nobody else in the (never truncated) test database has. */
  const phone = () => `+1${2 + Math.floor(Math.random() * 8)}${String(Math.floor(Math.random() * 100)).padStart(2, '0')}555${String(Math.floor(Math.random() * 10_000)).padStart(4, '0')}`;
  // Tomorrow, so it is after every enquiry made during the test: midday and the middle of the night in New York.
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  const NOON = new Date(`${tomorrow}T17:00:00Z`);
  const NIGHT = new Date(`${tomorrow}T08:00:00Z`);
  const LEADS_ON = () => ({ lead_followup_enabled: true, lead_followup_since: new Date(Date.now() - 60_000).toISOString(), lead_mailing_address: ADDRESS, lead_reply_email: REPLY });
  const TEXTS_ON = () => ({ ...LEADS_ON(), lead_text_followup: true });

  async function enquire(a: Agency, over: Record<string, unknown> = {}, meta: { shownIn?: 'en' | 'es' } = {}) {
    const email = `lead-${uniq()}@example.test`;
    // `defer` is given and never run here: the welcome is left to the runs below, as when the after-response step is lost.
    const r = await submitLead(a.slug, { fullName: 'Pat Lead', email, goal: 'home', language: 'en', consent: true, ...over }, { ip: testIp(), userAgent: 'vitest', defer: () => undefined, ...meta });
    const c = await withSystem((db) => db.row<{ id: string }>('select id from public.clients where org_id = $1 and email = $2', [a.orgId, email]));
    return { r, id: c?.id ?? '', email };
  }
  const consent = (clientId: string) => withSystem((db) => db.row<{ source: string; phone: string; language: string; consent_text: string; ip: string | null; user_agent: string | null; revoked_via: string | null; recorded_by: string | null }>(
    'select source, phone, language, consent_text, ip, user_agent, revoked_via, recorded_by from public.sms_consents where client_id = $1 order by granted_at desc limit 1', [clientId]));
  const log = (clientId: string) => withSystem((db) => db.rows<{ step: string; status: string }>('select step, status from public.lead_outreach where client_id = $1 order by created_at', [clientId]));
  const textsTo = (number: string) => smsLog.filter((m) => m.to === number);
  const age = (a: Agency, clientId: string, days: number) => withSystem(async (db) => {
    await db.run("update public.organizations set settings = settings || jsonb_build_object('lead_followup_since', (now() - interval '30 days')::text) where id = $1", [a.orgId]);
    await db.run('update public.clients set created_at = created_at - make_interval(days => $2) where id = $1', [clientId, days]);
    await db.run('update public.lead_outreach set sent_at = sent_at - make_interval(days => $2), created_at = created_at - make_interval(days => $2) where client_id = $1', [clientId, days]);
  });
  function emails() {
    const mails: Email[] = [];
    const send = async (m: Email): Promise<SendResult> => { mails.push(m); return { ok: true, provider: 'resend', providerRef: `ref-${mails.length}` }; };
    return { mails, opts: { live: true, send } };
  }

  it('text follow-up is off by default, and the form only offers the text box when a text could really follow', async () => {
    const none = await agency('LeadTextsNone');
    const emailOnly = await agency('LeadTextsEmailOnly', LEADS_ON());
    const on = await agency('LeadTextsOffered', TEXTS_ON());
    expect((await runLeadTexts(none.orgId, { now: NOON })).blocked).toBe('off');
    expect((await runLeadTexts(emailOnly.orgId, { now: NOON })).blocked).toBe('texts_off');
    expect((await runLeadTexts(on.orgId, { now: NOON })).blocked).toBeNull();
    expect([leadTextsOffered({}), leadTextsOffered(LEADS_ON()), leadTextsOffered(TEXTS_ON())]).toEqual([false, false, true]);
    // With no text service connected nothing is offered and nothing is sent.
    process.env.SMS_DRIVER = 'disabled'; resetEnvCache();
    try {
      expect(leadTextsOffered(TEXTS_ON())).toBe(false);
      expect((await runLeadTexts(on.orgId, { now: NOON })).blocked).toBe('sms_not_connected');
    } finally { process.env.SMS_DRIVER = 'log'; resetEnvCache(); }

    // A ticked box where texts are not offered (it was never shown) records no consent and sends no text.
    const number = phone();
    const l = await enquire(emailOnly, { phone: number, smsConsent: true });
    expect(l.r).toEqual({ ok: true });
    expect(await consent(l.id)).toBeNull();
    await withSystem((db) => db.run("update public.organizations set settings = settings || '{\"lead_text_followup\": true}'::jsonb where id = $1", [emailOnly.orgId]));
    expect(await runLeadTexts(emailOnly.orgId, { now: NOON })).toEqual({ sent: 0, failed: 0, waiting: 0, blocked: null });
    expect(textsTo(number)).toEqual([]);
  });

  it('no consent, email only; the ticked box, a text too: stored with the exact wording, the number and where it came from', async () => {
    const a = await agency('LeadTexts', TEXTS_ON());
    const [nA, nB, nD] = [phone(), phone(), phone()];
    const agreed = await enquire(a, { phone: nA, smsConsent: true });
    const emailOnly = await enquire(a, { phone: nB }); // gave a number, did not tick the text box
    const typed = await addClient(a.orgId, 'Typed In', { status: 'lead' }); // added by staff, with a consent staff recorded
    await withSystem((db) => db.run('update public.clients set phone = $2 where id = $1', [typed, nD]));
    await asUser(a.ownerId, (db) => grantSmsConsent(db, { orgId: a.orgId, clientId: typed, userId: a.ownerId, source: 'staff', note: 'Agreed on a call with me on Monday morning.' }));

    // The consent ledger holds what the person was shown, for which number, from which address. Nobody "recorded" it.
    expect(await consent(agreed.id)).toEqual({ source: 'enquiry_form', phone: nA, language: 'en', consent_text: leadSmsConsentText('en', a.name), ip: expect.stringMatching(/^10\./), user_agent: 'vitest', revoked_via: null, recorded_by: null });
    expect(await consent(emailOnly.id)).toBeNull();
    const timeline = await withSystem((db) => db.rows<{ summary: string }>("select summary from public.client_events where client_id = $1 and kind = 'sms_consent'", [agreed.id]));
    expect(timeline.map((t) => t.summary)).toEqual(['Agreed to text messages on the enquiry form']);

    // One text, to the one lead who ticked the box. A staff-recorded consent is for file updates and unlocks nothing here.
    expect(await runLeadTexts(a.orgId, { now: NOON })).toEqual({ sent: 1, failed: 0, waiting: 0, blocked: null });
    expect(await runLeadTexts(a.orgId, { now: NOON })).toEqual({ sent: 0, failed: 0, waiting: 0, blocked: null });
    expect(textsTo(nA).map((m) => m.body)).toEqual([leadText('text_welcome', 'en', { orgName: a.name })]);
    expect(textsTo(nB)).toEqual([]);
    expect(textsTo(nD)).toEqual([]);
    expect(await log(agreed.id)).toEqual([{ step: 'text_welcome', status: 'sent' }]);
    expect(await log(emailOnly.id)).toEqual([]);
    expect(await log(typed)).toEqual([]);
    // Recorded as a message on the lead (the log driver delivers nothing, so it reads "not delivered").
    expect(await withSystem((db) => db.rows('select direction, channel, status, body from public.communications where client_id = $1', [agreed.id]))).toEqual([{ direction: 'outbound', channel: 'sms', status: 'queued', body: textsTo(nA)[0]!.body }]);

    // The emails are untouched by the text: both leads who sent the form still get the welcome email, with no approval step.
    const box = emails();
    expect((await runLeadOutreach(a.orgId, box.opts)).sent).toBe(2);
    expect(box.mails.map((m) => m.to).sort()).toEqual([agreed.email, emailOnly.email].sort());
    expect((await log(agreed.id)).map((s) => s.step).sort()).toEqual(['text_welcome', 'welcome']);
    expect(await log(emailOnly.id)).toEqual([{ step: 'welcome', status: 'sent' }]);

    // Three days later the follow-up text; after that never another.
    await age(a, agreed.id, 3);
    expect((await runLeadTexts(a.orgId, { now: NOON })).sent).toBe(1);
    expect(textsTo(nA).map((m) => m.body)).toEqual([leadText('text_welcome', 'en', { orgName: a.name }), leadText('text_followup', 'en', { orgName: a.name })]);
    await age(a, agreed.id, 5);
    expect((await runLeadTexts(a.orgId, { now: NOON })).sent).toBe(0);
    expect(textsTo(nA)).toHaveLength(2);
    expect(textsTo(nB)).toEqual([]);
  });

  it('the box needs a mobile number, and the consent is worded in the language the form was shown in', async () => {
    const a = await agency('LeadTextsForm', TEXTS_ON());
    const missing = await enquire(a, { smsConsent: true });
    expect(missing.r).toEqual({ ok: false, error: LEAD_SMS_NEEDS_PHONE.en });
    expect(missing.id).toBe(''); // nothing was created
    expect((await enquire(a, { phone: '555-0134', smsConsent: true }, { shownIn: 'es' })).r).toEqual({ ok: false, error: LEAD_SMS_NEEDS_PHONE.es });
    const number = phone();
    const es = await enquire(a, { phone: `(${number.slice(2, 5)}) ${number.slice(5, 8)}-${number.slice(8)}`, smsConsent: true, language: 'es' }, { shownIn: 'es' });
    expect(es.r).toEqual({ ok: true });
    expect(await consent(es.id)).toMatchObject({ source: 'enquiry_form', phone: number, language: 'es', consent_text: leadSmsConsentText('es', a.name) });
    expect((await runLeadTexts(a.orgId, { now: NOON })).sent).toBe(1);
    expect(textsTo(number)[0]!.body).toBe(leadText('text_welcome', 'es', { orgName: a.name }));
    // An enquiry form consent cannot be written through a tenant request: not by staff, not by a portal client.
    const typed = await addClient(a.orgId, 'Typed In', { status: 'lead' });
    await expect(asUser(a.ownerId, (db) => db.run("insert into public.sms_consents (org_id, client_id, phone, consent_text, source, recorded_by) values ($1, $2, $3, repeat('y', 30), 'enquiry_form', $4)", [a.orgId, typed, phone(), a.ownerId]))).rejects.toThrow(/row-level security/);
  });

  it('quiet hours hold a text until morning, and a text that failed is recorded and not sent again', async () => {
    const a = await agency('LeadTextsQuiet', TEXTS_ON());
    const number = phone();
    const l = await enquire(a, { phone: number, smsConsent: true });
    expect(await runLeadTexts(a.orgId, { now: NIGHT })).toEqual({ sent: 0, failed: 0, waiting: 1, blocked: null });
    expect(textsTo(number)).toEqual([]);
    expect(await log(l.id)).toEqual([]);
    const refuse = async (_: Sms): Promise<SmsResult> => ({ ok: false, provider: 'twilio', error: 'Attempt to send to unsubscribed recipient (Twilio error 21610)' });
    expect(await runLeadTexts(a.orgId, { now: NOON, send: refuse })).toEqual({ sent: 0, failed: 1, waiting: 0, blocked: null });
    expect(await log(l.id)).toEqual([{ step: 'text_welcome', status: 'failed' }]);
    expect(await withSystem((db) => db.rows('select channel, status from public.communications where client_id = $1', [l.id]))).toEqual([{ channel: 'sms', status: 'failed' }]);
    await age(a, l.id, 3);
    expect(await runLeadTexts(a.orgId, { now: NOON })).toEqual({ sent: 0, failed: 0, waiting: 0, blocked: null });
    expect(textsTo(number)).toEqual([]);
    // A failed text is not "the team being in touch": the automatic email still goes out.
    const box = emails();
    expect((await runLeadOutreach(a.orgId, { ...box.opts, clientId: l.id })).sent).toBe(1);
  });

  it('STOP ends the texts for good; a changed number, a reply, an opt-out or becoming a client stop them too', async () => {
    const a = await agency('LeadTextsStop', TEXTS_ON());
    const [nStop, nChanged, nOptOut, nClient] = [phone(), phone(), phone(), phone()];
    const stop = await enquire(a, { phone: nStop, smsConsent: true });
    const changed = await enquire(a, { phone: nChanged, smsConsent: true });
    const optOut = await enquire(a, { phone: nOptOut, smsConsent: true });
    const client = await enquire(a, { phone: nClient, smsConsent: true });
    expect((await runLeadTexts(a.orgId, { now: NOON })).sent).toBe(4);

    expect((await recordInboundSms({ sid: `SM${uniq()}${uniq()}`, from: nStop, body: 'STOP' })).kind).toBe('stop');
    expect(await consent(stop.id)).toMatchObject({ revoked_via: 'sms_stop' });
    await withSystem(async (db) => {
      await db.run('update public.clients set phone = $2 where id = $1', [changed.id, phone()]);
      await db.run('update public.clients set outreach_opt_out_at = now() where id = $1', [optOut.id]);
      await db.run("update public.clients set status = 'onboarding' where id = $1", [client.id]);
    });
    for (const l of [stop, changed, optOut, client]) await age(a, l.id, 3);
    expect(await runLeadTexts(a.orgId, { now: NOON })).toEqual({ sent: 0, failed: 0, waiting: 0, blocked: null });
    for (const n of [nStop, nChanged, nOptOut, nClient]) expect(textsTo(n)).toHaveLength(1);

    // The public form cannot switch texts back on for a number that replied STOP: the lead is saved, without a consent.
    const again = await enquire(a, { phone: nStop, smsConsent: true });
    expect(again.r).toEqual({ ok: true });
    expect(await consent(again.id)).toBeNull();
    expect((await withSystem((db) => db.rows<{ summary: string }>("select summary from public.client_events where client_id = $1 and kind = 'sms_consent'", [again.id]))).map((e) => e.summary))
      .toEqual(['Ticked the text message box on the enquiry form, but this number has replied STOP before. No consent was recorded and no text is sent.']);
    expect(await runLeadTexts(a.orgId, { now: NOON })).toEqual({ sent: 0, failed: 0, waiting: 0, blocked: null });
    expect(textsTo(nStop)).toHaveLength(1);
    // The table refuses it too, whatever the application does.
    await expect(withSystem((db) => db.run("insert into public.sms_consents (org_id, client_id, phone, consent_text, source) values ($1, $2, $3, repeat('y', 30), 'enquiry_form')", [a.orgId, again.id, nStop]))).rejects.toThrow(/replied STOP/);
  });

  it('sending the form again with the same number cannot text that number again', async () => {
    const a = await agency('LeadTextsRepeat', TEXTS_ON());
    const number = phone();
    const first = await enquire(a, { phone: number, smsConsent: true });
    const second = await enquire(a, { phone: number, smsConsent: true, fullName: 'Someone Else' });
    const third = await enquire(a, { phone: `(${number.slice(2, 5)}) ${number.slice(5, 8)}-${number.slice(8)}`, smsConsent: true });
    expect([second.r, third.r]).toEqual([{ ok: true }, { ok: true }]); // the enquiries themselves are saved
    expect(await consent(first.id)).toMatchObject({ source: 'enquiry_form', phone: number });
    expect(await consent(second.id)).toBeNull();
    expect(await consent(third.id)).toBeNull();
    expect(await runLeadTexts(a.orgId, { now: NOON })).toEqual({ sent: 1, failed: 0, waiting: 0, blocked: null });
    expect(textsTo(number)).toHaveLength(1);
    for (const l of [first, second, third]) await age(a, l.id, 3);
    expect((await runLeadTexts(a.orgId, { now: NOON })).sent).toBe(1); // the one follow-up for the one consent
    expect(textsTo(number)).toHaveLength(2);
    expect((await withSystem((db) => db.rows<{ summary: string }>("select summary from public.client_events where client_id = $1 and kind = 'sms_consent'", [second.id]))).map((e) => e.summary))
      .toEqual(['Ticked the text message box on the enquiry form, but another enquiry already has a text consent for this number. No second consent was recorded and no text is sent for this one.']);
  });

  it('two runs at the same moment send one text, and another agency is unaffected', async () => {
    const a = await agency('LeadTextsA', TEXTS_ON());
    const b = await agency('LeadTextsB', LEADS_ON());
    const [nA, nB] = [phone(), phone()];
    const la = await enquire(a, { phone: nA, smsConsent: true });
    const lb = await enquire(b, { phone: nB, smsConsent: true });
    const runs = await Promise.all([runLeadTexts(a.orgId, { now: NOON }), runLeadTexts(a.orgId, { now: NOON }), runLeadTexts(a.orgId, { now: NOON })]);
    expect(sum(runs)).toBe(1);
    expect(textsTo(nA)).toHaveLength(1);
    expect(await log(la.id)).toEqual([{ step: 'text_welcome', status: 'sent' }]);
    expect((await runLeadTexts(b.orgId, { now: NOON })).blocked).toBe('texts_off');
    expect(textsTo(nB)).toEqual([]);
    expect(await consent(lb.id)).toBeNull();
    expect(await log(lb.id)).toEqual([]);
  });
});

// ================================================================ end to end through the scheduled job
describe('the scheduled job sends everything with no approval step', () => {
  afterEach(() => { vi.unstubAllGlobals(); process.env.EMAIL_DRIVER = 'log'; process.env.SMS_DRIVER = 'log'; delete process.env.RESEND_API_KEY; delete process.env.TWILIO_ACCOUNT_SID; delete process.env.TWILIO_AUTH_TOKEN; delete process.env.TWILIO_FROM_NUMBER; resetEnvCache(); });

  it('with email and texts connected: the lead email, the consented lead text and the partner email all go out once', async () => {
    // The real drivers, with the providers' HTTP APIs stood in for.
    Object.assign(process.env, { EMAIL_DRIVER: 'resend', RESEND_API_KEY: 're_test_key_for_vitest', SMS_DRIVER: 'twilio', TWILIO_ACCOUNT_SID: 'ACtest', TWILIO_AUTH_TOKEN: 'token', TWILIO_FROM_NUMBER: '+15005550006' });
    resetEnvCache();
    const calls: { url: string; body: string }[] = [];
    vi.stubGlobal('fetch', async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), body: String(init?.body ?? '') });
      if (String(url) === 'https://api.resend.com/emails') return new Response(JSON.stringify({ id: `re_${calls.length}` }), { status: 200 });
      if (String(url).startsWith('https://api.twilio.com/')) return new Response(JSON.stringify({ sid: `SM${uniq()}${calls.length}` }), { status: 201 });
      throw new Error(`unexpected request to ${String(url)}`);
    });
    // The next business day at midday in New York: after the enquiry below, inside texting hours, and a day partners are emailed.
    let next = addDays(new Date().toISOString().slice(0, 10), 1);
    while (!isBusinessDay(next)) next = addDays(next, 1);
    const when = new Date(`${next}T17:00:00Z`);

    const a = await agency('JobsAllOn', { ...ON, lead_followup_enabled: true, lead_followup_since: new Date(Date.now() - 60_000).toISOString(), lead_text_followup: true });
    const [pid] = await add(a, [P({ phone: '(512) 555-0199' })]) as [string];
    const number = `+1512555${String(Math.floor(Math.random() * 10_000)).padStart(4, '0')}`;
    const email = `lead-${uniq()}@example.test`;
    expect(await submitLead(a.slug, { fullName: 'Pat Lead', email, phone: number, language: 'en', consent: true, smsConsent: true }, { ip: testIp(), defer: () => undefined })).toEqual({ ok: true });

    const first = await runScheduledJobs({ onlyOrgIds: [a.orgId], now: when });
    expect(first).toMatchObject({ failures: 0, leadEmails: 1, leadTexts: 1, partnerEmails: 1 });
    const mails = calls.filter((c) => c.url.includes('resend')).map((c) => JSON.parse(c.body) as { to: string[]; subject: string; from: string; reply_to: string; text: string });
    const texts = calls.filter((c) => c.url.includes('twilio')).map((c) => new URLSearchParams(c.body));
    expect(mails.map((m) => m.to[0]).sort()).toEqual([email, (await partner(pid))!.email].sort());
    for (const m of mails) { expect(m.reply_to).toBe(REPLY); expect(m.from).toContain(`"${a.name}"`); expect(m.text).toContain(`${a.name} · ${ADDRESS}`); expect(m.text).toMatch(/\/unsubscribe\//); }
    expect(texts).toHaveLength(1);
    expect(texts[0]!.get('To')).toBe(number);
    expect(texts[0]!.get('Body')).toBe(leadText('text_welcome', 'en', { orgName: a.name }));
    // The only number ever texted is the lead's who agreed; the partner's phone number went nowhere.
    expect(calls.some((c) => c.body.includes('5550199'))).toBe(false);
    expect(await steps(pid)).toMatchObject([{ step: 'intro', status: 'sent' }]);

    // Running again, as a scheduler does, sends nothing twice.
    const second = await runScheduledJobs({ onlyOrgIds: [a.orgId], now: when });
    expect(second).toMatchObject({ failures: 0, leadEmails: 0, leadTexts: 0, partnerEmails: 0 });
    expect(calls).toHaveLength(3);
  });
});
