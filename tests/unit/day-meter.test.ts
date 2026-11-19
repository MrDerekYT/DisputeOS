import { describe, expect, it } from 'vitest';
import { dayWindow, windowStart, windowText } from '@/lib/day-meter';
import { daysOverdue, daysRemaining, deadlineState, responseDueDate } from '@/lib/disputes/workflow';

const at = (s: string) => new Date(s);

describe('investigation window arithmetic', () => {
  const submitted = '2026-11-07T15:00:00Z';
  const due = '2026-12-07T15:00:00Z'; // a 30-day window

  it('counts the day, the days left and the bar shares inside the window', () => {
    const w = dayWindow(submitted, due, at('2026-11-19T18:00:00Z'));
    expect(w).toMatchObject({ state: 'open', totalDays: 30, day: 12, daysLeft: 18, daysOverdue: 0, elapsedPct: 40, leftPct: 60, overPct: 0 });
    expect(windowText(w)).toEqual({ count: 'Day 12 of 30', status: '18 days left', spoken: 'Investigation window: Day 12 of 30, 18 days left' });
  });

  it('day and days left always add up to the window length while it is open', () => {
    for (let h = 0; h <= 30 * 24; h += 7) {
      const w = dayWindow(submitted, due, new Date(at(submitted).getTime() + h * 3_600_000));
      expect(w.state).toBe('open');
      expect(w.day! + w.daysLeft, `hour ${h}`).toBe(30);
      expect(w.elapsedPct + w.leftPct).toBeCloseTo(100, 5);
    }
  });

  it('starts at day 0 and is not overdue at the exact deadline', () => {
    expect(dayWindow(submitted, due, at(submitted))).toMatchObject({ state: 'open', day: 0, daysLeft: 30, elapsedPct: 0, leftPct: 100 });
    const last = dayWindow(submitted, due, at(due));
    expect(last).toMatchObject({ state: 'open', day: 30, daysLeft: 0, elapsedPct: 100, leftPct: 0 });
    expect(windowText(last).status).toBe('Due today');
  });

  it('is overdue the moment the deadline passes, and keeps counting days', () => {
    const justPast = dayWindow(submitted, due, at('2026-12-07T15:00:01Z'));
    expect(justPast).toMatchObject({ state: 'overdue', day: 31, daysLeft: 0, daysOverdue: 1 });
    const w = dayWindow(submitted, due, at('2026-12-13T10:00:00Z'));
    expect(w).toMatchObject({ state: 'overdue', totalDays: 30, day: 36, daysOverdue: 6 });
    expect(w.elapsedPct + w.overPct).toBeCloseTo(100, 5);
    expect(w.elapsedPct).toBeCloseTo((30 / 36) * 100, 1);
    expect(windowText(w)).toMatchObject({ count: 'Day 36 of 30', status: '6 days overdue' });
    expect(windowText(justPast).status).toBe('1 day overdue');
  });

  it('agrees with the dispute workflow rules at every point', () => {
    for (const now of ['2026-11-07T15:00:00Z', '2026-11-30T03:00:00Z', '2026-12-07T14:59:59Z', '2026-12-07T15:00:00Z', '2026-12-07T15:00:01Z', '2026-12-25T00:00:00Z']) {
      const n = at(now);
      const w = dayWindow(submitted, due, n);
      expect(w.state === 'overdue', now).toBe(deadlineState(due, n) === 'overdue');
      if (w.state === 'overdue') expect(w.daysOverdue, now).toBe(daysOverdue(due, n));
      else expect(w.daysLeft, now).toBe(daysRemaining(due, n));
    }
  });

  it('handles a 45-day window', () => {
    expect(dayWindow('2026-01-01T12:00:00Z', '2026-02-15T12:00:00Z', at('2026-01-10T12:00:00Z'))).toMatchObject({ totalDays: 45, day: 9, daysLeft: 36, elapsedPct: 20 });
  });

  it('draws nothing it does not know: no deadline is pending, no submission date gives no day count', () => {
    const pending = dayWindow(null, null, at('2026-11-19T00:00:00Z'));
    expect(pending).toMatchObject({ state: 'pending', totalDays: null, day: null, elapsedPct: 0, leftPct: 0, overPct: 0 });
    expect(windowText(pending)).toMatchObject({ count: '', status: 'Not submitted yet' });
    expect(dayWindow(submitted, '', at('2026-11-19T00:00:00Z')).state).toBe('pending');
    expect(dayWindow(submitted, 'not a date', at('2026-11-19T00:00:00Z')).state).toBe('pending');

    const noStart = dayWindow(null, due, at('2026-11-19T18:00:00Z'));
    expect(noStart).toMatchObject({ state: 'open', totalDays: null, day: null, daysLeft: 18 });
    expect(windowText(noStart)).toMatchObject({ count: '', status: '18 days left' });
    expect(dayWindow(null, due, at('2026-12-13T10:00:00Z'))).toMatchObject({ state: 'overdue', day: null, daysOverdue: 6, overPct: 100 });
    // a submission recorded after its own deadline is bad data, not a window
    expect(dayWindow(due, submitted, at('2026-11-01T00:00:00Z'))).toMatchObject({ state: 'open', totalDays: null, day: null });
  });

  it('never shows a negative day when "now" is before the recorded submission', () => {
    expect(dayWindow(submitted, due, at('2026-11-05T00:00:00Z'))).toMatchObject({ state: 'open', day: 0, elapsedPct: 0, leftPct: 100 });
  });

  it('accepts Date objects as well as strings', () => {
    expect(dayWindow(at(submitted), at(due), at('2026-11-19T18:00:00Z'))).toMatchObject({ day: 12, daysLeft: 18 });
  });

  it('has the same words in Spanish', () => {
    expect(windowText(dayWindow(submitted, due, at('2026-11-19T18:00:00Z')), 'es')).toEqual({ count: 'Día 12 de 30', status: 'Quedan 18 días', spoken: 'Plazo de investigación: Día 12 de 30, Quedan 18 días' });
    expect(windowText(dayWindow(submitted, due, at('2026-12-13T10:00:00Z')), 'es').status).toBe('6 días de retraso');
    expect(windowText(dayWindow(submitted, due, at('2026-12-06T16:00:00Z')), 'es').status).toBe('Queda 1 día');
    expect(windowText(dayWindow(submitted, due, at(due)), 'es').status).toBe('Vence hoy');
    expect(windowText(dayWindow(null, null), 'es').status).toBe('Aún no se ha enviado');
  });
});

