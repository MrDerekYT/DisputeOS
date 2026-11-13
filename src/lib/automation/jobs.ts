import { withSystem, type Db } from '../db';
import { runSweeps, type SweepSummary } from './engine';

export interface JobsResult { orgs: number; failures: number; executed: number; pending: number; skipped: number; cleaned: Record<string, number>; failed: { orgId: string; error: string }[] }
type Sweep = (db: Db, actor: { orgId: string; userId: string | null }) => Promise<SweepSummary[]>;

/**
 * The scheduled work, shared by POST /api/jobs/run and `npm run jobs:run`.
 *
 * - Each organization runs in its own transaction, so one organization's failure cannot stop or roll back another's.
 * - Safe to retry: automation runs are unique per (automation, subject, cooldown bucket), so running this twice
 *   creates no duplicate tasks, messages or notifications.
 * - Failures are never silent: each one is written to job_runs (shown on the Automations page) and the
 *   organization's owners and admins get an in-app notification — at most one per day while it keeps failing.
 */
export async function runScheduledJobs(opts: { sweep?: Sweep; onlyOrgIds?: string[] } = {}): Promise<JobsResult> {
  const sweep = opts.sweep ?? runSweeps;
  const orgs = await withSystem((db) => db.rows<{ id: string }>(
    "select id from public.organizations where status = 'active' and ($1::uuid[] is null or id = any($1)) order by created_at", [opts.onlyOrgIds ?? null]));
  const out: JobsResult = { orgs: orgs.length, failures: 0, executed: 0, pending: 0, skipped: 0, cleaned: {}, failed: [] };
  for (const o of orgs) {
    const started = new Date();
    try {
      const sums = await withSystem((db) => sweep(db, { orgId: o.id, userId: null }));
      const t = sums.reduce((a, s) => ({ executed: a.executed + s.executed, pending: a.pending + s.pending, skipped: a.skipped + s.skipped }), { executed: 0, pending: 0, skipped: 0 });
      out.executed += t.executed; out.pending += t.pending; out.skipped += t.skipped;
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
  out.cleaned = await withSystem(async (db) => ({
    sessions: await db.run("delete from public.sessions where expires_at < now() - interval '7 days' or revoked_at < now() - interval '7 days'"),
    resets: await db.run("delete from public.password_resets where expires_at < now() - interval '1 day'"),
    invites: await db.run("delete from public.invites where expires_at < now() - interval '30 days' and accepted_at is null"),
    rateLimits: await db.run("delete from public.rate_limits where window_start < now() - interval '1 day'"),
    jobRuns: await db.run("delete from public.job_runs where started_at < now() - interval '90 days'"),
  }));
  return out;
}
