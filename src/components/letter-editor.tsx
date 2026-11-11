'use client';

import { useState } from 'react';
import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import { ActionForm, SubmitButton, TextArea } from '@/components/forms';
import { findBlockedClaims } from '@/lib/compliance/claims';
import { unresolvedPlaceholders } from '@/lib/letters/render';
import type { ActionState } from '@/components/forms';

type Save = (prev: ActionState, fd: FormData) => Promise<ActionState>;

/** Edit on the left, see the letter as it will print on the right. Problems are flagged as you type. */
export function LetterEditor({ id, initial, locked, save }: { id: string; initial: string; locked: boolean; save: Save }) {
  const [text, setText] = useState(initial);
  const unresolved = unresolvedPlaceholders(text);
  const claims = findBlockedClaims(text);
  const dirty = text.trim() !== initial.trim();
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <ActionForm action={save} className="space-y-3">
        <input type="hidden" name="id" value={id} />
        <div>
          <label htmlFor="body" className="label">Letter text</label>
          <textarea id="body" name="body" value={text} onChange={(e) => setText(e.target.value)} readOnly={locked} rows={26}
            className="field resize-y font-mono !text-[13px] leading-relaxed" spellCheck />
        </div>
        <div aria-live="polite" className="space-y-2">
          {unresolved.length > 0 && <p className="flex items-start gap-2 rounded-xl bg-warn-soft px-3 py-2 text-sm text-warn"><AlertTriangle size={16} className="mt-0.5 shrink-0" /> Fill in before approval: {unresolved.join(', ')}</p>}
          {claims.map((c) => <p key={c.id} className="flex items-start gap-2 rounded-xl bg-bad-soft px-3 py-2 text-sm text-bad"><AlertTriangle size={16} className="mt-0.5 shrink-0" /> “{c.excerpt}” — {c.why}</p>)}
          {!unresolved.length && !claims.length && <p className="flex items-center gap-2 text-sm text-ok"><CheckCircle2 size={16} /> No unfilled fields or prohibited claims detected.</p>}
        </div>
        {!locked && (
          <div className="flex flex-wrap items-end gap-3">
            <div className="min-w-[12rem] flex-1"><TextArea label="What did you change? (optional)" name="note" rows={1} maxLength={300} /></div>
            <SubmitButton>{dirty ? "Save new version" : "Save (no changes)"}</SubmitButton>
          </div>
        )}
        {locked && <p className="text-sm text-muted">This letter is final and can no longer be edited.</p>}
      </ActionForm>

      <div aria-label="Print preview" className="no-print">
        <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Preview</div>
        <div className="mx-auto aspect-[8.5/11] max-h-[46rem] w-full overflow-auto rounded-md border border-line bg-white p-[8%] text-[11px] leading-[1.45] text-neutral-900 shadow-pop">
          <pre className="whitespace-pre-wrap font-sans">{text}</pre>
        </div>
      </div>
    </div>
  );
}
