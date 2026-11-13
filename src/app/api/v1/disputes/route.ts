import { ok, withApi } from '@/lib/api/route';
import { isUuid } from '@/lib/util';

export const dynamic = 'force-dynamic';

export function GET(req: Request) {
  return withApi(req, 'disputes:read', async (c) => {
    const q = c.url.searchParams;
    const limit = Math.min(Math.max(Number(q.get('limit')) || 25, 1), 100);
    const offset = Math.max(Number(q.get('offset')) || 0, 0);
    const where: string[] = [];
    const p: string[] = [];
    if (q.get('client_id') && isUuid(q.get('client_id'))) { p.push(q.get('client_id')!); where.push(`client_id = $${p.length}`); }
    if (q.get('status')) { p.push(q.get('status')!); where.push(`status = $${p.length}`); }
    const w = where.length ? `where ${where.join(' and ')}` : '';
    const data = await c.tx((db) => db.rows(
      `select id, client_id, item_label, category, bureau, status, round, submitted_at, due_at, outcome, response_at, created_at from public.disputes ${w} order by created_at desc limit ${limit} offset ${offset}`, p));
    return ok({ data, limit, offset });
  });
}
