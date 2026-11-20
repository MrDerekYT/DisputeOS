import { PortalBlock } from '@/components/portal-kit';
import { Badge } from '@/components/ui';
import type { Ctx } from '@/lib/auth/context';
import { loadCollectorNotices } from '@/lib/credit/case-tools';
import { fill, type Lang, type PortalKey } from '@/lib/portal-i18n';
import { fmtDate } from '@/lib/util';

/**
 * The client's own collector notices, as staff recorded them: the date and when the 30-day validation period
 * generally ends (12 CFR 1006.34(b)(5)), with a plain explanation. Shown only when there is one. This is the FDCPA
 * deadline for writing to a collector, kept apart from the credit-report dispute dates elsewhere on the page.
 */
export async function CollectorNotices({ ctx, clientId, t, lang, className }: { ctx: Ctx; clientId: string; t: (k: PortalKey) => string; lang: Lang; className?: string }) {
  const notices = await ctx.tx((db) => loadCollectorNotices(db, clientId));
  if (!notices.length) return null;
  const day = (d: string) => fmtDate(d, lang);
  return (
    <PortalBlock id="collector-notices" title={t('cn_title')} hint={t('cn_intro')} className={className}>
      <ul className="divide-y divide-line">
        {notices.map((n) => (
          <li key={n.id} className="py-3 text-[0.9375rem]">
            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5">
              <span className="font-medium [overflow-wrap:anywhere]">{n.collectorName}</span>
              <Badge tone={n.period.open ? 'info' : 'neutral'}>{fill(t(n.period.open ? 'cn_ends' : 'cn_ended'), { date: day(n.period.endsOn) })}</Badge>
            </div>
            <p className="mt-1 text-[0.8125rem] text-muted">
              {n.period.presumed ? fill(t('cn_sent'), { date: day(n.date), received: day(n.period.receivedOn) }) : fill(t('cn_received'), { date: day(n.date) })}
              {n.period.open && <> · {n.period.daysLeft === 0 ? t('cn_lastDay') : fill(t('cn_left'), { n: n.period.daysLeft })}</>}
            </p>
          </li>
        ))}
      </ul>
      {notices.some((n) => n.period.open) && <p className="mt-3 text-sm text-muted">{t('cn_open')}</p>}
      {notices.some((n) => !n.period.open) && <p className="mt-3 text-sm text-muted">{t('cn_closed')}</p>}
    </PortalBlock>
  );
}
