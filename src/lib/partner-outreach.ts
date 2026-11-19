import { createHmac } from 'node:crypto';
import { publicSiteBySlug, siteHome } from './agency-site';
import { audit } from './audit';
import { isBusinessDay, toDay } from './business-days';
import { orgTimezone } from './client-updates/templates';
import { findBlockedClaims, findMarketingClaims } from './compliance/claims';
import { safeEqual } from './crypto';
import { withSystem, type Db } from './db';
import { getEnv } from './env';
import { emailIsLive, outreachSettings } from './lead-outreach';
import { sendEmail, type Email, type SendResult } from './mailer';
import { APPROVAL_COLS, isNewlyApproved, NEW_WORKSPACE_DAILY_EMAILS, outreachApproved, type ApprovalRow } from './outreach-approval';
import {
  decidePartnerStep, isPartnerCategory, PARTNER_DAILY_CAP, PARTNER_FAILURE_HOLD_HOURS, PARTNER_MAX_ATTEMPTS, PARTNER_PER_RUN_CAP, PARTNER_RUN_BUDGET_MS, PARTNER_RUN_FAILURE_LIMIT,
  partnerEmail, partnerEmailText, partnerStepLabel, partnerWordingIssue,
  type PartnerCategory, type PartnerLang, type PartnerState,
} from './partner-emails';
import type { PartnerInput } from './partner-import';
import { dayInZone, isUuid } from './util';

/**
 * Automatic email to referral partners (businesses the agency added itself). EMAIL ONLY: nothing in this file, or
 * anywhere in the product, sends a text message or places a call to a partner; a partner's phone number is kept for
 * the agency's own reference.
 *
 * Stored in organizations.settings. Everything is off until an owner or admin turns it on, and nothing is sent until
 * the platform operator has approved the workspace for outreach (./outreach-approval.ts). The postal address and the
 * reply address are the ones the lead follow-up uses (one place to keep them). The wording is fixed: an earlier
 * setting that let a model reword the emails (`partner_outreach_ai`) is no longer read, because nothing a model writes
 * is emailed with nobody reading it.
 */
export interface PartnerSettings { enabled: boolean; address: string; replyTo: string }
export function partnerSettings(settings: Record<string, unknown> | null | undefined): PartnerSettings {
  const s = settings ?? {};
  const o = outreachSettings(s);
  return { enabled: s.partner_outreach_enabled === true, address: o.address, replyTo: o.replyTo };
}

export type PartnerBlocker = 'off' | 'not_approved' | 'no_address' | 'no_reply' | 'email_not_connected' | 'name_claim';
/**
 * Why nothing is being sent to partners, or null when the sequence is running. `org` carries the operator's approval
 * and the business name it was given for: a workspace that was never approved, or was renamed since, sends nothing.
 */
export function partnerBlocker(s: PartnerSettings, live: boolean, org: ApprovalRow): PartnerBlocker | null {
  if (!s.enabled) return 'off';
  if (!outreachApproved(org)) return 'not_approved';
  if (!s.address) return 'no_address';
  if (!s.replyTo) return 'no_reply';
  if (!live) return 'email_not_connected';
  if (partnerWordingIssue(org.name)) return 'name_claim';
  return null;
}

// ---------------------------------------------------------------- opt-out link (signed, no sign-in)
const signWith = (key: string, partnerId: string) => createHmac('sha256', Buffer.from(key, 'base64')).update(`partner-opt-out:${partnerId}`).digest('base64url');
export const partnerOptOutToken = (partnerId: string) => `${partnerId}-${signWith(getEnv().PII_ENCRYPTION_KEY, partnerId)}`;
/** The link in the body of every email: a page that asks "stop these emails?" with one button. Opening it changes nothing. */
export const partnerOptOutUrl = (partnerId: string) => `${getEnv().APP_URL.replace(/\/+$/, '')}/unsubscribe/partner/${partnerOptOutToken(partnerId)}`;
/**
 * The address in the List-Unsubscribe header (RFC 8058): a mail program POSTs to it when the reader presses its own
 * "unsubscribe" button, and that POST is the opt-out. A GET of it, which is all a link scanner sends, changes nothing.
 */
