import { execFileSync } from 'node:child_process';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { getBalance } from '@/lib/ai/credits';
import { runScheduledJobs } from '@/lib/automation/jobs';
import { addDays, isBusinessDay } from '@/lib/business-days';
import { grantSmsConsent, queueClientUpdate, recordInboundSms, recordSmsStatus, revokeSmsConsent } from '@/lib/client-updates/service';
import { resetEnvCache } from '@/lib/env';
import { leadTextsOffered, leadTextsOfferedBySlug, runLeadOutreach, runLeadTexts } from '@/lib/lead-outreach';
import { LEAD_SMS_NEEDS_PHONE, LEAD_TEXT_DAILY_CAP, leadSmsConsentText, leadText } from '@/lib/lead-texts';
import { submitLead } from '@/lib/leads';
import { sentLog, type Email, type SendResult } from '@/lib/mailer';
import { PARTNER_CATEGORIES, PARTNER_DAILY_CAP, PARTNER_PER_RUN_CAP, partnerEmail } from '@/lib/partner-emails';
import { parsePartnerList, type PartnerInput } from '@/lib/partner-import';
import { NEW_WORKSPACE_DAILY_EMAILS } from '@/lib/outreach-approval';
import {
  addPartners, optOutPartner, PARTNER_BOUNCE_MIN, PARTNER_GUARD_REFUSAL, partnerBounceHealth, partnerFailureHold, partnerOneClickUrl, partnerOptOutInfo, partnerOptOutToken, recordPartnerDeliveryEvent,
  runPartnerOutreach, type PartnerRunOptions,
} from '@/lib/partner-outreach';
import { markPartner, partnerAskedToStop, pausePartner, removePartner, resumePartner, retryPartnerStep, setReferredBy, updatePartner } from '@/lib/partners';
import { smsLog, toUsE164, type Sms, type SmsResult } from '@/lib/sms';
import { usAreaCodeState } from '@/lib/us-phone';
import { addClient, addMember, addPortalClient, approveOutreach, asUser, closePool, makeOrg, testIp, uniq, withSystem, type TestOrg } from './helpers';

const saved = { ...process.env };
// The development stand-in for texts: written to a log, nothing leaves the machine. Partners must never appear in it.
beforeAll(() => { process.env.SMS_DRIVER = 'log'; resetEnvCache(); });
afterAll(async () => { process.env = { ...saved }; resetEnvCache(); await closePool(); });

const ADDRESS = '12 Main St, Austin, TX 78701';
const REPLY = 'hello@agency.example.test';
type Agency = TestOrg & { slug: string; name: string };

/** When the workspaces below were approved for outreach: long before any date a test runs at, so the first-two-weeks rate does not apply. */
const APPROVED = new Date('2025-06-02T15:00:00Z');
/**
 * A workspace, approved for outreach by the operator as `npm run outreach:approve` does it (pass `approved: false` for
 * one that nobody has looked at yet, which is what sign-up gives).
 */
