import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { EmptyState, Notice, PageHeader, Section } from '@/components/ui';
import { requireStaff } from '@/lib/auth/context';
import { ageLabel, applyScenario, isOpen, isRevolving, snapshot, type Snapshot, type WAccount } from '@/lib/credit/what-if';
import { BUREAU_LABEL, BUREAUS, fmtDate, isUuid, money, type Bureau } from '@/lib/util';

export const metadata: Metadata = { title: 'What-if calculator' };

const dollars = (v: string | undefined) => { const n = Number(String(v ?? '').replace(/[$,\s]/g, '')); return Number.isFinite(n) && n > 0 ? Math.min(Math.round(n * 100), 100_000_000_00) : 0; };

/** Before/after arithmetic on the client's reported accounts. Shows usage and age only; never a score. */
export default async function WhatIfPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { id } = await params;
  const sp = await searchParams;
  if (!isUuid(id)) notFound();
  const ctx = await requireStaff('clients:read');
  const data = await ctx.tx(async (db) => {
    const c = await db.row<{ full_name: string }>('select full_name from public.clients where id = $1', [id]);
    if (!c) return null;
    const reports = await db.rows<{ id: string; bureau: Bureau; report_date: string | null; created_at: string }>(
      "select distinct on (bureau) id, bureau, report_date, created_at from public.credit_reports where client_id = $1 and status = 'approved' and bureau is not null order by bureau, coalesce(report_date, created_at::date) desc, created_at desc", [id]);
    const bureau = (BUREAUS as readonly string[]).includes(sp.bureau ?? '') ? (sp.bureau as Bureau) : reports[0]?.bureau;
    const report = reports.find((r) => r.bureau === bureau);
    const rows = report ? await db.rows<{ creditor_name: string; account_type: string | null; account_status: string | null; balance_cents: string | null; credit_limit_cents: string | null; date_opened: string | null }>(
      'select creditor_name, account_type, account_status, balance_cents, credit_limit_cents, date_opened from public.tradelines where report_id = $1 order by creditor_name', [report.id]) : [];
    return { c, reports, report, rows };
  });
  if (!data) notFound();
  const { c, reports, report, rows } = data;
  const accounts: WAccount[] = rows.map((r) => ({ creditor: r.creditor_name, type: r.account_type, status: r.account_status, balanceCents: r.balance_cents == null ? null : Number(r.balance_cents), limitCents: r.credit_limit_cents == null ? null : Number(r.credit_limit_cents), opened: r.date_opened }));

  const payDown = dollars(sp.payDown);
  const addLimit = dollars(sp.addLimit);
  const addBalance = dollars(sp.addBalance);
  const today = new Date().toISOString().slice(0, 10);
  const addOpened = /^\d{4}-\d{2}-\d{2}$/.test(sp.addOpened ?? '') ? sp.addOpened! : today;
  const changed = payDown > 0 || addLimit > 0;
  const before = snapshot(accounts);
  const after = snapshot(applyScenario(accounts, { payDownCents: payDown, add: addLimit > 0 ? { limitCents: addLimit, balanceCents: addBalance, opened: addOpened } : null }));
  const pct = (s: Snapshot) => (s.utilizationPct == null ? '—' : `${s.utilizationPct}%`);
  const rowsOut: [string, string, string][] = [
    ['Credit usage (card balances ÷ card limits)', pct(before), pct(after)],
    ['Total card balances', money(before.revolvingBalanceCents), money(after.revolvingBalanceCents)],
    ['Total card limits', money(before.revolvingLimitCents), money(after.revolvingLimitCents)],
    ['Open accounts', String(before.openAccounts), String(after.openAccounts)],
    ['Average age of open accounts', ageLabel(before.averageAgeMonths), ageLabel(after.averageAgeMonths)],
    ['Oldest open account', ageLabel(before.oldestAgeMonths), ageLabel(after.oldestAgeMonths)],
  ];

  return (
    <>
      <PageHeader title="What-if calculator" subtitle={`${c.full_name} · see how a change would alter the figures on their report`} back={{ href: `/app/clients/${id}?tab=reports`, label: c.full_name }} />
      <div className="mb-6"><Notice tone="info" title="Arithmetic, not a score prediction">This shows how credit usage and account age would change, using the figures on the approved report. It does not estimate a credit score: scoring formulas are not public, lenders and bureaus decide for themselves, and no one can promise a client a score increase.</Notice></div>
      {!report ? <EmptyState title="No approved report yet" body="Upload or import a report and approve it first. The calculator uses the accounts on the latest approved report." /> : (
        <div className="grid gap-6 lg:grid-cols-[22rem_minmax(0,1fr)]">
          <Section title="Try a change">
            <form method="get" className="space-y-4">
              <div><label className="label" htmlFor="bureau">Report</label>
                <select id="bureau" name="bureau" defaultValue={report.bureau} className="field">{reports.map((r) => <option key={r.id} value={r.bureau}>{BUREAU_LABEL[r.bureau]} · {fmtDate(r.report_date ?? r.created_at)}</option>)}</select></div>
              <div><label className="label" htmlFor="payDown">Pay down card balances by ($)</label><input id="payDown" name="payDown" inputMode="decimal" className="field" defaultValue={sp.payDown ?? ''} placeholder="0" /><p className="mt-1 text-xs text-muted">Applied to the most heavily used cards first.</p></div>
              <fieldset className="space-y-3 rounded-xl border border-line p-3">
                <legend className="px-1 text-sm font-medium">Add an account</legend>
                <div><label className="label" htmlFor="addLimit">Credit limit ($)</label><input id="addLimit" name="addLimit" inputMode="decimal" className="field" defaultValue={sp.addLimit ?? ''} placeholder="0" /></div>
                <div><label className="label" htmlFor="addBalance">Balance ($)</label><input id="addBalance" name="addBalance" inputMode="decimal" className="field" defaultValue={sp.addBalance ?? ''} placeholder="0" /></div>
                <div><label className="label" htmlFor="addOpened">Date opened</label><input id="addOpened" name="addOpened" type="date" className="field" defaultValue={addOpened} max={today} /></div>
                <p className="text-xs text-muted">Only an account the client genuinely holds or is legitimately added to belongs on a credit report. Paying to be added to a stranger’s account can be treated as misrepresentation by lenders.</p>
              </fieldset>
              <button className="btn-primary w-full" type="submit">Show the difference</button>
            </form>
          </Section>

          <div className="space-y-6">
            <Section title={changed ? 'Before and after' : 'Where the report stands'} hint={`${BUREAU_LABEL[report.bureau]} report dated ${fmtDate(report.report_date ?? report.created_at)}`}>
              <div className="table-wrap !shadow-none"><table className="table"><thead><tr><th>Figure</th><th>Today</th>{changed && <th>After the change</th>}</tr></thead>
                <tbody>{rowsOut.map(([label, b, a]) => <tr key={label}><td>{label}</td><td className="tabular-nums">{b}</td>{changed && <td className={`tabular-nums ${a !== b ? 'font-semibold text-brand-strong' : ''}`}>{a}</td>}</tr>)}</tbody></table></div>
              {before.utilizationPct == null && <p className="mt-3 text-sm text-muted">No credit limits are reported on this report’s open cards, so credit usage cannot be calculated.</p>}
            </Section>
            <Section title="Accounts used" hint="Open accounts from this report. Closed, paid and collection accounts are left out of the figures.">
              <div className="table-wrap !shadow-none"><table className="table"><thead><tr><th>Account</th><th>Type</th><th>Balance</th><th>Limit</th><th>Opened</th><th>Counted as</th></tr></thead>
                <tbody>{accounts.map((a, i) => <tr key={i} className={isOpen(a) ? '' : 'opacity-50'}><td>{a.creditor}</td><td>{a.type ?? '—'}</td><td className="tabular-nums">{a.balanceCents == null ? '—' : money(a.balanceCents)}</td><td className="tabular-nums">{a.limitCents == null ? '—' : money(a.limitCents)}</td><td>{fmtDate(a.opened)}</td><td className="text-muted">{!isOpen(a) ? 'Not counted' : isRevolving(a) ? 'Card (usage + age)' : 'Age only'}</td></tr>)}</tbody></table></div>
            </Section>
          </div>
        </div>
      )}
    </>
  );
}
