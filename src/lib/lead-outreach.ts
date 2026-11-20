import { createHmac } from 'node:crypto';
import { audit } from './audit';
import { inQuietHoursAnywhere, leadQuietZones, MARKETING_WINDOW, orgTimezone, SMS_MAX_CHARS } from './client-updates/templates';
import { assertNoBlockedClaims, findBlockedClaims } from './compliance/claims';
import { safeEqual } from './crypto';
import { withSystem, type Db } from './db';
import { getEnv } from './env';
import { decideLeadStep, leadEmail, LEAD_MAX_ATTEMPTS, LEAD_STEPS, LEAD_WINDOW_DAYS, type LeadOutreachState, type LeadStep } from './lead-emails';
import { decideLeadText, ENQUIRY_FORM_CONSENT, LEAD_TEXT_DAILY_CAP, LEAD_TEXT_STEPS, leadSmsConsentText, leadText, linkInName, type LeadTextState } from './lead-texts';
import { sendEmail, type Email, type SendResult } from './mailer';
import { usableMailingAddress } from './mailing-address';
import { APPROVAL_COLS, outreachApproved, type ApprovalRow } from './outreach-approval';
import { sendSms, smsUsable, toE164, toUsE164, type Sms, type SmsResult } from './sms';
import { usAreaCodeState } from './us-phone';
import { isUuid } from './util';

/**
 * Agency-level switch and the details every automatic lead email needs. Stored in organizations.settings.
 * `texts` is the separate switch for text follow-up: off by default, and it only ever reaches leads who ticked the
 * text-message box on the enquiry form.
 * `address` is the saved mailing address only when it has the shape of a postal address (./mailing-address.ts). A
 * saved value that is a sentence or carries a link reads as no address, so nothing that prints it is sent: the lead
 * follow-up emails here and the partner emails (src/lib/partner-outreach.ts reads the same settings).
 */
export interface OutreachSettings { enabled: boolean; since: string | null; address: string; replyTo: string; texts: boolean }
export function outreachSettings(settings: Record<string, unknown> | null | undefined): OutreachSettings {
  const s = settings ?? {};
  const str = (k: string) => (typeof s[k] === 'string' ? (s[k] as string).trim() : '');
  return { enabled: s.lead_followup_enabled === true, since: str('lead_followup_since') || null, address: usableMailingAddress(str('lead_mailing_address')), replyTo: str('lead_reply_email'), texts: s.lead_text_followup === true };
}

/** True only when email really leaves the building. The `log` driver writes to a file and delivers nothing. */
export function emailIsLive(): boolean {
  const env = getEnv();
  return env.EMAIL_DRIVER === 'resend' && !!env.RESEND_API_KEY;
}

export type OutreachBlocker = 'off' | 'not_approved' | 'no_address' | 'no_reply' | 'email_not_connected';
/**
 * Why nothing automatic is being sent, or null when it is. Never before the platform operator has approved the
 * workspace under its current name (./outreach-approval.ts): the enquiry form is public and takes any address, and the
 * business name is the From name of every email and part of its subject.
 */
export function outreachBlocker(s: OutreachSettings, live: boolean, org: ApprovalRow | null | undefined): OutreachBlocker | null {
  if (!s.enabled || !s.since) return 'off';
  if (!org || !outreachApproved(org)) return 'not_approved';
  if (!s.address) return 'no_address';
  if (!s.replyTo) return 'no_reply';
  if (!live) return 'email_not_connected';
  return null;
}

// ---------------------------------------------------------------- opt-out link (signed, no sign-in)
const signWith = (key: string, clientId: string) => createHmac('sha256', Buffer.from(key, 'base64')).update(`lead-opt-out:${clientId}`).digest('base64url');
const sign = (clientId: string) => signWith(getEnv().PII_ENCRYPTION_KEY, clientId);
export const optOutToken = (clientId: string) => `${clientId}-${sign(clientId)}`;
export const optOutUrl = (clientId: string) => `${getEnv().APP_URL}/unsubscribe/${optOutToken(clientId)}`;
/** A link signed before the key was rotated still works while the previous key is configured: an opt-out link must outlive its email. */
export function verifyOptOutToken(token: string): string | null {
  const id = token.slice(0, 36);
  if (!isUuid(id) || token[36] !== '-') return null;
  const env = getEnv();
  const keys = [env.PII_ENCRYPTION_KEY, env.PII_ENCRYPTION_KEY_PREVIOUS].filter((k): k is string => !!k);
  return keys.some((k) => safeEqual(token.slice(37), signWith(k, id))) ? id : null;
}