export const partnerOneClickUrl = (partnerId: string) => `${getEnv().APP_URL.replace(/\/+$/, '')}/api/unsubscribe/partner/${partnerOptOutToken(partnerId)}`;
/**
 * The partner a link belongs to, or null. A link never expires, and one signed before the key was rotated still works
 * while the previous key is configured: an opt-out link has to keep working long after its email was sent.
 */
export function verifyPartnerOptOutToken(token: string): string | null {
  const id = token.slice(0, 36);
  if (!isUuid(id) || token[36] !== '-') return null;
  const env = getEnv();
  const keys = [env.PII_ENCRYPTION_KEY, env.PII_ENCRYPTION_KEY_PREVIOUS].filter((k): k is string => !!k);
  return keys.some((k) => safeEqual(token.slice(37), signWith(k, id))) ? id : null;
}

/**
 * Stops all email to one partner, for good: stamps the opt-out once and writes the timeline entry. The table refuses
 * to lift the stamp, to put the partner back in the sequence or to change the address (trigger partners_guard,
 * migration 0028), and the address cannot be added again as a new row (unique per agency). The stop is the stamp
 * (`opted_out_at`), not the status: staff may later record that the partner replied or is interested, and still no
 * email is ever sent to the address.
 */
export async function markPartnerOptedOut(db: Db, a: { orgId: string; partnerId: string; actorId: string | null; summary: string }): Promise<boolean> {
  const changed = await db.run("update public.partners set status = 'opted_out', opted_out_at = now(), paused_at = null where id = $1 and org_id = $2 and opted_out_at is null", [a.partnerId, a.orgId]);
  if (changed) await db.run("insert into public.partner_events (org_id, partner_id, actor_id, kind, summary) values ($1, $2, $3, 'opted_out', $4)", [a.orgId, a.partnerId, a.actorId, a.summary.slice(0, 300)]);
  return changed > 0;
}

/**
 * Who an opt-out link belongs to, and whether the stop is already on record. Reading it changes nothing: this is what
 * the page behind the link shows before the reader presses the button. Mail security gateways open the links in
 * incoming mail; if opening were the opt-out, the first email would opt out every partner behind such a gateway.
 */
export async function partnerOptOutInfo(token: string): Promise<{ orgId: string; orgName: string; lang: PartnerLang; optedOut: boolean } | null> {
  const id = verifyPartnerOptOutToken(token);
  if (!id) return null;
  return withSystem(async (db) => {
    const p = await db.row<{ org_id: string; name: string; language: string; opted_out: boolean }>(
      'select p.org_id, o.name, p.language, (p.opted_out_at is not null) as opted_out from public.partners p join public.organizations o on o.id = p.org_id where p.id = $1', [id]);
    return p ? { orgId: p.org_id, orgName: p.name, lang: p.language === 'es' ? 'es' : 'en', optedOut: p.opted_out } : null;
  });
}

/**
 * The opt-out itself: the button on the page behind the link, or a mail program's one-click unsubscribe (a POST to
 * partnerOneClickUrl). No sign-in. Doing it again changes nothing.
 */
export async function optOutPartner(token: string): Promise<{ orgId: string; orgName: string; lang: PartnerLang } | null> {
  const id = verifyPartnerOptOutToken(token);
  if (!id) return null;
  return withSystem(async (db) => {
    const p = await db.row<{ org_id: string; name: string; language: string }>(
      'select p.org_id, o.name, p.language from public.partners p join public.organizations o on o.id = p.org_id where p.id = $1 for update of p', [id]);
    if (!p) return null;
    if (await markPartnerOptedOut(db, { orgId: p.org_id, partnerId: id, actorId: null, summary: 'Opted out from an email (the link, or the mail program’s unsubscribe button). No further email is sent to this address.' })) {
      await audit(db, { orgId: p.org_id, actorLabel: 'Email opt-out link', action: 'partner.opted_out', entityType: 'partner', entityId: id });
    }
    return { orgId: p.org_id, orgName: p.name, lang: p.language === 'es' ? 'es' : 'en' };
  });
}

