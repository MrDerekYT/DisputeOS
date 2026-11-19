import type { Metadata } from 'next';
import Link from 'next/link';
import { Download, FileText } from 'lucide-react';
import { PortalTitle } from '@/components/portal-kit';
import { EmptyState } from '@/components/ui';
import { portalContext } from '@/lib/portal';
import { fmtDate } from '@/lib/util';

export const metadata: Metadata = { title: 'Letters' };

export default async function PortalLetters() {
  const { ctx, t, lang } = await portalContext();
  const rows = await ctx.tx((db) => db.rows<{ id: string; title: string; status: string; approved_at: string | null; sent_at: string | null; sent_on: string | null; delivery_source: string }>('select id, title, status, approved_at, sent_at, sent_on, delivery_source from public.letters order by created_at desc'));
  return (
    <div className="max-w-3xl space-y-6">
      <PortalTitle>{t('letters')}</PortalTitle>
      {rows.length === 0 ? <EmptyState title={t('noLetters')} icon={<FileText size={20} />} action={<Link href="/portal/messages" className="btn-primary">{t('messageTeam')}</Link>} /> : (
        <ul className="card divide-y divide-line/70">{rows.map((l) => (
          <li key={l.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3 p-4 sm:px-5">
            <div className="flex min-w-0 flex-1 basis-[14rem] items-start gap-3">
              <span aria-hidden className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-raised text-muted"><FileText size={18} /></span>
              <div className="min-w-0"><div className="text-[0.9375rem] font-semibold [overflow-wrap:anywhere]">{l.title}</div><div className="mt-0.5 text-[0.8125rem] text-muted">{l.status === 'sent' ? `${l.sent_on ?? l.sent_at ? `${t('sentOn')} ${fmtDate(l.sent_on ?? l.sent_at, lang)}` : t('sentNoDate')} · ${l.delivery_source === 'carrier_confirmed' ? t('byCarrier') : t('byStaff')}` : l.approved_at ? fmtDate(l.approved_at, lang) : null}</div></div>
            </div>
            <a className="btn-quiet btn-sm" href={`/api/letters/${l.id}/pdf`}><Download size={14} aria-hidden /> {t('download')}</a>
          </li>))}</ul>)}
    </div>
  );
}