describe('where the window starts', () => {
  // The deadline is stored as receipt + 30 days (45 when extended), so the window is counted back from it.
  it('is the receipt date, however long before that the letter was mailed', () => {
    const sent = at('2026-11-14T12:00:00Z');      // mailed 5 days before it was recorded
    const received = at('2026-11-19T12:00:00Z');  // no receipt date typed: the clock starts when it is recorded
    const due = responseDueDate(received);
    expect(windowStart(due, false)!.toISOString()).toBe(received.toISOString());

    // Measured from the mailing date the same dispute would read "Day 5 of 35".
    expect(windowText(dayWindow(sent, due, received)).count).toBe('Day 5 of 35');
    // Measured from receipt it is the legal window: day 0 of 30 on the day it is recorded, and always "of 30".
    expect(dayWindow(windowStart(due, false), due, received)).toMatchObject({ state: 'open', totalDays: 30, day: 0, daysLeft: 30 });
    const later = at('2026-12-01T18:00:00Z');
    const w = dayWindow(windowStart(due, false), due, later);
    expect(w).toMatchObject({ totalDays: 30, day: 12, daysLeft: 18 });
    expect(w.day! + w.daysLeft).toBe(30);
  });

  it('is 45 days before the deadline when the window was extended', () => {
    const received = at('2026-11-10T12:00:00Z');
    const due = responseDueDate(received, true);
    expect(windowStart(due, true)!.toISOString()).toBe(received.toISOString());
    expect(dayWindow(windowStart(due, true), due, at('2026-11-19T12:00:00Z'))).toMatchObject({ totalDays: 45, day: 9, daysLeft: 36 });
    expect(windowText(dayWindow(windowStart(due, true), due, at('2026-11-19T12:00:00Z'))).count).toBe('Day 9 of 45');
  });

  it('keeps the days left and overdue exactly as before: only the start moved', () => {
    const due = responseDueDate(at('2026-11-19T12:00:00Z'));
    for (const now of ['2026-11-25T00:00:00Z', '2026-12-19T12:00:00Z', '2026-12-19T12:00:01Z', '2026-12-30T09:00:00Z']) {
      const n = at(now);
      const fromSent = dayWindow('2026-11-14T12:00:00Z', due, n);
      const fromReceipt = dayWindow(windowStart(due, false), due, n);
      expect([fromReceipt.state, fromReceipt.daysLeft, fromReceipt.daysOverdue], now).toEqual([fromSent.state, fromSent.daysLeft, fromSent.daysOverdue]);
      expect(fromReceipt.totalDays, now).toBe(30);
    }
  });

  it('has no start without a deadline', () => {
    expect(windowStart(null, false)).toBeNull();
    expect(windowStart('', true)).toBeNull();
    expect(windowStart('not a date', false)).toBeNull();
    expect(dayWindow(windowStart(null, false), null).state).toBe('pending');
  });
});
