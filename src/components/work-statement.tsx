import type { ReactNode } from 'react';
import type { Statement, WaitingOn } from '@/lib/billing/statement';
import { DOC_KIND_LABEL } from '@/lib/crm';
import { OUTCOME_LABEL, type Outcome } from '@/lib/disputes/workflow';
import { fill, tr, type Lang, type PortalKey } from '@/lib/portal-i18n';
import { fmtDate } from '@/lib/util';

/**
 * The work statement, for staff ("Work statement") and for the client ("What we did for you"). One layout and one set
 * of strings (src/lib/portal-i18n.ts, English and Spanish), so the two views cannot drift apart. The staff view is in
 * English and swaps only the lines that say "you" or "us". Facts and dates only: no adjectives, and the only results
 * language is the outcome as recorded plus the standard line about who decides outcomes.
 */
const STAFF: Partial<Record<PortalKey, string>> = {
  ws_msgCount: '{sent} sent to the client · {received} received from the client',
  ws_onClient: 'Waiting on the client', ws_onAgency: 'Waiting on your team',
  ws_w_document_request: 'Document requested: {label} (asked {date})',
  ws_staffRecorded: 'Sending recorded by staff. No carrier has confirmed delivery.',
};

export const monthLabel = (month: string, lang: Lang = 'en') =>
  new Date(`${month}-01T00:00:00Z`).toLocaleDateString(lang === 'es' ? 'es-US' : 'en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });

/** The month chooser above a statement: a plain GET form, so it works without scripts. Never printed. */
export function MonthPicker({ months, month, lang = 'en', label, show, keep }: { months: string[]; month: string; lang?: Lang; label: string; show: string; /** Other query parameters to carry along. */ keep?: Record<string, string> }) {
  return (
    <form method="get" className="no-print flex flex-wrap items-end gap-2">
      {Object.entries(keep ?? {}).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
      <div><label className="label" htmlFor="ws-period">{label}</label>
        <select id="ws-period" name="period" defaultValue={month} className="field min-w-[12rem]">{months.map((m) => <option key={m} value={m}>{monthLabel(m, lang)}</option>)}</select></div>
      <button type="submit" className="btn-secondary">{show}</button>
    </form>
  );
}

function Part({ title, count, children }: { title: string; count?: number; children: ReactNode }) {
  return (
    <section className="break-inside-avoid">
      <h2 className="text-[0.9375rem] font-semibold">{title}{count != null && <span className="ml-2 font-normal tabular-nums text-muted">{count}</span>}</h2>
      <div className="mt-2 text-sm">{children}</div>
    </section>
  );
}

const Row = ({ date, children }: { date: string; children: ReactNode }) => (
  <li className="flex gap-4 py-2.5"><span className="w-[5.75rem] shrink-0 text-[0.8125rem] text-muted">{date}</span><span className="min-w-0 [overflow-wrap:anywhere]">{children}</span></li>
);

export function WorkStatementView({ s, lang = 'en', staff = false }: { s: Statement; lang?: Lang; staff?: boolean }) {
  const base = tr(lang);
  const t = (k: PortalKey) => (staff && STAFF[k]) || base(k);
  const d = (v: string | null) => fmtDate(v, lang);
  const none = <p className="text-muted">{t('ws_none')}</p>;
  const outcome = (o: string | null) => (!o ? t('ws_noOutcome') : staff ? OUTCOME_LABEL[o as Outcome] ?? o : base(`o_${o}` as PortalKey) ?? o);
  const docKind = (k: string) => (staff ? DOC_KIND_LABEL[k] : base(`kind_${k}` as PortalKey)) ?? k.replace(/_/g, ' ');
  const waitingText = (w: Statement['waiting'][number]) => {
    if (w.kind === 'document_review') return fill(t('ws_w_document_review'), { n: w.count ?? 0 });
    if (w.kind === 'investigation' && !w.day) return fill(t('ws_w_investigationNoDate'), { label: w.label });
    return fill(t(`ws_w_${w.kind}` as PortalKey), { label: w.kind === 'document_request' ? docKind(w.label) : w.label, date: d(w.day) });
  };
  const groups: [WaitingOn, PortalKey][] = [['client', 'ws_onClient'], ['recipient', 'ws_onRecipient'], ['agency', 'ws_onAgency']];

  return (
    <div className="space-y-7">
      {s.empty ? <p className="rounded-xl bg-raised px-4 py-3 text-sm">{t('ws_empty')}</p> : (
        <>
          <Part title={t('ws_sent')} count={s.lettersSent.length}>
            {s.lettersSent.length === 0 ? none : (
              <ul className="divide-y divide-line">{s.lettersSent.map((l, i) => (
                <Row key={i} date={d(l.on)}>
                  <span className="font-medium">{l.title}</span>
                  <span className="block text-muted">{t('ws_to')}: {l.recipient}{l.method ? ` · ${t(`ws_mt_${l.method}` as PortalKey)}` : ''}{l.tracking ? ` · ${t('ws_tracking')}: ${l.tracking}` : ''}</span>
                  <span className="block text-[0.8125rem] text-muted">{l.delivery === 'carrier_confirmed' ? (l.carrierDeliveredOn ? fill(t('ws_carrierOn'), { date: d(l.carrierDeliveredOn) }) : t('ws_carrier')) : t('ws_staffRecorded')}</span>
                </Row>))}</ul>)}
          </Part>
          <Part title={t('ws_approved')} count={s.lettersApproved.length}>
            {s.lettersApproved.length === 0 ? none : <ul className="divide-y divide-line">{s.lettersApproved.map((l, i) => <Row key={i} date={d(l.on)}><span className="font-medium">{l.title}</span><span className="block text-muted">{t('ws_to')}: {l.recipient}</span></Row>)}</ul>}
          </Part>
          <Part title={t('ws_responses')} count={s.responses.length}>
            {s.responses.length === 0 ? none : <ul className="divide-y divide-line">{s.responses.map((r, i) => <Row key={i} date={d(r.on)}><span className="font-medium">{r.item}</span><span className="block text-muted">{t('ws_from')}: {r.from} · {t('ws_outcome')}: {outcome(r.outcome)}</span></Row>)}</ul>}
          </Part>
          <div className="grid gap-7 sm:grid-cols-2">
            <Part title={t('ws_documents')}><p>{fill(t('ws_docCount'), { n: s.documentsReviewed })}</p></Part>
            <Part title={t('ws_messages')}><p>{fill(t('ws_msgCount'), { sent: s.messages.sent, received: s.messages.received })}</p></Part>
          </div>
        </>
      )}
      <Part title={t('ws_waiting')}>
        <p className="mb-2 text-[0.8125rem] text-muted">{t('ws_waitingAsOf')}</p>
        {s.waiting.length === 0 ? <p className="text-muted">{t('ws_nothingWaiting')}</p> : (
          <dl className="space-y-3">{groups.filter(([on]) => s.waiting.some((w) => w.on === on)).map(([on, key]) => (
            <div key={on}><dt className="font-medium">{t(key)}</dt><dd><ul className="mt-1 list-disc space-y-0.5 pl-5 text-muted">{s.waiting.filter((w) => w.on === on).map((w, i) => <li key={i}>{waitingText(w)}</li>)}</ul></dd></div>))}</dl>)}
      </Part>
      <p className="border-t border-line pt-4 text-[0.8125rem] text-muted">{t('ws_outcomeLine')}</p>
    </div>
  );
}
