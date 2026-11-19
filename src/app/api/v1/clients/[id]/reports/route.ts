import { ingestInbound } from '@/lib/credit/pull';
import { getEnv } from '@/lib/env';
import { notFound, ok, withApi } from '@/lib/api/route';
import { isUuid } from '@/lib/util';

export const dynamic = 'force-dynamic';

/**
 * Push normalized credit reports for a client (from a provider webhook, Zapier, or your own system).
 * Requires the client's written FCRA authorization to be on file. Reports land in "pending review": a person must
 * approve them before anything is analysed or disputed.
 */
export function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withApi(req, 'reports:write', async (c) => {
    const { id } = await params;
    if (!isUuid(id)) return notFound();
    const body = await c.json();
    const r = await c.tx((db) => ingestInbound(db, c.actor, id, body));
    return ok({
      pull_id: r.pullId, report_ids: r.reportIds, status: 'pending_review',
      review_urls: r.reportIds.map((rid) => `${getEnv().APP_URL}/app/reports/${rid}`),
      note: 'A team member must review and approve these reports before they are analysed.',
    }, 201);
  });
}
