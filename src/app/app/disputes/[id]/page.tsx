import Link from 'next/link';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { CalendarClock, Check as CheckIcon, FileText, Lightbulb } from 'lucide-react';
import { ActionForm, Check, ConfirmButton, Field, Select, SubmitButton, TextArea } from '@/components/forms';
import { Badge, EmptyState, Notice, PageHeader, Section, StatusBadge } from '@/components/ui';
import { requireStaff } from '@/lib/auth/context';
import { consentStatus } from '@/lib/compliance/disclosures';
import { CATEGORIES, daysRemaining, deadlineState, nextSteps, OUTCOME_LABEL, OUTCOMES, PIPELINE, STATUS_LABEL, type DisputeStatus, type Outcome } from '@/lib/disputes/workflow';
import { staffMembers, memberLabel, DOC_KIND_LABEL } from '@/lib/crm';
import { BUREAU_LABEL, cn, fmtDate, isUuid, relTime, type Bureau } from '@/lib/util';
import { addEvidenceAction, addFollowUpTaskAction, analyzeReplyAction, assignDisputeAction, nextRoundAction, recordResponseAction, transitionAction } from '../actions';
import { PRODUCT } from '@/lib/product';

export const metadata: Metadata = { title: 'Dispute' };

interface D {
  id: string; client_id: string; client_name: string; item_label: string; status: DisputeStatus; round: number; category: string; reason: string; fields: string[];
  bureau: Bureau | null; recipient_name: string; target_type: string; workflow: string; submitted_at: string | null; due_at: string | null; deadline_extended: boolean;
  response_at: string | null; outcome: Outcome | null; outcome_notes: string | null; assigned_to: string | null; approved_by_name: string | null; approved_at: string | null;
  parent_dispute_id: string | null; created_at: string;
}

