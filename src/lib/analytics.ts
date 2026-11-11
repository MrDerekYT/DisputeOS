import type { Db } from './db';

/**
 * All dashboard and analytics numbers come from here, computed by SQL over the caller's own data (row-level security
 * scopes every query to their organization). Nothing is estimated, sampled or hard-coded.
 */
export interface Analytics {
  rangeDays: number;
  clients: { total: number; active: number; newInRange: number; onboarding: number };
  disputes: { created: number; submitted: number; inFlight: number; awaitingReview: number; dueSoon: number; overdue: number; deleted: number; updated: number; verified: number; unresolved: number; resolvedTotal: number };
  tasks: { open: number; overdue: number };
  series: { clients: { label: string; value: number }[]; submitted: { label: string; value: number }[] };
  deadlines: { id: string; item_label: string; client_name: string; due_at: string; bureau: string | null }[];
  team: { id: string; name: string; role: string; created: number; submitted: number; changed: number; tasksDone: number; tasksOpen: number; activeClients: number }[];
  revenue: { mrrCents: number; collectedCents: number; refundedCents: number; payments: number; activeSubs: number; clientsWithPlan: number } | null;
  bureauOutcomes: { bureau: string; total: number; changed: number }[];
}

export async function getAnalytics(db: Db, opts: { rangeDays: number; withTeam: boolean; withRevenue: boolean }): Promise<Analytics> {
  const days = String(opts.rangeDays);
  const one = async <T>(sql: string, p: unknown[] = []) => (await db.row<T>(sql, p as never[]))!;

  const clients = await one<Analytics['clients']>(
    `select count(*)::int as total, count(*) filter (where status = 'active')::int as active,
            count(*) filter (where created_at > now() - ($1 || ' days')::interval)::int as "newInRange",
            count(*) filter (where status in ('lead','onboarding'))::int as onboarding from public.clients`, [days]);

  const disputes = await one<Analytics['disputes']>(
    `select count(*) filter (where created_at > now() - ($1 || ' days')::interval)::int as created,
            count(*) filter (where submitted_at > now() - ($1 || ' days')::interval)::int as submitted,
            count(*) filter (where status in ('submitted','under_investigation','response_received'))::int as "inFlight",
            count(*) filter (where status = 'ready_for_review')::int as "awaitingReview",
            count(*) filter (where status in ('submitted','under_investigation') and due_at between now() and now() + interval '7 days')::int as "dueSoon",
            count(*) filter (where status in ('submitted','under_investigation') and due_at < now())::int as overdue,
            count(*) filter (where outcome = 'deleted' and response_at > now() - ($1 || ' days')::interval)::int as deleted,
            count(*) filter (where outcome = 'updated' and response_at > now() - ($1 || ' days')::interval)::int as updated,
            count(*) filter (where outcome = 'verified' and response_at > now() - ($1 || ' days')::interval)::int as verified,
            count(*) filter (where outcome in ('unresolved','no_response') and response_at > now() - ($1 || ' days')::interval)::int as unresolved,
            count(*) filter (where outcome is not null and response_at > now() - ($1 || ' days')::interval)::int as "resolvedTotal"
       from public.disputes`, [days]);

  const tasks = await one<Analytics['tasks']>(
    `select count(*) filter (where status = 'open')::int as open, count(*) filter (where status = 'open' and due_at < now())::int as overdue from public.tasks`);

  const monthly = (col: string, table: string, where = '') =>
    db.rows<{ label: string; value: number }>(
      `select to_char(m, 'Mon') as label, count(x.id)::int as value
         from generate_series(date_trunc('month', now()) - interval '5 months', date_trunc('month', now()), interval '1 month') m
         left join public.${table} x on date_trunc('month', x.${col}) = m ${where} group by m order by m`);
  const [cSeries, sSeries] = await Promise.all([monthly('created_at', 'clients'), monthly('submitted_at', 'disputes')]);

  const deadlines = await db.rows<Analytics['deadlines'][number]>(
    `select d.id, d.item_label, c.full_name as client_name, d.due_at, d.bureau from public.disputes d join public.clients c on c.id = d.client_id
      where d.status in ('submitted','under_investigation') and d.due_at is not null order by d.due_at limit 8`);

  const bureauOutcomes = await db.rows<Analytics['bureauOutcomes'][number]>(
    `select bureau, count(*)::int as total, count(*) filter (where outcome in ('deleted','updated'))::int as changed from public.disputes
      where bureau is not null and outcome is not null and response_at > now() - ($1 || ' days')::interval group by bureau order by bureau`, [days]);

  let team: Analytics['team'] = [];
  if (opts.withTeam) {
    team = await db.rows<Analytics['team'][number]>(
      `select u.id, coalesce(nullif(u.full_name, ''), u.email) as name, m.role,
              (select count(*)::int from public.disputes d where d.created_by = u.id and d.created_at > now() - ($1 || ' days')::interval) as created,
              (select count(*)::int from public.disputes d where d.assigned_to = u.id and d.submitted_at > now() - ($1 || ' days')::interval) as submitted,
              (select count(*)::int from public.disputes d where d.assigned_to = u.id and d.outcome in ('deleted','updated') and d.response_at > now() - ($1 || ' days')::interval) as changed,
              (select count(*)::int from public.tasks t where t.assignee_id = u.id and t.status = 'done' and t.completed_at > now() - ($1 || ' days')::interval) as "tasksDone",
              (select count(*)::int from public.tasks t where t.assignee_id = u.id and t.status = 'open') as "tasksOpen",
              (select count(*)::int from public.clients c where c.assigned_to = u.id and c.status = 'active') as "activeClients"
         from public.memberships m join public.users u on u.id = m.user_id where m.role <> 'client' order by name`, [days]);
  }

  let revenue: Analytics['revenue'] = null;
  if (opts.withRevenue) {
    revenue = await one<NonNullable<Analytics['revenue']>>(
      `select coalesce((select sum(p.price_cents) from public.client_subscriptions s join public.service_plans p on p.id = s.plan_id where s.status = 'active' and p.interval = 'month'), 0)::bigint as "mrrCents",
              coalesce((select sum(amount_cents) from public.payments where status = 'succeeded' and paid_at > now() - ($1 || ' days')::interval), 0)::bigint as "collectedCents",
              coalesce((select sum(amount_cents) from public.payments where status = 'refunded' and paid_at > now() - ($1 || ' days')::interval), 0)::bigint as "refundedCents",
              (select count(*)::int from public.payments where status = 'succeeded' and paid_at > now() - ($1 || ' days')::interval) as payments,
              (select count(*)::int from public.client_subscriptions where status = 'active') as "activeSubs",
              (select count(distinct client_id)::int from public.client_subscriptions where status = 'active') as "clientsWithPlan"`, [days]);
  }
  return { rangeDays: opts.rangeDays, clients, disputes, tasks, series: { clients: cSeries, submitted: sSeries }, deadlines, team, revenue, bureauOutcomes };
}