// ---------------------------------------------------------------- adding partners
/**
 * Adds partners inside the caller's tenant transaction, so row-level security decides: staff of the organization
 * only, each row stamped with the person who attested it. An address already on file for the agency is skipped (the
 * unique key), which is also what keeps an address that opted out from coming back. Returns how many were new.
 */
export async function addPartners(db: Db, a: { orgId: string; userId: string }, rows: PartnerInput[], summary: string): Promise<{ added: number; existing: number; ids: string[] }> {
  if (!rows.length) return { added: 0, existing: 0, ids: [] };
  const inserted = await db.rows<{ id: string }>(
    `insert into public.partners (org_id, business_name, contact_name, category, email, phone, city, state, language, source_note, attested_by)
     select $1, r."businessName", r."contactName", r.category, r.email, r.phone, r.city, r.state, r.language, r."sourceNote", $2
       from jsonb_to_recordset($3::jsonb) as r("businessName" text, "contactName" text, category text, email text, phone text, city text, state text, language text, "sourceNote" text)
     on conflict (org_id, email) do nothing returning id`, [a.orgId, a.userId, JSON.stringify(rows)]);
  const ids = inserted.map((r) => r.id);
  if (ids.length) {
    await db.run("insert into public.partner_events (org_id, partner_id, actor_id, kind, summary) select $1, id, $2, 'added', $3 from unnest($4::uuid[]) as id", [a.orgId, a.userId, summary.slice(0, 300), ids]);
  }
  return { added: ids.length, existing: rows.length - ids.length, ids };
}

// ---------------------------------------------------------------- partner state (shared by the job and the Partners pages)
/** Columns that say where a partner (alias `p`) stands in the sequence; feed the row to `partnerState`. */
export const PARTNER_STATE_SQL = `
  p.status, (p.paused_at is not null) as paused, (p.opted_out_at is not null) as opted_out,
  coalesce((select jsonb_agg(jsonb_build_object('step', o.step, 'status', o.status, 'attempts', o.attempts, 'at', coalesce(o.sent_at, o.claimed_at)) order by o.created_at)
              from public.partner_outreach o where o.partner_id = p.id), '[]'::jsonb) as outreach`;
export interface PartnerStateRow { status: string; paused: boolean; /** The email stop: set once, never lifted, whatever the status says later. */ opted_out?: boolean; outreach: { step: string; status: string; attempts: number; at: string }[] }
/** `tz` is the agency's time zone: a step sent at 8 p.m. Eastern counts as sent that day, not the next one in UTC. */
export const partnerState = (r: PartnerStateRow, tz: string): PartnerState => ({
  status: r.opted_out ? 'opted_out' : r.status, paused: r.paused, outreach: r.outreach.map((o) => ({ step: o.step, status: o.status, attempts: o.attempts, sentOn: toDay(o.at, tz) })),
});
export const partnerTimezone = (settings: Record<string, unknown> | null | undefined) => orgTimezone(settings, getEnv().APP_TIMEZONE);

/**
 * The reason the email service gave, when the agency's most recent attempts all failed within the hold period; null
 * otherwise. While it holds nothing new is tried, so a problem on the sending side (a domain that is not verified, a
 * revoked key) stops two partners, not the whole list. It lifts by itself after PARTNER_FAILURE_HOLD_HOURS, and at once
 * when a person asks for another try of one of them ('failed' becomes 'retry'). Works under a tenant or the system connection.
 */
export async function partnerFailureHold(db: Db, orgId: string, now: Date = new Date()): Promise<string | null> {
  const recent = await db.rows<{ status: string; error: string | null }>(
    `select status, error from public.partner_outreach
      where org_id = $1 and claimed_at > $2::timestamptz - make_interval(hours => $3::int)
      order by claimed_at desc, created_at desc limit $4`, [orgId, now, PARTNER_FAILURE_HOLD_HOURS, PARTNER_RUN_FAILURE_LIMIT]);
  if (recent.length < PARTNER_RUN_FAILURE_LIMIT || recent.some((r) => r.status !== 'failed')) return null;
  return recent[0]!.error ?? 'the email service refused the message';
}

