import Link from 'next/link';
import type { Metadata } from 'next';
import { AlertTriangle, LayoutGrid, Plus, Table2 } from 'lucide-react';
import { Avatar, Badge, EmptyState, PageHeader, Pagination, Stat, StatusBadge } from '@/components/ui';
import { requireStaff } from '@/lib/auth/context';
import { daysOverdue, daysRemaining, deadlineState, DUE_SOON_DAYS, PIPELINE, STATUS_LABEL, type DisputeStatus } from '@/lib/disputes/workflow';
import { BUREAU_LABEL, cn, fmtDate, pageParam, type Bureau } from '@/lib/util';

export const metadata: Metadata = { title: 'Disputes' };

interface Row {
  id: string; item_label: string; status: DisputeStatus; round: number; bureau: Bureau | null; recipient_name: string; due_at: string | null; client_id: string;
  client_name: string; assignee_name: string | null; assigned_to: string | null; outcome: string | null; category: string;
}

const PER_COLUMN = 10;
const PAGE_SIZE = 50;

function Due({ due }: { due: string | null }) {
  const s = deadlineState(due);
  if (s === 'none' || !due) return null;
  return <Badge tone={s === 'overdue' ? 'bad' : s === 'soon' ? 'warn' : 'neutral'}>{s === 'overdue' ? `${daysOverdue(due)}d overdue` : `${daysRemaining(due)}d left`}</Badge>;
}