/** Opens from the link in an email. Sets the flag once, records it on the timeline, and stops all automatic lead email. */
export async function optOutLead(token: string): Promise<{ orgId: string; orgName: string; lang: 'en' | 'es' } | null> {
  const id = verifyOptOutToken(token);
  if (!id) return null;
  return withSystem(async (db) => {
    const c = await db.row<{ org_id: string; name: string; preferred_language: 'en' | 'es' }>(
      'select c.org_id, o.name, c.preferred_language from public.clients c join public.organizations o on o.id = c.org_id where c.id = $1', [id]);
    if (!c) return null;
    const changed = await db.run('update public.clients set outreach_opt_out_at = now() where id = $1 and outreach_opt_out_at is null', [id]);
    if (changed) {
      await db.run("insert into public.client_events (org_id, client_id, kind, summary) values ($1, $2, 'lead_opt_out', 'Opted out of automatic follow-up emails using the link in an email')", [c.org_id, id]);
      await audit(db, { orgId: c.org_id, actorLabel: 'Email opt-out link', action: 'lead.opted_out', entityType: 'client', entityId: id });
    }
    return { orgId: c.org_id, orgName: c.name, lang: c.preferred_language === 'es' ? 'es' : 'en' };
  });
}

/**
 * A spam complaint or a bounce the email service reported for an automatic follow-up email to a lead (matched by the
 * id the service gave when it accepted the email). Either one ends all automatic follow-up to that lead, as the
 * opt-out link does: the person said they do not want these emails, or the address does not take them. The timeline
 * says which it was. Reporting it again changes nothing. Returns false when the id is not one of the follow-up emails.
 * Reached through POST /api/webhooks/resend; written to Resend's documented webhook, not exercised against it.
 */
export async function recordLeadDeliveryEvent(providerRef: string, kind: 'bounced' | 'complained'): Promise<boolean> {
  if (!providerRef) return false;
  return withSystem(async (db) => {
    const o = await db.row<{ org_id: string; client_id: string }>(
      `select o.org_id, o.client_id from public.lead_outreach o join public.communications m on m.id = o.communication_id
        where m.provider_ref = $1 and m.channel = 'email' and m.direction = 'outbound' limit 1`, [providerRef.slice(0, 200)]);
    if (!o) return false;
    if (await db.run('update public.clients set outreach_opt_out_at = now() where id = $1 and org_id = $2 and outreach_opt_out_at is null', [o.client_id, o.org_id])) {
      const reason = kind === 'complained' ? 'complaint' : 'bounce';
      await db.run("insert into public.client_events (org_id, client_id, kind, summary, meta) values ($1, $2, 'lead_opt_out', $3, $4)", [o.org_id, o.client_id,
        kind === 'complained'
          ? 'The email service reported that this person marked an automatic follow-up email as spam. No further automatic follow-up is sent to them.'
          : 'The email service reported that an automatic follow-up email to this address came back undelivered. No further automatic follow-up is sent to it.',
        JSON.stringify({ reason })]);
      await audit(db, { orgId: o.org_id, actorLabel: 'Email service report', action: 'lead.opted_out', entityType: 'client', entityId: o.client_id, meta: { reason } });
    }
    return true;
  });
}

// ---------------------------------------------------------------- lead state (shared by the job and the Leads page)
/**
 * A communication row (alias `m`) that counts as the team being in touch: sent or logged by the team, and not an email
 * the provider refused ('failed') or one written to the log because no email service is connected ('queued').
 */
export const DELIVERED_BY_TEAM_SQL = "m.direction <> 'inbound' and m.status not in ('failed', 'queued', 'draft', 'pending_approval')";
/** The email steps and the text steps of public.lead_outreach, as SQL lists (constants from the step tables, never user input). */
export const EMAIL_STEPS_SQL = LEAD_STEPS.map((s) => `'${s.key}'`).join(', ');
export const TEXT_STEPS_SQL = LEAD_TEXT_STEPS.map((s) => `'${s.key}'`).join(', ');
/**
 * Columns that describe where a lead (alias `c`) stands with automatic follow-up; feed the row to `leadState`.
 * `outreach` holds the email steps only: the text steps of the same log are read separately (LEAD_TEXT_STATE_SQL).
 */
export const LEAD_STATE_SQL = `
  c.status, c.created_at, (c.email is not null) as has_email, (c.outreach_opt_out_at is not null) as opted_out,
  exists (select 1 from public.client_events e where e.client_id = c.id and e.kind = 'lead_created' and e.meta->>'contact_consent' = 'true') as consented,
  exists (select 1 from public.communications m where m.client_id = c.id and m.direction = 'inbound') as replied,
  exists (select 1 from public.communications m where m.client_id = c.id and ${DELIVERED_BY_TEAM_SQL}
            and not exists (select 1 from public.lead_outreach o where o.communication_id = m.id)) as contacted,
  coalesce((select jsonb_agg(jsonb_build_object('step', o.step, 'status', o.status, 'attempts', o.attempts, 'at', coalesce(o.sent_at, o.created_at)))
              from public.lead_outreach o where o.client_id = c.id and o.step in (${EMAIL_STEPS_SQL})), '[]'::jsonb) as outreach`;
