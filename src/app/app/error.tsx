'use client';

import { useEffect } from 'react';
import { AlertTriangle } from 'lucide-react';

/** Error screen for the staff app. It renders inside the app shell, so the navigation stays usable. */
export default function StaffError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <div role="alert" className="mx-auto mt-10 max-w-lg px-2 text-center sm:mt-16">
      <div className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-xl bg-warn-soft text-warn" aria-hidden><AlertTriangle size={22} /></div>
      <h1 className="display text-2xl">Something went wrong</h1>
      <p className="mt-2 text-sm text-muted">
        This page could not be shown, or the last action did not complete. Try again. If it keeps happening, go back to the dashboard and check
        whether your change was saved before repeating it.
      </p>
      {error.digest && <p className="mt-2 text-xs text-muted">Reference: {error.digest}</p>}
      <div className="mt-6 flex flex-wrap justify-center gap-2">
        <button type="button" className="btn-primary" onClick={reset}>Try again</button>
        {/* A full page load on purpose: it clears whatever state led here. */}
        {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
        <a href="/app" className="btn-secondary">Back to dashboard</a>
      </div>
    </div>
  );
}
