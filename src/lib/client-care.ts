import type { Db } from './db';

/** Live client-care queues, read under the staff member's own row-level security (specialists see only their clients). */
export async function clientCare(db: Db) {
  const [messages, uploads, quiet, leads] = await Promise.all([
    db.rows<{ id: string; client_id: string; client_name: string; body: string; created_at: string; hours: number; n: number }>(
      `select m.id, m.client_id, c.full_name as client_name, left(m.body, 140) as body, m.created_at, (extract(epoch from now() - m.created_at) / 3600)::int as hours, count(*) over ()::int as n
         from public.communications m join public.clients c on c.id = m.client_id
        where m.direction = 'inbound' and m.read_at is null order by m.created_at limit 5`),
    db.rows<{ id: string; client_id: string; client_name: string; file_name: string; created_at: string; hours: number; n: number }>(
      `select d.id, d.client_id, c.full_name as client_name, d.file_name, d.created_at, (extract(epoch from now() - d.created_at) / 3600)::int as hours, count(*) over ()::int as n
         from public.documents d join public.clients c on c.id = d.client_id
        where d.source = 'client' and d.review_status = 'pending_review' order by d.created_at limit 5`),
    db.rows<{ id: string; full_name: string; last_contact: string | null; days: number; n: number }>(
      `select c.id, c.full_name, max(o.created_at) as last_contact,
              (extract(epoch from now() - coalesce(max(o.created_at), c.created_at)) / 86400)::int as days, count(*) over ()::int as n
         from public.clients c left join public.communications o on o.client_id = c.id and o.direction = 'outbound'
        where c.status in ('onboarding', 'active')
        group by c.id
       having coalesce(max(o.created_at), c.created_at) < now() - interval '14 days'
        order by coalesce(max(o.created_at), c.created_at) limit 5`),
    db.rows<{ id: string; full_name: string; source: string | null; created_at: string; hours: number; n: number }>(
      `select c.id, c.full_name, c.source, c.created_at, (extract(epoch from now() - c.created_at) / 3600)::int as hours, count(*) over ()::int as n
         from public.clients c
        where c.status = 'lead' and not exists (select 1 from public.communications o where o.client_id = c.id and o.direction = 'outbound')
        order by c.created_at desc limit 5`),
  ]);
  const n = (r: { n: number }[]) => r[0]?.n ?? 0;
  return { messages, uploads, quiet, leads, counts: { messages: n(messages), uploads: n(uploads), quiet: n(quiet), leads: n(leads) }, total: n(messages) + n(uploads) + n(quiet) + n(leads) };
}
