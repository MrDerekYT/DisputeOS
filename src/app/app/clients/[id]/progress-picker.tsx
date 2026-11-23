'use client';

import { Sparkles } from 'lucide-react';
import { ActionForm, Select, SubmitButton } from '@/components/forms';
import { CLIENT_STAGES, CLIENT_STATUSES, STAGE_LABEL } from '@/lib/crm';
import { STATUS_LABEL, type Suggestion } from '@/lib/client-progress';
import { setProgressAction } from '../actions';

/**
 * Status and stage, chosen from a dropdown that starts on what the client's file shows (src/lib/client-progress.ts).
 * The page already moves a client forward on its own; this is for any other change, and says why it suggests what it does.
 */
export function ProgressPicker({ clientId, status, stage, suggestion }: { clientId: string; status: string; stage: string; suggestion: Suggestion }) {
  const differs = suggestion.status !== status || suggestion.stage !== stage;
  return (
    <details className="mt-3 text-sm" open={differs}>
      <summary className="cursor-pointer text-muted hover:text-ink">
        <Sparkles size={13} aria-hidden className="mr-1 inline" />
        {differs
          ? <>Suggested from the file: <strong className="font-semibold text-ink">{STATUS_LABEL[suggestion.status]} · {STAGE_LABEL[suggestion.stage]}</strong></>
          : 'Change status or stage'}
      </summary>
      <ActionForm action={setProgressAction} className="mt-3 flex flex-wrap items-end gap-3">
        <input type="hidden" name="clientId" value={clientId} />
        <Select label="Status" name="status" defaultValue={differs ? suggestion.status : status}
          options={CLIENT_STATUSES.map((s) => ({ value: s, label: `${STATUS_LABEL[s]}${s === suggestion.status ? ' (suggested)' : ''}` }))} />
        <Select label="Stage" name="stage" defaultValue={differs ? suggestion.stage : stage}
          options={CLIENT_STAGES.map((s) => ({ value: s, label: `${STAGE_LABEL[s]}${s === suggestion.stage ? ' (suggested)' : ''}` }))} />
        <SubmitButton variant="secondary" pendingText="Saving…">Save</SubmitButton>
      </ActionForm>
      <p className="mt-2 text-xs text-muted">Why: {suggestion.why.filter(Boolean).join('; ')}.</p>
    </details>
  );
}
