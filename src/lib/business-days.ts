/**
 * Business-day arithmetic for the whole app: one holiday rule, one definition of a business day.
 *
 * The US federal holidays (5 U.S.C. § 6103, each on the day it is observed, computed by rule for any year) and the
 * counting helpers live in src/lib/disputes/clock.ts, where they were first needed and where the unit test checks the
 * rule against OPM's published dates. They are re-exported here so code outside the dispute clock does not import from
 * it, and so there is never a second holiday list to keep in step.
 */
import { addBusinessDays, type Day } from './disputes/clock';

export { addBusinessDays, addDays, daysBetween, federalHolidays, isBusinessDay, isFederalHoliday, isWeekend, sayDay, toDay, type Day } from './disputes/clock';

/**
 * CROA § 407(a) (15 U.S.C. § 1679e(a)): a consumer may cancel a contract with a credit repair organization "at any
 * time before midnight of the 3rd business day which begins after the date on which the contract or agreement … is
 * executed". The statute does not define "business day"; weekends and federal holidays are skipped here, which can
 * only make the period longer, never shorter. Some states set a longer period: the agency confirms its own.
 */
export const CANCELLATION_BUSINESS_DAYS = 3;

/** The last day on which the client can still cancel (the period ends at midnight at the end of this day). */
export const cancellationEndsOn = (signedOn: Day): Day => addBusinessDays(signedOn, CANCELLATION_BUSINESS_DAYS);

/** The first and last day of a calendar month given as YYYY-MM. */
export function monthRange(month: string): { from: Day; to: Day } {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return { from: `${month}-01`, to: new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10) };
}

export const isMonth = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(v);

/** The months from `first` back from `last`, newest first, at most `max` of them (both as YYYY-MM). */
export function monthsBack(last: string, first: string, max = 24): string[] {
  const out: string[] = [];
  let [y, m] = last.split('-').map(Number) as [number, number];
  while (out.length < max) {
    const cur = `${y}-${String(m).padStart(2, '0')}`;
    if (cur < first) break;
    out.push(cur);
    m -= 1;
    if (m === 0) { m = 12; y -= 1; }
  }
  return out;
}
