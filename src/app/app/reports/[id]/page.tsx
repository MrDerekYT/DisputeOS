import Link from 'next/link';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { AlertOctagon, AlertTriangle, CheckCircle2, ChevronDown, RefreshCw } from 'lucide-react';
import { REPORT_SOURCE_LABEL } from '@/components/staff-kit';
import { ActionForm, Check, ConfirmButton, Field, SubmitButton } from '@/components/forms';
import { Badge, DefinitionList, EmptyState, label, Notice, PageHeader, Section, StatFigure, StatusBadge } from '@/components/ui';
import { requireStaff } from '@/lib/auth/context';
import { lowConfidenceFields } from '@/lib/reports/parser';
import { readingMark, REPORT_CHANGED } from '@/lib/reports/service';
import type { FieldMeta } from '@/lib/reports/types';
import { BUREAU_LABEL, fmtDate, isUuid, money, type Bureau } from '@/lib/util';
import { decideReportAction, deleteTradelineAction, rereadReportAction, updateTradelineAction } from '../actions';
import { AI_COSTS } from '@/lib/ai/credits';
import { ocrEnabled } from '@/lib/reports/ocr';
import { PRODUCT } from '@/lib/product';
import { FallOffNote } from '@/components/fall-off';
import { publicRecordFallOff, tradelineFallOff } from '@/lib/credit/reporting-period';
import { accountLabel, confirmedLabel, isBadKind, isCollectorAccount, labelBasis, labelOrder } from '@/lib/credit/account-kind';
import { kindLabelSql } from '@/lib/credit/kind-label-sql';
import { KindBadge } from '@/components/kind-badge';

export const metadata: Metadata = { title: 'Review report' };

/** A field to confirm, in the words the form below uses for it (the stored name says “balance cents”). */
const FIELD_LABEL: Record<string, string> = {
  creditor_name: 'creditor', account_last4: 'account last 4', balance_cents: 'balance', credit_limit_cents: 'credit limit', high_balance_cents: 'high balance',
  date_of_first_delinquency: 'first delinquency', payment_history: 'payment history',
};
const fieldLabel = (f: string) => FIELD_LABEL[f] ?? f.replace(/_/g, ' ');

interface TL {
  id: string; creditor_name: string; original_creditor: string | null; account_last4: string | null; item_type: string; account_status: string | null; payment_status: string | null;
  balance_cents: number | null; credit_limit_cents: number | null; date_opened: string | null; date_reported: string | null; date_of_first_delinquency: string | null;
  payment_history: string | null; confidence: number; field_meta: Record<string, FieldMeta>; user_provided: { not_mine?: boolean; never_late?: boolean };
  account_type: string | null; remarks: string | null; kind_label: unknown;
}

