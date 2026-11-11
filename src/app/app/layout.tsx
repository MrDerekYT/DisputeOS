import type { ReactNode } from 'react';
import { AppShell, staffNav } from '@/components/shell';
import { requireStaff } from '@/lib/auth/context';

export default async function StaffLayout({ children }: { children: ReactNode }) {
  const ctx = await requireStaff();
  const counts = await ctx.tx(async (db) => {
    const t = await db.row<{ n: number }>("select count(*)::int as n from public.tasks where status = 'open' and (assignee_id = $1 or assignee_id is null) and due_at < now() + interval '1 day'", [ctx.userId]);
    const i = await db.row<{ n: number }>(
      `select (select count(*) from public.communications where direction = 'inbound' and read_at is null)
            + (select count(*) from public.automation_runs where status = 'pending_approval')
            + (select count(*) from public.notifications where user_id = $1 and read_at is null) as n`, [ctx.userId]);
    return { tasks: t?.n ?? 0, inbox: i?.n ?? 0 };
  });
  return <AppShell ctx={ctx} nav={staffNav(ctx, counts)}>{children}</AppShell>;
}
