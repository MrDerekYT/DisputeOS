import Link from 'next/link';
import { ActionForm, Check, Field, SubmitButton, TextArea } from '@/components/forms';
import { Badge, Notice, Section, StatusBadge, type Tone } from '@/components/ui';
import { daysBetween, disputeClock, receivedDay, reinvestigationDays, toDay, type ClockRow, type Day } from '@/lib/disputes/clock';
import { PROCEDURE_KIND } from '@/lib/disputes/escalation';
import { CFPB_COMPLAINT_URL, complaintSummary, escalationSteps, isAgencyDispute, NO_RESPONSE_COPY, OUTCOME_PLAIN, type EscalationStep } from '@/lib/disputes/next-steps';
import { PRODUCT } from '@/lib/product';
import { fmtDate } from '@/lib/util';
import { confirmedAccurateAction, frivolousNoticeAction, procedureDatesAction, recordMoreInfoAction, requestProcedureAction } from '../escalation-actions';

export interface ClockDispute {
  id: string; client_id: string; tradeline_id: string | null; target_type: string; category: string; status: string; outcome: string | null; item_label: string; recipient_name: string; reason: string;
  submitted_at: string | null; due_at: string | null; deadline_extended: boolean; response_at: string | null;
  more_info_on: string | null; investigation_completed_on: string | null; frivolous_missing: string | null; client_confirmed_accurate: boolean;
}
export interface ClockLetter {
  id: string; kind: string; status: string; sent_on: string | null; sent_method: string | null; tracking_number: string | null;
  received_on: string | null; reply_due_on: string | null; reply_received_on: string | null;
}

const STATE: Record<ClockRow['state'], { tone: Tone; text: (r: ClockRow, today: Day) => string } | null> = {
  fact: null,
  done: { tone: 'ok', text: () => 'Recorded' },
  ahead: { tone: 'neutral', text: (r, today) => { const n = daysBetween(today, r.date); return n === 0 ? 'Today' : n === 1 ? 'In 1 day' : `In ${n} days`; } },
  // Not "late" or "missed": the app only knows that nothing has been recorded.
  passed: { tone: 'warn', text: () => 'Date passed, nothing recorded' },
};

/**
 * The legal clock for a dispute sent to a credit bureau or a specialty agency, and the optional steps that follow a
 * "verified" result or a period that ended with no response recorded. Everything here is offered, never done: each
 * button records what a person says happened, or opens a draft that still needs approval.
 */
