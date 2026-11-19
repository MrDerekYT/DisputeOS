import { Section } from '@/components/ui';
import type { Ctx } from '@/lib/auth/context';
import { loadAgingOff } from '@/lib/credit/aging-off-load';
import { FALL_OFF_RULE_TEXT } from '@/lib/credit/reporting-period';
import { businessToday } from '@/lib/letters/service';
import { fmtDate } from '@/lib/util';

/**
 * Negative items on the latest approved reports whose reporting period generally ends in the next 12 months
 * (15 U.S.C. § 1681c). Dates are arithmetic on what each bureau reports. Nothing here predicts a credit score or an
 * outcome, and the block is hidden when there is nothing to list.
 */
export async function AgingOffBlock({ ctx, clientId }: { ctx: Ctx; clientId: string }) {
  const items = await ctx.tx((db) => loadAgingOff(db, clientId, businessToday()));
  if (!items.length) return null;
  return (
    <Section plain id="aging-off" title="Aging off within 12 months"
      hint="When each item generally stops being reportable, worked out from the dates the bureaus report. For an account that is only late, the date covers that late-payment information, not the account. Confirm the reported date before relying on it. This says nothing about a credit score.">
      <ul className="divide-y divide-line/70 text-sm">
        {items.map((i) => (
          <li key={`${i.label}|${i.date}|${i.rule}`} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 py-2.5 first:pt-0 last:pb-0">
            <span className="min-w-0"><span className="font-medium [overflow-wrap:anywhere]">{i.label}</span> <span className="text-[0.8125rem] text-muted">· {i.bureaus.join(', ')}{i.rule === 'seven_years' ? ` · late-payment information from ${fmtDate(i.from)} only, not the account` : ''}</span></span>
            <span className="text-[0.8125rem] text-muted" title={`Generally ${FALL_OFF_RULE_TEXT[i.rule]} (15 U.S.C. § 1681c).`}>generally until <span className="font-medium tabular-nums text-ink">{fmtDate(i.date)}</span></span>
          </li>
        ))}
      </ul>
    </Section>
  );
}
