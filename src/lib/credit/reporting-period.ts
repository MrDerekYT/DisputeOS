/**
 * When a negative item generally stops being reportable, worked out from dates a credit report actually states.
 *
 * 15 U.S.C. § 1681c (FCRA § 605):
 *  - (a)(4), (a)(5): accounts placed for collection or charged to profit and loss, and other adverse items, may
 *    generally not be reported once they antedate the report by more than seven years.
 *  - (c)(1): for a collection or charge-off, the seven years begin "upon the expiration of the 180-day period
 *    beginning on the date of the commencement of the delinquency which immediately preceded the collection activity,
 *    charge to profit and loss, or similar action". So: date of first delinquency + 180 days, then + 7 years.
 *  - (a)(1): cases under title 11 (bankruptcy) may generally be reported for ten years. The statute counts from the
 *    order for relief or adjudication; for a petition the debtor files, that is the filing date, which is the date a
 *    report shows.
 *
 * This is date arithmetic on a reported date, not legal advice and not a prediction: the reported date may itself be
 * wrong, § 1681c(b) has exceptions (large credit, insurance and employment transactions), and nothing here says
 * anything about a credit score. The UI always says "generally" and never estimates a date that was not reported:
 * with no date of first delinquency the answer is "date not available".
 */
export const SEVEN_YEARS = 7;
export const BANKRUPTCY_YEARS = 10;
export const COLLECTION_LEAD_DAYS = 180;

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const parse = (iso: string): Date | null => {
  if (!ISO.test(iso)) return null;
  const d = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== iso ? null : d;
};
const fmt = (d: Date) => d.toISOString().slice(0, 10);

/** Calendar days added to a YYYY-MM-DD date (UTC, so daylight saving never shifts the day). Null if the input is not a real date. */
export function addDaysIso(iso: string, days: number): string | null {
  const d = parse(iso);
  if (!d) return null;
  d.setUTCDate(d.getUTCDate() + days);
  return fmt(d);
}

/**
 * Whole years added to a YYYY-MM-DD date. February 29 in a year without one becomes March 1 (the later of the two
 * possible readings, so an item is never shown as past its reporting period a day early).
 */
export function addYearsIso(iso: string, years: number): string | null {
  const d = parse(iso);
  if (!d) return null;
  const y = d.getUTCFullYear() + years;
  const out = new Date(Date.UTC(y, d.getUTCMonth(), d.getUTCDate())); // Feb 29 rolls over to Mar 1 by itself
  return fmt(out);
}

/** Whole months added; a day that does not exist in the target month rolls to the first of the next. */
export function addMonthsIso(iso: string, months: number): string | null {
  const d = parse(iso);
  if (!d) return null;
  const out = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1));
  const last = new Date(Date.UTC(out.getUTCFullYear(), out.getUTCMonth() + 1, 0)).getUTCDate();
  if (d.getUTCDate() > last) return fmt(new Date(Date.UTC(out.getUTCFullYear(), out.getUTCMonth() + 1, 1)));
  out.setUTCDate(d.getUTCDate());
  return fmt(out);
}

export interface ReportedItem {
  item_type: string; account_status: string | null; payment_status: string | null; payment_history?: string | null; date_of_first_delinquency: string | null;
}

const LATE = /\b(30|60|90|120|150|180)\b|late|delinq|charged?[\s_-]*off|collection|repo|foreclos|derog|past due/i;
const CHARGED_OFF = /charged?[\s_-]*off|charged to (profit|loss)|profit and loss|collection/i;

/** Words that say the opposite of late ("Open/Never late.", "Pays As Agreed", "Current"): removed before the late test. */
const NOT_LATE = /never\s+late|not\s+late|no\s+late\s+payments?|pays?\s+as\s+agreed|paid\s+as\s+agreed|current\s+account/gi;
/** Dates ("12/30/2023", "2023-12-30") are not late codes: their 30 must not read as "30 days late". */
const DATES = /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b|\b\d{4}-\d{2}-\d{2}\b/g;
/** In a payment history, a full date ("12/30/2023") or a year ("2030") is not a late code. "30/60/90" is left alone. */
const HISTORY_DATES = /\b\d{1,2}\/\d{1,2}\/\d{4}\b|\b\d{4}-\d{2}-\d{2}\b|\b(?:19|20)\d{2}\b/g;
/** The bureaus' letter codes for a collection, charge-off, repossession, foreclosure and voluntary surrender. */
const HISTORY_CODES = /\b(?:COL|CO|RPO|FC|VS|vs)\b|\b[Cc]\/[Oo]\b|\bC\.O\./;

/**
 * True when a payment history carries a late or derogatory code: days late ("30", "CC30CC", "120") or a bureau's
 * letter code (TransUnion's COL, c/o, RPO, FC and vs; CO for a charge-off). "CCCCCC", "OK OK" and a year are not.
 */
export function historyShowsLate(history: string | null | undefined): boolean {
  if (!history) return false;
  const h = history.replace(HISTORY_DATES, ' ');
  return /[3-9]0|120/.test(h) || HISTORY_CODES.test(h);
}

