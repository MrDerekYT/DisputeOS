import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { PortalTitle } from '@/components/portal-kit';
import { PrintButton } from '@/components/print-button';
import { MonthPicker, monthLabel, WorkStatementView } from '@/components/work-statement';
import { loadStatement } from '@/lib/billing/records';
import { isMonth, monthsBack } from '@/lib/business-days';
import { getEnv } from '@/lib/env';
import { businessToday } from '@/lib/letters/service';
import { portalContext } from '@/lib/portal';
import { dayInZone } from '@/lib/util';

export const metadata: Metadata = { title: 'What we did for you' };

/**
 * "What we did for you", month by month: the client's own copy of the work statement. Read under the client's own
 * row-level security, so it can only ever show their record. Facts and dates; no promise about any outcome.
 */
export default async function PortalStatement({ searchParams }: { searchParams: Promise<{ period?: string }> }) {
  const sp = await searchParams;
  const { ctx, t, lang } = await portalContext();
  const tz = getEnv().APP_TIMEZONE;
  const thisMonth = businessToday().slice(0, 7);
  const month = isMonth(sp.period) && sp.period <= thisMonth ? sp.period : thisMonth;
  const d = await ctx.tx(async (db) => ({
    since: (await db.row<{ created_at: string }>('select created_at from public.clients where id = $1', [ctx.clientId]))!.created_at,
    s: (await loadStatement(db, ctx.clientId, month, tz))!,
  }));
  const months = monthsBack(thisMonth, dayInZone(tz, new Date(d.since)).slice(0, 7));
  return (
    <div className="max-w-3xl space-y-6">
      <Link href="/portal" className="no-print inline-flex items-center gap-1 text-[0.8125rem] font-medium text-muted hover:text-ink"><ArrowLeft size={14} aria-hidden /> {t('home')}</Link>
      <PortalTitle sub={t('ws_sub')}>{t('ws_title')}</PortalTitle>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <MonthPicker months={months.includes(month) ? months : [month, ...months]} month={month} lang={lang} label={t('ws_month')} show={t('ws_show')} />
        <PrintButton>{t('ws_print')}</PrintButton>
      </div>
      <h2 className="display text-[1.375rem] first-letter:uppercase">{monthLabel(month, lang)}</h2>
      <WorkStatementView s={d.s} lang={lang} />
    </div>
  );
}
