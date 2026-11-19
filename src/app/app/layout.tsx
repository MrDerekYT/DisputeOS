import type { ReactNode } from 'react';
import { CreditGuide } from '@/components/credit-guide';
import { AppShell, staffNav } from '@/components/shell';
import { getBalance } from '@/lib/ai/credits';
import { guideLabels, guideStarters } from '@/lib/guide/labels';
import { requireStaff } from '@/lib/auth/context';

// Server actions under this layout may wait on an AI provider for up to 30 s (TIMEOUT_MS in src/lib/ai/provider.ts).
// The host must not stop the request before that call returns and its charge is settled or refunded.
export const maxDuration = 60;

export default async function StaffLayout({ children }: { children: ReactNode }) {
  const ctx = await requireStaff();
  const counts = await ctx.tx(async (db) => {
    const t = await db.row<{ n: number }>("select count(*)::int as n from public.tasks where status = 'open' and (assignee_id = $1 or assignee_id is null) and due_at < now() + interval '1 day'", [ctx.userId]);
    const i = await db.row<{ n: number }>(
      `select (select count(*) from public.communications where direction = 'inbound' and read_at is null)
            + (select count(*) from public.automation_runs where status = 'pending_approval')
            + (select count(*) from public.notifications where user_id = $1 and read_at is null) as n`, [ctx.userId]);
    // The rail shows the workspace's real AI credit balance, read under the signed-in person's row-level security.
    return { tasks: t?.n ?? 0, inbox: i?.n ?? 0, credits: await getBalance(ctx.orgId, db) };
  });
  return (
    <AppShell ctx={ctx} nav={staffNav(ctx, counts)} credits={counts.credits}
      guide={<CreditGuide audience="app" labels={guideLabels('app')} starters={guideStarters('app')} />}>
      {children}
    </AppShell>
  );
}
