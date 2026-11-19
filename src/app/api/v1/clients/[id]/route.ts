import { notFound, ok, withApi } from '@/lib/api/route';
import { isUuid } from '@/lib/util';

export const dynamic = 'force-dynamic';

export function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withApi(req, 'clients:read', async (c) => {
    const { id } = await params;
    if (!isUuid(id)) return notFound();
    const out = await c.tx(async (db) => {
      const client = await db.row('select id, full_name, email, phone, status, stage, preferred_language, source, tags, created_at from public.clients where id = $1', [id]);
      if (!client) return null;
      const reports = await db.rows('select id, bureau, status, source, report_date, created_at from public.credit_reports where client_id = $1 order by created_at desc', [id]);
      const scores = await db.rows('select bureau, model, score, scored_on from public.credit_scores where client_id = $1 order by scored_on desc', [id]);
      const disputes = await db.rows('select id, item_label, status, round, outcome, due_at from public.disputes where client_id = $1 order by created_at desc', [id]);
      return { ...client, reports, scores, disputes };
    });
    return out ? ok(out) : notFound();
  });
}