// ---------------------------------------------------------------- bounces and complaints
/** With at least this many bounces since the workspace was approved (30 days at most), and more than PARTNER_BOUNCE_RATE of what was sent, the sequence holds. */
export const PARTNER_BOUNCE_MIN = 3;
export const PARTNER_BOUNCE_RATE = 0.1;

/**
 * How many partner emails of this agency were sent, and how many addresses bounced, since the later of 30 days ago and
 * the day the operator approved the workspace. `hold` is true when the list is bad enough that sending on would hurt
 * every other workspace's email: the sequence then waits until the list is cleaned and the operator approves again
 * (which restarts the count). Works under a tenant or the system connection.
 */
export async function partnerBounceHealth(db: Db, orgId: string, approvedAt: string | Date | null): Promise<{ sent: number; bounced: number; hold: boolean }> {
  const r = await db.row<{ sent: number; bounced: number }>(
    `select (select count(*) from public.partner_outreach o where o.org_id = $1 and o.status = 'sent' and o.sent_at > greatest(now() - interval '30 days', coalesce($2::timestamptz, '-infinity')))::int as sent,
            (select count(*) from public.partner_events e where e.org_id = $1 and e.kind = 'bounced' and e.created_at > greatest(now() - interval '30 days', coalesce($2::timestamptz, '-infinity')))::int as bounced`,
    [orgId, approvedAt]);
  const sent = r?.sent ?? 0;
  const bounced = r?.bounced ?? 0;
  return { sent, bounced, hold: bounced >= PARTNER_BOUNCE_MIN && bounced > Math.max(sent, bounced) * PARTNER_BOUNCE_RATE };
}

/**
 * A bounce or a spam complaint the email service reported for an email this sequence sent (matched by the id the
 * service gave when it accepted the email). A bounce stops the sequence for that partner, exactly as the "Bounced"
 * button does. A complaint is an opt-out: that address is never emailed again. Returns false when the id is not one of
 * ours. Reached through POST /api/webhooks/resend; written to Resend's documented webhook, not exercised against it.
 */
export async function recordPartnerDeliveryEvent(providerRef: string, kind: 'bounced' | 'complained'): Promise<boolean> {
  if (!providerRef) return false;
  return withSystem(async (db) => {
    const o = await db.row<{ org_id: string; partner_id: string }>('select org_id, partner_id from public.partner_outreach where provider_ref = $1 limit 1', [providerRef.slice(0, 200)]);
    if (!o) return false;
    if (!(await db.row('select 1 from public.partners where id = $1 for update', [o.partner_id]))) return false;
    if (kind === 'complained') {
      if (await markPartnerOptedOut(db, { orgId: o.org_id, partnerId: o.partner_id, actorId: null, summary: 'The recipient marked one of these emails as spam. No email is sent to this address again.' })) {
        await audit(db, { orgId: o.org_id, actorLabel: 'Email service report', action: 'partner.opted_out', entityType: 'partner', entityId: o.partner_id, meta: { reason: 'complaint' } });
      }
      return true;
    }
    const changed = await db.run("update public.partners set status = 'bounced', paused_at = null where id = $1 and status in ('new', 'in_sequence', 'finished')", [o.partner_id]);
    if (changed) {
      await db.run("insert into public.partner_events (org_id, partner_id, kind, summary) values ($1, $2, 'bounced', 'The email service reported that an email to this address came back undelivered. No further automatic email is sent.')", [o.org_id, o.partner_id]);
      await audit(db, { orgId: o.org_id, actorLabel: 'Email service report', action: 'partner.marked', entityType: 'partner', entityId: o.partner_id, meta: { status: 'bounced' } });
    }
    return true;
  });
}

// ---------------------------------------------------------------- sending
export interface PartnerRunResult {
  sent: number; failed: number; blocked: PartnerBlocker | null;
  /** Why a run with nothing in the way stopped before the list was done. */
  held: 'not_business_day' | 'daily_cap' | 'platform_cap' | 'failures' | 'bounces' | 'switched_off' | 'time' | null;
}
export interface PartnerRunOptions {
  now?: Date;
  /** Only this partner. */
  partnerId?: string;
  /** Tests only: stand in for a connected email service. */
  live?: boolean;
  send?: (mail: Email) => Promise<SendResult>;
  /** The scheduled job's own deadline (epoch ms): nothing new is claimed after it, so an email in flight can still finish. */
  stopAt?: number;
}
interface Candidate extends PartnerStateRow { id: string; contact_name: string | null; category: string; email: string; city: string | null; state: string | null; language: string }
const CANDIDATE_COLS = 'p.id, p.contact_name, p.category, p.email, p.city, p.state, p.language';

