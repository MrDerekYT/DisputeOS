'use client';

import { useState } from 'react';

/** Room left for the rest of the form in the request: the host refuses the whole request, not just the file. */
const MARGIN = 0.95;
const ACCEPTED = ['image/jpeg', 'image/png'];

/**
 * Draws a photo again as a JPEG, scaled down step by step until it fits under `maxBytes`. Works for any image the
 * browser can open (including an iPhone's HEIC photo in Safari), which the server would otherwise refuse.
 */
async function shrink(file: File, maxBytes: number): Promise<File> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    let scale = Math.min(1, 2400 / Math.max(img.naturalWidth, img.naturalHeight, 1));
    let quality = 0.85;
    for (let i = 0; i < 7; i++) {
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
      const g = canvas.getContext('2d');
      if (!g) break;
      g.fillStyle = '#ffffff'; // a transparent PNG gets a white page, not a black one
      g.fillRect(0, 0, canvas.width, canvas.height);
      g.drawImage(img, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob | null>((done) => canvas.toBlob(done, 'image/jpeg', quality));
      if (blob && blob.size <= maxBytes * MARGIN) return new File([blob], `${file.name.replace(/\.[^.]+$/, '') || 'photo'}.jpg`, { type: 'image/jpeg', lastModified: Date.now() });
      scale *= 0.8;
      quality = Math.max(0.6, quality - 0.05);
    }
    throw new Error('still too large');
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * File picker for identity documents, made for phone photos. A PDF, PNG or JPEG within the limit is sent as it is. A
 * bigger photo, or one in another image format, is redrawn in the browser as a JPEG that fits (Vercel refuses request
 * bodies over 4.5 MB; `maxBytes` comes from the server's own limit, src/lib/upload.ts). The form cannot be sent while
 * a photo is being prepared. Nothing is uploaded until the person presses the button.
 */
export function PhotoFileInput({ id, maxBytes, tooLarge, preparing }: { id: string; maxBytes: number; tooLarge: string; preparing: string }) {
  const [state, setState] = useState<'idle' | 'busy' | 'error'>('idle');
  return (
    <>
      <input
        id={id} name="file" type="file" required accept="image/*,.pdf,.png,.jpg,.jpeg,.heic,.heif"
        aria-describedby={state === 'idle' ? undefined : `${id}-note`}
        className="field !p-2 text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-brand-soft file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-brand-strong"
        onChange={async (e) => {
          const input = e.currentTarget;
          const file = input.files?.[0];
          input.setCustomValidity('');
          if (!file) { setState('idle'); return; }
          const image = file.type.startsWith('image/') || /\.(heic|heif)$/i.test(file.name);
          const redraw = image && (file.size > maxBytes * MARGIN || !ACCEPTED.includes(file.type));
          if (!redraw) {
            if (file.size > maxBytes) { input.value = ''; setState('error'); } else setState('idle');
            return;
          }
          setState('busy');
          input.setCustomValidity(preparing); // blocks the form until the smaller copy is in place
          try {
            const smaller = await shrink(file, maxBytes);
            const dt = new DataTransfer();
            dt.items.add(smaller);
            input.files = dt.files;
            input.setCustomValidity('');
            setState('idle');
          } catch {
            // The browser could not redraw it. Within the limit it goes as it is (the server checks its type and says
            // so if it cannot take it); over the limit it cannot be sent at all.
            input.setCustomValidity('');
            if (file.size > maxBytes) { input.value = ''; setState('error'); } else setState('idle');
          }
        }}
      />
      {state === 'busy' && <p id={`${id}-note`} role="status" className="mt-1.5 text-sm text-muted">{preparing}</p>}
      {state === 'error' && <p id={`${id}-note`} role="alert" className="mt-1.5 text-sm text-bad">{tooLarge}</p>}
    </>
  );
}