async function agency(label: string, settings: Record<string, unknown> | null = null, approved = true): Promise<Agency> {
  const o = await makeOrg(label);
  const r = (await withSystem((db) => db.row<{ slug: string; name: string }>('update public.organizations set settings = settings || $2::jsonb where id = $1 returning slug, name', [o.orgId, JSON.stringify(settings ?? {})])))!;
  if (approved) await approveOutreach(o.orgId, APPROVED);
  return { ...o, ...r };
}
const approval = (orgId: string) => withSystem((db) => db.row<{ at: Date | null; name: string | null }>('select outreach_approved_at as at, outreach_approved_name as name from public.organizations where id = $1', [orgId]));
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
const steps = (id: string) => withSystem((db) => db.rows<{ step: string; status: string; attempts: number; subject: string | null; body: string | null; error: string | null }>(
  'select step, status, attempts, subject, body, error from public.partner_outreach where partner_id = $1 order by created_at', [id]));
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
    // Saved text that is not shaped like a postal address counts as none. The forms refuse it; this is a value saved
    // before they did, or written some other way. Nothing prints it in an email.
    for (const junk of ['x', 'URGENT: your escrow account is on hold. Sign in at https://secure-escrow-verify.example/login today or the closing is cancelled. P.S. As we discussed at the expo, most local agents already use us.']) {
      await withSystem((db) => db.run('update public.organizations set settings = settings || $2::jsonb where id = $1', [a.orgId, JSON.stringify({ lead_mailing_address: junk })]));
      expect(await runPartnerOutreach(a.orgId, { ...box.opts, now: MON }), junk).toEqual({ sent: 0, failed: 0, blocked: 'no_address', held: null });
    }
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
    // Renamed after it was approved: the approval was for the old name.
    expect((await runPartnerOutreach(a.orgId, { ...box.opts, now: MON })).blocked).toBe('not_approved');
    // Even approved under the new name, a name that makes a promise sends nothing.
    await approveOutreach(a.orgId, APPROVED);
    expect((await runPartnerOutreach(a.orgId, { ...box.opts, now: MON })).blocked).toBe('name_claim');
    // And so does a name that carries a web address, or is long enough to be a message of its own.
    for (const name of ['URGENT - your escrow account is on hold, sign in at secure-escrow-verify.example', `${'Very Long Credit Company Name '.repeat(3)}LLC`]) {
      await withSystem((db) => db.run('update public.organizations set name = $2, outreach_approved_name = $2 where id = $1', [a.orgId, name]));
      expect((await runPartnerOutreach(a.orgId, { ...box.opts, now: MON })).blocked, name).toBe('name_claim');
    }
    expect(box.mails).toEqual([]);
  });

  it('a website address that reads as a claim blocks the sequence before anything is claimed, instead of failing partner after partner', async () => {
    // The address of a site on the platform keeps the name the workspace signed up with, whatever it is called now.
    const a = await agency('Free Credit Help', ON);
    expect(a.slug).toMatch(/^free-credit-help-/);
    await withSystem((db) => db.run('update public.organizations set name = $2, settings = settings || $3::jsonb where id = $1',
      [a.orgId, `Hill Credit ${uniq()}`, JSON.stringify({ website: { published: true, headline: 'Credit report help' } })]));
    await approveOutreach(a.orgId, APPROVED); // approved under the name it has now, which says nothing
    const ids = await add(a, [P(), P(), P()]);
    const box = outbox();
    const told = () => count("select count(*)::int as n from public.notifications where org_id = $1 and title = 'Partner emails are not going out'", [a.orgId]);
    for (const now of [MON, day(1)]) expect(await runPartnerOutreach(a.orgId, { ...box.opts, now })).toEqual({ sent: 0, failed: 0, blocked: 'site_claim', held: null });
    expect(box.mails).toEqual([]);
    // Nobody was moved to "failed", nothing holds and nobody was told the email service refused anything.
    for (const id of ids) { expect(await steps(id)).toEqual([]); expect(await partner(id)).toMatchObject({ status: 'new' }); }
    expect(await withSystem((db) => partnerFailureHold(db, a.orgId, MON))).toBeNull();
    expect(await told()).toBe(0);
    // With the site unpublished the emails carry no link, and go out.
    await withSystem((db) => db.run("update public.organizations set settings = jsonb_set(settings, '{website,published}', 'false'::jsonb) where id = $1", [a.orgId]));
    expect(await runPartnerOutreach(a.orgId, { ...box.opts, now: MON })).toEqual({ sent: 3, failed: 0, blocked: null, held: null });
    expect(box.mails.some((m) => m.text.includes('/a/'))).toBe(false);
    // A site whose address says nothing is linked from the introduction.
    const b = await agency('Hill Path', { ...ON, website: { published: true, headline: 'Credit report help' } });
    await add(b, [P()]);
    expect(await runPartnerOutreach(b.orgId, { ...box.opts, now: MON })).toEqual({ sent: 1, failed: 0, blocked: null, held: null });
    expect(box.mails.at(-1)!.text).toContain(`You can read about us here: http://localhost:3000/a/${b.slug}`);
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
    // It leaves on the outreach stream, with the headers a mail program's own "unsubscribe" button acts on.
    expect(intro.stream).toBe('outreach');
    expect(intro.headers).toEqual({ 'List-Unsubscribe': `<http://localhost:3000/api/unsubscribe/partner/${partnerOptOutToken(en)}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' });
    expect(partnerOneClickUrl(en)).toBe(`http://localhost:3000/api/unsubscribe/partner/${partnerOptOutToken(en)}`);
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
    expect(await steps(en)).toEqual([{ step: 'intro', status: 'sent', attempts: 1, subject: intro.subject, body: intro.text, error: null }]);
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
    for (const status of ['finished', 'bounced', 'new']) {
      await expect(asUser(a.ownerId, (db) => db.run('update public.partners set status = $2 where id = $1', [id, status])), status).rejects.toThrow(/opt-out cannot be undone/);
    }
    // The stamp is what stops the emails, and it cannot exist without having been set: a row cannot be "opted out" with no date.
    await expect(withSystem((db) => db.run("insert into public.partners (org_id, business_name, category, email, attested_by, status) values ($1, 'X Co', 'other', $2, $3, 'opted_out')", [a.orgId, `x-${uniq()}@biz.example.test`, a.ownerId]))).rejects.toThrow(/partners_opt_out_check/);
    expect(await asUser(a.ownerId, (db) => markPartner(db, actor(a), id, 'bounced'))).toBe(false);
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

  it('no answer from the email service: the email may have gone out, so the step is never sent again, cannot be retried and is not a refusal', async () => {
    const a = await agency('PartnersNoAnswer', ON);
    const ids = await add(a, [P(), P(), P()]);
    const handed: Email[] = [];
    // The service accepts and delivers every request; its first answer is lost on the way back. `unconfirmed` is what the
    // real driver reports for a timeout or a dropped connection (tests/unit/mailer-unconfirmed.test.ts).
    const send = async (m: Email): Promise<SendResult> => {
      handed.push(m);
      return handed.length === 1 ? { ok: false, provider: 'resend', error: 'The operation was aborted due to timeout', unconfirmed: true } : { ok: true, provider: 'resend', providerRef: `ref-${handed.length}` };
    };
    const told = () => count("select count(*)::int as n from public.notifications where org_id = $1 and title = 'Partner emails are not going out'", [a.orgId]);
    // Nothing more is handed to a service that is not answering: the run ends there.
    expect(await runPartnerOutreach(a.orgId, { live: true, send, now: MON })).toEqual({ sent: 0, failed: 0, blocked: null, held: 'no_answer' });
    expect(handed).toHaveLength(1);
    const all = await Promise.all(ids.map(async (id) => ({ id, steps: await steps(id), email: (await partner(id))!.email })));
    const stuck = all.find((x) => x.steps.length)!;
    expect(stuck.email).toBe(handed[0]!.to);
    // It is not 'failed'. The email as it was handed over and the reason are kept with the step.
    expect(stuck.steps).toEqual([{ step: 'intro', status: 'sending', attempts: 1, subject: handed[0]!.subject, body: handed[0]!.text, error: 'The operation was aborted due to timeout' }]);
    expect((await events(stuck.id)).at(-1)).toEqual({ kind: 'email_unconfirmed', summary: 'Introduction email: the email service did not answer (The operation was aborted due to timeout), so it may or may not have arrived. It is not sent again. The sequence stopped for this partner.' });
    expect(await partner(stuck.id)).toMatchObject({ status: 'new' });
    // Nobody can ask for another try of it: "Try again" is for an email the service refused.
    expect(await asUser(a.ownerId, (db) => retryPartnerStep(db, actor(a), stuck.id))).toBe(false);
    await expect(asUser(a.ownerId, (db) => db.run("update public.partner_outreach set status = 'retry' where partner_id = $1", [stuck.id]))).resolves.toBe(0);
    // It is not a refusal either: nothing holds, and nobody is told the email service refused anything.
    expect(await withSystem((db) => partnerFailureHold(db, a.orgId, MON))).toBeNull();
    expect(await told()).toBe(0);
    // The next run carries on with the others. That step, and everything after it, is never sent to that partner.
    expect(await runPartnerOutreach(a.orgId, { live: true, send, now: new Date(MON.getTime() + 3_600_000) })).toEqual({ sent: 2, failed: 0, blocked: null, held: null });
    for (const n of [4, 11, 30]) await runPartnerOutreach(a.orgId, { live: true, send, now: day(n) });
    expect(handed.filter((m) => m.to === stuck.email)).toHaveLength(1); // one copy, ever
    expect(handed).toHaveLength(1 + 2 * 3);
    expect(await steps(stuck.id)).toMatchObject([{ step: 'intro', status: 'sending', attempts: 1 }]);

    // A refusal and then an unanswered send are not "two refusals in a row".
    const b = await agency('PartnersNoAnswerMixed', ON);
    const [refused, unanswered] = await add(b, [P(), P()]) as [string, string];
    expect(await runPartnerOutreach(b.orgId, { ...outbox({ ok: false, error: 'domain not verified' }).opts, now: MON, partnerId: refused })).toMatchObject({ failed: 1, held: null });
    expect(await runPartnerOutreach(b.orgId, { ...outbox({ ok: false, error: 'read ECONNRESET', unconfirmed: true }).opts, now: MON, partnerId: unanswered })).toEqual({ sent: 0, failed: 0, blocked: null, held: 'no_answer' });
    expect(await steps(unanswered)).toMatchObject([{ status: 'sending', error: 'read ECONNRESET' }]);
    expect(await withSystem((db) => partnerFailureHold(db, b.orgId, MON))).toBeNull();

    // The real driver, with only the request to the email service stood in for: it times out.
    const c = await agency('PartnersRealTimeout', ON);
    const [viaDriver] = await add(c, [P()]) as [string];
    Object.assign(process.env, { EMAIL_DRIVER: 'resend', RESEND_API_KEY: 're_test_key_for_vitest' });
    resetEnvCache();
    vi.stubGlobal('fetch', async () => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); });
    try {
      expect(await runPartnerOutreach(c.orgId, { now: MON })).toEqual({ sent: 0, failed: 0, blocked: null, held: 'no_answer' });
      expect(await steps(viaDriver)).toMatchObject([{ step: 'intro', status: 'sending', attempts: 1, error: 'The operation was aborted due to timeout' }]);
    } finally {
      vi.unstubAllGlobals();
      process.env.EMAIL_DRIVER = saved.EMAIL_DRIVER;
      delete process.env.RESEND_API_KEY;
      resetEnvCache();
    }
    for (const n of [0, 4, 11]) expect((await runPartnerOutreach(c.orgId, { ...outbox().opts, now: day(n) })).sent).toBe(0);
  });

  it('an email this app’s own guard refuses stops that partner only: it is not a refusal by the email service, and nothing holds', async () => {
    const a = await agency('PartnersGuard', ON);
    // Rows as they could be on file from before a city was checked when a partner is added ("Free Soil" is now refused there).
    const soil = await add(a, [P({ city: 'Free Soil', state: 'MI' }), P({ city: 'Free Soil', state: 'MI' })]);
    await add(a, [P(), P()]);
    const box = outbox();
    const told = () => count("select count(*)::int as n from public.notifications where org_id = $1 and title = 'Partner emails are not going out'", [a.orgId]);
    // Two are refused, in a row, and the run carries on to the partners after them.
    expect(await runPartnerOutreach(a.orgId, { ...box.opts, now: MON })).toEqual({ sent: 2, failed: 2, blocked: null, held: null });
    expect(box.mails).toHaveLength(2); // the two refused emails were never handed to the email service
    for (const id of soil) {
      expect(await steps(id)).toMatchObject([{ step: 'intro', status: 'failed', attempts: 1, error: `${PARTNER_GUARD_REFUSAL} (Only a first consultation may be called free. Do not call credit repair, reports, scores or results free.)` }]);
      expect((await events(id)).at(-1)).toEqual({ kind: 'email_failed', summary: 'Introduction email was not sent: the message would contain a claim that is not allowed (Only a first consultation may be called free. Do not call credit repair, reports, scores or results free.). The sequence stopped for this partner.' });
    }
    // The sequence does not hold, and the owners are not told that the email service refused anything.
    expect(await withSystem((db) => partnerFailureHold(db, a.orgId, MON))).toBeNull();
    expect(await told()).toBe(0);
    await add(a, [P()]);
    expect(await runPartnerOutreach(a.orgId, { ...box.opts, now: new Date(MON.getTime() + 3_600_000) })).toEqual({ sent: 1, failed: 0, blocked: null, held: null });
    // With the city taken off the record and another try asked for, the email goes out without a place.
    expect(await asUser(a.ownerId, (db) => updatePartner(db, actor(a), soil[0]!, { ...P(), city: null, state: 'MI' }))).toBe(true);
    expect(await asUser(a.ownerId, (db) => retryPartnerStep(db, actor(a), soil[0]!))).toBe(true);
    expect((await runPartnerOutreach(a.orgId, { ...box.opts, now: day(1), partnerId: soil[0]! })).sent).toBe(1);
    expect(box.mails.at(-1)!.text).toContain('I am contacting you because you work as a real estate agent.');
    expect(await steps(soil[0]!)).toMatchObject([{ step: 'intro', status: 'sent', attempts: 2, error: null }]);

    // What the email service refuses still counts, and a guard refusal between two of those neither adds to them nor
    // breaks the run of them. (Added one at a time, so the order they are tried in is the order they were added in.)
    const b = await agency('PartnersGuardMixed', ON);
    const [first] = await add(b, [P()]) as [string];
    const [between] = await add(b, [P({ city: 'Free Soil', state: 'MI' })]) as [string];
    const [second] = await add(b, [P()]) as [string];
    const [untried] = await add(b, [P()]) as [string];
    const bad = outbox({ ok: false, error: 'domain not verified' });
    expect(await runPartnerOutreach(b.orgId, { ...bad.opts, now: MON })).toEqual({ sent: 0, failed: 3, blocked: null, held: 'failures' });
    expect(bad.mails).toHaveLength(2);
    expect(await steps(between)).toMatchObject([{ status: 'failed', error: expect.stringContaining(PARTNER_GUARD_REFUSAL) }]);
    for (const id of [first, second]) expect(await steps(id)).toMatchObject([{ status: 'failed', error: 'domain not verified' }]);
    expect(await steps(untried)).toEqual([]);
    // The hold and the notification give the reason the email service gave, not the guard's.
    expect(await withSystem((db) => partnerFailureHold(db, b.orgId, MON))).toBe('domain not verified');
    expect(await withSystem((db) => db.rows<{ body: string }>("select body from public.notifications where org_id = $1 and title = 'Partner emails are not going out'", [b.orgId])))
      .toEqual([{ body: 'The email service refused 2 partner emails in a row (domain not verified). Nothing more is tried for 24 hours, or until you press “Try again” on one of those partners.' }]);
  });

  it('the claim is on record before the email is handed over, and no transaction is open during the send', async () => {
    const a = await agency('PartnersClaimFirst', ON);
    const [id] = await add(a, [P()]) as [string];
    let seen: { step: string; status: string }[] = [];
    const send = async (): Promise<SendResult> => {
      seen = (await steps(id)).map(({ step, status }) => ({ step, status })); // a separate connection can already see the committed claim
      // …and can change the partner: neither the row nor the claim lock is held while the email service is called.
      await withSystem(async (db) => {
        await db.run("set local lock_timeout = '2s'");
        await db.run('update public.partners set source_note = $2 where id = $1', [id, 'edited during the send']);
        await db.run('select pg_advisory_xact_lock(hashtextextended($1, 28))', ['partner-outreach']);
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
    // An opt-out is recorded on agency A's partner. Agency B's record is not touched by it...
    await optOutPartner(partnerOptOutToken(pa));
    expect(await partner(pb)).toMatchObject({ status: 'new', opted_out: false });
    // ...but B cannot email that address either (see "one opt-out list for the whole service" below).
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

  it('one mailbox is one partner: another spelling of an address already listed is skipped, so nobody gets the sequence twice', async () => {
    const a = await agency('PartnersMailbox', ON);
    const u = uniq();
    // Five spellings of one Gmail mailbox in one list: one partner, four counted as already on the list.
    const spellings = [`sam${u}@gmail.com`, `sam${u}+1@gmail.com`, `sam${u}+2@gmail.com`, `sa.m${u}@gmail.com`, `sam${u}@googlemail.com`];
    expect(await asUser(a.ownerId, (db) => addPartners(db, actor(a), spellings.map((email) => P({ email })), 'Imported'))).toMatchObject({ added: 1, existing: 4 });
    // Later, one at a time; and a "+tag" on any domain. Dots only mean nothing at Gmail.
    expect(await asUser(a.ownerId, (db) => addPartners(db, actor(a), [P({ email: `sam${u}+later@gmail.com` })], 'Added by hand.'))).toEqual({ added: 0, existing: 1, ids: [] });
    expect(await asUser(a.ownerId, (db) => addPartners(db, actor(a), [P({ email: `dana@hill-${u}.example` }), P({ email: `dana+spring@hill-${u}.example` }), P({ email: `d.ana@hill-${u}.example` })], 'Imported')))
      .toMatchObject({ added: 2, existing: 1 });
    expect(await count('select count(*)::int as n from public.partners where org_id = $1', [a.orgId])).toBe(3);
    // The key is in the database, whatever inserts the row.
    await expect(withSystem((db) => db.run("insert into public.partners (org_id, business_name, category, email, attested_by) values ($1, 'X Co', 'other', $2, $3)", [a.orgId, `sam${u}+direct@gmail.com`, a.ownerId])))
      .rejects.toThrow(/partners_org_email_norm_idx/);
    expect(await withSystem((db) => db.rows<{ indexname: string; indexdef: string }>("select indexname, indexdef from pg_indexes where schemaname = 'public' and tablename = 'partners' and indexdef like 'CREATE UNIQUE%' order by indexname")))
      .toEqual([{ indexname: 'partners_org_email_norm_idx', indexdef: 'CREATE UNIQUE INDEX partners_org_email_norm_idx ON public.partners USING btree (org_id, app.email_norm(email))' }, { indexname: 'partners_pkey', indexdef: 'CREATE UNIQUE INDEX partners_pkey ON public.partners USING btree (id)' }]);
    // So that mailbox gets one introduction, not five.
    const box = outbox();
    expect((await runPartnerOutreach(a.orgId, { ...box.opts, now: MON })).sent).toBe(3);
    expect(box.mails.filter((m) => m.to.includes(u) && /gmail\.com$|googlemail\.com$/.test(m.to))).toHaveLength(1);
    // Another agency may have the same mailbox on its own list: the key is per agency.
    const b = await agency('PartnersMailboxB');
    expect(await add(b, [P({ email: `sam${u}+b@gmail.com` })])).toHaveLength(1);
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

// ================================================================ the operator's approval, the limits and the opt-out list
describe('nothing unattended goes out until the operator has approved the workspace', () => {
  const approveByCommand = (...args: string[]) => execFileSync('node', ['scripts/approve-outreach.mjs', ...args], { env: { ...process.env, APP_ENV: 'test' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  /** The next business day at 15:00 UTC, in real time: after the approval the command records, and a day partners are emailed. */
  const nextBusinessDay = (from = new Date(), plus = 1) => { let d = addDays(from.toISOString().slice(0, 10), plus); while (!isBusinessDay(d)) d = addDays(d, 1); return new Date(`${d}T15:00:00Z`); };

  it('a workspace as sign-up leaves it sends no partner email, whatever it switched on, and cannot approve itself', async () => {
    const a = await agency('PartnersFresh', ON, false);
    expect(await approval(a.orgId)).toEqual({ at: null, name: null });
    const [id] = await add(a, [P()]) as [string];
    const box = outbox();
    expect(await runPartnerOutreach(a.orgId, { ...box.opts, now: MON })).toEqual({ sent: 0, failed: 0, blocked: 'not_approved', held: null });
    expect((await runScheduledJobs({ onlyOrgIds: [a.orgId], now: MON })).partnerEmails).toBe(0);
    // The owner cannot write the approval: those columns are not granted to any tenant request...
    await expect(asUser(a.ownerId, (db) => db.run('update public.organizations set outreach_approved_at = now(), outreach_approved_name = name where id = $1', [a.orgId]))).rejects.toThrow(/permission denied/);
    // ...and nothing in the settings an owner can save stands in for it.
    await asUser(a.ownerId, (db) => db.run(`update public.organizations set settings = settings || '{"outreach_approved_at": "2020-01-01T00:00:00Z", "outreach_approved": true, "outreach_approved_name": "x"}'::jsonb where id = $1`, [a.orgId]));
    expect((await runPartnerOutreach(a.orgId, { ...box.opts, now: MON })).blocked).toBe('not_approved');
    expect(box.mails).toEqual([]);
    expect(await steps(id)).toEqual([]);
    expect(await approval(a.orgId)).toEqual({ at: null, name: null });
  });

  it('the operator’s command approves a workspace under its current name, leaves an audit entry, and can withdraw the approval', async () => {
    const a = await agency('PartnersOperator', ON, false);
    await add(a, Array.from({ length: NEW_WORKSPACE_DAILY_EMAILS + 4 }, () => P()));
    const box = outbox();
    const printed = approveByCommand(a.slug);
    expect(printed).toContain(`Approved "${a.name}" (${a.slug}) for automatic outreach under that name.`);
    // Before it approves, the command shows what the emails of this workspace carry besides its name.
    expect(printed).toContain(`"${a.name}" (${a.slug}) has saved, for its automatic emails:\n  Mailing address: "${ADDRESS}"\n  Reply address:   "${REPLY}"\n`);
    expect(printed.indexOf('Mailing address:')).toBeLessThan(printed.indexOf('Approved "'));
    const given = (await approval(a.orgId))!;
    expect(given.name).toBe(a.name);
    expect(Date.now() - new Date(given.at!).getTime()).toBeLessThan(60_000);
    expect(await count("select count(*)::int as n from public.audit_logs where org_id = $1 and action = 'outreach.approved' and actor_label = 'platform operator (outreach:approve)'", [a.orgId])).toBe(1);

    // Newly approved: for its first two weeks the workspace sends a quarter of the usual daily number, so a list that
    // turns out to be bad shows itself in a few bounces.
    const day1 = nextBusinessDay();
    expect(await runPartnerOutreach(a.orgId, { ...box.opts, now: day1 })).toEqual({ sent: NEW_WORKSPACE_DAILY_EMAILS, failed: 0, blocked: null, held: null });
    expect(await runPartnerOutreach(a.orgId, { ...box.opts, now: day1 })).toEqual({ sent: 0, failed: 0, blocked: null, held: 'daily_cap' });
    expect(NEW_WORKSPACE_DAILY_EMAILS).toBeLessThan(PARTNER_DAILY_CAP);
    // The rest wait for another day.
    expect(await runPartnerOutreach(a.orgId, { ...box.opts, now: nextBusinessDay(day1) })).toEqual({ sent: 4, failed: 0, blocked: null, held: null });

    // Renamed after the approval: the name is in every subject and From line, so nothing is sent until it is approved again.
    const waiting = await add(a, [P()]);
    await asUser(a.ownerId, (db) => db.run("update public.organizations set name = 'Chase Bank Account Services' where id = $1", [a.orgId]));
    const later = nextBusinessDay(day1, 3);
    expect((await runPartnerOutreach(a.orgId, { ...box.opts, now: later })).blocked).toBe('not_approved');
    expect(await steps(waiting[0]!)).toEqual([]);
    await asUser(a.ownerId, (db) => db.run('update public.organizations set name = $2 where id = $1', [a.orgId, a.name]));
    expect((await runPartnerOutreach(a.orgId, { ...box.opts, now: later })).sent).toBe(1); // back under the approved name

    // Withdrawn: nothing more is sent. An unknown workspace changes nothing and says so.
    const withdrawn = approveByCommand(a.slug, '--revoke');
    expect(withdrawn).toContain(`Approval withdrawn for "${a.name}"`);
    expect(withdrawn).not.toContain('Mailing address');
    // A workspace that saved neither address is shown as such, with whatever text it did save printed as it is.
    const bare = await agency('PartnersOperatorBare', { lead_mailing_address: 'URGENT: sign in at https://secure-escrow-verify.example/login' }, false);
    expect(approveByCommand(bare.slug)).toContain('  Mailing address: "URGENT: sign in at https://secure-escrow-verify.example/login"\n  Reply address:   none saved\n');
    expect(await approval(a.orgId)).toEqual({ at: null, name: null });
    await add(a, [P()]);
    expect((await runPartnerOutreach(a.orgId, { ...box.opts, now: later })).blocked).toBe('not_approved');
    expect(() => approveByCommand(`no-such-workspace-${uniq()}`)).toThrow(/Nothing was changed/);
    expect(() => approveByCommand()).toThrow(/Usage/);
  });

  it('the whole service sends a bounded number of partner emails in any 24 hours, across every workspace', async () => {
    const a = await agency('PartnersPlatformCapA', ON);
    const b = await agency('PartnersPlatformCapB', ON);
    await add(a, [P(), P(), P()]);
    await add(b, [P(), P(), P()]);
    const box = outbox();
    // What every workspace in this database has already claimed in the window, plus four more.
    const already = await count("select count(*)::int as n from public.partner_outreach where status in ('sending', 'sent') and claimed_at > $1::timestamptz - interval '24 hours'", [MON]);
    process.env.OUTREACH_PLATFORM_DAILY_EMAILS = String(already + 4);
    resetEnvCache();
    try {
      expect(await runPartnerOutreach(a.orgId, { ...box.opts, now: MON })).toEqual({ sent: 3, failed: 0, blocked: null, held: null });
      // The second workspace gets the one that is left; its own limit is nowhere near.
      expect(await runPartnerOutreach(b.orgId, { ...box.opts, now: MON })).toEqual({ sent: 1, failed: 0, blocked: null, held: 'platform_cap' });
      expect(await runPartnerOutreach(b.orgId, { ...box.opts, now: MON })).toEqual({ sent: 0, failed: 0, blocked: null, held: 'platform_cap' });
      expect(box.mails).toHaveLength(4);
      // Set to zero, the operator has stopped partner email for the whole deployment.
      process.env.OUTREACH_PLATFORM_DAILY_EMAILS = '0';
      resetEnvCache();
      expect(await runPartnerOutreach(b.orgId, { ...box.opts, now: MON })).toMatchObject({ sent: 0, held: 'platform_cap' });
    } finally { process.env.OUTREACH_PLATFORM_DAILY_EMAILS = saved.OUTREACH_PLATFORM_DAILY_EMAILS; resetEnvCache(); }
    expect((await runPartnerOutreach(b.orgId, { ...box.opts, now: MON })).sent).toBe(2);
  });

  it('one opt-out list for the whole service: an address that stopped these emails is not written to through another workspace, or under a +tag', async () => {
    const a = await agency('PartnersListA', ON);
    const b = await agency('PartnersListB', ON);
    const c = await agency('PartnersListC', ON);
    const u = uniq();
    const [pa, ga] = await add(a, [P({ email: `dana@hill-${u}.example` }), P({ email: `dana.hill.${u}@gmail.com` })]) as [string, string];
    const [same, gmail, other] = await add(b, [P({ email: `dana@hill-${u}.example` }), P({ email: `danahill${u}+work@googlemail.com` }), P({ email: `sam@hill-${u}.example` })]) as [string, string, string];
    const [tagged] = await add(c, [P({ email: `dana+spring@hill-${u}.example` })]) as [string];
    const box = outbox();
    expect((await runPartnerOutreach(a.orgId, { ...box.opts, now: MON })).sent).toBe(2);
    await optOutPartner(partnerOptOutToken(pa));
    await optOutPartner(partnerOptOutToken(ga));

    // Two other workspaces have those mailboxes on their lists, as new partners. Only the address that never opted out is emailed.
    expect(await runPartnerOutreach(b.orgId, { ...box.opts, now: MON })).toEqual({ sent: 1, failed: 0, blocked: null, held: null });
    expect(await runPartnerOutreach(c.orgId, { ...box.opts, now: MON })).toEqual({ sent: 0, failed: 0, blocked: null, held: null });
    expect(box.mails.slice(2).map((m) => m.to)).toEqual([`sam@hill-${u}.example`]);
    for (const id of [same, tagged, gmail]) {
      expect(await steps(id)).toEqual([]);
      // Paused with the reason, not stamped as opted out: that stamp can never be lifted, and the stop is on another workspace's record.
      expect(await partner(id)).toMatchObject({ status: 'new', paused: true, opted_out: false });
      expect((await events(id)).at(-1)).toEqual({ kind: 'paused', summary: 'Paused automatically: this address opted out of partner emails sent through this service. No email is sent to it.' });
    }
    expect(await partner(other)).toMatchObject({ status: 'in_sequence', opted_out: false });
    // Whatever day it is, and however often the job runs, they stay off.
    for (const n of [1, 4, 11]) for (const org of [b, c]) await runPartnerOutreach(org.orgId, { ...box.opts, now: day(n) });
    // Resumed by a person, it is paused again by the next run, and one entry is written each time, not one per run.
    expect(await asUser(b.ownerId, (db) => resumePartner(db, actor(b), same))).toBe(true);
    for (const n of [14, 15]) await runPartnerOutreach(b.orgId, { ...box.opts, now: day(n) }); // a Monday and a Tuesday
    expect(await partner(same)).toMatchObject({ status: 'new', paused: true, opted_out: false });
    expect((await events(same)).filter((e) => e.kind === 'paused')).toHaveLength(2);
    expect(box.mails.filter((m) => /dana|danahill/.test(m.to))).toHaveLength(2); // the two introductions the first workspace sent before the opt-out
    // The normalisation the list is read by: case, a "+tag", and for Gmail the dots it ignores.
    const norm = (addr: string) => withSystem((db) => db.row<{ n: string }>('select app.email_norm($1) as n', [addr])).then((r) => r!.n);
    expect(await norm(' Dana+Spring@Hill.Example ')).toBe('dana@hill.example');
    expect(await norm('d.a.n.a+x@googlemail.com')).toBe('dana@gmail.com');
    expect(await norm('dana.hill@outlook.example')).toBe('dana.hill@outlook.example'); // dots matter everywhere else
  });

  it('“Asked to stop” recorded by the staff of one workspace stops that workspace’s emails and nobody else’s', async () => {
    const victim = await agency('PartnersVictim', ON);
    const rival = await agency('PartnersRival', null, false); // signed up a minute ago: not approved, has never sent anything
    const specialist = await addMember(rival.orgId, 'specialist');
    const u = uniq();
    const ids = await add(victim, [P({ email: `sam@oak-${u}.example` }), P({ email: `dana@hill-${u}.example` }), P({ email: `lee.realtor.${u}@gmail.com` })]) as string[];
    // The rival lists the same mailboxes, in other spellings too, and its lowest staff role presses "Asked to stop" on each.
    const theirs = (await asUser(specialist.id, (db) => addPartners(db, { orgId: rival.orgId, userId: specialist.id }, [
      P({ email: `sam@oak-${u}.example` }), P({ email: `dana+x@hill-${u}.example` }), P({ email: `leerealtor${u}@googlemail.com` }),
    ], 'Added by hand.'))).ids as string[];
    for (const id of theirs) expect(await asUser(specialist.id, (db) => partnerAskedToStop(db, { orgId: rival.orgId, userId: specialist.id }, id))).toBe(true);
    // A signed-in person cannot write the kind of entry that counts for every workspace: the timeline takes entries under their own name only.
    await expect(asUser(specialist.id, (db) => db.run(
      "insert into public.partner_events (org_id, partner_id, actor_id, kind, summary) values ($1, $2, null, 'opted_out', 'x')", [rival.orgId, theirs[0]]))).rejects.toThrow(/row-level security/);

    const box = outbox();
    expect(await runPartnerOutreach(victim.orgId, { ...box.opts, now: MON })).toEqual({ sent: 3, failed: 0, blocked: null, held: null });
    for (const id of ids) {
      expect(await partner(id)).toMatchObject({ status: 'in_sequence', paused: false, opted_out: false });
      expect((await events(id)).map((e) => e.kind)).toEqual(['added', 'email_sent']);
    }
    // In its own workspace the stop holds as before.
    for (const id of theirs) expect(await partner(id)).toMatchObject({ status: 'opted_out', opted_out: true });
  });

  it('where a partner stands in the sequence is written by the scheduled job: a signed-in person cannot put a bounced or finished address back in line', async () => {
    const a = await agency('PartnersLine', ON);
    const [bounced, finished, fresh] = await add(a, [P(), P(), P()]) as [string, string, string];
    await asUser(a.ownerId, (db) => markPartner(db, actor(a), bounced, 'bounced'));
    await withSystem((db) => db.run("update public.partners set status = 'finished' where id = $1", [finished]));
    const set = (id: string, status: string) => asUser(a.ownerId, (db) => db.run('update public.partners set status = $2 where id = $1', [id, status]));
    for (const status of ['new', 'in_sequence']) {
      await expect(set(bounced, status), status).rejects.toThrow(/set by the scheduled job only/);
      await expect(set(finished, status), status).rejects.toThrow(/set by the scheduled job only/);
    }
    await expect(set(fresh, 'finished')).rejects.toThrow(/set by the scheduled job only/);
    await expect(set(fresh, 'in_sequence')).rejects.toThrow(/set by the scheduled job only/);
    // What a person does record still saves, and so does everything that leaves the status alone.
    expect(await asUser(a.ownerId, (db) => markPartner(db, actor(a), finished, 'replied'))).toBe(true);
    expect(await asUser(a.ownerId, (db) => pausePartner(db, actor(a), fresh))).toBe(true);
    expect(await asUser(a.ownerId, (db) => resumePartner(db, actor(a), fresh))).toBe(true);
    expect(await asUser(a.ownerId, (db) => updatePartner(db, actor(a), fresh, { ...P(), businessName: 'Renamed Co' }))).toBe(true);
    const box = outbox();
    expect((await runPartnerOutreach(a.orgId, { ...box.opts, now: MON })).sent).toBe(1);
    expect(box.mails).toHaveLength(1);
    expect(await partner(fresh)).toMatchObject({ status: 'in_sequence' });
    expect(await partner(bounced)).toMatchObject({ status: 'bounced' });
  });

  it('opening the opt-out link changes nothing; the button on that page, or the mail program’s one-click request, is the opt-out', async () => {
    const a = await agency('PartnersLink', ON);
    const [id, viaHeader] = await add(a, [P({ language: 'es' }), P()]) as [string, string];
    const box = outbox();
    expect((await runPartnerOutreach(a.orgId, { ...box.opts, now: MON })).sent).toBe(2);
    const token = partnerOptOutToken(id);

    // What a mail security gateway does with every link in an incoming email: it fetches it. Three times, here.
    for (let i = 0; i < 3; i++) expect(await partnerOptOutInfo(token)).toEqual({ orgId: a.orgId, orgName: a.name, lang: 'es', optedOut: false });
    const { GET, POST } = await import('@/app/api/unsubscribe/partner/[token]/route');
    const oneClick = (t: string, method: 'GET' | 'POST') => (method === 'GET' ? GET : POST)(
      new Request(`http://localhost:3000/api/unsubscribe/partner/${t}`, { method, headers: { 'x-forwarded-for': testIp() }, ...(method === 'POST' ? { body: 'List-Unsubscribe=One-Click', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': testIp() } } : {}) }),
      { params: Promise.resolve({ token: t }) });
    const fetched = await oneClick(partnerOptOutToken(viaHeader), 'GET');
    expect(fetched.status).toBe(303);
    expect(fetched.headers.get('location')).toBe(`http://localhost:3000/unsubscribe/partner/${partnerOptOutToken(viaHeader)}`);
    expect((await oneClick('not-a-token', 'GET')).status).toBe(404);
    for (const p of [id, viaHeader]) expect(await partner(p)).toMatchObject({ status: 'in_sequence', opted_out: false });
    expect(await events(id)).toHaveLength(2); // added, email sent: nothing else
    // So the follow-up still goes out to both.
    expect((await runPartnerOutreach(a.orgId, { ...box.opts, now: day(4) })).sent).toBe(2);

    // The button on the page (a POST), and the one-click request a mail program sends for the header.
    expect(await optOutPartner(token)).toEqual({ orgId: a.orgId, orgName: a.name, lang: 'es' });
    expect(await partnerOptOutInfo(token)).toMatchObject({ optedOut: true });
    const posted = await oneClick(partnerOptOutToken(viaHeader), 'POST');
    expect(posted.status).toBe(200);
    expect(await posted.text()).toBe('You will not receive these emails again.');
    expect((await oneClick(`${partnerOptOutToken(viaHeader).slice(0, -2)}xx`, 'POST')).status).toBe(404);
    for (const p of [id, viaHeader]) expect(await partner(p)).toMatchObject({ status: 'opted_out', opted_out: true });
    expect((await events(viaHeader)).at(-1)).toEqual({ kind: 'opted_out', summary: 'Opted out from an email (the link, or the mail program’s unsubscribe button). No further email is sent to this address.' });
    expect((await runPartnerOutreach(a.orgId, { ...box.opts, now: day(11) })).sent).toBe(0);
    expect(box.mails).toHaveLength(4);
  });

  it('a partner who opted out can still be recorded as having replied or being interested, and is still never emailed', async () => {
    const a = await agency('PartnersOptedOutReply', ON);
    const [id, paused] = await add(a, [P(), P()]) as [string, string];
    const box = outbox();
    expect((await runPartnerOutreach(a.orgId, { ...box.opts, now: MON })).sent).toBe(2);
    await optOutPartner(partnerOptOutToken(id));
    // They opted out of the emails and then telephoned: that is worth recording.
    expect(await asUser(a.ownerId, (db) => markPartner(db, actor(a), id, 'replied'))).toBe(true);
    expect(await partner(id)).toMatchObject({ status: 'replied', opted_out: true });
    expect((await events(id)).at(-1)).toEqual({ kind: 'replied', summary: 'Marked as replied. This address opted out of the emails and is still never emailed.' });
    expect(await asUser(a.ownerId, (db) => markPartner(db, actor(a), id, 'interested'))).toBe(true);
    expect(await partner(id)).toMatchObject({ status: 'interested', opted_out: true });
    // "Bounced" is about an address that is being written to, and no status can put them back in the sequence.
    expect(await asUser(a.ownerId, (db) => markPartner(db, actor(a), id, 'bounced'))).toBe(false);
    await expect(asUser(a.ownerId, (db) => db.run("update public.partners set status = 'in_sequence' where id = $1", [id]))).rejects.toThrow(/opt-out cannot be undone/);
    await expect(withSystem((db) => db.run("update public.partners set status = 'new' where id = $1", [id]))).rejects.toThrow(/opt-out cannot be undone/);
    await expect(withSystem((db) => db.run("update public.partners set opted_out_at = null where id = $1", [id]))).rejects.toThrow(/opt-out cannot be undone/);
    expect(await asUser(a.ownerId, (db) => retryPartnerStep(db, actor(a), id))).toBe(false);
    // A paused partner who opts out is no longer "paused": the opt-out is what stands.
    await asUser(a.ownerId, (db) => pausePartner(db, actor(a), paused));
    await optOutPartner(partnerOptOutToken(paused));
    expect(await partner(paused)).toMatchObject({ status: 'opted_out', paused: false, opted_out: true });
    for (const n of [4, 11, 30]) expect((await runPartnerOutreach(a.orgId, { ...box.opts, now: day(n) })).sent).toBe(0);
    expect(box.mails).toHaveLength(2);
  });

  it('a bounce or a spam complaint reported by the email service is recorded, and a list with too many bounces holds the sequence', async () => {
    const a = await agency('PartnersBounces', ON);
    const tag = uniq();
    const ids = await add(a, Array.from({ length: 12 }, () => P()));
    const mails: Email[] = [];
    const send = async (m: Email): Promise<SendResult> => { mails.push(m); return { ok: true, provider: 'resend', providerRef: `re-${tag}-${mails.length}` }; };
    expect((await runPartnerOutreach(a.orgId, { live: true, send, now: MON })).sent).toBe(PARTNER_PER_RUN_CAP);
    const refOf = async (to: string) => (await withSystem((db) => db.row<{ ref: string; id: string }>('select o.provider_ref as ref, p.id from public.partner_outreach o join public.partners p on p.id = o.partner_id where p.org_id = $1 and p.email = $2', [a.orgId, to])))!;

    // An id that is not one of this sequence's emails changes nothing.
    expect(await recordPartnerDeliveryEvent(`re-${tag}-999`, 'bounced')).toBe(false);
    expect(await recordPartnerDeliveryEvent('', 'complained')).toBe(false);
    // A spam complaint is an opt-out, for good.
    const complained = await refOf(mails[0]!.to);
    expect(await recordPartnerDeliveryEvent(complained.ref, 'complained')).toBe(true);
    expect(await partner(complained.id)).toMatchObject({ status: 'opted_out', opted_out: true });
    expect((await events(complained.id)).at(-1)).toEqual({ kind: 'opted_out', summary: 'The recipient marked one of these emails as spam. No email is sent to this address again.' });
    // A bounce stops that partner, as the "Bounced" button does. Reported twice, it is recorded once.
    const first = await refOf(mails[1]!.to);
    expect(await recordPartnerDeliveryEvent(first.ref, 'bounced')).toBe(true);
    expect(await recordPartnerDeliveryEvent(first.ref, 'bounced')).toBe(true);
    expect(await partner(first.id)).toMatchObject({ status: 'bounced' });
    expect((await events(first.id)).filter((e) => e.kind === 'bounced')).toEqual([{ kind: 'bounced', summary: 'The email service reported that an email to this address came back undelivered. No further automatic email is sent.' }]);

    // Two bounces is bad luck; the sequence carries on for everyone else.
    const second = await refOf(mails[2]!.to);
    await recordPartnerDeliveryEvent(second.ref, 'bounced');
    expect(await asUser(a.ownerId, (db) => partnerBounceHealth(db, a.orgId, APPROVED))).toMatchObject({ bounced: 2, hold: false });
    expect((await runPartnerOutreach(a.orgId, { live: true, send, now: MON })).sent).toBe(2);
    // A third (one typed in by staff counts the same) is a bad list: nothing more goes out, to anyone on it.
    const third = ids.find((id) => ![complained.id, first.id, second.id].includes(id))!;
    await asUser(a.ownerId, (db) => markPartner(db, actor(a), third, 'bounced'));
    expect(PARTNER_BOUNCE_MIN).toBe(3);
    // Counted from the approval: the twelve emails sent since then, whenever that was, and the three bounces.
    expect(await asUser(a.ownerId, (db) => partnerBounceHealth(db, a.orgId, APPROVED))).toEqual({ sent: 12, bounced: 3, hold: true });
    const sentSoFar = mails.length;
    for (const n of [4, 5, 11]) {
      const r = await runPartnerOutreach(a.orgId, { live: true, send, now: day(n) });
      expect(r.sent).toBe(0);
      if (isBusinessDay(day(n).toISOString().slice(0, 10))) expect(r.held).toBe('bounces');
    }
    expect(mails).toHaveLength(sentSoFar);
    // Time does not lift it. The same bounces a month and a year later hold the sequence all the same.
    for (const age of ['31 days', '1 year']) {
      await withSystem((db) => db.run('update public.partner_events set created_at = created_at - $2::interval where org_id = $1 and kind = \'bounced\'', [a.orgId, age]));
      expect(await asUser(a.ownerId, (db) => partnerBounceHealth(db, a.orgId, APPROVED)), age).toEqual({ sent: 12, bounced: 3, hold: true });
      expect(await runPartnerOutreach(a.orgId, { live: true, send, now: day(11) }), age).toEqual({ sent: 0, failed: 0, blocked: null, held: 'bounces' });
    }
    expect(mails).toHaveLength(sentSoFar);
    // It stays held until the operator has looked at the list and approved the workspace again, which restarts the count.
    await approveOutreach(a.orgId, new Date());
    expect(await asUser(a.ownerId, (db) => partnerBounceHealth(db, a.orgId, new Date()))).toMatchObject({ bounced: 0, hold: false });
  });

  it('no model writes any of it: the old AI switch is ignored, no credit is spent and the wording is the fixed one', async () => {
    const a = await agency('PartnersNoAi', { ...ON, partner_outreach_ai: true });
    await withSystem((db) => db.run("insert into public.ai_credit_ledger (org_id, delta, reason, note) values ($1, 5, 'grant', 'test')", [a.orgId]));
    // A provider is "connected": anything that still called a model would reach this.
    const called: string[] = [];
    vi.stubGlobal('fetch', async (url: string | URL) => { called.push(String(url)); throw new Error(`unexpected request to ${String(url)}`); });
    Object.assign(process.env, { AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'sk-ant-test-key-for-vitest' });
    resetEnvCache();
    try {
      const [id] = await add(a, [P()]) as [string];
      const box = outbox();
      for (const n of [0, 4, 11]) expect((await runPartnerOutreach(a.orgId, { ...box.opts, now: day(n) })).sent).toBe(1);
      expect(called).toEqual([]);
      expect(await getBalance(a.orgId)).toBe(5);
      expect(await count("select count(*)::int as n from public.ai_credit_ledger where org_id = $1 and reason <> 'grant'", [a.orgId])).toBe(0);
      const vars = { contactName: 'Dana Whitfield', category: 'real_estate_agent' as const, city: 'Austin', state: 'TX', orgName: a.name, address: ADDRESS, optOutUrl: `http://localhost:3000/unsubscribe/partner/${partnerOptOutToken(id)}`, siteUrl: null };
      expect(box.mails.map((m) => m.text)).toEqual((['intro', 'followup', 'final'] as const).map((step) => partnerEmail(step, 'en', vars).text));
      expect(await steps(id)).toMatchObject([{ step: 'intro', status: 'sent' }, { step: 'followup', status: 'sent' }, { step: 'final', status: 'sent' }]);
      expect((await events(id)).filter((e) => e.kind === 'email_sent').map((e) => e.summary)).toEqual(['Introduction email sent automatically', 'Follow-up email sent automatically', 'Last note email sent automatically']);
    } finally {
      vi.unstubAllGlobals();
      delete process.env.AI_PROVIDER; delete process.env.ANTHROPIC_API_KEY;
      resetEnvCache();
    }
  });
});

// ================================================================ people who asked to be contacted: text follow-up
describe('lead follow-up by text: only with a text consent from the enquiry form', () => {
  const AREA_CODES = ['212', '216', '303', '305', '312', '314', '404', '412', '415', '503', '512', '602', '615', '617', '702', '704', '713', '801', '816', '919'];
  /** A US number nobody else in the (never truncated) test database has: a real area code of the 48 states, any exchange, any line. */
  const phone = (): string => {
    const n = `+1${AREA_CODES[Math.floor(Math.random() * AREA_CODES.length)]}${2 + Math.floor(Math.random() * 8)}${String(Math.floor(Math.random() * 100)).padStart(2, '0')}${String(Math.floor(Math.random() * 10_000)).padStart(4, '0')}`;
    return toUsE164(n) ? n : phone();
  };
  // Tomorrow, so it is after every enquiry made during the test. 20:00 UTC is the hour the scheduled run texts at: the
  // afternoon coast to coast, and still morning in Hawaii. 08:00 UTC is the middle of the night everywhere in the country.
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  const NOON = new Date(`${tomorrow}T20:00:00Z`);
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
    expect(await Promise.all([none, emailOnly, on].map((x) => leadTextsOfferedBySlug(x.slug)))).toEqual([false, false, true]);
    expect(leadTextsOffered(null)).toBe(false);
    // A workspace the operator has not approved offers no text box and sends no text, whatever it switched on...
    const fresh = await agency('LeadTextsFresh', TEXTS_ON(), false);
    expect(await leadTextsOfferedBySlug(fresh.slug)).toBe(false);
    expect((await runLeadTexts(fresh.orgId, { now: NOON })).blocked).toBe('not_approved');
    // ...and neither does one renamed since it was approved, or one whose name would put a web address in every text.
    const renamed = await agency('LeadTextsRenamed', TEXTS_ON());
    await withSystem((db) => db.run("update public.organizations set name = 'Chase Fraud Team' where id = $1", [renamed.orgId]));
    expect((await runLeadTexts(renamed.orgId, { now: NOON })).blocked).toBe('not_approved');
    await withSystem((db) => db.run("update public.organizations set name = 'Acme chase-verify.example', outreach_approved_name = 'Acme chase-verify.example' where id = $1", [renamed.orgId]));
    expect((await runLeadTexts(renamed.orgId, { now: NOON })).blocked).toBe('name_link');
    expect(await leadTextsOfferedBySlug(renamed.slug)).toBe(false);
    // With no text service connected nothing is offered and nothing is sent.
    process.env.SMS_DRIVER = 'disabled'; resetEnvCache();
    try {
      expect(await leadTextsOfferedBySlug(on.slug)).toBe(false);
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
    // A number in another country, or a "+1" number that is not a US one, is refused before anything is created: the
    // public form cannot be used to make this service text Cameroon, the UK, Jamaica, Canada or a premium-rate line.
    for (const abroad of ['+237 6 77 12 34 56', '+44 7911 123456', '+8801712345678', '+1 876 555 1234', '+1 416 555 0134', '(900) 555-1234', '(212) 976-1234']) {
      const refused = await enquire(a, { phone: abroad, smsConsent: true });
      expect(refused.r, abroad).toEqual({ ok: false, error: LEAD_SMS_NEEDS_PHONE.en });
      expect(refused.id, abroad).toBe('');
    }
    // Without the text box, the same number is just the phone number on an enquiry: saved, and never texted.
    const call = await enquire(a, { phone: '+44 7911 123456' });
    expect(call.r).toEqual({ ok: true });
    expect(await consent(call.id)).toBeNull();
    // A consent that reached the ledger some other way for a number that is not a US one still produces no text.
    const odd = await enquire(a, { phone: '+44 7911 123456' });
    await withSystem((db) => db.run("insert into public.sms_consents (org_id, client_id, phone, consent_text, source) values ($1, $2, '+447911123456', repeat('y', 30), 'enquiry_form')", [a.orgId, odd.id]));
    expect(await runLeadTexts(a.orgId, { now: NOON })).toEqual({ sent: 0, failed: 0, waiting: 0, blocked: null });
    expect(textsTo('+447911123456')).toEqual([]);
    expect(await log(odd.id)).toEqual([]);
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
    // Marketing texts keep to 9:00-20:00 where the person may be. 13:30 UTC is 8:30 in New York (too early for a
    // marketing text, though not for a file update); 17:00 UTC is noon in New York and 9:00 on the Pacific coast.
    expect((await runLeadTexts(a.orgId, { now: new Date(`${tomorrow}T13:30:00Z`) })).waiting).toBe(1);
    expect((await runLeadTexts(a.orgId, { now: new Date(`${tomorrow}T12:30:00Z`) })).waiting).toBe(1);
    // A Hawaii or Alaska number is judged in its own zone as well: at 17:00 UTC it is 7 a.m. in Honolulu and 8 a.m. in
    // Anchorage, so those two wait, while a number from the 48 states could be texted.
    const b = await agency('LeadTextsZones', TEXTS_ON());
    const line = () => String(Math.floor(Math.random() * 10_000)).padStart(4, '0');
    // (Drawn again when the exchange comes out as a service code such as 411, which is not a number that can exist.)
    const inAreaCode = (code: string): string => { const n = `+1${code}${2 + Math.floor(Math.random() * 7)}${line().slice(0, 2)}${line()}`; return toUsE164(n) ? n : inAreaCode(code); };
    const [hawaii, alaska, mainland] = [inAreaCode('808'), inAreaCode('907'), phone()];
    expect([usAreaCodeState(hawaii), usAreaCodeState(alaska)]).toEqual(['HI', 'AK']);
    for (const n of [hawaii, alaska, mainland]) expect((await enquire(b, { phone: n, smsConsent: true })).r).toEqual({ ok: true });
    expect(await runLeadTexts(b.orgId, { now: new Date(`${tomorrow}T17:00:00Z`) })).toEqual({ sent: 1, failed: 0, waiting: 2, blocked: null });
    expect([textsTo(hawaii), textsTo(alaska), textsTo(mainland).length]).toEqual([[], [], 1]);
    // At the hour the scheduled run texts (20:00 UTC) it is 10 a.m. in Honolulu and 11 a.m. in Anchorage.
    expect(await runLeadTexts(b.orgId, { now: NOON })).toEqual({ sent: 2, failed: 0, waiting: 0, blocked: null });
    expect([textsTo(hawaii).length, textsTo(alaska).length, textsTo(mainland).length]).toEqual([1, 1, 1]);
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

  it('the form sent many times at the same moment with one number records one consent and sends one text', async () => {
    const a = await agency('LeadTextsRace', TEXTS_ON());
    const number = phone();
    // Eight submissions at once: the same number, different names, email addresses and IP addresses.
    const all = await Promise.all(Array.from({ length: 8 }, (_, i) => enquire(a, { phone: number, smsConsent: true, fullName: `Pat ${i}` })));
    expect(all.map((l) => l.r)).toEqual(Array.from({ length: 8 }, () => ({ ok: true }))); // every enquiry is saved
    expect(await count("select count(*)::int as n from public.sms_consents where org_id = $1 and phone = $2 and revoked_at is null", [a.orgId, number])).toBe(1);
    expect(await count("select count(*)::int as n from public.sms_consents where org_id = $1 and phone = $2", [a.orgId, number])).toBe(1);
    // The other seven are told on their timeline why they have no consent.
    expect(await count("select count(*)::int as n from public.client_events where org_id = $1 and kind = 'sms_consent' and summary like 'Ticked the text message box on the enquiry form, but another enquiry already has a text consent%'", [a.orgId])).toBe(7);
    expect(await runLeadTexts(a.orgId, { now: NOON })).toEqual({ sent: 1, failed: 0, waiting: 0, blocked: null });
    expect(textsTo(number)).toHaveLength(1);
    // And the one follow-up, three days later.
    for (const l of all) await age(a, l.id, 3);
    expect((await runLeadTexts(a.orgId, { now: NOON })).sent).toBe(1);
    expect(textsTo(number)).toHaveLength(2);
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

  it(`one workspace sends at most ${LEAD_TEXT_DAILY_CAP} lead texts in any 24 hours, however many enquiries arrive and however many runs overlap`, async () => {
    const a = await agency('LeadTextsCap', TEXTS_ON());
    const numbers = Array.from({ length: LEAD_TEXT_DAILY_CAP + 3 }, () => phone());
    for (const n of numbers) expect((await enquire(a, { phone: n, smsConsent: true })).r).toEqual({ ok: true });
    // A text service that accepts every text and gives each an id, as Twilio does.
    const handed: { to: string; ref: string }[] = [];
    const send = async (m: Sms): Promise<SmsResult> => { const ref = `SM${uniq()}${uniq()}`; handed.push({ to: m.to, ref }); return { ok: true, provider: 'twilio', providerRef: ref }; };
    const texted = (n: string) => handed.filter((h) => h.to === n).length;
    const run = () => runLeadTexts(a.orgId, { now: NOON, send });
    const burst = await Promise.all([run(), run(), run()]);
    expect(sum(burst)).toBe(LEAD_TEXT_DAILY_CAP);
    expect(burst.some((r) => r.held === 'daily_cap')).toBe(true);
    expect(await run()).toMatchObject({ sent: 0, failed: 0, held: 'daily_cap' });
    expect(numbers.filter((n) => texted(n) === 1)).toHaveLength(LEAD_TEXT_DAILY_CAP);
    expect(numbers.some((n) => texted(n) > 1)).toBe(false); // nobody was texted twice
    // The carrier then reports ten of them undelivered (dead numbers, landlines). They were handed to the text service
    // all the same, so they still count: a form fed with numbers that take no texts reaches the limit like any other.
    for (const h of handed.slice(0, 10)) expect(await recordSmsStatus(h.ref, 'undelivered', '30006')).toEqual({ kind: 'status', matched: 1 });
    expect(await count("select count(*)::int as n from public.lead_outreach where org_id = $1 and status = 'failed'", [a.orgId])).toBe(10);
    expect(await run()).toMatchObject({ sent: 0, failed: 0, held: 'daily_cap' });
    // So does a text the text service refused outright.
    await withSystem((db) => db.run("update public.lead_outreach set status = 'failed', error = 'The text service refused the message' where id in (select id from public.lead_outreach where org_id = $1 and status = 'sent' limit 5)", [a.orgId]));
    expect(await run()).toMatchObject({ sent: 0, failed: 0, held: 'daily_cap' });
    expect(handed).toHaveLength(LEAD_TEXT_DAILY_CAP);
    // The three that were left out go out once the earlier ones are more than a day old.
    await withSystem((db) => db.run("update public.lead_outreach set created_at = created_at - interval '25 hours' where org_id = $1", [a.orgId]));
    expect(await run()).toEqual({ sent: 3, failed: 0, waiting: 0, blocked: null });
    expect(numbers.every((n) => texted(n) === 1)).toBe(true);
  });

  it('the whole service sends a bounded number of lead texts in any 24 hours, across every workspace', async () => {
    const a = await agency('LeadTextsPlatformA', TEXTS_ON());
    const b = await agency('LeadTextsPlatformB', TEXTS_ON());
    const [a1, a2, b1, b2] = [phone(), phone(), phone(), phone()];
    for (const [who, n] of [[a, a1], [a, a2], [b, b1], [b, b2]] as const) await enquire(who, { phone: n, smsConsent: true });
    // What every workspace in this database has claimed in the last 24 hours, whatever became of each text, plus three more.
    const already = await count("select count(*)::int as n from public.lead_outreach where step in ('text_welcome', 'text_followup') and created_at > now() - interval '24 hours'", []);
    process.env.OUTREACH_PLATFORM_DAILY_TEXTS = String(already + 3);
    resetEnvCache();
    try {
      expect(await runLeadTexts(a.orgId, { now: NOON })).toEqual({ sent: 2, failed: 0, waiting: 0, blocked: null });
      expect(await runLeadTexts(b.orgId, { now: NOON })).toMatchObject({ sent: 1, failed: 0, held: 'platform_cap' });
      expect(await runLeadTexts(b.orgId, { now: NOON })).toMatchObject({ sent: 0, held: 'platform_cap' });
      expect([a1, a2, b1, b2].map((n) => textsTo(n).length).reduce((x, y) => x + y, 0)).toBe(3);
    } finally { process.env.OUTREACH_PLATFORM_DAILY_TEXTS = saved.OUTREACH_PLATFORM_DAILY_TEXTS; resetEnvCache(); }
    expect((await runLeadTexts(b.orgId, { now: NOON })).sent).toBe(1);
  });

  it('a reply to a lead text reaches the workspace that texted last and stops its follow-up; a carrier failure stops the texts to that number', async () => {
    // The same person sent the enquiry form of two agencies, with the same mobile number, and agreed to texts on both.
    const a = await agency('LeadTextsReplyA', TEXTS_ON());
    const b = await agency('LeadTextsReplyB', TEXTS_ON());
    const number = phone();
    const la = await enquire(a, { phone: number, smsConsent: true });
    const lb = await enquire(b, { phone: number, smsConsent: true });
    const inbound = (clientId: string) => withSystem((db) => db.rows<{ body: string }>("select body from public.communications where client_id = $1 and direction = 'inbound' order by created_at", [clientId])).then((r) => r.map((x) => x.body));
    expect((await runLeadTexts(b.orgId, { now: NOON })).sent).toBe(1);
    expect((await runLeadTexts(a.orgId, { now: NOON })).sent).toBe(1);
    // "You can reply to this text": they do. Agency A texted them last, so the reply is A's.
    expect(await recordInboundSms({ sid: `SM${uniq()}${uniq()}`, from: number, body: 'After 5pm works for me' })).toEqual({ kind: 'message', matched: 1 });
    expect(await inbound(la.id)).toEqual(['After 5pm works for me']);
    expect(await inbound(lb.id)).toEqual([]);
    for (const l of [la, lb]) await age(a, l.id, 3);
    await withSystem((db) => db.run("update public.organizations set settings = settings || jsonb_build_object('lead_followup_since', (now() - interval '30 days')::text) where id = $1", [b.orgId]));
    // A reply is on A's lead: A's automatic text and emails stop, and staff answer. B heard nothing, so its follow-up goes out.
    expect(await runLeadTexts(a.orgId, { now: NOON })).toEqual({ sent: 0, failed: 0, waiting: 0, blocked: null });
    const box = emails();
    expect((await runLeadOutreach(a.orgId, { ...box.opts, clientId: la.id })).sent).toBe(0);
    expect((await runLeadTexts(b.orgId, { now: NOON })).sent).toBe(1);
    expect(textsTo(number)).toHaveLength(3);

    // The carrier reports that a welcome text was not delivered: the step is marked failed on the lead's follow-up log,
    // so no second text is sent to a number that does not take them.
    const c = await agency('LeadTextsCarrier', TEXTS_ON());
    const dead = phone();
    const lc = await enquire(c, { phone: dead, smsConsent: true });
    const sid = `SM${uniq()}${uniq()}`;
    const accepted = async (_: Sms): Promise<SmsResult> => ({ ok: true, provider: 'twilio', providerRef: sid });
    expect(await runLeadTexts(c.orgId, { now: NOON, send: accepted })).toEqual({ sent: 1, failed: 0, waiting: 0, blocked: null });
    expect(await log(lc.id)).toEqual([{ step: 'text_welcome', status: 'sent' }]);
    expect(await recordSmsStatus(sid, 'undelivered', '30005')).toEqual({ kind: 'status', matched: 1 });
    expect(await log(lc.id)).toEqual([{ step: 'text_welcome', status: 'failed' }]);
    expect(await withSystem((db) => db.row('select error from public.lead_outreach where client_id = $1', [lc.id]))).toEqual({ error: 'The carrier did not deliver it (Twilio error 30005)' });
    expect(await withSystem((db) => db.rows('select status from public.communications where client_id = $1', [lc.id]))).toEqual([{ status: 'failed' }]);
    await age(c, lc.id, 3);
    expect(await runLeadTexts(c.orgId, { now: NOON, send: accepted })).toEqual({ sent: 0, failed: 0, waiting: 0, blocked: null });
    // A "delivered" report changes nothing on the log.
    const lc2 = await enquire(c, { phone: phone(), smsConsent: true });
    const sid2 = `SM${uniq()}${uniq()}`;
    expect((await runLeadTexts(c.orgId, { now: NOON, send: async () => ({ ok: true, provider: 'twilio', providerRef: sid2 }) })).sent).toBe(1);
    expect(await recordSmsStatus(sid2, 'delivered')).toEqual({ kind: 'status', matched: 1 });
    expect(await log(lc2.id)).toEqual([{ step: 'text_welcome', status: 'sent' }]);
  });

  it('a consent that was withdrawn is not brought back by the public form, and one switched off for a lead stays off when they become a client', async () => {
    // The workspace also texts its clients when a dispute is sent (Settings, Client updates).
    const a = await agency('LeadTextsWithdrawn', { ...TEXTS_ON(), client_updates: { switches: { dispute_sent: { sms: true, email: false } }, window_since: null } });
    const [number, other] = [phone(), phone()];
    const l = await enquire(a, { phone: number, smsConsent: true });
    const control = await enquire(a, { phone: other, smsConsent: true, fullName: 'Did Not Ask To Stop' });
    expect((await runLeadTexts(a.orgId, { now: NOON })).sent).toBe(2);
    // One of them telephones and asks the team to stop. Staff record it ("Asked to stop" on the lead): no automatic
    // message follows, and the agreement to texts they gave on the form is withdrawn with it.
    await asUser(a.ownerId, async (db) => {
      await db.run('update public.clients set outreach_opt_out_at = now() where id = $1', [l.id]);
      expect(await revokeSmsConsent(db, { orgId: a.orgId, clientId: l.id, userId: a.ownerId, via: 'asked_to_stop' })).toBe(true);
    });
    expect(await consent(l.id)).toMatchObject({ revoked_via: 'asked_to_stop' });
    await age(a, l.id, 3);
    await age(a, control.id, 3);
    expect((await runLeadTexts(a.orgId, { now: NOON })).sent).toBe(1); // the follow-up for the other one only
    expect([textsTo(number).length, textsTo(other).length]).toEqual([1, 2]);

    // Later both become clients with a portal sign-in, and a dispute is sent for each. The one who never asked to stop
    // is texted about it under the consent they gave. The one who asked to stop is not: the old form consent does not
    // come back to life because the record changed from lead to client.
    const queued = async (clientId: string) => {
      const user = await addMember(a.orgId, 'client', 'portal');
      await withSystem((db) => db.run("update public.clients set status = 'active', portal_user_id = $2 where id = $1", [clientId, user.id]));
      const dispute = (await withSystem((db) => db.row<{ id: string }>("insert into public.disputes (org_id, client_id, item_label, bureau, recipient_name, category, reason, status) values ($1, $2, 'Acme ••1234 (Experian)', 'experian', 'Experian', 'incorrect_balance', 'Balance differs from my statement', 'submitted') returning id", [a.orgId, clientId])))!.id;
      await asUser(a.ownerId, (db) => queueClientUpdate(db, { orgId: a.orgId, clientId, event: 'dispute_sent', subjectId: dispute, defer: false }));
      return count("select count(*)::int as n from public.client_updates where client_id = $1 and channel = 'sms'", [clientId]);
    };
    expect(await queued(control.id)).toBe(1);
    expect(await queued(l.id)).toBe(0);
    expect(await withSystem((db) => db.row<{ stopped: boolean }>('select app.sms_stopped($1, $2) as stopped', [l.id, number]))).toEqual({ stopped: true });
    // Staff cannot simply switch texts back on for them, and neither can the form, sent again with the same number.
    await expect(asUser(a.ownerId, (db) => grantSmsConsent(db, { orgId: a.orgId, clientId: l.id, userId: a.ownerId, source: 'staff', note: 'They said yes on the phone this morning.' }))).resolves.toMatchObject({ ok: false, reason: 'stopped' });
    const again = await enquire(a, { phone: number, smsConsent: true, fullName: 'Same Number Again' });
    expect(again.r).toEqual({ ok: true });
    expect(await consent(again.id)).toBeNull();
    expect((await withSystem((db) => db.rows<{ summary: string }>("select summary from public.client_events where client_id = $1 and kind = 'sms_consent'", [again.id]))).map((e) => e.summary))
      .toEqual(['Ticked the text message box on the enquiry form, but texts to this number were switched off before. No consent was recorded and no text is sent: only the person, in the portal, or a staff member who records how they agreed can switch them back on.']);
    expect((await runLeadTexts(a.orgId, { now: NOON })).sent).toBe(0);
    expect(textsTo(number)).toHaveLength(1);
    // A consent staff switched off for a client (not a STOP) is not brought back by the form either.
    const b = await agency('LeadTextsStaffOff', TEXTS_ON());
    const num2 = phone();
    const typed = await addClient(b.orgId, 'Typed In', { status: 'active' });
    await withSystem((db) => db.run('update public.clients set phone = $2 where id = $1', [typed, num2]));
    await asUser(b.ownerId, (db) => grantSmsConsent(db, { orgId: b.orgId, clientId: typed, userId: b.ownerId, source: 'staff', note: 'Agreed on a call with me on Monday morning.' }));
    await asUser(b.ownerId, (db) => revokeSmsConsent(db, { orgId: b.orgId, clientId: typed, userId: b.ownerId, via: 'staff' }));
    const viaForm = await enquire(b, { phone: num2, smsConsent: true });
    expect(viaForm.r).toEqual({ ok: true });
    expect(await consent(viaForm.id)).toBeNull();
    expect((await runLeadTexts(b.orgId, { now: NOON })).sent).toBe(0);
    expect(textsTo(num2)).toEqual([]);
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
    // The next business day: after the enquiry below, and a day partners are emailed.
    let next = addDays(new Date().toISOString().slice(0, 10), 1);
    while (!isBusinessDay(next)) next = addDays(next, 1);
    const when = new Date(`${next}T20:00:00Z`); // the hour of the second daily run: inside texting hours in every US time zone

    const a = await agency('JobsAllOn', { ...ON, lead_followup_enabled: true, lead_followup_since: new Date(Date.now() - 60_000).toISOString(), lead_text_followup: true });
    const [pid] = await add(a, [P({ phone: '(512) 555-0199' })]) as [string];
    const number = `+1512555${String(Math.floor(Math.random() * 10_000)).padStart(4, '0')}`;
    const email = `lead-${uniq()}@example.test`;
    expect(await submitLead(a.slug, { fullName: 'Pat Lead', email, phone: number, language: 'en', consent: true, smsConsent: true }, { ip: testIp(), defer: () => undefined })).toEqual({ ok: true });

    const first = await runScheduledJobs({ onlyOrgIds: [a.orgId], now: when });
    expect(first).toMatchObject({ failures: 0, leadEmails: 1, leadTexts: 1, partnerEmails: 1 });
    const mails = calls.filter((c) => c.url.includes('resend')).map((c) => JSON.parse(c.body) as { to: string[]; subject: string; from: string; reply_to: string; text: string; headers?: Record<string, string> });
    const texts = calls.filter((c) => c.url.includes('twilio')).map((c) => new URLSearchParams(c.body));
    const partnerEmailAddress = (await partner(pid))!.email;
    expect(mails.map((m) => m.to[0]).sort()).toEqual([email, partnerEmailAddress].sort());
    for (const m of mails) { expect(m.reply_to).toBe(REPLY); expect(m.from).toContain(`"${a.name}"`); expect(m.text).toContain(`${a.name} · ${ADDRESS}`); expect(m.text).toMatch(/\/unsubscribe\//); }
    // The partner email is handed to the email service with the one-click unsubscribe headers; the lead email has its own link.
    const toPartner = mails.find((m) => m.to[0] === (partnerEmailAddress))!;
    expect(toPartner.headers).toEqual({ 'List-Unsubscribe': `<http://localhost:3000/api/unsubscribe/partner/${partnerOptOutToken(pid)}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' });
    expect(texts).toHaveLength(1);
    expect(texts[0]!.get('To')).toBe(number);
    expect(texts[0]!.get('Body')).toBe(leadText('text_welcome', 'en', { orgName: a.name }));
    // The only number ever texted is the lead's who agreed; the partner's phone number went nowhere.
    expect(calls.some((c) => c.body.includes('5550199'))).toBe(false);
    expect(await steps(pid)).toMatchObject([{ step: 'intro', status: 'sent' }]);

    // Running again, as a scheduler does, sends nothing twice. The job ran on the clock `when` while the database
    // stamped the sends with the real time; put both on one clock, as they are in production, so this does not
    // depend on how many days away the next business day happens to be.
    await withSystem((db) => db.run('update public.lead_outreach set sent_at = $2 where org_id = $1 and sent_at is not null', [a.orgId, when]));
    const second = await runScheduledJobs({ onlyOrgIds: [a.orgId], now: when });
    expect(second).toMatchObject({ failures: 0, leadEmails: 0, leadTexts: 0, partnerEmails: 0 });
    expect(calls).toHaveLength(3);
    // The same switches in a workspace the operator has not approved: nothing leaves, not the lead email either. The
    // form is public and takes any address, so the name of a workspace nobody has looked at reaches no inbox.
    const b = await agency('JobsNotApproved', { ...ON, lead_followup_enabled: true, lead_followup_since: new Date(Date.now() - 60_000).toISOString(), lead_text_followup: true }, false);
    await add(b, [P()]);
    const email2 = `lead-${uniq()}@example.test`;
    expect(await submitLead(b.slug, { fullName: 'Pat Lead', email: email2, phone: `+1512${2 + Math.floor(Math.random() * 7)}55${String(Math.floor(Math.random() * 10_000)).padStart(4, '0')}`, language: 'en', consent: true, smsConsent: true }, { ip: testIp(), defer: () => undefined })).toEqual({ ok: true });
    expect(await runScheduledJobs({ onlyOrgIds: [b.orgId], now: when })).toMatchObject({ failures: 0, leadEmails: 0, leadTexts: 0, partnerEmails: 0 });
    expect(calls).toHaveLength(3);
    expect(calls.some((c) => c.body.includes(email2))).toBe(false);
    expect(await count('select count(*)::int as n from public.sms_consents where org_id = $1', [b.orgId])).toBe(0); // the box was never offered, so no consent was recorded
  });
});
