import Link from 'next/link';
import type { Metadata } from 'next';
import { ArrowRight, CheckCircle2, Circle, FileUp, HeartHandshake, MessageCircle, MessageSquareDashed, UserPlus } from 'lucide-react';
import { BarSeries, SplitBar } from '@/components/charts';
import { Badge, Notice, PageHeader, Section, Stat } from '@/components/ui';
import { getAnalytics } from '@/lib/analytics';
import { requireStaff } from '@/lib/auth/context';
import { clientCare } from '@/lib/client-care';
import { daysRemaining } from '@/lib/disputes/workflow';
import { BUREAU_LABEL, fmtDate, relTime, type Bureau } from '@/lib/util';

export const metadata: Metadata = { title: 'Dashboard' };

export default async function Dashboard({ searchParams }: { searchParams: Promise<{ denied?: string }> }) {
  const sp = await searchParams;
  const ctx = await requireStaff();
  const { a, mine, setup, care } = await ctx.tx(async (db) => ({
    a: await getAnalytics(db, { rangeDays: 90, withTeam: false, withRevenue: false }),
    mine: await db.rows<{ id: string; title: string; due_at: string | null; client_id: string | null; client_name: string | null }>(
      `select t.id, t.title, t.due_at, t.client_id, c.full_name as client_name from public.tasks t left join public.clients c on c.id = t.client_id
        where t.status = 'open' and (t.assignee_id = $1 or t.assignee_id is null) order by t.due_at nulls last limit 6`, [ctx.userId]),
    setup: await db.row<{ clients: number; reports: number; approved: number; disputes: number; team: number; letters: number }>(
      `select (select count(*)::int from public.clients) as clients, (select count(*)::int from public.credit_reports) as reports,
              (select count(*)::int from public.credit_reports where status = 'approved') as approved, (select count(*)::int from public.disputes) as disputes,
              (select count(*)::int from public.memberships where role <> 'client') as team, (select count(*)::int from public.letters where status in ('approved','sent')) as letters`),
    care: await clientCare(db),
  }));
  const first = ctx.session.fullName.split(' ')[0] || 'there';
  const d = a.disputes;
  const brandNew = (setup?.clients ?? 0) === 0;
  const steps: [string, boolean, string][] = [
    ['Add your first client', (setup?.clients ?? 0) > 0, '/app/clients/new'],
    ['Upload and approve a credit report', (setup?.approved ?? 0) > 0, '/app/clients'],
    ['Start a dispute from a finding', (setup?.disputes ?? 0) > 0, '/app/disputes/new'],
    ['Approve your first letter', (setup?.letters ?? 0) > 0, '/app/letters'],
    ['Invite a teammate', (setup?.team ?? 1) > 1, '/app/team'],
  ];
  const trialDays = ctx.session.orgPlan === 'trial' ? await ctx.tx((db) => db.row<{ d: number }>("select greatest(0, ceil(extract(epoch from (trial_ends_at - now())) / 86400))::int as d from public.organizations where id = $1", [ctx.orgId])) : null;

  return (
    <>
      <PageHeader title={`Welcome back, ${first}`} subtitle={`${ctx.session.orgName} · everything below is live data from your workspace.`}
        actions={<Link href="/app/clients/new" className="btn-primary">New client</Link>} />
      {sp.denied && <div className="mb-4"><Notice tone="warn" title="Not available for your role">Ask an admin if you need access to that area.</Notice></div>}
      {trialDays && <div className="mb-4"><Notice tone="info" title={`Trial: ${trialDays.d} day${trialDays.d === 1 ? '' : 's'} left`}>You are on the free trial. Billing is not connected in this build, so nothing is charged.</Notice></div>}

      {brandNew || steps.some(([, done]) => !done) ? (
        <Section title="Get set up" hint="A few steps to your first reviewed dispute." className="mb-6">
          <ol className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
            {steps.map(([label, done, href], i) => (
              <li key={label}><Link href={href} className={`flex h-full items-start gap-2.5 rounded-xl border p-3 text-sm transition hover:border-brand/50 ${done ? 'border-ok/30 bg-ok-soft/50' : 'border-line bg-surface'}`}>
                {done ? <CheckCircle2 size={18} className="mt-0.5 shrink-0 text-ok" /> : <Circle size={18} className="mt-0.5 shrink-0 text-faint" />}<span className={done ? 'text-muted line-through' : 'font-medium'}>{i + 1}. {label}</span></Link></li>))}
          </ol>
        </Section>
      ) : null}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Active clients" value={a.clients.active} sub={`${a.clients.total} total · ${a.clients.newInRange} new in 90 days`} href="/app/clients" />
        <Stat label="Disputes in flight" value={d.inFlight} sub={`${d.created} created in 90 days`} href="/app/disputes" />
        <Stat label="Due in 7 days" value={d.dueSoon} tone={d.dueSoon ? 'warn' : undefined} sub={d.overdue ? `${d.overdue} overdue` : 'none overdue'} href="/app/disputes?view=table" />
        <Stat label="Open tasks" value={a.tasks.open} tone={a.tasks.overdue ? 'warn' : undefined} sub={a.tasks.overdue ? `${a.tasks.overdue} overdue` : 'all on time'} href="/app/tasks" />
      </div>

      <Section className="mt-6" title="Client care" hint="Clients who are waiting on your team. Reply, review, or send an update — it’s what keeps clients confident."
        actions={<span className="flex items-center gap-1.5 text-xs text-muted"><HeartHandshake size={14} aria-hidden /> {care.total === 0 ? 'Everyone is up to date' : `${care.total} waiting`}</span>}>
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <CareList icon={UserPlus} title="New leads to contact" count={care.counts.leads} empty="No new leads waiting."
            items={care.leads.map((l) => ({ key: l.id, href: `/app/clients/${l.id}`, name: l.full_name, detail: l.source ?? 'Added by your team', when: relTime(l.created_at), urgent: l.hours >= 24 }))} />
          <CareList icon={MessageCircle} title="Waiting for a reply" count={care.counts.messages} empty="No unanswered client messages."
            items={care.messages.map((m) => ({ key: m.id, href: `/app/clients/${m.client_id}?tab=messages`, name: m.client_name, detail: m.body, when: relTime(m.created_at), urgent: m.hours >= 24 }))} />
          <CareList icon={FileUp} title="Uploads to review" count={care.counts.uploads} empty="No client uploads waiting."
            items={care.uploads.map((u) => ({ key: u.id, href: `/app/clients/${u.client_id}?tab=documents`, name: u.client_name, detail: u.file_name, when: relTime(u.created_at), urgent: u.hours >= 48 }))} />
          <CareList icon={MessageSquareDashed} title="No update in 14+ days" count={care.counts.quiet} empty="Every active client has heard from you recently."
            items={care.quiet.map((q) => ({ key: q.id, href: `/app/clients/${q.id}?tab=messages`, name: q.full_name, detail: q.last_contact ? `Last update ${fmtDate(q.last_contact)}` : 'Never sent an update', when: '', urgent: q.days >= 30 }))} />
        </div>
      </Section>

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <Section title="Needs you today" className="lg:col-span-2" actions={<Link href="/app/tasks" className="text-sm text-brand-strong hover:underline">All tasks</Link>}>
          {d.awaitingReview > 0 && ctx.can('disputes:approve') && <Link href="/app/disputes?status=ready_for_review&view=table" className="mb-3 flex items-center justify-between rounded-xl bg-warn-soft p-3 text-sm text-warn"><span><strong>{d.awaitingReview}</strong> dispute{d.awaitingReview > 1 ? 's' : ''} waiting for your approval</span><ArrowRight size={16} /></Link>}
          {mine.length === 0 && d.awaitingReview === 0 ? <p className="py-6 text-center text-sm text-muted">You’re all caught up.</p> : (
            <ul className="divide-y divide-line">{mine.map((t) => (
              <li key={t.id} className="flex items-center justify-between gap-3 py-2.5 text-sm"><div className="min-w-0"><div className="truncate font-medium">{t.title}</div>{t.client_name && <Link href={`/app/clients/${t.client_id}`} className="text-xs text-muted hover:underline">{t.client_name}</Link>}</div>
                {t.due_at && <Badge tone={new Date(t.due_at) < new Date() ? 'bad' : 'neutral'}>{fmtDate(t.due_at)}</Badge>}</li>))}</ul>
          )}
        </Section>

        <Section title="Upcoming deadlines" hint="Bureau and furnisher response windows">
          {a.deadlines.length === 0 ? <p className="text-sm text-muted">No submitted disputes yet.</p> : (
            <ul className="space-y-3">{a.deadlines.slice(0, 5).map((x) => {
              const left = daysRemaining(x.due_at);
              return (<li key={x.id} className="text-sm"><Link href={`/app/disputes/${x.id}`} className="font-medium hover:underline">{x.item_label}</Link><div className="flex items-center justify-between text-xs text-muted"><span>{x.client_name}{x.bureau ? ` · ${BUREAU_LABEL[x.bureau as Bureau]}` : ''}</span><Badge tone={left < 0 ? 'bad' : left <= 5 ? 'warn' : 'neutral'}>{left < 0 ? `${-left}d overdue` : `${left}d`}</Badge></div></li>);
            })}</ul>
          )}
        </Section>

        <Section title="Dispute outcomes · last 90 days" hint="From responses recorded in the same period">
          <SplitBar parts={[{ label: 'Deleted', value: d.deleted, className: 'bg-ok' }, { label: 'Updated', value: d.updated, className: 'bg-info' }, { label: 'Verified', value: d.verified, className: 'bg-faint' }, { label: 'Unresolved', value: d.unresolved, className: 'bg-warn' }]} />
          {d.resolvedTotal > 0 && <p className="mt-4 text-xs text-muted">Outcomes depend on what bureaus and furnishers find after investigation. They are not a promise of future results.</p>}
        </Section>
        <Section title="New clients per month"><BarSeries data={a.series.clients} height={140} /></Section>
        <Section title="Disputes submitted per month"><BarSeries data={a.series.submitted} height={140} /></Section>
      </div>
    </>
  );
}

