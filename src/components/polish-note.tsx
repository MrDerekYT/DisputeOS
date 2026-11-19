'use client';

import { useActionState, useEffect, useRef } from 'react';
import type { ActionState } from './forms';
import { SubmitButton } from './forms';

type Action = (prev: ActionState, fd: FormData) => Promise<ActionState>;

/**
 * Optional, paid AI polish for the drafted progress note. Nothing is called or charged until the button is pressed.
 * On success the polished text replaces the draft in the message box next to it (inside the same [data-polish-scope]).
 */
export function PolishNote({ clientId, action, label }: { clientId: string; action: Action; label: string }) {
  const [s, run] = useActionState(action, undefined);
  const ref = useRef<HTMLFormElement>(null);
  useEffect(() => {
    const box = ref.current?.closest('[data-polish-scope]')?.querySelector<HTMLTextAreaElement>('textarea[name="body"]');
    if (box && s?.ok && s.data?.text) box.value = s.data.text;
  }, [s]);
  return (
    <form ref={ref} action={run} className="space-y-2">
      <input type="hidden" name="clientId" value={clientId} />
      <SubmitButton variant="secondary" className="btn-sm" pendingText="Polishing…">{label}</SubmitButton>
      <div aria-live="polite">
        {s?.error && <p role="alert" className="text-sm text-bad">{s.error}</p>}
        {s?.ok && <p className="text-sm text-ok">{s.ok}</p>}
      </div>
    </form>
  );
}
