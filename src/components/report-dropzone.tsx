'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import { AlertCircle, CheckCircle2, FileUp, Loader2 } from 'lucide-react';
import type { ActionState } from './forms';

type Row = { key: string; name: string; status: 'waiting' | 'reading' | 'done' | 'error'; note?: string; reportId?: string };
type UploadAction = (prev: ActionState, fd: FormData) => Promise<ActionState>;

/**
 * Drag-and-drop (or tap to pick) for several credit reports at once — e.g. the three PDFs from
 * AnnualCreditReport.com. Files go up one at a time, so each stays inside the host's request size limit, and each
 * row shows what was read from it. The size limit is checked here first, with the server's own number and message.
 */
export function ReportDropzone({ clientId, action, accept, maxBytes, tooLarge, hint }: {
  clientId: string; action: UploadAction; accept: string; maxBytes: number; tooLarge: string; hint: string;
}) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [rows, setRows] = useState<Row[]>([]);
  const allowed = accept.split(',').map((s) => s.trim().toLowerCase());

  const update = (key: string, patch: Partial<Row>) => setRows((r) => r.map((x) => (x.key === key ? { ...x, ...patch } : x)));

  async function upload(files: File[]) {
    if (!files.length || busy) return;
    const batch: (Row & { file: File })[] = files.map((file, i) => ({ key: `${Date.now()}-${i}`, name: file.name, status: 'waiting', file }));
    setRows((r) => [...batch.map(({ file: _f, ...row }) => row), ...r]);
    setBusy(true);
    for (const b of batch) {
      const ext = `.${b.file.name.split('.').pop()?.toLowerCase() ?? ''}`;
      if (!allowed.includes(ext)) { update(b.key, { status: 'error', note: `This file type can't be read here (${hint}).` }); continue; }
      if (b.file.size > maxBytes) { update(b.key, { status: 'error', note: tooLarge }); continue; }
      update(b.key, { status: 'reading' });
      const fd = new FormData();
      fd.set('clientId', clientId);
      fd.set('file', b.file);
      try {
        const res = await action(undefined, fd);
        if (res?.error) update(b.key, { status: 'error', note: res.error });
        else update(b.key, { status: 'done', note: res?.ok, reportId: res?.data?.reportId });
      } catch {
        update(b.key, { status: 'error', note: 'The upload did not finish. Check your connection and try again.' });
      }
    }
    setBusy(false);
    router.refresh();
  }

  return (
    <div className="space-y-3">
      <div
        role="button" tabIndex={0} aria-label="Upload credit reports: drop files here or press to choose"
        onClick={() => input.current?.click()}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.current?.click(); } }}
        onDragOver={(e) => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); void upload(Array.from(e.dataTransfer.files)); }}
        className={`flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-4 py-8 text-center transition-colors ${over ? 'border-brand bg-brand-soft' : 'border-line hover:border-brand/60 hover:bg-brand-soft/40'} ${busy ? 'pointer-events-none opacity-70' : ''}`}
      >
        {busy ? <Loader2 size={28} className="animate-spin text-brand" aria-hidden /> : <FileUp size={28} className="text-brand" aria-hidden />}
        <p className="font-medium">{busy ? 'Reading reports…' : 'Drop credit reports here'}</p>
        <p className="text-xs text-muted">or tap to choose · several at once · {hint}</p>
        <input
          ref={input} type="file" multiple accept={accept} className="sr-only" tabIndex={-1}
          onChange={(e) => { const f = Array.from(e.currentTarget.files ?? []); e.currentTarget.value = ''; void upload(f); }}
        />
      </div>
      {rows.length > 0 && (
        <ul className="divide-y divide-line/70 rounded-xl border border-line text-sm" aria-live="polite">
          {rows.map((r) => (
            <li key={r.key} className="flex items-start gap-3 px-3 py-2.5">
              <span className="mt-0.5 shrink-0">
                {r.status === 'done' ? <CheckCircle2 size={16} className="text-ok" aria-label="Imported" />
                  : r.status === 'error' ? <AlertCircle size={16} className="text-bad" aria-label="Not imported" />
                  : <Loader2 size={16} className={r.status === 'reading' ? 'animate-spin text-brand' : 'text-muted'} aria-label={r.status === 'reading' ? 'Reading' : 'Waiting'} />}
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{r.name}</div>
                {r.note && <div className={`text-xs ${r.status === 'error' ? 'text-bad' : 'text-muted'}`}>{r.note}</div>}
                {r.status === 'waiting' && <div className="text-xs text-muted">Waiting…</div>}
              </div>
              {r.reportId && <Link href={`/app/reports/${r.reportId}`} className="btn-ghost btn-sm shrink-0">Open</Link>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
