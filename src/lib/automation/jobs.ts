import { refundUnsettled } from '../ai/credits';
import { withSystem, type Db } from '../db';
import { runLeadOutreach, runLeadTexts, TEXT_STEPS_SQL } from '../lead-outreach';
import { runPartnerOutreach } from '../partner-outreach';
import { runClientUpdateJobs, unmatchedInboundCount } from '../client-updates/service';
import { runSweeps, type SweepSummary } from './engine';

export interface JobsResult {
  orgs: number; failures: number; executed: number; pending: number; skipped: number; leadEmails: number;
  /** Follow-up texts to leads who ticked the text-message box on the enquiry form. */ leadTexts: number;
  /** Emails to referral partners (businesses); never a text or a call. */ partnerEmails: number;
  clientUpdates: number;
  /** Organizations whose reminders, lead emails and client updates were not reached before the time ran out. They come first in the next run. */
  notReached: number;
  /** Organizations that still had lead emails or client updates to send when the time ran out. What is left stays queued for a later run. */
  unfinished: number;
  /** True when the outreach pass (lead texts, partner emails) stopped before every organization had its turn. Those left out come first in the next run. */
  outreachCutShort: boolean;
  /** Inbound texts that belong to no workspace and nobody has reviewed (last 30 days). */ unmatchedInboundTexts: number;
  aiRefunds: number; cleaned: Record<string, number>; failed: { orgId: string; error: string }[];
}
type Sweep = (db: Db, actor: { orgId: string; userId: string | null }) => Promise<SweepSummary[]>;

/**
 * How long one run may keep starting new work. The route that calls it is cut off after 60 seconds (maxDuration in
 * src/app/api/jobs/run/route.ts), and an email or a text handed to its service can take up to 15 seconds to come back,
 * so nothing new is started after 40: whatever is in flight still finishes and is recorded.
 */
export const JOBS_DEADLINE_MS = 40_000;

/**
 * The scheduled work, shared by POST /api/jobs/run and `npm run jobs:run`.
 *
 * Two passes, in that order, so that outreach can never hold up what a client or a lead is waiting for:
 *   1. every organization's deadline sweeps, lead follow-up emails and client updates;
 *   2. then outreach: follow-up texts to leads and the email sequence to referral partners.
 * Each pass takes the organizations in the order of who has waited longest: pass 1 by when their scheduled work last
 * ran (never, first), pass 2 by when their outreach last went out. So when a run does run out of time, it is never
 * the same organizations that go without: whoever was left out is first in the next run. A pass stops starting work
 * at the deadline, and what was not reached is counted in the result. The deadline holds inside an organization's own
 * work too: its lead emails and client updates stop being claimed once it has passed, so one organization with a long
 * queue cannot carry the run past it. What it has left stays queued for a later run and is counted (`unfinished`).
 *
 * - Each organization runs in its own transaction, so one organization's failure cannot stop or roll back another's.
 * - Safe to retry: automation runs are unique per (automation, subject, cooldown bucket), so running this twice
 *   creates no duplicate tasks, messages or notifications.
 * - Automatic follow-up to consenting leads runs per organization too: each (lead, step) is sent once, and nothing is
 *   sent or recorded unless the agency switched it on and email is really connected (src/lib/lead-outreach.ts).
 *   The same holds for the email sequence to referral partners (src/lib/partner-outreach.ts). Nothing here needs a
 *   person to approve a message, and nothing here texts or calls a partner.
 * - Failures are never silent: each one is written to job_runs (shown on the Automations page) and the
 *   organization's owners and admins get an in-app notification — at most one per day while it keeps failing.
 * - The clean-up at the end (unsettled AI charges, expired credentials) always runs: it is not behind the deadline.
 */
