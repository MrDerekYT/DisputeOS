import Link from 'next/link';
import type { Metadata } from 'next';
import { AlertTriangle, LayoutGrid, Plus, Table2 } from 'lucide-react';
import { Avatar, Badge, EmptyState, PageHeader, Stat, StatusBadge } from '@/components/ui';
import { requireStaff } from '@/lib/auth/context';
import { daysRemaining, deadlineState, PIPELINE, STATUS_LABEL, type DisputeStatus } from '@/lib/disputes/workflow';
import { BUREAU_LABEL, cn, fmtDate, type Bureau } from '@/lib/util';

export const metadata: Metadata = { title: 'Disputes' };

interface Row {
  id: string; item_label: string; status: DisputeStatus; round: number; bureau: Bureau | null; recipient_name: string; due_at: string | null; client_id: string;
  client_name: string; assignee_name: string | null; assigned_to: string | null; outcome: string | null; category: string;
}

const PER_COLUMN = 10;

function Due({ due }: { due: string | null }) {
  const s = deadlineState(due);
  if (s === 'none' || !due) return null;
  const d = daysRemaining(due);
  return <Badge tone={s === 'overdue' ? 'bad' : s === 'soon' ? 'warn' : 'neutral'}>{s === 'overdue' ? `${Math.abs(d)}d overdue` : `${d}d left`}</Badge>;
}

