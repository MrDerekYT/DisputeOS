import Link from 'next/link';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import { ActionForm, Check, Field, SubmitButton } from '@/components/forms';
import { Badge, DefinitionList, EmptyState, Notice, PageHeader, Section, StatusBadge } from '@/components/ui';
import { requireStaff } from '@/lib/auth/context';
import { lowConfidenceFields } from '@/lib/reports/parser';
import type { FieldMeta } from '@/lib/reports/types';
import { BUREAU_LABEL, fmtDate, isUuid, money, type Bureau } from '@/lib/util';
import { decideReportAction, deleteTradelineAction, updateTradelineAction } from '../actions';
import { PRODUCT } from '@/lib/product';

export const metadata: Metadata = { title: 'Review report' };

interface TL {
  id: string; creditor_name: string; original_creditor: string | null; account_last4: string | null; item_type: string; account_status: string | null; payment_status: string | null;
  balance_cents: number | null; credit_limit_cents: number | null; date_opened: string | null; date_reported: string | null; date_of_first_delinquency: string | null;
  payment_history: string | null; confidence: number; field_meta: Record<string, FieldMeta>; user_provided: { not_mine?: boolean; never_late?: boolean };
}

export default async function ReportReview({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const ctx = await requireStaff('clients:read');
  const data = await ctx.tx(async (db) => {
    const r = await db.row<{ id: string; client_id: string; bureau: Bureau; status: string; report_date: string | null; source: string; warnings: string[]; client_name: string; created_at: string; document_id: string | null }>(
      `select r.id, r.client_id, r.bureau, r.status, r.report_date, r.source, r.warnings, r.created_at, r.document_id, c.full_name as client_name from public.credit_reports r join public.clients c on c.id = r.client_id where r.id = $1`, [id]);
    if (!r) return null;
    const [tradelines, inquiries, records, identity] = await Promise.all([
      db.rows<TL>(`select id, creditor_name, original_creditor, account_last4, item_type, account_status, payment_status, balance_cents, credit_limit_cents, date_opened, date_reported, date_of_first_delinquency, payment_history, confidence, field_meta, user_provided from public.tradelines where report_id = $1 order by item_type, creditor_name`, [id]),
      db.rows<{ name: string; inquiry_date: string | null }>('select name, inquiry_date from public.inquiries where report_id = $1 order by inquiry_date desc nulls last', [id]),
      db.rows<{ kind: string; court: string | null; amount_cents: number | null; filed_date: string | null }>('select kind, court, amount_cents, filed_date from public.public_records where report_id = $1', [id]),
      db.rows<{ kind: string; value: string }>('select kind, value from public.report_identity_items where report_id = $1 order by kind', [id]),
    ]);
    return { r, tradelines, inquiries, records, identity };
  });
  if (!data) notFound();
  const { r, tradelines, inquiries, records, identity } = data;
  const pending = r.status === 'pending_review';
  const needsConfirm = tradelines.filter((t) => lowConfidenceFields(t).length > 0).length;

  return (
    <>
      <PageHeader
        title={`${BUREAU_LABEL[r.bureau]} report`}
        subtitle={<>For <Link className="underline" href={`/app/clients/${r.client_id}`}>{r.client_name}</Link> · report date {fmtDate(r.report_date)} · imported {fmtDate(r.created_at)} via {r.source}</>}
        back={{ href: `/app/clients/${r.client_id}?tab=reports`, label: r.client_name }}
        actions={<StatusBadge status={r.status} />}
      />

      {pending ? (
        <Notice tone="warn" title="Review before this is used">
          {PRODUCT.name} read this file automatically and can make mistakes. Check each account below against the original, correct anything that is off, then approve. Nothing is analysed or disputed until a person approves the report.
          {needsConfirm > 0 && <> <strong>{needsConfirm} account{needsConfirm > 1 ? 's have' : ' has'} fields with low confidence.</strong></>}
        </Notice>
      ) : (
        <Notice tone={r.status === 'approved' ? 'ok' : 'neutral'} title={r.status === 'approved' ? 'Approved' : 'Rejected'}>
          {r.status === 'approved' ? <>This report feeds the <Link className="underline" href={`/app/clients/${r.client_id}/compare`}>three-bureau comparison</Link>.</> : 'This report is not used for analysis.'}
        </Notice>
      )}
      {r.warnings.length > 0 && <div className="mt-4"><Notice tone="warn" title="Import notes"><ul className="list-disc pl-5">{r.warnings.map((w) => <li key={w}>{w}</li>)}</ul></Notice></div>}

      <div className="mt-6 space-y-4">
        <h2 className="text-lg font-semibold">Accounts <span className="text-sm font-normal text-muted">({tradelines.length})</span></h2>
        {tradelines.length === 0 && <EmptyState title="No accounts in this report" body="Only inquiries, public records or identity lines were found." />}
        {tradelines.map((t) => {
          const low = lowConfidenceFields(t);
          return (
            <article key={t.id} className="card card-pad">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="font-semibold">{t.creditor_name} {t.account_last4 && <span className="font-normal text-muted">••{t.account_last4}</span>}</h3>
                  <p className="text-xs text-muted">{t.item_type === 'collection' ? 'Collection' : 'Account'}{t.original_creditor ? ` · original creditor ${t.original_creditor}` : ''}</p>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  {low.length > 0 ? <Badge tone="warn"><AlertTriangle size={12} /> Confirm {low.map((f) => f.replace(/_/g, ' ')).join(', ')}</Badge> : <Badge tone="ok"><CheckCircle2 size={12} /> Read cleanly</Badge>}
                  {t.user_provided.not_mine && <Badge tone="info">Client: not recognised</Badge>}
                  {t.user_provided.never_late && <Badge tone="info">Client: never late</Badge>}
                </div>
              </div>
              <div className="mt-4">
                <DefinitionList items={[
                  ['Account status', t.account_status], ['Payment status', t.payment_status], ['Balance', money(t.balance_cents)], ['Credit limit', money(t.credit_limit_cents)],
                  ['Opened', fmtDate(t.date_opened)], ['Reported', fmtDate(t.date_reported)], ['First delinquency', fmtDate(t.date_of_first_delinquency)], ['Payment history', t.payment_history],
                ]} />
              </div>
              {low.length > 0 && (
                <div className="mt-4 rounded-xl bg-warn-soft p-3 text-xs text-warn">
                  {low.map((f) => <p key={f}><strong>{f.replace(/_/g, ' ')}</strong>: source line “{t.field_meta[f]?.snippet}”</p>)}
                </div>
              )}
              <details className="group mt-4">
                <summary className="btn-secondary btn-sm w-fit cursor-pointer list-none">Edit / confirm</summary>
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
                    <p className="text-xs font-semibold uppercase tracking-wide text-muted">What the client tells us (kept separate from the report)</p>
                    <Check name="notMine" defaultChecked={!!t.user_provided.not_mine}>Client does not recognise this account</Check>
                    <Check name="neverLate" defaultChecked={!!t.user_provided.never_late}>Client says every payment was on time</Check>
                  </div>
                  <div className="flex gap-2 sm:col-span-2 lg:col-span-3"><SubmitButton>Save & confirm</SubmitButton></div>
                </ActionForm>
                {pending && (
                  <form action={deleteTradelineAction} className="mt-2">
                    <input type="hidden" name="id" value={t.id} /><input type="hidden" name="reportId" value={r.id} />
                    <button className="text-xs text-bad underline" type="submit">Remove (misread row)</button>
                  </form>
                )}
              </details>
            </article>
          );
        })}
      </div>

      <div className="mt-8 grid gap-4 lg:grid-cols-3">
        <Section title={`Inquiries (${inquiries.length})`}>
          {inquiries.length ? <ul className="divide-y divide-line text-sm">{inquiries.map((i, n) => <li key={n} className="flex justify-between gap-3 py-2"><span>{i.name}</span><span className="text-muted">{fmtDate(i.inquiry_date)}</span></li>)}</ul> : <p className="text-sm text-muted">None found.</p>}
        </Section>
        <Section title={`Public records (${records.length})`}>
          {records.length ? <ul className="divide-y divide-line text-sm">{records.map((x, n) => <li key={n} className="py-2"><div className="font-medium">{x.kind}</div><div className="text-muted">{x.court ?? '—'} · {fmtDate(x.filed_date)} · {money(x.amount_cents)}</div></li>)}</ul> : <p className="text-sm text-muted">None found.</p>}
        </Section>
        <Section title={`Personal information (${identity.length})`}>
          {identity.length ? <ul className="divide-y divide-line text-sm">{identity.map((x, n) => <li key={n} className="py-2"><span className="text-xs uppercase text-muted">{x.kind}</span><div>{x.value}</div></li>)}</ul> : <p className="text-sm text-muted">None found.</p>}
        </Section>
      </div>

      {pending && (
        <div className="sticky bottom-4 mt-8 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-line bg-surface/95 p-4 shadow-pop backdrop-blur">
          <p className="text-sm text-muted">Approving runs the cross-bureau analysis for this client.</p>
          <div className="flex gap-2">
            <form action={decideReportAction}><input type="hidden" name="id" value={r.id} /><input type="hidden" name="decision" value="rejected" /><button className="btn-secondary" type="submit">Reject</button></form>
            <form action={decideReportAction}><input type="hidden" name="id" value={r.id} /><input type="hidden" name="decision" value="approved" /><button className="btn-primary" type="submit">Approve report</button></form>
          </div>
        </div>
      )}
    </>
  );
}
