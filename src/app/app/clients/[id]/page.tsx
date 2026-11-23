import Link from 'next/link';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { AlertTriangle, ArrowLeft, Check as CheckIcon, CheckCircle2, ChevronDown, ChevronRight, Download, FileText, Gavel, Mail, MapPin, Pencil, Phone, Pin, ScanSearch } from 'lucide-react';
import { ActionForm, Check, ConfirmButton, Field, Select, SubmitButton, TextArea } from '@/components/forms';
import { AiTag, Avatar, Badge, DayMeter, DefinitionList, EmptyState, Notice, Section, StatusBadge, Tabs } from '@/components/ui';
import { SplitBar } from '@/components/charts';
import { aiUnapproved, REPORT_SOURCE_LABEL } from '@/components/staff-kit';
import { loadDisputeCounts, progressSummary } from '@/lib/ai/assistant';
import { AI_COSTS, getBalance, polishOffer } from '@/lib/ai/credits';
import { providerStatus } from '@/lib/ai/provider';
import { PolishNote } from '@/components/polish-note';
import { requireStaff } from '@/lib/auth/context';
import { CONSENT_DOCS, consentTitle, isDraftEraSignature, isRendered, SERVICE_CONSENTS, signatureSource, type ConsentDoc } from '@/lib/compliance/disclosures';
import { CLIENT_STAGES, DOC_KIND_LABEL, DOC_KINDS, memberLabel, STAGE_LABEL, staffMembers } from '@/lib/crm';
import type { DisputeStatus } from '@/lib/disputes/workflow';
import { BUREAU_LABEL, cn, dayInZone, fmtDate, isUuid, money, relTime, type Bureau } from '@/lib/util';
import { cancelSubscriptionAction, refundPaymentAction, subscribeClientAction } from '../../billing/actions';
import { addNoteAction, createTaskAction, markInboundReadAction, polishProgressAction, recordConsentAction, requestDocumentAction, reviewDocumentAction, revokeConsentAction, sendMessageAction, setTaskStatusAction, togglePinAction, uploadDocumentAction } from '../actions';
import { importDocumentAsReportAction, pullReportAction, uploadReportAction } from '../../reports/actions';
import { currentAuthorization } from '@/lib/credit/authorization';
import { listProviders } from '@/lib/credit/providers';
import { ScoreHistory, type ScoreRow } from '@/components/score-history';
import { PRODUCT } from '@/lib/product';
import { emailIsLive } from '@/lib/lead-outreach';
import { FileInput } from '@/components/file-input';
import { maxUploadBytes, maxUploadMb, tooLargeMessage } from '@/lib/upload';
import { buildPlan, loadPlanInput } from '@/lib/plan';
import { loadIntake } from '@/lib/intake-load';
import { IntakeBlock } from './intake-block';
import { SpecialtyBlock } from './specialty-block';
import { ProtectionsBlock } from './protections-block';
import { AgingOffBlock } from './aging-off-block';
import { CaseToolsBlock } from './case-tools-block';
import { BankCollectionsBlock } from './bank-collections-block';
import { PersonalInfoBlock } from './personal-info-block';
import { SmsConsentBlock } from './sms-consent-block';
import { ReferredByBlock } from './referred-by-block';
import { ChargeBlock } from './charge-block';
import { loadSpecialty } from '@/lib/credit/specialty-reports';
import { businessToday } from '@/lib/letters/service';
import { loadClientAgreements, loadServiceStatus, paperDateRange, renderFor, revokeConfirmation } from '@/lib/agreements';
import { sayDay } from '@/lib/business-days';
import { WelcomeBlock } from './welcome-block';
import { AgreementTermsBlock } from './agreement-terms-block';

export const metadata: Metadata = { title: 'Client' };

const TAB_KEYS = ['overview', 'reports', 'disputes', 'documents', 'letters', 'messages', 'tasks', 'notes', 'timeline', 'billing'] as const;
type Tab = (typeof TAB_KEYS)[number];

export default async function ClientPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ tab?: string; draft?: string; period?: string }> }) {
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
      <header className="mb-6">
        <Link href="/app/clients" className="mb-3 inline-flex items-center gap-1 text-[0.8125rem] font-medium text-muted hover:text-ink"><ArrowLeft size={14} aria-hidden /> Clients</Link>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex min-w-0 items-center gap-4">
            <span className="hidden sm:block"><Avatar name={c.full_name} size={52} /></span>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                <h1 className="display text-[1.75rem] [overflow-wrap:anywhere] sm:text-[2rem]">{c.full_name}</h1>
                <StatusBadge status={c.status} />
              </div>
              {(c.email || c.phone || addr) && (
                <p className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted">
                  {c.email && <span className="flex min-w-0 items-center gap-1.5"><Mail size={14} aria-hidden className="shrink-0" /><span className="[overflow-wrap:anywhere]">{c.email}</span></span>}
                  {c.phone && <span className="flex items-center gap-1.5"><Phone size={14} aria-hidden className="shrink-0" />{c.phone}</span>}
                  {addr && <span className="flex items-center gap-1.5"><MapPin size={14} aria-hidden className="shrink-0" />{addr}</span>}
                </p>
              )}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Link href={`/app/clients/${id}/statement`} className="btn-secondary">Work statement</Link>
            <Link href={`/app/clients/${id}/edit`} className="btn-secondary"><Pencil size={15} aria-hidden /> Edit</Link>
            <Link href={`/app/disputes/new?clientId=${id}`} className="btn-primary"><Gavel size={15} aria-hidden /> New dispute</Link>
          </div>
        </div>
      </header>

      {/* Where the client is on the journey, and who looks after them. A strip, not a box. */}
      <section aria-label="Journey and specialist" className="mb-6 grid gap-x-10 gap-y-4 border-y border-line py-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
        <div className="min-w-0">
          {stageIdx >= 0 && <p className="mb-2 text-[0.8125rem] text-muted">Stage {stageIdx + 1} of {CLIENT_STAGES.length}: <strong className="font-semibold text-ink">{STAGE_LABEL[c.stage]}</strong></p>}
          <ol className="grid grid-cols-5 gap-1.5" aria-label="Client journey">
            {CLIENT_STAGES.map((s, i) => (
              <li key={s} aria-current={i === stageIdx ? 'step' : undefined} className="min-w-0">
                <span aria-hidden className={cn('block h-1.5 rounded-full', i < stageIdx ? 'bg-brand' : i === stageIdx ? 'bg-brand shadow-[0_0_0_3px_rgb(var(--brand)/0.25)]' : 'bg-line')} />
                <span className={cn('mt-2 hidden items-center gap-1 truncate text-xs sm:flex', i === stageIdx ? 'font-semibold text-ink' : i < stageIdx ? 'text-muted' : 'text-faint')}>
                  {i < stageIdx && <CheckIcon size={12} aria-hidden className="shrink-0" />}{STAGE_LABEL[s]}
                  <span className="sr-only">{i < stageIdx ? ' (done)' : i === stageIdx ? ' (current stage)' : ' (not started)'}</span>
                </span>
                <span className="sr-only sm:hidden">{STAGE_LABEL[s]}{i < stageIdx ? ' (done)' : i === stageIdx ? ' (current stage)' : ' (not started)'}</span>
              </li>
            ))}
          </ol>
        </div>
        <dl className="flex flex-wrap items-center gap-x-8 gap-y-3 text-sm">
          <div><dt className="text-[0.8125rem] text-muted">Specialist</dt><dd className="font-medium">{c.assignee_name ?? 'Unassigned'}</dd></div>
          <div><dt className="text-[0.8125rem] text-muted">Client portal</dt><dd>{c.portal_user_id ? <Badge tone="ok" dot>Portal active</Badge> : <Badge>No portal access</Badge>}</dd></div>
          {(c.tags.length > 0 || c.preferred_language === 'es') && (
            <div><dt className="sr-only">Tags</dt><dd className="flex flex-wrap gap-1.5">{c.tags.map((t) => <Badge key={t} tone="brand">{t}</Badge>)}{c.preferred_language === 'es' && <Badge>Español</Badge>}</dd></div>
          )}
        </dl>
      </section>

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
      {tab === 'billing' && <BillingTab id={id} ctx={ctx} period={sp.period} />}
    </>
  );
}

