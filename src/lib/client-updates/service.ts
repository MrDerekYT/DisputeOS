import { audit } from '../audit';
import { findBlockedClaims } from '../compliance/claims';
import { withSystem, type Db } from '../db';
import { getEnv } from '../env';
import { emailIsLive } from '../lead-outreach';
import { sendEmail, type Email, type SendResult } from '../mailer';
import { portalLoginPath } from '../org-brand';
import { APPROVAL_COLS, outreachApproved, type ApprovalRow } from '../outreach-approval';
import { fill, tr } from '../portal-i18n';
import { noResponseAfter, toDay } from '../disputes/clock';
import { dayInZone } from '../util';
import { classifyInbound, sendSms, smsUsable, toE164, toUsE164, type InboundKind, type Sms, type SmsResult } from '../sms';
import {
  anyChannelOn, DAILY_CAP, emailText, inQuietHoursAnywhere, MAX_QUEUE_AGE_HOURS, orgTimezone, quietZones, SMS_MAX_CHARS, smsText, TEXT_NOT_APPROVED, TEXT_NOT_US_NUMBER, updateSettings,
  type UpdateChannel, type UpdateEvent, type UpdateLang,
} from './templates';

// ================================================================ channels
/** Can an email be attempted here? Connected (Resend), or the development log stand-in. Never when email is disabled. */
export const emailUsable = () => emailIsLive() || getEnv().EMAIL_DRIVER === 'log';
export const channelUsable = (ch: UpdateChannel) => (ch === 'sms' ? smsUsable() : emailUsable());

// ================================================================ SMS consent (TCPA)
export interface SmsConsentRow {
  /** 'enquiry_form': the person ticked the separate text-message box on the public enquiry form (src/lib/lead-outreach.ts). */
  id: string; phone: string; language: UpdateLang; consent_text: string; source: 'portal' | 'staff' | 'enquiry_form'; note: string | null;
  /** 'asked_to_stop': the person told the team to stop and a staff member recorded it; like a STOP reply, only they can undo it. */
  granted_at: string; revoked_at: string | null; revoked_via: 'portal' | 'staff' | 'sms_stop' | 'asked_to_stop' | null;
}
const CONSENT_COLS = 'id, phone, language, consent_text, source, note, granted_at, revoked_at, revoked_via';

/** Newest first. The first row without revoked_at, if any, is the consent in force. */
export const smsConsentHistory = (db: Db, clientId: string) =>
  db.rows<SmsConsentRow>(`select ${CONSENT_COLS} from public.sms_consents where client_id = $1 order by granted_at desc limit 20`, [clientId]);

/** The exact wording a client agrees to, in their language, naming the business and the number. Stored with the record. */
export function smsConsentText(lang: UpdateLang, orgName: string, phone: string): string {
  return fill(tr(lang)('sms_consent'), { org: orgName.replace(/\s+/g, ' ').trim(), phone });
}

export type ConsentOutcome = { ok: true; phone: string } | { ok: false; reason: 'no_phone' | 'not_found' | 'stopped' };
export const SMS_STOPPED_MESSAGE = 'The client replied STOP by text, or asked the team to stop. Only they can turn texts back on, in their portal profile.';

/**
 * Records that a client agreed to texts at the number on their record. Runs inside the caller's transaction, so
 * row-level security decides who may write what: a portal user only their own, labelled 'portal'; staff only for their
 * organization, labelled 'staff', and the table refuses a staff record without a note. A consent already in force for
 * another number is revoked first; one for the same number is left as it is. The timeline entry is written by a
 * database trigger (app.on_sms_consent), because a portal user may not write timeline rows.
 *
 * Only a US mobile number can be agreed for (a state, DC or Puerto Rico area code; toUsE164 in ../sms.ts), because a
 * text is only ever sent to one. A record whose number is in another country, is a premium or toll-free number, or
 * cannot exist gets { ok: false, reason: 'no_phone' }, whoever asks.
 *
 * A reply of STOP can only be undone by the person who sent it, and so can a request to stop that the team recorded
 * ('asked_to_stop'). When the client's last consent ended either way, or
 * the number has sent STOP since its owner last agreed in the portal, a staff-recorded consent is refused
 * ({ ok: false, reason: 'stopped' }); the database refuses it too (trigger sms_consents_stop_guard, 0018). 47 U.S.C.
 * § 227 and 47 CFR § 64.1200(a)(10): a revocation has to be honoured, and it is the called party's to withdraw.
 */
