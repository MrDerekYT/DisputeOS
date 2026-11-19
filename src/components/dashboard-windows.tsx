import Link from 'next/link';
import { AlertTriangle, Clock } from 'lucide-react';
import { Badge } from '@/components/ui';
import { dayWindow, windowText } from '@/lib/day-meter';
import { DUE_SOON_DAYS } from '@/lib/disputes/workflow';
import { cn } from '@/lib/util';

/**
 * "Investigation windows": every open, submitted dispute drawn on one shared calendar, from its stored deadline and
 * the day its window opened (the deadline minus 30 or 45 days — see windowStart in src/lib/day-meter.ts). Elapsed days are solid, days left are outlined, days past the deadline are hatched coral,
 * and one line marks today. The chip beside each row says the same thing in words (same rules as DayMeter and the
 * overdue counts), so nothing depends on colour.
 */
export interface WindowRow {
  id: string;
  href: string;
  title: string;
  /** Lighter text after the title: client, bureau. */
  meta?: string;
  /** When the window opened: windowStart(due_at, deadline_extended). Without it only the days left / overdue are drawn. */
  startAt: string | null;
  /** disputes.due_at */
  dueAt: string;
}

const DAY = 86_400_000;

export interface Segment { kind: 'elapsed' | 'left' | 'over'; left: number; width: number }
export interface CalendarGeometry {
  /** Start and end of the shared axis (ms). */
  t0: number; t1: number;
  /** Where today sits on the axis, 0–100. */
  nowPct: number;
  /** Evenly spaced axis dates, first at 0 and last at 100. */
  ticks: { at: number; pct: number }[];
  rows: Segment[][];
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Pure: turns each window's start (`submittedAt` here: the day its window opened) and deadline into positions on a shared axis. The axis always contains today. */
export function calendarGeometry(rows: { submittedAt: string | null; dueAt: string }[], now: Date, tickCount = 5): CalendarGeometry {
  const t = now.getTime();
  const parsed = rows.map((r) => {
    const due = new Date(r.dueAt).getTime();
    const s = r.submittedAt ? new Date(r.submittedAt).getTime() : NaN;
    // A start on or after the deadline is bad data: treat the start as unknown rather than draw a made-up bar.
    return { due, start: Number.isFinite(s) && s < due ? s : null };
  }).filter((r) => Number.isFinite(r.due));
  let t0 = Math.min(t, ...parsed.map((r) => r.start ?? Math.min(r.due, t)));
  let t1 = Math.max(t, ...parsed.map((r) => r.due));
  if (t1 - t0 < DAY) { t0 -= DAY / 2; t1 += DAY / 2; }
  const span = t1 - t0;
  const pct = (x: number) => r2(((x - t0) / span) * 100);
  const seg = (kind: Segment['kind'], a: number, b: number): Segment | null => (b > a ? { kind, left: pct(a), width: r2(pct(b) - pct(a)) } : null);
  return {
    t0, t1, nowPct: pct(t),
    ticks: Array.from({ length: tickCount }, (_, i) => { const at = t0 + (span * i) / (tickCount - 1); return { at, pct: pct(at) }; }),
    rows: parsed.map(({ start, due }) => {
      const overdue = due < t;
      const from = start ?? Math.min(due, t);
      return [
        start != null ? seg('elapsed', from, Math.min(t, due)) : null,
        overdue ? seg('over', due, t) : seg('left', Math.max(from, t), due),
      ].filter((s): s is Segment => s !== null);
    }),
  };
}

const SEG_CLASS: Record<Segment['kind'], string> = { elapsed: 'meter-el', left: 'meter-left', over: 'meter-over' };

export function WindowCalendar({ rows, now, timeZone }: { rows: WindowRow[]; now: Date; timeZone: string }) {
  const g = calendarGeometry(rows.map((r) => ({ submittedAt: r.startAt, dueAt: r.dueAt })), now);
  const short = (ms: number, tz = 'UTC') => new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: tz });
  // Keep the "Today" label inside the panel when today sits near either end of the axis.
  const todayAlign = g.nowPct > 80 ? { right: `${100 - g.nowPct}%` } : g.nowPct < 20 ? { left: `${g.nowPct}%` } : { left: `${g.nowPct}%`, transform: 'translateX(-50%)' };
  return (
    <div>
      <div className="relative h-7" aria-hidden>
        <span className="absolute top-0 whitespace-nowrap rounded-full bg-now px-2.5 py-0.5 text-xs font-semibold text-canvas" style={todayAlign}>Today, {short(now.getTime(), timeZone)}</span>
      </div>
      <div className="relative">
        {/* The shared axis: faint date lines and the today line run behind every row. */}
        <div className="pointer-events-none absolute inset-0" aria-hidden>
          {g.ticks.map((k) => <span key={k.at} className="absolute inset-y-0 w-px bg-line/60" style={{ left: `${k.pct}%` }} />)}
          <span className="absolute inset-y-0 w-px bg-now/50" style={{ left: `${g.nowPct}%` }} />
        </div>
        <div className="relative flex justify-between pb-2 text-xs text-muted" aria-hidden>
          {g.ticks.map((k, i) => <span key={k.at} className={cn('bg-surface', i === 0 ? 'pr-1.5' : i === g.ticks.length - 1 ? 'pl-1.5' : 'px-1.5', i % 2 === 1 && 'hidden sm:inline')}>{short(k.at)}</span>)}
        </div>
        <ul className="relative space-y-4 pb-1">
          {rows.map((r, i) => {
            const w = dayWindow(r.startAt, r.dueAt, now);
            const text = windowText(w);
            const soon = w.state === 'open' && w.daysLeft <= DUE_SOON_DAYS;
            const Icon = w.state === 'overdue' ? AlertTriangle : Clock;
            return (
              <li key={r.id}>
                <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                  <Link href={r.href} className="group min-w-0 rounded-md text-sm leading-snug">
                    <span className="bg-surface font-semibold text-ink decoration-brand decoration-2 underline-offset-4 group-hover:underline">{r.title}</span>
                    {r.meta && <span className="bg-surface text-muted"> {r.meta}</span>}
                  </Link>
                  <Badge tone={w.state === 'overdue' ? 'bad' : soon ? 'warn' : 'neutral'}><Icon size={12} aria-hidden />{text.status}</Badge>
                </div>
                <div className="relative mt-2" role="img" aria-label={`${text.spoken}. ${r.startAt ? `Window opened ${short(new Date(r.startAt).getTime())}, ` : ''}due ${short(new Date(r.dueAt).getTime())}.`}>
                  <div className={cn('meter', w.state === 'overdue' && 'is-over')} style={{ display: 'block' }}>
                    {(g.rows[i] ?? []).map((s) => <i key={s.kind} className={SEG_CLASS[s.kind]} style={{ position: 'absolute', top: 0, left: `${s.left}%`, width: `${s.width}%` }} />)}
                  </div>
                  <span className="meter-pin" style={{ left: `${g.nowPct}%` }} aria-hidden />
                </div>
              </li>
            );
          })}
        </ul>
      </div>
      <ul className="mt-5 flex flex-wrap gap-x-5 gap-y-1.5 text-[0.8125rem] text-muted" aria-label="Legend">
        <li className="flex items-center gap-2"><i aria-hidden className="meter-el block h-2.5 !w-5 !rounded" />Days elapsed</li>
        <li className="flex items-center gap-2"><i aria-hidden className="meter-left block h-2.5 !w-5 !rounded" />Days left</li>
        <li className="flex items-center gap-2"><i aria-hidden className="meter-over block h-2.5 !w-5 !rounded" />Past the deadline</li>
      </ul>
    </div>
  );
}
