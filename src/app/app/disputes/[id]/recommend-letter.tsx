import Link from 'next/link';
import { AlertTriangle } from 'lucide-react';
import { ActionForm, SubmitButton } from '@/components/forms';
import type { Recommendation } from '@/lib/letters/brief';
import { draftRecommendedLetterAction } from '../recommend-actions';

/**
 * The letter that fits this dispute as it stands, with the one-line reason taken from the file
 * (src/lib/letters/brief.ts recommendLetter). No AI is involved. It is shown only while there is a letter to draft:
 * nothing appears when no letter fits, or when a letter of that kind is already on the dispute. Drafting it creates an
 * ordinary draft; staff can always choose another letter instead.
 */
export function RecommendLetter({ disputeId, clientId, rec, canDraft }: { disputeId: string; clientId: string; rec: Recommendation; canDraft: boolean }) {
  if (!rec.templateKey || rec.exists) return null;
  return (
    <div className="mb-3 rounded-xl border border-line p-3.5 text-sm" data-recommended-letter={rec.templateKey}>
      <div className="text-[0.8125rem] font-medium text-muted">Recommended letter</div>
      <div className="mt-0.5 font-semibold">{rec.name}</div>
      <p className="mt-1 text-[0.8125rem] text-muted">{rec.reason}</p>
      {rec.missing.length > 0 ? (
        <ul className="mt-2 space-y-1.5 text-[0.8125rem]">
          {rec.missing.map((m) => <li key={m} className="flex gap-2"><AlertTriangle size={14} aria-hidden className="mt-0.5 shrink-0 text-warn" />{m}</li>)}
        </ul>
      ) : canDraft ? (
        <ActionForm action={draftRecommendedLetterAction} className="mt-3">
          <input type="hidden" name="id" value={disputeId} />
          <SubmitButton variant="secondary" className="w-full" pendingText="Drafting…">Draft this letter</SubmitButton>
        </ActionForm>
      ) : null}
      {canDraft && <p className="mt-2 text-[0.8125rem]"><Link className="link" href={`/app/letters/new?clientId=${clientId}&disputeId=${disputeId}`}>Choose another</Link></p>}
    </div>
  );
}