type Ctx = Awaited<ReturnType<typeof requireStaff>>;
type C = { id: string; full_name: string; email: string | null; phone: string | null; preferred_language: 'en' | 'es'; goals: string | null; source: string | null; created_at: string; last_activity_at: string; portal_user_id: string | null; assigned_to: string | null; ssn_last4: string | null; address: Record<string, string | undefined> };

// ------------------------------------------------------------------ overview
/**
 * What staff record here: signatures the client gave on paper, never the consent to electronic records (the client
 * gives it in the portal); in a personal workspace the account holder's own consents, never the CROA statement or
 * service agreement.
 */
const recordableIn = (personal: boolean) => (x: ConsentDoc) => x.kind !== 'esign' && !(personal && (x.kind === 'croa_disclosure' || x.kind === 'croa_contract'));

async function Overview({ id, ctx, c, first }: { id: string; ctx: Ctx; c: C; first: string }) {
  const d = await ctx.tx(async (db) => {
    const outcomes = await db.row<{ total: number; deleted: number; updated: number; verified: number; waiting: number; unresolved: number }>(
      `select count(*) filter (where status in ('submitted','under_investigation','response_received','resolved'))::int as total, count(*) filter (where outcome = 'deleted')::int as deleted, count(*) filter (where outcome = 'updated')::int as updated,
              count(*) filter (where outcome = 'verified')::int as verified, count(*) filter (where outcome in ('unresolved','no_response'))::int as unresolved,
              count(*) filter (where status in ('submitted','under_investigation'))::int as waiting from public.disputes where client_id = $1`, [id]);
    const consents = await db.rows<{ id: string; kind: string; signed_name: string; signed_at: string; revoked_at: string | null; version: string; has_text: boolean; recorded_by: string | null; signed_on: string | null; revoked_reason: string | null }>(
      'select id, kind, signed_name, signed_at, revoked_at, version, text_shown is not null as has_text, recorded_by, signed_on::text, revoked_reason from public.client_consents where client_id = $1 order by signed_at desc', [id]);
    const events = await db.rows<{ id: string; summary: string; created_at: string; actor: string | null }>(`select e.id, e.summary, e.created_at, u.full_name as actor from public.client_events e left join public.users u on u.id = e.actor_id where e.client_id = $1 order by e.created_at desc limit 8`, [id]);
    const requests = await db.rows<{ id: string; kind: string; due_at: string | null }>('select id, kind, due_at from public.document_requests where client_id = $1 and fulfilled_document_id is null', [id]);
    const upcoming = await db.rows<{ id: string; item_label: string; due_at: string; deadline_extended: boolean }>("select id, item_label, due_at, deadline_extended from public.disputes where client_id = $1 and status in ('submitted','under_investigation') and due_at is not null order by due_at limit 3", [id]);
    const tasks = await db.rows<{ id: string; title: string; due_at: string | null }>("select id, title, due_at from public.tasks where client_id = $1 and status = 'open' order by due_at nulls last limit 4", [id]);
    const scores = await db.rows<ScoreRow>('select bureau, model, score, scored_on from public.credit_scores where client_id = $1 order by scored_on', [id]);
    // The gate the server applies (src/lib/agreements.ts): the documents missing and the cancellation period, counted on
    // the agency's own calendar day with the days stored at signing. A personal workspace has none of it.
    const cs = (await loadServiceStatus(db, id))!;
    // In a personal workspace the account holder reads each document before giving it: its exact text, as it is stored.
    const ag = cs.personal ? await loadClientAgreements(db, ctx.orgId, id) : null;
    const toGive = ag ? CONSENT_DOCS.filter((x) => recordableIn(true)(x) && !ag.inForce.includes(x.kind)).map((x) => renderFor(ag, x.kind)).filter(isRendered) : [];
    return { o: outcomes!, consents, events, requests, upcoming, tasks, scores, plan: await loadPlanInput(db, id), cs, toGive };
  });
  const cs = d.cs;
  const personal = cs.personal;
  // A personal workspace makes no agreement with itself, so its plan never asks for the CROA documents.
  const plan = buildPlan({ ...d.plan, missingConsents: personal ? [] : d.plan.missingConsents, firstName: first, self: ctx.session.orgMode === 'personal' });
  const pct = d.o.total ? Math.round(((d.o.deleted + d.o.updated) / d.o.total) * 100) : 0;
  const now = new Date();
  const quiet = !cs.missing.length && !d.requests.length && !d.tasks.length && !cs.inCancellationWindow;
  const paperDates = paperDateRange(dayInZone(cs.tz));
  const recordable = CONSENT_DOCS.filter(recordableIn(personal));
  // Which documents the record lists: an agency's required ones and whatever is on file; in a personal workspace only what is on file.
  const listed = CONSENT_DOCS.filter((x) => (!personal && x.required) || d.consents.some((k) => k.kind === x.kind));
  return (
    <div className="grid gap-x-8 gap-y-6 lg:grid-cols-3">
      {/* The plan is the one thing to read first: a numbered list, most pressing on top, each row goes where the work is. */}
      <section className="panel overflow-hidden lg:col-span-3" aria-labelledby="plan-title">
        <div className="px-5 pb-4 pt-5 sm:px-6">
          <h2 id="plan-title" className="text-lg font-semibold leading-snug">{`Plan for ${first}`}</h2>
          <p className="mt-0.5 text-[0.8125rem] text-muted">Built from this client’s own records, most pressing first. Suggestions only — nothing here predicts a score or an outcome.</p>
        </div>
        <ol className="divide-y divide-line/70 border-t border-line/70">
          {plan.map((p, i) => (
            <li key={p.key}>
              <Link href={p.href ?? `/app/clients/${id}`} className={cn('group flex items-start gap-4 px-5 py-3.5 text-sm transition-colors hover:bg-raised/60 sm:px-6', i === 0 && p.tone !== 'ok' && 'bg-brand-soft/30')}>
                <span className={cn('display grid h-8 w-8 shrink-0 place-items-center rounded-full text-sm', i === 0 && p.tone !== 'ok' ? 'bg-brand text-brand-ink' : 'bg-raised text-muted')} aria-hidden>{i + 1}</span>
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-2 text-[0.9375rem] font-semibold leading-snug text-ink">{p.title}{p.tone === 'warn' && <Badge tone="warn">Needs action</Badge>}{p.tone === 'ok' && <Badge tone="ok">Done</Badge>}</span>
                  <span className="mt-0.5 block text-muted">{p.detail}</span>
                </span>
                <ChevronRight size={18} aria-hidden className="mt-1.5 shrink-0 text-faint transition-colors group-hover:text-brand-strong" />
              </Link>
            </li>))}
        </ol>
      </section>

      <div className="space-y-6 lg:col-span-2">
        <Section title="Dispute progress" hint="Only counts disputes that were actually submitted. Outcomes are decided by the bureaus and furnishers.">
          {d.o.total === 0 ? <p className="text-sm text-muted">No disputes submitted yet.</p> : (
            <>
              <div className="mb-4">
                <div className="display text-5xl tabular-nums">{d.o.deleted + d.o.updated}<span className="text-xl text-muted"> / {d.o.total}</span></div>
                <div className="mt-1 text-[0.8125rem] text-muted">items removed or corrected ({pct}%)</div>
              </div>
              <SplitBar parts={[
                { label: 'Deleted', value: d.o.deleted, className: 'bg-ok' }, { label: 'Updated', value: d.o.updated, className: 'bg-info' }, { label: 'Verified as reported', value: d.o.verified, className: 'bg-faint' },
                { label: 'Unresolved', value: d.o.unresolved, className: 'bg-warn' }, { label: 'Awaiting response', value: d.o.waiting, className: 'bg-brand' },
              ]} />
            </>
          )}
          {d.upcoming.length > 0 && (
            <div className="mt-5 border-t border-line pt-4">
              <h3 className="text-sm font-semibold">Open investigation windows</h3>
              <ul className="mt-3 space-y-4">{d.upcoming.map((u) => (
                <li key={u.id}>
                  <div className="mb-1 flex flex-wrap items-baseline justify-between gap-x-3 text-sm"><Link className="font-medium hover:underline" href={`/app/disputes/${u.id}`}>{u.item_label}</Link><span className="text-[0.8125rem] text-muted">response due {fmtDate(u.due_at)}</span></div>
                  <DayMeter dueAt={u.due_at} extended={u.deadline_extended} now={now} size="sm" />
                </li>))}</ul>
            </div>
          )}
        </Section>

        {d.scores.length > 0 && <Section title="Reported credit scores" hint="Exactly as stated on each report"><ScoreHistory rows={d.scores} note="Scores change for many reasons and are not a prediction or a promise. They come from the reports you have imported." /></Section>}

        <Section plain title="Recent activity" actions={<Link href={`/app/clients/${id}?tab=timeline`} className="link text-sm">View all</Link>}>
          {d.events.length === 0 ? <p className="text-sm text-muted">Nothing yet.</p> : <ol className="space-y-3">{d.events.map((e) => (
            <li key={e.id} className="flex gap-3 text-sm"><span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-line-strong" aria-hidden /><div className="min-w-0"><div>{e.summary}</div><div className="text-xs text-muted">{e.actor ?? 'System'} · {relTime(e.created_at)}</div></div></li>))}</ol>}
        </Section>

        <Section plain title="Details">
          <DefinitionList items={[['Email', c.email], ['Phone', c.phone], ['Preferred language', c.preferred_language === 'es' ? 'Español' : 'English'], ['SSN on file', c.ssn_last4 ? `••• •• ${c.ssn_last4}` : null], ['Source', c.source], ['Client since', fmtDate(c.created_at)], ['Last activity', relTime(c.last_activity_at)], ['Goals', c.goals]]} />
        </Section>
      </div>

      <div className="space-y-6">
        {/* A personal workspace has no client to invite: the person works on their own file. */}
        {!personal && <WelcomeBlock ctx={ctx} clientId={id} first={first} email={c.email} portalUserId={c.portal_user_id} />}

        {/* What the service agreement states this client will pay: the agency's figures or the client's own (LEG-9). */}
        {!personal && <AgreementTermsBlock ctx={ctx} clientId={id} first={first} />}

        <Section title="Needs attention">
          <ul className="space-y-3 text-sm">
            {cs.clientCancelledOn && <li className="flex gap-2.5"><AlertTriangle size={16} aria-hidden className="mt-0.5 shrink-0 text-warn" /><span><strong className="font-semibold">Agreement cancelled:</strong> {first} cancelled the service agreement in the portal on {sayDay(cs.clientCancelledOn)}. No dispute can be submitted and no letter recorded as sent unless {first} signs a new one.</span></li>}
            {cs.missing.length > 0 && <li className="flex gap-2.5"><AlertTriangle size={16} aria-hidden className="mt-0.5 shrink-0 text-warn" /><span><strong className="font-semibold">Missing consents:</strong> {cs.missing.map((k) => CONSENT_DOCS.find((x) => x.kind === k)?.title.split(' (')[0] ?? k).join('; ')}</span></li>}
            {cs.inCancellationWindow && cs.cancellationEndsOn && <li className="flex gap-2.5"><AlertTriangle size={16} aria-hidden className="mt-0.5 shrink-0 text-warn" /><span><strong className="font-semibold">Cancellation period:</strong> {first} can cancel without penalty through {sayDay(cs.cancellationEndsOn)}. No dispute can be submitted and no letter recorded as sent before then.</span></li>}
            {d.requests.map((r) => <li key={r.id} className="flex gap-2.5"><FileText size={16} aria-hidden className="mt-0.5 shrink-0 text-muted" /><span>Waiting for {DOC_KIND_LABEL[r.kind] ?? r.kind}{r.due_at ? ` (due ${fmtDate(r.due_at)})` : ''}</span></li>)}
            {d.tasks.map((t) => <li key={t.id} className="flex gap-2.5"><CheckIcon size={16} aria-hidden className="mt-0.5 shrink-0 text-muted" /><span>{t.title}{t.due_at ? <span className="text-muted"> · {fmtDate(t.due_at)}</span> : ''}</span></li>)}
            {quiet && <li className="flex gap-2.5 text-muted"><CheckCircle2 size={16} aria-hidden className="mt-0.5 shrink-0 text-ok" />Nothing needs attention.</li>}
          </ul>
        </Section>

        <Section plain id="compliance" title="Compliance record" hint={personal ? 'In a personal workspace no credit repair agreement is needed: you are working on your own file. Record the authorization only if you use automatic report import.' : 'What this client has received and signed.'}>
          {listed.length > 0 && <ul className="space-y-3">
            {listed.map((doc) => {
              const rec = d.consents.find((k) => k.kind === doc.kind && !k.revoked_at);
              const cancelled = !rec ? d.consents.find((k) => k.kind === doc.kind && k.revoked_at && k.revoked_reason === 'client_cancelled') : undefined;
              // Only the statement, the service agreement and the authorization stop disputes when revoked (SERVICE_CONSENTS).
              const gates = !personal && SERVICE_CONSENTS.includes(doc.kind);
              // The client gives the E-SIGN consent in the portal; a client with no portal account signs on paper and needs none.
              // In a personal workspace no CROA document is needed at all (one may be on file from before).
              const notNeeded = !rec && ((doc.kind === 'esign' && !c.portal_user_id) || (personal && (doc.kind === 'croa_disclosure' || doc.kind === 'croa_contract')));
              const recordedOn = rec ? fmtDate(dayInZone(cs.tz, new Date(rec.signed_at))) : '';
              // How it was given: e-signed in the portal, on paper recorded by staff, or by the account holder of a personal workspace.
              const src = rec ? signatureSource(rec, personal) : null;
              return (
                <li key={doc.kind} className="flex items-start justify-between gap-3 text-sm">
                  <div className="min-w-0"><div className="font-medium leading-snug">{consentTitle(doc.kind, personal)}</div>
                    <div className="text-xs text-muted">{rec ? (src === 'paper'
                      ? <>Signed on paper{rec.signed_on ? ` on ${fmtDate(rec.signed_on)}` : ''} as “{rec.signed_name}” · recorded by staff on {recordedOn}{rec.has_text && <> · <a className="link" href={`/api/consents/${rec.id}/pdf`}>App’s text when recorded (PDF)</a></>}</>
                      : src === 'self'
                        ? <>Given by the account holder on {recordedOn} as “{rec.signed_name}”{rec.has_text && <> · <a className="link" href={`/api/consents/${rec.id}/pdf`}>Copy (PDF)</a></>}</>
                        : <>Signed {recordedOn} as “{rec.signed_name}”{rec.has_text && <> · e-signed in the portal · <a className="link" href={`/api/consents/${rec.id}/pdf`}>Copy (PDF)</a></>}</>)
                      : notNeeded ? (personal ? 'Not needed in a personal workspace.' : 'Not needed for paper signatures. If the client joins the portal, they give it there first.')
                        : cancelled ? `Cancelled by the client in the portal on ${fmtDate(dayInZone(cs.tz, new Date(cancelled.revoked_at!)))}`
                          : doc.kind === 'esign' ? 'Not on file — the client gives it first, in the portal' : gates ? 'Not on file — required' : 'Not on file'}</div>
                    {/* A personal workspace needs no current statement or agreement, so one from the 2026-01 drafts asks for nothing. */}
                    {rec && !personal && isDraftEraSignature(rec) && (
                      <p className="mt-1 text-xs font-medium text-warn">
                        {doc.kind === 'croa_contract' ? 'Signed before the current agreement: it has no terms or notice of cancellation.' : 'Signed before the current statement: it is not the full Consumer Credit File Rights statement.'}{' '}
                        <span className="font-normal text-muted">Revoke it, then {c.portal_user_id ? `ask ${first} to sign in: the portal asks for the current one` : `send a welcome link (or record a new paper signature) so ${first} signs the current one`}.</span>
                      </p>
                    )}
                  </div>
                  {rec ? <form action={revokeConsentAction}><input type="hidden" name="id" value={rec.id} /><input type="hidden" name="clientId" value={id} /><ConfirmButton className="text-xs text-muted underline hover:text-ink" message={revokeConfirmation(doc.kind, personal)}>Revoke</ConfirmButton></form>
                    : <Badge tone={notNeeded || personal || !doc.required ? 'neutral' : 'warn'}>{notNeeded ? 'Not needed' : 'Missing'}</Badge>}
                </li>);
            })}
          </ul>}
          <details className="mt-4">
            <summary className="link cursor-pointer text-sm">Record a consent</summary>
            <ActionForm action={recordConsentAction} className="mt-3 space-y-3">
              <input type="hidden" name="clientId" value={id} />
              <Select label="Document" name="kind" required options={recordable.map((x) => ({ value: x.kind, label: consentTitle(x.kind, personal) }))} />
              {personal ? (
                <>
                  {/* A personal workspace: the account holder gives their own consent here, today. No paper, no staff. They read the text first. */}
                  {d.toGive.length > 0 && (
                    <div role="group" aria-label="The text you give" className="space-y-3 rounded-lg border border-line bg-raised/40 p-3 text-sm">
                      {d.toGive.map((r) => (
                        <div key={r.doc.kind}>
                          <p className="font-semibold leading-snug">{r.doc.title}</p>
                          {r.blocks.map((b, i) => <p key={i} className="mt-1 text-muted">{b.text}</p>)}
                        </div>))}
                    </div>)}
                  <Field label="Your full legal name" name="signedName" defaultValue={c.full_name} required />
                  <SubmitButton variant="secondary">Record</SubmitButton>
                  <p className="text-xs text-muted">Records that you, the account holder, give the document you choose yourself, today, with the text shown above. The exact text and its fingerprint are kept with the record.</p>
                </>
              ) : (
                <>
                  <Field label="Name the client signed with" name="signedName" defaultValue={c.full_name} required />
                  <Field label="Date written on the signed paper" name="paperSignedOn" type="date" min={paperDates.min} max={paperDates.max} required />
                  <SubmitButton variant="secondary">Record</SubmitButton>
                  <p className="text-xs text-muted">Records that the client signed this document on paper, on the date written on it. What is stored with the record is the app’s text of the document today, dated with the date on the paper, not a copy of the paper: keep the signed paper, or upload a scan under Documents. The statement comes before the service agreement, and the agreement before the authorization; a service agreement’s cancellation period runs from the date on the paper. The consent to electronic records is not recorded here: the client gives it in their portal, where they can also e-sign the others.</p>
                </>
              )}
            </ActionForm>
          </details>
        </Section>

        <SmsConsentBlock ctx={ctx} clientId={id} phone={c.phone} lang={c.preferred_language} />

        <ReferredByBlock ctx={ctx} clientId={id} />

        <Section plain title="Draft an update for the client">
          <p className="text-sm text-muted">Creates a plain-language progress note from the dispute data above. You review and send it.</p>
          <Link href={`/app/clients/${id}?tab=messages&draft=progress`} className="btn-secondary mt-3">Draft update for {first}</Link>
        </Section>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ reports
async function ReportsTab({ id, ctx }: { id: string; ctx: Ctx }) {
  const { reports, authorized, pulls, specialty, specialtyFiles } = await ctx.tx(async (db) => ({
    specialty: await loadSpecialty(db, id),
    specialtyFiles: await db.rows<{ id: string; file_name: string }>("select id, file_name from public.documents where client_id = $1 and kind = 'specialty_report' order by created_at desc", [id]),
    reports: await db.rows<{ id: string; bureau: Bureau; status: string; report_date: string | null; created_at: string; n: number; source: string }>(
      `select r.id, r.bureau, r.status, r.report_date, r.created_at, r.source, (select count(*)::int from public.tradelines t where t.report_id = r.id) as n from public.credit_reports r where r.client_id = $1 order by r.created_at desc`, [id]),
    authorized: !!(await currentAuthorization(db, id)),
    pulls: await db.rows<{ id: string; provider: string; mode: string; status: string; created_at: string; error: string | null }>('select id, provider, mode, status, created_at, error from public.report_pulls where client_id = $1 order by created_at desc limit 5', [id]),
  }));
  const providers = listProviders().filter((p) => p.status === 'available');
  // Staff add a report only with the client's written authorization on file; a personal workspace needs none
  // (src/lib/credit/authorization.ts). The server refuses the same way.
  const canAddReport = authorized || ctx.session.orgMode === 'personal';
  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
      <div className="space-y-4">
        {reports.length === 0 ? <EmptyState title="No reports yet" body="Upload a bureau report (text-based PDF, HTML, text or CSV). It is read automatically, then a person confirms it." icon={<ScanSearch size={20} />} /> : (
          // Grouped by bureau: the newest report of each is the one in use, so it leads; earlier ones fold away.
          <div className="panel divide-y divide-line/70">
            {(Object.keys(BUREAU_LABEL) as Bureau[]).map((b) => {
              const [latest, ...older] = reports.filter((r) => r.bureau === b); // the query returns newest first
              if (!latest) return null;
              const row = (r: (typeof reports)[number], lead: boolean) => (
                <Link href={`/app/reports/${r.id}`} className="group flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 rounded-lg">
                  <span className="min-w-0 text-sm"><span className={lead ? 'font-semibold decoration-brand decoration-2 underline-offset-4 group-hover:underline' : 'text-muted group-hover:underline'}>Report dated {fmtDate(r.report_date)}</span><span className="text-muted"> · {r.n} account{r.n === 1 ? '' : 's'} · imported {relTime(r.created_at)} by {REPORT_SOURCE_LABEL[r.source] ?? r.source}</span></span>
                  <StatusBadge status={r.status} />
                </Link>);
              return (
                <section key={b} aria-label={`${BUREAU_LABEL[b]} reports`} className="px-5 py-4 sm:px-6">
                  <h3 className="mb-2 flex items-baseline justify-between gap-3 text-[0.9375rem] font-semibold">{BUREAU_LABEL[b]}<span className="text-[0.8125rem] font-normal text-muted">{older.length + 1} report{older.length ? 's' : ''}</span></h3>
                  {row(latest, true)}
                  {older.length > 0 && (
                    <details className="group/older mt-2.5">
                      <summary className="flex w-fit cursor-pointer list-none items-center gap-1 rounded-md text-[0.8125rem] font-semibold text-brand-strong [&::-webkit-details-marker]:hidden">{older.length} earlier report{older.length === 1 ? '' : 's'} <ChevronDown size={15} aria-hidden className="transition-transform group-open/older:rotate-180" /></summary>
                      <ul className="mt-2 space-y-2 border-l-2 border-line pl-3.5">{older.map((r) => <li key={r.id}>{row(r, false)}</li>)}</ul>
                    </details>
                  )}
                </section>);
            })}
          </div>
        )}
        {reports.some((r) => r.status === 'approved') && (
          <div className="flex flex-wrap gap-2">
            <Link href={`/app/clients/${id}/compare`} className="btn-primary"><ScanSearch size={16} aria-hidden /> Open the three-bureau comparison</Link>
            <Link href={`/app/clients/${id}/what-if`} className="btn-secondary">What-if calculator</Link>
          </div>
        )}
        <AgingOffBlock ctx={ctx} clientId={id} />
        <CaseToolsBlock ctx={ctx} clientId={id} />
        <BankCollectionsBlock ctx={ctx} clientId={id} />
        <PersonalInfoBlock ctx={ctx} clientId={id} />
        {specialty && <SpecialtyBlock clientId={id} states={specialty.states} bankingConcern={specialty.bankingConcern} files={specialtyFiles} today={businessToday()} />}
        <ProtectionsBlock ctx={ctx} clientId={id} />
      </div>
      <div className="space-y-6">
      <Section title="Upload a report">
        {!canAddReport ? (
          <Notice tone="warn" title="Authorization needed first">Record the client’s written authorization to review their credit reports (Overview → Compliance record) before you upload a report. A report the client uploads in their portal can still be read.</Notice>
        ) : (
        <ActionForm action={uploadReportAction} className="space-y-4">
          <input type="hidden" name="clientId" value={id} />
          <div><label className="label" htmlFor="file">File</label><FileInput id="file" accept=".pdf,.txt,.html,.htm,.csv" maxBytes={maxUploadBytes()} tooLarge={tooLargeMessage(maxUploadMb())} /><p className="hint">PDF, HTML, TXT or CSV · max {maxUploadMb()} MB.</p></div>
          <Select label="Bureau (if the file doesn’t say)" name="bureau" placeholder="Detect automatically" options={(Object.keys(BUREAU_LABEL) as Bureau[]).map((b) => ({ value: b, label: BUREAU_LABEL[b] }))} />
          <SubmitButton pendingText="Reading report…">Upload & read</SubmitButton>
          <p className="text-xs text-muted">Best results: text-based PDF or the CSV template. Scanned images are not read (no OCR). Files are stored encrypted. <a className="link" href="/templates/report-import.csv">CSV template</a></p>
        </ActionForm>
        )}
      </Section>
      <Section plain title="Pull automatically" hint="Credit Connect">
        {!authorized ? (
          <Notice tone="warn" title="Authorization needed first">Record the client’s written authorization to review their credit reports (Overview → Compliance record). Automatic import stays locked until then.</Notice>
        ) : providers.length === 0 ? (
          <p className="text-sm text-muted">No live provider is connected. Push reports through the API, or upload them below. {ctx.can('settings:manage') && <Link className="link" href="/app/settings/developers">Developers &amp; connections</Link>}</p>
        ) : (
          <ActionForm action={pullReportAction} className="space-y-3">
            <input type="hidden" name="clientId" value={id} />
            <Select label="Provider" name="provider" defaultValue={providers[0]!.key} options={providers.map((p) => ({ value: p.key, label: p.name }))} />
            <SubmitButton pendingText="Requesting…">Pull reports</SubmitButton>
            <p className="text-xs text-muted">Imports land in <em>pending review</em>. A person approves them before anything is analysed.</p>
          </ActionForm>
        )}
        {pulls.length > 0 && <ul className="mt-4 divide-y divide-line/70 border-t border-line pt-1 text-xs">{pulls.map((x) => <li key={x.id} className="flex items-center justify-between gap-2 py-2"><span>{x.mode === 'pull' ? 'Pulled' : 'Pushed'} via <strong>{x.provider}</strong></span><span className="flex items-center gap-2 text-muted">{relTime(x.created_at)} <StatusBadge status={x.status === 'imported' ? 'completed_run' : x.status} text={x.status} /></span></li>)}</ul>}
      </Section>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ disputes
async function DisputesTab({ id, ctx }: { id: string; ctx: Ctx }) {
  const rows = await ctx.tx((db) => db.rows<{ id: string; item_label: string; status: DisputeStatus; round: number; due_at: string | null; deadline_extended: boolean; outcome: string | null }>('select id, item_label, status, round, due_at, deadline_extended, outcome from public.disputes where client_id = $1 order by created_at desc', [id]));
  const now = new Date();
  return rows.length === 0 ? (
    <EmptyState title="No disputes for this client" body="Start from a finding in the bureau comparison, or create one directly." icon={<Gavel size={20} />} action={<Link href={`/app/disputes/new?clientId=${id}`} className="btn-primary">New dispute</Link>} />
  ) : (
    <div className="table-wrap"><table className="table table-stack"><thead><tr><th>Item</th><th>Status</th><th>Round</th><th>Response due</th><th>Outcome</th></tr></thead>
      <tbody>{rows.map((d) => {
        // The window is only drawn while a response is actually being waited for; before that there is no deadline, after it the date is history.
        const waiting = d.status === 'submitted' || d.status === 'under_investigation';
        return (
          <tr key={d.id} className="row-link"><td className="cell-main"><Link href={`/app/disputes/${d.id}`} className="font-medium hover:underline">{d.item_label}</Link></td><td><StatusBadge status={d.status} /></td><td className="tabular-nums" data-label="Round">{d.round}</td>
            <td className={cn('sm:min-w-[15rem]', waiting && d.due_at ? 'cell-full' : !d.due_at && 'cell-none')} data-label={waiting && d.due_at ? undefined : 'Due'}>{waiting && d.due_at ? <><DayMeter dueAt={d.due_at} extended={d.deadline_extended} now={now} size="sm" /><div className="mt-0.5 text-xs text-muted">{fmtDate(d.due_at)}</div></> : d.due_at ? <span className="text-muted">{fmtDate(d.due_at)}</span> : <span className="text-faint">—</span>}</td>
            <td className={d.outcome ? undefined : 'cell-none'}>{d.outcome ? <StatusBadge status={d.outcome} /> : <span className="text-faint">—</span>}</td></tr>);
      })}</tbody></table></div>
  );
}

// ------------------------------------------------------------------ documents
async function DocumentsTab({ id, ctx }: { id: string; ctx: Ctx }) {
  const { docs, reqs, intake, authorized } = await ctx.tx(async (db) => ({
    intake: await loadIntake(db, id),
    authorized: !!(await currentAuthorization(db, id)),
    docs: await db.rows<{ id: string; kind: string; file_name: string; size_bytes: number; source: string; review_status: string; review_note: string | null; created_at: string; uploader: string | null; mime_type: string; report_id: string | null }>(
      `select d.id, d.kind, d.file_name, d.size_bytes, d.source, d.review_status, d.review_note, d.created_at, u.full_name as uploader, d.mime_type, (select r.id from public.credit_reports r where r.document_id = d.id order by r.created_at limit 1) as report_id from public.documents d left join public.users u on u.id = d.uploaded_by where d.client_id = $1 order by d.created_at desc`, [id]),
    reqs: await db.rows<{ id: string; kind: string; note: string | null; due_at: string | null; fulfilled_document_id: string | null }>('select id, kind, note, due_at, fulfilled_document_id from public.document_requests where client_id = $1 order by created_at desc', [id]),
  }));
  const kindOpts = DOC_KINDS.map((k) => ({ value: k, label: DOC_KIND_LABEL[k]! }));
  // A credit report staff uploaded is read (or a new one uploaded) only with the client's written authorization on
  // file; one the client uploaded can always be read. The server refuses the same way (src/lib/credit/authorization.ts).
  const canAddReport = authorized || ctx.session.orgMode === 'personal';
  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
      <div className="space-y-6">
        <IntakeBlock clientId={id} statuses={intake} />
        <Section title="Requested from the client">
          {reqs.length === 0 ? <p className="text-sm text-muted">No requests. Use the form to ask the client for a document — they will see it in their portal.</p> : (
            <ul className="divide-y divide-line/70 text-sm">{reqs.map((r) => (<li key={r.id} className="flex items-center justify-between gap-3 py-2.5"><span>{DOC_KIND_LABEL[r.kind] ?? r.kind}{r.note && <span className="text-muted"> — {r.note}</span>}</span>{r.fulfilled_document_id ? <Badge tone="ok">Received</Badge> : <Badge tone="warn">{r.due_at ? `Due ${fmtDate(r.due_at)}` : 'Waiting'}</Badge>}</li>))}</ul>
          )}
        </Section>
        <Section title={`Vault (${docs.length})`} hint="Files are encrypted at rest. Every download is logged.">
          {docs.length === 0 ? <p className="text-sm text-muted">No documents yet.</p> : (
            <ul className="divide-y divide-line/70">{docs.map((x) => (
              <li key={x.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div className="min-w-0"><a href={`/api/documents/${x.id}`} className="flex items-center gap-2 font-medium hover:underline"><Download size={14} aria-hidden className="shrink-0 text-muted" /><span className="truncate">{x.file_name}</span></a>
                  <div className="text-xs text-muted">{DOC_KIND_LABEL[x.kind] ?? x.kind} · {(x.size_bytes / 1024).toFixed(0)} KB · {x.source === 'client' ? 'uploaded by client' : `by ${x.uploader ?? 'staff'}`} · {relTime(x.created_at)}{x.review_status === 'rejected' && x.review_note ? ` · ${x.review_note}` : ''}</div></div>
                <div className="flex flex-wrap items-center gap-2"><StatusBadge status={x.review_status} />
                  {x.report_id && <Link href={`/app/reports/${x.report_id}`} className="btn-ghost btn-sm">Open report</Link>}
                  {!x.report_id && x.kind === 'credit_report' && x.review_status !== 'rejected' && ['application/pdf', 'text/plain', 'text/html', 'text/csv'].includes(x.mime_type) && x.source !== 'client' && !canAddReport && (
                    <span className="text-xs text-muted">Reading it needs the client’s authorization</span>)}
                  {!x.report_id && x.kind === 'credit_report' && x.review_status !== 'rejected' && ['application/pdf', 'text/plain', 'text/html', 'text/csv'].includes(x.mime_type) && (x.source === 'client' || canAddReport) && (
                    <ActionForm action={importDocumentAsReportAction} className="inline-flex flex-col items-end gap-1.5"><input type="hidden" name="id" value={x.id} /><input type="hidden" name="clientId" value={id} />
                      <select name="bureau" defaultValue="" aria-label="Bureau this report is from" className="field !w-auto !py-1 text-xs"><option value="">Detect bureau from file</option>{(Object.keys(BUREAU_LABEL) as Bureau[]).map((b) => <option key={b} value={b}>{BUREAU_LABEL[b]}</option>)}</select><SubmitButton className="btn-sm" pendingText="Reading…">Read as credit report</SubmitButton></ActionForm>)}
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
            <div><label className="label" htmlFor="docfile">File</label><FileInput id="docfile" accept=".pdf,.png,.jpg,.jpeg,.txt,.csv" maxBytes={maxUploadBytes()} tooLarge={tooLargeMessage(maxUploadMb())} /><p className="hint">PDF, PNG, JPG, TXT or CSV · max {maxUploadMb()} MB. Type is checked from the file’s contents.{!canAddReport && ' A credit report can be added once the client’s written authorization is on file.'}</p></div>
            <SubmitButton pendingText="Encrypting…">Upload</SubmitButton>
          </ActionForm>
        </Section>
        <Section plain title="Request a document">
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
  const rows = await ctx.tx((db) => db.rows<{ id: string; title: string; status: string; current_version: number; created_at: string; source: string | null }>(
    // `source` is how the current version's text came to be; an AI draft is marked until a person approves that text.
    'select l.id, l.title, l.status, l.current_version, l.created_at, (select v.source from public.letter_versions v where v.letter_id = l.id and v.version = l.current_version) as source from public.letters l where l.client_id = $1 order by l.created_at desc', [id]));
  return (
    <div className="space-y-4">
      <div className="flex justify-end"><Link href={`/app/letters/new?clientId=${id}`} className="btn-primary">New letter</Link></div>
      {rows.length === 0 ? <EmptyState title="No letters yet" body="Letters are drafted from a dispute or a template, reviewed, and approved by a manager." icon={<FileText size={20} />} /> : (
        <div className="table-wrap"><table className="table table-stack"><thead><tr><th>Letter</th><th>Status</th><th>Version</th><th>Created</th></tr></thead><tbody>{rows.map((l) => (
          <tr key={l.id} className="row-link"><td className="cell-main"><Link className="font-medium hover:underline" href={`/app/letters/${l.id}`}>{l.title}</Link></td><td><span className="flex flex-wrap items-center gap-1.5"><StatusBadge status={l.status} />{aiUnapproved(l) && <AiTag title="This version was worded by AI and has not been approved by a person yet">AI wording</AiTag>}</span></td><td className="tabular-nums text-muted">v{l.current_version}</td><td className="text-muted">{relTime(l.created_at)}</td></tr>))}</tbody></table></div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ messages
async function MessagesTab({ id, ctx, c, draft }: { id: string; ctx: Ctx; c: C; draft?: string }) {
  const { msgs, stats, credits } = await ctx.tx(async (db) => ({
    msgs: await db.rows<{ id: string; direction: string; channel: string; subject: string | null; body: string; status: string; created_at: string; read_at: string | null; author: string | null }>(
      `select m.id, m.direction, m.channel, m.subject, m.body, m.status, m.created_at, m.read_at, u.full_name as author from public.communications m left join public.users u on u.id = m.author_id where m.client_id = $1 order by m.created_at desc limit 100`, [id]),
    stats: draft === 'progress' ? await loadDisputeCounts(db, id) : null,
    credits: draft === 'progress' ? await getBalance(ctx.orgId, db) : 0,
  }));
  // The draft is built from the dispute data and costs nothing. AI polish is a separate, paid button press — never a
  // side effect of loading this page.
  const prefill = stats ? progressSummary({ firstName: c.full_name.split(' ')[0] ?? '', language: c.preferred_language, ...stats }) : '';
  const offer = polishOffer(providerStatus().active, credits);
  const unread = msgs.some((m) => m.direction === 'inbound' && !m.read_at);
  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_24rem]">
      <div className="space-y-3">
        {unread && <form action={markInboundReadAction}><input type="hidden" name="clientId" value={id} /><button className="btn-secondary btn-sm" type="submit">Mark all as read</button></form>}
        {msgs.length === 0 ? <EmptyState title="No messages yet" body="Messages sent here appear in the client’s portal. Logged calls and texts show up too." /> : msgs.map((m) => (
          <div key={m.id} className={cn('max-w-[85%] rounded-2xl p-4', m.direction === 'inbound' ? 'rounded-bl-md bg-surface shadow-card' : m.direction === 'internal' ? 'border border-dashed border-line-strong/70' : 'ml-auto rounded-br-md bg-brand-soft')}>
            <div className="mb-1 flex flex-wrap items-center gap-2 text-xs text-muted"><strong className="text-ink">{m.direction === 'inbound' ? c.full_name : m.author ?? 'Automation'}</strong><span>{m.channel}{m.direction === 'internal' ? ' (logged)' : ''}</span><span>{relTime(m.created_at)}</span>{m.status === 'queued' && <Badge tone="warn">Not delivered</Badge>}{m.status === 'failed' && <Badge tone="bad">Failed</Badge>}</div>
            {m.subject && <div className="text-sm font-medium">{m.subject}</div>}<p className="whitespace-pre-wrap text-sm [overflow-wrap:anywhere]">{m.body}</p>
          </div>))}
        {msgs.length === 100 && <p className="text-center text-xs text-muted">Showing the 100 most recent messages. Older ones are kept but not listed here.</p>}
      </div>
      <div data-polish-scope><Section title="Send or log">
        {prefill && (
          <div className="mb-3 space-y-2"><Notice tone="info">Drafted from the dispute data. Read it before you send it.</Notice>
            {offer.button && <PolishNote clientId={id} action={polishProgressAction} label={`Polish wording with AI (${AI_COSTS.progress_note} credits)`} />}
            <p className="text-xs text-muted">{offer.note}</p>
          </div>)}
        <ActionForm action={sendMessageAction} resetOnSuccess className="space-y-3">
          <input type="hidden" name="clientId" value={id} />
          <Select label="Channel" name="channel" defaultValue="portal" options={[{ value: 'portal', label: 'Client portal message' }, { value: 'email', label: !emailIsLive() ? 'Email (not connected: nothing will be sent)' : c.email ? `Email to ${c.email}` : 'Email (no address on file)' }, { value: 'note_call', label: 'Log a phone call (nothing is sent)' }, { value: 'note_sms', label: 'Log a text message (nothing is sent)' }]} />
          <Field label="Subject (email only)" name="subject" />
          <TextArea label="Message" name="body" rows={7} required defaultValue={prefill} />
          <SubmitButton pendingText="Sending…">Send</SubmitButton>
          <p className="text-xs text-muted">You are the sender — messages typed here go out immediately. Do not promise results or timelines. Automated messages wait for approval in the Inbox.</p>
        </ActionForm>
      </Section></div>
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
        <ul className="panel divide-y divide-line/70">{tasks.map((t) => (
          <li key={t.id} className="flex items-start gap-3 p-4">
            <form action={setTaskStatusAction}><input type="hidden" name="id" value={t.id} /><input type="hidden" name="status" value={t.status === 'done' ? 'open' : 'done'} />
              <button aria-label={t.status === 'done' ? 'Reopen task' : 'Complete task'} className="group -m-1.5 grid h-8 w-8 place-items-center rounded-full"><span className={cn('grid h-5 w-5 place-items-center rounded-full border', t.status === 'done' ? 'border-ok bg-ok text-surface' : 'border-line-strong group-hover:border-brand')}>{t.status === 'done' && <CheckIcon size={12} aria-hidden />}</span></button></form>
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
        <article key={n.id} className="panel p-4">
          {n.pinned && <div className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-brand-strong"><Pin size={12} aria-hidden /> Pinned</div>}
          <p className="whitespace-pre-wrap text-sm [overflow-wrap:anywhere]">{n.body}</p>
          <div className="mt-2 flex items-center justify-between text-xs text-muted"><span>{n.author ?? 'Unknown'} · {relTime(n.created_at)}</span>
            <form action={togglePinAction}><input type="hidden" name="id" value={n.id} /><input type="hidden" name="clientId" value={id} /><button className="flex items-center gap-1 rounded-md hover:text-ink" type="submit"><Pin size={12} aria-hidden /> {n.pinned ? 'Unpin' : 'Pin'}</button></form></div>
        </article>))}</div>
      <Section title="Add an internal note"><ActionForm action={addNoteAction} resetOnSuccess className="space-y-3"><input type="hidden" name="clientId" value={id} /><TextArea label="Note" name="body" rows={5} required /><Check name="pinned">Pin to the top</Check><SubmitButton>Save note</SubmitButton></ActionForm></Section>
    </div>
  );
}

async function TimelineTab({ id, ctx }: { id: string; ctx: Ctx }) {
  const events = await ctx.tx((db) => db.rows<{ id: string; kind: string; summary: string; created_at: string; actor: string | null }>(`select e.id, e.kind, e.summary, e.created_at, u.full_name as actor from public.client_events e left join public.users u on u.id = e.actor_id where e.client_id = $1 order by e.created_at desc limit 200`, [id]));
  return events.length === 0 ? <EmptyState title="No activity yet" /> : (
    <>
    <ol className="panel divide-y divide-line/70">{events.map((e) => (<li key={e.id} className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1 px-5 py-3.5 text-sm"><div className="min-w-0"><div>{e.summary}</div><div className="text-xs text-muted">{e.actor ?? 'System'} · {e.kind.replace(/_/g, ' ')}</div></div><time className="shrink-0 text-xs text-muted" dateTime={e.created_at} title={e.created_at}>{fmtDate(e.created_at)} · {relTime(e.created_at)}</time></li>))}</ol>
    {events.length === 200 && <p className="mt-3 text-center text-xs text-muted">Showing the 200 most recent events. Older activity is kept in the record but not listed here.</p>}
    </>
  );
}

// ------------------------------------------------------------------ billing
async function BillingTab({ id, ctx, period }: { id: string; ctx: Ctx; period?: string }) {
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
            {ctx.can('billing:write') && <form action={cancelSubscriptionAction}><input type="hidden" name="id" value={active.id} /><input type="hidden" name="clientId" value={id} /><ConfirmButton message={`Cancel the ${active.plan_name} plan for this client?`}>Cancel plan</ConfirmButton></form>}</div>) : <p className="text-sm text-muted">No active plan.</p>}
        </Section>
        <Section title="Payments" hint={`${money(paid)} received in total. Payments are recorded by your team — ${PRODUCT.name} does not charge cards.`}>
          {payments.length === 0 ? <p className="text-sm text-muted">No payments recorded.</p> : (
            <ul className="divide-y divide-line/70 text-sm">{payments.map((p) => (<li key={p.id} className="flex flex-wrap items-center justify-between gap-3 py-2.5"><div><div className="font-medium tabular-nums">{money(p.amount_cents)} <span className="font-normal text-muted">· {p.method}</span></div><div className="text-xs text-muted">{fmtDate(p.paid_at)}{p.note ? ` · ${p.note}` : ''}</div></div>
              <div className="flex items-center gap-2"><StatusBadge status={p.status} />{p.status === 'succeeded' && ctx.can('billing:write') && <form action={refundPaymentAction}><input type="hidden" name="id" value={p.id} /><input type="hidden" name="clientId" value={id} /><ConfirmButton className="text-xs text-muted underline hover:text-ink" message={`Mark this ${money(p.amount_cents)} payment as refunded? This cannot be undone here.`}>Mark refunded</ConfirmButton></form>}</div></li>))}</ul>)}
        </Section>
      </div>
      {ctx.can('billing:write') && (
        <div className="space-y-6">
          <ChargeBlock id={id} ctx={ctx} period={period} subscription={active} />
          {plans.length > 0 && (<Section plain title="Assign a plan"><ActionForm action={subscribeClientAction} className="space-y-3"><input type="hidden" name="clientId" value={id} />
            <Select label="Plan" name="planId" required options={plans.map((p) => ({ value: p.id, label: `${p.name} — ${money(p.price_cents)}${p.interval === 'month' ? '/mo' : ''}` }))} /><SubmitButton variant="secondary">Assign</SubmitButton></ActionForm></Section>)}
        </div>
      )}
    </div>
  );
}

