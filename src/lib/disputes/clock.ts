/**
 * Every deadline the app computes for a dispute with a consumer reporting agency, in one pure module, each with the
 * section of 15 U.S.C. § 1681i (FCRA § 611) it comes from. Statute text: https://www.law.cornell.edu/uscode/text/15/1681i
 *
 * These are dates worked out from what staff recorded (receipt, completion, sent dates). They are not findings: a date
 * passing with nothing recorded can simply mean the response was not entered. Nothing here reads a clock unless `today`
 * is passed in, and nothing here is legal advice.
 *
 * Days are calendar days as 'YYYY-MM-DD' strings. A stored timestamp becomes a day in the zone the agency works in
 * (pass `tz`): a submission recorded at 8 p.m. Eastern is already "tomorrow" in UTC, and must not be shown a day late.
 */
import { dayInZone } from '../util';

export type Day = string;

const DAY_MS = 86_400_000;
const utc = (day: Day) => new Date(`${day}T00:00:00Z`);

/** The calendar day of a stored timestamp in `tz` (UTC when none is given), or a day string unchanged. */
export function toDay(v: string | Date, tz?: string): Day {
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  const d = typeof v === 'string' ? new Date(v) : v;
  return tz ? dayInZone(tz, d) : d.toISOString().slice(0, 10);
}

export function addDays(day: Day, n: number): Day {
  return new Date(utc(day).getTime() + n * DAY_MS).toISOString().slice(0, 10);
}

/** “Mar 3, 2026”, for the notes beside a date. */
export const sayDay = (day: Day) => utc(day).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

export const daysBetween = (from: Day, to: Day) => Math.round((utc(to).getTime() - utc(from).getTime()) / DAY_MS);

// ---------------------------------------------------------------- business days

/**
 * US federal legal public holidays, computed for any year from the rules of 5 U.S.C. § 6103(a), each on the day it is
 * observed: a holiday on a Saturday is observed the Friday before, one on a Sunday the Monday after (§ 6103(b) and
 * Executive Order 11582, as the U.S. Office of Personnel Management lists them:
 * https://www.opm.gov/policy-data-oversight/pay-leave/federal-holidays/). So a New Year's Day on a Saturday is observed
 * on December 31 of the year before, and counts in that year. The unit test compares the result with OPM's published
 * dates and with a second, independent reading of the rules. Inauguration Day (Washington, DC area only) is left out.
 *
 * The rules are today's. The two holidays added most recently count from their first year: Martin Luther King, Jr.'s
 * Birthday from 1986 and Juneteenth from 2021 (Pub. L. 117-17). Changes before 1986 (for example Veterans Day on a
 * Monday in October, 1971 to 1977) are not modelled: the app counts business days around recent dates only.
 *
 * § 1681i does not define "business day". Weekends and these holidays are skipped, which can only make a computed
 * deadline later, never earlier.
 */
const ymd = (y: number, m: number, d: number): Day => new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10);
const weekdayOf = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d)).getUTCDay();

/** The n-th `weekday` (0 = Sunday) of month `m` (1–12); n = -1 for the last one. */
function nthWeekday(y: number, m: number, weekday: number, n: number): Day {
  if (n > 0) return ymd(y, m, 1 + ((weekday - weekdayOf(y, m, 1) + 7) % 7) + (n - 1) * 7);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return ymd(y, m, last - ((weekdayOf(y, m, last) - weekday + 7) % 7));
}

/** A holiday on a fixed date, on the day it is observed: a Saturday moves to the Friday before, a Sunday to the Monday after. */
function observedDay(y: number, m: number, d: number): Day {
  const w = weekdayOf(y, m, d);
  return ymd(y, m, d + (w === 6 ? -1 : w === 0 ? 1 : 0));
}

/** The § 6103(a) holidays of year `y` on their observed days (a New Year's Day may move back into the year before). */
function holidaysOfYear(y: number): Day[] {
  return [
    observedDay(y, 1, 1), // New Year's Day
    ...(y >= 1986 ? [nthWeekday(y, 1, 1, 3)] : []), // Birthday of Martin Luther King, Jr.: third Monday in January
    nthWeekday(y, 2, 1, 3), // Washington's Birthday: third Monday in February
    nthWeekday(y, 5, 1, -1), // Memorial Day: last Monday in May
    ...(y >= 2021 ? [observedDay(y, 6, 19)] : []), // Juneteenth National Independence Day
    observedDay(y, 7, 4), // Independence Day
    nthWeekday(y, 9, 1, 1), // Labor Day: first Monday in September
    nthWeekday(y, 10, 1, 2), // Columbus Day: second Monday in October
    observedDay(y, 11, 11), // Veterans Day
    nthWeekday(y, 11, 4, 4), // Thanksgiving Day: fourth Thursday in November
    observedDay(y, 12, 25), // Christmas Day
  ];
}

