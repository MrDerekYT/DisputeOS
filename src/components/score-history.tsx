import { Sparkline } from './charts';
import { BUREAU_LABEL, fmtDate, type Bureau } from '@/lib/util';

export interface ScoreRow { bureau: Bureau; model: string; score: number; scored_on: string }

/**
 * Scores exactly as each report states them, per bureau and model. Nothing is computed, projected or celebrated:
 * a score moves for many reasons and is never presented as a promise.
 */
export function ScoreHistory({ rows, note, lang = 'en' }: { rows: ScoreRow[]; note: string; lang?: 'en' | 'es' }) {
  const groups = new Map<string, ScoreRow[]>();
  for (const r of rows) groups.set(`${r.bureau}|${r.model}`, [...(groups.get(`${r.bureau}|${r.model}`) ?? []), r]);
  const list = [...groups.values()].map((g) => g.sort((a, b) => a.scored_on.localeCompare(b.scored_on)));
  if (!list.length) return null;
  return (
    <div>
      <ul className="grid gap-3 sm:grid-cols-3">
        {list.map((g) => {
          const last = g[g.length - 1]!;
          const first = g[0]!;
          const delta = g.length > 1 ? last.score - first.score : null;
          return (
            <li key={`${last.bureau}${last.model}`} className="rounded-xl border border-line bg-raised p-3.5">
              <div className="text-xs font-semibold text-muted">{BUREAU_LABEL[last.bureau]} · {last.model}</div>
              {/* Score and trend share a row; the dates get their own full-width lines so narrow cards never squeeze them. */}
              <div className="mt-1 flex items-center justify-between gap-2">
                <div className="font-display text-3xl font-semibold tabular-nums">{last.score}</div>
                {g.length > 1 && <Sparkline values={g.map((x) => x.score)} width={84} height={32} />}
              </div>
              <div className="mt-1 text-xs text-muted">{fmtDate(last.scored_on, lang === 'es' ? 'es' : 'en')}</div>
              {delta != null && delta !== 0 && <div className="text-xs text-muted"><span className="font-medium tabular-nums text-ink">{delta > 0 ? '+' : ''}{delta}</span> {lang === 'es' ? 'desde' : 'since'} {fmtDate(first.scored_on, lang === 'es' ? 'es' : 'en')}</div>}
            </li>
          );
        })}
      </ul>
      <p className="mt-3 text-xs text-muted">{note}</p>
    </div>
  );
}
