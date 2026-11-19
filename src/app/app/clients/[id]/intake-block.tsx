import { Download } from 'lucide-react';
import { ActionForm, SubmitButton } from '@/components/forms';
import { Badge, Section } from '@/components/ui';
import { intakeStateLabel, intakeSummary, type IntakeState, type IntakeStatus } from '@/lib/intake';
import { fmtDate } from '@/lib/util';
import { requestMissingIntakeAction, reviewDocumentAction } from '../actions';

const TONE: Record<IntakeState, 'ok' | 'warn' | 'bad' | 'info' | 'neutral'> = { accepted: 'ok', pending: 'info', rejected: 'bad', stale: 'warn', missing: 'warn' };
/** The one date worth recording at review, per item: it is what makes "expired" and "no longer recent" knowable later. */
const DATE_FIELD: Record<string, { name: 'expiresOn' | 'docDate'; label: string }> = {
  id: { name: 'expiresOn', label: 'Expires on (optional)' },
  proof_of_address: { name: 'docDate', label: 'Date on the document (optional)' },
};

/** Staff view of the identity documents a bureau normally asks for: status per item, review, and one click to ask for the rest. */
export function IntakeBlock({ clientId, statuses }: { clientId: string; statuses: IntakeStatus[] }) {
  const sum = intakeSummary(statuses);
  return (
    <Section id="intake" title="Intake documents" hint={`${sum.accepted} of ${sum.total} accepted. Credit bureaus usually ask for these with a mailed dispute.`}>
      <ul className="divide-y divide-line/70">
        {statuses.map((s) => {
          const date = DATE_FIELD[s.item.key];
          return (
            <li key={s.item.key} className="py-3 first:pt-0">
              <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
                <span className="font-medium">{s.item.label.en}</span>
                <Badge tone={TONE[s.state]}>{intakeStateLabel(s)}</Badge>
              </div>
              {s.doc && (
                <a href={`/api/documents/${s.doc.id}`} className="mt-1 flex min-w-0 items-center gap-2 text-sm hover:underline">
                  <Download size={14} aria-hidden className="shrink-0 text-muted" /><span className="truncate">{s.doc.file_name}</span>
                </a>
              )}
              {s.state === 'rejected' && s.reason && <p className="mt-1 text-sm text-muted">Reason given to the client: {s.reason}</p>}
              {s.state === 'stale' && s.doc && <p className="mt-1 text-sm text-muted">{s.why === 'expired' ? `Expired ${fmtDate(s.doc.expires_on)}.` : `Dated ${fmtDate(s.doc.doc_date)}.`} Ask for a current one.</p>}
              {s.item.staffNote && <p className="mt-1 text-[0.8125rem] text-muted">{s.item.staffNote}</p>}
              {s.state === 'pending' && s.doc && (
                <div className="mt-3 flex flex-wrap items-end gap-x-4 gap-y-3">
                  <form action={reviewDocumentAction} className="flex flex-wrap items-end gap-2">
                    <input type="hidden" name="id" value={s.doc.id} /><input type="hidden" name="clientId" value={clientId} /><input type="hidden" name="decision" value="accepted" />
                    {date && <div><label className="label" htmlFor={`${date.name}-${s.doc.id}`}>{date.label}</label><input id={`${date.name}-${s.doc.id}`} name={date.name} type="date" className="field !w-auto" /></div>}
                    <button className="btn-secondary btn-sm">Accept</button>
                  </form>
                  <form action={reviewDocumentAction} className="flex min-w-0 flex-1 flex-wrap items-end gap-2">
                    <input type="hidden" name="id" value={s.doc.id} /><input type="hidden" name="clientId" value={clientId} /><input type="hidden" name="decision" value="rejected" />
                    <div className="min-w-[12rem] flex-1"><label className="label" htmlFor={`reason-${s.doc.id}`}>Reason, shown to the client</label>
                      <input id={`reason-${s.doc.id}`} name="reason" required maxLength={300} placeholder="e.g. The photo is cut off at the bottom" className="field" /></div>
                    <button className="btn-ghost btn-sm">Reject</button>
                  </form>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {sum.needed.length > 0 && (
        <ActionForm action={requestMissingIntakeAction} className="mt-4 border-t border-line pt-4">
          <input type="hidden" name="clientId" value={clientId} />
          <SubmitButton variant="secondary">Ask the client for the missing ones</SubmitButton>
        </ActionForm>
      )}
    </Section>
  );
}