export interface LeadStateRow { status: string; created_at: string; has_email: boolean; opted_out: boolean; consented: boolean; replied: boolean; contacted: boolean; outreach: LeadOutreachState['outreach'] }
export const leadState = (r: LeadStateRow, since: string | null): LeadOutreachState => ({
  status: r.status, hasEmail: r.has_email, consented: r.consented, optedOut: r.opted_out, replied: r.replied, contacted: r.contacted, receivedAt: r.created_at, eligibleFrom: since, outreach: r.outreach,
});

/**
 * LEAD_STATE_SQL plus what the text follow-up needs: the number on the record, the state on the address (for quiet
 * hours), the number an enquiry-form text consent is in force for, and the text steps already claimed.
 */
export const LEAD_TEXT_STATE_SQL = `${LEAD_STATE_SQL},
  c.phone, c.address->>'state' as state,
  (select s.phone from public.sms_consents s where s.client_id = c.id and s.revoked_at is null and s.source = '${ENQUIRY_FORM_CONSENT}') as text_consent_phone,
  coalesce((select jsonb_agg(jsonb_build_object('step', o.step, 'status', o.status, 'at', coalesce(o.sent_at, o.created_at)))
              from public.lead_outreach o where o.client_id = c.id and o.step in (${TEXT_STEPS_SQL})), '[]'::jsonb) as texts`;
export interface LeadTextStateRow extends LeadStateRow { phone: string | null; state: string | null; text_consent_phone: string | null; texts: LeadTextState['texts'] }
export const leadTextState = (r: LeadTextStateRow, since: string | null): LeadTextState => ({
  status: r.status, consented: r.consented, optedOut: r.opted_out, replied: r.replied, contacted: r.contacted,
  consentPhone: r.text_consent_phone, phone: toE164(r.phone), receivedAt: r.created_at, eligibleFrom: since, texts: r.texts,
});

// ---------------------------------------------------------------- sending
export interface OutreachResult {
  sent: number; failed: number; blocked: OutreachBlocker | null;
  /**
   * Why a run with nothing in the way stopped before the list was done. 'time': the scheduled job's deadline passed
   * while emails were still due; they go out with a later run. 'no_answer': the email service did not answer for the
   * email just handed to it, so nothing more was handed over in this run. 'switched_off': follow-up was switched off,
   * an address was changed, or the approval ended, while the run was under way.
   */
  held?: 'time' | 'no_answer' | 'switched_off';
}
export interface OutreachOptions {
  /** Only this lead (the welcome right after an enquiry). */
  clientId?: string;
  now?: Date;
  /** The scheduled job's own deadline (epoch ms): nothing new is claimed after it, so a send in flight can still finish. */
  stopAt?: number;
  /** Tests only: stand in for a connected email service. */
  live?: boolean;
  send?: (mail: Email) => Promise<SendResult>;
}
const MAX_EMAILS_PER_RUN = 50;
const STEP_LABEL = Object.fromEntries(LEAD_STEPS.map((s) => [s.key, s.label])) as Record<LeadStep, string>;

/**
 * Sends whichever automatic email each consenting lead of one agency is due — at most one per lead per call.
 * Nothing is sent, and nothing is recorded as sent, unless the platform operator approved the workspace under its
 * current name, the agency switched follow-up on, saved a postal address and a reply address, and email is really
 * connected. Safe to run twice or concurrently: each (lead, step) is claimed through a unique key, and the claim is
 * committed before the email is handed to the email service. The approval, the switch and both addresses are read
 * again with every claim.
 *
 * A step that does not go through: when the email service refused it, the step is 'failed' and is tried again by a
 * later run, LEAD_MAX_ATTEMPTS times in all. When the service gave no answer (a timeout, a dropped connection) the
 * email may have gone out, so the step stays 'sending': it is never sent again, nothing later goes out on top of it,
 * and the run hands nothing more to the service.
 */
