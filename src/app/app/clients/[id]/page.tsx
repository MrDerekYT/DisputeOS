import Link from 'next/link';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { AlertTriangle, Check as CheckIcon, Download, FileText, Gavel, Mail, MapPin, Pencil, Phone, Pin, ScanSearch, UserPlus } from 'lucide-react';
import { ActionForm, Check, Field, Select, SubmitButton, TextArea } from '@/components/forms';
import { Avatar, Badge, DefinitionList, EmptyState, Notice, PageHeader, Section, StatusBadge, Tabs } from '@/components/ui';
import { SplitBar } from '@/components/charts';
import { polishedProgress } from '@/lib/ai/assistant';
import { requireStaff } from '@/lib/auth/context';
import { CONSENT_DOCS, consentStatus } from '@/lib/compliance/disclosures';
import { CLIENT_STAGES, DOC_KIND_LABEL, DOC_KINDS, memberLabel, STAGE_LABEL, staffMembers } from '@/lib/crm';
import type { DisputeStatus } from '@/lib/disputes/workflow';
import { BUREAU_LABEL, cn, fmtDate, isUuid, money, relTime, type Bureau } from '@/lib/util';
import { cancelSubscriptionAction, recordPaymentAction, refundPaymentAction, subscribeClientAction } from '../../billing/actions';
import { addNoteAction, createTaskAction, invitePortalAction, markInboundReadAction, recordConsentAction, requestDocumentAction, reviewDocumentAction, revokeConsentAction, sendMessageAction, setTaskStatusAction, togglePinAction, uploadDocumentAction } from '../actions';
import { pullReportAction, uploadReportAction } from '../../reports/actions';
import { listProviders } from '@/lib/credit/providers';
import { ScoreHistory, type ScoreRow } from '@/components/score-history';
import { PRODUCT } from '@/lib/product';

export const metadata: Metadata = { title: 'Client' };

const TAB_KEYS = ['overview', 'reports', 'disputes', 'documents', 'letters', 'messages', 'tasks', 'notes', 'timeline', 'billing'] as const;
type Tab = (typeof TAB_KEYS)[number];

