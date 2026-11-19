import Link from 'next/link';
import type { Metadata } from 'next';
import { AlertTriangle, ArrowRight, CheckCircle2, Circle, Clock, FileUp, HeartHandshake, MessageSquare, MessageSquareDashed, Pencil, ScanLine, UserPlus } from 'lucide-react';
import { BarSeries, SplitBar } from '@/components/charts';
import { WindowCalendar } from '@/components/dashboard-windows';
import { aiUnapproved } from '@/components/staff-kit';
import { AiTag, Badge, DayMeter, ListRow, Notice, PageHeader, RowList, Section, Stat } from '@/components/ui';
import { getAnalytics } from '@/lib/analytics';
import { requireStaff } from '@/lib/auth/context';
import { clientCare } from '@/lib/client-care';
import type { Db } from '@/lib/db';
import { getEnv } from '@/lib/env';
import { windowStart } from '@/lib/day-meter';
import { DUE_SOON_DAYS } from '@/lib/disputes/workflow';
import { BUREAU_LABEL, cn, dueDay, fmtDate, relTime, type Bureau } from '@/lib/util';

export const metadata: Metadata = { title: 'Dashboard' };

/** How many investigation windows the dashboard calendar draws; the real total is shown when there are more. */
const WINDOW_LIMIT = 8;