export function ClockBlock({ d, letters, lang, today, tz, canLetter }: { d: ClockDispute; letters: ClockLetter[]; lang: 'en' | 'es'; today: Day; tz: string; canLetter: boolean }) {
  // Only once the dispute has been sent: before that, and for a cancelled dispute, there is no clock to show.
  if (!isAgencyDispute(d.target_type) || !d.due_at || !['submitted', 'under_investigation', 'response_received', 'resolved', 'on_hold'].includes(d.status)) return null;
  const procedure = letters.find((l) => l.kind === PROCEDURE_KIND && l.status !== 'void') ?? null;
  const mailed = letters.find((l) => l.kind !== PROCEDURE_KIND && l.status === 'sent') ?? null;
  const responseOn = d.response_at ? toDay(d.response_at, tz) : null;
  const rows = disputeClock({
    dueAt: d.due_at, extended: d.deadline_extended, moreInfoOn: d.more_info_on, completedOn: d.investigation_completed_on, responseOn, tz,
    procedure: procedure?.status === 'sent' ? { sentOn: procedure.sent_on, receivedOn: procedure.received_on, replyDueOn: procedure.reply_due_on, replyReceivedOn: procedure.reply_received_on } : null,
  }, today);
  const waiting = d.status === 'submitted' || d.status === 'under_investigation';
  const basis = { targetType: d.target_type, category: d.category, status: d.status, outcome: d.outcome, dueAt: d.due_at, hasTradeline: !!d.tradeline_id, tz };
  const next = escalationSteps({ ...basis, confirmedAccurate: d.client_confirmed_accurate }, today);
  // The steps would be on offer but for the client's confirmation: say so, and let it be undone.
  const withheld = d.client_confirmed_accurate && !!escalationSteps({ ...basis, confirmedAccurate: false }, today);

  let summary: string | null = null;
  if (next) {
    try {
      summary = complaintSummary({
        company: d.recipient_name, item: d.item_label, reason: d.reason, sentOn: mailed?.sent_on ?? (d.submitted_at ? toDay(d.submitted_at, tz) : null), sentMethod: mailed?.sent_method ?? null, tracking: mailed?.tracking_number ?? null,
        receivedOn: receivedDay(d.due_at, d.deadline_extended, tz), periodDays: reinvestigationDays(d.deadline_extended), periodEndsOn: toDay(d.due_at, tz), responseOn,
        outcomeText: d.outcome ? OUTCOME_PLAIN[d.outcome]?.[lang] ?? null : null,
        procedureRequestSentOn: procedure?.status === 'sent' ? procedure.sent_on : null, procedureReplyOn: procedure?.reply_received_on ?? null, today,
      }, lang);
    } catch { summary = null; } // the dispute's own wording did not pass the claims guard: prepare nothing rather than hand it on
  }

  const action = (s: EscalationStep) => {
    if (s.key === 'procedure_request') {
      if (procedure) {
        return (
          <div className="mt-2 space-y-2 text-sm">
            <p className="flex flex-wrap items-center gap-2"><Link className="link" href={`/app/letters/${procedure.id}`}>Open the request letter</Link><StatusBadge status={procedure.status} /></p>
            {procedure.status !== 'sent' && <p className="text-muted">The 15 days begin once the letter is approved, mailed and recorded as sent.</p>}
            {procedure.status === 'sent' && !procedure.reply_received_on && (
              <ActionForm action={procedureDatesAction} resetOnSuccess className="grid gap-3 sm:grid-cols-2">
                <input type="hidden" name="id" value={d.id} /><input type="hidden" name="letterId" value={procedure.id} />
                <Field label="Date the agency received the request" name="receivedOn" type="date" defaultValue={procedure.received_on ?? ''} max={today} hint="Optional. From the return receipt." />
                <Field label="Date the description arrived" name="replyOn" type="date" max={today} />
                <div className="sm:col-span-2"><SubmitButton variant="secondary">Record dates</SubmitButton></div>
              </ActionForm>
            )}
          </div>
        );
      }
      return canLetter ? (
        <ActionForm action={requestProcedureAction} className="mt-2">
          <input type="hidden" name="id" value={d.id} />
          <SubmitButton variant="secondary">Draft the request letter</SubmitButton>
        </ActionForm>
      ) : null;
    }
    if (s.key === 'results_request') {
      return <p className="mt-2 text-sm"><Link className="link" href={`/app/letters/new?clientId=${d.client_id}&disputeId=${d.id}&templateKey=follow_up_en`}>Draft a follow-up letter</Link></p>;
    }
    if (s.key === 'cfpb_complaint') {
      return summary ? (
        <details className="mt-2 text-sm">
          <summary className="cursor-pointer font-medium">Summary of dates and facts for the client</summary>
          <pre className="mt-2 whitespace-pre-wrap rounded-xl bg-raised p-3 font-sans text-[0.8125rem] leading-relaxed">{summary}</pre>
          <p className="mt-2 text-[0.8125rem] text-muted">Taken from this dispute’s record. Give it to the client to check and use at <a className="link" href={CFPB_COMPLAINT_URL} target="_blank" rel="noreferrer">consumerfinance.gov/complaint</a>. {PRODUCT.name} does not file anything.</p>
        </details>
      ) : <p className="mt-2 text-[0.8125rem] text-muted">A summary could not be prepared from this dispute’s wording. The client can still describe the dates in their own words.</p>;
    }
    return null;
  };

  return (
    <>
      <Section title="Legal clock" hint="Counted from the dates recorded on this dispute, under 15 U.S.C. § 1681i. A date that has passed means nothing was recorded here, not that nothing was sent.">
        <ul className="divide-y divide-line/70">
          {rows.map((r) => {
            const s = STATE[r.state];
            return (
              <li key={r.key} className="py-3 first:pt-0 last:pb-0">
                <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                  <span className="text-sm font-semibold">{r.label}</span>
                  <span className="flex flex-wrap items-center gap-2 text-sm"><span className="font-semibold">{fmtDate(r.date)}</span>{s && <Badge tone={s.tone}>{s.text(r, today)}</Badge>}</span>
                </div>
                <p className="mt-1 text-[0.8125rem] text-muted">{r.note} <span className="whitespace-nowrap">15 U.S.C. {r.cite}</span></p>
              </li>
            );
          })}
        </ul>
        {waiting && !d.more_info_on && (
          <details className="mt-4 border-t border-line pt-4">
            <summary className="cursor-pointer text-sm font-semibold">Client sent more information</summary>
            <ActionForm action={recordMoreInfoAction} className="mt-3 space-y-3">
              <input type="hidden" name="id" value={d.id} />
              <p className="text-[0.8125rem] text-muted">When a client sends the agency additional relevant information during the 30 days, the agency may generally take up to 15 more. Recording the date moves the deadline to 45 days from receipt.</p>
              <Field label="Date the client sent it" name="sentOn" type="date" max={today} required />
              <SubmitButton variant="secondary">Record and extend to 45 days</SubmitButton>
            </ActionForm>
          </details>
        )}
        {['submitted', 'under_investigation', 'response_received'].includes(d.status) && d.outcome !== 'frivolous' && (
          <details className="mt-4 border-t border-line pt-4">
            <summary className="cursor-pointer text-sm font-semibold">The agency said the dispute was frivolous or irrelevant</summary>
            <ActionForm action={frivolousNoticeAction} className="mt-3 space-y-3">
              <input type="hidden" name="id" value={d.id} />
              <p className="text-[0.8125rem] text-muted">An agency that will not investigate generally has to say why and what information it needs (15 U.S.C. § 1681i(a)(3)). Type what its notice asked for. That becomes a task, and the client sees the request in their portal.</p>
              <TextArea label="What did the agency say was missing?" name="missing" rows={3} required maxLength={1000} hint="Use the notice’s own words. Do not add a reason the client has not given." />
              <Field label="Date the notice was received" name="receivedOn" type="date" max={today} />
              <SubmitButton variant="secondary">Record notice and create the task</SubmitButton>
            </ActionForm>
          </details>
        )}
      </Section>

      {d.outcome === 'frivolous' && d.frivolous_missing && (
        <Notice tone="info" title={`${d.recipient_name} asked for more information`}>
          Its notice said this was missing: “{d.frivolous_missing}”. A task was created for it and the client sees the request in their portal. When the client has provided it, another round can include it. Nothing else is suggested here.
        </Notice>
      )}

      {withheld && (
        <Section title="Optional next steps">
          <p className="text-sm">The client has confirmed this item is reported accurately, so no further step, letter or round is offered for it.</p>
          <ActionForm action={confirmedAccurateAction} className="mt-3"><input type="hidden" name="id" value={d.id} /><SubmitButton variant="ghost">Undo: the client has not confirmed this</SubmitButton></ActionForm>
        </Section>
      )}

      {next && (
        <Section title="Optional next steps" hint="Each one is a choice for the client. Nothing here happens automatically, and none of them comes with an expected result.">
          {next.basis === 'no_response' ? (
            <Notice tone="warn" title={NO_RESPONSE_COPY.title}>{NO_RESPONSE_COPY.body}</Notice>
          ) : <p className="text-sm text-muted">A result of “verified as reported” is recorded for this dispute.</p>}
          <ul className="mt-4 space-y-5">
            {next.steps.map((s) => (
              <li key={s.key}>
                <h3 className="text-sm font-semibold">{s.title}</h3>
                <p className="mt-1 text-sm">{s.is}</p>
                <p className="mt-1 text-sm text-muted">{s.isNot} <span className="whitespace-nowrap">({s.cite})</span></p>
                {action(s)}
              </li>
            ))}
          </ul>
          <ActionForm action={confirmedAccurateAction} className="mt-5 flex flex-wrap items-center gap-3 border-t border-line pt-4">
            <input type="hidden" name="id" value={d.id} />
            <Check name="confirmed" required>The client has confirmed this item is reported accurately</Check>
            <SubmitButton variant="secondary">Save and stop offering steps</SubmitButton>
            <p className="basis-full text-[0.8125rem] text-muted">This also closes the dispute to new letters and another round.</p>
          </ActionForm>
        </Section>
      )}
    </>
  );
}
