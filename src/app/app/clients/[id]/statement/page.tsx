import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { PrintButton } from '@/components/print-button';
import { PageHeader } from '@/components/ui';
import { MonthPicker, monthLabel, WorkStatementView } from '@/components/work-statement';
import { requireStaff } from '@/lib/auth/context';
import { loadStatement } from '@/lib/billing/records';
import { isMonth, monthsBack } from '@/lib/business-days';
import { getEnv } from '@/lib/env';
import { businessToday } from '@/lib/letters/service';
import { dayInZone, fmtDate, isUuid } from '@/lib/util';

export const metadata: Metadata = { title: 'Work statement' };

/** What was done for one client in one month, from records only. Prints as a single clean page. */
export default async function WorkStatementPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ period?: string }> }) {
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  if (!isUuid(id)) notFound();
  const ctx = await requireStaff('clients:read');
  const tz = getEnv().APP_TIMEZONE;
  const today = businessToday();
  const month = isMonth(sp.period) && sp.period <= today.slice(0, 7) ? sp.period : today.slice(0, 7);
  const d = await ctx.tx(async (db) => {
    const c = await db.row<{ full_name: string; created_at: string; org: string }>('select c.full_name, c.created_at, o.name as org from public.clients c join public.organizations o on o.id = c.org_id where c.id = $1', [id]);
    return c ? { c, s: (await loadStatement(db, id, month, tz))! } : null;
  });
  if (!d) notFound();
  const months = monthsBack(today.slice(0, 7), dayInZone(tz, new Date(d.c.created_at)).slice(0, 7));
  return (
    <div className="max-w-3xl">
      <PageHeader title="Work statement" back={{ href: `/app/clients/${id}`, label: d.c.full_name }}
        subtitle={<>{d.c.full_name} · {monthLabel(month)} · {d.c.org}</>} actions={<PrintButton />} />
      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <MonthPicker months={months.includes(month) ? months : [month, ...months]} month={month} label="Month" show="Show" />
        <p className="text-[0.8125rem] text-muted">Built from this client’s records on {fmtDate(today)}. The client’s portal shows the same statement, limited to the records the client can see.</p>
      </div>
      <WorkStatementView s={d.s} staff />
    </div>
  );
}
