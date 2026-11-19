import { createHmac } from 'node:crypto';
import { audit } from './audit';
import { assertNoBlockedClaims } from './compliance/claims';
import { safeEqual } from './crypto';
import { withSystem } from './db';
import { getEnv } from './env';
import { decideLeadStep, leadEmail, LEAD_MAX_ATTEMPTS, LEAD_STEPS, LEAD_WINDOW_DAYS, type LeadOutreachState, type LeadStep } from './lead-emails';
import { sendEmail, type Email, type SendResult } from './mailer';
import { isUuid } from './util';

/** Agency-level switch and the details every automatic lead email needs. Stored in organizations.settings. */
export interface OutreachSettings { enabled: boolean; since: string | null; address: string; replyTo: string }
export function outreachSettings(settings: Record<string, unknown> | null | undefined): OutreachSettings {
  const s = settings ?? {};
  const str = (k: string) => (typeof s[k] === 'string' ? (s[k] as string).trim() : '');
  return { enabled: s.lead_followup_enabled === true, since: str('lead_followup_since') || null, address: str('lead_mailing_address'), replyTo: str('lead_reply_email') };
}

/** True only when email really leaves the building. The `log` driver writes to a file and delivers nothing. */
export function emailIsLive(): boolean {
  const env = getEnv();
  return env.EMAIL_DRIVER === 'resend' && !!env.RESEND_API_KEY;
}

export type OutreachBlocker = 'off' | 'no_address' | 'no_reply' | 'email_not_connected';
/** Why nothing automatic is being sent, or null when it is. */
export function outreachBlocker(s: OutreachSettings, live: boolean): OutreachBlocker | null {
  if (!s.enabled || !s.since) return 'off';
  if (!s.address) return 'no_address';
  if (!s.replyTo) return 'no_reply';
  if (!live) return 'email_not_connected';
  return null;
}

// ---------------------------------------------------------------- opt-out link (signed, no sign-in)
const sign = (clientId: string) => createHmac('sha256', Buffer.from(getEnv().PII_ENCRYPTION_KEY, 'base64')).update(`lead-opt-out:${clientId}`).digest('base64url');
export const optOutToken = (clientId: string) => `${clientId}-${sign(clientId)}`;
export const optOutUrl = (clientId: string) => `${getEnv().APP_URL}/unsubscribe/${optOutToken(clientId)}`;
export function verifyOptOutToken(token: string): string | null {
  const id = token.slice(0, 36);
  if (!isUuid(id) || token[36] !== '-') return null;
  return safeEqual(token.slice(37), sign(id)) ? id : null;
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

// ---------------------------------------------------------------- lead state (shared by the job and the Leads page)
/**
 * A communication row (alias `m`) that counts as the team being in touch: sent or logged by the team, and not an email
 * the provider refused ('failed') or one written to the log because no email service is connected ('queued').
 */
export const DELIVERED_BY_TEAM_SQL = "m.direction <> 'inbound' and m.status not in ('failed', 'queued', 'draft', 'pending_approval')";
/** Columns that describe where a lead (alias `c`) stands with automatic follow-up; feed the row to `leadState`. */
export const LEAD_STATE_SQL = `
  c.status, c.created_at, (c.email is not null) as has_email, (c.outreach_opt_out_at is not null) as opted_out,
  exists (select 1 from public.client_events e where e.client_id = c.id and e.kind = 'lead_created' and e.meta->>'contact_consent' = 'true') as consented,
  exists (select 1 from public.communications m where m.client_id = c.id and m.direction = 'inbound') as replied,
  exists (select 1 from public.communications m where m.client_id = c.id and ${DELIVERED_BY_TEAM_SQL}
            and not exists (select 1 from public.lead_outreach o where o.communication_id = m.id)) as contacted,
  coalesce((select jsonb_agg(jsonb_build_object('step', o.step, 'status', o.status, 'attempts', o.attempts, 'at', coalesce(o.sent_at, o.created_at)))
              from public.lead_outreach o where o.client_id = c.id), '[]'::jsonb) as outreach`;
export interface LeadStateRow { status: string; created_at: string; has_email: boolean; opted_out: boolean; consented: boolean; replied: boolean; contacted: boolean; outreach: LeadOutreachState['outreach'] }
export const leadState = (r: LeadStateRow, since: string | null): LeadOutreachState => ({
  status: r.status, hasEmail: r.has_email, consented: r.consented, optedOut: r.opted_out, replied: r.replied, contacted: r.contacted, receivedAt: r.created_at, eligibleFrom: since, outreach: r.outreach,
});

// ---------------------------------------------------------------- sending
export interface OutreachResult { sent: number; failed: number; blocked: OutreachBlocker | null }
export interface OutreachOptions {
  /** Only this lead (the welcome right after an enquiry). */
  clientId?: string;
  now?: Date;
  /** Tests only: stand in for a connected email service. */
  live?: boolean;
  send?: (mail: Email) => Promise<SendResult>;
}
const MAX_EMAILS_PER_RUN = 50;
const STEP_LABEL = Object.fromEntries(LEAD_STEPS.map((s) => [s.key, s.label])) as Record<LeadStep, string>;

/**
 * Sends whichever automatic email each consenting lead of one agency is due — at most one per lead per call.
 * Nothing is sent, and nothing is recorded as sent, unless the agency switched follow-up on, saved a postal address
 * and a reply address, and email is really connected. Safe to run twice or concurrently: each (lead, step) is
 * claimed through a unique key, and the claim is committed before the email is handed to the email service.
 */
export async function runLeadOutreach(orgId: string, opts: OutreachOptions = {}): Promise<OutreachResult> {
  const now = opts.now ?? new Date();
  const org = await withSystem((db) => db.row<{ name: string; settings: Record<string, unknown> }>(
    "select name, settings from public.organizations where id = $1 and status = 'active' and mode = 'agency'", [orgId]));
  if (!org) return { sent: 0, failed: 0, blocked: 'off' };
  const settings = outreachSettings(org.settings);
  const blocked = outreachBlocker(settings, opts.live ?? emailIsLive());
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
    const step = d.step;

    // 1. Claim the step in its own short transaction, so the claim is on record before anything is handed to the email
    //    service. Every stop condition is checked again here, under a row lock: the list above may be minutes old.
    const claim = await withSystem(async (db) => {
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
    if (!claim) continue;

    // 2. Send outside any transaction: no lock or pooled connection is held while waiting on the email service.
    let mail: Email | null = null;
    let error = '';
    let ref: string | null = null;
    try {
      const m = leadEmail(step, claim.lead.preferred_language === 'es' ? 'es' : 'en', { firstName: claim.lead.full_name, orgName: org.name, address: settings.address, optOutUrl: optOutUrl(l.id) });
      assertNoBlockedClaims(`${m.subject}\n${m.text}`);
      mail = { to: claim.lead.email, subject: m.subject, text: m.text, replyTo: settings.replyTo, fromName: org.name };
      const res = await (opts.send ?? sendEmail)(mail);
      if (res.provider === 'log') error = 'Email is not connected; nothing was delivered.';
      else if (!res.ok) error = res.error ?? 'The email service refused the message.';
      ref = res.providerRef ?? null;
    } catch (e) {
      error = String((e as Error).message ?? e);
    }

    // 3. Record the outcome. If this never runs (a crash, a lost connection) the row stays 'sending', which is treated
    //    as "delivery unknown" and never sent again automatically: at worst one email is lost, never duplicated.
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
