import { describe, expect, it } from 'vitest';
import { daysOverdue, deadlineState, DUE_SOON_DAYS } from '@/lib/disputes/workflow';
import { dayInZone, dueDay, pageParam } from '@/lib/util';

describe('task due days', () => {
  // Tasks are stored as 17:00 UTC on the chosen day.
  const due = '2026-03-10T17:00:00.000Z';
  const tz = 'America/New_York';

  it('keeps a task due today under "today" for the whole business day', () => {
    expect(dueDay(due, tz, new Date('2026-03-10T13:00:00Z'))).toBe('today'); // 9am Eastern
    expect(dueDay(due, tz, new Date('2026-03-10T18:30:00Z'))).toBe('today'); // after 17:00 UTC, still the 10th in the US
    expect(dueDay(due, tz, new Date('2026-03-11T02:00:00Z'))).toBe('today'); // 10pm Eastern on the 10th
  });
  it('is overdue only from the next day, and upcoming before', () => {
    expect(dueDay(due, tz, new Date('2026-03-11T13:00:00Z'))).toBe('overdue');
    expect(dueDay(due, tz, new Date('2026-03-09T23:00:00Z'))).toBe('upcoming');
  });
  it('reads today in the business time zone, not UTC', () => {
    expect(dayInZone(tz, new Date('2026-03-11T02:00:00Z'))).toBe('2026-03-10');
    expect(dayInZone(tz, new Date('2026-03-11T12:00:00Z'))).toBe('2026-03-11');
  });
  it('follows the configured zone, not a fixed one', () => {
    const now = new Date('2026-03-11T05:30:00Z'); // 1:30am Eastern on the 11th, 10:30pm Pacific on the 10th
    expect(dueDay(due, 'America/New_York', now)).toBe('overdue');
    expect(dueDay(due, 'America/Los_Angeles', now)).toBe('today');
  });
});

describe('page numbers from the URL', () => {
  it('accepts whole numbers in range and falls back to 1 for anything else', () => {
    expect(pageParam('3')).toBe(3);
    for (const v of [undefined, '', '0', '-2', '1.5', 'abc', 'Infinity', '1e30', '100001']) expect(pageParam(v)).toBe(1);
  });
});

describe('dispute deadlines', () => {
  const now = new Date('2026-03-10T12:00:00Z');

  it('is overdue as soon as the deadline has passed, and never shows 0 days', () => {
    expect(deadlineState('2026-03-10T06:00:00Z', now)).toBe('overdue'); // 6 hours ago
    expect(daysOverdue('2026-03-10T06:00:00Z', now)).toBe(1);
    expect(daysOverdue('2026-03-07T06:00:00Z', now)).toBe(4);
    expect(deadlineState('2026-03-10T18:00:00Z', now)).toBe('soon'); // later today is not overdue
  });
  it('uses one due-soon window', () => {
    expect(DUE_SOON_DAYS).toBe(7);
    expect(deadlineState('2026-03-17T12:00:00Z', now)).toBe('soon');
    expect(deadlineState('2026-03-18T12:00:01Z', now)).toBe('ok');
  });
});
