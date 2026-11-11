import type { Metadata } from 'next';
import { FileText } from 'lucide-react';
import { EmptyState } from '@/components/ui';
import { portalContext } from '@/lib/portal';
import { fmtDate } from '@/lib/util';

export const metadata: Metadata = { title: 'Letters' };

export default async function PortalLetters() {
  const { ctx, t, lang } = await portalContext();
  const rows = await ctx.tx((db) => db.rows<{ id: string; title: string; status: string; approved_at: string | null; sent_at: string | null }>('select id, title, status, approved_at, sent_at from public.letters order by created_at desc'));
  return (
    <div className="space-y-5">
      <h1 className="font-display text-3xl font-semibold">{t('letters')}</h1>
      {rows.length === 0 ? <EmptyState title={t('noLetters')} /> : (
        <ul className="card divide-y divide-line">{rows.map((l) => (
          <li key={l.id} className="flex flex-wrap items-center justify-between gap-3 p-4"><div className="flex min-w-0 items-center gap-3"><FileText size={18} className="shrink-0 text-muted" /><div className="min-w-0"><div className="truncate font-medium">{l.title}</div><div className="text-xs text-muted">{fmtDate(l.sent_at ?? l.approved_at, lang)}</div></div></div><a className="btn-secondary btn-sm" href={`/api/letters/${l.id}/pdf`}>{t('download')}</a></li>))}</ul>)}
    </div>
  );
}