export default async function DisputesPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const ctx = await requireStaff('clients:read');
  const view = sp.view === 'table' ? 'table' : 'board';
  const rows = await ctx.tx((db) => {
    const w: string[] = [];
    const p: (string | number)[] = [];
    if (sp.mine === '1') { p.push(ctx.userId); w.push(`d.assigned_to = $${p.length}`); }
    if (sp.bureau) { p.push(sp.bureau); w.push(`d.bureau = $${p.length}`); }
    if (sp.status) { p.push(sp.status); w.push(`d.status = $${p.length}`); }
    if (sp.overdue === '1') w.push("d.status in ('submitted','under_investigation') and d.due_at < now()");
    if (view === 'board' && !sp.status) w.push("(d.status <> 'cancelled' and (d.status <> 'resolved' or d.updated_at > now() - interval '60 days'))");
    return db.rows<Row>(
      `select d.id, d.item_label, d.status, d.round, d.bureau, d.recipient_name, d.due_at, d.client_id, d.assigned_to, d.outcome, d.category, c.full_name as client_name, u.full_name as assignee_name
         from public.disputes d join public.clients c on c.id = d.client_id left join public.users u on u.id = d.assigned_to
        ${w.length ? `where ${w.join(' and ')}` : ''} order by coalesce(d.due_at, d.updated_at) asc limit 400`, p);
  });
  const stats = await ctx.tx((db) => db.row<{ active: number; soon: number; overdue: number; review: number }>(
    `select count(*) filter (where status in ('submitted','under_investigation','response_received'))::int as active,
            count(*) filter (where status in ('submitted','under_investigation') and due_at between now() and now() + interval '5 days')::int as soon,
            count(*) filter (where status in ('submitted','under_investigation') and due_at < now())::int as overdue,
            count(*) filter (where status = 'ready_for_review')::int as review from public.disputes`));

  const qs = (o: Record<string, string | undefined>) => {
    const u = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...sp, ...o })) if (v) u.set(k, v);
    return `/app/disputes?${u}`;
  };
  const byStatus = (s: DisputeStatus) => rows.filter((r) => r.status === s);

  return (
    <>
      <PageHeader title="Disputes" subtitle="Every dispute moves through the same documented pipeline." actions={<Link href="/app/disputes/new" className="btn-primary"><Plus size={16} /> New dispute</Link>} />
      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="In flight" value={stats?.active ?? 0} sub="submitted → response" />
        <Stat label="Awaiting review" value={stats?.review ?? 0} tone={stats?.review ? 'warn' : undefined} href={qs({ status: 'ready_for_review', view: 'table' })} sub="needs a manager" />
        <Stat label="Due in 5 days" value={stats?.soon ?? 0} tone={stats?.soon ? 'warn' : undefined} />
        <Stat label="Overdue" value={stats?.overdue ?? 0} tone={stats?.overdue ? 'bad' : undefined} href={qs({ overdue: '1', view: 'table', status: undefined })} sub="response window passed" />
      </div>

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex gap-1 rounded-xl border border-line bg-surface p-1" role="tablist" aria-label="View">
          <Link href={qs({ view: undefined })} role="tab" aria-selected={view === 'board'} className={cn('btn btn-sm', view === 'board' ? 'bg-brand-soft text-brand-strong' : 'text-muted')}><LayoutGrid size={14} /> Pipeline</Link>
          <Link href={qs({ view: 'table' })} role="tab" aria-selected={view === 'table'} className={cn('btn btn-sm', view === 'table' ? 'bg-brand-soft text-brand-strong' : 'text-muted')}><Table2 size={14} /> Table</Link>
        </div>
        <form method="get" className="flex flex-wrap items-center gap-2">
          {view === 'table' && <input type="hidden" name="view" value="table" />}
          <select name="bureau" defaultValue={sp.bureau ?? ''} className="field !w-auto !py-1.5" aria-label="Bureau"><option value="">All bureaus</option>{(Object.keys(BUREAU_LABEL) as Bureau[]).map((b) => <option key={b} value={b}>{BUREAU_LABEL[b]}</option>)}</select>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="mine" value="1" defaultChecked={sp.mine === '1'} className="accent-[rgb(var(--brand))]" /> Mine</label>
          <button className="btn-secondary btn-sm" type="submit">Apply</button>
          {(sp.bureau || sp.mine || sp.status || sp.overdue) && <Link href={qs({ bureau: undefined, mine: undefined, status: undefined, overdue: undefined })} className="btn-ghost btn-sm">Clear</Link>}
        </form>
      </div>

      {rows.length === 0 ? (
        <EmptyState title="No disputes yet" body="Compare a client’s bureau reports, then start a dispute from a finding — or create one from scratch." action={<Link href="/app/disputes/new" className="btn-primary">Start a dispute</Link>} />
      ) : view === 'board' ? (
        <div className="-mx-4 overflow-x-auto px-4 pb-4 sm:-mx-6 sm:px-6">
          <div className="flex gap-4" style={{ minWidth: `${PIPELINE.length * 17}rem` }}>
            {PIPELINE.map((s) => {
              const col = byStatus(s);
              return (
                <section key={s} className="w-64 shrink-0" aria-label={STATUS_LABEL[s]}>
                  <header className="mb-2 flex items-center justify-between px-1">
                    <h2 className="text-sm font-semibold">{STATUS_LABEL[s]}</h2>
                    <span className="rounded-full bg-raised px-2 py-0.5 text-xs tabular-nums text-muted ring-1 ring-inset ring-line">{col.length}</span>
                  </header>
                  <div className="space-y-2.5 rounded-2xl bg-raised/70 p-2 ring-1 ring-inset ring-line">
                    {col.slice(0, PER_COLUMN).map((d) => (
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
                    {col.length > PER_COLUMN && <Link href={qs({ status: s, view: 'table' })} className="block py-1 text-center text-xs font-medium text-brand-strong hover:underline">+{col.length - PER_COLUMN} more</Link>}
                  </div>
                </section>
              );
            })}
          </div>
          {rows.some((r) => r.status === 'on_hold') && (
            <p className="mt-4 flex items-center gap-2 text-sm text-muted"><AlertTriangle size={15} /> {rows.filter((r) => r.status === 'on_hold').length} dispute(s) on hold. <Link className="underline" href={qs({ status: 'on_hold', view: 'table' })}>View</Link></p>
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
    </>
  );
}
