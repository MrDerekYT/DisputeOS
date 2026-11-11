import Link from 'next/link';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Check, Eye, Gavel, RefreshCw, X } from 'lucide-react';
import { Badge, EmptyState, Notice, PageHeader, StatusBadge } from '@/components/ui';
import { requireStaff } from '@/lib/auth/context';
import { diffGroup, groupAccounts, SEVERITY_ORDER, FINDING_CATEGORIES, type AnalysisTradeline, type Evidence, type FindingCategory } from '@/lib/reports/analysis';
import { loadAnalysisInput } from '@/lib/reports/service';
import { BUREAU_LABEL, BUREAUS, cn, fmtDate, isUuid, money, type Bureau } from '@/lib/util';
import { refreshFindingsAction, setFindingStatusAction } from '../../../reports/actions';
import { bulkDraftAction } from '../../../disputes/actions';

export const metadata: Metadata = { title: 'Three-bureau comparison' };

interface FindingRow { id: string; category: FindingCategory; severity: 'info' | 'review' | 'strong'; title: string; explanation: string; evidence: Evidence[]; basis: string; status: string; tradeline_ids: string[] }

const BASIS_LABEL: Record<string, { text: string; tone: 'ok' | 'info' | 'warn'; hint: string }> = {
  verified_fact: { text: 'Reported fact', tone: 'ok', hint: 'Shown exactly as a bureau reports it' },
  user_provided: { text: 'Client-provided', tone: 'info', hint: 'Comes from what the client told us — not verified' },
  potential_discrepancy: { text: 'Potential discrepancy', tone: 'warn', hint: 'A difference worth checking — not proof of an error' },
};