/**
 * Sends whichever email of the sequence each partner of one agency is due: at most one per partner per call, at most
 * PARTNER_PER_RUN_CAP per call and PARTNER_DAILY_CAP in any 24 hours (NEW_WORKSPACE_DAILY_EMAILS while the workspace
 * is newly approved), and at most OUTREACH_PLATFORM_DAILY_EMAILS across every workspace, on business days only. No
 * message is approved one by one: once the operator has approved the workspace and an owner or admin has switched the
 * sequence on, the scheduled job sends. What it sends is the fixed wording and nothing else.
 *
 * Nothing is sent, and nothing is recorded as sent, unless the workspace is approved for outreach under its current
 * name, the sequence is switched on, a postal address and a reply address are saved, and email is really connected.
 * Safe to run twice or at the same moment: each (partner, step) is claimed through a unique key under one lock for the
 * whole deployment (which also makes both daily limits exact), and the claim is committed before the email is handed
 * to the email service. Every stop condition (opt-out, a recorded reply, "interested", "not interested", bounced,
 * paused, the switch and the approval themselves) is read again under a row lock at that moment, and so is the
 * deployment-wide opt-out list: an address that opted out of any workspace's partner emails, in any spelling the
 * email service treats as the same mailbox, is not emailed. A failed send stops the sequence for that partner; two
 * failures in a row hold the whole sequence (partnerFailureHold) and tell the owners and admins; and a list with too
 * many bounces holds it until the operator approves the workspace again (partnerBounceHealth).
 */