export default async function ReportReview({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ changed?: string }> }) {
  const { id } = await params;
  const { changed } = await searchParams;
  if (!isUuid(id)) notFound();
  const ctx = await requireStaff('clients:read');
  const data = await ctx.tx(async (db) => {
    const r = await db.row<{ id: string; client_id: string; bureau: Bureau; status: string; report_date: string | null; source: string; warnings: string[]; client_name: string; created_at: string; document_id: string | null }>(
      `select r.id, r.client_id, r.bureau, r.status, r.report_date, r.source, r.warnings, r.created_at, r.document_id, c.full_name as client_name from public.credit_reports r join public.clients c on c.id = r.client_id where r.id = $1`, [id]);
    if (!r) return null;
    // The mark goes to the Approve and Reject buttons, so that what is decided is what was on screen. It is taken
    // before the rows: if the file is read again in between, the page carries the old mark and the decision is
    // refused, never the other way round.
    const mark = await readingMark(db, id);
    const [tradelines, inquiries, records, identity] = await Promise.all([
      db.rows<TL>(`select t.id, t.creditor_name, t.original_creditor, t.account_last4, t.item_type, t.account_status, t.payment_status, t.balance_cents, t.credit_limit_cents, t.date_opened, t.date_reported,
                          t.date_of_first_delinquency, t.payment_history, t.confidence, t.field_meta, t.user_provided, t.account_type, t.remarks, ${kindLabelSql('t')}
                     from public.tradelines t where t.report_id = $1 order by t.item_type, t.creditor_name`, [id]),
      db.rows<{ name: string; inquiry_date: string | null }>('select name, inquiry_date from public.inquiries where report_id = $1 order by inquiry_date desc nulls last', [id]),
      db.rows<{ kind: string; court: string | null; amount_cents: number | null; filed_date: string | null }>('select kind, court, amount_cents, filed_date from public.public_records where report_id = $1', [id]),
      db.rows<{ kind: string; value: string }>('select kind, value from public.report_identity_items where report_id = $1 order by kind', [id]),
    ]);
    return { r, tradelines, inquiries, records, identity, mark };
  });
  if (!data) notFound();
  const { r, identity, inquiries, records, mark } = data;
  // Every account carries what its words say it is (src/lib/credit/account-kind.ts). Negative ones first, collections
  // at the very top: they are what the client hired us for.
  // Shown: the label with any AI suggestion. Counted: what the report's words or a person say (confirmedLabel).
  const labels = new Map(data.tradelines.map((t) => [t.id, accountLabel(t)]));
  const kindOf = (t: TL) => confirmedLabel(t).kind;
  const isColl = (t: TL) => isCollectorAccount(t) || kindOf(t) === 'collection';
  const tradelines = [...data.tradelines].sort((a, b) => (isColl(b) ? 1 : 0) - (isColl(a) ? 1 : 0) || labelOrder(labels.get(a.id)!.kind) - labelOrder(labels.get(b.id)!.kind) || a.creditor_name.localeCompare(b.creditor_name));
  const collections = tradelines.filter(isColl);
  const lates = tradelines.filter((t) => !isColl(t) && (kindOf(t) === 'late' || kindOf(t) === 'was_late'));
  const otherBad = tradelines.filter((t) => !isColl(t) && isBadKind(kindOf(t)) && kindOf(t) !== 'late' && kindOf(t) !== 'was_late');
  const owedInCollections = collections.reduce((sum, t) => sum + (t.balance_cents ?? 0), 0);
  const pending = r.status === 'pending_review';
  const needsConfirm = tradelines.filter((t) => lowConfidenceFields(t).length > 0).length;

  return (
    <>
      <PageHeader
        title={`${BUREAU_LABEL[r.bureau]} report`}
        subtitle={<>For <Link className="link" href={`/app/clients/${r.client_id}`}>{r.client_name}</Link> · report date {fmtDate(r.report_date)} · imported {fmtDate(r.created_at)} by {REPORT_SOURCE_LABEL[r.source] ?? r.source}</>}
        back={{ href: `/app/clients/${r.client_id}?tab=reports`, label: r.client_name }}
        actions={<StatusBadge status={r.status} />}
      />

      {pending && changed && <div className="mb-4"><Notice tone="bad" title="Not decided">{REPORT_CHANGED}</Notice></div>}
      {pending ? (
        <>
          <Notice tone="warn" title="Review before this is used">
            {PRODUCT.name} read this file automatically and can make mistakes. Check each account below against the original, correct anything that is off, then approve. Nothing is analysed or disputed until a person approves the report.
            {needsConfirm > 0 && <> <strong>{needsConfirm} account{needsConfirm > 1 ? 's have' : ' has'} fields with low confidence.</strong></>}
          </Notice>
          {/* The file is in the vault, so a reading that came out wrong (an older reader, a row removed by mistake) is
              made again from it instead of asking for the file a second time. Approved and rejected reports never get this. */}
          {r.document_id && ctx.can('reports:write') && (
            <ActionForm action={rereadReportAction} className="mt-3">
              <input type="hidden" name="id" value={r.id} />
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                <ConfirmButton pendingText="Reading…" message={`Read this file again? What this report holds now is replaced by a fresh reading. Corrections typed on this page, and what the client told you about an account, are lost.${ocrEnabled() ? ` If the file needs AI to be read, that takes ${AI_COSTS.report_scan} AI credits again.` : ''}`}><RefreshCw size={14} aria-hidden /> Read the file again</ConfirmButton>
                <p className="text-[0.8125rem] text-muted">Reads the stored file with the reader as it is today and replaces this reading. For a reading that came out wrong, or a row removed by mistake.</p>
              </div>
            </ActionForm>
          )}
        </>
      ) : (
        <Notice tone={r.status === 'approved' ? 'ok' : 'neutral'} title={r.status === 'approved' ? 'Approved' : 'Rejected'}>
          {r.status === 'approved' ? <>This report feeds the <Link className="link" href={`/app/clients/${r.client_id}/compare`}>three-bureau comparison</Link>.</> : 'This report is not used for analysis.'}
        </Notice>
      )}
      {/* Negative items stay red, as figures with a label and a rule instead of one loud box: what they are is said in
          words, and the accounts themselves carry the same red rule in the list below. */}
      {collections.length + lates.length + otherBad.length > 0 ? (
        <section aria-label="Negative items" className="mt-7">
          <h2 className="flex items-center gap-2 text-lg font-semibold text-bad"><AlertOctagon size={18} aria-hidden className="shrink-0" />Negative items on this report</h2>
          <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4">
            <StatFigure tone="bad" label={`Collection${collections.length === 1 ? '' : 's'}`} value={collections.length} />
            <StatFigure tone="bad" label={`Late or past-due account${lates.length === 1 ? '' : 's'}`} value={lates.length} />
            {otherBad.length > 0 && <StatFigure tone="bad" label={`Charge-off${otherBad.length === 1 ? '' : 's'} and other negative`} value={otherBad.length} />}
            {owedInCollections > 0 && <StatFigure tone="bad" label="In collections" value={money(owedInCollections)} />}
          </div>
          <p className="mt-3 text-sm text-muted">{pending ? 'Approve this report to turn these into dispute suggestions for the client.' : <>These are on the client’s <Link className="link" href={`/app/clients/${r.client_id}/compare`}>dispute suggestions</Link>.</>}</p>
        </section>
      ) : tradelines.length > 0 && (
        <div className="mt-6"><Notice tone="ok" title="No negative items">No collections, late payments or charge-offs were read from this report.</Notice></div>
      )}
      {r.warnings.length > 0 && <div className="mt-4"><Notice tone="warn" title="Import notes"><ul className="list-disc pl-5">{r.warnings.map((w) => <li key={w}>{w}</li>)}</ul></Notice></div>}

      <div className="mt-8">
        <h2 className="mb-3 text-lg font-semibold">Accounts <span className="text-sm font-normal text-muted">({tradelines.length})</span></h2>
        {tradelines.length === 0 && <EmptyState title="No accounts in this report" body="Only inquiries, public records or identity lines were found." />}
        {/* One divided list, not a box per account: who it is and whether it read cleanly, four figures to check
            against the original, and everything else (plus the edit form) behind one disclosure. */}
        {tradelines.length > 0 && (
          <ul className="panel divide-y divide-line/70">
            {tradelines.map((t) => {
              const low = lowConfidenceFields(t);
              const kl = labels.get(t.id)!;
              const neg = isColl(t) || isBadKind(kl.kind);
              const statuses = [t.item_type === 'collection' ? 'Collection' : 'Account', t.item_type === 'collection' ? t.account_status?.replace(/^collection(?: account)?[:.]?\s*/i, '') || null : t.account_status, t.payment_status, t.original_creditor ? `original creditor ${t.original_creditor}` : null].filter((v, i, all) => !!v && all.findIndex((o) => o?.toLowerCase() === v.toLowerCase()) === i).join(' · ');
              return (
                <li key={t.id} className={neg ? 'border-l-4 border-bad bg-bad-soft/25 px-5 py-4 sm:px-6' : 'px-5 py-4 sm:px-6'}>
                  <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
                    <div className="min-w-0">
                      <h3 className={`${neg ? 'text-base font-semibold text-bad' : 'text-[0.9375rem] font-semibold'} leading-snug [overflow-wrap:anywhere]`}>{t.creditor_name} {t.account_last4 && <span className="font-normal text-muted">••{t.account_last4}</span>}</h3>
                      <p className="mt-0.5 text-[0.8125rem] text-muted">{statuses}</p>
                      <p className="mt-0.5 text-[0.8125rem] text-muted [overflow-wrap:anywhere]">{labelBasis(kl)}</p>
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <KindBadge label={kl} />
                      {/* A badge is one line. A reader that holds every field for review (TransUnion's does) would make
                          it wider than a phone, so past two fields it gives the count; each field is listed just below. */}
                      {low.length > 0 ? <Badge tone="warn"><AlertTriangle size={12} aria-hidden /> Confirm {low.length > 2 ? `${low.length} fields` : low.map(fieldLabel).join(', ')}</Badge> : <Badge tone="ok"><CheckCircle2 size={12} aria-hidden /> Read cleanly</Badge>}
                      {t.user_provided.not_mine && <Badge tone="info">Client: not recognised</Badge>}
                      {t.user_provided.never_late && <Badge tone="info">Client: never late</Badge>}
                    </div>
                  </div>
                  <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-4">
                    {([['Balance', money(t.balance_cents)], ['Credit limit', money(t.credit_limit_cents)], ['Opened', fmtDate(t.date_opened)], ['Reported', fmtDate(t.date_reported)]] as const).map(([k, v]) => (
                      <div key={k}><dt className="text-xs text-muted">{k}</dt><dd className="text-sm tabular-nums">{v}</dd></div>))}
                  </dl>
                  <FallOffNote fallOff={tradelineFallOff(t)} className="mt-2" />
                  {low.length > 0 && (
                    <div className="mt-3 rounded-xl bg-warn-soft p-3 text-xs text-ink">
                      {low.map((f) => <p key={f}><strong className="text-warn">{fieldLabel(f)}</strong>: source line “{t.field_meta[f]?.snippet}”</p>)}
                    </div>
                  )}
                  <details className="group mt-3">
                    <summary className="flex w-fit cursor-pointer list-none items-center gap-1 rounded-md text-[0.8125rem] font-semibold text-brand-strong [&::-webkit-details-marker]:hidden">More fields · edit or confirm <ChevronDown size={15} aria-hidden className="transition-transform group-open:rotate-180" /></summary>
                    <div className="mt-3">
                      <DefinitionList items={[['Account status', t.account_status], ['Payment status', t.payment_status], ['First delinquency', fmtDate(t.date_of_first_delinquency)], ['Payment history', t.payment_history]]} />
                    </div>
                    <ActionForm action={updateTradelineAction} className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                      <input type="hidden" name="id" value={t.id} /><input type="hidden" name="reportId" value={r.id} />
                      <Field label="Creditor" name="creditor" defaultValue={t.creditor_name} required className="lg:col-span-2" />
                      <Field label="Account last 4" name="last4" defaultValue={t.account_last4} maxLength={4} />
                      <Field label="Account status" name="accountStatus" defaultValue={t.account_status} />
                      <Field label="Payment status" name="paymentStatus" defaultValue={t.payment_status} />
                      <Field label="Payment history" name="history" defaultValue={t.payment_history} />
                      <Field label="Balance ($)" name="balance" defaultValue={t.balance_cents != null ? (t.balance_cents / 100).toFixed(2) : ''} inputMode="decimal" />
                      <Field label="Credit limit ($)" name="limit" defaultValue={t.credit_limit_cents != null ? (t.credit_limit_cents / 100).toFixed(2) : ''} inputMode="decimal" />
                      <Field label="Date opened" name="opened" type="date" defaultValue={t.date_opened} />
                      <Field label="Date reported" name="reported" type="date" defaultValue={t.date_reported} />
                      <Field label="First delinquency" name="dofd" type="date" defaultValue={t.date_of_first_delinquency} />
                      <div className="space-y-2 sm:col-span-2 lg:col-span-3">
                        <p className="text-sm font-semibold">What the client tells us <span className="font-normal text-muted">(kept separate from the report)</span></p>
                        <Check name="notMine" defaultChecked={!!t.user_provided.not_mine}>Client does not recognise this account</Check>
                        <Check name="neverLate" defaultChecked={!!t.user_provided.never_late}>Client says every payment was on time</Check>
                      </div>
                      <div className="flex gap-2 sm:col-span-2 lg:col-span-3"><SubmitButton>Save & confirm</SubmitButton></div>
                    </ActionForm>
                    {pending && (
                      <form action={deleteTradelineAction} className="mt-2">
                        <input type="hidden" name="id" value={t.id} /><input type="hidden" name="reportId" value={r.id} />
                        <ConfirmButton className="text-xs font-medium text-bad underline" message={`Remove ${t.creditor_name} from this report? Use this only for a row that was misread. It cannot be undone.`}>Remove (misread row)</ConfirmButton>
                      </form>
                    )}
                  </details>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="mt-10 grid gap-x-8 gap-y-6 lg:grid-cols-3">
        <Section plain title={`Inquiries (${inquiries.length})`}>
          {inquiries.length ? <ul className="divide-y divide-line/70 text-sm">{inquiries.map((i, n) => <li key={n} className="flex justify-between gap-3 py-2"><span>{i.name}</span><span className="text-muted">{fmtDate(i.inquiry_date)}</span></li>)}</ul> : <p className="text-sm text-muted">None found.</p>}
        </Section>
        <Section plain title={`Public records (${records.length})`}>
          {records.length ? <ul className="divide-y divide-line/70 text-sm">{records.map((x, n) => <li key={n} className="py-2"><div className="font-medium">{x.kind}</div><div className="text-muted">{x.court ?? '—'} · {fmtDate(x.filed_date)} · {money(x.amount_cents)}</div><FallOffNote fallOff={publicRecordFallOff(x)} missing="no filing date reported" className="mt-0.5" /></li>)}</ul> : <p className="text-sm text-muted">None found.</p>}
        </Section>
        <Section plain title={`Personal information (${identity.length})`}>
          {identity.length ? <ul className="divide-y divide-line/70 text-sm">{identity.map((x, n) => <li key={n} className="py-2"><span className="text-xs text-muted">{label(x.kind)}</span><div>{x.value}</div></li>)}</ul> : <p className="text-sm text-muted">None found.</p>}
        </Section>
      </div>

      {pending && (
        <div className="sticky bottom-4 mt-8 flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-raised p-4 shadow-pop">
          <p className="text-sm text-muted">Approving flags every negative item and runs the cross-bureau comparison for this client.</p>
          <div className="flex gap-2">
            <form action={decideReportAction}><input type="hidden" name="id" value={r.id} /><input type="hidden" name="mark" value={mark} /><input type="hidden" name="decision" value="rejected" /><ConfirmButton className="btn-secondary" message="Reject this report? This is final: it will not be used, and the same file cannot be read again. To try again you would upload the report as a new file.">Reject</ConfirmButton></form>
            <form action={decideReportAction}><input type="hidden" name="id" value={r.id} /><input type="hidden" name="mark" value={mark} /><input type="hidden" name="decision" value="approved" /><button className="btn-primary" type="submit">Approve & flag negatives</button></form>
          </div>
        </div>
      )}
    </>
  );
}
