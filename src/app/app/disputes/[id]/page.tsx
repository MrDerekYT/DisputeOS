import Link from 'next/link';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { CalendarClock, Check as CheckIcon, FileText, Lightbulb } from 'lucide-react';
import { ActionForm, Check, ConfirmButton, Field, Select, SubmitButton, TextArea } from '@/components/forms';
import { Badge, DayMeter, DeliveryRecord, EmptyState, Notice, PageHeader, Section, StatusBadge } from '@/components/ui';
import { requireStaff } from '@/lib/auth/context';
import { consentStatus } from '@/lib/compliance/disclosures';
import { CATEGORIES, deadlineState, nextSteps, OUTCOME_LABEL, OUTCOMES, PIPELINE, STATUS_LABEL, type DisputeStatus, type Outcome } from '@/lib/disputes/workflow';
import { staffMembers, memberLabel, DOC_KIND_LABEL } from '@/lib/crm';
import { businessToday } from '@/lib/letters/service';
import { getEnv } from '@/lib/env';
import { BUREAU_LABEL, cn, fmtDate, isUuid, relTime, type Bureau } from '@/lib/util';
import { addEvidenceAction, addFollowUpTaskAction, analyzeReplyAction, assignDisputeAction, nextRoundAction, recordResponseAction, transitionAction } from '../actions';
import { PRODUCT } from '@/lib/product';
import { dayWindow, windowStart, windowText } from '@/lib/day-meter';
import { loadRecheck } from '@/lib/disputes/recheck-load';
import { intakeStateLabel, intakeSummary } from '@/lib/intake';
import { loadIntake } from '@/lib/intake-load';
import { agencyIdentityLines, agencyItemLines, parseAgencyItem, specialtyAgency } from '@/lib/credit/agencies';
import { MailRequirements } from '@/components/mail-requirements';
import { recommendLetter } from '@/lib/letters/brief';
import { loadBrief } from '@/lib/letters/brief-load';
import { ClockBlock } from './clock-block';
import { RecommendLetter } from './recommend-letter';

export const metadata: Metadata = { title: 'Dispute' };

interface D {
  id: string; client_id: string; client_name: string; item_label: string; status: DisputeStatus; round: number; category: string; reason: string; fields: string[];
  bureau: Bureau | null; recipient_name: string; target_type: string; tradeline_id: string | null; workflow: string; submitted_at: string | null; due_at: string | null; deadline_extended: boolean;
  response_at: string | null; outcome: Outcome | null; outcome_notes: string | null; assigned_to: string | null; approved_by_name: string | null; approved_at: string | null;
  parent_dispute_id: string | null; created_at: string; agency: string | null; agency_item: unknown; recipient_address: string | null;
  more_info_on: string | null; investigation_completed_on: string | null; frivolous_missing: string | null; client_confirmed_accurate: boolean; client_language: string;
}

function Transition({ id, to, label, variant = 'primary', confirm, children }: { id: string; to: DisputeStatus; label: string; variant?: 'primary' | 'secondary' | 'danger'; confirm?: string; children?: React.ReactNode }) {
  return (
    <ActionForm action={transitionAction} className="mr-3 inline-flex flex-wrap items-end gap-2">
      <input type="hidden" name="id" value={id} /><input type="hidden" name="to" value={to} />
      {children}
      {confirm ? <ConfirmButton className={`btn-${variant}`} message={confirm}>{label}</ConfirmButton> : <SubmitButton variant={variant}>{label}</SubmitButton>}
    </ActionForm>
  );
}

