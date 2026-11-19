'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, MessageCircle, RotateCw } from 'lucide-react';
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
    <div ref={ref} role="alert" className="mx-auto max-w-xl py-6 sm:py-10">
      <span aria-hidden className="grid h-11 w-11 place-items-center rounded-xl bg-warn-soft text-warn"><AlertTriangle size={20} /></span>
      <h1 className="display mt-4 text-[1.75rem]">{t('err_title')}</h1>
      <p className="mt-2 text-[0.9375rem] text-muted">{t('err_body')}</p>
      <div className="mt-6 flex flex-col gap-2.5 sm:flex-row">
        <button type="button" className="btn-primary btn-lg" onClick={reset}><RotateCw size={17} aria-hidden /> {t('err_retry')}</button>
        <Link href="/portal/messages" className="btn-quiet btn-lg"><MessageCircle size={17} aria-hidden /> {t('messageTeam')}</Link>
      </div>
    </div>
  );
}
