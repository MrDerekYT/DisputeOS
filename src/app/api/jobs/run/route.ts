import { NextResponse } from 'next/server';
import { runSweeps } from '@/lib/automation/engine';
import { safeEqual } from '@/lib/crypto';
import { withSystem } from '@/lib/db';
import { getEnv } from '@/lib/env';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Scheduled work: automation sweeps for every active organization, plus housekeeping of expired credentials.
 * Call from your host's scheduler: POST /api/jobs/run  with  Authorization: Bearer $CRON_SECRET
 * The endpoint is disabled (404) when CRON_SECRET is not configured.
 */
export async function POST(req: Request) {
  const secret = getEnv().CRON_SECRET;
  if (!secret) return new NextResponse('Not found', { status: 404 });
  const given = /^Bearer (.+)$/.exec(req.headers.get('authorization') ?? '')?.[1] ?? '';
  if (!safeEqual(given, secret)) return new NextResponse('Unauthorized', { status: 401 });

  const orgs = await withSystem((db) => db.rows<{ id: string }>("select id from public.organizations where status = 'active'"));
  const results: Record<string, { automation: string; executed: number; pending: number; skipped: number; capped: boolean }[]> = {};
  let failures = 0;
  for (const o of orgs) {
    try { results[o.id] = await withSystem((db) => runSweeps(db, { orgId: o.id, userId: null })); } catch (e) { failures++; console.error('[jobs] org failed', o.id, (e as Error).message); }
  }
  const cleaned = await withSystem(async (db) => ({
    sessions: await db.run("delete from public.sessions where expires_at < now() - interval '7 days' or revoked_at < now() - interval '7 days'"),
    resets: await db.run("delete from public.password_resets where expires_at < now() - interval '1 day'"),
    invites: await db.run("delete from public.invites where expires_at < now() - interval '30 days' and accepted_at is null"),
    rateLimits: await db.run("delete from public.rate_limits where window_start < now() - interval '1 day'"),
  }));
  return NextResponse.json({ orgs: orgs.length, failures, cleaned, ran: Object.values(results).reduce((a, r) => a + r.reduce((b, s) => b + s.executed + s.pending, 0), 0) });
}