/** Every federal holiday observed during calendar year `y`, in date order, including the next New Year's Day when it is observed on December 31. */
export function federalHolidays(y: number): Day[] {
  return [...new Set([...holidaysOfYear(y), ...holidaysOfYear(y + 1)])].filter((d) => d.startsWith(`${y}-`)).sort();
}

const OBSERVED = new Map<number, ReadonlySet<Day>>();
/** True on a day a federal holiday is observed, in any year. */
export function isFederalHoliday(day: Day): boolean {
  const y = Number(day.slice(0, 4));
  let days = OBSERVED.get(y);
  if (!days) OBSERVED.set(y, (days = new Set(federalHolidays(y))));
  return days.has(day);
}

export const isWeekend = (day: Day) => { const w = utc(day).getUTCDay(); return w === 0 || w === 6; };
export const isBusinessDay = (day: Day) => !isWeekend(day) && !isFederalHoliday(day);

/** The n-th business day after `day`. The starting day itself is never counted. */
export function addBusinessDays(day: Day, n: number): Day {
  let d = day;
  for (let left = n; left > 0;) {
    d = addDays(d, 1);
    if (isBusinessDay(d)) left--;
  }
  return d;
}

// ---------------------------------------------------------------- the deadlines

/**
 * § 1681i(a)(1)(A): the agency reinvestigates "before the end of the 30-day period beginning on the date on which the
 * agency receives the notice of the dispute". § 1681i(a)(1)(B): that period "may be extended for not more than 15
 * additional days" when the agency receives information from the consumer during the 30 days that is relevant to the
 * reinvestigation, so 45 days is the latest it can run. ((a)(1)(C): the extension does not apply if, during the 30
 * days, the information is found to be inaccurate, incomplete or unverifiable.)
 *
 * The 45-day period also applies to a dispute that follows a free annual report obtained through the central source
 * (§ 1681j(a)(3)). The app cannot know that, so it stays a manual tick when the submission is recorded.
 */
export const REINVESTIGATION_DAYS = { standard: 30, extended: 45 } as const;
export const reinvestigationDays = (extended: boolean | null | undefined) => (extended ? REINVESTIGATION_DAYS.extended : REINVESTIGATION_DAYS.standard);
export const reinvestigationDue = (receivedOn: Day, extended: boolean | null | undefined): Day => addDays(receivedOn, reinvestigationDays(extended));

/**
 * § 1681i(a)(1)(B): only information the agency receives "during that 30-day period" extends it. The day staff record
 * is the day the client sent it, so it has to fall inside the 30 days that began at receipt of the dispute.
 */
export const withinOriginalPeriod = (receivedOn: Day, day: Day) => day >= receivedOn && day <= addDays(receivedOn, REINVESTIGATION_DAYS.standard);

/** § 1681i(a)(6)(A): written notice of the results "not later than 5 business days after the completion of the reinvestigation". */
export const RESULTS_NOTICE_BUSINESS_DAYS = 5;
export const resultsNoticeDue = (completedOn: Day): Day => addBusinessDays(completedOn, RESULTS_NOTICE_BUSINESS_DAYS);

/**
 * The first day the app says "no response recorded". Not the day after the reinvestigation period ends: the agency
 * may finish on the last day of it, then has 5 business days to send written results (§ 1681i(a)(6)(A)), and the mail
 * takes time. So: the end of the period + 5 business days + an allowance of 7 calendar days for the mail. The allowance
 * is this app's own margin, not a statutory figure. A response can still be in transit after it.
 */
export const MAIL_ALLOWANCE_DAYS = 7;
export const noResponseAfter = (periodEndsOn: Day): Day => addDays(addBusinessDays(periodEndsOn, RESULTS_NOTICE_BUSINESS_DAYS), MAIL_ALLOWANCE_DAYS);

/**
 * § 1681i(a)(7): the description of the reinvestigation procedure (§ 1681i(a)(6)(B)(iii)) is due "by not later than 15
 * days after receiving a request from the consumer for that description". Calendar days, counted from the agency's
 * receipt of the request.
 */
