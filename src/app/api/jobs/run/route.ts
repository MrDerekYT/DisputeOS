import { NextResponse } from 'next/server';
import { runScheduledJobs } from '@/lib/automation/jobs';
import { safeEqual } from '@/lib/crypto';
import { getEnv } from '@/lib/env';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Scheduled work: automation sweeps for every active organization, plus housekeeping of expired credentials.
 * Call from your host's scheduler: POST /api/jobs/run  with  Authorization: Bearer $CRON_SECRET
 * (or `npm run jobs:run`, which makes exactly this call). Disabled (404) when CRON_SECRET is not configured.
 * Answers 200 even when an organization's jobs failed; the body lists the failures and `failures` counts them.
 */
export async function POST(req: Request) {
  const secret = getEnv().CRON_SECRET;
  if (!secret) return new NextResponse('Not found', { status: 404 });
  const given = /^Bearer (.+)$/.exec(req.headers.get('authorization') ?? '')?.[1] ?? '';
  if (!safeEqual(given, secret)) return new NextResponse('Unauthorized', { status: 401 });
  const r = await runScheduledJobs();
  return NextResponse.json({ ...r, ran: r.executed + r.pending });
}
