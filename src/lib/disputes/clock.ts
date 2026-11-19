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
 * US federal legal public holidays (5 U.S.C. § 6103), on the day they are observed: a holiday on a Saturday is observed
 * the Friday before, one on a Sunday the Monday after. Source: U.S. Office of Personnel Management, "Federal Holidays",
 * https://www.opm.gov/policy-data-oversight/pay-leave/federal-holidays/ — the unit test rebuilds every date from the
 * statutory rules and compares. Inauguration Day (Washington, DC area only) is left out.
 *
 * § 1681i does not define "business day". Weekends and these holidays are skipped, which can only make a computed
 * deadline later, never earlier.
 */
export const FEDERAL_HOLIDAYS: Record<number, Day[]> = {
  2025: ['2025-01-01', '2025-01-20', '2025-02-17', '2025-05-26', '2025-06-19', '2025-07-04', '2025-09-01', '2025-10-13', '2025-11-11', '2025-11-27', '2025-12-25'],
  2026: ['2026-01-01', '2026-01-19', '2026-02-16', '2026-05-25', '2026-06-19', '2026-07-03', '2026-09-07', '2026-10-12', '2026-11-11', '2026-11-26', '2026-12-25'],
  2027: ['2027-01-01', '2027-01-18', '2027-02-15', '2027-05-31', '2027-06-18', '2027-07-05', '2027-09-06', '2027-10-11', '2027-11-11', '2027-11-25', '2027-12-24', '2027-12-31'],
  2028: ['2028-01-17', '2028-02-21', '2028-05-29', '2028-06-19', '2028-07-04', '2028-09-04', '2028-10-09', '2028-11-10', '2028-11-23', '2028-12-25'],
  2029: ['2029-01-01', '2029-01-15', '2029-02-19', '2029-05-28', '2029-06-19', '2029-07-04', '2029-09-03', '2029-10-08', '2029-11-12', '2029-11-22', '2029-12-25'],
  2030: ['2030-01-01', '2030-01-21', '2030-02-18', '2030-05-27', '2030-06-19', '2030-07-04', '2030-09-02', '2030-10-14', '2030-11-11', '2030-11-28', '2030-12-25'],
};
/** The last year the table covers. After it only weekends are skipped, and holidayTableCovers() says so. */
export const HOLIDAYS_THROUGH = 2030;
const HOLIDAY_SET = new Set(Object.values(FEDERAL_HOLIDAYS).flat());

export const isWeekend = (day: Day) => { const w = utc(day).getUTCDay(); return w === 0 || w === 6; };
export const isFederalHoliday = (day: Day) => HOLIDAY_SET.has(day);
export const isBusinessDay = (day: Day) => !isWeekend(day) && !isFederalHoliday(day);
/** False when a date falls after the holiday table ends, so the caller can say holidays were not counted. */
export const holidayTableCovers = (day: Day) => Number(day.slice(0, 4)) <= HOLIDAYS_THROUGH;

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
      note: `5 business days after the agency completed its reinvestigation on ${sayDay(i.completedOn)}${holidayTableCovers(d) ? '' : ` (federal holidays after ${HOLIDAYS_THROUGH} are not counted)`}.`,
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
