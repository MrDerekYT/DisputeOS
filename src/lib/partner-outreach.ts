import { createHmac } from 'node:crypto';
import { publicSiteBySlug, siteHome } from './agency-site';
import { audit } from './audit';
import { isBusinessDay, toDay } from './business-days';
import { orgTimezone } from './client-updates/templates';
import { safeEqual } from './crypto';
import { withSystem, type Db } from './db';
import { getEnv } from './env';
import { emailIsLive, outreachSettings } from './lead-outreach';
import { sendEmail, type Email, type SendResult } from './mailer';
import { usableMailingAddress } from './mailing-address';
import { APPROVAL_COLS, isNewlyApproved, NEW_WORKSPACE_DAILY_EMAILS, outreachApproved, type ApprovalRow } from './outreach-approval';
import {
  decidePartnerStep, isPartnerCategory, PARTNER_DAILY_CAP, PARTNER_FAILURE_HOLD_HOURS, PARTNER_MAX_ATTEMPTS, PARTNER_PER_RUN_CAP, PARTNER_RUN_BUDGET_MS, PARTNER_RUN_FAILURE_LIMIT,
  partnerEmail, partnerEmailIssue, partnerStepLabel, partnerWordingIssue,
  type PartnerCategory, type PartnerLang, type PartnerState, type PartnerWordingIssue,
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
 * reply address are the ones the lead follow-up uses (one place to keep them). The postal address is printed in every
 * email, so a saved value that is not shaped like a postal address (./mailing-address.ts) is read as no address at
 * all. The wording is fixed: an earlier setting that let a model reword the emails (`partner_outreach_ai`) is no
 * longer read, because nothing a model writes is emailed with nobody reading it.
 */
export interface PartnerSettings { enabled: boolean; /** '' when none is saved, or when the saved text is not shaped like a postal address. */ address: string; replyTo: string }
export function partnerSettings(settings: Record<string, unknown> | null | undefined): PartnerSettings {
  const s = settings ?? {};
  const o = outreachSettings(s);
  return { enabled: s.partner_outreach_enabled === true, address: usableMailingAddress(o.address), replyTo: o.replyTo };
}

/** The last three: the business name, the website address or the mailing address would put a claim (or a link) in the emails. */
export type PartnerBlocker = 'off' | 'not_approved' | 'no_address' | 'no_reply' | 'email_not_connected' | 'name_claim' | 'site_claim' | 'address_claim';
const WORDING_BLOCKER: Record<PartnerWordingIssue['part'], PartnerBlocker> = { name: 'name_claim', website: 'site_claim', address: 'address_claim' };
/**
 * Why nothing is being sent to partners, or null when the sequence is running. `org` carries the operator's approval
 * and the business name it was given for: a workspace that was never approved, or was renamed since, sends nothing.
 * `siteUrl` is the address of the agency's published website, which the emails link to: given it, the last check reads
 * the emails as they would really leave (partnerWordingIssue).
 */
export function partnerBlocker(s: PartnerSettings, live: boolean, org: ApprovalRow, siteUrl?: string | null): PartnerBlocker | null {
  if (!s.enabled) return 'off';
  if (!outreachApproved(org)) return 'not_approved';
  if (!usableMailingAddress(s.address)) return 'no_address';
  if (!s.replyTo) return 'no_reply';
  if (!live) return 'email_not_connected';
  const wording = partnerWordingIssue(org.name, { siteUrl, address: s.address });
  return wording ? WORDING_BLOCKER[wording.part] : null;
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
 * email is ever sent to the address. On its own this stops this workspace's emails only; what the recipient did
 * themselves also goes on the deployment-wide list (recipientOptOut below).
 */
export async function markPartnerOptedOut(db: Db, a: { orgId: string; partnerId: string; actorId: string | null; summary: string }): Promise<boolean> {
  const changed = await db.run("update public.partners set status = 'opted_out', opted_out_at = now(), paused_at = null where id = $1 and org_id = $2 and opted_out_at is null", [a.partnerId, a.orgId]);
  if (changed) await db.run("insert into public.partner_events (org_id, partner_id, actor_id, kind, summary) values ($1, $2, $3, 'opted_out', $4)", [a.orgId, a.partnerId, a.actorId, a.summary.slice(0, 300)]);
  return changed > 0;
}

/** How a recipient stopped the partner emails: the button behind the link, the mail program's one-click request, or a spam complaint. */
export type PartnerOptOutSource = 'link' | 'one_click' | 'complaint';
const LINK_OPT_OUT_SUMMARY = 'Opted out from an email (the link, or the mail program’s unsubscribe button). No further email is sent to this address.';

/**
 * An opt-out the recipient made themselves. The mailbox goes on the deployment-wide list (public.partner_opt_outs,
 * migration 0030) that every workspace's sequence reads, and this partner is stopped as markPartnerOptedOut does. The
 * list is written every time, also when staff had already recorded "Asked to stop" on the partner: that stopped this
 * workspace's emails only. The list belongs to no workspace, so deleting a user or a workspace removes nothing from it.
 * Call under the system connection, with the partner row locked. True when anything new was recorded.
 */
async function recipientOptOut(db: Db, a: { orgId: string; partnerId: string; email: string; source: PartnerOptOutSource; summary: string }): Promise<boolean> {
  const listed = (await db.run('insert into public.partner_opt_outs (email_norm, source) values (app.email_norm($1), $2) on conflict (email_norm) do nothing', [a.email, a.source])) > 0;
  const stamped = await markPartnerOptedOut(db, { orgId: a.orgId, partnerId: a.partnerId, actorId: null, summary: a.summary });
  // Already stopped by the team: the timeline still says that the recipient opted out as well.
  if (listed && !stamped) await db.run("insert into public.partner_events (org_id, partner_id, kind, summary) values ($1, $2, 'opted_out', $3)", [a.orgId, a.partnerId, a.summary.slice(0, 300)]);
  return listed || stamped;
}

/**
 * Who an opt-out link belongs to, and whether the recipient's own stop is already on record. Reading it changes
 * nothing: this is what the page behind the link shows before the reader presses the button. Mail security gateways
 * open the links in incoming mail; if opening were the opt-out, the first email would opt out every partner behind such
 * a gateway. A partner the team marked "Asked to stop" is not done yet: the page still offers the button, because only
 * the recipient's own opt-out stops the emails of every workspace.
 */
export async function partnerOptOutInfo(token: string): Promise<{ orgId: string; orgName: string; lang: PartnerLang; optedOut: boolean } | null> {
  const id = verifyPartnerOptOutToken(token);
  if (!id) return null;
  return withSystem(async (db) => {
    const p = await db.row<{ org_id: string; name: string; language: string; opted_out: boolean }>(
      `select p.org_id, o.name, p.language,
              (p.opted_out_at is not null and exists (select 1 from public.partner_opt_outs x where x.email_norm = app.email_norm(p.email))) as opted_out
         from public.partners p join public.organizations o on o.id = p.org_id where p.id = $1`, [id]);
    return p ? { orgId: p.org_id, orgName: p.name, lang: p.language === 'es' ? 'es' : 'en', optedOut: p.opted_out } : null;
  });
}

/**
 * The opt-out itself: the button on the page behind the link (`via` 'link'), or a mail program's one-click unsubscribe
 * (a POST to partnerOneClickUrl, `via` 'one_click'). No sign-in. Doing it again changes nothing.
 */
export async function optOutPartner(token: string, via: 'link' | 'one_click' = 'link'): Promise<{ orgId: string; orgName: string; lang: PartnerLang } | null> {
  const id = verifyPartnerOptOutToken(token);
  if (!id) return null;
  return withSystem(async (db) => {
    const p = await db.row<{ org_id: string; name: string; language: string; email: string }>(
      'select p.org_id, o.name, p.language, p.email from public.partners p join public.organizations o on o.id = p.org_id where p.id = $1 for update of p', [id]);
    if (!p) return null;
    if (await recipientOptOut(db, { orgId: p.org_id, partnerId: id, email: p.email, source: via, summary: LINK_OPT_OUT_SUMMARY })) {
      await audit(db, { orgId: p.org_id, actorLabel: 'Email opt-out link', action: 'partner.opted_out', entityType: 'partner', entityId: id, meta: { via } });
    }
    return { orgId: p.org_id, orgName: p.name, lang: p.language === 'es' ? 'es' : 'en' };
  });
}

// ---------------------------------------------------------------- adding partners
/**
 * Adds partners inside the caller's tenant transaction, so row-level security decides: staff of the organization
 * only, each row stamped with the person who attested it. A mailbox already on file for the agency is skipped and
 * counted as existing. The unique key reads an address as the opt-out list does (app.email_norm: lower case, without a
 * "+tag", and for Gmail without dots), so dana+1@ is not a second partner next to dana@, and one mailbox gets the
 * sequence once. It is also what keeps an address that opted out from coming back. Returns how many were new.
 */
export async function addPartners(db: Db, a: { orgId: string; userId: string }, rows: PartnerInput[], summary: string): Promise<{ added: number; existing: number; ids: string[] }> {
  if (!rows.length) return { added: 0, existing: 0, ids: [] };
  const inserted = await db.rows<{ id: string }>(
    `insert into public.partners (org_id, business_name, contact_name, category, email, phone, city, state, language, source_note, attested_by)
     select $1, r."businessName", r."contactName", r.category, r.email, r.phone, r.city, r.state, r.language, r."sourceNote", $2
       from jsonb_to_recordset($3::jsonb) as r("businessName" text, "contactName" text, category text, email text, phone text, city text, state text, language text, "sourceNote" text)
     on conflict do nothing returning id`, [a.orgId, a.userId, JSON.stringify(rows)]);
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
 * How the error of a step begins when this app's own claims guard refused the email, which was then never handed to
 * the email service. The step stops that partner like any failed one, but it says nothing about the email service: it
 * is left out of the hold below and of the notification that goes with it.
 */
export const PARTNER_GUARD_REFUSAL = 'the message would contain a claim that is not allowed';

/**
 * The reason the email service gave, when the agency's most recent attempts all failed within the hold period; null
 * otherwise. While it holds nothing new is tried, so a problem on the sending side (a domain that is not verified, a
 * revoked key) stops two partners, not the whole list. It lifts by itself after PARTNER_FAILURE_HOLD_HOURS, and at once
 * when a person asks for another try of one of them ('failed' becomes 'retry'). An email this app's own guard refused
 * is not an attempt for this purpose, and one whose outcome is unknown (still 'sending') is not a failure. Works under
 * a tenant or the system connection.
 */
export async function partnerFailureHold(db: Db, orgId: string, now: Date = new Date()): Promise<string | null> {
  const recent = await db.rows<{ status: string; error: string | null }>(
    `select status, error from public.partner_outreach
      where org_id = $1 and claimed_at > $2::timestamptz - make_interval(hours => $3::int) and not starts_with(coalesce(error, ''), $5)
      order by claimed_at desc, created_at desc limit $4`, [orgId, now, PARTNER_FAILURE_HOLD_HOURS, PARTNER_RUN_FAILURE_LIMIT, PARTNER_GUARD_REFUSAL]);
  if (recent.length < PARTNER_RUN_FAILURE_LIMIT || recent.some((r) => r.status !== 'failed')) return null;
  return recent[0]!.error ?? 'the email service refused the message';
}

// ---------------------------------------------------------------- bounces and complaints
/** With at least this many bounces since the workspace was approved, and more than PARTNER_BOUNCE_RATE of what was sent, the sequence holds. */
export const PARTNER_BOUNCE_MIN = 3;
export const PARTNER_BOUNCE_RATE = 0.1;

/**
 * How many partner emails of this agency were sent, and how many addresses bounced, since the operator approved the
 * workspace (a workspace that sends always has that date; without one, the last 30 days are counted). `hold` is true
 * when the list is bad enough that sending on would hurt every other workspace's email. The hold does not end with
 * time: the sequence waits until the list is cleaned and the operator approves the workspace again, which restarts the
 * count. Works under a tenant or the system connection.
 */
export async function partnerBounceHealth(db: Db, orgId: string, approvedAt: string | Date | null): Promise<{ sent: number; bounced: number; hold: boolean }> {
  const r = await db.row<{ sent: number; bounced: number }>(
    `select (select count(*) from public.partner_outreach o where o.org_id = $1 and o.status = 'sent' and o.sent_at > coalesce($2::timestamptz, now() - interval '30 days'))::int as sent,
            (select count(*) from public.partner_events e where e.org_id = $1 and e.kind = 'bounced' and e.created_at > coalesce($2::timestamptz, now() - interval '30 days'))::int as bounced`,
    [orgId, approvedAt]);
  const sent = r?.sent ?? 0;
  const bounced = r?.bounced ?? 0;
  return { sent, bounced, hold: bounced >= PARTNER_BOUNCE_MIN && bounced > Math.max(sent, bounced) * PARTNER_BOUNCE_RATE };
}

/**
 * A bounce or a spam complaint the email service reported for an email this sequence sent (matched by the id the
 * service gave when it accepted the email). A bounce stops the sequence for that partner, exactly as the "Bounced"
 * button does. A complaint is the recipient's own opt-out: that mailbox is never emailed again, by any workspace.
 * Returns false when the id is not one of ours. Reached through POST /api/webhooks/resend; written to Resend's
 * documented webhook, not exercised against it.
 */
export async function recordPartnerDeliveryEvent(providerRef: string, kind: 'bounced' | 'complained'): Promise<boolean> {
  if (!providerRef) return false;
  return withSystem(async (db) => {
    const o = await db.row<{ org_id: string; partner_id: string }>('select org_id, partner_id from public.partner_outreach where provider_ref = $1 limit 1', [providerRef.slice(0, 200)]);
    if (!o) return false;
    const p = await db.row<{ email: string }>('select email from public.partners where id = $1 for update', [o.partner_id]);
    if (!p) return false;
    if (kind === 'complained') {
      if (await recipientOptOut(db, { orgId: o.org_id, partnerId: o.partner_id, email: p.email, source: 'complaint', summary: 'The recipient marked one of these emails as spam. No email is sent to this address again.' })) {
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
  /**
   * Why a run with nothing in the way stopped before the list was done. 'no_answer': the email service did not answer
   * for the email just handed to it, so nothing more was handed over in this run.
   */
  held: 'not_business_day' | 'daily_cap' | 'platform_cap' | 'failures' | 'bounces' | 'switched_off' | 'time' | 'no_answer' | null;
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
 * name, the sequence is switched on, a postal address and a reply address are saved, email is really connected, and
 * the emails as they would leave (with the agency's name, website address and mailing address) pass the claims guard.
 * Safe to run twice or at the same moment: each (partner, step) is claimed through a unique key under one lock for the
 * whole deployment (which also makes both daily limits exact), and the claim is committed before the email is handed
 * to the email service. Every stop condition (opt-out, a recorded reply, "interested", "not interested", bounced,
 * paused, the switch and the approval themselves) is read again under a row lock at that moment, and so is the
 * deployment-wide opt-out list: a mailbox whose owner opted out of any workspace's partner emails, in any spelling the
 * email service treats as the same mailbox, is not emailed.
 *
 * What happens to a step that does not go through:
 *  - the email service refused it: the step is 'failed' and the sequence stops for that partner until a person asks
 *    for another try. Two such refusals in a row hold the whole sequence (partnerFailureHold) and tell the owners and admins;
 *  - the email service gave no answer (a timeout, a dropped connection): the email may have gone out, so the step stays
 *    'sending'. It is never sent again, nobody is offered another try, it is not counted as a refusal, and the run
 *    hands nothing more to the service;
 *  - this app's own claims guard refused it (something on that partner's record reads as a claim): the step is
 *    'failed' for that partner, and it is not counted as a refusal by the email service.
 * A list with too many bounces holds the sequence until the operator approves the workspace again (partnerBounceHealth).
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

  // The agency's own published website, when there is one, is linked from the introduction and the follow-up. Its
  // address is then part of those emails, so the wording is checked once more with it before anything is claimed.
  const site = await publicSiteBySlug(org.slug);
  const siteUrl = site ? siteHome(site) : null;
  const siteBlocked = siteUrl ? partnerBlocker(settings, true, org, siteUrl) : null;
  if (siteBlocked) return { ...out, blocked: siteBlocked };
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
      // The name and the mailing address are the ones the wording was checked with when this run started.
      if (!cur || !s.enabled || !s.replyTo || !outreachApproved(cur) || cur.name !== org.name || s.address !== settings.address) return 'switched_off' as const;
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
      // The opt-out list is one list for the deployment (public.partner_opt_outs), read by normalised address: someone
      // who stopped these emails themselves (the link, the mail program's unsubscribe button, a spam complaint) is not
      // written to again through any workspace, or as dana+1@ after dana@ opted out. Only the system connection writes
      // that list. What staff recorded by hand ("Asked to stop") stops their own workspace's emails, in any spelling
      // of the address, and nobody else's.
      if (await db.row(
        `select 1 from public.partner_opt_outs where email_norm = app.email_norm($1)
         union all
         select 1 from public.partners x
          where x.org_id = $2 and x.id <> $3 and x.opted_out_at is not null and app.email_norm(x.email) = app.email_norm($1)
         limit 1`, [fresh.email, orgId, p.id])) {
        // Paused, not stamped as opted out: that stamp can never be lifted, and this stop is on another record.
        await db.run('update public.partners set paused_at = now() where id = $1 and org_id = $2 and paused_at is null', [p.id, orgId]);
        await db.run("insert into public.partner_events (org_id, partner_id, kind, summary) values ($1, $2, 'paused', $3)",
          [orgId, p.id, 'Paused automatically: this address opted out of partner emails sent through this service. No email is sent to it.']);
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

    // 2. Build and send outside any transaction: no lock or pooled connection is held while waiting on the email service.
    const label = partnerStepLabel(step);
    const lang: PartnerLang = claim.partner.language === 'es' ? 'es' : 'en';
    const category: PartnerCategory = isPartnerCategory(claim.partner.category) ? claim.partner.category : 'other';
    let subject: string | null = null;
    let text: string | null = null;
    let error = '';
    let ref: string | null = null;
    /** This app's own claims guard refused the email: it was never handed to the email service. */
    let guardRefused = false;
    /** Handed to the email service, and no answer came back: it may or may not have been accepted. */
    let unconfirmed = false;
    try {
      // The fixed wording, from the fields on the record. Nothing a model wrote is ever part of it.
      const base = partnerEmail(step, lang, {
        contactName: claim.partner.contact_name, category, city: claim.partner.city, state: claim.partner.state,
        orgName: org.name, address: claim.address, optOutUrl: partnerOptOutUrl(p.id), siteUrl,
      });
      subject = base.subject;
      text = base.text;
      // The email that leaves is held to the claims guard one more time. What is the same for every partner passed it
      // when the run started, so a refusal here comes from this partner's record (a city or a first name).
      const issue = partnerEmailIssue(base);
      if (issue) {
        guardRefused = true;
        error = `${PARTNER_GUARD_REFUSAL} (${issue.why})`;
      } else {
        const res = await (opts.send ?? sendEmail)({
          to: claim.partner.email, subject, text, replyTo: claim.replyTo, fromName: org.name, stream: 'outreach',
          // A mail program's own "unsubscribe" button POSTs to this address, and that POST is the opt-out (RFC 8058).
          headers: { 'List-Unsubscribe': `<${partnerOneClickUrl(p.id)}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
        });
        if (res.provider !== 'resend') error = 'email is not connected; nothing was delivered';
        else if (!res.ok) {
          error = res.error ?? 'the email service refused the message';
          unconfirmed = res.unconfirmed === true;
        }
        ref = res.providerRef ?? null;
      }
    } catch (e) {
      error = String((e as Error).message ?? e);
    }

    // 3. Record the outcome. If this never runs (a crash, a lost connection) the row stays 'sending', which is treated
    //    as "delivery unknown" and never sent again automatically: at worst one email is lost, never duplicated.
    if (unconfirmed) {
      // No answer came back, so the email may have gone out. The step stays 'sending' for the same reason: it is not
      // 'failed', so nobody is offered "Try again" and it does not count towards the hold after refusals. The email
      // and the reason are kept with it for the partner's page, and nothing more is handed to a service that is not answering.
      await withSystem(async (db) => {
        await db.run("update public.partner_outreach set error = $2, subject = $3, body = $4 where id = $1 and status = 'sending'", [claim.id, error.slice(0, 500), subject, text]);
        await db.run("insert into public.partner_events (org_id, partner_id, kind, summary) values ($1, $2, 'email_unconfirmed', $3)",
          [orgId, p.id, `${label} email: the email service did not answer (${error}`.slice(0, 180) + '), so it may or may not have arrived. It is not sent again. The sequence stopped for this partner.']);
      });
      out.held = 'no_answer';
      break;
    }
    if (error) {
      await withSystem(async (db) => {
        await db.run("update public.partner_outreach set status = 'failed', error = $2, subject = $3, body = $4 where id = $1 and status = 'sending'", [claim.id, error.slice(0, 500), subject, text]);
        await db.run("insert into public.partner_events (org_id, partner_id, kind, summary) values ($1, $2, 'email_failed', $3)",
          [orgId, p.id, `${label} email was not sent: ${error}`.slice(0, 240) + '. The sequence stopped for this partner.']);
      });
      out.failed++;
      // A refusal by this app's own guard says nothing about the email service: no hold, no notification.
      if (guardRefused) continue;
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