export const PROCEDURE_DESCRIPTION_DAYS = 15;
export const procedureDescriptionDue = (requestReceivedOn: Day): Day => addDays(requestReceivedOn, PROCEDURE_DESCRIPTION_DAYS);

// ---------------------------------------------------------------- one dispute's clock

export interface ClockInput {
  /** disputes.due_at: receipt + 30 days, or + 45 when extended. Null before the dispute is submitted. */
  dueAt: string | null;
  extended: boolean;
  /** The day the client sent more information, when that is what extended the period. */
  moreInfoOn: Day | null;
  /** The day the agency completed its reinvestigation, as its results state. */
  completedOn: Day | null;
  /** The day the response reached the client or the agency's office, as recorded. */
  responseOn: Day | null;
  /** The request for the description of the procedure, once its letter has been recorded as sent. */
  procedure?: { sentOn: Day | null; receivedOn: Day | null; replyDueOn: Day | null; replyReceivedOn: Day | null } | null;
  /** The zone the agency works in: stored timestamps are read as days there. */
  tz?: string;
}

export interface ClockRow {
  key: 'received' | 'reinvestigation' | 'results' | 'procedure';
  label: string;
  /** The governing section, shown beside the date. */
  cite: string;
  date: Day;
  /** 'done' = the thing it waits for is recorded; 'passed' = the date has gone by with nothing recorded; 'ahead' otherwise. */
  state: 'done' | 'ahead' | 'passed' | 'fact';
  note: string;
}

/** The recorded receipt date: the stored deadline minus its 30 (or 45) days. */
export const receivedDay = (dueAt: string, extended: boolean, tz?: string): Day => addDays(toDay(dueAt, tz), -reinvestigationDays(extended));

/** The rows of the "legal clock" for a dispute sent to a consumer reporting agency. Empty before it is submitted. */
export function disputeClock(i: ClockInput, today: Day): ClockRow[] {
  if (!i.dueAt) return [];
  const due = toDay(i.dueAt, i.tz);
  const received = receivedDay(i.dueAt, i.extended, i.tz);
  // 45 days because the client sent more information: § 1681i(a)(1)(B). 45 days ticked at submission (a dispute that
  // follows a free annual report): § 1681j(a)(3), a different section.
  const cite = !i.extended ? '§ 1681i(a)(1)(A)' : i.moreInfoOn ? '§ 1681i(a)(1)(B)' : '§ 1681j(a)(3)';
  const answered = !!i.responseOn;
  const rows: ClockRow[] = [
    { key: 'received', label: 'Dispute received by the agency', cite: '§ 1681i(a)(1)(A)', date: received, state: 'fact', note: 'As recorded when the submission was entered. Every date below is counted from it.' },
    {
      key: 'reinvestigation', label: `Reinvestigation period ends (${reinvestigationDays(i.extended)} days)`, cite, date: due,
      state: answered ? 'done' : due < today ? 'passed' : 'ahead',
      note: !i.extended ? '30 days from receipt.'
        : i.moreInfoOn ? `Extended from 30 days: the client sent more information on ${sayDay(i.moreInfoOn)}. The agency may take up to 15 more days, so this is the latest date.`
          : '45 days from receipt. The 45-day period was ticked when the submission was recorded, as for a dispute that follows a free annual report.',
    },
  ];
  if (i.completedOn) {
    const d = resultsNoticeDue(i.completedOn);
    rows.push({
      key: 'results', label: 'Written results due', cite: '§ 1681i(a)(6)(A)', date: d, state: answered ? 'done' : d < today ? 'passed' : 'ahead',
      note: `5 business days after the agency completed its reinvestigation on ${sayDay(i.completedOn)}.`,
    });
  }
  const p = i.procedure;
  if (p?.sentOn) {
    const d = p.replyDueOn ?? procedureDescriptionDue(p.receivedOn ?? p.sentOn);
    rows.push({
      key: 'procedure', label: 'Description of the reinvestigation procedure due', cite: '§ 1681i(a)(7)', date: d, state: p.replyReceivedOn ? 'done' : d < today ? 'passed' : 'ahead',
      note: p.receivedOn ? `15 days after the agency received the request on ${sayDay(p.receivedOn)}.` : `15 days, counted from the day the request was sent (${sayDay(p.sentOn)}). The period generally runs from the day the agency receives it; record that date to count from it.`,
    });
  }
  return rows;
}