export default async function ClientPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ tab?: string; draft?: string }> }) {
  const { id } = await params;
  const sp = await searchParams;
  if (!isUuid(id)) notFound();
  const ctx = await requireStaff('clients:read');
  const tab: Tab = (TAB_KEYS as readonly string[]).includes(sp.tab ?? '') ? (sp.tab as Tab) : 'overview';

  const base = await ctx.tx(async (db) => {
    const c = await db.row<{
      id: string; full_name: string; email: string | null; phone: string | null; preferred_language: 'en' | 'es'; status: string; stage: (typeof CLIENT_STAGES)[number]; source: string | null; goals: string | null;
      address: { line1?: string; line2?: string; city?: string; state?: string; zip?: string }; ssn_last4: string | null; tags: string[]; assigned_to: string | null; assignee_name: string | null;
      portal_user_id: string | null; created_at: string; last_activity_at: string;
    }>(`select c.id, c.full_name, c.email, c.phone, c.preferred_language, c.status, c.stage, c.source, c.goals, c.address, c.ssn_last4, c.tags, c.assigned_to, u.full_name as assignee_name, c.portal_user_id, c.created_at, c.last_activity_at
          from public.clients c left join public.users u on u.id = c.assigned_to where c.id = $1`, [id]);
    if (!c) return null;
    const counts = await db.row<Record<string, number>>(
      `select (select count(*)::int from public.credit_reports where client_id = $1) as reports,
              (select count(*)::int from public.disputes where client_id = $1) as disputes,
              (select count(*)::int from public.documents where client_id = $1) as documents,
              (select count(*)::int from public.letters where client_id = $1) as letters,
              (select count(*)::int from public.tasks where client_id = $1 and status = 'open') as tasks,
              (select count(*)::int from public.communications where client_id = $1 and direction = 'inbound' and read_at is null) as unread,
              (select count(*)::int from public.document_requests where client_id = $1 and fulfilled_document_id is null) as requests`, [id]);
    return { c, counts: counts ?? {} };
  });
  if (!base) notFound();
  const { c, counts } = base;
  const addr = [[c.address.line1, c.address.line2].filter(Boolean).join(', '), [c.address.city, [c.address.state, c.address.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ')].filter(Boolean).join(' · ');
  const stageIdx = CLIENT_STAGES.indexOf(c.stage);
  const first = c.full_name.split(' ')[0] ?? c.full_name;

  const href = (k: string) => `/app/clients/${id}?tab=${k}`;
  const tabs = [
    { key: 'overview', label: 'Overview', href: href('overview') },
    { key: 'reports', label: 'Reports', href: href('reports'), count: counts.reports },
    { key: 'disputes', label: 'Disputes', href: href('disputes'), count: counts.disputes },
    { key: 'documents', label: 'Documents', href: href('documents'), count: counts.requests },
    { key: 'letters', label: 'Letters', href: href('letters'), count: counts.letters },
    { key: 'messages', label: 'Messages', href: href('messages'), count: counts.unread },
    { key: 'tasks', label: 'Tasks', href: href('tasks'), count: counts.tasks },
    { key: 'notes', label: 'Notes', href: href('notes') },
    { key: 'timeline', label: 'Timeline', href: href('timeline') },
    ...(ctx.can('billing:read') ? [{ key: 'billing', label: 'Billing', href: href('billing') }] : []),
  ];

  return (
    <>
      <PageHeader back={{ href: '/app/clients', label: 'Clients' }} title={c.full_name}
        subtitle={<span className="flex flex-wrap items-center gap-x-4 gap-y-1">
          {c.email && <span className="flex items-center gap-1.5"><Mail size={14} />{c.email}</span>}{c.phone && <span className="flex items-center gap-1.5"><Phone size={14} />{c.phone}</span>}{addr && <span className="flex items-center gap-1.5"><MapPin size={14} />{addr}</span>}
        </span>}
        actions={<>
          <StatusBadge status={c.status} />
          <Link href={`/app/clients/${id}/edit`} className="btn-secondary"><Pencil size={15} /> Edit</Link>
          <Link href={`/app/disputes/new?clientId=${id}`} className="btn-primary"><Gavel size={15} /> New dispute</Link>
        </>} />

      {/* Journey */}
      <div className="card mb-6 flex flex-wrap items-center gap-x-8 gap-y-4 p-4">
        <div className="flex items-center gap-3"><Avatar name={c.full_name} size={44} /><div className="text-sm"><div className="text-muted">Specialist</div><div className="font-medium">{c.assignee_name ?? 'Unassigned'}</div></div></div>
        <ol className="flex flex-1 items-center gap-1 overflow-x-auto" aria-label="Client journey">
          {CLIENT_STAGES.map((s, i) => (
            <li key={s} className="flex items-center gap-1">
              <span className={cn('rounded-full px-3 py-1 text-xs font-medium', i < stageIdx ? 'bg-brand text-brand-ink' : i === stageIdx ? 'bg-brand-soft text-brand-strong ring-1 ring-brand' : 'bg-raised text-faint')}>{i < stageIdx && <CheckIcon size={11} className="mr-1 inline" />}{STAGE_LABEL[s]}</span>
              {i < CLIENT_STAGES.length - 1 && <span className="h-px w-3 bg-line" />}
            </li>
          ))}
        </ol>
        <div className="flex flex-wrap gap-1.5">{c.tags.map((t) => <Badge key={t} tone="brand">{t}</Badge>)}{c.preferred_language === 'es' && <Badge>Español</Badge>}{c.portal_user_id ? <Badge tone="ok">Portal active</Badge> : <Badge>No portal access</Badge>}</div>
      </div>

      <Tabs tabs={tabs} active={tab} />

      {tab === 'overview' && <Overview id={id} ctx={ctx} c={c} first={first} />}
      {tab === 'reports' && <ReportsTab id={id} ctx={ctx} />}
      {tab === 'disputes' && <DisputesTab id={id} ctx={ctx} />}
      {tab === 'documents' && <DocumentsTab id={id} ctx={ctx} />}
      {tab === 'letters' && <LettersTab id={id} ctx={ctx} />}
      {tab === 'messages' && <MessagesTab id={id} ctx={ctx} c={c} draft={sp.draft} />}
      {tab === 'tasks' && <TasksTab id={id} ctx={ctx} />}
      {tab === 'notes' && <NotesTab id={id} ctx={ctx} />}
      {tab === 'timeline' && <TimelineTab id={id} ctx={ctx} />}
      {tab === 'billing' && <BillingTab id={id} ctx={ctx} />}
    </>
  );
}

type Ctx = Awaited<ReturnType<typeof requireStaff>>;
type C = { id: string; full_name: string; email: string | null; phone: string | null; preferred_language: 'en' | 'es'; goals: string | null; source: string | null; created_at: string; last_activity_at: string; portal_user_id: string | null; assigned_to: string | null; ssn_last4: string | null; address: Record<string, string | undefined> };

// ------------------------------------------------------------------ overview
async function Overview({ id, ctx, c, first }: { id: string; ctx: Ctx; c: C; first: string }) {
  const d = await ctx.tx(async (db) => {
    const outcomes = await db.row<{ total: number; deleted: number; updated: number; verified: number; waiting: number; unresolved: number }>(
      `select count(*) filter (where status in ('submitted','under_investigation','response_received','resolved'))::int as total, count(*) filter (where outcome = 'deleted')::int as deleted, count(*) filter (where outcome = 'updated')::int as updated,
              count(*) filter (where outcome = 'verified')::int as verified, count(*) filter (where outcome in ('unresolved','no_response'))::int as unresolved,
              count(*) filter (where status in ('submitted','under_investigation'))::int as waiting from public.disputes where client_id = $1`, [id]);
    const consents = await db.rows<{ id: string; kind: string; signed_name: string; signed_at: string; revoked_at: string | null; version: string }>('select id, kind, signed_name, signed_at, revoked_at, version from public.client_consents where client_id = $1 order by signed_at desc', [id]);
    const events = await db.rows<{ id: string; summary: string; created_at: string; actor: string | null }>(`select e.id, e.summary, e.created_at, u.full_name as actor from public.client_events e left join public.users u on u.id = e.actor_id where e.client_id = $1 order by e.created_at desc limit 8`, [id]);
    const requests = await db.rows<{ id: string; kind: string; due_at: string | null }>('select id, kind, due_at from public.document_requests where client_id = $1 and fulfilled_document_id is null', [id]);
    const upcoming = await db.rows<{ id: string; item_label: string; due_at: string }>("select id, item_label, due_at from public.disputes where client_id = $1 and status in ('submitted','under_investigation') and due_at is not null order by due_at limit 3", [id]);
    const tasks = await db.rows<{ id: string; title: string; due_at: string | null }>("select id, title, due_at from public.tasks where client_id = $1 and status = 'open' order by due_at nulls last limit 4", [id]);
    const scores = await db.rows<ScoreRow>('select bureau, model, score, scored_on from public.credit_scores where client_id = $1 order by scored_on', [id]);
    return { o: outcomes!, consents, events, requests, upcoming, tasks, scores };
  });
  const cs = consentStatus(d.consents);
  const pct = d.o.total ? Math.round(((d.o.deleted + d.o.updated) / d.o.total) * 100) : 0;
  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <div className="space-y-6 lg:col-span-2">
        <Section title="Dispute progress" hint="Only counts disputes that were actually submitted. Outcomes are decided by the bureaus and furnishers.">
          {d.o.total === 0 ? <p className="text-sm text-muted">No disputes submitted yet.</p> : (
            <>
              <div className="mb-4 flex items-end gap-6">
                <div><div className="font-display text-4xl font-semibold tabular-nums">{d.o.deleted + d.o.updated}<span className="text-lg text-muted"> / {d.o.total}</span></div><div className="text-xs text-muted">items removed or corrected ({pct}%)</div></div>
              </div>
              <SplitBar parts={[
                { label: 'Deleted', value: d.o.deleted, className: 'bg-ok' }, { label: 'Updated', value: d.o.updated, className: 'bg-info' }, { label: 'Verified as reported', value: d.o.verified, className: 'bg-faint' },
                { label: 'Unresolved', value: d.o.unresolved, className: 'bg-warn' }, { label: 'Awaiting response', value: d.o.waiting, className: 'bg-brand' },
              ]} />
            </>
          )}
          {d.upcoming.length > 0 && <ul className="mt-5 space-y-2 border-t border-line pt-4 text-sm">{d.upcoming.map((u) => <li key={u.id} className="flex justify-between gap-3"><Link className="hover:underline" href={`/app/disputes/${u.id}`}>{u.item_label}</Link><span className="text-muted">response due {fmtDate(u.due_at)}</span></li>)}</ul>}
        </Section>

        {d.scores.length > 0 && <Section title="Reported credit scores" hint="Exactly as stated on each report"><ScoreHistory rows={d.scores} note="Scores change for many reasons and are not a prediction or a promise. They come from the reports you have imported." /></Section>}

        <Section title="Recent activity" actions={<Link href={`/app/clients/${id}?tab=timeline`} className="text-sm text-brand-strong hover:underline">View all</Link>}>
          {d.events.length === 0 ? <p className="text-sm text-muted">Nothing yet.</p> : <ol className="space-y-3">{d.events.map((e) => (
            <li key={e.id} className="flex gap-3 text-sm"><span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-brand" /><div><div>{e.summary}</div><div className="text-xs text-muted">{e.actor ?? 'System'} · {relTime(e.created_at)}</div></div></li>))}</ol>}
        </Section>

        <Section title="Details">
          <DefinitionList items={[['Email', c.email], ['Phone', c.phone], ['Preferred language', c.preferred_language === 'es' ? 'Español' : 'English'], ['SSN on file', c.ssn_last4 ? `••• •• ${c.ssn_last4}` : null], ['Source', c.source], ['Client since', fmtDate(c.created_at)], ['Last activity', relTime(c.last_activity_at)], ['Goals', c.goals]]} />
          {!c.portal_user_id && c.email && (
            <ActionForm action={invitePortalAction} className="mt-5 border-t border-line pt-4"><input type="hidden" name="clientId" value={id} /><SubmitButton variant="secondary"><UserPlus size={15} /> Invite to client portal</SubmitButton></ActionForm>
          )}
        </Section>
      </div>

      <div className="space-y-6">
        <Section title="Needs attention">
          <ul className="space-y-3 text-sm">
            {cs.missing.length > 0 && <li className="flex gap-2 text-warn"><AlertTriangle size={16} className="mt-0.5 shrink-0" /><span>Missing consents: {cs.missing.map((k) => CONSENT_DOCS.find((x) => x.kind === k)?.title.split(' (')[0] ?? k).join('; ')}</span></li>}
            {cs.inCancellationWindow && <li className="flex gap-2 text-warn"><AlertTriangle size={16} className="mt-0.5 shrink-0" /><span>Within the 3-business-day cancellation window.</span></li>}
            {d.requests.map((r) => <li key={r.id} className="flex gap-2"><FileText size={16} className="mt-0.5 shrink-0 text-muted" /><span>Waiting for {DOC_KIND_LABEL[r.kind] ?? r.kind}{r.due_at ? ` (due ${fmtDate(r.due_at)})` : ''}</span></li>)}
            {d.tasks.map((t) => <li key={t.id} className="flex gap-2"><CheckIcon size={16} className="mt-0.5 shrink-0 text-muted" /><span>{t.title}{t.due_at ? <span className="text-muted"> · {fmtDate(t.due_at)}</span> : ''}</span></li>)}
            {!cs.missing.length && !d.requests.length && !d.tasks.length && !cs.inCancellationWindow && <li className="text-muted">Nothing needs attention. 🎉</li>}
          </ul>
        </Section>

        <Section title="Compliance record" hint="What this client has received and signed.">
          <ul className="space-y-2.5">
            {CONSENT_DOCS.filter((x) => x.required || d.consents.some((k) => k.kind === x.kind)).map((doc) => {
              const rec = d.consents.find((k) => k.kind === doc.kind && !k.revoked_at);
              return (
                <li key={doc.kind} className="flex items-start justify-between gap-2 text-sm">
                  <div className="min-w-0"><div className="font-medium leading-snug">{doc.title}</div><div className="text-xs text-muted">{rec ? `Signed ${fmtDate(rec.signed_at)} as “${rec.signed_name}”` : doc.required ? 'Not on file — required' : 'Not on file'}</div></div>
                  {rec ? <form action={revokeConsentAction}><input type="hidden" name="id" value={rec.id} /><input type="hidden" name="clientId" value={id} /><button className="text-xs text-muted underline" type="submit">Revoke</button></form> : <Badge tone={doc.required ? 'warn' : 'neutral'}>Missing</Badge>}
                </li>);
            })}
          </ul>
          <details className="mt-4 border-t border-line pt-3">
            <summary className="cursor-pointer text-sm font-medium text-brand-strong">Record a consent</summary>
            <ActionForm action={recordConsentAction} className="mt-3 space-y-3">
              <input type="hidden" name="clientId" value={id} />
              <Select label="Document" name="kind" required options={CONSENT_DOCS.map((x) => ({ value: x.kind, label: x.title }))} />
              <Field label="Name the client signed with" name="signedName" defaultValue={c.full_name} required />
              <SubmitButton variant="secondary">Record</SubmitButton>
              <p className="text-xs text-muted">Records that the client received and signed the document. The client can also e-sign in their portal.</p>
            </ActionForm>
          </details>
        </Section>

        <Section title="Draft an update for the client">
          <p className="text-sm text-muted">Creates a plain-language progress note from the dispute data above. You review and send it.</p>
          <Link href={`/app/clients/${id}?tab=messages&draft=progress`} className="btn-secondary mt-3">Draft update for {first}</Link>
        </Section>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ reports
async function ReportsTab({ id, ctx }: { id: string; ctx: Ctx }) {
  const { reports, authorized, pulls } = await ctx.tx(async (db) => ({
    reports: await db.rows<{ id: string; bureau: Bureau; status: string; report_date: string | null; created_at: string; n: number; source: string }>(
      `select r.id, r.bureau, r.status, r.report_date, r.created_at, r.source, (select count(*)::int from public.tradelines t where t.report_id = r.id) as n from public.credit_reports r where r.client_id = $1 order by r.created_at desc`, [id]),
    authorized: !!(await db.row("select 1 from public.client_consents where client_id = $1 and kind = 'fcra_authorization' and revoked_at is null", [id])),
    pulls: await db.rows<{ id: string; provider: string; mode: string; status: string; created_at: string; error: string | null }>('select id, provider, mode, status, created_at, error from public.report_pulls where client_id = $1 order by created_at desc limit 5', [id]),
  }));
  const providers = listProviders().filter((p) => p.status === 'available');
  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
      <div className="space-y-4">
        {reports.length === 0 ? <EmptyState title="No reports yet" body="Upload a bureau report (text-based PDF, HTML, text or CSV). It is read automatically, then a person confirms it." icon={<ScanSearch size={20} />} /> : (
          <div className="table-wrap"><table className="table"><thead><tr><th>Bureau</th><th>Report date</th><th>Accounts</th><th>Status</th><th>Imported</th></tr></thead>
            <tbody>{reports.map((r) => (
              <tr key={r.id} className="row-link"><td><Link href={`/app/reports/${r.id}`} className="font-medium hover:underline">{BUREAU_LABEL[r.bureau]}</Link></td><td>{fmtDate(r.report_date)}</td><td className="tabular-nums">{r.n}</td><td><StatusBadge status={r.status} /></td><td className="text-muted">{relTime(r.created_at)} · {r.source}</td></tr>))}</tbody></table></div>
        )}
        {reports.some((r) => r.status === 'approved') && <Link href={`/app/clients/${id}/compare`} className="btn-primary"><ScanSearch size={16} /> Open the three-bureau comparison</Link>}
        {reports.some((r) => r.status === 'approved') && <Link href={`/app/clients/${id}/what-if`} className="btn-secondary ml-2">What-if calculator</Link>}
      </div>
      <div className="space-y-6">
      <Section title="Pull automatically" hint="Credit Connect">
        {!authorized ? (
          <Notice tone="warn" title="Authorization needed first">Record the client’s written authorization to review their credit reports (Overview → Compliance record). Automatic import stays locked until then.</Notice>
        ) : providers.length === 0 ? (
          <p className="text-sm text-muted">No live provider is connected. Push reports through the API, or upload them below. {ctx.can('settings:manage') && <Link className="underline" href="/app/settings/developers">Developers &amp; connections →</Link>}</p>
        ) : (
          <ActionForm action={pullReportAction} className="space-y-3">
            <input type="hidden" name="clientId" value={id} />
            <Select label="Provider" name="provider" defaultValue={providers[0]!.key} options={providers.map((p) => ({ value: p.key, label: p.name }))} />
            <SubmitButton pendingText="Requesting…">Pull reports</SubmitButton>
            <p className="text-xs text-muted">Imports land in <em>pending review</em>. A person approves them before anything is analysed.</p>
          </ActionForm>
        )}
        {pulls.length > 0 && <ul className="mt-4 divide-y divide-line border-t border-line pt-1 text-xs">{pulls.map((x) => <li key={x.id} className="flex items-center justify-between gap-2 py-2"><span>{x.mode === 'pull' ? 'Pulled' : 'Pushed'} via <strong>{x.provider}</strong></span><span className="flex items-center gap-2 text-muted">{relTime(x.created_at)} <StatusBadge status={x.status === 'imported' ? 'completed_run' : x.status} text={x.status} /></span></li>)}</ul>}
      </Section>
      <Section title="Upload a report">
        <ActionForm action={uploadReportAction} className="space-y-4">
          <input type="hidden" name="clientId" value={id} />
          <div><label className="label" htmlFor="file">File</label><input id="file" name="file" type="file" required accept=".pdf,.txt,.html,.htm,.csv" className="field !p-2 text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-brand-soft file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-brand-strong" /></div>
          <Select label="Bureau (if the file doesn’t say)" name="bureau" placeholder="Detect automatically" options={(Object.keys(BUREAU_LABEL) as Bureau[]).map((b) => ({ value: b, label: BUREAU_LABEL[b] }))} />
          <SubmitButton pendingText="Reading report…">Upload & read</SubmitButton>
          <p className="text-xs text-muted">Best results: text-based PDF or the CSV template. Scanned images are not read (no OCR). Files are stored encrypted. <a className="underline" href="/templates/report-import.csv">CSV template</a></p>
        </ActionForm>
      </Section>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ disputes
async function DisputesTab({ id, ctx }: { id: string; ctx: Ctx }) {
  const rows = await ctx.tx((db) => db.rows<{ id: string; item_label: string; status: DisputeStatus; round: number; due_at: string | null; outcome: string | null }>('select id, item_label, status, round, due_at, outcome from public.disputes where client_id = $1 order by created_at desc', [id]));
  return rows.length === 0 ? (
    <EmptyState title="No disputes for this client" body="Start from a finding in the bureau comparison, or create one directly." icon={<Gavel size={20} />} action={<Link href={`/app/disputes/new?clientId=${id}`} className="btn-primary">New dispute</Link>} />
  ) : (
    <div className="table-wrap"><table className="table"><thead><tr><th>Item</th><th>Status</th><th>Round</th><th>Response due</th><th>Outcome</th></tr></thead>
      <tbody>{rows.map((d) => (<tr key={d.id} className="row-link"><td><Link href={`/app/disputes/${d.id}`} className="font-medium hover:underline">{d.item_label}</Link></td><td><StatusBadge status={d.status} /></td><td className="tabular-nums">{d.round}</td><td>{fmtDate(d.due_at)}</td><td>{d.outcome ? <StatusBadge status={d.outcome} /> : '—'}</td></tr>))}</tbody></table></div>
  );
}

// ------------------------------------------------------------------ documents
async function DocumentsTab({ id, ctx }: { id: string; ctx: Ctx }) {
  const { docs, reqs } = await ctx.tx(async (db) => ({
    docs: await db.rows<{ id: string; kind: string; file_name: string; size_bytes: number; source: string; review_status: string; created_at: string; uploader: string | null }>(
      `select d.id, d.kind, d.file_name, d.size_bytes, d.source, d.review_status, d.created_at, u.full_name as uploader from public.documents d left join public.users u on u.id = d.uploaded_by where d.client_id = $1 order by d.created_at desc`, [id]),
    reqs: await db.rows<{ id: string; kind: string; note: string | null; due_at: string | null; fulfilled_document_id: string | null }>('select id, kind, note, due_at, fulfilled_document_id from public.document_requests where client_id = $1 order by created_at desc', [id]),
  }));
  const kindOpts = DOC_KINDS.map((k) => ({ value: k, label: DOC_KIND_LABEL[k]! }));
  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
      <div className="space-y-6">
        <Section title="Requested from the client">
          {reqs.length === 0 ? <p className="text-sm text-muted">No requests. Use the form to ask the client for a document — they will see it in their portal.</p> : (
            <ul className="divide-y divide-line text-sm">{reqs.map((r) => (<li key={r.id} className="flex items-center justify-between gap-3 py-2.5"><span>{DOC_KIND_LABEL[r.kind] ?? r.kind}{r.note && <span className="text-muted"> — {r.note}</span>}</span>{r.fulfilled_document_id ? <Badge tone="ok">Received</Badge> : <Badge tone="warn">{r.due_at ? `Due ${fmtDate(r.due_at)}` : 'Waiting'}</Badge>}</li>))}</ul>
          )}
        </Section>
        <Section title={`Vault (${docs.length})`} hint="Files are encrypted at rest. Every download is logged.">
          {docs.length === 0 ? <p className="text-sm text-muted">No documents yet.</p> : (
            <ul className="divide-y divide-line">{docs.map((x) => (
              <li key={x.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div className="min-w-0"><a href={`/api/documents/${x.id}`} className="flex items-center gap-2 font-medium hover:underline"><Download size={14} className="text-muted" /><span className="truncate">{x.file_name}</span></a>
                  <div className="text-xs text-muted">{DOC_KIND_LABEL[x.kind] ?? x.kind} · {(x.size_bytes / 1024).toFixed(0)} KB · {x.source === 'client' ? 'uploaded by client' : `by ${x.uploader ?? 'staff'}`} · {relTime(x.created_at)}</div></div>
                <div className="flex items-center gap-2"><StatusBadge status={x.review_status} />
                  {x.review_status === 'pending_review' && (<><form action={reviewDocumentAction}><input type="hidden" name="id" value={x.id} /><input type="hidden" name="clientId" value={id} /><input type="hidden" name="decision" value="accepted" /><button className="btn-secondary btn-sm">Accept</button></form>
                    <form action={reviewDocumentAction}><input type="hidden" name="id" value={x.id} /><input type="hidden" name="clientId" value={id} /><input type="hidden" name="decision" value="rejected" /><button className="btn-ghost btn-sm">Reject</button></form></>)}</div>
              </li>))}</ul>
          )}
        </Section>
      </div>
      <div className="space-y-6">
        <Section title="Upload a file">
          <ActionForm action={uploadDocumentAction} resetOnSuccess className="space-y-3">
            <input type="hidden" name="clientId" value={id} />
            <Select label="Type" name="kind" options={kindOpts} defaultValue="other" />
            <div><label className="label" htmlFor="docfile">File</label><input id="docfile" name="file" type="file" required accept=".pdf,.png,.jpg,.jpeg,.txt,.csv" className="field !p-2 text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-brand-soft file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-brand-strong" /><p className="hint">PDF, PNG, JPG, TXT or CSV · max 10 MB. Type is checked from the file’s contents.</p></div>
            <SubmitButton pendingText="Encrypting…">Upload</SubmitButton>
          </ActionForm>
        </Section>
        <Section title="Request a document">
          <ActionForm action={requestDocumentAction} resetOnSuccess className="space-y-3">
            <input type="hidden" name="clientId" value={id} />
            <Select label="What do you need?" name="kind" options={kindOpts.filter((k) => k.value !== 'contract')} defaultValue="id" />
            <Field label="Note for the client" name="note" placeholder="e.g. A clear photo of your driver’s license" />
            <Field label="Needed by" name="due" type="date" />
            <SubmitButton variant="secondary">Send request</SubmitButton>
          </ActionForm>
        </Section>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ letters
async function LettersTab({ id, ctx }: { id: string; ctx: Ctx }) {
  const rows = await ctx.tx((db) => db.rows<{ id: string; title: string; status: string; current_version: number; created_at: string }>('select id, title, status, current_version, created_at from public.letters where client_id = $1 order by created_at desc', [id]));
  return (
    <div className="space-y-4">
      <div className="flex justify-end"><Link href={`/app/letters/new?clientId=${id}`} className="btn-primary">New letter</Link></div>
      {rows.length === 0 ? <EmptyState title="No letters yet" body="Letters are drafted from a dispute or a template, reviewed, and approved by a manager." icon={<FileText size={20} />} /> : (
        <div className="table-wrap"><table className="table"><thead><tr><th>Letter</th><th>Status</th><th>Version</th><th>Created</th></tr></thead><tbody>{rows.map((l) => (
          <tr key={l.id} className="row-link"><td><Link className="font-medium hover:underline" href={`/app/letters/${l.id}`}>{l.title}</Link></td><td><StatusBadge status={l.status} /></td><td className="tabular-nums text-muted">v{l.current_version}</td><td className="text-muted">{relTime(l.created_at)}</td></tr>))}</tbody></table></div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ messages
async function MessagesTab({ id, ctx, c, draft }: { id: string; ctx: Ctx; c: C; draft?: string }) {
  const { msgs, stats } = await ctx.tx(async (db) => ({
    msgs: await db.rows<{ id: string; direction: string; channel: string; subject: string | null; body: string; status: string; created_at: string; author: string | null }>(
      `select m.id, m.direction, m.channel, m.subject, m.body, m.status, m.created_at, u.full_name as author from public.communications m left join public.users u on u.id = m.author_id where m.client_id = $1 order by m.created_at desc limit 100`, [id]),
    stats: await db.row<{ total: number; deleted: number; updated: number; verified: number; waiting: number; draft: number }>(
      `select count(*) filter (where status in ('submitted','under_investigation','response_received','resolved'))::int as total, count(*) filter (where outcome = 'deleted')::int as deleted, count(*) filter (where outcome = 'updated')::int as updated,
              count(*) filter (where outcome = 'verified')::int as verified, count(*) filter (where status in ('submitted','under_investigation'))::int as waiting, count(*) filter (where status = 'draft')::int as draft from public.disputes where client_id = $1`, [id]),
  }));
  let prefill = '';
  let note = '';
  if (draft === 'progress' && stats) {
    const r = await polishedProgress({ firstName: c.full_name.split(' ')[0] ?? '', language: c.preferred_language, ...stats });
    prefill = r.text;
    note = r.usedAi ? `Wording polished by ${r.provider}; facts verified unchanged.` : r.note ?? 'Built from the dispute data — no AI rewriting applied.';
  }
  const unread = msgs.some((m) => m.direction === 'inbound' && m.status === 'received');
  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_24rem]">
      <div className="space-y-3">
        {unread && <form action={markInboundReadAction}><input type="hidden" name="clientId" value={id} /><button className="btn-secondary btn-sm" type="submit">Mark all as read</button></form>}
        {msgs.length === 0 ? <EmptyState title="No messages yet" body="Messages sent here appear in the client’s portal. Logged calls and texts show up too." /> : msgs.map((m) => (
          <div key={m.id} className={cn('max-w-[85%] rounded-2xl border p-4', m.direction === 'inbound' ? 'border-line bg-surface' : m.direction === 'internal' ? 'border-dashed border-line bg-raised' : 'ml-auto border-brand/30 bg-brand-soft')}>
            <div className="mb-1 flex flex-wrap items-center gap-2 text-xs text-muted"><strong className="text-ink">{m.direction === 'inbound' ? c.full_name : m.author ?? 'Automation'}</strong><span>{m.channel}{m.direction === 'internal' ? ' (logged)' : ''}</span><span>{relTime(m.created_at)}</span>{m.status === 'queued' && <Badge tone="warn">Not delivered</Badge>}{m.status === 'failed' && <Badge tone="bad">Failed</Badge>}</div>
            {m.subject && <div className="text-sm font-medium">{m.subject}</div>}<p className="whitespace-pre-wrap text-sm">{m.body}</p>
          </div>))}
      </div>
      <Section title="Send or log">
        {note && <div className="mb-3"><Notice tone="info">{note}</Notice></div>}
        <ActionForm action={sendMessageAction} resetOnSuccess className="space-y-3">
          <input type="hidden" name="clientId" value={id} />
          <Select label="Channel" name="channel" defaultValue="portal" options={[{ value: 'portal', label: 'Client portal message' }, { value: 'email', label: c.email ? `Email to ${c.email}` : 'Email (no address on file)' }, { value: 'note_call', label: 'Log a phone call (nothing is sent)' }, { value: 'note_sms', label: 'Log a text message (nothing is sent)' }]} />
          <Field label="Subject (email only)" name="subject" />
          <TextArea label="Message" name="body" rows={7} required defaultValue={prefill} />
          <SubmitButton pendingText="Sending…">Send</SubmitButton>
          <p className="text-xs text-muted">You are the sender — messages typed here go out immediately. Do not promise results or timelines. Automated messages wait for approval in the Inbox.</p>
        </ActionForm>
      </Section>
    </div>
  );
}

// ------------------------------------------------------------------ tasks / notes / timeline
async function TasksTab({ id, ctx }: { id: string; ctx: Ctx }) {
  const { tasks, team } = await ctx.tx(async (db) => ({
    tasks: await db.rows<{ id: string; title: string; detail: string | null; status: string; due_at: string | null; assignee: string | null; source: string }>(
      `select t.id, t.title, t.detail, t.status, t.due_at, t.source, u.full_name as assignee from public.tasks t left join public.users u on u.id = t.assignee_id where t.client_id = $1 order by (t.status = 'open') desc, t.due_at nulls last`, [id]),
    team: await staffMembers(db),
  }));
  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
      <div>{tasks.length === 0 ? <EmptyState title="No tasks" body="Create follow-ups, reminders and to-dos for this client." /> : (
        <ul className="card divide-y divide-line">{tasks.map((t) => (
          <li key={t.id} className="flex items-start gap-3 p-4">
            <form action={setTaskStatusAction}><input type="hidden" name="id" value={t.id} /><input type="hidden" name="status" value={t.status === 'done' ? 'open' : 'done'} />
              <button aria-label={t.status === 'done' ? 'Reopen task' : 'Complete task'} className={cn('mt-0.5 grid h-5 w-5 place-items-center rounded-full border', t.status === 'done' ? 'border-ok bg-ok text-white' : 'border-line hover:border-brand')}>{t.status === 'done' && <CheckIcon size={12} />}</button></form>
            <div className="min-w-0 flex-1"><div className={cn('text-sm font-medium', t.status === 'done' && 'text-muted line-through')}>{t.title}</div>{t.detail && <div className="text-sm text-muted">{t.detail}</div>}
              <div className="mt-0.5 text-xs text-muted">{t.assignee ?? 'Unassigned'}{t.due_at ? ` · due ${fmtDate(t.due_at)}` : ''}{t.source === 'automation' ? ' · automation' : ''}</div></div>
          </li>))}</ul>)}</div>
      <Section title="New task">
        <ActionForm action={createTaskAction} resetOnSuccess className="space-y-3">
          <input type="hidden" name="clientId" value={id} />
          <Field label="Title" name="title" required /><TextArea label="Details" name="detail" rows={2} />
          <Select label="Type" name="kind" defaultValue="follow_up" options={[{ value: 'general', label: 'General' }, { value: 'follow_up', label: 'Follow-up' }, { value: 'document', label: 'Document' }, { value: 'review', label: 'Review' }, { value: 'deadline', label: 'Deadline' }]} />
          <Field label="Due" name="due" type="date" />
          <Select label="Assign to" name="assigneeId" placeholder="Me" options={team.map((m) => ({ value: m.id, label: memberLabel(m) }))} />
          <SubmitButton>Add task</SubmitButton>
        </ActionForm>
      </Section>
    </div>
  );
}

async function NotesTab({ id, ctx }: { id: string; ctx: Ctx }) {
  const notes = await ctx.tx((db) => db.rows<{ id: string; body: string; pinned: boolean; created_at: string; author: string | null }>(
    `select n.id, n.body, n.pinned, n.created_at, u.full_name as author from public.client_notes n left join public.users u on u.id = n.author_id where n.client_id = $1 order by n.pinned desc, n.created_at desc`, [id]));
  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
      <div className="space-y-3">{notes.length === 0 ? <EmptyState title="No notes" body="Internal notes are never visible to the client." /> : notes.map((n) => (
        <article key={n.id} className={cn('card p-4', n.pinned && 'border-brand/40')}>
          <p className="whitespace-pre-wrap text-sm">{n.body}</p>
          <div className="mt-2 flex items-center justify-between text-xs text-muted"><span>{n.author ?? 'Unknown'} · {relTime(n.created_at)}</span>
            <form action={togglePinAction}><input type="hidden" name="id" value={n.id} /><input type="hidden" name="clientId" value={id} /><button className="flex items-center gap-1 hover:text-ink" type="submit"><Pin size={12} /> {n.pinned ? 'Unpin' : 'Pin'}</button></form></div>
        </article>))}</div>
      <Section title="Add an internal note"><ActionForm action={addNoteAction} resetOnSuccess className="space-y-3"><input type="hidden" name="clientId" value={id} /><TextArea label="Note" name="body" rows={5} required /><Check name="pinned">Pin to the top</Check><SubmitButton>Save note</SubmitButton></ActionForm></Section>
    </div>
  );
}

async function TimelineTab({ id, ctx }: { id: string; ctx: Ctx }) {
  const events = await ctx.tx((db) => db.rows<{ id: string; kind: string; summary: string; created_at: string; actor: string | null }>(`select e.id, e.kind, e.summary, e.created_at, u.full_name as actor from public.client_events e left join public.users u on u.id = e.actor_id where e.client_id = $1 order by e.created_at desc limit 200`, [id]));
  return events.length === 0 ? <EmptyState title="No activity yet" /> : (
    <ol className="card divide-y divide-line">{events.map((e) => (<li key={e.id} className="flex items-start justify-between gap-4 p-4 text-sm"><div><div>{e.summary}</div><div className="text-xs text-muted">{e.actor ?? 'System'} · {e.kind.replace(/_/g, ' ')}</div></div><time className="shrink-0 text-xs text-muted" dateTime={e.created_at} title={e.created_at}>{fmtDate(e.created_at)} · {relTime(e.created_at)}</time></li>))}</ol>
  );
}

// ------------------------------------------------------------------ billing
async function BillingTab({ id, ctx }: { id: string; ctx: Ctx }) {
  const { subs, payments, plans } = await ctx.tx(async (db) => ({
    subs: await db.rows<{ id: string; status: string; plan_name: string; price_cents: number; interval: string; started_at: string }>(`select s.id, s.status, p.name as plan_name, p.price_cents, p.interval, s.started_at from public.client_subscriptions s join public.service_plans p on p.id = s.plan_id where s.client_id = $1 order by s.created_at desc`, [id]),
    payments: await db.rows<{ id: string; amount_cents: number; method: string; status: string; paid_at: string; note: string | null }>('select id, amount_cents, method, status, paid_at, note from public.payments where client_id = $1 order by paid_at desc', [id]),
    plans: await db.rows<{ id: string; name: string; price_cents: number; interval: string }>('select id, name, price_cents, interval from public.service_plans where active order by name'),
  }));
  const active = subs.find((s) => s.status === 'active');
  const paid = payments.filter((p) => p.status === 'succeeded').reduce((a, p) => a + p.amount_cents, 0);
  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
      <div className="space-y-6">
        <Section title="Service plan">
          {active ? (<div className="flex flex-wrap items-center justify-between gap-3"><div><div className="font-medium">{active.plan_name}</div><div className="text-sm text-muted">{money(active.price_cents)}{active.interval === 'month' ? ' / month' : ' one time'} · since {fmtDate(active.started_at)}</div></div>
            {ctx.can('billing:write') && <form action={cancelSubscriptionAction}><input type="hidden" name="id" value={active.id} /><input type="hidden" name="clientId" value={id} /><button className="btn-secondary btn-sm">Cancel plan</button></form>}</div>) : <p className="text-sm text-muted">No active plan.</p>}
        </Section>
        <Section title="Payments" hint={`${money(paid)} received in total. Payments are recorded by your team — ${PRODUCT.name} does not charge cards.`}>
          {payments.length === 0 ? <p className="text-sm text-muted">No payments recorded.</p> : (
            <ul className="divide-y divide-line text-sm">{payments.map((p) => (<li key={p.id} className="flex flex-wrap items-center justify-between gap-3 py-2.5"><div><div className="font-medium tabular-nums">{money(p.amount_cents)} <span className="font-normal text-muted">· {p.method}</span></div><div className="text-xs text-muted">{fmtDate(p.paid_at)}{p.note ? ` · ${p.note}` : ''}</div></div>
              <div className="flex items-center gap-2"><StatusBadge status={p.status} />{p.status === 'succeeded' && ctx.can('billing:write') && <form action={refundPaymentAction}><input type="hidden" name="id" value={p.id} /><input type="hidden" name="clientId" value={id} /><button className="text-xs text-muted underline">Mark refunded</button></form>}</div></li>))}</ul>)}
        </Section>
      </div>
      {ctx.can('billing:write') && (
        <div className="space-y-6">
          <Section title="Record a payment">
            <ActionForm action={recordPaymentAction} resetOnSuccess className="space-y-3">
              <input type="hidden" name="clientId" value={id} /><input type="hidden" name="subscriptionId" value={active?.id ?? ''} />
              <Field label="Amount ($)" name="amount" inputMode="decimal" required defaultValue={active ? (active.price_cents / 100).toFixed(2) : ''} />
              <Select label="Method" name="method" defaultValue="card" options={[{ value: 'card', label: 'Card' }, { value: 'ach', label: 'ACH / bank' }, { value: 'check', label: 'Check' }, { value: 'cash', label: 'Cash' }, { value: 'other', label: 'Other' }]} />
              <Field label="Note" name="note" />
              <Check name="performed" required>This payment is for services <strong>already performed</strong>. (Credit repair organizations may not collect payment in advance.)</Check>
              <SubmitButton>Record payment</SubmitButton>
            </ActionForm>
          </Section>
          {plans.length > 0 && (<Section title="Assign a plan"><ActionForm action={subscribeClientAction} className="space-y-3"><input type="hidden" name="clientId" value={id} />
            <Select label="Plan" name="planId" required options={plans.map((p) => ({ value: p.id, label: `${p.name} — ${money(p.price_cents)}${p.interval === 'month' ? '/mo' : ''}` }))} /><SubmitButton variant="secondary">Assign</SubmitButton></ActionForm></Section>)}
        </div>
      )}
    </div>
  );
}

