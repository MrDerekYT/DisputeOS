import type { Metadata } from 'next';
import Link from 'next/link';
import { ChevronDown } from 'lucide-react';
import { DatedRow, PortalTitle } from '@/components/portal-kit';
import { Badge, DayMeter, EmptyState } from '@/components/ui';
import { portalContext } from '@/lib/portal';
import { fill } from '@/lib/portal-i18n';
import { BUREAU_LABEL, fmtDate, type Bureau } from '@/lib/util';
import { specialtyAgency } from '@/lib/credit/agencies';

export const metadata: Metadata = { title: 'My items' };

export default async function PortalDisputes() {
  const { ctx, t, lang } = await portalContext();
  const { rows, events } = await ctx.tx(async (db) => ({
    rows: await db.rows<{ id: string; item_label: string; status: string; round: number; bureau: Bureau | null; recipient_name: string; reason: string; submitted_at: string | null; due_at: string | null; deadline_extended: boolean; outcome: string | null; agency: string | null }>(
      'select id, item_label, status, round, bureau, recipient_name, reason, submitted_at, due_at, deadline_extended, outcome, agency from public.disputes order by coalesce(submitted_at, created_at) desc'),
    events: await db.rows<{ dispute_id: string; to_status: string | null; note: string | null; kind: string; created_at: string }>('select dispute_id, to_status, note, kind, created_at from public.dispute_events order by created_at'),
  }));
  const tone = (s: string) => (s === 'resolved' ? 'ok' : s === 'response_received' ? 'brand' : s === 'on_hold' || s === 'approved' ? 'neutral' : 'info') as 'ok' | 'brand' | 'info' | 'neutral';
  // One clock for every window on the page.
  const now = new Date();
  return (
    <div className="max-w-3xl space-y-6">
      <PortalTitle>{t('disputes')}</PortalTitle>
      {rows.length === 0 ? <EmptyState title={t('noDisputes')} action={<Link href="/portal/messages" className="btn-primary">{t('messageTeam')}</Link>} /> : rows.map((d) => {
        const open = Boolean(d.due_at) && (d.status === 'submitted' || d.status === 'under_investigation');
        const history = events.filter((e) => e.dispute_id === d.id);
        const agency = specialtyAgency(d.agency);
        return (
          <article key={d.id} className="card card-pad">
            <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
              <div className="min-w-0"><h2 className="text-lg font-semibold leading-snug [overflow-wrap:anywhere]">{d.item_label}</h2><p className="mt-0.5 text-sm text-muted">{d.bureau ? BUREAU_LABEL[d.bureau] : d.recipient_name}{d.round > 1 ? ` · ${t('round')} ${d.round}` : ''}</p></div>
              <Badge tone={tone(d.status)} dot>{t(`st_${d.status}` as 'st_resolved')}</Badge>
            </div>
            <p className="mt-3 text-[0.9375rem]">{t(`m_${d.status}` as 'm_resolved')}</p>
            {d.outcome && <p className="mt-3 rounded-xl bg-raised px-3.5 py-3 text-[0.9375rem] font-semibold">{t(`o_${d.outcome}` as 'o_deleted')}</p>}

            {open ? (
              // The investigation window, counted back from this item's own stored deadline.
              <div className="mt-5">
                <DayMeter dueAt={d.due_at} extended={d.deadline_extended} now={now} lang={lang} variant="ticks" />
                <div className="mt-2 flex flex-wrap justify-between gap-x-4 gap-y-0.5 text-[0.8125rem] text-muted">
                  <span>{d.submitted_at && fill(t('win_sent'), { date: fmtDate(d.submitted_at, lang) })}</span>
                  <span>{t('expectBy')} {fmtDate(d.due_at, lang)}</span>
                </div>
              </div>
            ) : d.submitted_at && (
              <dl className="mt-4 text-sm"><div><dt className="text-[0.8125rem] text-muted">{t('sentOn')}</dt><dd>{fmtDate(d.submitted_at, lang)}</dd></div></dl>
            )}

            {agency && (
              // What this agency is, in one sentence, and where the client can ask for their own free copy.
              <details className="group/about mt-5 border-t border-line pt-4">
                <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded-md text-sm font-semibold text-brand-strong [&::-webkit-details-marker]:hidden">{fill(t('sp_about'), { name: agency.shortName })} <ChevronDown size={16} aria-hidden className="transition-transform group-open/about:rotate-180" /></summary>
                <p className="mt-2.5 text-sm text-muted">{agency.reports[lang]} <a className="link" href={agency.disclosure.url} target="_blank" rel="noreferrer">{t('sp_request')}</a></p>
              </details>
            )}
            <details className="group mt-5 border-t border-line pt-4">
              <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded-md text-sm font-semibold text-brand-strong [&::-webkit-details-marker]:hidden">{t('reason')} <ChevronDown size={16} aria-hidden className="transition-transform group-open:rotate-180" /></summary>
              <p className="mt-2.5 whitespace-pre-wrap rounded-xl bg-raised p-3.5 text-sm text-muted [overflow-wrap:anywhere]">{d.reason}</p>
            </details>
            {history.length > 0 && (
              <div className="mt-4 border-t border-line pt-3">
                <h3 className="text-[0.8125rem] font-medium text-muted">{t('history')}</h3>
                <ol className="divide-y divide-line/70">
                  {history.map((e, i) => <DatedRow key={i} date={fmtDate(e.created_at, lang)}>{e.kind === 'status_changed' ? t(`st_${e.to_status}` as 'st_resolved') : e.note}</DatedRow>)}
                </ol>
              </div>
            )}
          </article>);
      })}
    </div>
  );
}