export async function runLeadOutreach(orgId: string, opts: OutreachOptions = {}): Promise<OutreachResult> {
  const now = opts.now ?? new Date();
  const org = await withSystem((db) => db.row<ApprovalRow & { settings: Record<string, unknown> }>(
    `select ${APPROVAL_COLS}, settings from public.organizations where id = $1 and status = 'active' and mode = 'agency'`, [orgId]));
  if (!org) return { sent: 0, failed: 0, blocked: 'off' };
  const settings = outreachSettings(org.settings);
  const blocked = outreachBlocker(settings, opts.live ?? emailIsLive(), org);
  if (blocked) return { sent: 0, failed: 0, blocked };

  const leads = await withSystem((db) => db.rows<LeadStateRow & { id: string; full_name: string; email: string; preferred_language: string }>(
    `select c.id, c.full_name, c.email, c.preferred_language, ${LEAD_STATE_SQL}
       from public.clients c
      where c.org_id = $1 and c.status = 'lead' and c.email is not null and c.outreach_opt_out_at is null
        and c.created_at >= $2 and c.created_at >= $3 and ($4::uuid is null or c.id = $4)
      order by c.created_at limit 500`,
    [orgId, settings.since, new Date(now.getTime() - LEAD_WINDOW_DAYS * 86_400_000), opts.clientId ?? null]));

  const out: OutreachResult = { sent: 0, failed: 0, blocked: null };
  type Lead = (typeof leads)[number];
  for (const l of leads) {
    if (out.sent + out.failed >= MAX_EMAILS_PER_RUN) break;
    const d = decideLeadStep(leadState(l, settings.since), now);
    if (d.kind !== 'send') continue;
    if (opts.stopAt != null && Date.now() > opts.stopAt) { out.held = 'time'; break; }
    const step = d.step;

    // 1. Claim the step in its own short transaction, so the claim is on record before anything is handed to the email
    //    service. Every stop condition is checked again here, under a row lock: the list above may be minutes old.
    const claim = await withSystem(async (db) => {
      // The approval is for the name the email carries, and it can be withdrawn while a run is under way; so can the
      // switch and the two addresses. All are read again here, and the run ends when any of them changed.
      const cur = await db.row<ApprovalRow & { settings: Record<string, unknown> }>(`select ${APPROVAL_COLS}, settings from public.organizations where id = $1 and status = 'active'`, [orgId]);
      const s = outreachSettings(cur?.settings);
      if (!cur || !outreachApproved(cur) || cur.name !== org.name || !s.enabled || s.since !== settings.since || s.address !== settings.address || s.replyTo !== settings.replyTo) return 'switched_off' as const;
      if (!(await db.row('select 1 from public.clients where id = $1 and org_id = $2 for update', [l.id, orgId]))) return null;
      const fresh = await db.row<Lead>(`select c.id, c.full_name, c.email, c.preferred_language, ${LEAD_STATE_SQL} from public.clients c where c.id = $1 and c.org_id = $2`, [l.id, orgId]);
      if (!fresh || !fresh.email) return null;
      const again = decideLeadStep(leadState(fresh, settings.since), now);
      if (again.kind !== 'send' || again.step !== step) return null;
      const row = await db.row<{ id: string }>(
        `insert into public.lead_outreach (org_id, client_id, step, status) values ($1, $2, $3, 'sending')
         on conflict (client_id, step) do update set status = 'sending', attempts = public.lead_outreach.attempts + 1, error = null
           where public.lead_outreach.status = 'failed' and public.lead_outreach.attempts < $4
         returning id`, [orgId, l.id, step, LEAD_MAX_ATTEMPTS]);
      return row ? { id: row.id, lead: fresh } : null;
    });
    if (claim === 'switched_off') { out.held = 'switched_off'; break; }
    if (!claim) continue;

    // 2. Send outside any transaction: no lock or pooled connection is held while waiting on the email service.
    let mail: Email | null = null;
    let error = '';
    let ref: string | null = null;
    /** Handed to the email service, and no answer came back: it may or may not have been accepted. */
    let unconfirmed = false;
    try {
      const m = leadEmail(step, claim.lead.preferred_language === 'es' ? 'es' : 'en', { firstName: claim.lead.full_name, orgName: org.name, address: settings.address, optOutUrl: optOutUrl(l.id) });
      assertNoBlockedClaims(`${m.subject}\n${m.text}`);
      mail = { to: claim.lead.email, subject: m.subject, text: m.text, replyTo: settings.replyTo, fromName: org.name };
      const res = await (opts.send ?? sendEmail)(mail);
      if (res.provider !== 'resend') error = 'Email is not connected; nothing was delivered.';
      else if (!res.ok) {
        error = res.error ?? 'The email service refused the message.';
        unconfirmed = res.unconfirmed === true;
      }
      ref = res.providerRef ?? null;
    } catch (e) {
      error = String((e as Error).message ?? e);
    }

    // 3. Record the outcome. If this never runs (a crash, a lost connection) the row stays 'sending', which is treated
    //    as "delivery unknown" and never sent again automatically: at worst one email is lost, never duplicated.
    if (unconfirmed) {
      // No answer came back, so the email may have gone out. A 'failed' step is tried again by a later run, which
      // could put a second copy in the same mailbox; so this one stays 'sending', with the reason kept beside it,
      // and nothing more is handed to a service that is not answering.
      await withSystem(async (db) => {
        await db.run("update public.lead_outreach set error = $2 where id = $1 and status = 'sending'", [claim.id, error.slice(0, 500)]);
        await db.run("insert into public.client_events (org_id, client_id, kind, summary, meta) values ($1, $2, 'lead_outreach_unconfirmed', $3, $4)",
          [orgId, l.id, `Automatic follow-up email (${STEP_LABEL[step]}): the email service did not answer, so it may or may not have arrived. It is not sent again.`, JSON.stringify({ step })]);
      });
      out.held = 'no_answer';
      break;
    }
    if (error || !mail) {
      await withSystem((db) => db.run("update public.lead_outreach set status = 'failed', error = $2 where id = $1 and status = 'sending'", [claim.id, error.slice(0, 500)]));
      out.failed++;
      continue;
    }
    const sentMail = mail;
    await withSystem(async (db) => {
      const comm = await db.row<{ id: string }>(
        `insert into public.communications (org_id, client_id, direction, channel, subject, body, status, provider_ref)
         values ($1, $2, 'outbound', 'email', $3, $4, 'sent', $5) returning id`, [orgId, l.id, sentMail.subject, sentMail.text, ref]);
      await db.run("update public.lead_outreach set status = 'sent', sent_at = now(), communication_id = $2 where id = $1", [claim.id, comm!.id]);
      await db.run("insert into public.client_events (org_id, client_id, kind, summary, meta) values ($1, $2, 'lead_outreach', $3, $4)",
        [orgId, l.id, `Automatic follow-up email sent: ${STEP_LABEL[step]}`, JSON.stringify({ step })]);
    });
    out.sent++;
  }
  return out;
}

