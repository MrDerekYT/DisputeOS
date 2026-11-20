-- 0026 Personal information on reports, and the "bank account sent to collections" guide.
-- Additive and safe to run again: two new tables that start empty, with their own policies. No existing table, row,
-- policy, check or trigger changes, and nothing here needs a superuser.

-- ---------------------------------------------------------------- 1. personal information marked as wrong
-- One row each time staff, or the client in the portal, say that a name, address, employer, phone number or date of
-- birth shown in the personal information section of ONE bureau's report is not theirs or is not correct. `value` is
-- the entry as the report shows it (picked from report_identity_items when the report was imported, typed otherwise).
-- `correct_value` is what the person says it should be, when they gave one. Nothing is inferred: the app never fills
-- either in. The correction letter is drafted from these rows (src/lib/credit/personal-info.ts).
create table if not exists public.personal_info_marks (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  client_id uuid not null references public.clients (id) on delete cascade,
  bureau text not null check (bureau in ('experian', 'equifax', 'transunion')),
  kind text not null check (kind in ('name', 'address', 'employer', 'phone', 'date_of_birth')),
  value text not null check (char_length(btrim(value)) between 1 and 300),
  issue text not null check (issue in ('not_mine', 'incorrect')),
  correct_value text check (correct_value is null or char_length(correct_value) <= 300),
  source text not null default 'staff' check (source in ('staff', 'client')),
  created_by uuid references public.users (id) on delete set null,
  created_at timestamptz not null default now()
);
create unique index if not exists personal_info_marks_entry_idx on public.personal_info_marks (client_id, bureau, kind, lower(btrim(value)));
create index if not exists personal_info_marks_org_idx on public.personal_info_marks (org_id);

alter table public.personal_info_marks enable row level security;
revoke all on public.personal_info_marks from public;
revoke all on public.personal_info_marks from disputeos_rls;
grant select, insert, delete on public.personal_info_marks to disputeos_rls;

-- Staff: read, add and remove marks for clients of their own organization.
drop policy if exists personal_info_marks_staff_select on public.personal_info_marks;
create policy personal_info_marks_staff_select on public.personal_info_marks for select to disputeos_rls using (app.is_staff(org_id));
drop policy if exists personal_info_marks_staff_insert on public.personal_info_marks;
create policy personal_info_marks_staff_insert on public.personal_info_marks for insert to disputeos_rls
  with check (app.is_staff(org_id) and org_id = app.client_org(client_id));
drop policy if exists personal_info_marks_staff_delete on public.personal_info_marks;
create policy personal_info_marks_staff_delete on public.personal_info_marks for delete to disputeos_rls using (app.is_staff(org_id));
-- The client: read every mark on their own file, add their own, and remove only the ones they added.
drop policy if exists personal_info_marks_self_select on public.personal_info_marks;
create policy personal_info_marks_self_select on public.personal_info_marks for select to disputeos_rls using (client_id in (select app.client_ids()));
drop policy if exists personal_info_marks_self_insert on public.personal_info_marks;
create policy personal_info_marks_self_insert on public.personal_info_marks for insert to disputeos_rls
  with check (client_id in (select app.client_ids()) and org_id = app.client_org(client_id) and source = 'client' and created_by = app.uid());
drop policy if exists personal_info_marks_self_delete on public.personal_info_marks;
create policy personal_info_marks_self_delete on public.personal_info_marks for delete to disputeos_rls
  using (client_id in (select app.client_ids()) and source = 'client');

-- ---------------------------------------------------------------- 2. bank account sent to collections
-- The answers staff recorded to a few plain questions about one overdrawn or closed bank account. The steps shown for
-- it are worked out from these answers in src/lib/credit/bank-collections.ts; nothing is drafted or sent from here.
-- Whether the client has asked for their ChexSystems or Early Warning report is already kept in
-- clients.specialty_reports, so it is not repeated here. Staff only: the portal does not read this table.
create table if not exists public.bank_collection_cases (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  client_id uuid not null references public.clients (id) on delete cascade,
  bank_name text not null check (char_length(btrim(bank_name)) between 1 and 160),
  charge_accurate text not null check (charge_accurate in ('yes', 'no', 'unsure')),
  inaccurate_details text[] not null default '{}' check (inaccurate_details <@ array['amount', 'dates', 'ownership', 'paid_status']::text[]),
  paid text not null check (paid in ('yes', 'no')),
  on_credit_reports text not null check (on_credit_reports in ('yes', 'no', 'unsure')),
  created_by uuid references public.users (id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists bank_collection_cases_client_idx on public.bank_collection_cases (client_id, created_at desc);
create index if not exists bank_collection_cases_org_idx on public.bank_collection_cases (org_id);

alter table public.bank_collection_cases enable row level security;
revoke all on public.bank_collection_cases from public;
revoke all on public.bank_collection_cases from disputeos_rls;
grant select, insert, delete on public.bank_collection_cases to disputeos_rls;

drop policy if exists bank_collection_cases_staff_select on public.bank_collection_cases;
create policy bank_collection_cases_staff_select on public.bank_collection_cases for select to disputeos_rls using (app.is_staff(org_id));
drop policy if exists bank_collection_cases_staff_insert on public.bank_collection_cases;
create policy bank_collection_cases_staff_insert on public.bank_collection_cases for insert to disputeos_rls
  with check (app.is_staff(org_id) and org_id = app.client_org(client_id));
drop policy if exists bank_collection_cases_staff_delete on public.bank_collection_cases;
create policy bank_collection_cases_staff_delete on public.bank_collection_cases for delete to disputeos_rls using (app.is_staff(org_id));
