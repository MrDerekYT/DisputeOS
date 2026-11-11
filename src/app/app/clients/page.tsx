import Link from 'next/link';
import type { Metadata } from 'next';
import { Plus, Search } from 'lucide-react';
import { Avatar, EmptyState, PageHeader, Pagination, StatusBadge, Badge } from '@/components/ui';
import { requireStaff } from '@/lib/auth/context';
import { listClients, SEGMENTS, STAGE_LABEL, CLIENT_STATUSES, staffMembers, memberLabel } from '@/lib/crm';
import { relTime } from '@/lib/util';

export const metadata: Metadata = { title: 'Clients' };
const PAGE_SIZE = 25;

export default async function ClientsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const ctx = await requireStaff('clients:read');
  const page = Math.max(Number(sp.page) || 1, 1);
  const { rows, total, team, segmentCounts } = await ctx.tx(async (db) => {
    const r = await listClients(db, { q: sp.q, status: sp.status, segment: sp.segment, assignee: sp.assignee, page, pageSize: PAGE_SIZE, userId: ctx.userId });
    const team = await staffMembers(db);
    const sc = await db.row<Record<string, number>>(
      `select count(*)::int as all,
              count(*) filter (where assigned_to = $1)::int as mine,
              count(*) filter (where status in ('lead','onboarding'))::int as onboarding,
              count(*) filter (where exists (select 1 from public.document_requests r where r.client_id = c.id and r.fulfilled_document_id is null))::int as needs_docs,
              count(*) filter (where exists (select 1 from public.disputes d where d.client_id = c.id and d.status in ('submitted','under_investigation','response_received')))::int as active_disputes,
              count(*) filter (where status = 'active' and last_activity_at < now() - interval '30 days')::int as inactive,
              count(*) filter (where assigned_to is null)::int as unassigned
         from public.clients c`, [ctx.userId]);
    return { ...r, team, segmentCounts: sc ?? {} };
  });
  const segment = sp.segment ?? 'all';
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const qs = (over: Record<string, string | undefined>) => {
    const u = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...sp, ...over })) if (v) u.set(k, v);
    return `/app/clients?${u.toString()}`;
  };

  return (
    <>
      <PageHeader
        title="Clients"
        subtitle={`${segmentCounts.all ?? 0} in your workspace`}
        actions={<Link href="/app/clients/new" className="btn-primary"><Plus size={16} /> New client</Link>}
      />

      <div className="-mx-1 mb-4 flex gap-2 overflow-x-auto px-1 pb-1" role="tablist" aria-label="Segments">
        {SEGMENTS.map((s) => (
          <Link key={s.key} href={qs({ segment: s.key === 'all' ? undefined : s.key, page: undefined })} role="tab" aria-selected={segment === s.key}
            className={`flex shrink-0 items-center gap-2 rounded-full border px-3.5 py-1.5 text-sm font-medium transition ${segment === s.key ? 'border-brand bg-brand-soft text-brand-strong' : 'border-line bg-surface text-muted hover:text-ink'}`}>
            {s.label}
            <span className="text-xs tabular-nums opacity-70">{segmentCounts[s.key === 'active_disputes' ? 'active_disputes' : s.key === 'needs_docs' ? 'needs_docs' : s.key] ?? 0}</span>
          </Link>
        ))}
      </div>

      <form method="get" className="mb-4 flex flex-wrap items-center gap-3" role="search">
        {sp.segment && <input type="hidden" name="segment" value={sp.segment} />}
        <div className="relative min-w-[14rem] flex-1">
          <Search size={16} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-faint" aria-hidden />
          <input name="q" defaultValue={sp.q} placeholder="Search by name, email or phone" className="field pl-10" aria-label="Search clients" />
        </div>
        <select name="status" defaultValue={sp.status ?? ''} className="field !w-auto" aria-label="Status">
          <option value="">Any status</option>
          {CLIENT_STATUSES.map((s) => <option key={s} value={s}>{s.replace(/^\w/, (c) => c.toUpperCase())}</option>)}
        </select>
        <select name="assignee" defaultValue={sp.assignee ?? ''} className="field !w-auto" aria-label="Assigned to">
          <option value="">Anyone</option>
          <option value="none">Unassigned</option>
          {team.map((m) => <option key={m.id} value={m.id}>{memberLabel(m)}</option>)}
        </select>
        <button className="btn-secondary" type="submit">Filter</button>
        {(sp.q || sp.status || sp.assignee) && <Link href="/app/clients" className="btn-ghost">Clear</Link>}
      </form>

      {rows.length === 0 ? (
        <EmptyState
          title={sp.q || sp.status || sp.segment ? 'No clients match these filters' : 'No clients yet'}
          body={sp.q || sp.status || sp.segment ? 'Try a different search or clear the filters.' : 'Add your first client to start tracking their credit repair journey.'}
          action={<Link href="/app/clients/new" className="btn-primary">Add a client</Link>}
        />
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr><th>Client</th><th>Status</th><th>Stage</th><th>Specialist</th><th className="text-right">Active disputes</th><th>Last activity</th></tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.id} className="row-link">
                  <td>
                    <Link href={`/app/clients/${c.id}`} className="flex items-center gap-3">
                      <Avatar name={c.full_name} />
                      <span className="min-w-0">
                        <span className="block truncate font-medium">{c.full_name}</span>
                        <span className="block truncate text-xs text-muted">{c.email ?? c.phone ?? 'No contact info'}</span>
                      </span>
                    </Link>
                  </td>
                  <td>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <StatusBadge status={c.status} />
                      {c.open_requests > 0 && <Badge tone="warn">{c.open_requests} doc{c.open_requests > 1 ? 's' : ''} needed</Badge>}
                    </div>
                  </td>
                  <td className="text-muted">{STAGE_LABEL[c.stage as keyof typeof STAGE_LABEL] ?? c.stage}</td>
                  <td className="text-muted">{c.assignee_name ?? <span className="text-faint">Unassigned</span>}</td>
                  <td className="text-right tabular-nums">{c.active_disputes || <span className="text-faint">0</span>}</td>
                  <td className="whitespace-nowrap text-muted">{relTime(c.last_activity_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Pagination page={page} pages={pages} hrefFor={(p) => qs({ page: String(p) })} />
    </>
  );
}
