import { FALL_OFF_RULE_TEXT, LATE_ONLY_NOTE, type FallOff } from '@/lib/credit/reporting-period';
import { cn, fmtDate } from '@/lib/util';

/**
 * One quiet line under a negative item: the date it generally stops being reportable (15 U.S.C. § 1681c), worked out
 * from the date the report states. For an account that is only late, the line is about the late-payment information
 * from that date, not the account. Renders nothing for an item with no negative information. When the report gives
 * no date to count from it says so; a date is never estimated. This is not a prediction about any credit score.
 */
export function FallOffNote({ fallOff, missing = 'no date of first delinquency reported', className }: { fallOff: FallOff | null; missing?: string; className?: string }) {
  if (!fallOff) return null;
  if (fallOff.kind === 'not_available') return <div className={cn('text-xs text-muted', className)}>Fall-off date not available <span className="text-faint">({missing})</span></div>;
  return (
    <div className={cn('text-xs text-muted', className)} title={`Generally ${FALL_OFF_RULE_TEXT[fallOff.rule]} (15 U.S.C. § 1681c). Worked out from the date as reported. Confirm that date first.${fallOff.rule === 'seven_years' ? ` ${LATE_ONLY_NOTE}` : ''}`}>
      {/* § 1681c(a)(5) ages each adverse item from its own date: an account that is only late does not stop being
          reported, and a later late payment runs its own 7 years. Only a collection, charge-off or bankruptcy goes whole. */}
      {fallOff.rule === 'seven_years' ? `Late-payment information from ${fmtDate(fallOff.from)} is generally reportable until ` : 'Generally reportable until '}
      <span className="font-medium tabular-nums text-ink">{fmtDate(fallOff.date)}</span>
      <span className="sr-only">. Generally {FALL_OFF_RULE_TEXT[fallOff.rule]}, worked out from the date as reported.</span>
    </div>
  );
}
