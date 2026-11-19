/**
 * Date arithmetic for the "investigation window" meter (DayMeter in src/components/ui.tsx).
 *
 * A dispute's window opens when the recipient receives it and closes at its response deadline. The deadline is stored
 * (disputes.due_at = receipt + 30 days, or 45 when extended), so the opening is worked back from it with windowStart().
 * dayWindow() turns a start, a deadline and "now" into day counts and bar proportions. It uses the same rules as src/lib/disputes/workflow.ts,
 * so the meter can never disagree with the overdue counts, filters and badges:
 *   - overdue the moment the deadline passes (due < now);
 *   - days left   = ceil((due − now) / 1 day);
 *   - days overdue = ceil((now − due) / 1 day), never less than 1 once it has passed.
 * Pure: no clock is read here unless `now` is left out.
 */
const DAY = 86_400_000;
type When = string | Date | null | undefined;
const ms = (v: When): number | null => {
  if (v == null || v === '') return null;
  const t = (typeof v === 'string' ? new Date(v) : v).getTime();
  return Number.isFinite(t) ? t : null;
};

/** Length of an investigation window in days: the same numbers responseDueDate() adds in src/lib/disputes/workflow.ts. */
export const WINDOW_DAYS = { standard: 30, extended: 45 } as const;

/**
 * The moment a window opened: the deadline minus its length. due_at is always "receipt + 30 days" (45 when the
 * dispute's deadline was extended), so this is the recorded receipt date — not the day the letter was mailed.
 * Measuring from the mailing date instead would draw windows of 33 or 35 days whenever the two dates differ.
 * Null when there is no deadline yet.
 */
export function windowStart(dueAt: When, extended: boolean | null | undefined): Date | null {
  const due = ms(dueAt);
  return due == null ? null : new Date(due - (extended ? WINDOW_DAYS.extended : WINDOW_DAYS.standard) * DAY);
}

export type WindowState =
  /** No deadline is recorded: the dispute has not been submitted yet, so there is no window to draw. */
  | 'pending'
  /** Submitted and inside the window. */
  | 'open'
  /** The deadline has passed. */
  | 'overdue';

export interface DayWindow {
  state: WindowState;
  /** Length of the window in whole days (30 or 45 when the start comes from windowStart()); null when no start is given. */
  totalDays: number | null;
  /** Whole days since the window opened ("Day 12 of 30"). Runs past totalDays when overdue ("Day 36 of 30"). Null without a start. */
  day: number | null;
  /** Days until the deadline; 0 when overdue or pending. */
  daysLeft: number;
  /** Days past the deadline; 0 unless overdue. */
  daysOverdue: number;
  /** Bar shares, each 0–100 and summing to 100 (all 0 when pending): elapsed inside the window, still to come, past the deadline. */
  elapsedPct: number;
  leftPct: number;
  overPct: number;
}

const PENDING: DayWindow = { state: 'pending', totalDays: null, day: null, daysLeft: 0, daysOverdue: 0, elapsedPct: 0, leftPct: 0, overPct: 0 };
const pct = (part: number, whole: number) => Math.round((part / whole) * 10_000) / 100;

/** `startAt` is when the window opened — pass windowStart(dueAt, deadline_extended) for a dispute. */
export function dayWindow(startAt: When, dueAt: When, now: Date = new Date()): DayWindow {
  const due = ms(dueAt);
  if (due == null) return PENDING;
  const start = ms(startAt);
  const t = now.getTime();
  // A start on or after the deadline is bad data; treat the length as unknown rather than draw a made-up bar.
  const totalDays = start != null && start < due ? Math.max(1, Math.round((due - start) / DAY)) : null;

  if (due < t) {
    const daysOverdue = Math.max(1, Math.ceil((t - due) / DAY));
    if (totalDays == null) return { state: 'overdue', totalDays: null, day: null, daysLeft: 0, daysOverdue, elapsedPct: 0, leftPct: 0, overPct: 100 };
    const whole = totalDays + daysOverdue;
    const elapsedPct = pct(totalDays, whole);
    return { state: 'overdue', totalDays, day: whole, daysLeft: 0, daysOverdue, elapsedPct, leftPct: 0, overPct: Math.round((100 - elapsedPct) * 100) / 100 };
  }

  const daysLeft = Math.ceil((due - t) / DAY);
  if (totalDays == null) return { state: 'open', totalDays: null, day: null, daysLeft, daysOverdue: 0, elapsedPct: 0, leftPct: 100, overPct: 0 };
  // Before the recorded submission time (clock skew, a future-dated entry) nothing has elapsed yet.
  const day = Math.min(totalDays, Math.max(0, totalDays - daysLeft));
  const elapsedPct = pct(day, totalDays);
  return { state: 'open', totalDays, day, daysLeft, daysOverdue: 0, elapsedPct, leftPct: Math.round((100 - elapsedPct) * 100) / 100, overPct: 0 };
}

export interface WindowText {
  /** "Day 12 of 30" — empty when the submission date is not recorded or the window is pending. */
  count: string;
  /** "18 days left", "Due today", "6 days overdue", "Not submitted yet". */
  status: string;
  /** One sentence for screen readers, combining both. */
  spoken: string;
}

const COPY = {
  en: {
    count: (d: number, n: number) => `Day ${d} of ${n}`,
    left: (n: number) => (n === 0 ? 'Due today' : n === 1 ? '1 day left' : `${n} days left`),
    over: (n: number) => (n === 1 ? '1 day overdue' : `${n} days overdue`),
    pending: 'Not submitted yet',
    window: 'Investigation window',
  },
  es: {
    count: (d: number, n: number) => `Día ${d} de ${n}`,
    left: (n: number) => (n === 0 ? 'Vence hoy' : n === 1 ? 'Queda 1 día' : `Quedan ${n} días`),
    over: (n: number) => (n === 1 ? '1 día de retraso' : `${n} días de retraso`),
    pending: 'Aún no se ha enviado',
    window: 'Plazo de investigación',
  },
} as const;

/** The words that always travel with the bar, so the state never depends on colour. */
export function windowText(w: DayWindow, lang: 'en' | 'es' = 'en'): WindowText {
  const c = COPY[lang];
  const status = w.state === 'pending' ? c.pending : w.state === 'overdue' ? c.over(w.daysOverdue) : c.left(w.daysLeft);
  const count = w.day != null && w.totalDays != null ? c.count(w.day, w.totalDays) : '';
  return { count, status, spoken: `${c.window}: ${[count, status].filter(Boolean).join(', ')}` };
}