export async function grantSmsConsent(db: Db, a: {
  orgId: string; clientId: string; userId: string; source: 'portal' | 'staff'; note?: string | null; ip?: string | null; userAgent?: string | null;
}): Promise<ConsentOutcome> {
  const c = await db.row<{ phone: string | null; preferred_language: string; org_name: string }>(
    'select c.phone, c.preferred_language, o.name as org_name from public.clients c join public.organizations o on o.id = c.org_id where c.id = $1 and c.org_id = $2 for update of c', [a.clientId, a.orgId]);
  if (!c) return { ok: false, reason: 'not_found' };
  const phone = toUsE164(c.phone);
  if (!phone) return { ok: false, reason: 'no_phone' };
  const lang: UpdateLang = c.preferred_language === 'es' ? 'es' : 'en';
  const current = await db.row<{ id: string; phone: string }>('select id, phone from public.sms_consents where client_id = $1 and revoked_at is null', [a.clientId]);
  if (current?.phone === phone) return { ok: true, phone };
  if (a.source === 'staff' && (await db.row<{ blocked: boolean }>('select app.sms_stop_blocks_staff($1, $2) as blocked', [a.clientId, phone]))?.blocked) return { ok: false, reason: 'stopped' };
  if (current) await db.run('update public.sms_consents set revoked_at = now(), revoked_via = $2 where id = $1 and revoked_at is null', [current.id, a.source]);
  await db.run(
    `insert into public.sms_consents (org_id, client_id, phone, language, consent_text, source, note, recorded_by, ip, user_agent)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [a.orgId, a.clientId, phone, lang, smsConsentText(lang, c.org_name, phone), a.source, a.note?.trim().slice(0, 500) || null, a.userId, a.ip ?? null, a.userAgent?.slice(0, 300) ?? null]);
  await audit(db, { orgId: a.orgId, actorId: a.userId, action: 'sms_consent.granted', entityType: 'client', entityId: a.clientId, ip: a.ip, meta: { source: a.source } });
  return { ok: true, phone };
}

/** Withdraws the consent in force, if any. Texts stop at once: the send re-checks consent under a lock. */
export async function revokeSmsConsent(db: Db, a: { orgId: string; clientId: string; userId: string; via: 'portal' | 'staff' | 'sms_stop' | 'asked_to_stop'; ip?: string | null }): Promise<boolean> {
  const n = await db.run('update public.sms_consents set revoked_at = now(), revoked_via = $2 where client_id = $1 and org_id = $3 and revoked_at is null', [a.clientId, a.via, a.orgId]);
  if (!n) return false;
  await audit(db, { orgId: a.orgId, actorId: a.userId, action: 'sms_consent.revoked', entityType: 'client', entityId: a.clientId, ip: a.ip, meta: { via: a.via } });
  return true;
}

// ================================================================ queueing (inside the transaction that caused it)
/**
 * Hands the delivery to Next's `after`, which runs it once the response is finished and so after the transaction that
 * queued the rows has committed. Outside a request (tests, the jobs script) there is nothing to hand it to; the rows
 * stay queued and the scheduled job sends them.
 */
async function deliverAfterResponse(orgId: string): Promise<void> {
  try {
    const { after } = await import('next/server');
    after(() => deliverClientUpdates(orgId).then(() => undefined, (e) => console.error('[client-updates] delivery failed', (e as Error).message)));
  } catch {
    /* not in a request: the scheduled job delivers */
  }
}

/** A subject that groups events so a client is told once per period: a day for document requests, an hour for messages. */
export const dayBucket = (now = new Date()) => now.toISOString().slice(0, 10);
export const hourBucket = (now = new Date()) => now.toISOString().slice(0, 13);

/**
 * Call inside the transaction that records the event. Adds one 'queued' row per channel the agency switched on for
 * this event — and only when that channel could actually reach this client: the channel is connected, the client has a
 * portal sign-in (every message says "sign in"), for email an address, and for a text a consent in force for the
 * number on their record. No consent, no row, no text.
 *
 * A text needs two more things, which an email does not. The platform operator has approved the workspace under the
 * name it has now (../outreach-approval.ts): sign-up is open and every text leaves through the deployment's one
 * number, so a workspace nobody has looked at texts no one. And the number is a US one. Both are read again when the
 * text is sent (deliverClientUpdates).
 *
 * It can never break the caller: it runs inside a savepoint, so an error here is rolled back on its own and the
 * dispute, request or message that triggered it is saved regardless. The unique key (client, event, subject, channel)
 * makes a repeated or concurrent trigger a no-op. Returns how many rows were added.
 */
export async function queueClientUpdate(db: Db, a: { orgId: string; clientId: string; event: UpdateEvent; subjectId: string; defer?: boolean }): Promise<number> {
  let added = 0;
  await db.run('savepoint client_update');
  try {
    const org = await db.row<ApprovalRow & { settings: Record<string, unknown> }>(`select ${APPROVAL_COLS}, settings from public.organizations where id = $1 and status = 'active'`, [a.orgId]);
    const on = org ? updateSettings(org.settings).switches[a.event] : null;
    const channels = (['sms', 'email'] as UpdateChannel[]).filter((ch) => on?.[ch] && channelUsable(ch) && (ch === 'email' || outreachApproved(org)));
    if (channels.length) {
      const c = await db.row<{ email: string | null; phone: string | null; portal_user_id: string | null; consent_phone: string | null }>(
        `select c.email, c.phone, c.portal_user_id,
                (select s.phone from public.sms_consents s where s.client_id = c.id and s.revoked_at is null) as consent_phone
           from public.clients c where c.id = $1 and c.org_id = $2`, [a.clientId, a.orgId]);
      for (const ch of channels) {
        if (!c?.portal_user_id) continue;
        if (ch === 'email' && !c.email) continue;
        if (ch === 'sms' && (!c.consent_phone || toUsE164(c.phone) !== c.consent_phone)) continue;
        added += await db.run(
          `insert into public.client_updates (org_id, client_id, event, subject_id, channel) values ($1, $2, $3, $4, $5)
           on conflict (client_id, event, subject_id, channel) do nothing`, [a.orgId, a.clientId, a.event, a.subjectId.slice(0, 80), ch]);
      }
    }
    await db.run('release savepoint client_update');
  } catch (e) {
    await db.run('rollback to savepoint client_update').catch(() => undefined);
    console.error('[client-updates] could not queue', a.event, (e as Error).message);
    return 0;
  }
  if (added && a.defer !== false) await deliverAfterResponse(a.orgId);
  return added;
}

// ================================================================ delivery (after commit, or from the scheduled job)
export interface DeliveryResult {
  sent: number; failed: number; skipped: number; waiting: number;
  /** 'time': the scheduled job's deadline passed while messages were still queued. They stay queued for a later run. */
  held?: 'time';
}
export interface DeliveryOptions {
  now?: Date;
  /** The scheduled job's own deadline (epoch ms): nothing new is claimed after it, so a send in flight can still finish. */
  stopAt?: number;
  /** Tests only: stand-ins for the providers. */
  sms?: (m: Sms) => Promise<SmsResult>;
  email?: (m: Email) => Promise<SendResult>;
}
interface Queued {
  id: string; client_id: string; event: UpdateEvent; subject_id: string; channel: UpdateChannel; created_at: string;
}
const MAX_PER_RUN = 100;

/**
 * Sends what is queued for one organization. Safe to run twice or at the same moment from two places:
 *  1. each row is claimed ('queued' -> 'sending') in its own short transaction, with the client row locked, and every
 *     stop condition is checked again there: the switch, the consent and its number, the daily limit, and for a text
 *     the operator's approval of the workspace under the name it has at that moment (the name the text then carries)
 *     and that the number is a US one;
 *  2. the message goes to the provider outside any transaction;
 *  3. the outcome is recorded on the row and as a communication on the client (sent or failed, with the provider id).
 * A row whose outcome was never recorded stays 'sending' and is not sent again: at worst one message is lost, never doubled.
 * Texts wait through quiet hours; everything that cannot or should not be sent is marked skipped with the reason.
 * With `stopAt` (the scheduled job's deadline) nothing is claimed once it has passed: what is left stays queued.
 */
export async function deliverClientUpdates(orgId: string, opts: DeliveryOptions = {}): Promise<DeliveryResult> {
  const now = opts.now ?? new Date();
  const out: DeliveryResult = { sent: 0, failed: 0, skipped: 0, waiting: 0 };
  const org = await withSystem((db) => db.row<{ name: string; slug: string; settings: Record<string, unknown> }>(
    "select name, slug, settings from public.organizations where id = $1 and status = 'active'", [orgId]));
  if (!org) return out;
  const queued = await withSystem((db) => db.rows<Queued>(
    "select id, client_id, event, subject_id, channel, created_at from public.client_updates where org_id = $1 and status = 'queued' order by created_at limit $2", [orgId, MAX_PER_RUN]));
  if (!queued.length) return out;
  const env = getEnv();
  const orgTz = orgTimezone(org.settings, env.APP_TIMEZONE);
  const portalUrl = `${env.APP_URL.replace(/\/+$/, '')}${portalLoginPath(org.slug)}`;
  const skip = async (id: string, why: string) => {
    out.skipped += await withSystem((db) => db.run("update public.client_updates set status = 'skipped', error = $2 where id = $1 and status = 'queued'", [id, why]));
  };

  for (const q of queued) {
    if (opts.stopAt != null && Date.now() > opts.stopAt) { out.held = 'time'; break; }
    if (now.getTime() - new Date(q.created_at).getTime() > MAX_QUEUE_AGE_HOURS * 3_600_000) { await skip(q.id, 'Too old to send'); continue; }
    if (!channelUsable(q.channel)) { await skip(q.id, q.channel === 'sms' ? 'Text messaging is not connected' : 'Email is not connected'); continue; }

    // 1. Claim, under a lock on the client, re-checking everything that could have changed since it was queued.
    const claim = await withSystem(async (db) => {
      const c = await db.row<{ full_name: string; email: string | null; phone: string | null; preferred_language: string; portal_user_id: string | null; state: string | null }>(
        "select full_name, email, phone, preferred_language, portal_user_id, address->>'state' as state from public.clients where id = $1 and org_id = $2 for update", [q.client_id, orgId]);
      const stop = async (why: string) => { await db.run("update public.client_updates set status = 'skipped', error = $2 where id = $1 and status = 'queued'", [q.id, why]); return { skipped: true as const }; };
      if (!c) return stop('Client not found');
      const fresh = await db.row<ApprovalRow & { settings: Record<string, unknown> }>(`select ${APPROVAL_COLS}, settings from public.organizations where id = $1`, [orgId]);
      if (!fresh || !updateSettings(fresh.settings).switches[q.event][q.channel]) return stop('Switched off before it was sent');
      if (!c.portal_user_id) return stop('The client has no portal sign-in');
      let to = '';
      if (q.channel === 'sms') {
        // No text leaves for a workspace the platform operator has not approved under the name it has now. Read here,
        // when the text is about to go: an approval withdrawn, or a rename, since the text was queued stops it.
        if (!outreachApproved(fresh)) return stop(TEXT_NOT_APPROVED);
        // TCPA: a text goes only to the number the client consented for, and only while that consent stands.
        const consent = await db.row<{ phone: string }>('select phone from public.sms_consents where client_id = $1 and revoked_at is null', [q.client_id]);
        if (!consent) return stop('No consent to text messages');
        if (toE164(c.phone) !== consent.phone) return stop('The phone number changed since consent was given');
        // Texts go to US numbers only, whatever the consent on file says (one may have been recorded before this rule).
        if (!toUsE164(consent.phone)) return stop(TEXT_NOT_US_NUMBER);
        // Quiet hours where the client is (their state, with the workspace's zone), not where the server is. See quietZones.
        if (inQuietHoursAnywhere(now, quietZones(orgTz, c.state))) return { waiting: true as const };
        // A free-text reply nobody has read yet may be the client asking to stop (47 CFR § 64.1200(a)(10): any
        // reasonable manner). Nothing more is texted until a staff member has read it and said which it is.
        if (await db.row("select 1 from public.sms_inbound where client_id = $1 and kind = 'message' and reviewed_at is null limit 1", [q.client_id])) return { waiting: true as const };
        to = consent.phone;
      } else {
        if (!c.email) return stop('The client has no email address');
        to = c.email;
      }
      const recent = await db.row<{ n: number }>(
        "select count(*)::int as n from public.client_updates where client_id = $1 and channel = $2 and status in ('sending', 'sent') and sent_at > $3::timestamptz - interval '24 hours'", [q.client_id, q.channel, now]);
      if ((recent?.n ?? 0) >= DAILY_CAP[q.channel]) return stop('Daily limit for this client reached');
      const got = await db.run("update public.client_updates set status = 'sending', sent_at = $2 where id = $1 and status = 'queued'", [q.id, now]);
      return got ? { to, client: c, orgName: fresh.name } : null;
    });
    if (!claim) continue; // someone else claimed it
    if ('waiting' in claim) { out.waiting++; continue; }
    if ('skipped' in claim) { out.skipped++; continue; }

    // 2. Build and send, outside any transaction.
    const lang: UpdateLang = claim.client.preferred_language === 'es' ? 'es' : 'en';
    let subject: string | null = null;
    let body = '';
    let res: { ok: boolean; provider: string; providerRef?: string; error?: string; unconfirmed?: boolean };
    try {
      if (q.channel === 'sms') {
        // The name read with the approval, in the claim: the text carries the name that was approved.
        body = smsText(q.event, lang, { orgName: claim.orgName, portalUrl });
      } else {
        const m = emailText(q.event, lang, { orgName: org.name, portalUrl, firstName: claim.client.full_name });
        subject = m.subject; body = m.text;
      }
      // Generated text is held to the claims guard. The business name is part of it, so a name that makes a promise blocks the send.
      const issues = findBlockedClaims(`${subject ?? ''}\n${body}`);
      if (issues.length) res = { ok: false, provider: 'none', error: `Not sent: the message would contain a claim that is not allowed (${issues[0]!.why})` };
      else if (q.channel === 'sms' && body.length > SMS_MAX_CHARS) res = { ok: false, provider: 'none', error: 'Not sent: the text would be too long' };
      else if (q.channel === 'sms') res = await (opts.sms ?? sendSms)({ to: claim.to, body });
      else res = await (opts.email ?? sendEmail)({ to: claim.to, subject: subject!, text: body, fromName: org.name, ...(typeof org.settings.lead_reply_email === 'string' && org.settings.lead_reply_email ? { replyTo: org.settings.lead_reply_email } : {}) });
    } catch (e) {
      res = { ok: false, provider: 'none', error: String((e as Error).message ?? e) };
    }

    // 3. Record. The development `log` driver delivers nothing, so its communication is saved as 'queued', which the
    //    Messages tab shows as "Not delivered" (the same convention as an email written to the log). An email the
    //    service never answered for stays 'failed' (it is not sent again either way), with the reason saying what is known.
    const status = res.ok ? 'sent' : 'failed';
    const commStatus = !res.ok ? 'failed' : res.provider === 'log' ? 'queued' : 'sent';
    const error = res.ok ? null : res.unconfirmed ? 'The email service did not answer; it may or may not have arrived.' : (res.error ?? 'The provider refused the message').slice(0, 500);
    await withSystem(async (db) => {
      const comm = await db.row<{ id: string }>(
        `insert into public.communications (org_id, client_id, direction, channel, subject, body, status, provider_ref)
         values ($1, $2, 'outbound', $3, $4, $5, $6, $7) returning id`, [orgId, q.client_id, q.channel, subject, body || '(not built)', commStatus, res.providerRef ?? null]);
      await db.run('update public.client_updates set status = $2, provider = $3, provider_ref = $4, error = $5, communication_id = $6 where id = $1',
        [q.id, status, res.provider, res.providerRef ?? null, error, comm!.id]);
    });
    if (res.ok) out.sent++; else out.failed++;
  }
  return out;
}

// ================================================================ scheduled work
/**
 * Queues "no response recorded" for disputes with no response well after the investigation period ended.
 * `due_at` was set when the dispute was recorded as sent (responseDueDate in src/lib/disputes/workflow.ts — FCRA
 * § 611(a)(1), 15 U.S.C. § 1681i(a)(1): generally 30 days from receipt, 45 in some cases). The client is not told the
 * day after that: the agency generally has 5 business days after completing its reinvestigation to send written
 * results (§ 1681i(a)(6)(A)) and the mail takes time, so the announcement waits for noResponseAfter() in
 * src/lib/disputes/clock.ts (period end + 5 business days + 7 days). Only disputes that reached that day in the last
 * 7 days, and whose period ended after the agency switched this event on, are announced.
 */
export async function queueOverdueWindows(orgId: string, now = new Date()): Promise<number> {
  return withSystem(async (db) => {
    const org = await db.row<{ settings: Record<string, unknown> }>("select settings from public.organizations where id = $1 and status = 'active'", [orgId]);
    const s = updateSettings(org?.settings);
    if (!org || !anyChannelOn(s, 'window_passed') || !s.windowSince) return 0;
    const tz = getEnv().APP_TIMEZONE;
    const today = dayInZone(tz, now);
    const weekAgo = dayInZone(tz, new Date(now.getTime() - 7 * 86_400_000));
    // The allowance is at least 12 and at most about 19 calendar days (5 business days with weekends and holidays, plus 7); the exact day is worked out per dispute below.
    const candidates = await db.rows<{ id: string; client_id: string; due_at: string }>(
      `select id, client_id, due_at from public.disputes
        where org_id = $1 and status in ('submitted', 'under_investigation') and response_at is null
          and due_at < $2::timestamptz - interval '11 days' and due_at > $2::timestamptz - interval '30 days' and due_at > $3::timestamptz
        order by due_at limit 500`, [orgId, now, s.windowSince]);
    const due = candidates.filter((d) => { const from = noResponseAfter(toDay(d.due_at, tz)); return from < today && from >= weekAgo; });
    let n = 0;
    for (const d of due) n += await queueClientUpdate(db, { orgId, clientId: d.client_id, event: 'window_passed', subjectId: d.id, defer: false });
    return n;
  });
}

/** What the scheduled job runs for each organization: queue ended windows, then send whatever is due. */
export async function runClientUpdateJobs(orgId: string, opts: DeliveryOptions = {}): Promise<DeliveryResult> {
  await queueOverdueWindows(orgId, opts.now);
  return deliverClientUpdates(orgId, opts);
}

// ================================================================ inbound (the provider's webhook)
export interface InboundResult { kind: InboundKind | 'status' | 'duplicate' | 'ignored'; matched: number }

/**
 * A delivery report for a text we sent (Twilio's StatusCallback). `delivered` upgrades the communication; `failed`
 * or `undelivered` marks it and its queue row failed with the provider's error code, so the failure is shown. A lead
 * follow-up text the carrier did not deliver is marked failed on the lead's follow-up log too, which stops the texts to
 * that number: a failed step is never followed by another one (decideLeadText).
 */
export async function recordSmsStatus(sid: string, status: string, errorCode?: string | null): Promise<InboundResult> {
  const st = status.toLowerCase();
  if (!sid || !['delivered', 'failed', 'undelivered'].includes(st)) return { kind: 'ignored', matched: 0 };
  const n = await withSystem(async (db) => {
    if (st === 'delivered') return db.run("update public.communications set status = 'delivered' where provider_ref = $1 and channel = 'sms' and direction = 'outbound' and status = 'sent'", [sid]);
    const why = `The carrier did not deliver it${errorCode ? ` (Twilio error ${String(errorCode).slice(0, 12)})` : ''}`;
    await db.run("update public.client_updates set status = 'failed', error = $2 where provider_ref = $1 and channel = 'sms' and status = 'sent'", [sid, why]);
    await db.run(
      `update public.lead_outreach set status = 'failed', error = $2
        where status = 'sent' and communication_id in (select id from public.communications where provider_ref = $1 and channel = 'sms' and direction = 'outbound')`, [sid, why]);
    return db.run("update public.communications set status = 'failed' where provider_ref = $1 and channel = 'sms' and direction = 'outbound' and status in ('sent', 'delivered')", [sid]);
  });
  return { kind: 'status', matched: n };
}

/**
 * A text someone sent to our number. Stored once (the provider's message id is unique, so a retried webhook is a no-op).
 *
 * Whose is it? The deployment has one sending number (or one Messaging Service) shared by its workspaces, so the
 * receiving number does not identify a workspace. The sender is matched by phone number against client records:
 *  - STOP (or any stop word): consent is revoked for EVERY client record with that number, in every workspace. The
 *    person told this number to stop, so nobody here may text them again until they consent afresh.
 *  - START: nothing is switched back on. It is noted on the client's timeline that they must turn texts on again in
 *    the portal; a keyword is not treated as new consent.
 *  - Anything else: saved as an inbound message on the client when exactly one client has that number. When several
 *    do (the same person in two workspaces, or one workspace typing another's client's number), it goes to the one
 *    whose consent is in force for exactly this number; if that is still more than one, to the one this deployment
 *    texted most recently, whatever the text was (a client update or a follow-up to their enquiry). A record that
 *    merely carries the number, or once had a consent, cannot pull the message away from the client who is actually
 *    being texted. When even that does not decide it (two records were texted at the same time, or neither text was
 *    recorded), the reply is filed on EVERY record that holds a consent in force for the number: a reply nobody can
 *    see would leave the follow-up running. Records of one workspace get the message itself. Records of different
 *    workspaces get a note that a reply arrived (SHARED_REPLY_NOTE) and not its wording: the person wrote to one
 *    business, and what they wrote is not shown to another. The message itself is then kept with no workspace, for
 *    the operator. Only when no record holds a consent is nothing filed, never guessed: the message is then kept with
 *    no workspace as well, even when every record that carries the number belongs to one workspace. Rows with no
 *    workspace are counted in the scheduled job's result (unmatchedInboundCount) so they are not lost.
 *    A matched free-text reply stays unreviewed: texts to that client pause until staff have read it (it may be a
 *    request to stop in the client's own words).
 * Every record that carries the number is looked at, however many there are: a workspace cannot push the record that
 * is being texted out of the list by typing the number onto records of its own.
 */
/** What each workspace sees when a free-text reply could not be told apart between records of different workspaces. */
export const SHARED_REPLY_NOTE = 'A reply arrived by text from this number. The number is also on file with another business that uses this service, and it could not be told which one the reply was for, so its wording is not shown here. Texts to this number are paused. Call or email the person to ask what they need.';

export async function recordInboundSms(m: { sid: string; from: string; to?: string | null; body: string; optOutType?: string | null }): Promise<InboundResult> {
  const from = toE164(m.from);
  const kind = classifyInbound(m.body, m.optOutType);
  const body = m.body.slice(0, 1600);
  return withSystem(async (db) => {
    const row = await db.row<{ id: string }>(
      `insert into public.sms_inbound (provider_ref, from_phone, to_phone, kind, body) values ($1, $2, $3, $4, $5)
       on conflict (provider_ref) do nothing returning id`, [m.sid.slice(0, 64), (from ?? m.from).slice(0, 30), m.to?.slice(0, 40) ?? null, kind, body]);
    if (!row) return { kind: 'duplicate' as const, matched: 0 };

    // Every record that carries the number and every consent in force for it, with no upper limit: a limit lets another
    // workspace push the record that is really being texted out of the list by typing the number onto records of its own.
    const digits = (from ?? '').replace(/\D/g, '');
    const found = from ? await db.rows<{ id: string; org_id: string; phone: string }>(
      `select c.id, c.org_id, c.phone
         from public.clients c join public.organizations o on o.id = c.org_id and o.status = 'active'
        where c.phone is not null and right(regexp_replace(c.phone, '\\D', '', 'g'), 10) = $1`, [digits.slice(-10)]) : [];
    // People whose record shows this number today, plus anyone whose consent in force was given for it.
    const byConsent = from ? await db.rows<{ id: string; org_id: string }>(
      'select s.client_id as id, s.org_id from public.sms_consents s where s.phone = $1 and s.revoked_at is null', [from]) : [];
    const candidates = found.filter((c) => toE164(c.phone) === from);

    if (kind === 'stop') {
      // Three statements, however many records there are, so a number typed onto hundreds of records cannot slow a STOP down.
      const ids = [...new Set([...candidates, ...byConsent].map((c) => c.id))];
      const revoked = await db.rows<{ client_id: string; org_id: string }>(
        "update public.sms_consents set revoked_at = now(), revoked_via = 'sms_stop' where client_id = any($1::uuid[]) and revoked_at is null returning client_id, org_id", [ids]);
      await db.run("update public.client_updates set status = 'skipped', error = 'The client replied STOP' where client_id = any($1::uuid[]) and channel = 'sms' and status = 'queued'", [ids]);
      // One audit entry per consent that ended (the same row audit() writes, for all of them at once).
      await db.run(
        `insert into public.audit_logs (org_id, actor_label, action, entity_type, entity_id, metadata)
         select r.org_id, 'Text message reply', 'sms_consent.revoked', 'client', r.client_id, '{"via": "sms_stop"}'::jsonb
           from unnest($1::uuid[], $2::uuid[]) as r(client_id, org_id)`, [revoked.map((r) => r.client_id), revoked.map((r) => r.org_id)]);
    }

    // Read before the STOP above revoked anything, so a STOP is still filed with the client it came from.
    const inForce = new Set(byConsent.map((c) => c.id));
    let targets = candidates;
    if (candidates.length > 1) {
      const consenting = candidates.filter((c) => inForce.has(c.id));
      const pool = consenting.length ? consenting : candidates;
      if (pool.length > 1) {
        // Whoever this deployment texted last: every text it sends, update or lead follow-up, is a message on the record.
        const texted = await db.rows<{ client_id: string; last: string }>(
          `select client_id, max(created_at) as last from public.communications
            where client_id = any($1::uuid[]) and channel = 'sms' and direction = 'outbound' and status <> 'failed' group by client_id order by last desc limit 2`,
          [pool.map((c) => c.id)]);
        const latest = texted[0] && (!texted[1] || new Date(texted[0].last).getTime() > new Date(texted[1].last).getTime()) ? pool.filter((c) => c.id === texted[0]!.client_id) : [];
        // Still undecided: everyone who holds a consent for this number gets the reply; with no consent, nobody is guessed at.
        targets = latest.length === 1 ? latest : consenting;
      } else targets = pool;
    }
    // A free-text reply that could belong to records of more than one workspace: each is told a reply arrived, none is
    // shown its wording, and the message itself stays with no workspace (the row the provider's id is on).
    const shared = kind === 'message' && new Set(targets.map((t) => t.org_id)).size > 1;
    const first = shared ? null : targets[0] ?? null;
    const shown = shared ? SHARED_REPLY_NOTE : body;
    // A keyword reply needs no reading. A free-text one stays unreviewed until a person has read it. With no record
    // chosen the message belongs to no workspace, also when every record that carries the number is in one workspace:
    // carrying a number is not a reason to be shown what its owner wrote.
    await db.run('update public.sms_inbound set org_id = $2, client_id = $3, reviewed_at = case when $3::uuid is null or $4 then null else now() end where id = $1',
      [row.id, first?.org_id ?? null, first?.id ?? null, kind === 'message']);
    for (const [i, t] of targets.entries()) {
      // Filed on more than one record: each gets its own row to review (the first keeps the provider's id, which is what makes a retried webhook a no-op).
      if (i > 0 || shared) {
        await db.run(
          `insert into public.sms_inbound (provider_ref, org_id, client_id, from_phone, to_phone, kind, body, reviewed_at) values ($1, $2, $3, $4, $5, $6, $7, case when $8 then null else now() end)
           on conflict (provider_ref) do nothing`, [`${m.sid.slice(0, 64)}:${i + 1}`, t.org_id, t.id, (from ?? m.from).slice(0, 30), m.to?.slice(0, 40) ?? null, kind, shown, kind === 'message']);
      }
      await db.run(
        "insert into public.communications (org_id, client_id, direction, channel, body, status, provider_ref) values ($1, $2, 'inbound', 'sms', $3, 'received', $4)",
        [t.org_id, t.id, shown.trim() || '(empty message)', m.sid.slice(0, 64)]);
      if (kind === 'start') {
        await db.run("insert into public.client_events (org_id, client_id, kind, summary) values ($1, $2, 'sms_consent', 'Client replied START by text. Texts stay off until they turn them on again in the portal.')", [t.org_id, t.id]);
      }
    }
    return { kind, matched: targets.length };
  });
}

/** Inbound texts from the last 30 days that belong to no workspace and that nobody has reviewed. No tenant screen can show them, so the scheduled job reports the count. */
export const unmatchedInboundCount = () => withSystem(async (db) =>
  (await db.row<{ n: number }>("select count(*)::int as n from public.sms_inbound where org_id is null and reviewed_at is null and kind = 'message' and created_at > now() - interval '30 days'"))?.n ?? 0);

// ================================================================ replies waiting to be read (staff, client profile)
export interface PendingReply { id: string; body: string; created_at: string }
/** Free-text replies from this client that nobody has read. While there is one, no text is sent to them. */
export const pendingSmsReplies = (db: Db, clientId: string) =>
  db.rows<PendingReply>("select id, body, created_at from public.sms_inbound where client_id = $1 and kind = 'message' and reviewed_at is null order by created_at desc limit 5", [clientId]);

/**
 * A staff member has read the client's replies. `asksToStop` = they read as a request to stop: consent is revoked as
 * a STOP (so only the client can turn texts back on) and anything queued is dropped. Otherwise texts resume.
 */
export async function reviewSmsReplies(db: Db, a: { orgId: string; clientId: string; userId: string; asksToStop: boolean; ip?: string | null }): Promise<void> {
  const n = await db.run("update public.sms_inbound set reviewed_at = now() where client_id = $1 and org_id = $2 and kind = 'message' and reviewed_at is null", [a.clientId, a.orgId]);
  if (a.asksToStop) await revokeSmsConsent(db, { orgId: a.orgId, clientId: a.clientId, userId: a.userId, via: 'sms_stop', ip: a.ip });
  if (n) await audit(db, { orgId: a.orgId, actorId: a.userId, action: 'sms_reply.reviewed', entityType: 'client', entityId: a.clientId, ip: a.ip, meta: { asks_to_stop: a.asksToStop } });
}
