import { cn } from '@/lib/util';

/* Dependency-free SVG charts. Colour is by token so they follow light/dark automatically. */

export function Sparkline({ values, height = 36, width = 120, className }: { values: number[]; height?: number; width?: number; className?: string }) {
  if (values.length < 2) return <div className="text-xs text-faint">Not enough data yet</div>;
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const span = max - min || 1;
  const pts = values.map((v, i) => [(i / (values.length - 1)) * (width - 4) + 2, height - 3 - ((v - min) / span) * (height - 6)] as const);
  const d = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  return (
    <svg viewBox={`0 0 ${width} ${height}`} width={width} height={height} className={cn('overflow-visible', className)} role="img" aria-label="Trend">
      <path d={`${d} L${width - 2},${height} L2,${height} Z`} className="fill-brand/10" />
      <path d={d} fill="none" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="stroke-brand" />
    </svg>
  );
}

/** Time series as bars with value labels and an x axis. */
export function BarSeries({ data, height = 160, format = (n: number) => String(n) }: { data: { label: string; value: number }[]; height?: number; format?: (n: number) => string }) {
  const max = Math.max(...data.map((d) => d.value), 1);
  const w = 100 / data.length;
  return (
    <figure>
      <svg viewBox={`0 0 100 ${height / 4}`} preserveAspectRatio="none" className="w-full" style={{ height }} role="img" aria-label="Bar chart">
        {[0.25, 0.5, 0.75, 1].map((g) => (
          <line key={g} x1="0" x2="100" y1={(height / 4) * (1 - g)} y2={(height / 4) * (1 - g)} className="stroke-line" strokeWidth="0.3" vectorEffect="non-scaling-stroke" />
        ))}
        {data.map((d, i) => {
          const h = (d.value / max) * (height / 4 - 2);
          return <rect key={d.label} x={i * w + w * 0.2} y={height / 4 - h} width={w * 0.6} height={Math.max(h, d.value > 0 ? 0.6 : 0)} rx="0.8" className="fill-brand" />;
        })}
      </svg>
      <div className="mt-1 grid text-center text-[11px] text-muted" style={{ gridTemplateColumns: `repeat(${data.length}, minmax(0, 1fr))` }}>
        {data.map((d) => (
          <div key={d.label}>
            <div className="font-medium tabular-nums text-ink">{format(d.value)}</div>
            <div>{d.label}</div>
          </div>
        ))}
      </div>
    </figure>
  );
}

export function Donut({ value, total, label, size = 120 }: { value: number; total: number; label: string; size?: number }) {
  const pct = total > 0 ? value / total : 0;
  const r = 44;
  const c = 2 * Math.PI * r;
  return (
    <div className="relative inline-grid place-items-center" style={{ width: size, height: size }} role="img" aria-label={`${label}: ${Math.round(pct * 100)}%`}>
      <svg viewBox="0 0 100 100" width={size} height={size} className="-rotate-90">
        <circle cx="50" cy="50" r={r} fill="none" strokeWidth="9" className="stroke-line" />
        <circle cx="50" cy="50" r={r} fill="none" strokeWidth="9" strokeLinecap="round" className="stroke-brand transition-all" strokeDasharray={`${c * pct} ${c}`} />
      </svg>
      <div className="absolute text-center">
        <div className="font-display text-2xl font-semibold tabular-nums">{total > 0 ? `${Math.round(pct * 100)}%` : '—'}</div>
        <div className="text-[11px] text-muted">{label}</div>
      </div>
    </div>
  );
}

/** Horizontal share bars: labelled rows with counts. */
export function HBars({ rows, tone = 'brand' }: { rows: { label: string; value: number; sub?: string }[]; tone?: 'brand' | 'ok' | 'warn' }) {
  const max = Math.max(...rows.map((r) => r.value), 1);
  const fill = { brand: 'bg-brand', ok: 'bg-ok', warn: 'bg-warn' }[tone];
  return (
    <ul className="space-y-3">
      {rows.map((r) => (
        <li key={r.label}>
          <div className="mb-1 flex justify-between gap-3 text-sm">
            <span className="truncate">{r.label}</span>
            <span className="shrink-0 tabular-nums text-muted">{r.sub ?? r.value}</span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-line/60">
            <div className={cn('h-full rounded-full', fill)} style={{ width: `${(r.value / max) * 100}%` }} />
          </div>
        </li>
      ))}
    </ul>
  );
}

/** Stacked bar: how one population divides across outcomes. */
export function SplitBar({ parts }: { parts: { label: string; value: number; className: string }[] }) {
  const total = parts.reduce((a, p) => a + p.value, 0);
  if (!total) return <div className="text-sm text-muted">No resolved items yet.</div>;
  return (
    <div>
      <div className="flex h-3 overflow-hidden rounded-full bg-line/60" role="img" aria-label={parts.map((p) => `${p.label} ${p.value}`).join(', ')}>
        {parts.filter((p) => p.value > 0).map((p) => <div key={p.label} className={p.className} style={{ width: `${(p.value / total) * 100}%` }} />)}
      </div>
      <ul className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm sm:grid-cols-3">
        {parts.map((p) => (
          <li key={p.label} className="flex items-center gap-2">
            <span className={cn('h-2.5 w-2.5 rounded-full', p.className)} aria-hidden />
            <span className="text-muted">{p.label}</span>
            <span className="ml-auto font-medium tabular-nums">{p.value}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
