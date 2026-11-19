'use client';

import { useState } from 'react';

/**
 * File picker that refuses an oversized file in the browser. The host (or Next.js) rejects an oversized request before
 * the upload action can answer with a readable message, so the limit is checked here first. `maxBytes` and `tooLarge`
 * come from the server (src/lib/upload.ts), so this check, the server's check and the messages all state one limit.
 */
export function FileInput({ id, accept, maxBytes, tooLarge }: { id: string; accept: string; maxBytes: number; tooLarge: string }) {
  const [error, setError] = useState(false);
  return (
    <>
      <input
        id={id} name="file" type="file" required accept={accept} aria-describedby={error ? `${id}-error` : undefined}
        className="field !p-2 text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-brand-soft file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-brand-strong"
        onChange={(e) => {
          const big = (e.currentTarget.files?.[0]?.size ?? 0) > maxBytes;
          if (big) e.currentTarget.value = '';
          setError(big);
        }}
      />
      {error && <p id={`${id}-error`} role="alert" className="mt-1.5 text-sm text-bad">{tooLarge}</p>}
    </>
  );
}
