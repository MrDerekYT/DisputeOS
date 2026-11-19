'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { tr, type Lang } from '@/lib/portal-i18n';

/**
 * Shown inside the portal frame when a portal page fails to load or an action fails outright (for example an upload
 * the server refuses before it can answer). The frame around it stays, and carries the client's language.
 */
export default function PortalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [lang, setLang] = useState<Lang>('en');
  useEffect(() => {
    console.error(error);
    if (ref.current?.closest('[lang]')?.getAttribute('lang') === 'es') setLang('es');
  }, [error]);
  const t = tr(lang);
  return (
    <div ref={ref} role="alert" className="card mx-auto max-w-xl p-6 text-center sm:p-8">
      <h1 className="font-display text-2xl font-semibold">{t('err_title')}</h1>
      <p className="mt-2 text-sm text-muted">{t('err_body')}</p>
      <div className="mt-5 flex flex-wrap justify-center gap-2">
        <button type="button" className="btn-primary" onClick={reset}>{t('err_retry')}</button>
        <Link href="/portal/messages" className="btn-secondary">{t('messageTeam')}</Link>
      </div>
    </div>
  );
}
