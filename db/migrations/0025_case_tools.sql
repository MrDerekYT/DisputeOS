-- 0025 Three small case tools: collector validation clock, medical collection screen, bankruptcy discharge audit.
-- Additive and safe to run again. Existing rows are untouched: the three new client columns are nullable with no
-- default, and the one new table starts empty. No existing policy, check or trigger changes, and nothing here needs a
-- superuser. (The medical screen needs no schema: "this is a medical debt" is a staff note kept in the existing
-- tradelines.user_provided column, apart from what the bureau reports.)

-- ---------------------------------------------------------------- 1. bankruptcy, as staff entered it
-- No court record is read. Null chapter = no bankruptcy recorded. The discharge date stays null until there is one.
alter table public.clients add column if not exists bankruptcy_chapter text check (bankruptcy_chapter is null or bankruptcy_chapter in ('7', '13'));
alter table public.clients add column if not exists bankruptcy_filed_on date;
alter table public.clients add column if not exists bankruptcy_discharged_on date;

-- ---------------------------------------------------------------- 2. collector notices (FDCPA validation period)
-- One row each time staff record that the client received a debt collector's validation notice. `notice_date` is the
-- day the client received it (date_kind 'received') or the day the collector sent it ('sent'); the end of the 30-day
-- validation period is computed from it in src/lib/credit/validation-clock.ts (12 CFR 1006.34(b)(5)). This is a
-- different law, deadline and recipient from a credit-report dispute, so it has its own table and never touches
-- public.disputes.
create table if not exists public.collector_notices (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  client_id uuid not null references public.clients (id) on delete cascade,
  tradeline_id uuid references public.tradelines (id) on delete set null,
  collector_name text not null check (char_length(btrim(collector_name)) between 1 and 200),
  date_kind text not null check (date_kind in ('received', 'sent')),
  notice_date date not null,
  created_by uuid references public.users (id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists collector_notices_client_idx on public.collector_notices (client_id, notice_date desc);
create index if not exists collector_notices_org_idx on public.collector_notices (org_id);

alter table public.collector_notices enable row level security;
revoke all on public.collector_notices from public;
revoke all on public.collector_notices from disputeos_rls;
grant select, insert, delete on public.collector_notices to disputeos_rls;

-- Staff: read, record and remove notices for clients of their own organization.
drop policy if exists collector_notices_staff_select on public.collector_notices;
create policy collector_notices_staff_select on public.collector_notices for select to disputeos_rls using (app.is_staff(org_id));
drop policy if exists collector_notices_staff_insert on public.collector_notices;
create policy collector_notices_staff_insert on public.collector_notices for insert to disputeos_rls
  with check (app.is_staff(org_id) and org_id = app.client_org(client_id));
drop policy if exists collector_notices_staff_delete on public.collector_notices;
create policy collector_notices_staff_delete on public.collector_notices for delete to disputeos_rls using (app.is_staff(org_id));
-- The client: read their own (the portal shows the date and a plain explanation).
drop policy if exists collector_notices_self_select on public.collector_notices;
create policy collector_notices_self_select on public.collector_notices for select to disputeos_rls using (client_id in (select app.client_ids()));
