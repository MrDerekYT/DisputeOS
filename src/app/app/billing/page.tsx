import Link from 'next/link';
import type { Metadata } from 'next';
import { ActionForm, Field, Select, SubmitButton, TextArea } from '@/components/forms';
import { BarSeries } from '@/components/charts';
import { Badge, EmptyState, Notice, PageHeader, Section, Stat, StatusBadge } from '@/components/ui';
import { requireStaff } from '@/lib/auth/context';
import { fmtDate, money, moneyShort } from '@/lib/util';
import { createPlanAction } from './actions';
import { PRODUCT } from '@/lib/product';

export const metadata: Metadata = { title: 'Billing' };

export default async function BillingPage() {
  const ctx = await requireStaff('billing:read');
  const d = await ctx.tx(async (db) => ({
    totals: await db.row<{ mrr: number; month: number; ninety: number; subs: number }>(
      `select coalesce((select sum(p.price_cents) from public.client_subscriptions s join public.service_plans p on p.id = s.plan_id where s.status = 'active' and p.interval = 'month'), 0)::bigint as mrr,
              coalesce((select sum(amount_cents) from public.payments where status = 'succeeded' and paid_at >= date_trunc('month', now())), 0)::bigint as month,
              coalesce((select sum(amount_cents) from public.payments where status = 'succeeded' and paid_at > now() - interval '90 days'), 0)::bigint as ninety,
              (select count(*)::int from public.client_subscriptions where status = 'active') as subs`),
    series: await db.rows<{ label: string; value: number }>(
      `select to_char(m, 'Mon') as label, coalesce(sum(p.amount_cents) filter (where p.status = 'succeeded'), 0)::bigint / 100 as value
         from generate_series(date_trunc('month', now()) - interval '5 months', date_trunc('month', now()), interval '1 month') m
         left join public.payments p on date_trunc('month', p.paid_at) = m group by m order by m`),
    plans: await db.rows<{ id: string; name: string; price_cents: number; interval: string; description: string | null; active: boolean; subs: number }>(
      `select p.id, p.name, p.price_cents, p.interval, p.description, p.active, (select count(*)::int from public.client_subscriptions s where s.plan_id = p.id and s.status = 'active') as subs from public.service_plans p order by p.created_at`),
    payments: await db.rows<{ id: string; amount_cents: number; method: string; status: string; paid_at: string; client_id: string; client_name: string }>(
      `select p.id, p.amount_cents, p.method, p.status, p.paid_at, p.client_id, c.full_name as client_name from public.payments p join public.clients c on c.id = p.client_id order by p.paid_at desc limit 25`),
  }));
  return (
    <>
      <PageHeader title="Billing" subtitle="Your plans, your clients’ subscriptions and payment history." />
      <div className="mb-6"><Notice tone="warn" title="Payments are recorded manually">{PRODUCT.name} does not process cards or bank transfers. Record payments your team collected elsewhere. Under the Credit Repair Organizations Act you may not charge for services before they are fully performed — every payment requires you to confirm that.</Notice></div>
      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Monthly recurring" value={moneyShort(d.totals?.mrr ?? 0)} sub={`${d.totals?.subs ?? 0} active plans`} /><Stat label="Collected this month" value={moneyShort(d.totals?.month ?? 0)} /><Stat label="Collected · 90 days" value={moneyShort(d.totals?.ninety ?? 0)} /><Stat label="Plans offered" value={d.plans.filter((p) => p.active).length} />
      </div>
      <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
        <div className="space-y-6">
          <Section title="Collected per month ($)"><BarSeries data={d.series} format={(n) => `$${n.toLocaleString()}`} /></Section>
          <Section title="Recent payments">
            {d.payments.length === 0 ? <EmptyState title="No payments yet" body="Record a payment from a client’s Billing tab." /> : (
              <div className="table-wrap !shadow-none"><table className="table"><thead><tr><th>Client</th><th>Amount</th><th>Method</th><th>Status</th><th>Date</th></tr></thead><tbody>{d.payments.map((p) => <tr key={p.id}><td><Link className="hover:underline" href={`/app/clients/${p.client_id}?tab=billing`}>{p.client_name}</Link></td><td className="tabular-nums font-medium">{money(p.amount_cents)}</td><td className="capitalize text-muted">{p.method}</td><td><StatusBadge status={p.status} /></td><td className="text-muted">{fmtDate(p.paid_at)}</td></tr>)}</tbody></table></div>)}
          </Section>
        </div>
        <div className="space-y-6">
          <Section title="Service plans">
            {d.plans.length === 0 ? <p className="mb-3 text-sm text-muted">No plans yet.</p> : <ul className="mb-4 divide-y divide-line">{d.plans.map((p) => <li key={p.id} className="py-2.5 text-sm"><div className="flex items-center justify-between"><span className="font-medium">{p.name}</span><span className="tabular-nums">{money(p.price_cents)}{p.interval === 'month' ? '/mo' : ''}</span></div><div className="flex items-center gap-2 text-xs text-muted">{p.subs} active{!p.active && <Badge>Inactive</Badge>}</div></li>)}</ul>}
            {ctx.can('billing:write') && (
              <ActionForm action={createPlanAction} resetOnSuccess className="space-y-3 border-t border-line pt-4">
                <Field label="Plan name" name="name" required /><Field label="Price ($)" name="price" inputMode="decimal" required />
                <Select label="Billing" name="interval" defaultValue="month" options={[{ value: 'month', label: 'Monthly' }, { value: 'one_time', label: 'One time' }]} />
                <TextArea label="Description" name="description" rows={2} /><SubmitButton variant="secondary">Add plan</SubmitButton>
              </ActionForm>
            )}
          </Section>
        </div>
      </div>
    </>
  );
}
