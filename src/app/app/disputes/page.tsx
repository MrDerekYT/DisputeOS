import Link from 'next/link';
import type { Metadata } from 'next';
import { AlertTriangle, LayoutGrid, Plus, Table2 } from 'lucide-react';
import { Avatar, Badge, DayMeter, EmptyState, PageHeader, Pagination, Stat, StatusBadge } from '@/components/ui';
import { requireStaff } from '@/lib/auth/context';
import { DUE_SOON_DAYS, PIPELINE, STATUS_LABEL, type DisputeStatus } from '@/lib/disputes/workflow';
import { BUREAU_LABEL, cn, fmtDate, pageParam, type Bureau } from '@/lib/util';

export const metadata: Metadata = { title: 'Disputes' };

interface Row {
  id: string; item_label: string; status: DisputeStatus; round: number; bureau: Bureau | null; recipient_name: string; submitted_at: string | null; due_at: string | null; deadline_extended: boolean; client_id: string;
  client_name: string; assignee_name: string | null; assigned_to: string | null; outcome: string | null; category: string;
}

const PER_COLUMN = 10;
const PAGE_SIZE = 50;

/** The investigation window is only running while a dispute is submitted or under investigation — the same test the overdue counts and filters use. */
const windowOpen = (d: Row) => (d.status === 'submitted' || d.status === 'under_investigation') && !!d.due_at;

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
    const cols = 'd.id, d.item_label, d.status, d.round, d.bureau, d.recipient_name, d.submitted_at, d.due_at, d.deadline_extended, d.client_id, d.assigned_to, d.outcome, d.category, c.full_name as client_name, u.full_name as assignee_name';
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
  const now = new Date();
  const seg = (on: boolean) => cn('btn btn-sm', on ? 'bg-surface text-ink shadow-card' : 'text-muted hover:text-ink');

  return (
    <>
      <PageHeader title="Disputes" subtitle="Every dispute moves through the same documented pipeline." actions={<Link href="/app/disputes/new" className="btn-primary"><Plus size={16} aria-hidden /> New dispute</Link>} />
      <div className="mb-8 grid grid-cols-2 gap-x-4 gap-y-6 lg:grid-cols-4">
        <Stat label="In flight" value={stats?.active ?? 0} sub="submitted → response" />
        <Stat label="Awaiting review" value={stats?.review ?? 0} tone={stats?.review ? 'warn' : undefined} href={qs({ status: 'ready_for_review', view: 'table' })} sub="needs a manager" />
        <Stat label={`Due in ${DUE_SOON_DAYS} days`} value={stats?.soon ?? 0} tone={stats?.soon ? 'warn' : undefined} href={qs({ due: 'soon', view: 'table', status: undefined, overdue: undefined })} />
        <Stat label="Overdue" value={stats?.overdue ?? 0} tone={stats?.overdue ? 'bad' : undefined} href={qs({ overdue: '1', view: 'table', status: undefined, due: undefined })} sub="response window passed" />
      </div>

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <nav className="flex gap-1 rounded-xl bg-raised p-1" aria-label="View">
          <Link href={qs({ view: undefined })} aria-current={view === 'board' ? 'page' : undefined} className={seg(view === 'board')}><LayoutGrid size={14} aria-hidden /> Pipeline</Link>
          <Link href={qs({ view: 'table' })} aria-current={view === 'table' ? 'page' : undefined} className={seg(view === 'table')}><Table2 size={14} aria-hidden /> Table</Link>
        </nav>
        <form method="get" className="flex flex-wrap items-center gap-2">
          {view === 'table' && <input type="hidden" name="view" value="table" />}
          {sp.status && <input type="hidden" name="status" value={sp.status} />}
          {sp.overdue === '1' && <input type="hidden" name="overdue" value="1" />}
          {sp.due === 'soon' && <input type="hidden" name="due" value="soon" />}
          <input name="q" defaultValue={q} placeholder="Search client or item" className="field !w-auto !py-1.5" aria-label="Search disputes by client or item" />
          <select name="bureau" defaultValue={sp.bureau ?? ''} className="field !w-auto !py-1.5" aria-label="Bureau"><option value="">All bureaus</option>{(Object.keys(BUREAU_LABEL) as Bureau[]).map((b) => <option key={b} value={b}>{BUREAU_LABEL[b]}</option>)}</select>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="mine" value="1" defaultChecked={sp.mine === '1'} className="h-4 w-4 accent-[rgb(var(--brand))]" /> Mine</label>
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
        // `relative` matters: the visually-hidden labels inside the columns are absolutely positioned, and only a positioned scroller clips them.
        <div className="relative -mx-4 overflow-x-auto px-4 pb-4 sm:-mx-6 sm:px-6">
          <div className="flex gap-4" style={{ minWidth: `${PIPELINE.length * 17}rem` }}>
            {PIPELINE.map((s) => {
              const col = byStatus(s);
              const n = statusCounts[s] ?? 0;
              return (
                <section key={s} className="w-64 shrink-0" aria-label={STATUS_LABEL[s]}>
                  <header className="mb-3 flex items-baseline justify-between gap-2 border-b border-line pb-2">
                    <h2 className="font-sans text-sm font-semibold tracking-normal">{STATUS_LABEL[s]}</h2>
                    <span className="text-[0.8125rem] font-semibold tabular-nums text-muted">{n}<span className="sr-only"> in this stage</span></span>
                  </header>
                  <div className="space-y-2.5">
                    {col.map((d) => (
                      <Link key={d.id} href={`/app/disputes/${d.id}`} className="panel block p-3 transition-shadow hover:shadow-pop">
                        <div className="text-sm font-medium leading-snug">{d.item_label}</div>
                        <div className="mt-0.5 truncate text-xs text-muted">{d.client_name}</div>
                        <div className="mt-2 flex flex-wrap items-center gap-1.5 empty:hidden">
                          {d.round > 1 && <Badge tone="info">Round {d.round}</Badge>}
                          {d.status === 'resolved' && d.outcome && <StatusBadge status={d.outcome} />}
                          {d.assignee_name && <span className="ml-auto"><Avatar name={d.assignee_name} size={22} /></span>}
                        </div>
                        {windowOpen(d) && <DayMeter className="mt-2.5" dueAt={d.due_at} extended={d.deadline_extended} now={now} size="sm" />}
                      </Link>
                    ))}
                    {col.length === 0 && <p className="py-4 text-[0.8125rem] text-muted">Nothing here</p>}
                    {n > col.length && <Link href={qs({ status: s, view: 'table' })} className="link block py-1 text-[0.8125rem]">+{n - col.length} more</Link>}
                  </div>
                </section>
              );
            })}
          </div>
          {(statusCounts.on_hold ?? 0) > 0 && (
            <p className="mt-4 flex items-center gap-2 text-sm text-muted"><AlertTriangle size={15} aria-hidden /> {statusCounts.on_hold} dispute(s) on hold. <Link className="link" href={qs({ status: 'on_hold', view: 'table' })}>View</Link></p>
          )}
        </div>
      ) : (
        <div className="table-wrap">
          <table className="table table-stack">
            <thead><tr><th>Item</th><th>Client</th><th>Status</th><th>Round</th><th>Sent to</th><th>Response deadline</th><th>Specialist</th></tr></thead>
            <tbody>
              {rows.map((d) => (
                <tr key={d.id} className="row-link">
                  <td className="cell-main"><Link href={`/app/disputes/${d.id}`} className="font-medium hover:underline">{d.item_label}</Link></td>
                  <td><Link href={`/app/clients/${d.client_id}`} className="text-muted hover:underline">{d.client_name}</Link></td>
                  <td><StatusBadge status={d.status} /></td>
                  <td className="tabular-nums" data-label="Round">{d.round}</td>
                  <td className="text-muted" data-label="Sent to">{d.bureau ? BUREAU_LABEL[d.bureau] : d.recipient_name}</td>
                  <td className={cn('whitespace-nowrap', windowOpen(d) && 'cell-full', !d.due_at && 'cell-none')} data-label="Due">{d.due_at ? <>{fmtDate(d.due_at)}{windowOpen(d) && <DayMeter className="mt-1.5 sm:min-w-[15rem]" dueAt={d.due_at} extended={d.deadline_extended} now={now} size="sm" />}</> : <span className="text-muted">—</span>}</td>
                  <td className={cn('text-muted', !d.assignee_name && 'cell-none')} data-label="Specialist">{d.assignee_name ?? '—'}</td>
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
