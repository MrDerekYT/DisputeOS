import { refundUnsettled } from '../ai/credits';
import { withSystem, type Db } from '../db';
import { runLeadOutreach } from '../lead-outreach';
import { runClientUpdateJobs, unmatchedInboundCount } from '../client-updates/service';
import { runSweeps, type SweepSummary } from './engine';

export interface JobsResult { orgs: number; failures: number; executed: number; pending: number; skipped: number; leadEmails: number; clientUpdates: number; /** Inbound texts that belong to no workspace and nobody has reviewed (last 30 days). */ unmatchedInboundTexts: number; aiRefunds: number; cleaned: Record<string, number>; failed: { orgId: string; error: string }[] }
type Sweep = (db: Db, actor: { orgId: string; userId: string | null }) => Promise<SweepSummary[]>;

/**
 * The scheduled work, shared by POST /api/jobs/run and `npm run jobs:run`.
 *
 * - Each organization runs in its own transaction, so one organization's failure cannot stop or roll back another's.
 * - Safe to retry: automation runs are unique per (automation, subject, cooldown bucket), so running this twice
 *   creates no duplicate tasks, messages or notifications.
 * - Automatic follow-up to consenting leads runs per organization too: each (lead, step) is sent once, and nothing is
 *   sent or recorded unless the agency switched it on and email is really connected (src/lib/lead-outreach.ts).
 * - Failures are never silent: each one is written to job_runs (shown on the Automations page) and the
 *   organization's owners and admins get an in-app notification — at most one per day while it keeps failing.
 */
export async function runScheduledJobs(opts: { sweep?: Sweep; onlyOrgIds?: string[] } = {}): Promise<JobsResult> {
  const sweep = opts.sweep ?? runSweeps;
  const orgs = await withSystem((db) => db.rows<{ id: string }>(
    "select id from public.organizations where status = 'active' and ($1::uuid[] is null or id = any($1)) order by created_at", [opts.onlyOrgIds ?? null]));
  const out: JobsResult = { orgs: orgs.length, failures: 0, executed: 0, pending: 0, skipped: 0, leadEmails: 0, clientUpdates: 0, unmatchedInboundTexts: 0, aiRefunds: 0, cleaned: {}, failed: [] };
  for (const o of orgs) {
    const started = new Date();
    try {
      const sums = await withSystem((db) => sweep(db, { orgId: o.id, userId: null }));
      const t = sums.reduce((a, s) => ({ executed: a.executed + s.executed, pending: a.pending + s.pending, skipped: a.skipped + s.skipped }), { executed: 0, pending: 0, skipped: 0 });
      out.executed += t.executed; out.pending += t.pending; out.skipped += t.skipped;
      out.leadEmails += (await runLeadOutreach(o.id)).sent;
      // Client updates by text and email: queue investigation windows that ended, send what is due (src/lib/client-updates/service.ts).
      out.clientUpdates += (await runClientUpdateJobs(o.id)).sent;
      await withSystem((db) => db.run("insert into public.job_runs (org_id, started_at, finished_at, status, executed, pending, skipped) values ($1, $2, now(), 'ok', $3, $4, $5)", [o.id, started, t.executed, t.pending, t.skipped]));
    } catch (e) {
      const error = String((e as Error).message ?? e).slice(0, 1000);
      out.failures++;
      out.failed.push({ orgId: o.id, error });
      console.error('[jobs] organization failed', o.id, error);
      await withSystem(async (db) => {
        await db.run("insert into public.job_runs (org_id, started_at, finished_at, status, error) values ($1, $2, now(), 'failed', $3)", [o.id, started, error]);
        const already = await db.row('select 1 from public.notifications where org_id = $1 and title = $2 and created_at > now() - interval \'1 day\' limit 1', [o.id, 'Scheduled jobs failed']);
        if (!already) {
          await db.run(
            `insert into public.notifications (org_id, user_id, title, body, href)
             select $1, m.user_id, 'Scheduled jobs failed', $2, '/app/automations' from public.memberships m where m.org_id = $1 and m.role in ('owner', 'admin')`,
            [o.id, `Reminders and deadline checks did not run: ${error}`.slice(0, 1000)]);
        }
      }).catch((err) => console.error('[jobs] could not record the failure', o.id, (err as Error).message));
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
