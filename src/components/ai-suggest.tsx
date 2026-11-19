'use client';

import { useActionState } from 'react';
import { AlertCircle, CheckCircle2 } from 'lucide-react';
import type { ActionState } from './forms';
import { SubmitButton } from './forms';
import { AiTag } from './ui';

type Action = (prev: ActionState, fd: FormData) => Promise<ActionState>;

/** Marks the lines that differ so the reviewer's eye goes to what changed. */
function Lines({ text, other, tone }: { text: string; other: string; tone: 'before' | 'after' }) {
  const otherLines = new Set(other.split('\n').map((l) => l.trim()));
  return (
    <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded-xl bg-raised py-3 pr-3 text-xs leading-relaxed">
      {text.split('\n').map((l, i) => {
        const changed = l.trim() !== '' && !otherLines.has(l.trim());
        // A changed line gets a bar in the margin as well as a tint, so the difference does not rest on colour.
        return <span key={i} className={changed ? `block border-l-[3px] pl-[calc(0.75rem-3px)] ${tone === 'after' ? 'border-ok bg-ok-soft' : 'border-warn bg-warn-soft'}` : 'block min-h-[1.2em] pl-3'}>{l}</span>;
      })}
    </pre>
  );
}

/**
 * AI wording help in two steps: ask for a suggestion, compare it with the current text, then accept or ignore it.
 * The first step changes nothing in the letter, and an accepted suggestion is only a new draft version.
 */
export function AiSuggest({ id, suggest, accept, stored }: { id: string; suggest: Action; accept: Action; stored?: { before: string; after: string; version: string; provider: string } }) {
  const [s, runSuggest] = useActionState(suggest, undefined);
  const [a, runAccept] = useActionState(accept, undefined);
  // `stored` is the suggestion already paid for on this version, read by the page: it survives a reload or a lost response.
  const proposal = a?.ok ? null : s?.ok && s.data?.after ? s.data : stored ?? null;
  return (
    <div className="space-y-3">
      <form action={runSuggest}><input type="hidden" name="id" value={id} /><SubmitButton variant="secondary" className="w-full" pendingText="Thinking…">Suggest better wording</SubmitButton></form>
      <div aria-live="polite" className="space-y-3">
        {s?.error && <p role="alert" className="flex items-start gap-2 rounded-xl bg-bad-soft px-3.5 py-2.5 text-sm text-bad"><AlertCircle size={16} className="mt-0.5 shrink-0" aria-hidden /> {s.error}</p>}
        {proposal && (
          <div className="space-y-3 border-t border-line pt-3">
            <p className="text-sm font-medium">Compare before you accept. The letter has not been changed.</p>
            <div><div className="mb-1 text-xs font-semibold text-muted">Current text (version {proposal.version})</div><Lines text={proposal.before!} other={proposal.after!} tone="before" /></div>
            <div><div className="mb-1 flex flex-wrap items-center gap-2 text-xs font-semibold text-muted"><AiTag>AI suggestion</AiTag> changed lines are marked in the margin</div><Lines text={proposal.after!} other={proposal.before!} tone="after" /></div>
            <form action={runAccept} className="space-y-2">
              <input type="hidden" name="id" value={id} /><input type="hidden" name="version" value={proposal.version} />
              <input type="hidden" name="provider" value={proposal.provider ?? ''} /><input type="hidden" name="text" value={proposal.after} />
              <SubmitButton className="w-full" pendingText="Saving…">Use this wording as a new draft</SubmitButton>
              <p className="text-xs text-muted">To ignore the suggestion, simply leave it. The letter stays exactly as it is.</p>
            </form>
          </div>
        )}
        {a?.error && <p role="alert" className="flex items-start gap-2 rounded-xl bg-bad-soft px-3.5 py-2.5 text-sm text-bad"><AlertCircle size={16} className="mt-0.5 shrink-0" aria-hidden /> {a.error}</p>}
        {a?.ok && <p className="flex items-start gap-2 rounded-xl bg-ok-soft px-3.5 py-2.5 text-sm text-ok"><CheckCircle2 size={16} className="mt-0.5 shrink-0" aria-hidden /> {a.ok}</p>}
      </div>
    </div>
  );
}
