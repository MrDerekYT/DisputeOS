/**
 * The debt collector validation period: date arithmetic only, on dates staff entered. Pure, no clock unless `today`
 * is passed in, and not legal advice.
 *
 * This is the Fair Debt Collection Practices Act (15 U.S.C. § 1692g) as implemented by Regulation F, and it is a
 * DIFFERENT clock from a credit-report dispute (FCRA, 15 U.S.C. § 1681i): different law, different deadline,
 * different recipient (the collector, not a bureau). Nothing here reads or writes a dispute.
 *
 * 12 CFR 1006.34(b)(5) (text checked at ecfr.gov, November 2026): "Validation period means the period starting on the
 * date that a debt collector provides the validation information ... and ending 30 days after the consumer receives
 * or is assumed to receive the validation information. For purposes of determining the end of the validation period,
 * the debt collector may assume that a consumer receives the validation information on any date that is at least
 * five days (excluding legal public holidays identified in 5 U.S.C. 6103(a), Saturdays, and Sundays) after the debt
 * collector provides it."
 *
 * 12 CFR 1006.38(c), (d)(2): on receiving a dispute, or a request for the original creditor's name and address,
 * "submitted by the consumer in writing within the validation period", the collector must cease collection of the
 * debt until it sends verification (or a copy of a judgment), or the original creditor's name and address.
 * 12 CFR 1006.38(d)(1): not disputing "does not constitute a legal admission of liability by the consumer".
 */
import { addDays, daysBetween, isFederalHoliday, isWeekend, type Day } from '../business-days';

export const VALIDATION_PERIOD_DAYS = 30;
export const PRESUMED_RECEIPT_DAYS = 5;

/**
 * The shared holiday rule (federalHolidays in src/lib/disputes/clock.ts, computed for any year) gives each holiday on
 * the day it is OBSERVED (a Saturday holiday on the Friday before, a Sunday holiday on the Monday after). § 1006.34(b)(5) excludes the holidays "identified in 5 U.S.C. 6103(a)", which
 * names the holidays themselves, plus Saturdays and Sundays. So an observed-only Friday or Monday is counted here.
 * That can only make the presumed receipt, and so the end of the period, earlier: the cautious reading for a consumer.
 * Only the fixed-date holidays ever move (Jan 1, Jun 19, Jul 4, Nov 11, Dec 25); these are the days they move to.
 */
const OBSERVED_ONLY = new Set(['12-31', '01-02', '06-18', '06-20', '07-03', '07-05', '11-10', '11-12', '12-24', '12-26']);
const isHolidayItself = (day: Day) => isFederalHoliday(day) && !OBSERVED_ONLY.has(day.slice(5));

/** A day § 1006.34(b)(5) does not count: a Saturday, a Sunday, or a legal public holiday on its own date. */
export const isExcludedDay = (day: Day) => isWeekend(day) || isHolidayItself(day);

/** The earliest day a collector may assume the notice was received: the 5th counted day after it was sent. */
export function presumedReceipt(sentOn: Day): Day {
  let d = sentOn;
  for (let left = PRESUMED_RECEIPT_DAYS; left > 0;) {
    d = addDays(d, 1);
    if (!isExcludedDay(d)) left--;
  }
  return d;
}

export type NoticeDateKind = 'received' | 'sent';

export interface ValidationPeriod {
  /** The day the period is counted from: the day the client received the notice, or the presumed day. */
  receivedOn: Day;
  /** True when only the sent date is known, so `receivedOn` is the earliest day the collector may assume. */
  presumed: boolean;
  /** The last day of the 30-day period. */
  endsOn: Day;
  /** Whole days from `today` to `endsOn`; 0 on the last day, negative once it has passed. */
  daysLeft: number;
  open: boolean;
}

export function validationPeriod(notice: { kind: NoticeDateKind; date: Day }, today: Day): ValidationPeriod {
  const presumed = notice.kind === 'sent';
  const receivedOn = presumed ? presumedReceipt(notice.date) : notice.date;
  const endsOn = addDays(receivedOn, VALIDATION_PERIOD_DAYS);
  const daysLeft = daysBetween(today, endsOn);
  return { receivedOn, presumed, endsOn, daysLeft, open: daysLeft >= 0 };
}

/**
 * What the end of the period generally means. Shown to staff once the date has passed. General information, not advice.
 * § 1006.38(c), (d)(2) turn on a request "submitted by the consumer in writing within the validation period": what
 * counts is when the consumer sends it, not when the collector receives it.
 */
export const AFTER_PERIOD_NOTE =
  'The 30-day window for the validation request has passed. A collector is generally required to pause collection and send verification only when the consumer sends the written request within that window (12 CFR 1006.38). '
  + 'A request can still be sent later, but the collector is generally not required to answer it in the same way. Not having disputed in time is not an admission that the debt is owed (12 CFR 1006.38(d)(1)), '
  + 'and the right to dispute how the account appears on a credit report is separate and has its own rules. For advice about a specific debt, the client can speak with an attorney.';
