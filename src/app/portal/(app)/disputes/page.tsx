import type { Metadata } from 'next';
import { Badge, EmptyState } from '@/components/ui';
import { portalContext } from '@/lib/portal';
import { BUREAU_LABEL, fmtDate, type Bureau } from '@/lib/util';

export const metadata: Metadata = { title: 'My items' };

export default async function PortalDisputes() {
  const { ctx, t, lang } = await portalContext();
  const { rows, events } = await ctx.tx(async (db) => ({
    rows: await db.rows<{ id: string; item_label: string; status: string; round: number; bureau: Bureau | null; recipient_name: string; reason: string; submitted_at: string | null; due_at: string | null; outcome: string | null }>(
      'select id, item_label, status, round, bureau, recipient_name, reason, submitted_at, due_at, outcome from public.disputes order by coalesce(submitted_at, created_at) desc'),
    events: await db.rows<{ dispute_id: string; to_status: string | null; note: string | null; kind: string; created_at: string }>('select dispute_id, to_status, note, kind, created_at from public.dispute_events order by created_at'),
  }));
  const tone = (s: string) => (s === 'resolved' ? 'ok' : s === 'response_received' ? 'brand' : s === 'on_hold' || s === 'approved' ? 'neutral' : 'info') as 'ok' | 'brand' | 'info' | 'neutral';
  return (
    <div className="space-y-5">
      <h1 className="font-display text-3xl font-semibold">{t('disputes')}</h1>
      {rows.length === 0 ? <EmptyState title={t('noDisputes')} /> : rows.map((d) => (
        <article key={d.id} className="card p-5 sm:p-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0"><h2 className="text-lg font-semibold leading-snug">{d.item_label}</h2><p className="text-sm text-muted">{d.bureau ? BUREAU_LABEL[d.bureau] : d.recipient_name}{d.round > 1 ? ` · #${d.round}` : ''}</p></div>
            <Badge tone={tone(d.status)} dot>{t(`st_${d.status}` as 'st_resolved')}</Badge>
          </div>
          <p className="mt-3 text-sm">{t(`m_${d.status}` as 'm_resolved')}</p>
          {d.outcome && <p className="mt-2 rounded-xl bg-raised p-3 text-sm font-medium">{t(`o_${d.outcome}` as 'o_deleted')}</p>}
          <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
            {d.submitted_at && <div><dt className="text-xs text-muted">{t('sentOn')}</dt><dd>{fmtDate(d.submitted_at, lang)}</dd></div>}
            {d.due_at && (d.status === 'submitted' || d.status === 'under_investigation') && <div><dt className="text-xs text-muted">{t('expectBy')}</dt><dd>{fmtDate(d.due_at, lang)}</dd></div>}
          </dl>
          <details className="mt-4"><summary className="cursor-pointer text-sm font-medium text-brand-strong">{t('reason')}</summary><p className="mt-2 whitespace-pre-wrap rounded-xl bg-raised p-3 text-sm text-muted">{d.reason}</p></details>
          {events.some((e) => e.dispute_id === d.id) && (
            <ol className="mt-4 space-y-2 border-t border-line pt-4 text-sm">
              {events.filter((e) => e.dispute_id === d.id).map((e, i) => <li key={i} className="flex gap-3"><span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-brand" /><span>{e.kind === 'status_changed' ? t(`st_${e.to_status}` as 'st_resolved') : e.note} <span className="text-xs text-muted">· {fmtDate(e.created_at, lang)}</span></span></li>)}
            </ol>
          )}
        </article>))}
    </div>
  );
}
