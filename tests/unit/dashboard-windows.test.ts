import { describe, expect, it } from 'vitest';
import { calendarGeometry } from '@/components/dashboard-windows';

const DAY = 86_400_000;
const now = new Date('2026-11-19T12:00:00Z');
const at = (days: number) => new Date(now.getTime() + days * DAY).toISOString();

describe('investigation windows calendar', () => {
  it('puts every window and today on one shared axis', () => {
    const g = calendarGeometry([{ submittedAt: at(-36), dueAt: at(-6) }, { submittedAt: at(-12), dueAt: at(18) }], now);
    expect(g.t0).toBe(now.getTime() - 36 * DAY);
    expect(g.t1).toBe(now.getTime() + 18 * DAY);
    expect(g.nowPct).toBeCloseTo((36 / 54) * 100, 1);
    expect(g.ticks[0]!.pct).toBe(0);
    expect(g.ticks.at(-1)!.pct).toBe(100);
  });

  it('draws an overdue window as elapsed up to the deadline, then past-deadline up to today', () => {
    const [segs] = calendarGeometry([{ submittedAt: at(-36), dueAt: at(-6) }], now).rows;
    expect(segs!.map((s) => s.kind)).toEqual(['elapsed', 'over']);
    expect(segs![0]!.left).toBe(0);
    expect(segs![0]!.width).toBeCloseTo((30 / 36) * 100, 1);
    expect(segs![1]!.left + segs![1]!.width).toBeCloseTo(100, 1); // ends at today
  });

  it('draws an open window as elapsed up to today, then days left up to the deadline', () => {
    const g = calendarGeometry([{ submittedAt: at(-12), dueAt: at(18) }], now);
    const segs = g.rows[0]!;
    expect(segs.map((s) => s.kind)).toEqual(['elapsed', 'left']);
    expect(segs[0]!.left + segs[0]!.width).toBeCloseTo(g.nowPct, 1); // the boundary is the today line
    expect(segs[1]!.left).toBeCloseTo(g.nowPct, 1);
    expect(segs[1]!.left + segs[1]!.width).toBeCloseTo(100, 1);
  });

  it('never invents a start: without a submission date only the days left or overdue are drawn', () => {
    expect(calendarGeometry([{ submittedAt: null, dueAt: at(10) }], now).rows[0]!.map((s) => s.kind)).toEqual(['left']);
    expect(calendarGeometry([{ submittedAt: null, dueAt: at(-3) }], now).rows[0]!.map((s) => s.kind)).toEqual(['over']);
    // a start on or after the deadline is bad data and is treated as unknown
    expect(calendarGeometry([{ submittedAt: at(20), dueAt: at(10) }], now).rows[0]!.map((s) => s.kind)).toEqual(['left']);
  });

  it('keeps every segment inside the track', () => {
    const g = calendarGeometry([{ submittedAt: at(-36), dueAt: at(-6) }, { submittedAt: at(-1), dueAt: at(44) }, { submittedAt: null, dueAt: at(2) }], now);
    for (const s of g.rows.flat()) { expect(s.left).toBeGreaterThanOrEqual(0); expect(s.left + s.width).toBeLessThanOrEqual(100.01); expect(s.width).toBeGreaterThan(0); }
  });
});