type CareItem = { key: string; href: string; name: string; detail: string; when: string; urgent: boolean };

function CareList({ icon: Icon, title, items, count, empty }: { icon: typeof MessageCircle; title: string; items: CareItem[]; count: number; empty: string }) {
  return (
    <div className="rounded-xl border border-line p-4">
      <h3 className="mb-3 flex items-center justify-between gap-2 text-sm font-semibold"><span className="flex items-center gap-2"><Icon size={15} className="text-brand" aria-hidden />{title}</span>{count > 0 && <Badge tone={items.some((i) => i.urgent) ? 'warn' : 'neutral'}>{count}</Badge>}</h3>
      {items.length === 0 ? <p className="text-sm text-muted">{empty}</p> : (
        <ul className="space-y-2.5">{items.map((i) => (
          <li key={i.key}><Link href={i.href} className="group block rounded-lg text-sm">
            <div className="flex items-center justify-between gap-2"><span className="truncate font-medium group-hover:underline">{i.name}</span>{i.when && <span className={i.urgent ? 'shrink-0 text-xs font-medium text-warn' : 'shrink-0 text-xs text-muted'}>{i.when}</span>}</div>
            <p className={i.urgent && !i.when ? 'truncate text-xs text-warn' : 'truncate text-xs text-muted'}>{i.detail}</p>
          </Link></li>))}</ul>
      )}
    </div>
  );
}
