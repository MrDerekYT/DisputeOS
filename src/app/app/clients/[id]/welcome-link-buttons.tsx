'use client';

import { useActionState } from 'react';
import { AlertCircle, CheckCircle2 } from 'lucide-react';
import { SubmitButton } from '@/components/forms';
import { CopyButton } from '@/components/shell-client';
import { copyWelcomeLinkAction, emailWelcomeLinkAction } from '../welcome-actions';

const Result = ({ tone, children }: { tone: 'ok' | 'bad'; children: string }) => (
  <p role={tone === 'bad' ? 'alert' : undefined} className={`mt-3 flex items-start gap-2 rounded-xl px-3.5 py-2.5 text-sm ${tone === 'ok' ? 'bg-ok-soft text-ok' : 'bg-bad-soft text-bad'}`}>
    {tone === 'ok' ? <CheckCircle2 size={16} className="mt-0.5 shrink-0" aria-hidden /> : <AlertCircle size={16} className="mt-0.5 shrink-0" aria-hidden />} {children}
  </p>
);

/** "Copy welcome link" (always) and "Email welcome link" (only when email really delivers). A made link is shown to copy. */
export function WelcomeLinkButtons({ clientId, emailLive }: { clientId: string; emailLive: boolean }) {
  const [copied, copy] = useActionState(copyWelcomeLinkAction, undefined);
  const [mailed, mail] = useActionState(emailWelcomeLinkAction, undefined);
  const link = copied?.data?.link;
  return (
    <div aria-live="polite">
      <div className="flex flex-wrap gap-2">
        <form action={copy}><input type="hidden" name="clientId" value={clientId} /><SubmitButton variant="secondary" pendingText="Making a link…">Copy welcome link</SubmitButton></form>
        {emailLive && <form action={mail}><input type="hidden" name="clientId" value={clientId} /><SubmitButton variant="secondary" pendingText="Sending…">Email welcome link</SubmitButton></form>}
      </div>
      {link && (
        <div className="mt-3 rounded-xl bg-raised p-3">
          <p className="text-sm">{copied?.ok}</p>
          <code className="mt-2 block break-all text-xs">{link}</code>
          <div className="mt-2"><CopyButton value={link} label="Copy link" /></div>
        </div>
      )}
      {copied?.error && <Result tone="bad">{copied.error}</Result>}
      {mailed?.ok && <Result tone="ok">{mailed.ok}</Result>}
      {mailed?.error && <Result tone="bad">{mailed.error}</Result>}
    </div>
  );
}