export default async function Dashboard({ searchParams }: { searchParams: Promise<{ denied?: string }> }) {
  const sp = await searchParams;
  const ctx = await requireStaff();
  const { a, mine, setup, care, first3, windows } = await ctx.tx(async (db) => ({
    a: await getAnalytics(db, { rangeDays: 90, withTeam: false, withRevenue: false }),
    mine: await db.rows<{ id: string; title: string; due_at: string | null; client_id: string | null; client_name: string | null }>(
      `select t.id, t.title, t.due_at, t.client_id, c.full_name as client_name from public.tasks t left join public.clients c on c.id = t.client_id
        where t.status = 'open' and (t.assignee_id = $1 or t.assignee_id is null) order by t.due_at nulls last limit 6`, [ctx.userId]),
    setup: await db.row<{ clients: number; reports: number; approved: number; disputes: number; team: number; letters: number }>(
      `select (select count(*)::int from public.clients) as clients, (select count(*)::int from public.credit_reports) as reports,
              (select count(*)::int from public.credit_reports where status = 'approved') as approved, (select count(*)::int from public.disputes) as disputes,
              (select count(*)::int from public.memberships where role <> 'client') as team, (select count(*)::int from public.letters where status in ('approved','sent')) as letters`),
    care: await clientCare(db),
    first3: await workFirst(db),
    // Every open, submitted dispute with a deadline (the same population as the overdue and due-soon counts), nearest deadline first.
    windows: await db.rows<{ id: string; item_label: string; client_name: string; bureau: string | null; due_at: string; deadline_extended: boolean; n: number }>(
      `select d.id, d.item_label, c.full_name as client_name, d.bureau, d.due_at, d.deadline_extended, count(*) over ()::int as n
         from public.disputes d join public.clients c on c.id = d.client_id
        where d.status in ('submitted', 'under_investigation') and d.due_at is not null order by d.due_at limit ${WINDOW_LIMIT}`),
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

  const now = new Date();
  const tz = getEnv().APP_TIMEZONE;
  const sentTo = (bureau: string | null) => (bureau ? BUREAU_LABEL[bureau as Bureau] ?? bureau : null);
  const queues: { key: string; label: string; count: number; shown: number; href?: string; more: string; tone?: 'bad' }[] = [
    { key: 'overdue', label: 'Overdue deadlines', count: first3.counts.overdue, shown: first3.overdue.length, href: '/app/disputes?view=table&overdue=1', more: 'overdue', tone: 'bad' },
    { key: 'letters', label: 'Letters awaiting approval', count: first3.counts.letters, shown: first3.letters.length, href: '/app/letters?status=pending_approval', more: 'letters' },
    { key: 'messages', label: 'Unanswered messages', count: care.counts.messages, shown: care.messages.length, href: '/app/inbox', more: 'messages' },
    { key: 'reports', label: 'Reports to review', count: first3.counts.reports, shown: first3.reports.length, more: 'reports' },
  ];
  const waiting = queues.reduce((n, q) => n + q.shown, 0);
  const hidden = queues.filter((q) => q.count > q.shown);
  const careWaiting = care.total - care.counts.messages;
  // With a short queue the left column ends well above the windows panel; the workspace figures fill that space
  // instead of leaving it empty and pushing them below the fold.
  const shortQueue = waiting < 4;
  const figures = (
    <>
      <Stat label="Active clients" value={a.clients.active} sub={`${a.clients.total} total · ${a.clients.newInRange} new in 90 days`} href="/app/clients" />
      <Stat label="Disputes in flight" value={d.inFlight} sub={`${d.created} created in 90 days`} href="/app/disputes" />
      <Stat label={`Due in ${DUE_SOON_DAYS} days`} value={d.dueSoon} tone={d.dueSoon ? 'warn' : undefined} sub={d.overdue ? `${d.overdue} overdue` : 'none overdue'} href="/app/disputes?view=table&due=soon" />
      <Stat label="Open tasks" value={a.tasks.open} tone={a.tasks.overdue ? 'warn' : undefined} sub={a.tasks.overdue ? `${a.tasks.overdue} overdue` : 'all on time'} href="/app/tasks" />
    </>
  );

  return (
    <>
      <PageHeader title={`Welcome back, ${first}`} subtitle={`${ctx.session.orgName} · live data from your workspace.`}
        actions={trialDays ? <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[0.8125rem] text-muted"><Badge tone="info"><Clock size={12} aria-hidden />Trial: {trialDays.d} day{trialDays.d === 1 ? '' : 's'} left</Badge>Billing is not connected in this build, so nothing is charged.</p> : undefined} />
      {sp.denied && <div className="mb-4"><Notice tone="warn" title="Not available for your role">Ask an admin if you need access to that area.</Notice></div>}

      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
        <div className="space-y-8">
        <section aria-labelledby="do-first" className="panel overflow-hidden">
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-5 pt-5 sm:px-6">
            <h2 id="do-first" className="display text-xl">Do these first</h2>
            <p className="text-[0.8125rem] text-muted">Oldest first, across every client</p>
          </div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-5 px-5 py-5 sm:grid-cols-4 sm:px-6">
            {queues.map((q) => {
              const hot = q.tone === 'bad' && q.count > 0;
              const body = (<>
                <div className={cn('display text-[2rem] tabular-nums', hot ? 'text-bad' : 'text-ink', q.href && 'decoration-brand decoration-2 underline-offset-4 group-hover:underline')}>{q.count}</div>
                <h3 className="mt-1 text-[0.8125rem] font-medium leading-snug text-muted">{q.label}</h3>
              </>);
              return (
                <div key={q.key} className={cn('border-l-2 pl-4', hot ? 'border-bad' : 'border-line')}>
                  {q.href ? <Link href={q.href} className="group block rounded-md">{body}</Link> : body}
                </div>
              );
            })}
          </div>
          {waiting === 0 ? <p className="border-t border-line/70 px-5 py-6 text-sm text-muted sm:px-6">Nothing is waiting on your team right now.</p> : (
            <RowList className="border-t border-line/70" label="Work waiting on your team">
              {first3.overdue.map((x) => (
                <ListRow key={`o${x.id}`} tone="bad" icon={<AlertTriangle size={18} />} eyebrow="Overdue deadline" title={x.item_label} meta={[x.client_name, sentTo(x.bureau)].filter(Boolean).join(', ')}
                  action={{ href: `/app/disputes/${x.id}`, label: 'Open dispute' }}>
                  <DayMeter dueAt={x.due_at} extended={x.deadline_extended} now={now} size="sm" />
                </ListRow>))}
              {first3.letters.map((l) => (
                <ListRow key={`l${l.id}`} icon={<Pencil size={18} />} eyebrow="Letter awaiting approval" tag={aiUnapproved(l) ? <AiTag title="This version was worded by AI and has not been approved by a person yet">AI wording</AiTag> : undefined} title={l.title} detail={l.client_name} aside={relTime(l.created_at)}
                  action={{ href: `/app/letters/${l.id}`, label: 'Review letter' }} />))}
              {care.messages.map((m) => (
                <ListRow key={`m${m.id}`} icon={<MessageSquare size={18} />} eyebrow="Unanswered message" title={m.client_name} detail={<span className="line-clamp-2">{m.body}</span>} aside={relTime(m.created_at)}
                  action={{ href: `/app/clients/${m.client_id}?tab=messages`, label: 'Reply' }} />))}
              {first3.reports.map((r) => (
                <ListRow key={`r${r.id}`} icon={<ScanLine size={18} />} eyebrow="Report to review" title={r.client_name} detail={`${sentTo(r.bureau) ?? 'Credit'} report, not used until it is approved`} aside={relTime(r.created_at)}
                  action={{ href: `/app/reports/${r.id}`, label: 'Review report' }} />))}
            </RowList>
          )}
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-line/70 px-5 py-4 text-[0.8125rem] text-muted sm:px-6">
            <p>{hidden.length === 0 ? (waiting > 0 ? 'That is everything waiting on your team right now.' : 'New work appears here as it comes in.')
              : <>Showing the oldest of each. Not shown: {hidden.map((q, i) => <span key={q.key}>{i > 0 && ', '}{q.href ? <Link href={q.href} className="link">{q.count - q.shown} more {q.more}</Link> : `${q.count - q.shown} more ${q.more}`}</span>)}.</>}</p>
            <Link href="/app/tasks" className="link">All tasks</Link>
          </div>
        </section>
        {shortQueue && <div className="grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-4 xl:grid-cols-2 2xl:grid-cols-4">{figures}</div>}
        </div>

        <section aria-labelledby="windows" className="panel p-5 sm:p-6">
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <h2 id="windows" className="display text-xl">Investigation windows</h2>
            <Link href="/app/disputes" className="link text-[0.8125rem]">All disputes</Link>
          </div>
          <p className="mb-5 mt-1 text-[0.8125rem] text-muted">Bureau and furnisher response windows, on one calendar.</p>
          {windows.length === 0 ? <p className="text-sm text-muted">No submitted disputes yet.</p> : (
            <>
              <WindowCalendar now={now} timeZone={tz} rows={windows.map((x) => ({ id: x.id, href: `/app/disputes/${x.id}`, title: x.item_label, meta: [x.client_name, sentTo(x.bureau)].filter(Boolean).join(', '), startAt: windowStart(x.due_at, x.deadline_extended)?.toISOString() ?? null, dueAt: x.due_at }))} />
              {windows[0]!.n > windows.length && <p className="mt-4 text-[0.8125rem] text-muted">Showing the {windows.length} closest deadlines of {windows[0]!.n}. <Link href="/app/disputes?view=table" className="link">See the rest</Link></p>}
            </>
          )}
          <div className="mt-6 border-t border-line/70 pt-5">
            <h3 className="mb-3 text-sm font-semibold">Dispute outcomes, last 90 days</h3>
            <SplitBar parts={[{ label: 'Deleted', value: d.deleted, className: 'bg-ok' }, { label: 'Updated', value: d.updated, className: 'bg-info' }, { label: 'Verified', value: d.verified, className: 'bg-faint' }, { label: 'Unresolved', value: d.unresolved, className: 'bg-warn' }]} />
            {d.resolvedTotal > 0 && <p className="mt-3 text-[0.8125rem] text-muted">Outcomes depend on what bureaus and furnishers find after investigation. They are not a promise of future results.</p>}
          </div>
        </section>
      </div>

      {!shortQueue && <div className="mt-8 grid grid-cols-2 gap-x-4 gap-y-6 border-t border-line pt-6 lg:grid-cols-4">{figures}</div>}

      {brandNew || steps.some(([, done]) => !done) ? (
        <Section plain title="Get set up" hint="A few steps to your first reviewed dispute." className="mt-8">
          <ol className="grid gap-x-6 gap-y-1 sm:grid-cols-2 lg:grid-cols-5">
            {steps.map(([label, done, href], i) => (
              <li key={label}><Link href={href} className="group flex items-start gap-2.5 rounded-md py-1.5 text-sm">
                {done ? <CheckCircle2 size={18} className="mt-0.5 shrink-0 text-ok" aria-hidden /> : <Circle size={18} className="mt-0.5 shrink-0 text-faint" aria-hidden />}
                <span className={done ? 'text-muted' : 'font-medium decoration-brand decoration-2 underline-offset-4 group-hover:underline'}>{i + 1}. {label}{done && <span className="sr-only"> (done)</span>}</span></Link></li>))}
          </ol>
        </Section>
      ) : null}

      <Section plain className="mt-8" title="Client care" hint="New leads, uploads to review, and clients who have not heard from you lately."
        actions={<span className="flex items-center gap-1.5 text-[0.8125rem] text-muted"><HeartHandshake size={14} aria-hidden /> {careWaiting === 0 ? 'Everyone is up to date' : `${careWaiting} waiting`}</span>}>
        <div className="grid gap-x-8 gap-y-6 md:grid-cols-3">
          <CareList icon={UserPlus} title="New leads to contact" count={care.counts.leads} empty="No new leads waiting."
            items={care.leads.map((l) => ({ key: l.id, href: `/app/clients/${l.id}`, name: l.full_name, detail: l.source ?? 'Added by your team', when: relTime(l.created_at), urgent: l.hours >= 24 }))} />
          <CareList icon={FileUp} title="Uploads to review" count={care.counts.uploads} empty="No client uploads waiting."
            items={care.uploads.map((u) => ({ key: u.id, href: `/app/clients/${u.client_id}?tab=documents`, name: u.client_name, detail: u.file_name, when: relTime(u.created_at), urgent: u.hours >= 48 }))} />
          <CareList icon={MessageSquareDashed} title="No update in 14+ days" count={care.counts.quiet} empty="Every active client has heard from you recently."
            items={care.quiet.map((q) => ({ key: q.id, href: `/app/clients/${q.id}?tab=messages`, name: q.full_name, detail: q.last_contact ? `Last update ${fmtDate(q.last_contact)}` : 'Never sent an update', when: '', urgent: q.days >= 30 }))} />
        </div>
      </Section>

      <div className="mt-8 grid gap-x-8 gap-y-8 border-t border-line pt-6 lg:grid-cols-3">
        <section aria-labelledby="needs-you">
          <div className="mb-3 flex items-baseline justify-between gap-3"><h2 id="needs-you" className="text-lg font-semibold">Needs you today</h2><Link href="/app/tasks" className="link text-[0.8125rem]">All tasks</Link></div>
          {d.awaitingReview > 0 && ctx.can('disputes:approve') && <Link href="/app/disputes?status=ready_for_review&view=table" className="mb-3 flex items-center justify-between gap-3 rounded-xl bg-warn-soft p-3 text-sm text-warn"><span><strong>{d.awaitingReview}</strong> dispute{d.awaitingReview > 1 ? 's' : ''} waiting for your approval</span><ArrowRight size={16} aria-hidden /></Link>}
          {mine.length === 0 && d.awaitingReview === 0 ? <p className="text-sm text-muted">You’re all caught up.</p> : (
            <ul className="divide-y divide-line/70">{mine.map((t) => {
              const late = !!t.due_at && dueDay(t.due_at, tz) === 'overdue';
              return (
                <li key={t.id} className="flex items-center justify-between gap-3 py-2.5 text-sm"><div className="min-w-0"><div className="truncate font-medium">{t.title}</div>{t.client_name && <Link href={`/app/clients/${t.client_id}`} className="text-[0.8125rem] text-muted hover:underline">{t.client_name}</Link>}</div>
                  {t.due_at && <Badge tone={late ? 'bad' : 'neutral'}>{late && <span className="sr-only">Overdue: </span>}{fmtDate(t.due_at)}</Badge>}</li>);
            })}</ul>
          )}
        </section>
        <section aria-labelledby="clients-month"><h2 id="clients-month" className="mb-3 text-lg font-semibold">New clients per month</h2><BarSeries data={a.series.clients} height={140} /></section>
        <section aria-labelledby="disputes-month"><h2 id="disputes-month" className="mb-3 text-lg font-semibold">Disputes submitted per month</h2><BarSeries data={a.series.submitted} height={140} /></section>
      </div>
    </>
  );
}

type CareItem = { key: string; href: string; name: string; detail: string; when: string; urgent: boolean };

function CareList({ icon: Icon, title, items, count, empty }: { icon: typeof FileUp; title: string; items: CareItem[]; count: number; empty: string }) {
  return (
    <div>
      <h3 className="mb-3 flex items-center justify-between gap-2 text-sm font-semibold"><span className="flex items-center gap-2"><Icon size={15} className="text-muted" aria-hidden />{title}</span>{count > 0 && <Badge tone={items.some((i) => i.urgent) ? 'warn' : 'neutral'}>{count}</Badge>}</h3>
      {items.length === 0 ? <p className="text-sm text-muted">{empty}</p> : (
        <ul className="space-y-2.5">{items.map((i) => (
          <li key={i.key}><Link href={i.href} className="group block rounded-lg text-sm">
            <div className="flex items-center justify-between gap-2"><span className="truncate font-medium group-hover:underline">{i.name}</span>{i.when && <span className={i.urgent ? 'shrink-0 text-xs font-semibold text-warn' : 'shrink-0 text-xs text-muted'}>{i.when}</span>}</div>
            <p className={i.urgent && !i.when ? 'truncate text-xs text-warn' : 'truncate text-xs text-muted'}>{i.detail}</p>
          </Link></li>))}</ul>
      )}
    </div>
  );
}

/** Overdue investigation deadlines, letters waiting for approval and credit reports waiting for review, oldest first, under the viewer's row-level security. */
async function workFirst(db: Db) {
  const [overdue, letters, reports] = await Promise.all([
    db.rows<{ id: string; item_label: string; client_name: string; bureau: string | null; due_at: string; deadline_extended: boolean; days: number; n: number }>(
      `select d.id, d.item_label, c.full_name as client_name, d.bureau, d.due_at, d.deadline_extended, greatest(1, ceil(extract(epoch from now() - d.due_at) / 86400))::int as days, count(*) over ()::int as n
         from public.disputes d join public.clients c on c.id = d.client_id
        where d.status in ('submitted', 'under_investigation') and d.due_at < now() order by d.due_at limit 5`),
    // `source` is the current version's letter_versions.source — the same flag the letters list uses for the AI mark.
    db.rows<{ id: string; title: string; status: string; client_name: string; created_at: string; source: string | null; n: number }>(
      `select l.id, l.title, l.status, c.full_name as client_name, l.created_at, count(*) over ()::int as n,
              (select v.source from public.letter_versions v where v.letter_id = l.id and v.version = l.current_version) as source
         from public.letters l join public.clients c on c.id = l.client_id where l.status = 'pending_approval' order by l.created_at limit 5`),
    db.rows<{ id: string; bureau: string | null; client_name: string; created_at: string; n: number }>(
      `select r.id, r.bureau, c.full_name as client_name, r.created_at, count(*) over ()::int as n
         from public.credit_reports r join public.clients c on c.id = r.client_id where r.status = 'pending_review' order by r.created_at limit 5`),
  ]);
  return { overdue, letters, reports, counts: { overdue: overdue[0]?.n ?? 0, letters: letters[0]?.n ?? 0, reports: reports[0]?.n ?? 0 } };
}
