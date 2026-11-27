import Link from 'next/link';
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import { ArrowDown, Check, Eye, Gavel, RefreshCw, X } from 'lucide-react';
import { Badge, EmptyState, Notice, PageHeader, StatusBadge } from '@/components/ui';
import { requireStaff } from '@/lib/auth/context';
import { analyze, diffGroup, groupAccounts, SEVERITY_ORDER, FINDING_CATEGORIES, type AnalysisTradeline, type Evidence, type FindingCategory } from '@/lib/reports/analysis';
import { loadAnalysisInput, regenerateFindings } from '@/lib/reports/service';
import { BUREAU_LABEL, BUREAUS, cn, fmtDate, isUuid, money, type Bureau } from '@/lib/util';
import { refreshFindingsAction, setFindingStatusAction } from '../../../reports/actions';
import { bulkDraftAction } from '../../../disputes/actions';
import { FallOffCell } from '@/components/fall-off';
import { tradelineFallOff } from '@/lib/credit/reporting-period';

export const metadata: Metadata = { title: 'Three-bureau comparison' };

interface FindingRow { id: string; category: FindingCategory; severity: 'info' | 'review' | 'strong'; title: string; explanation: string; evidence: Evidence[]; basis: string; status: string; tradeline_ids: string[]; dedupe_key: string; generated_by: string }

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
    const c = await db.row<{ id: string; full_name: string; address: { line1?: string } | null }>('select id, full_name, address from public.clients where id = $1', [id]);
    if (!c) return null;
    const input = await loadAnalysisInput(db, id);
    const load = () => db.rows<FindingRow>(
      `select id, category, severity, title, explanation, evidence, basis, status, tradeline_ids, dedupe_key, generated_by from public.findings where client_id = $1 order by created_at`, [id]);
    let all = await load();
    // The stored flags against what the approved reports say today. They fall behind when an account is edited after
    // approval, when the client adds a statement, or simply as time passes (an item that was inside its reporting
    // period last month may be past it now). Whoever may edit reports gets them brought up to date on opening the
    // page; anyone else is told they are behind. Reviewed flags are never touched (regenerateFindings).
    const address = c.address?.line1 ?? '';
    const fresh = new Set(analyze({ ...input, clientName: c.full_name, clientAddress: address }).map((f) => f.dedupe_key));
    const stored = new Set(all.map((f) => f.dedupe_key));
    let behind = [...fresh].filter((k) => !stored.has(k)).length + all.filter((f) => f.status === 'suggested' && f.generated_by === 'rules' && !fresh.has(f.dedupe_key)).length;
    if (behind > 0 && ctx.can('reports:write')) {
      await regenerateFindings(db, ctx, id, c.full_name, address);
      all = await load();
      behind = 0;
    }
    const findings = all.filter((f) => f.status !== 'dismissed');
    const dismissed = all.filter((f) => f.status === 'dismissed');
    const pending = await db.row<{ n: number }>("select count(*)::int as n from public.credit_reports where client_id = $1 and status = 'pending_review'", [id]);
    return { c, input, findings, dismissed, pending: pending?.n ?? 0, behind };
  });
  if (!data) notFound();
  const { c, input, findings, dismissed, pending, behind } = data;
  const canDispute = ctx.can('disputes:write');
  const groups = groupAccounts(input.tradelines);
  const have = new Set(input.reports.map((r) => r.bureau));
  // Negative items (collections, late payments, charge-offs, old items) first, then by severity.
  const NEG = new Set(['collection_validation', 'negative_item', 'obsolete_item']);
  findings.sort((a, b) => Number(NEG.has(b.category)) - Number(NEG.has(a.category)) || SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  const negativeCount = findings.filter((f) => NEG.has(f.category)).length;

  // `short` is the label on a phone, where the label column is narrow and a long word would break mid-word.
  const fieldRows: { label: string; short?: string; get: (t: AnalysisTradeline) => string | null; field: string }[] = [
    { label: 'Balance', field: 'balance_cents', get: (t) => (t.balance_cents == null ? null : money(t.balance_cents)) },
    { label: 'Account status', field: 'account_status', get: (t) => t.account_status },
    { label: 'Payment status', field: 'payment_status', get: (t) => t.payment_status },
    { label: 'Credit limit', field: 'credit_limit_cents', get: (t) => (t.credit_limit_cents == null ? null : money(t.credit_limit_cents)) },
    { label: 'Opened', field: 'date_opened', get: (t) => (t.date_opened ? fmtDate(t.date_opened) : null) },
    { label: 'First delinquency', short: 'First delinq.', field: 'date_of_first_delinquency', get: (t) => (t.date_of_first_delinquency ? fmtDate(t.date_of_first_delinquency) : null) },
    { label: 'Reported', field: 'date_reported', get: (t) => (t.date_reported ? fmtDate(t.date_reported) : null) },
  ];

  return (
    <>
      <PageHeader title="Three-bureau comparison" subtitle={<>For <Link className="link" href={`/app/clients/${id}`}>{c.full_name}</Link>. Differences are things to look into — a difference alone does not mean anything is inaccurate.</>}
        back={{ href: `/app/clients/${id}?tab=reports`, label: c.full_name }}
        actions={<form action={refreshFindingsAction}><input type="hidden" name="clientId" value={id} /><button className="btn-secondary" type="submit"><RefreshCw size={15} aria-hidden /> Re-run analysis</button></form>} />

      {findings.length > 0 && (
        <a href="#findings" className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-2xl border-l-4 border-bad bg-bad-soft/40 px-5 py-3.5 text-ink no-underline transition-colors hover:bg-bad-soft/70">
          <span><span className="block font-semibold text-bad">{negativeCount} negative item{negativeCount === 1 ? '' : 's'} · {findings.length} flag{findings.length === 1 ? '' : 's'} to review</span>
            <span className="text-sm text-muted">Start disputes from the flags below the account table.</span></span>
          <span className="btn-secondary btn-sm shrink-0">Go to flags <ArrowDown size={14} aria-hidden /></span>
        </a>
      )}
      <div className="mb-5 flex flex-wrap items-center gap-2 text-sm">
        {BUREAUS.map((b) => <Badge key={b} tone={have.has(b) ? 'ok' : 'neutral'} dot>{BUREAU_LABEL[b]}: {have.has(b) ? 'approved report' : 'not uploaded'}</Badge>)}
        {pending > 0 && <Badge tone="warn">{pending} report{pending > 1 ? 's' : ''} awaiting review</Badge>}
      </div>

      {!input.reports.length ? (
        <EmptyState title="No approved reports yet" body="Upload each bureau’s report and approve it after review. The comparison appears here." action={<Link href={`/app/clients/${id}?tab=reports`} className="btn-primary">Go to reports</Link>} />
      ) : (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-x-5 gap-y-1 text-xs text-muted" aria-label="Legend">
            <span className="flex items-center gap-1.5"><span aria-hidden className="grid h-5 w-5 place-items-center rounded bg-warn-soft text-[0.8125rem] font-semibold text-warn">≠</span> differs from another bureau</span>
            <span className="flex items-center gap-1.5"><Badge tone="info">Client says</Badge> from the client, unverified</span>
          </div>

          <div className="space-y-4">
            {groups.map((g) => {
              const diffs = new Set(diffGroup(g).map((d) => d.field as string));
              return (
                <article key={g.key} className="panel overflow-hidden">
                  <header className="flex flex-wrap items-center justify-between gap-2 border-b border-line/70 px-4 py-3.5">
                    <div className="font-display text-base font-semibold">{g.creditor} <span className="font-sans font-normal text-muted">{g.byBureau[BUREAUS.find((b) => g.byBureau[b])!]?.account_last4 && `••${g.byBureau[BUREAUS.find((b) => g.byBureau[b])!]!.account_last4}`}</span></div>
                    <div className="flex items-center gap-2">
                      {g.itemType === 'collection' && <Badge tone="bad">Collection</Badge>}
                      {diffs.size > 0 && <Badge tone="warn">{diffs.size} difference{diffs.size > 1 ? 's' : ''}</Badge>}
                    </div>
                  </header>
                  {/* One table per account: a row per reported value, a column per bureau, so the three read across on a
                      phone as they do on a desk. A bureau that does not report the account is one cell down its column. */}
                  {(() => {
                    const cols = BUREAUS.map((b: Bureau) => ({ b, t: g.byBureau[b] ?? null }));
                    const offs = cols.map((c) => (c.t ? tradelineFallOff(c.t) : null));
                    const anyHistory = cols.some((c) => c.t?.payment_history);
                    const anyOff = offs.some(Boolean);
                    const anySays = cols.some((c) => c.t && (c.t.user_provided.not_mine === true || c.t.user_provided.never_late === true));
                    const span = fieldRows.length + Number(anyHistory) + Number(anyOff) + Number(anySays) + 1;
                    const head = 'py-1.5 pl-3 pr-1 text-left align-top font-normal text-muted sm:pr-3';
                    const cell = 'px-1.5 py-1.5 align-top font-medium [overflow-wrap:anywhere] sm:px-2';
                    /** The cells of one row: `first` is the top row, where a bureau without this account gets its one tall cell. */
                    const across = (first: boolean, render: (t: AnalysisTradeline, n: number) => ReactNode, className = cell) => cols.map((c, n) => (c.t
                      ? <td key={c.b} className={className}>{render(c.t, n)}</td>
                      : first ? <td key={c.b} rowSpan={span} className="px-2 py-3 text-center align-middle text-xs text-muted">{have.has(c.b) ? 'Not on this bureau’s approved report' : 'No report uploaded'}</td> : null));
                    return (
                      <table className="w-full table-fixed text-[0.8125rem] sm:text-sm">
                        <caption className="sr-only">{g.creditor}: what each bureau reports</caption>
                        <colgroup><col className="w-20 sm:w-44" /><col /><col /><col /></colgroup>
                        <thead>
                          <tr className="border-b border-line/70">
                            <td />
                            {cols.map((c) => <th key={c.b} scope="col" className="px-1.5 py-2.5 text-left font-semibold sm:px-2">{BUREAU_LABEL[c.b]}</th>)}
                          </tr>
                        </thead>
                        <tbody>
                          {fieldRows.map((f, r) => {
                            const differs = diffs.has(f.field);
                            return (
                              <tr key={f.field}>
                                <th scope="row" className={cn(head, differs && 'rounded-l-lg bg-warn-soft text-ink', r === 0 && 'pt-3')}>{f.short ? <><span className="sm:hidden">{f.short}</span><span className="hidden sm:inline">{f.label}</span></> : f.label}</th>
                                {across(r === 0, (t) => {
                                  const v = f.get(t);
                                  return <span className={cn('tabular-nums', !v && 'font-normal text-faint')}>{differs && v && <><span aria-hidden className="mr-1 hidden font-semibold text-warn sm:inline">≠</span><span className="sr-only">Differs from another bureau: </span></>}{v ?? '—'}</span>;
                                }, cn(cell, differs && 'bg-warn-soft last:rounded-r-lg', r === 0 && 'pt-3'))}
                              </tr>
                            );
                          })}
                          {anyHistory && (
                            <tr>
                              <th scope="row" className={head}>History</th>
                              {across(false, (t) => (t.payment_history ? <span className="font-mono text-xs font-normal text-muted">{t.payment_history}</span> : <span className="font-normal text-faint">—</span>))}
                            </tr>
                          )}
                          {anyOff && (
                            <tr>
                              <th scope="row" className={head}>Generally reportable until</th>
                              {across(false, (_t, n) => <FallOffCell fallOff={offs[n] ?? null} />)}
                            </tr>
                          )}
                          {anySays && (
                            <tr>
                              <th scope="row" className={head}>Client says</th>
                              {across(false, (t) => (
                                <span className="flex flex-wrap gap-1">
                                  {t.user_provided.not_mine === true && <Badge tone="info">Not recognised</Badge>}
                                  {t.user_provided.never_late === true && <Badge tone="info">Never late</Badge>}
                                  {t.user_provided.not_mine !== true && t.user_provided.never_late !== true && <span className="font-normal text-faint">—</span>}
                                </span>
                              ))}
                            </tr>
                          )}
                          <tr className="border-t border-line/70">
                            <td />
                            {across(false, (t) => <Link href={`/app/disputes/new?clientId=${id}&tradelineId=${t.id}`} className="btn-ghost btn-sm -ml-1.5 !px-1.5 sm:-ml-2 sm:!px-2" title={`Start a dispute with ${BUREAU_LABEL[t.bureau]}`}><Gavel size={14} aria-hidden className="hidden sm:block" /> Dispute<span className="sr-only"> with {BUREAU_LABEL[t.bureau]}</span></Link>, 'px-1.5 py-1.5 align-top sm:px-2')}
                          </tr>
                        </tbody>
                      </table>
                    );
                  })()}
                </article>
              );
            })}
            {groups.length === 0 && <EmptyState title="No accounts in the approved reports" />}
          </div>

          <section className="mt-10 border-t border-line pt-8" aria-labelledby="findings">
            <div className="mb-4 flex flex-wrap items-end justify-between gap-2">
              <div><h2 id="findings" className="text-lg font-semibold">Findings to review ({findings.length})</h2><p className="text-sm text-muted">Each one shows exactly which reported values it rests on.</p></div>
              <div className="flex flex-wrap gap-2">{Object.entries(BASIS_LABEL).map(([k, v]) => <span key={k} className="flex items-center gap-1.5 text-xs text-muted"><Badge tone={v.tone}>{v.text}</Badge>{v.hint}</span>)}</div>
            </div>
            {sp.drafted != null && Number(sp.drafted) > 0 && <div className="mb-4"><Notice tone="ok" title={`${Number(sp.drafted)} dispute${Number(sp.drafted) === 1 ? '' : 's'} drafted`}>Each is a draft with the reason written from its evidence. Read and edit each one, then send it for review — nothing is submitted until it is approved. <Link className="link" href="/app/disputes?view=table&status=draft">Open the drafts</Link>{Number(sp.skipped) > 0 && <> · {Number(sp.skipped)} skipped{sp.why ? ` (${sp.why})` : ''}</>}</Notice></div>}
            {sp.drafted === '0' && <div className="mb-4"><Notice tone="warn" title="Nothing was drafted">{sp.why ?? 'The selected findings could not be drafted automatically.'}</Notice></div>}
            {sp.bulk === 'none' && <div className="mb-4"><Notice tone="warn" title="Select at least one finding">Tick the findings you and the client agreed to pursue, then draft.</Notice></div>}
            {sp.bulk === 'error' && <div className="mb-4"><Notice tone="warn" title="Could not draft">{sp.why}</Notice></div>}
            {canDispute && findings.some((f) => f.status !== 'disputed') && (
              <form id="bulk" action={bulkDraftAction} className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-raised p-4">
                <input type="hidden" name="clientId" value={id} />
                <p className="text-sm"><strong>Draft several at once.</strong> <span className="text-muted">Tick the findings to pursue. One draft dispute is created per finding — a person still reviews and approves each before anything is sent.</span></p>
                <button className="btn-primary btn-sm"><Gavel size={14} aria-hidden /> Draft disputes for selected</button>
              </form>
            )}
            {behind > 0 && <div className="mb-4"><Notice tone="warn" title="These flags are out of date">The approved reports have changed in {behind} place{behind === 1 ? '' : 's'} since the analysis last ran. Someone who can edit reports brings the flags up to date by opening this page or pressing “Re-run analysis”.</Notice></div>}
            {findings.length === 0 ? (behind > 0 ? null : <Notice tone="ok">{dismissed.length ? 'No findings left to review. The ones you dismissed are listed below.' : 'Nothing to flag. The approved reports agree with each other and nothing looks out of the ordinary.'}</Notice>) : (
              <ul className="space-y-3">
                {findings.map((f) => {
                  const basis = BASIS_LABEL[f.basis]!;
                  // Collections, charge-offs and late payments are what clients come to us for: shown in red.
                  const negative = f.category === 'collection_validation' || f.category === 'negative_item' || f.category === 'obsolete_item';
                  return (
                    <li key={f.id} className={negative ? 'card card-pad border-l-4 !border-l-bad' : 'card card-pad'}>
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0 basis-full sm:basis-0 sm:flex-1">
                          <div className="mb-1.5 flex flex-wrap items-center gap-2">
                            {canDispute && f.status !== 'disputed' && <label className="flex items-center gap-1.5 text-xs font-medium"><input type="checkbox" form="bulk" name="finding" value={f.id} className="h-4 w-4 rounded border-line-strong accent-[rgb(var(--brand))]" /> Select</label>}
                            {/* Two tags at most: negative or not, and what the flag rests on. The kind of flag is plain text. */}
                            {negative ? <Badge tone="bad">Negative item</Badge> : f.severity === 'strong' && <Badge tone="warn">Worth a close look</Badge>}
                            <Badge tone={basis.tone}>{basis.text}</Badge>
                            {f.status !== 'suggested' && <StatusBadge status={f.status} />}
                            <span className="text-xs text-muted">{FINDING_CATEGORIES[f.category] ?? f.category}</span>
                          </div>
                          <h3 className={negative ? 'text-base font-semibold leading-snug text-bad' : 'text-[0.9375rem] font-semibold leading-snug'}>{f.title}</h3>
                          <p className="mt-1 text-sm text-muted">{f.explanation}</p>
                          <details className="mt-3">
                            <summary className="link cursor-pointer text-[0.8125rem]">What this is based on ({f.evidence.length})</summary>
                            <ul className="mt-2 space-y-1 rounded-xl bg-raised p-3 text-xs">
                              {f.evidence.map((e, i) => (
                                <li key={i} className="flex flex-wrap gap-x-2">
                                  <span className="font-semibold">{e.bureau ? BUREAU_LABEL[e.bureau] : e.source === 'client' ? 'Client' : e.source === 'record' ? 'Case file' : 'Derived'}</span>
                                  <span className="text-muted">{e.field}:</span> <span>{e.value}</span>
                                  <span className="text-faint">({e.source === 'reported' ? 'as reported' : e.source === 'client' ? 'client statement' : e.source === 'record' ? 'recorded by staff' : 'computed from reported dates'})</span>
                                </li>
                              ))}
                            </ul>
                          </details>
                        </div>
                        <div className="flex w-full shrink-0 flex-wrap items-center gap-2 sm:w-auto sm:flex-col sm:items-stretch">
                          {f.status !== 'disputed' && <Link href={`/app/disputes/new?clientId=${id}&findingId=${f.id}`} className="btn-primary btn-sm"><Gavel size={14} aria-hidden /> Start dispute</Link>}
                          <div className="flex gap-1.5">
                            <form action={setFindingStatusAction}><input type="hidden" name="id" value={f.id} /><input type="hidden" name="clientId" value={id} /><input type="hidden" name="status" value="accepted" /><button className="btn-secondary btn-sm" title="Mark as worth pursuing"><Check size={14} aria-hidden /> Keep</button></form>
                            <form action={setFindingStatusAction}><input type="hidden" name="id" value={f.id} /><input type="hidden" name="clientId" value={id} /><input type="hidden" name="status" value="dismissed" /><button className="btn-ghost btn-sm" title="Not relevant"><X size={14} aria-hidden /> Dismiss</button></form>
                          </div>
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
            {dismissed.length > 0 && (
              <details className="mt-6 border-t border-line pt-4">
                <summary className="link cursor-pointer text-sm">Dismissed ({dismissed.length})</summary>
                <ul className="mt-3 divide-y divide-line/70">
                  {dismissed.map((f) => (
                    <li key={f.id} className="flex flex-wrap items-start justify-between gap-3 py-3">
                      <div className="min-w-0 flex-1"><div className="text-sm font-medium">{f.title}</div><p className="mt-0.5 text-sm text-muted">{f.explanation}</p></div>
                      <form action={setFindingStatusAction}><input type="hidden" name="id" value={f.id} /><input type="hidden" name="clientId" value={id} /><input type="hidden" name="status" value="suggested" /><button className="btn-secondary btn-sm">Restore</button></form>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </section>
        </>
      )}
      <p className="mt-6 flex items-center gap-2 text-xs text-muted"><Eye size={14} aria-hidden /> Analysis uses only the most recent approved report from each bureau.</p>
    </>
  );
}