// ================================================================ text follow-up (only with a consent from the enquiry form)
export type LeadTextBlocker = 'off' | 'texts_off' | 'not_approved' | 'name_link' | 'sms_not_connected';
/**
 * Why no automatic text is being sent to leads, or null when texts can go out. Off unless the agency switched it on,
 * and never before the platform operator has approved the workspace for outreach under its current name
 * (./outreach-approval.ts): the public form takes any number, and every text leaves through the deployment's one
 * sending number. A name that would put a web address at the start of each text is refused as well.
 */
export function leadTextBlocker(s: OutreachSettings, usable: boolean, org: ApprovalRow | null | undefined): LeadTextBlocker | null {
  if (!s.enabled || !s.since) return 'off';
  if (!s.texts) return 'texts_off';
  if (!org || !outreachApproved(org)) return 'not_approved';
  if (linkInName(org.name)) return 'name_link';
  if (!usable) return 'sms_not_connected';
  return null;
}

/** Whether an agency's public enquiry form shows the text-message box: only when a text could actually follow. */
export const leadTextsOffered = (org: (ApprovalRow & { settings: Record<string, unknown> }) | null | undefined) => !!org && leadTextBlocker(outreachSettings(org.settings), smsUsable(), org) === null;
export async function leadTextsOfferedBySlug(slug: string): Promise<boolean> {
  const org = await withSystem((db) => db.row<ApprovalRow & { settings: Record<string, unknown> }>(`select ${APPROVAL_COLS}, settings from public.organizations where slug = $1 and status = 'active' and mode = 'agency'`, [slug]));
  return leadTextsOffered(org);
}

/**
 * Records the text consent a person gave by ticking the separate box on the enquiry form: the exact wording they were
 * shown (in the language the form was in), the number, the time and the address the request came from, in the same
 * ledger as every other SMS consent (sms_consents, source 'enquiry_form'). Call inside the transaction that creates the
 * lead. It can never undo the enquiry: it runs in a savepoint.
 *
 * The form is public and the number is not verified, so:
 *  - only a US number is accepted (a state, DC or Puerto Rico area code; ./sms.ts toUsE164): the form cannot be used to
 *    text another country, a premium number or a Caribbean area code at the deployment's cost;
 *  - a consent from it never overrides a STOP: when the number has replied STOP nothing is recorded (the table
 *    refuses it too) and the timeline says so;
 *  - nor a consent that was withdrawn any other way: when the newest text consent this agency holds for the number, on
 *    any record, was ended (the person asked the team to stop, staff switched texts off, a reply was read as a request
 *    to stop, the portal switch), ticking a box on a public form does not bring texts back. Only the person, signed in
 *    to the portal, or staff with a note of how they agreed, can;
 *  - one number is followed up once per agency: when another enquiry of the same agency already holds a form consent
 *    for the number, no second one is recorded, so sending the form again and again cannot text a number repeatedly.
 *    That holds when the form is sent several times at the same moment too: the checks below run under a lock on the
 *    agency and the number, kept until the enquiry's transaction commits, so a second submission waits for the first
 *    and then finds its consent.
 */