export default async function ComparePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ drafted?: string; skipped?: string; why?: string; bulk?: string }> }) {
  const { id } = await params;
  const sp = await searchParams;
  if (!isUuid(id)) notFound();
  const ctx = await requireStaff('clients:read');
  const data = await ctx.tx(async (db) => {
    const c = await db.row<{ id: string; full_name: string }>('select id, full_name from public.clients where id = $1', [id]);
    if (!c) return null;
    const input = await loadAnalysisInput(db, id);
    const findings = await db.rows<FindingRow>(
      `select id, category, severity, title, explanation, evidence, basis, status, tradeline_ids from public.findings where client_id = $1 and status <> 'dismissed' order by created_at`, [id]);
    const pending = await db.row<{ n: number }>("select count(*)::int as n from public.credit_reports where client_id = $1 and status = 'pending_review'", [id]);
    return { c, input, findings, pending: pending?.n ?? 0 };
  });
  if (!data) notFound();
  const { c, input, findings, pending } = data;
  const canDispute = ctx.can('disputes:write');
  const groups = groupAccounts(input.tradelines);
  const have = new Set(input.reports.map((r) => r.bureau));
  findings.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);

  const fieldRows: { label: string; get: (t: AnalysisTradeline) => string | null; field: string }[] = [
    { label: 'Balance', field: 'balance_cents', get: (t) => (t.balance_cents == null ? null : money(t.balance_cents)) },
    { label: 'Account status', field: 'account_status', get: (t) => t.account_status },
    { label: 'Payment status', field: 'payment_status', get: (t) => t.payment_status },
    { label: 'Credit limit', field: 'credit_limit_cents', get: (t) => (t.credit_limit_cents == null ? null : money(t.credit_limit_cents)) },
    { label: 'Opened', field: 'date_opened', get: (t) => (t.date_opened ? fmtDate(t.date_opened) : null) },
    { label: 'First delinquency', field: 'date_of_first_delinquency', get: (t) => (t.date_of_first_delinquency ? fmtDate(t.date_of_first_delinquency) : null) },
    { label: 'Reported', field: 'date_reported', get: (t) => (t.date_reported ? fmtDate(t.date_reported) : null) },
  ];

  return (
    <>
      <PageHeader title="Three-bureau comparison" subtitle={<>For <Link className="underline" href={`/app/clients/${id}`}>{c.full_name}</Link>. Differences are things to look into — a difference alone does not mean anything is inaccurate.</>}
        back={{ href: `/app/clients/${id}?tab=reports`, label: c.full_name }}
        actions={<form action={refreshFindingsAction}><input type="hidden" name="clientId" value={id} /><button className="btn-secondary" type="submit"><RefreshCw size={15} /> Re-run analysis</button></form>} />

      <div className="mb-5 flex flex-wrap items-center gap-2 text-sm">
        {BUREAUS.map((b) => <Badge key={b} tone={have.has(b) ? 'ok' : 'neutral'} dot>{BUREAU_LABEL[b]}: {have.has(b) ? 'approved report' : 'not uploaded'}</Badge>)}
        {pending > 0 && <Badge tone="warn">{pending} report{pending > 1 ? 's' : ''} awaiting review</Badge>}
      </div>

      {!input.reports.length ? (
        <EmptyState title="No approved reports yet" body="Upload each bureau’s report and approve it after review. The comparison appears here." action={<Link href={`/app/clients/${id}?tab=reports`} className="btn-primary">Go to reports</Link>} />
      ) : (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-x-5 gap-y-1 text-xs text-muted" aria-label="Legend">
            <span className="flex items-center gap-1.5"><span className="h-3 w-3 rounded bg-warn-soft ring-1 ring-warn/40" /> differs from another bureau</span>
            <span className="flex items-center gap-1.5"><span className="h-3 w-3 rounded bg-raised ring-1 ring-line" /> as reported</span>
            <span className="flex items-center gap-1.5"><Badge tone="info">Client says</Badge> from the client, unverified</span>
          </div>

          <div className="space-y-4">
            {groups.map((g) => {
              const diffs = new Set(diffGroup(g).map((d) => d.field as string));
              return (
                <article key={g.key} className="card overflow-hidden">
                  <header className="flex flex-wrap items-center justify-between gap-2 border-b border-line bg-raised px-4 py-3">
                    <div className="font-semibold">{g.creditor} <span className="font-normal text-muted">{g.byBureau[BUREAUS.find((b) => g.byBureau[b])!]?.account_last4 && `••${g.byBureau[BUREAUS.find((b) => g.byBureau[b])!]!.account_last4}`}</span></div>
                    <div className="flex items-center gap-2">
                      {g.itemType === 'collection' && <Badge tone="bad">Collection</Badge>}
                      {diffs.size > 0 && <Badge tone="warn">{diffs.size} difference{diffs.size > 1 ? 's' : ''}</Badge>}
                    </div>
                  </header>
                  <div className="grid divide-line md:grid-cols-3 md:divide-x">
                    {BUREAUS.map((b: Bureau) => {
                      const t = g.byBureau[b];
                      return (
                        <div key={b} className={cn('min-w-0 p-4', !have.has(b) && 'bg-raised/60')}>
                          <div className="mb-3 flex items-center justify-between">
                            <span className="text-sm font-semibold">{BUREAU_LABEL[b]}</span>
                            {t && <Link href={`/app/disputes/new?clientId=${id}&tradelineId=${t.id}`} className="btn-ghost btn-sm !px-2" title={`Start a dispute with ${BUREAU_LABEL[b]}`}><Gavel size={14} /> Dispute</Link>}
                          </div>
                          {!t ? (
                            <p className="text-sm text-muted">{have.has(b) ? 'Not reported on this bureau’s approved report.' : 'No report uploaded for this bureau.'}</p>
                          ) : (
                            <dl className="space-y-1.5 text-sm">
                              {fieldRows.map((f) => {
                                const v = f.get(t);
                                const differs = diffs.has(f.field) && v;
                                return (
                                  <div key={f.field} className={cn('flex justify-between gap-3 rounded-lg px-2 py-1', differs ? 'bg-warn-soft ring-1 ring-warn/30' : '')}>
                                    <dt className="text-muted">{f.label}</dt>
                                    <dd className={cn('text-right font-medium tabular-nums', !v && 'font-normal text-faint')}>{v ?? '—'}</dd>
                                  </div>
                                );
                              })}
                              {t.payment_history && <div className="px-2 pt-1 font-mono text-xs text-muted">History: {t.payment_history}</div>}
                              {(t.user_provided.not_mine === true || t.user_provided.never_late === true) && (
                                <div className="flex flex-wrap gap-1 px-2 pt-1">
                                  {t.user_provided.not_mine === true && <Badge tone="info">Client says: not recognised</Badge>}
                                  {t.user_provided.never_late === true && <Badge tone="info">Client says: never late</Badge>}
                                </div>
                              )}
                            </dl>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </article>
              );
            })}
            {groups.length === 0 && <EmptyState title="No accounts in the approved reports" />}
          </div>

          <section className="mt-10" aria-labelledby="findings">
            <div className="mb-4 flex flex-wrap items-end justify-between gap-2">
              <div><h2 id="findings" className="text-lg font-semibold">Findings to review ({findings.length})</h2><p className="text-sm text-muted">Each one shows exactly which reported values it rests on.</p></div>
              <div className="flex flex-wrap gap-2">{Object.entries(BASIS_LABEL).map(([k, v]) => <span key={k} className="flex items-center gap-1.5 text-xs text-muted"><Badge tone={v.tone}>{v.text}</Badge>{v.hint}</span>)}</div>
            </div>
            {sp.drafted != null && Number(sp.drafted) > 0 && <div className="mb-4"><Notice tone="ok" title={`${Number(sp.drafted)} dispute${Number(sp.drafted) === 1 ? '' : 's'} drafted`}>Each is a draft with the reason written from its evidence. Read and edit each one, then send it for review — nothing is submitted until it is approved. <Link className="font-medium underline" href="/app/disputes?view=table&status=draft">Open the drafts</Link>{Number(sp.skipped) > 0 && <> · {Number(sp.skipped)} skipped{sp.why ? ` (${sp.why})` : ''}</>}</Notice></div>}
            {sp.drafted === '0' && <div className="mb-4"><Notice tone="warn" title="Nothing was drafted">{sp.why ?? 'The selected findings could not be drafted automatically.'}</Notice></div>}
            {sp.bulk === 'none' && <div className="mb-4"><Notice tone="warn" title="Select at least one finding">Tick the findings you and the client agreed to pursue, then draft.</Notice></div>}
            {sp.bulk === 'error' && <div className="mb-4"><Notice tone="warn" title="Could not draft">{sp.why}</Notice></div>}
            {canDispute && findings.some((f) => f.status !== 'disputed') && (
              <form id="bulk" action={bulkDraftAction} className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-line bg-raised p-4">
                <input type="hidden" name="clientId" value={id} />
                <p className="text-sm"><strong>Draft several at once.</strong> <span className="text-muted">Tick the findings to pursue. One draft dispute is created per finding — a person still reviews and approves each before anything is sent.</span></p>
                <button className="btn-primary btn-sm"><Gavel size={14} /> Draft disputes for selected</button>
              </form>
            )}
            {findings.length === 0 ? <Notice tone="ok">Nothing to flag. The approved reports agree with each other and nothing looks out of the ordinary.</Notice> : (
              <ul className="space-y-3">
                {findings.map((f) => {
                  const basis = BASIS_LABEL[f.basis]!;
                  return (
                    <li key={f.id} className="card card-pad">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="mb-1.5 flex flex-wrap items-center gap-2">
                            {canDispute && f.status !== 'disputed' && <label className="flex items-center gap-1.5 text-xs font-medium"><input type="checkbox" form="bulk" name="finding" value={f.id} className="h-4 w-4 rounded border-line accent-[rgb(var(--brand))]" /> Select</label>}
                            <Badge tone={basis.tone}>{basis.text}</Badge>
                            <Badge>{FINDING_CATEGORIES[f.category] ?? f.category}</Badge>
                            {f.severity === 'strong' && <Badge tone="warn">Worth a close look</Badge>}
                            {f.status !== 'suggested' && <StatusBadge status={f.status} />}
                          </div>
                          <h3 className="font-medium">{f.title}</h3>
                          <p className="mt-1 text-sm text-muted">{f.explanation}</p>
                          <details className="mt-3">
                            <summary className="cursor-pointer text-xs font-medium text-brand-strong">What this is based on ({f.evidence.length})</summary>
                            <ul className="mt-2 space-y-1 rounded-xl bg-raised p-3 text-xs">
                              {f.evidence.map((e, i) => (
                                <li key={i} className="flex flex-wrap gap-x-2">
                                  <span className="font-semibold">{e.bureau ? BUREAU_LABEL[e.bureau] : e.source === 'client' ? 'Client' : 'Derived'}</span>
                                  <span className="text-muted">{e.field}:</span> <span>{e.value}</span>
                                  <span className="text-faint">({e.source === 'reported' ? 'as reported' : e.source === 'client' ? 'client statement' : 'computed from reported dates'})</span>
                                </li>
                              ))}
                            </ul>
                          </details>
                        </div>
                        <div className="flex shrink-0 flex-col gap-2">
                          {f.status !== 'disputed' && <Link href={`/app/disputes/new?clientId=${id}&findingId=${f.id}`} className="btn-primary btn-sm"><Gavel size={14} /> Start dispute</Link>}
                          <div className="flex gap-1.5">
                            <form action={setFindingStatusAction}><input type="hidden" name="id" value={f.id} /><input type="hidden" name="clientId" value={id} /><input type="hidden" name="status" value="accepted" /><button className="btn-secondary btn-sm" title="Mark as worth pursuing"><Check size={14} /> Keep</button></form>
                            <form action={setFindingStatusAction}><input type="hidden" name="id" value={f.id} /><input type="hidden" name="clientId" value={id} /><input type="hidden" name="status" value="dismissed" /><button className="btn-ghost btn-sm" title="Not relevant"><X size={14} /> Dismiss</button></form>
                          </div>
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </>
      )}
      <p className="mt-6 flex items-center gap-2 text-xs text-muted"><Eye size={14} /> Analysis uses only the most recent approved report from each bureau.</p>
    </>
  );
}
