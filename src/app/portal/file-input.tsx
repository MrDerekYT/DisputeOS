'use client';

import { useState } from 'react';
import { MAX_UPLOAD_BYTES } from '@/lib/upload';

/**
 * File picker for the portal upload forms. A file over the size limit is refused here, in the browser, because the
 * server rejects an oversized request before the upload action can answer with a readable message.
 */
export function PortalFileInput({ id, tooLarge }: { id: string; tooLarge: string }) {
  const [error, setError] = useState(false);
  return (
    <>
      <input
        id={id} name="file" type="file" required accept=".pdf,.png,.jpg,.jpeg" aria-describedby={error ? `${id}-error` : undefined}
        className="field !p-2 text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-brand-soft file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-brand-strong"
        onChange={(e) => {
          const big = (e.currentTarget.files?.[0]?.size ?? 0) > MAX_UPLOAD_BYTES;
          if (big) e.currentTarget.value = '';
          setError(big);
        }}
      />
      {error && <p id={`${id}-error`} role="alert" className="mt-1.5 text-sm text-bad">{tooLarge}</p>}
    </>
  );
}