export async function recordEnquirySmsConsent(db: Db, a: { orgId: string; clientId: string; orgName: string; phone: string | null | undefined; lang: 'en' | 'es'; ip?: string | null; userAgent?: string | null }): Promise<'recorded' | 'no_phone' | 'stopped' | 'duplicate' | 'failed'> {
  const phone = toUsE164(a.phone);
  if (!phone) return 'no_phone';
  await db.run('savepoint enquiry_sms_consent');
  try {
    await db.run('select pg_advisory_xact_lock(hashtextextended($1, 29))', [`${a.orgId}:${phone}`]);
    let outcome: 'recorded' | 'stopped' | 'duplicate' = 'recorded';
    // The newest consent this agency holds for the number, on any record, was ended; or a record of this agency with
    // this number was marked "asked to stop" (which also covers someone who never had a consent to withdraw).
    const withdrawn = await db.row<{ ended: boolean }>(
      `select coalesce((select s.revoked_at is not null from public.sms_consents s where s.org_id = $1 and s.phone = $2 order by s.granted_at desc, s.id desc limit 1), false)
           or exists (select 1 from public.clients c where c.org_id = $1 and c.id <> $4 and c.outreach_opt_out_at is not null and c.phone is not null
                       and right(regexp_replace(c.phone, '\\D', '', 'g'), 10) = $3) as ended`, [a.orgId, phone, phone.slice(-10), a.clientId]);
    if ((await db.row<{ stopped: boolean }>('select app.sms_stopped($1, $2) as stopped', [a.clientId, phone]))?.stopped) {
      outcome = 'stopped';
      await db.run("insert into public.client_events (org_id, client_id, kind, summary) values ($1, $2, 'sms_consent', 'Ticked the text message box on the enquiry form, but this number has replied STOP before. No consent was recorded and no text is sent.')", [a.orgId, a.clientId]);
    } else if (withdrawn?.ended) {
      outcome = 'stopped';
      await db.run("insert into public.client_events (org_id, client_id, kind, summary) values ($1, $2, 'sms_consent', 'Ticked the text message box on the enquiry form, but texts to this number were switched off before. No consent was recorded and no text is sent: only the person, in the portal, or a staff member who records how they agreed can switch them back on.')", [a.orgId, a.clientId]);
    } else if (await db.row('select 1 from public.sms_consents where org_id = $1 and phone = $2 and source = $3 and revoked_at is null and client_id <> $4 limit 1', [a.orgId, phone, ENQUIRY_FORM_CONSENT, a.clientId])) {
      outcome = 'duplicate';
      await db.run("insert into public.client_events (org_id, client_id, kind, summary) values ($1, $2, 'sms_consent', 'Ticked the text message box on the enquiry form, but another enquiry already has a text consent for this number. No second consent was recorded and no text is sent for this one.')", [a.orgId, a.clientId]);
    } else {
      await db.run(
        `insert into public.sms_consents (org_id, client_id, phone, language, consent_text, source, ip, user_agent) values ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [a.orgId, a.clientId, phone, a.lang, leadSmsConsentText(a.lang, a.orgName), ENQUIRY_FORM_CONSENT, a.ip ?? null, a.userAgent?.slice(0, 300) ?? null]);
      await audit(db, { orgId: a.orgId, actorLabel: 'Website enquiry form', action: 'sms_consent.granted', entityType: 'client', entityId: a.clientId, ip: a.ip, meta: { source: ENQUIRY_FORM_CONSENT } });
    }
    await db.run('release savepoint enquiry_sms_consent');
    return outcome;
  } catch (e) {
    await db.run('rollback to savepoint enquiry_sms_consent').catch(() => undefined);
    console.error('[leads] could not record the text consent', a.clientId, (e as Error).message);
    return 'failed';
  }
}

export interface LeadTextResult {
  sent: number; failed: number; /** Held back by quiet hours; they go out with a later run. */ waiting: number; blocked: LeadTextBlocker | null;
  /**
   * Why a run with nothing in the way stopped before the list was done: the agency's or the deployment's 24-hour
   * limit, or time. 'switched_off': follow-up or texts were switched off, the workspace was renamed, or the approval
   * ended, while the run was under way.
   */
  held?: 'daily_cap' | 'platform_cap' | 'time' | 'switched_off' | null;
}
export interface LeadTextOptions {
  /** Only this lead (the welcome right after an enquiry). */
  clientId?: string;
  now?: Date;
  /** The scheduled job's own deadline (epoch ms): nothing new is claimed after it, so a send in flight can still finish. */
  stopAt?: number;
  /** Tests only: stand in for a connected text service. */
  usable?: boolean;
  send?: (msg: Sms) => Promise<SmsResult>;
}
const MAX_TEXTS_PER_RUN = 50;
/** How long one run may keep texting for one agency; what is left goes out with the next run (the job has a time limit of its own). */
const TEXT_RUN_BUDGET_MS = 20_000;
const TEXT_LABEL = Object.fromEntries(LEAD_TEXT_STEPS.map((s) => [s.key, s.label])) as Record<string, string>;

/**
 * Sends whichever automatic text each lead of one agency is due: at most one per lead per call, and only to a lead who
 * ticked the text-message box on the enquiry form, at exactly the number that consent was given for, while it stands.
 * No consent, no text: such a lead gets the emails only. A STOP reply withdraws the consent (and, being a reply, also
 * ends the emails). Texts are marketing, so they go out between 9:00 and 20:00 only, judged in the workspace's zone,
 * in Eastern and Pacific, and in the zones of the state the number's area code belongs to (leadQuietZones); a number
 * that is not a US number we can place is never texted. An agency sends at most LEAD_TEXT_DAILY_CAP of them in any 24
 * hours and the whole deployment at most OUTREACH_PLATFORM_DAILY_TEXTS, both counted under a lock when a text is
 * claimed; a text that failed or was not delivered still counts.
 *
 * Same guarantees as the emails: nothing is sent unless the operator approved the workspace under its current name and
 * the agency switched follow-up and texts on and a text service is connected; each (lead, step) is claimed through the
 * unique key before the text is handed over, with the approval, the name, the switches and every stop condition read
 * again at that moment (the run ends when any of the first three changed); a text whose outcome was never recorded is
 * not sent again, and neither is one that failed. No message is approved one by one.
 */
export async function runLeadTexts(orgId: string, opts: LeadTextOptions = {}): Promise<LeadTextResult> {
  const now = opts.now ?? new Date();
  const out: LeadTextResult = { sent: 0, failed: 0, waiting: 0, blocked: null };
  const org = await withSystem((db) => db.row<ApprovalRow & { settings: Record<string, unknown> }>(
    `select ${APPROVAL_COLS}, settings from public.organizations where id = $1 and status = 'active' and mode = 'agency'`, [orgId]));
  if (!org) return { ...out, blocked: 'off' };
  const settings = outreachSettings(org.settings);
  const blocked = leadTextBlocker(settings, opts.usable ?? smsUsable(), org);
  if (blocked) return { ...out, blocked };
  const platformCap = getEnv().OUTREACH_PLATFORM_DAILY_TEXTS;
  const orgTz = orgTimezone(org.settings, getEnv().APP_TIMEZONE);

  type Lead = LeadTextStateRow & { id: string; preferred_language: string };
  const leads = await withSystem((db) => db.rows<Lead>(
    `select c.id, c.preferred_language, ${LEAD_TEXT_STATE_SQL}
       from public.clients c
      where c.org_id = $1 and c.status = 'lead' and c.outreach_opt_out_at is null
        and c.created_at >= $2 and c.created_at >= $3 and ($4::uuid is null or c.id = $4)
        and exists (select 1 from public.sms_consents s where s.client_id = c.id and s.revoked_at is null and s.source = '${ENQUIRY_FORM_CONSENT}')
      order by c.created_at limit 500`,
    [orgId, settings.since, new Date(now.getTime() - LEAD_WINDOW_DAYS * 86_400_000), opts.clientId ?? null]));

  const started = Date.now();
  for (const l of leads) {
    if (out.sent + out.failed >= MAX_TEXTS_PER_RUN) break;
    if (Date.now() - started > TEXT_RUN_BUDGET_MS || (opts.stopAt != null && Date.now() > opts.stopAt)) { out.held = 'time'; break; }
    const state0 = leadTextState(l, settings.since);
    const d = decideLeadText(state0, now);
    if (d.kind !== 'send') continue;
    const step = d.step;
    // Where the person may be: the state the number's area code belongs to. (decideLeadText already stopped a number
    // with no US area code we know.) Quiet hours are judged there as well as in the workspace's zone and coast to coast.
    const areaState = usAreaCodeState(state0.consentPhone);
    if (!areaState) continue;
    if (inQuietHoursAnywhere(now, leadQuietZones(orgTz, l.state, areaState), MARKETING_WINDOW)) { out.waiting++; continue; }

    // 1. Claim, under a lock on the lead, reading the consent and every stop condition again. One claim at a time
    //    across the deployment, so both 24-hour limits are counted exactly even when runs overlap. Every claim of the
    //    last 24 hours counts, whatever became of the text: one the carrier later reported undelivered was still handed
    //    to the text service, so a form fed with dead numbers reaches the limit like any other.
    const claim = await withSystem(async (db) => {
      await db.run('select pg_advisory_xact_lock(hashtextextended($1, 28))', ['lead-texts']);
      // The approval is for the name every text starts with, and it can be withdrawn while a run is under way; so can
      // the switches. All are read again here, and the run ends when any of them changed.
      const cur = await db.row<ApprovalRow & { settings: Record<string, unknown> }>(`select ${APPROVAL_COLS}, settings from public.organizations where id = $1 and status = 'active'`, [orgId]);
      const s = outreachSettings(cur?.settings);
      if (!cur || cur.name !== org.name || s.since !== settings.since || leadTextBlocker(s, true, cur)) return 'switched_off' as const;
      const used = await db.row<{ org: number; platform: number }>(
        `select count(*) filter (where org_id = $1)::int as org, count(*)::int as platform from public.lead_outreach
          where step in (${TEXT_STEPS_SQL}) and created_at > now() - interval '24 hours'`, [orgId]);
      if ((used?.org ?? 0) >= LEAD_TEXT_DAILY_CAP) return 'daily_cap' as const;
      if ((used?.platform ?? 0) >= platformCap) return 'platform_cap' as const;
      if (!(await db.row('select 1 from public.clients where id = $1 and org_id = $2 for update', [l.id, orgId]))) return null;
      const fresh = await db.row<Lead>(`select c.id, c.preferred_language, ${LEAD_TEXT_STATE_SQL} from public.clients c where c.id = $1 and c.org_id = $2`, [l.id, orgId]);
      if (!fresh) return null;
      const state = leadTextState(fresh, settings.since);
      const again = decideLeadText(state, now);
      if (again.kind !== 'send' || again.step !== step || !state.consentPhone) return null;
      const row = await db.row<{ id: string }>(
        "insert into public.lead_outreach (org_id, client_id, step, status) values ($1, $2, $3, 'sending') on conflict (client_id, step) do nothing returning id", [orgId, l.id, step]);
      return row ? { id: row.id, to: state.consentPhone, lang: fresh.preferred_language === 'es' ? 'es' as const : 'en' as const } : null;
    });
    if (claim === 'daily_cap' || claim === 'platform_cap' || claim === 'switched_off') { out.held = claim; break; }
    if (!claim) continue;

    // 2. Send outside any transaction.
    let body = '';
    let res: { ok: boolean; provider: string; providerRef?: string; error?: string };
    try {
      body = leadText(step, claim.lang, { orgName: org.name });
      const issue = findBlockedClaims(body)[0];
      if (issue) res = { ok: false, provider: 'none', error: `Not sent: the message would contain a claim that is not allowed (${issue.why})` };
      else if (body.length > SMS_MAX_CHARS) res = { ok: false, provider: 'none', error: 'Not sent: the text would be too long' };
      else res = await (opts.send ?? sendSms)({ to: claim.to, body });
    } catch (e) {
      res = { ok: false, provider: 'none', error: String((e as Error).message ?? e) };
    }

    // 3. Record: on the log of steps, and as a message on the lead. The development `log` driver delivers nothing, so
    //    its message is saved as 'queued', which the Messages tab shows as "Not delivered".
    const outcome = res;
    await withSystem(async (db) => {
      const comm = await db.row<{ id: string }>(
        `insert into public.communications (org_id, client_id, direction, channel, body, status, provider_ref)
         values ($1, $2, 'outbound', 'sms', $3, $4, $5) returning id`,
        [orgId, l.id, body || '(not built)', !outcome.ok ? 'failed' : outcome.provider === 'log' ? 'queued' : 'sent', outcome.providerRef ?? null]);
      await db.run("update public.lead_outreach set status = $2, sent_at = case when $2 = 'sent' then now() else null end, error = $3, communication_id = $4 where id = $1",
        [claim.id, outcome.ok ? 'sent' : 'failed', outcome.ok ? null : (outcome.error ?? 'The text service refused the message').slice(0, 500), comm!.id]);
      if (outcome.ok) {
        await db.run("insert into public.client_events (org_id, client_id, kind, summary, meta) values ($1, $2, 'lead_outreach', $3, $4)",
          [orgId, l.id, `Automatic follow-up text sent: ${TEXT_LABEL[step] ?? step}`, JSON.stringify({ step })]);
      }
    });
    if (outcome.ok) out.sent++; else out.failed++;
  }
  return out;
}