export async function runScheduledJobs(opts: {
  sweep?: Sweep; onlyOrgIds?: string[];
  /** Tests only: the moment the lead texts and partner emails are judged at (quiet hours, business days). */ now?: Date;
  /** Tests only: how long the run may keep starting work (default JOBS_DEADLINE_MS). */ deadlineMs?: number;
} = {}): Promise<JobsResult> {
  const sweep = opts.sweep ?? runSweeps;
  const listed = await withSystem((db) => db.rows<{ id: string; last_run: string | null; last_outreach: string | null }>(
    `select o.id,
            (select max(j.started_at) from public.job_runs j where j.org_id = o.id) as last_run,
            greatest((select max(p.claimed_at) from public.partner_outreach p where p.org_id = o.id),
                     (select max(l.created_at) from public.lead_outreach l where l.org_id = o.id and l.step in (${TEXT_STEPS_SQL}))) as last_outreach
       from public.organizations o where o.status = 'active' and ($1::uuid[] is null or o.id = any($1)) order by o.created_at`, [opts.onlyOrgIds ?? null]));
  // Longest wait first (the sort is stable, so organizations that tie stay in the order they were created).
  const longestWaitFirst = (key: 'last_run' | 'last_outreach') => [...listed].sort((a, b) => (a[key] ? new Date(a[key]!).getTime() : 0) - (b[key] ? new Date(b[key]!).getTime() : 0));
  const orgs = longestWaitFirst('last_run');
  const stopAt = Date.now() + (opts.deadlineMs ?? JOBS_DEADLINE_MS);
  const out: JobsResult = { orgs: orgs.length, failures: 0, executed: 0, pending: 0, skipped: 0, leadEmails: 0, leadTexts: 0, partnerEmails: 0, clientUpdates: 0, notReached: 0, unfinished: 0, outreachCutShort: false, unmatchedInboundTexts: 0, aiRefunds: 0, cleaned: {}, failed: [] };

  const fail = async (orgId: string, started: Date, e: unknown) => {
    const error = String((e as Error).message ?? e).slice(0, 1000);
    out.failures++;
    out.failed.push({ orgId, error });
    console.error('[jobs] organization failed', orgId, error);
    await withSystem(async (db) => {
      await db.run("insert into public.job_runs (org_id, started_at, finished_at, status, error) values ($1, $2, now(), 'failed', $3)", [orgId, started, error]);
      const already = await db.row('select 1 from public.notifications where org_id = $1 and title = $2 and created_at > now() - interval \'1 day\' limit 1', [orgId, 'Scheduled jobs failed']);
      if (!already) {
        await db.run(
          `insert into public.notifications (org_id, user_id, title, body, href)
           select $1, m.user_id, 'Scheduled jobs failed', $2, '/app/automations' from public.memberships m where m.org_id = $1 and m.role in ('owner', 'admin')`,
          [orgId, `Reminders and deadline checks did not run: ${error}`.slice(0, 1000)]);
      }
    }).catch((err) => console.error('[jobs] could not record the failure', orgId, (err as Error).message));
  };

  // ---- Pass 1: what clients and leads are waiting for.
  const failedHere = new Set<string>();
  for (const o of orgs) {
    if (Date.now() > stopAt) { out.notReached++; continue; }
    const started = new Date();
    try {
      const sums = await withSystem((db) => sweep(db, { orgId: o.id, userId: null }));
      const t = sums.reduce((a, s) => ({ executed: a.executed + s.executed, pending: a.pending + s.pending, skipped: a.skipped + s.skipped }), { executed: 0, pending: 0, skipped: 0 });
      out.executed += t.executed; out.pending += t.pending; out.skipped += t.skipped;
      // Both stop claiming at the run's deadline, like the outreach below: a send in flight finishes, the rest waits.
      const leads = await runLeadOutreach(o.id, { stopAt });
      out.leadEmails += leads.sent;
      // Client updates by text and email: queue investigation windows that ended, send what is due (src/lib/client-updates/service.ts).
      const updates = await runClientUpdateJobs(o.id, { stopAt });
      out.clientUpdates += updates.sent;
      if (leads.held === 'time' || updates.held === 'time') out.unfinished++;
      await withSystem((db) => db.run("insert into public.job_runs (org_id, started_at, finished_at, status, executed, pending, skipped) values ($1, $2, now(), 'ok', $3, $4, $5)", [o.id, started, t.executed, t.pending, t.skipped]));
    } catch (e) {
      failedHere.add(o.id);
      await fail(o.id, started, e);
    }
  }
  if (out.notReached) console.warn(`[jobs] ${out.notReached} organization(s) were not reached before the time ran out; they come first in a later run`);
  if (out.unfinished) console.warn(`[jobs] ${out.unfinished} organization(s) still had lead emails or client updates to send when the time ran out; what is left stays queued for a later run`);

  // ---- Pass 2: outreach. Only with time left, one organization after another, each stopping at the same deadline.
  for (const o of longestWaitFirst('last_outreach')) {
    if (Date.now() > stopAt) { out.outreachCutShort = true; break; }
    if (failedHere.has(o.id)) continue;
    const started = new Date();
    try {
      // Text follow-up for leads with a text consent from the enquiry form; nobody else is texted (src/lib/lead-outreach.ts).
      out.leadTexts += (await runLeadTexts(o.id, { now: opts.now, stopAt })).sent;
      // The email sequence to referral partners, when the agency switched it on (src/lib/partner-outreach.ts).
      out.partnerEmails += (await runPartnerOutreach(o.id, { now: opts.now, stopAt })).sent;
    } catch (e) {
      await fail(o.id, started, e);
    }
  }

  // AI charges whose request died before an outcome was recorded are given back (src/lib/ai/credits.ts).
  out.aiRefunds = await refundUnsettled().catch((e) => { console.error('[jobs] AI credit sweep failed', (e as Error).message); return 0; });
  // Texts that reached the webhook but belong to no workspace are on no tenant's screen: say how many, so an operator looks.
  out.unmatchedInboundTexts = await unmatchedInboundCount().catch(() => 0);
  if (out.unmatchedInboundTexts) console.warn(`[jobs] ${out.unmatchedInboundTexts} inbound text(s) matched no single workspace and are unreviewed (public.sms_inbound where org_id is null)`);
  out.cleaned = await withSystem(async (db) => ({
    sessions: await db.run("delete from public.sessions where expires_at < now() - interval '7 days' or revoked_at < now() - interval '7 days'"),
    resets: await db.run("delete from public.password_resets where expires_at < now() - interval '1 day'"),
    invites: await db.run("delete from public.invites where expires_at < now() - interval '30 days' and accepted_at is null"),
    rateLimits: await db.run("delete from public.rate_limits where window_start < now() - interval '1 day'"),
    jobRuns: await db.run("delete from public.job_runs where started_at < now() - interval '90 days'"),
  }));
  return out;
}