/** A reported item that carries negative information: a collection, a late / charged-off status, or late codes in the payment history. */
export const isNegative = (t: Pick<ReportedItem, 'item_type' | 'account_status' | 'payment_status' | 'payment_history'>): boolean =>
  t.item_type === 'collection' || LATE.test(`${t.payment_status ?? ''} ${t.account_status ?? ''}`.replace(NOT_LATE, ' ').replace(DATES, ' ')) || historyShowsLate(t.payment_history);

/** Placed for collection or charged off: the items § 1681c(c)(1) gives the 180-day lead to. */
export const isCollectionOrChargeOff = (t: Pick<ReportedItem, 'item_type' | 'account_status' | 'payment_status'>): boolean =>
  t.item_type === 'collection' || CHARGED_OFF.test(`${t.payment_status ?? ''} ${t.account_status ?? ''}`);

export type FallOffRule = 'seven_years' | 'seven_years_plus_180_days' | 'bankruptcy_ten_years';
export type FallOff =
  /** `from` is the reported date the arithmetic started at. */
  | { kind: 'date'; date: string; rule: FallOffRule; from: string }
  /** A negative item with no usable reported date. Shown as "date not available"; never estimated. */
  | { kind: 'not_available' };

export const FALL_OFF_RULE_TEXT: Record<FallOffRule, string> = {
  seven_years: '7 years from the reported date of first delinquency',
  seven_years_plus_180_days: '7 years, starting 180 days after the reported date of first delinquency',
  bankruptcy_ten_years: '10 years from the reported filing date',
};
/** Said wherever a 'seven_years' date is shown: what that date does not cover. */
export const LATE_ONLY_NOTE = 'This date is for the late-payment information from that date only. The account itself keeps being reported, and any later late payment runs its own 7 years.';

/**
 * Fall-off date for a reported account. Null when the item carries nothing negative (there is nothing to age off).
 * 15 U.S.C. § 1681c(a)(4), (a)(5), (c)(1): 7 years from the date of first delinquency; for a collection or a
 * charge-off the 7 years start 180 days after it.
 *
 * What the date covers depends on the rule. For a collection or a charge-off ('seven_years_plus_180_days') it is the
 * whole entry. For an account that is only late ('seven_years') it is the late-payment information from that date and
 * nothing more: § 1681c(a)(5) ages each adverse item from its own date, the account keeps being reported, and a later
 * late payment runs its own seven years. The UI words the two differently.
 */
export function tradelineFallOff(t: ReportedItem): FallOff | null {
  if (!isNegative(t)) return null;
  const from = t.date_of_first_delinquency;
  if (!from || !parse(from)) return { kind: 'not_available' };
  const lead = isCollectionOrChargeOff(t);
  const start = lead ? addDaysIso(from, COLLECTION_LEAD_DAYS)! : from;
  return { kind: 'date', date: addYearsIso(start, SEVEN_YEARS)!, rule: lead ? 'seven_years_plus_180_days' : 'seven_years', from };
}

/**
 * Fall-off date for a public record. Only bankruptcies are computed: 15 U.S.C. § 1681c(a)(1), 10 years (the statute
 * makes no chapter distinction; the agencies may by their own policy remove some chapters sooner, which is not
 * modelled). Judgments and tax liens depend on dates a report does not reliably state (entry, payment, the state's
 * limitation period), so they return null rather than a guess.
 */
export function publicRecordFallOff(r: { kind: string; filed_date: string | null }): FallOff | null {
  if (!/bankruptcy|\bchapter\s*(7|11|12|13)\b/i.test(r.kind)) return null;
  if (!r.filed_date || !parse(r.filed_date)) return { kind: 'not_available' };
  return { kind: 'date', date: addYearsIso(r.filed_date, BANKRUPTCY_YEARS)!, rule: 'bankruptcy_ten_years', from: r.filed_date };
}

/** True when the date falls from `today` up to and including the same day `months` later. */
export function withinMonths(date: string, today: string, months = 12): boolean {
  const end = addMonthsIso(today, months);
  return !!end && date >= today && date <= end;
}

export interface AgingOffSource { label: string; bureau: string; fallOff: FallOff | null }
export interface AgingOffItem { label: string; date: string; rule: FallOffRule; from: string; bureaus: string[] }

/** Items whose computed date falls within the next `months`, soonest first. The same item with the same date on several bureaus is one row. */
export function agingOffWithin(items: AgingOffSource[], today: string, months = 12): AgingOffItem[] {
  const out = new Map<string, AgingOffItem>();
  for (const i of items) {
    const f = i.fallOff;
    if (!f || f.kind !== 'date' || !withinMonths(f.date, today, months)) continue;
    const key = `${i.label.toLowerCase()}|${f.date}|${f.rule}`;
    const row = out.get(key) ?? { label: i.label, date: f.date, rule: f.rule, from: f.from, bureaus: [] };
    if (!row.bureaus.includes(i.bureau)) row.bureaus.push(i.bureau);
    out.set(key, row);
  }
  return [...out.values()].sort((a, b) => a.date.localeCompare(b.date) || a.label.localeCompare(b.label));
}
