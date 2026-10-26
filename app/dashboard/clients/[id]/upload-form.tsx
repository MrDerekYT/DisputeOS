'use client';

import { useActionState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';

type Action = (
  prev: { error?: string } | undefined,
  fd: FormData,
) => Promise<{ error?: string } | undefined>;

export function UploadForm({ clientId, action }: { clientId: string; action: Action }) {
  const t = useTranslations('clients');
  const [state, run, pending] = useActionState(action, undefined);
  return (
    <form action={run} className="max-w-md space-y-2 rounded-lg border p-4">
      <h2 className="font-semibold">{t('uploadTitle')}</h2>
      <p className="text-xs text-muted-foreground">{t('uploadHelp')}</p>
      <input type="hidden" name="clientId" value={clientId} />
      <input name="file" type="file" required accept=".pdf,.png,.jpg,.jpeg,.txt,.html,.htm" />
      {state?.error && (
        <p role="alert" className="text-sm text-destructive">
          {t(`err_${state.error}` as 'err_failed')}
        </p>
      )}
      <Button disabled={pending}>{t('upload')}</Button>
    </form>
  );
}
