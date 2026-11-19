import Link from 'next/link';
import type { Metadata } from 'next';
import { AlertTriangle, Clock } from 'lucide-react';
import { BarSeries, Donut, HBars, SplitBar } from '@/components/charts';
import { Badge, EmptyState, PageHeader, Section, Stat } from '@/components/ui';
import { getAnalytics } from '@/lib/analytics';
import { requireStaff } from '@/lib/auth/context';
import { dayWindow, windowText } from '@/lib/day-meter';
import { deadlineState } from '@/lib/disputes/workflow';
import { BUREAU_LABEL, cn, fmtDate, moneyShort, type Bureau } from '@/lib/util';
import { PRODUCT } from '@/lib/product';

export const metadata: Metadata = { title: 'Analytics' };
const RANGES = [[30, '30 days'], [90, '90 days'], [365, '12 months']] as const;

export default async function AnalyticsPage({ searchParams }: { searchParams: Promise<{ range?: string }> }) {
  const sp = await searchParams;
  const ctx = await requireStaff('analytics:read');
  const range = [30, 90, 365].includes(Number(sp.range)) ? Number(sp.range) : 90;
  const a = await ctx.tx((db) => getAnalytics(db, { rangeDays: range, withTeam: ctx.can('analytics:team'), withRevenue: ctx.can('billing:read') }));
  const d = a.disputes;
  const changed = d.deleted + d.updated;
  const now = new Date();

  return (
    <>
      <PageHeader title="Analytics" subtitle="Computed live from your clients, disputes, tasks and payments. Nothing is estimated."
        actions={<nav aria-label="Period" className="flex gap-1 rounded-xl bg-raised p-1">{RANGES.map(([n, l]) => <Link key={n} href={`/app/analytics?range=${n}`} aria-current={range === n ? 'page' : undefined} className={cn('btn btn-sm', range === n ? 'bg-surface text-ink shadow-card' : 'text-muted hover:text-ink')}>{l}</Link>)}</nav>} />

      <h2 className="display mb-4 text-xl">Clients</h2>
      <div className="mb-10 grid grid-cols-2 gap-x-4 gap-y-6 lg:grid-cols-4">
        <Stat label="Total clients" value={a.clients.total} /><Stat label="Active" value={a.clients.active} /><Stat label={`New · ${range}d`} value={a.clients.newInRange} /><Stat label="In onboarding" value={a.clients.onboarding} />
      </div>

      <h2 className="display mb-4 text-xl">Disputes · last {range} days</h2>
      <div className="mb-6 grid grid-cols-2 gap-x-4 gap-y-6 lg:grid-cols-4">
        <Stat label="Created" value={d.created} /><Stat label="Submitted" value={d.submitted} /><Stat label="In flight now" value={d.inFlight} /><Stat label="Awaiting review" value={d.awaitingReview} tone={d.awaitingReview ? 'warn' : undefined} />
      </div>
      <div className="mb-10 grid gap-6 lg:grid-cols-3">
        <Section title="Outcomes" className="lg:col-span-2" hint="Responses recorded in this period">
          {d.resolvedTotal === 0 ? <p className="text-sm text-muted">No outcomes recorded in this period yet.</p> : <SplitBar parts={[{ label: 'Deleted', value: d.deleted, className: 'bg-ok' }, { label: 'Updated', value: d.updated, className: 'bg-info' }, { label: 'Verified as reported', value: d.verified, className: 'bg-faint' }, { label: 'Unresolved / no response', value: d.unresolved, className: 'bg-warn' }]} />}
        </Section>
        <Section plain title="Changed rate" hint="Deleted or updated ÷ outcomes"><div className="flex justify-center py-2"><Donut value={changed} total={d.resolvedTotal} label="changed" /></div><p className="mt-2 text-center text-[0.8125rem] text-muted">Outcomes are decided by bureaus and furnishers. Past rates do not predict future results.</p></Section>
      </div>

      <div className="mb-10 grid gap-x-8 gap-y-8 lg:grid-cols-2">
        <Section plain title="Clients added per month"><BarSeries data={a.series.clients} /></Section>
        <Section plain title="Disputes submitted per month"><BarSeries data={a.series.submitted} /></Section>
        <Section plain title="Outcomes by bureau" hint="Items deleted or updated vs. all outcomes">
          {a.bureauOutcomes.length === 0 ? <p className="text-sm text-muted">No outcomes in this period.</p> : <HBars rows={a.bureauOutcomes.map((b) => ({ label: BUREAU_LABEL[b.bureau as Bureau] ?? b.bureau, value: b.changed, sub: `${b.changed} of ${b.total}` }))} tone="ok" />}
        </Section>
        <Section plain title="Upcoming response deadlines">
          {a.deadlines.length === 0 ? <p className="text-sm text-muted">Nothing pending.</p> : <ul className="divide-y divide-line/70 text-sm">{a.deadlines.map((x) => {
            const st = deadlineState(x.due_at, now);
            const Icon = st === 'overdue' ? AlertTriangle : Clock;
            return <li key={x.id} className="flex items-center justify-between gap-3 py-2.5"><span className="min-w-0"><Link className="font-semibold decoration-brand decoration-2 underline-offset-4 hover:underline" href={`/app/disputes/${x.id}`}>{x.item_label}</Link><span className="block truncate text-[0.8125rem] text-muted">{x.client_name}{x.bureau ? `, ${BUREAU_LABEL[x.bureau as Bureau] ?? x.bureau}` : ''} · due {fmtDate(x.due_at)}</span></span><Badge tone={st === 'overdue' ? 'bad' : st === 'soon' ? 'warn' : 'neutral'}><Icon size={12} aria-hidden />{windowText(dayWindow(null, x.due_at, now)).status}</Badge></li>; })}</ul>}
        </Section>
      </div>

      <h2 className="display mb-4 text-xl">Work</h2>
      <div className="mb-10 grid grid-cols-2 gap-x-4 gap-y-6 lg:grid-cols-4"><Stat label="Open tasks" value={a.tasks.open} /><Stat label="Overdue tasks" value={a.tasks.overdue} tone={a.tasks.overdue ? 'bad' : undefined} /><Stat label="Due in 7 days" value={d.dueSoon} tone={d.dueSoon ? 'warn' : undefined} /><Stat label="Overdue disputes" value={d.overdue} tone={d.overdue ? 'bad' : undefined} /></div>

      {a.revenue && (
        <>
          <h2 className="display mb-4 text-xl">Revenue &amp; subscriptions</h2>
          <div className="mb-3 grid grid-cols-2 gap-x-4 gap-y-6 lg:grid-cols-4">
            <Stat label="Monthly recurring" value={moneyShort(a.revenue.mrrCents)} sub={`${a.revenue.activeSubs} active plan${a.revenue.activeSubs === 1 ? '' : 's'}`} />
            <Stat label={`Collected · ${range}d`} value={moneyShort(a.revenue.collectedCents)} sub={`${a.revenue.payments} payment${a.revenue.payments === 1 ? '' : 's'}`} />
            <Stat label="Refunded" value={moneyShort(a.revenue.refundedCents)} />
            <Stat label="Clients on a plan" value={a.revenue.clientsWithPlan} sub={a.clients.active ? `of ${a.clients.active} active` : undefined} />
          </div>
          <p className="mb-10 text-[0.8125rem] text-muted">Revenue reflects payments your team recorded. {PRODUCT.name} does not process cards.</p>
        </>
      )}

      {ctx.can('analytics:team') && (
        <Section title="Team performance" hint={`Last ${range} days. Counts reflect work done, not quality — read them alongside outcomes and client feedback.`}>
          {a.team.length === 0 ? <EmptyState title="No team members" /> : (
            <div className="table-wrap !shadow-none"><table className="table"><thead><tr><th>Teammate</th><th className="text-right">Active clients</th><th className="text-right">Disputes created</th><th className="text-right">Submitted</th><th className="text-right">Deleted / updated</th><th className="text-right">Tasks done</th><th className="text-right">Tasks open</th></tr></thead>
              <tbody>{a.team.map((t) => <tr key={t.id}><td><div className="font-medium">{t.name}</div><div className="text-[0.8125rem] capitalize text-muted">{t.role}</div></td><td className="text-right tabular-nums">{t.activeClients}</td><td className="text-right tabular-nums">{t.created}</td><td className="text-right tabular-nums">{t.submitted}</td><td className="text-right tabular-nums">{t.changed}</td><td className="text-right tabular-nums">{t.tasksDone}</td><td className="text-right tabular-nums">{t.tasksOpen}</td></tr>)}</tbody></table></div>
          )}
        </Section>
      )}
    </>
  );
}
