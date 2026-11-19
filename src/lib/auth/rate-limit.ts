import { withSystem } from '../db';

export interface LimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSec: number;
}

/**
 * Fixed-window counter in Postgres, so limits hold across serverless instances and restarts.
 * `key` should combine the action and the subject, e.g. `login:ip:1.2.3.4` or `login:email:a@b.com`.
 */
export async function rateLimit(key: string, limit: number, windowSec: number, nowMs = Date.now()): Promise<LimitResult> {
  const bucket = Math.floor(nowMs / 1000 / windowSec);
  const windowStart = new Date(bucket * windowSec * 1000);
  const hits = await withSystem(async (db) => {
    const r = await db.row<{ hits: number }>(
      `insert into public.rate_limits (key, window_start, hits) values ($1, $2, 1)
       on conflict (key, window_start) do update set hits = public.rate_limits.hits + 1
       returning hits`,
      [key, windowStart],
    );
    // opportunistic cleanup keeps the table small
    if (Math.random() < 0.02) await db.run(`delete from public.rate_limits where window_start < now() - interval '1 day'`);
    return r?.hits ?? 1;
  });
  const resetAt = (bucket + 1) * windowSec * 1000;
  return { allowed: hits <= limit, remaining: Math.max(0, limit - hits), retryAfterSec: Math.max(1, Math.ceil((resetAt - nowMs) / 1000)) };
}
