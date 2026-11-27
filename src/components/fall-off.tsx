import { FALL_OFF_RULE_TEXT, LATE_ONLY_NOTE, type FallOff } from '@/lib/credit/reporting-period';
import { cn, fmtDate } from '@/lib/util';

/**
 * One quiet line under a negative item: the date it generally stops being reportable (15 U.S.C. § 1681c), worked out
 * from the date the report states. For an account that is only late, the line is about the late-payment information
 * from that date, not the account. Renders nothing for an item with no negative information. When the report gives
 * no date to count from it says so; a date is never estimated. This is not a prediction about any credit score.
 */
/**
 * The same fact for one cell of a table whose row is labelled "Generally reportable until": the date alone, in red
 * with "date has passed" once it is behind us, and for an account that is only late a second line saying the date is
 * about the late payments from that date and not the account. A dash for an item with nothing negative.
 */
export function FallOffCell({ fallOff, today = new Date().toISOString().slice(0, 10) }: { fallOff: FallOff | null; today?: string }) {
  if (!fallOff) return <span className="font-normal text-faint">—</span>;
  if (fallOff.kind === 'not_available') return <span className="font-normal text-muted" title="The report gives no date of first delinquency to count from. A date is never estimated.">Date not reported</span>;
  const past = fallOff.date < today;
  return (
    <span className={past ? 'text-bad' : undefined} title={`Generally ${FALL_OFF_RULE_TEXT[fallOff.rule]} (15 U.S.C. § 1681c). Worked out from the date as reported. Confirm that date first.${fallOff.rule === 'seven_years' ? ` ${LATE_ONLY_NOTE}` : ''}`}>
      {fmtDate(fallOff.date)}
      {past && <span className="block text-xs font-medium">date has passed</span>}
      {fallOff.rule === 'seven_years' && <span className="block text-xs font-normal text-muted">late payments from {fmtDate(fallOff.from)} only</span>}
    </span>
  );
}

export function FallOffNote({ fallOff, missing = 'no date of first delinquency reported', className, today = new Date().toISOString().slice(0, 10) }: {
  fallOff: FallOff | null; missing?: string; className?: string;
  /** YYYY-MM-DD. A date before it has passed: the line then stands out, the same test the "old item" flag uses. */
  today?: string;
}) {
  if (!fallOff) return null;
  if (fallOff.kind === 'not_available') return <div className={cn('text-xs text-muted', className)}>Fall-off date not available <span className="text-faint">({missing})</span></div>;
  const past = fallOff.date < today;
  return (
    <div className={cn('text-xs', past ? 'font-medium text-bad' : 'text-muted', className)} title={`Generally ${FALL_OFF_RULE_TEXT[fallOff.rule]} (15 U.S.C. § 1681c). Worked out from the date as reported. Confirm that date first.${fallOff.rule === 'seven_years' ? ` ${LATE_ONLY_NOTE}` : ''}`}>
      {/* § 1681c(a)(5) ages each adverse item from its own date: an account that is only late does not stop being
          reported, and a later late payment runs its own 7 years. Only a collection, charge-off or bankruptcy goes whole. */}
      {fallOff.rule === 'seven_years' ? `Late-payment information from ${fmtDate(fallOff.from)} is generally reportable until ` : 'Generally reportable until '}
      <span className={cn('font-medium tabular-nums', !past && 'text-ink')}>{fmtDate(fallOff.date)}</span>
      {past && <span> · that date has passed</span>}
      <span className="sr-only">. Generally {FALL_OFF_RULE_TEXT[fallOff.rule]}, worked out from the date as reported.</span>
    </div>
  );
}
