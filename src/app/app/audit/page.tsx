import type { Metadata } from 'next';
import { EmptyState, PageHeader, Pagination } from '@/components/ui';
import { requireStaff } from '@/lib/auth/context';
import { fmtDate, titleCase } from '@/lib/util';

export const metadata: Metadata = { title: 'Audit log' };
const PAGE = 50;

export default async function AuditPage({ searchParams }: { searchParams: Promise<{ page?: string; q?: string }> }) {
  const sp = await searchParams;
  const ctx = await requireStaff('audit:read');
  const page = Math.max(Number(sp.page) || 1, 1);
  const q = sp.q?.trim().slice(0, 60);
  const { rows, total } = await ctx.tx(async (db) => {
    const p: (string | number)[] = [];
    const where = q ? (p.push(`${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`), 'where a.action ilike $1') : '';
    return {
      total: (await db.row<{ n: number }>(`select count(*)::int as n from public.audit_logs a ${where}`, p))?.n ?? 0,
      rows: await db.rows<{ id: number; action: string; entity_type: string | null; ip: string | null; metadata: Record<string, unknown>; created_at: string; actor: string | null }>(
        `select a.id, a.action, a.entity_type, a.ip, a.metadata, a.created_at, coalesce(nullif(u.full_name, ''), u.email) as actor from public.audit_logs a left join public.users u on u.id = a.actor_id ${where} order by a.id desc limit ${PAGE} offset ${(page - 1) * PAGE}`, p),
    };
  });
  const pages = Math.max(1, Math.ceil(total / PAGE));
  return (
    <>
      <PageHeader title="Audit log" subtitle="An append-only record of sensitive actions. It cannot be edited or deleted — not even by administrators." />
      <form method="get" className="mb-4 flex gap-2" role="search"><input name="q" defaultValue={q} placeholder="Filter by action, e.g. dispute. or letter." className="field max-w-sm" aria-label="Filter by action" /><button className="btn-secondary">Filter</button></form>
      {rows.length === 0 ? <EmptyState title="No entries" /> : (
        <div className="table-wrap"><table className="table"><thead><tr><th>When</th><th>Who</th><th>Action</th><th>Details</th><th>IP</th></tr></thead>
          <tbody>{rows.map((r) => (
            <tr key={r.id}><td className="whitespace-nowrap text-muted">{fmtDate(r.created_at)} <span className="text-xs">{new Date(r.created_at).toISOString().slice(11, 16)}Z</span></td><td>{r.actor ?? <span className="text-faint">system</span>}</td>
              <td><code className="rounded bg-raised px-1.5 py-0.5 text-xs">{r.action}</code></td>
              <td className="max-w-xs truncate text-xs text-muted">{r.entity_type ? titleCase(r.entity_type) : ''}{Object.keys(r.metadata).length ? ` · ${Object.entries(r.metadata).map(([k, v]) => `${k}=${String(v)}`).join(' ')}` : ''}</td><td className="text-xs text-muted">{r.ip ?? '—'}</td></tr>))}</tbody></table></div>
      )}
      <Pagination page={page} pages={pages} hrefFor={(p) => `/app/audit?page=${p}${q ? `&q=${encodeURIComponent(q)}` : ''}`} />
    </>
  );
}