export default async function DisputesPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const ctx = await requireStaff('clients:read');
  const view = sp.view === 'table' ? 'table' : 'board';
  const q = (sp.q ?? '').trim().slice(0, 80);
  const page = pageParam(sp.page);
  const filtered = !!(q || sp.bureau || sp.mine || sp.status || sp.overdue || sp.due);
  const { rows, statusCounts } = await ctx.tx(async (db) => {
    const w: string[] = [];
    const p: (string | number)[] = [];
    if (sp.mine === '1') { p.push(ctx.userId); w.push(`d.assigned_to = $${p.length}`); }
    if (sp.bureau) { p.push(sp.bureau); w.push(`d.bureau = $${p.length}`); }
    if (sp.status) { p.push(sp.status); w.push(`d.status = $${p.length}`); }
    if (q) { p.push(q.replace(/[\\%_]/g, '\\$&')); w.push(`(d.item_label ilike '%' || $${p.length} || '%' or c.full_name ilike '%' || $${p.length} || '%')`); }
    if (sp.overdue === '1') w.push("d.status in ('submitted','under_investigation') and d.due_at < now()");
    if (sp.due === 'soon') w.push(`d.status in ('submitted','under_investigation') and d.due_at between now() and now() + interval '${DUE_SOON_DAYS} days'`);
    if (view === 'board' && !sp.status) w.push("(d.status <> 'cancelled' and (d.status <> 'resolved' or d.updated_at > now() - interval '60 days'))");
    const from = `from public.disputes d join public.clients c on c.id = d.client_id left join public.users u on u.id = d.assigned_to ${w.length ? `where ${w.join(' and ')}` : ''}`;
    const cols = 'd.id, d.item_label, d.status, d.round, d.bureau, d.recipient_name, d.due_at, d.client_id, d.assigned_to, d.outcome, d.category, c.full_name as client_name, u.full_name as assignee_name';
    // Counts come from the database, not from the rows on screen, so they stay right however many disputes there are.
    const counts = await db.rows<{ status: DisputeStatus; n: number }>(`select d.status, count(*)::int as n ${from} group by d.status`, p);
    const rows = view === 'board'
      ? await db.rows<Row>(`select * from (select ${cols}, coalesce(d.due_at, d.updated_at) as sort_at, row_number() over (partition by d.status order by coalesce(d.due_at, d.updated_at) asc) as rn ${from}) x where rn <= ${PER_COLUMN} order by sort_at asc`, p)
      : await db.rows<Row>(`select ${cols} ${from} order by coalesce(d.due_at, d.updated_at) asc, d.id limit ${PAGE_SIZE} offset ${(page - 1) * PAGE_SIZE}`, p);
    return { rows, statusCounts: Object.fromEntries(counts.map((c) => [c.status, c.n])) as Partial<Record<DisputeStatus, number>> };
  });
  const total = Object.values(statusCounts).reduce((a, n) => a + (n ?? 0), 0);
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const stats = await ctx.tx((db) => db.row<{ active: number; soon: number; overdue: number; review: number }>(
    `select count(*) filter (where status in ('submitted','under_investigation','response_received'))::int as active,
            count(*) filter (where status in ('submitted','under_investigation') and due_at between now() and now() + interval '${DUE_SOON_DAYS} days')::int as soon,
            count(*) filter (where status in ('submitted','under_investigation') and due_at < now())::int as overdue,
            count(*) filter (where status = 'ready_for_review')::int as review from public.disputes`));

  const qs = (o: Record<string, string | undefined>) => {
    const u = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...sp, page: undefined, ...o })) if (v) u.set(k, v);
    return `/app/disputes?${u}`;
  };
  const byStatus = (s: DisputeStatus) => rows.filter((r) => r.status === s);

  return (
    <>
      <PageHeader title="Disputes" subtitle="Every dispute moves through the same documented pipeline." actions={<Link href="/app/disputes/new" className="btn-primary"><Plus size={16} /> New dispute</Link>} />
      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="In flight" value={stats?.active ?? 0} sub="submitted → response" />
        <Stat label="Awaiting review" value={stats?.review ?? 0} tone={stats?.review ? 'warn' : undefined} href={qs({ status: 'ready_for_review', view: 'table' })} sub="needs a manager" />
        <Stat label={`Due in ${DUE_SOON_DAYS} days`} value={stats?.soon ?? 0} tone={stats?.soon ? 'warn' : undefined} href={qs({ due: 'soon', view: 'table', status: undefined, overdue: undefined })} />
        <Stat label="Overdue" value={stats?.overdue ?? 0} tone={stats?.overdue ? 'bad' : undefined} href={qs({ overdue: '1', view: 'table', status: undefined, due: undefined })} sub="response window passed" />
      </div>

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <nav className="flex gap-1 rounded-xl border border-line bg-surface p-1" aria-label="View">
          <Link href={qs({ view: undefined })} aria-current={view === 'board' ? 'page' : undefined} className={cn('btn btn-sm', view === 'board' ? 'bg-brand-soft text-brand-strong' : 'text-muted')}><LayoutGrid size={14} /> Pipeline</Link>
          <Link href={qs({ view: 'table' })} aria-current={view === 'table' ? 'page' : undefined} className={cn('btn btn-sm', view === 'table' ? 'bg-brand-soft text-brand-strong' : 'text-muted')}><Table2 size={14} /> Table</Link>
        </nav>
        <form method="get" className="flex flex-wrap items-center gap-2">
          {view === 'table' && <input type="hidden" name="view" value="table" />}
          {sp.status && <input type="hidden" name="status" value={sp.status} />}
          {sp.overdue === '1' && <input type="hidden" name="overdue" value="1" />}
          {sp.due === 'soon' && <input type="hidden" name="due" value="soon" />}
          <input name="q" defaultValue={q} placeholder="Search client or item" className="field !w-auto !py-1.5" aria-label="Search disputes by client or item" />
          <select name="bureau" defaultValue={sp.bureau ?? ''} className="field !w-auto !py-1.5" aria-label="Bureau"><option value="">All bureaus</option>{(Object.keys(BUREAU_LABEL) as Bureau[]).map((b) => <option key={b} value={b}>{BUREAU_LABEL[b]}</option>)}</select>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="mine" value="1" defaultChecked={sp.mine === '1'} className="accent-[rgb(var(--brand))]" /> Mine</label>
          <button className="btn-secondary btn-sm" type="submit">Apply</button>
          {filtered && <Link href={qs({ bureau: undefined, mine: undefined, status: undefined, overdue: undefined, due: undefined, q: undefined })} className="btn-ghost btn-sm">Clear</Link>}
        </form>
      </div>

      {(sp.status || sp.overdue === '1' || sp.due === 'soon') && (
        <p className="mb-3 text-sm text-muted">Showing {sp.overdue === '1' ? 'overdue disputes' : sp.due === 'soon' ? `disputes due in the next ${DUE_SOON_DAYS} days` : `disputes that are “${STATUS_LABEL[sp.status as DisputeStatus] ?? sp.status}”`} · {total} found</p>
      )}
      {rows.length === 0 && filtered ? (
        <EmptyState title="No disputes match these filters" body="Try a different search or clear the filters." action={<Link href={view === 'table' ? '/app/disputes?view=table' : '/app/disputes'} className="btn-secondary">Clear filters</Link>} />
      ) : rows.length === 0 ? (
        <EmptyState title="No disputes yet" body="Compare a client’s bureau reports, then start a dispute from a finding — or create one from scratch." action={<Link href="/app/disputes/new" className="btn-primary">Start a dispute</Link>} />
      ) : view === 'board' ? (
        <div className="-mx-4 overflow-x-auto px-4 pb-4 sm:-mx-6 sm:px-6">
          <div className="flex gap-4" style={{ minWidth: `${PIPELINE.length * 17}rem` }}>
            {PIPELINE.map((s) => {
              const col = byStatus(s);
              const n = statusCounts[s] ?? 0;
              return (
                <section key={s} className="w-64 shrink-0" aria-label={STATUS_LABEL[s]}>
                  <header className="mb-2 flex items-center justify-between px-1">
                    <h2 className="text-sm font-semibold">{STATUS_LABEL[s]}</h2>
                    <span className="rounded-full bg-raised px-2 py-0.5 text-xs tabular-nums text-muted ring-1 ring-inset ring-line">{n}</span>
                  </header>
                  <div className="space-y-2.5 rounded-2xl bg-raised/70 p-2 ring-1 ring-inset ring-line">
                    {col.map((d) => (
                      <Link key={d.id} href={`/app/disputes/${d.id}`} className="card block p-3 transition hover:-translate-y-0.5 hover:border-brand/50 hover:shadow-pop">
                        <div className="text-sm font-medium leading-snug">{d.item_label}</div>
                        <div className="mt-0.5 truncate text-xs text-muted">{d.client_name}</div>
                        <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                          {d.round > 1 && <Badge tone="info">Round {d.round}</Badge>}
                          <Due due={d.due_at} />
                          {d.status === 'resolved' && d.outcome && <StatusBadge status={d.outcome} />}
                          {d.assignee_name && <span className="ml-auto"><Avatar name={d.assignee_name} size={22} /></span>}
                        </div>
                      </Link>
                    ))}
                    {col.length === 0 && <p className="px-2 py-6 text-center text-xs text-faint">Nothing here</p>}
                    {n > col.length && <Link href={qs({ status: s, view: 'table' })} className="block py-1 text-center text-xs font-medium text-brand-strong hover:underline">+{n - col.length} more</Link>}
                  </div>
                </section>
              );
            })}
          </div>
          {(statusCounts.on_hold ?? 0) > 0 && (
            <p className="mt-4 flex items-center gap-2 text-sm text-muted"><AlertTriangle size={15} /> {statusCounts.on_hold} dispute(s) on hold. <Link className="underline" href={qs({ status: 'on_hold', view: 'table' })}>View</Link></p>
          )}
        </div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Item</th><th>Client</th><th>Status</th><th>Round</th><th>Sent to</th><th>Deadline</th><th>Specialist</th></tr></thead>
            <tbody>
              {rows.map((d) => (
                <tr key={d.id} className="row-link">
                  <td><Link href={`/app/disputes/${d.id}`} className="font-medium hover:underline">{d.item_label}</Link></td>
                  <td><Link href={`/app/clients/${d.client_id}`} className="text-muted hover:underline">{d.client_name}</Link></td>
                  <td><StatusBadge status={d.status} /></td>
                  <td className="tabular-nums">{d.round}</td>
                  <td className="text-muted">{d.bureau ? BUREAU_LABEL[d.bureau] : d.recipient_name}</td>
                  <td className="whitespace-nowrap">{d.due_at ? <span className="flex items-center gap-2">{fmtDate(d.due_at)} <Due due={d.due_at} /></span> : <span className="text-faint">—</span>}</td>
                  <td className="text-muted">{d.assignee_name ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {view === 'table' && <Pagination page={page} pages={pages} hrefFor={(p) => qs({ page: String(p) })} />}
    </>
  );
}
