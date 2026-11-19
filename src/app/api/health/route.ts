import { NextResponse } from 'next/server';
import { withSystem } from '@/lib/db';

export const dynamic = 'force-dynamic';

const answer = (ok: boolean) => NextResponse.json({ ok }, { status: ok ? 200 : 503, headers: { 'cache-control': 'no-store' } });

/**
 * Liveness/readiness probe for load balancers and uptime monitors. Unauthenticated and side-effect free:
 * it checks that the database answers and that the row-level-security role exists, and says nothing else
 * (no version, no configuration, no error text).
 */
export async function GET() {
  try {
    const r = await withSystem((db) => db.row<{ ok: boolean }>("select exists (select 1 from pg_roles where rolname = 'disputeos_rls') as ok"));
    return answer(r?.ok === true);
  } catch {
    return answer(false);
  }
}