export default async function DisputePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const ctx = await requireStaff('clients:read');
  const data = await ctx.tx(async (db) => {
    const d = await db.row<D>(
      `select d.*, c.full_name as client_name, c.preferred_language as client_language, ab.full_name as approved_by_name from public.disputes d join public.clients c on c.id = d.client_id left join public.users ab on ab.id = d.approved_by where d.id = $1`, [id]);
    if (!d) return null;
    const [events, evidence, letters, docs, consents, tasks, children, team] = await Promise.all([
      db.rows<{ id: string; kind: string; from_status: string | null; to_status: string | null; note: string | null; created_at: string; actor: string | null }>(
        `select e.id, e.kind, e.from_status, e.to_status, e.note, e.created_at, u.full_name as actor from public.dispute_events e left join public.users u on u.id = e.actor_id where e.dispute_id = $1 order by e.created_at desc, e.id`, [id]),
      db.rows<{ id: string; label: string; note: string | null; file_name: string | null; document_id: string | null; created_at: string }>(
        `select ev.id, ev.label, ev.note, ev.document_id, ev.created_at, doc.file_name from public.dispute_evidence ev left join public.documents doc on doc.id = ev.document_id where ev.dispute_id = $1 order by ev.created_at`, [id]),
      db.rows<{ id: string; title: string; status: string; current_version: number; created_at: string; sent_at: string | null; sent_on: string | null; sent_method: string | null; tracking_number: string | null; delivery_source: string; carrier_delivered_at: string | null; recorder: string | null; kind: string; received_on: string | null; reply_due_on: string | null; reply_received_on: string | null }>('select l.id, l.title, l.status, l.current_version, l.created_at, l.sent_at, l.sent_on, l.sent_method, l.tracking_number, l.delivery_source, l.carrier_delivered_at, sr.full_name as recorder, l.kind, l.received_on, l.reply_due_on, l.reply_received_on from public.letters l left join public.users sr on sr.id = l.sent_recorded_by where l.dispute_id = $1 order by l.created_at desc', [id]),
      db.rows<{ id: string; file_name: string; kind: string }>('select id, file_name, kind from public.documents where client_id = $1 order by created_at desc limit 50', [d.client_id]),
      db.rows<{ kind: string; signed_at: string; revoked_at: string | null }>('select kind, signed_at, revoked_at from public.client_consents where client_id = $1', [d.client_id]),
      db.rows<{ id: string; title: string; status: string; due_at: string | null }>("select id, title, status, due_at from public.tasks where dispute_id = $1 order by status, due_at", [id]),
      db.rows<{ id: string; round: number; status: string }>('select id, round, status from public.disputes where parent_dispute_id = $1', [id]),
      staffMembers(db),
    ]);
    const check = ['submitted', 'under_investigation', 'response_received'].includes(d.status) ? await loadRecheck(db, id) : null;
    // Only looked at when a bureau or specialty agency dispute is about to be recorded as sent.
    const idDocs = d.status === 'approved' && (d.target_type === 'bureau' || d.target_type === 'agency') ? intakeSummary(await loadIntake(db, d.client_id)).notAccepted : [];
    // The letter that fits this dispute, from what is on file (no AI). Only before it is sent: afterwards the legal clock block says what can follow.
    const brief = !d.submitted_at && !d.client_confirmed_accurate && !['resolved', 'cancelled'].includes(d.status) && ctx.can('letters:write') ? await loadBrief(db, d.client_id, id) : null;
    return { d, events, evidence, letters, docs, consents, tasks, children, team, check, idDocs, rec: brief ? recommendLetter(brief) : null };
  });
  if (!data) notFound();
  const { d, events, evidence, letters, docs, consents, tasks, children, team, check, idDocs, rec } = data;
  const agency = specialtyAgency(d.agency);
  const item = parseAgencyItem(d.agency_item);
  const cs = consentStatus(consents);
  const today = businessToday(); // the agency's calendar day (APP_TIMEZONE), not the UTC date
  const hasApproved = letters.some((l) => (l.status === 'approved' || l.status === 'sent') && l.kind !== 'method_of_verification');
  const steps = nextSteps({ status: d.status, round: d.round, due_at: d.due_at, outcome: d.outcome, hasApprovedLetter: hasApproved, evidenceCount: evidence.length, confirmedAccurate: d.client_confirmed_accurate });
  const canApprove = ctx.can('disputes:approve');
  const state = deadlineState(d.due_at);
  const idx = PIPELINE.indexOf(d.status);
  const open = !['resolved', 'cancelled'].includes(d.status);
  const now = new Date();
  // The window is running only while the dispute is submitted or under investigation (the same test the overdue counts use).
  const windowOpen = (d.status === 'submitted' || d.status === 'under_investigation') && !!d.due_at;
  // The window is counted from receipt: the stored deadline minus its 30 (or 45) days — not from the mailing date.
  const opened = windowStart(d.due_at, d.deadline_extended);
  const wt = windowText(dayWindow(opened, d.due_at, now));
  const sameDay = !!opened && !!d.submitted_at && fmtDate(opened) === fmtDate(d.submitted_at);

  return (
    <>
      <PageHeader
        title={d.item_label}
        subtitle={<>Round {d.round} · {CATEGORIES[d.category]?.label ?? d.category} · for <Link className="link" href={`/app/clients/${d.client_id}`}>{d.client_name}</Link> · sent to {d.bureau ? BUREAU_LABEL[d.bureau] : d.recipient_name}</>}
        back={{ href: '/app/disputes', label: 'Disputes' }}
        actions={<StatusBadge status={d.status} />}
      />

      {/* Pipeline stepper */}
      <nav aria-label="Pipeline" className="mb-8">
        <ol className="hidden items-center sm:flex">
          {PIPELINE.map((s, i) => {
            const done = idx > i, current = d.status === s;
            return (
              <li key={s} aria-current={current ? 'step' : undefined} className={cn('flex flex-1 items-center', i === PIPELINE.length - 1 && 'flex-none')}>
                <span className="flex flex-col items-center gap-1.5 text-center">
                  <span className={cn('grid h-8 w-8 place-items-center rounded-full text-xs font-semibold', done ? 'bg-raised text-ink' : current ? 'bg-ink text-canvas' : 'border border-line-strong/70 text-muted')}>{done ? <><CheckIcon size={15} aria-hidden /><span className="sr-only">Done: </span></> : i + 1}</span>
                  <span className={cn('w-20 text-xs leading-tight', current ? 'font-semibold text-ink' : 'text-muted')}>{STATUS_LABEL[s]}</span>
                </span>
                {i < PIPELINE.length - 1 && <span aria-hidden className={cn('mx-1 mb-5 h-0.5 flex-1', done ? 'bg-line-strong' : 'bg-line')} />}
              </li>
            );
          })}
        </ol>
        {/* Phones: the step in words and a segmented bar — seven dots do not fit, and a sideways scroll hides the rest. */}
        {idx >= 0 && (
          <div className="sm:hidden">
            <p className="text-sm text-muted">Step {idx + 1} of {PIPELINE.length}: <strong className="font-semibold text-ink">{STATUS_LABEL[d.status]}</strong></p>
            <div className="mt-2 flex gap-1" aria-hidden>{PIPELINE.map((s, i) => <span key={s} className={cn('h-1.5 flex-1 rounded-full', i < idx ? 'bg-line-strong' : i === idx ? 'bg-ink' : 'bg-line')} />)}</div>
            {idx < PIPELINE.length - 1 && <p className="mt-2 text-[0.8125rem] text-muted">Next: {STATUS_LABEL[PIPELINE[idx + 1]!]}</p>}
          </div>
        )}
        {(d.status === 'on_hold' || d.status === 'cancelled') && <p className="mt-3 text-sm text-muted">This dispute is <strong>{STATUS_LABEL[d.status].toLowerCase()}</strong>.</p>}
      </nav>

      {windowOpen && (
        <section aria-labelledby="window" className={cn('panel mb-6 p-5 sm:p-6', state === 'overdue' && 'ring-1 ring-inset ring-bad/50')}>
          <div className="mb-4 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <h2 id="window" className="display text-xl">Investigation window</h2>
            <p className={cn('display text-xl', state === 'overdue' && 'text-bad')}>{wt.status}</p>
          </div>
          <DayMeter dueAt={d.due_at} extended={d.deadline_extended} now={now} variant="ticks" showText={false} />
          <div className="mt-3 flex flex-wrap justify-between gap-x-6 gap-y-1 text-[0.8125rem] text-muted">
            <span>{!d.submitted_at ? `Window opened ${fmtDate(opened)}` : sameDay ? `Submitted ${fmtDate(d.submitted_at)}` : `Sent ${fmtDate(d.submitted_at)} · window opened ${fmtDate(opened)}`}</span>
            {wt.count && <span className="font-semibold text-ink">{wt.count}</span>}
            <span>Response due {fmtDate(d.due_at)}</span>
          </div>
        </section>
      )}

      <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
        <div className="space-y-6">
          {check && check.kind !== 'no_newer_report' && (
            <Section title="What the newer report shows" hint={`Compared with the ${d.bureau ? BUREAU_LABEL[d.bureau as Bureau] : 'bureau'} report${check.reportDate ? ` dated ${fmtDate(check.reportDate)}` : ''} imported after this dispute’s report.`}>
              {check.kind === 'not_on_newer_report' && <Notice tone="info" title="This account does not appear on the newer report">That can mean it was removed, or that it is reported under a different name or number. Check the report and any letter received before recording the outcome.</Notice>}
              {check.kind === 'unchanged' && <Notice tone="info" title="No change on the newer report">The balance, statuses and delinquency date are reported the same as before.</Notice>}
              {check.kind === 'changed' && (
                <>
                  <div className="table-wrap !shadow-none"><table className="table"><thead><tr><th>Reported value</th><th>Before</th><th>Now</th></tr></thead>
                    <tbody>{check.changes.map((c) => <tr key={c.field}><td>{c.field}</td><td>{c.before}</td><td className="font-semibold">{c.after}</td></tr>)}</tbody></table></div>
                </>
              )}
              <p className="mt-3 text-[0.8125rem] text-muted">This is a comparison only. Nothing is recorded until a person enters the response below.</p>
            </Section>
          )}
          {letters.filter((l) => l.status === 'sent' && l.kind !== 'method_of_verification').slice(0, 1).map((l) => (
            <Section key={l.id} title="Delivery record" hint="How and when the approved letter was sent.">
              <DeliveryRecord sentOn={l.sent_on ?? l.sent_at} method={l.sent_method} tracking={l.tracking_number} source={l.delivery_source} recordedBy={l.recorder} carrierDeliveredAt={l.carrier_delivered_at} />
            </Section>
          ))}
          {/* What to do now */}
          <Section title="What happens next" hint="The system suggests; people decide.">
            <ul className="space-y-2">{steps.map((s) => <li key={s} className="flex gap-2 text-sm"><Lightbulb size={16} className="mt-0.5 shrink-0 text-muted" aria-hidden />{s}</li>)}</ul>

            <div className="mt-5 space-y-4 border-t border-line pt-5">
              {d.status === 'draft' && <Transition id={d.id} to="ready_for_review" label="Send for review" />}
              {d.status === 'ready_for_review' && (
                <div className="flex flex-wrap gap-3">
                  {canApprove ? <Transition id={d.id} to="approved" label="Approve dispute" /> : <Notice tone="info">A manager or admin approves disputes.</Notice>}
                  <Transition id={d.id} to="draft" label="Return to draft" variant="secondary" />
                </div>
              )}
              {d.status === 'approved' && (
                <ActionForm action={transitionAction} className="space-y-4">
                  <input type="hidden" name="id" value={d.id} /><input type="hidden" name="to" value="submitted" />
                  {cs.missing.length > 0 && <Notice tone="bad" title="Cannot submit yet">Required consents missing: {cs.missing.join(', ').replace(/_/g, ' ')}. <Link className="link" href={`/app/clients/${d.client_id}?tab=overview`}>Record them on the client profile.</Link></Notice>}
                  {cs.inCancellationWindow && <Notice tone="warn" title="Within the 3-business-day cancellation window">The client signed their agreement recently and may still cancel without penalty. Confirm before mailing.</Notice>}
                  {!hasApproved && <Notice tone="bad" title="No approved letter">Approve a letter for this dispute first.</Notice>}
                  {/* The delivery form only appears once it can succeed: an approved letter and the required consents. */}
                  {hasApproved && cs.missing.length === 0 && (<>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Select label="How was it sent?" name="sentMethod" defaultValue="certified_mail" options={[{ value: 'certified_mail', label: 'Certified mail' }, { value: 'first_class_mail', label: 'First-class mail' }, { value: 'portal', label: 'Online portal' }, { value: 'manual', label: 'Other' }]} />
                    <Field label="Date sent" name="sentOn" type="date" defaultValue={today} max={today} required />
                    <Field label="Tracking reference" name="tracking" hint="Optional. For example the certified-mail number." maxLength={80} />
                    <Field label="Date the recipient received it (if known)" name="receivedOn" type="date" hint="The 30-day clock starts at receipt. Leave blank to count from today." />
                    <div className="self-end pb-2"><Check name="extended">45-day window (for example, this dispute follows a free annual report)</Check></div>
                  </div>
                  {idDocs.length > 0 && (
                    <div className="space-y-3">
                      <Notice tone="warn" title="Identity documents are not on file">
                        {idDocs.map((x) => `${x.item.label.en} (${intakeStateLabel(x).toLowerCase()})`).join(', ')}. A dispute can be sent without them, but the {agency ? 'agency' : 'bureau'} may ask for them before it investigates.{' '}
                        <Link className="link" href={`/app/clients/${d.client_id}?tab=documents#intake`}>Open intake documents</Link>
                      </Notice>
                      <Check name="sendAnyway" required>Send without the identity documents</Check>
                    </div>
                  )}
                  <p className="text-[0.8125rem] text-muted">Recording a submission means a person has already mailed the approved letter. {PRODUCT.name} never sends correspondence on its own.</p>
                  <SubmitButton>Record submission</SubmitButton>
                  </>)}
                </ActionForm>
              )}
              {(d.status === 'submitted') && <Transition id={d.id} to="under_investigation" label="Mark as under investigation" variant="secondary" />}
              {['submitted', 'under_investigation', 'response_received'].includes(d.status) && (
                <div className="grid gap-5 lg:grid-cols-2">
                  <div>
                    <h3 className="mb-2 text-sm font-semibold">1 · Read the reply <span className="font-normal text-muted">(optional)</span></h3>
                    <ActionForm action={analyzeReplyAction} className="space-y-2">
                      <TextArea label="Paste the response text" name="reply" rows={5} />
                      <SubmitButton variant="secondary">Suggest an outcome</SubmitButton>
                    </ActionForm>
                  </div>
                  <div>
                    <h3 className="mb-2 text-sm font-semibold">2 · Record the outcome</h3>
                    <ActionForm action={recordResponseAction} className="space-y-3">
                      <input type="hidden" name="id" value={d.id} />
                      <Select label="Outcome" name="outcome" required defaultValue={d.outcome ?? ''} placeholder="Choose…" options={OUTCOMES.filter((o) => o !== 'frivolous').map((o) => ({ value: o, label: OUTCOME_LABEL[o] }))} />
                      <Field label="Date response received" name="receivedOn" type="date" />
                      <Field label="Date the agency completed its reinvestigation" name="completedOn" type="date" defaultValue={d.investigation_completed_on ?? ''} hint="Optional. Only if the response states it." />
                      <TextArea label="Notes" name="notes" rows={2} defaultValue={d.outcome_notes} />
                      <SubmitButton>Record response</SubmitButton>
                    </ActionForm>
                  </div>
                </div>
              )}
              {d.status === 'response_received' && <Transition id={d.id} to="resolved" label="Mark resolved" />}
              {d.status === 'on_hold' && <Transition id={d.id} to={d.submitted_at ? 'under_investigation' : 'draft'} label="Resume" />}
              {d.status === 'resolved' && ['verified', 'unresolved', 'no_response', 'frivolous'].includes(d.outcome ?? '') && !children.length && !d.client_confirmed_accurate && (
                <details className="rounded-xl border border-line-strong/60 p-4">
                  <summary className="cursor-pointer text-sm font-semibold">Start round {d.round + 1}</summary>
                  <ActionForm action={nextRoundAction} className="mt-4 space-y-3">
                    <input type="hidden" name="id" value={d.id} />
                    <Notice tone="warn">Another round needs <strong>new</strong> information or evidence. Repeating the same dispute can be treated as frivolous.</Notice>
                    <TextArea label="Reason for this round" name="reason" rows={4} required defaultValue="" />
                    <TextArea label="What is new since last time?" name="newInformation" rows={2} required placeholder="e.g. Statement dated 3/1/2026 showing the balance…" />
                    <SubmitButton>Create round {d.round + 1} draft</SubmitButton>
                  </ActionForm>
                </details>
              )}
              {open && d.status !== 'on_hold' && ['submitted', 'under_investigation', 'response_received'].includes(d.status) && <Transition id={d.id} to="on_hold" label="Put on hold" variant="secondary" />}
              {open && <Transition id={d.id} to="cancelled" label="Cancel dispute" variant="danger" confirm="Cancel this dispute? It stays in the record but will not proceed." />}
            </div>
          </Section>

          <ClockBlock d={d} letters={letters} lang={d.client_language === 'es' ? 'es' : 'en'} today={today} tz={getEnv().APP_TIMEZONE} canLetter={ctx.can('letters:write')} />

          {agency && (
            <Section plain title={`Item on the ${agency.shortName} disclosure`} hint="Typed in by a person. These reports are not read by the system.">
              {item && <p className="whitespace-pre-line text-sm leading-relaxed">{[...agencyItemLines(item, 'en').map((l) => l.trim()), ...(item.consumerId ? agencyIdentityLines(agency, item, 'en').slice(0, 1) : [])].join('\n')}</p>}
              <div className="mt-4 text-sm">
                <p className="text-muted">Mail to</p>
                {agency.disputeAddress ? (
                  <>
                    <p className="mt-1 whitespace-pre-line font-medium">{[agency.name, ...agency.disputeAddress.lines].join('\n')}</p>
                    <p className="mt-1 text-[0.8125rem] text-muted">Read on <a className="link" href={agency.disputeAddress.sourceUrl} target="_blank" rel="noreferrer">{new URL(agency.disputeAddress.sourceUrl).hostname}</a> on {fmtDate(agency.disputeAddress.verifiedOn)}.</p>
                  </>
                ) : (
                  <>
                    <p className="mt-1 whitespace-pre-line font-medium">{[agency.name, d.recipient_address].filter(Boolean).join('\n')}</p>
                    <p className="mt-1 text-[0.8125rem] text-muted">Address entered by your team. No verified address is on file for this agency.</p>
                  </>
                )}
                <MailRequirements agency={agency} className="mt-3" />
              </div>
            </Section>
          )}

          <Section plain title="Reason">
            <p className="whitespace-pre-wrap text-sm leading-relaxed">{d.reason}</p>
            {d.fields.length > 0 && <div className="mt-3 flex flex-wrap gap-1.5">{d.fields.map((f) => <Badge key={f}>{f}</Badge>)}</div>}
          </Section>

          <Section title={`Evidence (${evidence.length})`}>
            {evidence.length === 0 ? <p className="mb-4 text-sm text-muted">No evidence attached yet. Statements, letters and records strengthen a dispute — and are what an investigator reviews.</p> : (
              <ul className="mb-4 divide-y divide-line/70 text-sm">{evidence.map((e) => (
                <li key={e.id} className="flex items-start justify-between gap-3 py-2.5">
                  <div className="min-w-0"><div className="font-medium">{e.label}</div>{e.note && <div className="text-muted">{e.note}</div>}{e.file_name && <a className="link text-[0.8125rem]" href={`/api/documents/${e.document_id}`}>{e.file_name}</a>}</div>
                  <span className="shrink-0 text-xs text-muted">{fmtDate(e.created_at)}</span>
                </li>))}</ul>
            )}
            {open && (
              <ActionForm action={addEvidenceAction} resetOnSuccess className="grid gap-3 sm:grid-cols-2">
                <input type="hidden" name="id" value={d.id} />
                <Field label="Label" name="label" required placeholder="March statement showing balance" />
                <Select label="Attach a document from the vault (optional)" name="documentId" placeholder="None" options={docs.map((x) => ({ value: x.id, label: `${x.file_name} · ${DOC_KIND_LABEL[x.kind] ?? x.kind}` }))} />
                <TextArea label="Note" name="note" rows={2} className="sm:col-span-2" />
                <div className="sm:col-span-2"><SubmitButton variant="secondary">Add evidence</SubmitButton></div>
              </ActionForm>
            )}
          </Section>

          <Section plain title="History" hint="Every change is recorded automatically and cannot be edited.">
            <ol className="space-y-3">
              {events.map((e) => (
                <li key={e.id} className="flex gap-3 text-sm">
                  <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-line-strong" aria-hidden />
                  <div className="min-w-0">
                    <div>{e.kind === 'status_changed' ? <>Status: <strong>{STATUS_LABEL[e.from_status as DisputeStatus]}</strong> → <strong>{STATUS_LABEL[e.to_status as DisputeStatus]}</strong></> : e.note ?? e.kind.replace(/_/g, ' ')}</div>
                    <div className="text-xs text-muted">{e.actor ?? 'System'} · {relTime(e.created_at)} · {fmtDate(e.created_at)}</div>
                  </div>
                </li>
              ))}
            </ol>
          </Section>
        </div>

        <aside className="space-y-6">
          <Section plain title="Timeline">
            <dl className="space-y-3 text-sm [&>div]:gap-3">
              <div className="flex justify-between"><dt className="text-muted">Created</dt><dd>{fmtDate(d.created_at)}</dd></div>
              <div className="flex justify-between"><dt className="text-muted">Approved</dt><dd>{d.approved_at ? `${fmtDate(d.approved_at)} · ${d.approved_by_name ?? ''}` : '—'}</dd></div>
              <div className="flex justify-between"><dt className="text-muted">Submitted</dt><dd>{fmtDate(d.submitted_at)}</dd></div>
              <div className="flex justify-between"><dt className="text-muted">Response due</dt><dd className="flex flex-wrap items-center justify-end gap-2">{fmtDate(d.due_at)}{d.due_at && open && !windowOpen && <Badge tone={state === 'overdue' ? 'bad' : state === 'soon' ? 'warn' : 'neutral'}><CalendarClock size={12} aria-hidden /> {wt.status}</Badge>}</dd></div>
              <div className="flex justify-between"><dt className="text-muted">Response</dt><dd>{fmtDate(d.response_at)}</dd></div>
              <div className="flex justify-between"><dt className="text-muted">Outcome</dt><dd>{d.outcome ? <StatusBadge status={d.outcome} text={OUTCOME_LABEL[d.outcome]} /> : '—'}</dd></div>
            </dl>
            {d.due_at && <p className="mt-3 text-[0.8125rem] text-muted">{d.deadline_extended ? '45' : '30'}-day investigation window counted from receipt.</p>}
          </Section>

          <Section plain title="Letters" actions={open && !d.client_confirmed_accurate ? <Link href={`/app/letters/new?clientId=${d.client_id}&disputeId=${d.id}`} className="btn-secondary btn-sm">New</Link> : undefined}>
            {rec && <RecommendLetter disputeId={d.id} clientId={d.client_id} rec={rec} canDraft={ctx.can('letters:write')} />}
            {letters.length === 0 ? <p className="text-sm text-muted">No letter yet.</p> : (
              <ul className="space-y-2">{letters.map((l) => (
                <li key={l.id}><Link href={`/app/letters/${l.id}`} className="flex items-center justify-between gap-2 rounded-xl bg-raised p-3 text-sm transition-colors hover:bg-line">
                  <span className="flex min-w-0 items-center gap-2"><FileText size={16} className="shrink-0 text-muted" aria-hidden /><span className="truncate">{l.title}</span></span><StatusBadge status={l.status} />
                </Link></li>))}</ul>
            )}
          </Section>

          <Section title="Assignment & follow-ups">
            <form action={assignDisputeAction} className="mb-4 flex items-end gap-2">
              <input type="hidden" name="id" value={d.id} />
              <Select label="Specialist" name="assignee" defaultValue={d.assigned_to ?? ''} placeholder="Unassigned" options={team.map((m) => ({ value: m.id, label: memberLabel(m) }))} className="flex-1" />
              <button className="btn-secondary" type="submit">Set</button>
            </form>
            {tasks.length > 0 && <ul className="mb-3 space-y-1.5 text-sm">{tasks.map((t) => <li key={t.id} className="flex justify-between gap-2"><span className={t.status === 'done' ? 'text-muted line-through' : ''}>{t.title}</span><span className="text-xs text-muted">{t.due_at ? fmtDate(t.due_at) : ''}</span></li>)}</ul>}
            <ActionForm action={addFollowUpTaskAction} resetOnSuccess className="space-y-2">
              <input type="hidden" name="id" value={d.id} />
              <Field label="New follow-up task" name="title" required placeholder="Call bureau for status" />
              <Field label="Due" name="due" type="date" />
              <SubmitButton variant="secondary">Add task</SubmitButton>
            </ActionForm>
          </Section>

          {(d.parent_dispute_id || children.length > 0) && (
            <Section plain title="Rounds">
              <ul className="space-y-1.5 text-sm">
                {d.parent_dispute_id && <li><Link className="link" href={`/app/disputes/${d.parent_dispute_id}`}>← Previous round</Link></li>}
                {children.map((c) => <li key={c.id}><Link className="link" href={`/app/disputes/${c.id}`}>Round {c.round} →</Link> <StatusBadge status={c.status} /></li>)}
              </ul>
            </Section>
          )}
          {!open && d.status === 'cancelled' && <EmptyState title="Cancelled" body="This dispute was cancelled and will not proceed." />}
        </aside>
      </div>
    </>
  );
}