function Transition({ id, to, label, variant = 'primary', confirm, children }: { id: string; to: DisputeStatus; label: string; variant?: 'primary' | 'secondary' | 'danger'; confirm?: string; children?: React.ReactNode }) {
  return (
    <ActionForm action={transitionAction} className="inline-flex flex-wrap items-end gap-2">
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
      `select d.*, c.full_name as client_name, ab.full_name as approved_by_name from public.disputes d join public.clients c on c.id = d.client_id left join public.users ab on ab.id = d.approved_by where d.id = $1`, [id]);
    if (!d) return null;
    const [events, evidence, letters, docs, consents, tasks, children, team] = await Promise.all([
      db.rows<{ id: string; kind: string; from_status: string | null; to_status: string | null; note: string | null; created_at: string; actor: string | null }>(
        `select e.id, e.kind, e.from_status, e.to_status, e.note, e.created_at, u.full_name as actor from public.dispute_events e left join public.users u on u.id = e.actor_id where e.dispute_id = $1 order by e.created_at desc, e.id`, [id]),
      db.rows<{ id: string; label: string; note: string | null; file_name: string | null; document_id: string | null; created_at: string }>(
        `select ev.id, ev.label, ev.note, ev.document_id, ev.created_at, doc.file_name from public.dispute_evidence ev left join public.documents doc on doc.id = ev.document_id where ev.dispute_id = $1 order by ev.created_at`, [id]),
      db.rows<{ id: string; title: string; status: string; current_version: number; created_at: string }>('select id, title, status, current_version, created_at from public.letters where dispute_id = $1 order by created_at desc', [id]),
      db.rows<{ id: string; file_name: string; kind: string }>('select id, file_name, kind from public.documents where client_id = $1 order by created_at desc limit 50', [d.client_id]),
      db.rows<{ kind: string; signed_at: string; revoked_at: string | null }>('select kind, signed_at, revoked_at from public.client_consents where client_id = $1', [d.client_id]),
      db.rows<{ id: string; title: string; status: string; due_at: string | null }>("select id, title, status, due_at from public.tasks where dispute_id = $1 order by status, due_at", [id]),
      db.rows<{ id: string; round: number; status: string }>('select id, round, status from public.disputes where parent_dispute_id = $1', [id]),
      staffMembers(db),
    ]);
    return { d, events, evidence, letters, docs, consents, tasks, children, team };
  });
  if (!data) notFound();
  const { d, events, evidence, letters, docs, consents, tasks, children, team } = data;
  const cs = consentStatus(consents);
  const hasApproved = letters.some((l) => l.status === 'approved' || l.status === 'sent');
  const steps = nextSteps({ status: d.status, round: d.round, due_at: d.due_at, outcome: d.outcome, hasApprovedLetter: hasApproved, evidenceCount: evidence.length });
  const canApprove = ctx.can('disputes:approve');
  const state = deadlineState(d.due_at);
  const idx = PIPELINE.indexOf(d.status);
  const open = !['resolved', 'cancelled'].includes(d.status);

  return (
    <>
      <PageHeader
        title={d.item_label}
        subtitle={<>Round {d.round} · {CATEGORIES[d.category]?.label ?? d.category} · for <Link className="underline" href={`/app/clients/${d.client_id}`}>{d.client_name}</Link> · sent to {d.bureau ? BUREAU_LABEL[d.bureau] : d.recipient_name}</>}
        back={{ href: '/app/disputes', label: 'Disputes' }}
        actions={<StatusBadge status={d.status} />}
      />

      {/* Pipeline stepper */}
      <nav aria-label="Pipeline" className="card mb-6 overflow-x-auto p-4">
        <ol className="flex min-w-[40rem] items-center">
          {PIPELINE.map((s, i) => {
            const done = idx > i, current = d.status === s;
            return (
              <li key={s} className={cn('flex flex-1 items-center', i === PIPELINE.length - 1 && 'flex-none')}>
                <span className="flex flex-col items-center gap-1.5 text-center">
                  <span className={cn('grid h-8 w-8 place-items-center rounded-full text-xs font-semibold ring-2', done ? 'bg-brand text-brand-ink ring-brand' : current ? 'bg-brand-soft text-brand-strong ring-brand' : 'bg-surface text-faint ring-line')}>{done ? <CheckIcon size={15} /> : i + 1}</span>
                  <span className={cn('w-20 text-[11px] leading-tight', current ? 'font-semibold text-ink' : 'text-muted')}>{STATUS_LABEL[s]}</span>
                </span>
                {i < PIPELINE.length - 1 && <span className={cn('mx-1 mb-5 h-0.5 flex-1', done ? 'bg-brand' : 'bg-line')} />}
              </li>
            );
          })}
        </ol>
        {(d.status === 'on_hold' || d.status === 'cancelled') && <p className="mt-3 text-sm text-muted">This dispute is <strong>{STATUS_LABEL[d.status].toLowerCase()}</strong>.</p>}
      </nav>

      <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
        <div className="space-y-6">
          {/* What to do now */}
          <Section title="What happens next" hint="The system suggests; people decide.">
            <ul className="space-y-2">{steps.map((s) => <li key={s} className="flex gap-2 text-sm"><Lightbulb size={16} className="mt-0.5 shrink-0 text-brand" />{s}</li>)}</ul>

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
                  {cs.missing.length > 0 && <Notice tone="bad" title="Cannot submit yet">Required consents missing: {cs.missing.join(', ').replace(/_/g, ' ')}. <Link className="underline" href={`/app/clients/${d.client_id}?tab=overview`}>Record them on the client profile.</Link></Notice>}
                  {cs.inCancellationWindow && <Notice tone="warn" title="Within the 3-business-day cancellation window">The client signed their agreement recently and may still cancel without penalty. Confirm before mailing.</Notice>}
                  {!hasApproved && <Notice tone="bad" title="No approved letter">Approve a letter for this dispute first.</Notice>}
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Select label="How was it sent?" name="sentMethod" defaultValue="certified_mail" options={[{ value: 'certified_mail', label: 'Certified mail' }, { value: 'first_class_mail', label: 'First-class mail' }, { value: 'portal', label: 'Online portal' }, { value: 'manual', label: 'Other' }]} />
                    <Field label="Tracking number" name="tracking" />
                    <Field label="Date the recipient received it (if known)" name="receivedOn" type="date" hint="The 30-day clock starts at receipt. Leave blank to count from today." />
                    <div className="self-end pb-2"><Check name="extended">Client sent additional information (45-day window)</Check></div>
                  </div>
                  <p className="text-xs text-muted">Recording a submission means a person has already mailed the approved letter. {PRODUCT.name} never sends correspondence on its own.</p>
                  <SubmitButton>Record submission</SubmitButton>
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
                      <Select label="Outcome" name="outcome" required defaultValue={d.outcome ?? ''} placeholder="Choose…" options={OUTCOMES.map((o) => ({ value: o, label: OUTCOME_LABEL[o] }))} />
                      <Field label="Date response received" name="receivedOn" type="date" />
                      <TextArea label="Notes" name="notes" rows={2} defaultValue={d.outcome_notes} />
                      <SubmitButton>Record response</SubmitButton>
                    </ActionForm>
                  </div>
                </div>
              )}
              {d.status === 'response_received' && <Transition id={d.id} to="resolved" label="Mark resolved" />}
              {d.status === 'on_hold' && <Transition id={d.id} to={d.submitted_at ? 'under_investigation' : 'draft'} label="Resume" />}
              {d.status === 'resolved' && ['verified', 'unresolved', 'no_response'].includes(d.outcome ?? '') && !children.length && (
                <details className="rounded-xl border border-line p-4">
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

          <Section title="Reason">
            <p className="whitespace-pre-wrap text-sm leading-relaxed">{d.reason}</p>
            {d.fields.length > 0 && <div className="mt-3 flex flex-wrap gap-1.5">{d.fields.map((f) => <Badge key={f}>{f}</Badge>)}</div>}
          </Section>

          <Section title={`Evidence (${evidence.length})`} hint="Everything attached to this dispute, in the order it was added.">
            {evidence.length === 0 ? <p className="mb-4 text-sm text-muted">No evidence attached yet. Statements, letters and records strengthen a dispute — and are what an investigator reviews.</p> : (
              <ul className="mb-4 divide-y divide-line text-sm">{evidence.map((e) => (
                <li key={e.id} className="flex items-start justify-between gap-3 py-2.5">
                  <div className="min-w-0"><div className="font-medium">{e.label}</div>{e.note && <div className="text-muted">{e.note}</div>}{e.file_name && <a className="text-xs text-brand-strong underline" href={`/api/documents/${e.document_id}`}>{e.file_name}</a>}</div>
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

          <Section title="History" hint="Every change is recorded automatically and cannot be edited.">
            <ol className="space-y-3">
              {events.map((e) => (
                <li key={e.id} className="flex gap-3 text-sm">
                  <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-brand" aria-hidden />
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
          <Section title="Timeline">
            <dl className="space-y-3 text-sm">
              <div className="flex justify-between"><dt className="text-muted">Created</dt><dd>{fmtDate(d.created_at)}</dd></div>
              <div className="flex justify-between"><dt className="text-muted">Approved</dt><dd>{d.approved_at ? `${fmtDate(d.approved_at)} · ${d.approved_by_name ?? ''}` : '—'}</dd></div>
              <div className="flex justify-between"><dt className="text-muted">Submitted</dt><dd>{fmtDate(d.submitted_at)}</dd></div>
              <div className="flex justify-between"><dt className="text-muted">Response due</dt><dd className="flex items-center gap-2">{fmtDate(d.due_at)}{d.due_at && open && <Badge tone={state === 'overdue' ? 'bad' : state === 'soon' ? 'warn' : 'neutral'}><CalendarClock size={12} /> {state === 'overdue' ? `${Math.abs(daysRemaining(d.due_at))}d overdue` : `${daysRemaining(d.due_at)}d`}</Badge>}</dd></div>
              <div className="flex justify-between"><dt className="text-muted">Response</dt><dd>{fmtDate(d.response_at)}</dd></div>
              <div className="flex justify-between"><dt className="text-muted">Outcome</dt><dd>{d.outcome ? <StatusBadge status={d.outcome} text={OUTCOME_LABEL[d.outcome]} /> : '—'}</dd></div>
            </dl>
            {d.due_at && <p className="mt-3 text-xs text-muted">{d.deadline_extended ? '45' : '30'}-day investigation window counted from receipt.</p>}
          </Section>

          <Section title="Letters" actions={open ? <Link href={`/app/letters/new?clientId=${d.client_id}&disputeId=${d.id}`} className="btn-secondary btn-sm">New</Link> : undefined}>
            {letters.length === 0 ? <p className="text-sm text-muted">No letter yet.</p> : (
              <ul className="space-y-2">{letters.map((l) => (
                <li key={l.id}><Link href={`/app/letters/${l.id}`} className="flex items-center justify-between gap-2 rounded-xl border border-line p-3 text-sm transition hover:border-brand/50">
                  <span className="flex min-w-0 items-center gap-2"><FileText size={16} className="shrink-0 text-muted" /><span className="truncate">{l.title}</span></span><StatusBadge status={l.status} />
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
            <Section title="Rounds">
              <ul className="space-y-1.5 text-sm">
                {d.parent_dispute_id && <li><Link className="underline" href={`/app/disputes/${d.parent_dispute_id}`}>← Previous round</Link></li>}
                {children.map((c) => <li key={c.id}><Link className="underline" href={`/app/disputes/${c.id}`}>Round {c.round} →</Link> <StatusBadge status={c.status} /></li>)}
              </ul>
            </Section>
          )}
          {!open && d.status === 'cancelled' && <EmptyState title="Cancelled" body="This dispute was cancelled and will not proceed." />}
        </aside>
      </div>
    </>
  );
}