export async function runPartnerOutreach(orgId: string, opts: PartnerRunOptions = {}): Promise<PartnerRunResult> {
  const now = opts.now ?? new Date();
  const out: PartnerRunResult = { sent: 0, failed: 0, blocked: null, held: null };
  const org = await withSystem((db) => db.row<ApprovalRow & { slug: string; settings: Record<string, unknown> }>(
    `select ${APPROVAL_COLS}, slug, settings from public.organizations where id = $1 and status = 'active' and mode = 'agency'`, [orgId]));
  if (!org) return { ...out, blocked: 'off' };
  const settings = partnerSettings(org.settings);
  const blocked = partnerBlocker(settings, opts.live ?? emailIsLive(), org);
  if (blocked) return { ...out, blocked };
  const platformCap = getEnv().OUTREACH_PLATFORM_DAILY_EMAILS;
  // A workspace approved in the last two weeks sends at a lower rate: a bad list then shows itself in a few bounces.
  const dailyCap = isNewlyApproved(org, now) ? NEW_WORKSPACE_DAILY_EMAILS : PARTNER_DAILY_CAP;
  const tz = partnerTimezone(org.settings);
  const today = dayInZone(tz, now);
  if (!isBusinessDay(today)) return { ...out, held: 'not_business_day' };

  const partners = await withSystem((db) => db.rows<Candidate>(
    `select ${CANDIDATE_COLS}, ${PARTNER_STATE_SQL}
       from public.partners p
      where p.org_id = $1 and p.status in ('new', 'in_sequence') and p.paused_at is null and ($2::uuid is null or p.id = $2)
      order by (p.status = 'in_sequence') desc, p.created_at, p.id limit 1000`, [orgId, opts.partnerId ?? null]));
  const due = partners.flatMap((p) => { const d = decidePartnerStep(partnerState(p, tz), today); return d.kind === 'send' ? [{ p, step: d.step }] : []; });
  if (!due.length) return out;
  // The last attempts all failed: hold, rather than stop one more partner with every run.
  if (await withSystem((db) => partnerFailureHold(db, orgId, now))) return { ...out, held: 'failures' };
  // Too many addresses on this list bounced: hold until it is cleaned and the operator approves the workspace again.
  if ((await withSystem((db) => partnerBounceHealth(db, orgId, org.outreach_approved_at))).hold) return { ...out, held: 'bounces' };

  // The agency's own published website, when there is one, is linked from the email.
  const site = await publicSiteBySlug(org.slug);
  const siteUrl = site ? siteHome(site) : null;
  let failuresInARow = 0;
  const started = Date.now();

  for (const { p, step } of due) {
    if (out.sent + out.failed >= PARTNER_PER_RUN_CAP) break;
    if (Date.now() - started > PARTNER_RUN_BUDGET_MS || (opts.stopAt != null && Date.now() > opts.stopAt)) { out.held = 'time'; break; }

    // 1. Claim the step in its own short transaction. One claim at a time across the deployment, so the agency's and
    //    the deployment's 24-hour limits are counted exactly even when runs overlap; every stop condition, the
    //    approval and the opt-out list are read again under a lock on the partner.
    const claim = await withSystem(async (db) => {
      await db.run('select pg_advisory_xact_lock(hashtextextended($1, 28))', ['partner-outreach']);
      const cur = await db.row<ApprovalRow & { settings: Record<string, unknown> }>(`select ${APPROVAL_COLS}, settings from public.organizations where id = $1 and status = 'active'`, [orgId]);
      const s = partnerSettings(cur?.settings);
      if (!cur || !s.enabled || !s.address || !s.replyTo || !outreachApproved(cur) || cur.name !== org.name) return 'switched_off' as const;
      const used = await db.row<{ org: number; platform: number }>(
        `select count(*) filter (where org_id = $1)::int as org, count(*)::int as platform from public.partner_outreach
          where status in ('sending', 'sent') and claimed_at > $2::timestamptz - interval '24 hours'`, [orgId, now]);
      if ((used?.org ?? 0) >= dailyCap) return 'daily_cap' as const;
      if ((used?.platform ?? 0) >= platformCap) return 'platform_cap' as const;
      if (!(await db.row('select 1 from public.partners where id = $1 and org_id = $2 for update', [p.id, orgId]))) return null;
      const fresh = await db.row<Candidate>(`select ${CANDIDATE_COLS}, ${PARTNER_STATE_SQL} from public.partners p where p.id = $1 and p.org_id = $2`, [p.id, orgId]);
      if (!fresh) return null;
      const again = decidePartnerStep(partnerState(fresh, tz), today);
      if (again.kind !== 'send' || again.step !== step) return null;
      // The opt-out list is one list for the deployment, read by normalised address: someone who stopped these emails
      // once is not written to again through another workspace, or as dana+1@ after dana@ opted out.
      if (await db.row('select 1 from public.partners x where x.opted_out_at is not null and app.email_norm(x.email) = app.email_norm($1) limit 1', [fresh.email])) {
        await markPartnerOptedOut(db, { orgId, partnerId: p.id, actorId: null, summary: 'This address has asked not to receive partner emails sent through this service. No email is sent to it.' });
        return null;
      }
      const row = await db.row<{ id: string }>(
        `insert into public.partner_outreach (org_id, partner_id, step, status, claimed_at) values ($1, $2, $3, 'sending', $4)
         on conflict (partner_id, step) do update set status = 'sending', attempts = public.partner_outreach.attempts + 1, error = null, claimed_at = $4
           where public.partner_outreach.status = 'retry' and public.partner_outreach.attempts < $5
         returning id`, [orgId, p.id, step, now, PARTNER_MAX_ATTEMPTS]);
      return row ? { id: row.id, partner: fresh, address: s.address, replyTo: s.replyTo } : null;
    });
    if (claim === 'switched_off' || claim === 'daily_cap' || claim === 'platform_cap') { out.held = claim; break; }
    if (!claim) continue; // another run has it, or something changed in the meantime

    // 2. Build and send outside any transaction: no lock or pooled connection is held while waiting on the AI or the email service.
    const label = partnerStepLabel(step);
    const lang: PartnerLang = claim.partner.language === 'es' ? 'es' : 'en';
    const category: PartnerCategory = isPartnerCategory(claim.partner.category) ? claim.partner.category : 'other';
    let subject: string | null = null;
    let text: string | null = null;
    let error = '';
    let ref: string | null = null;
    try {
      // The fixed wording, from the fields on the record. Nothing a model wrote is ever part of it.
      const base = partnerEmail(step, lang, {
        contactName: claim.partner.contact_name, category, city: claim.partner.city, state: claim.partner.state,
        orgName: org.name, address: claim.address, optOutUrl: partnerOptOutUrl(p.id), siteUrl,
      });
      subject = base.subject;
      text = partnerEmailText(base.body, base.footer);
      // The email that leaves is held to the claims guard one more time (the business name is part of it).
      const issue = findMarketingClaims(`${subject}\n${base.body}`)[0] ?? findBlockedClaims(text)[0];
      if (issue) error = `the message would contain a claim that is not allowed (${issue.why})`;
      else {
        const res = await (opts.send ?? sendEmail)({
          to: claim.partner.email, subject, text, replyTo: claim.replyTo, fromName: org.name, stream: 'outreach',
          // A mail program's own "unsubscribe" button POSTs to this address, and that POST is the opt-out (RFC 8058).
          headers: { 'List-Unsubscribe': `<${partnerOneClickUrl(p.id)}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
        });
        if (res.provider !== 'resend') error = 'email is not connected; nothing was delivered';
        else if (!res.ok) error = res.error ?? 'the email service refused the message';
        ref = res.providerRef ?? null;
      }
    } catch (e) {
      error = String((e as Error).message ?? e);
    }

    // 3. Record the outcome. If this never runs (a crash, a lost connection) the row stays 'sending', which is treated
    //    as "delivery unknown" and never sent again automatically: at worst one email is lost, never duplicated.
    if (error) {
      await withSystem(async (db) => {
        await db.run("update public.partner_outreach set status = 'failed', error = $2, subject = $3, body = $4 where id = $1 and status = 'sending'", [claim.id, error.slice(0, 500), subject, text]);
        await db.run("insert into public.partner_events (org_id, partner_id, kind, summary) values ($1, $2, 'email_failed', $3)",
          [orgId, p.id, `${label} email was not sent: ${error}`.slice(0, 240) + '. The sequence stopped for this partner.']);
      });
      out.failed++;
      if (++failuresInARow >= PARTNER_RUN_FAILURE_LIMIT) {
        out.held = 'failures';
        // Not silent: the owners and admins are told once a day while it lasts, with the reason the email service gave.
        await withSystem(async (db) => {
          const title = 'Partner emails are not going out';
          if (await db.row("select 1 from public.notifications where org_id = $1 and title = $2 and created_at > now() - interval '1 day' limit 1", [orgId, title])) return;
          await db.run(
            `insert into public.notifications (org_id, user_id, title, body, href)
             select $1, m.user_id, $2, $3, '/app/partners' from public.memberships m where m.org_id = $1 and m.role in ('owner', 'admin')`,
            [orgId, title, `The email service refused ${PARTNER_RUN_FAILURE_LIMIT} partner emails in a row (${error}). Nothing more is tried for ${PARTNER_FAILURE_HOLD_HOURS} hours, or until you press “Try again” on one of those partners.`.slice(0, 1000)]);
        }).catch((e) => console.error('[partners] could not record the notification', orgId, (e as Error).message));
        break;
      }
      continue;
    }
    failuresInARow = 0;
    await withSystem(async (db) => {
      await db.run("update public.partner_outreach set status = 'sent', sent_at = $2, subject = $3, body = $4, provider_ref = $5 where id = $1", [claim.id, now, subject, text, ref]);
      // A reply or a decision recorded while the email was on its way is left as it is.
      await db.run("update public.partners set status = $3 where id = $1 and org_id = $2 and status in ('new', 'in_sequence')", [p.id, orgId, step === 'final' ? 'finished' : 'in_sequence']);
      await db.run("insert into public.partner_events (org_id, partner_id, kind, summary) values ($1, $2, 'email_sent', $3)",
        [orgId, p.id, `${label} email sent automatically`]);
    });
    out.sent++;
  }
  return out;
}
