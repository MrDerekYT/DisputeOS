'use client';

import { useEffect, useState } from 'react';
import { tr, type Lang } from '@/lib/portal-i18n';

/** Last-resort error screen for any page without a closer one. The visitor is unknown here, so the language follows the browser. */
export default function RootError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const [lang, setLang] = useState<Lang>('en');
  useEffect(() => {
    console.error(error);
    if (navigator.language?.toLowerCase().startsWith('es')) setLang('es');
  }, [error]);
  const t = tr(lang);
  return (
    <main id="main" lang={lang} role="alert" className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center px-5 py-10 text-center">
      <h1 className="font-display text-3xl font-semibold">{t('err_title')}</h1>
      <p className="mt-2 text-sm text-muted">{t('err_rootBody')}</p>
      <div className="mt-6 flex flex-wrap justify-center gap-2">
        <button type="button" className="btn-primary" onClick={reset}>{t('err_retry')}</button>
        {/* A full page load on purpose: it also recovers when the app shell itself is what failed. */}
        {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
        <a href="/" className="btn-secondary">{t('err_home')}</a>
      </div>
    </main>
  );
}
