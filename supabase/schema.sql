-- DisputeOS Phase 1 schema: enums, tables, helper functions, triggers, RLS.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------- enums
create type public.org_mode as enum ('personal', 'agency');
create type public.user_role as enum ('owner', 'staff', 'client');
create type public.client_status as enum ('lead', 'active', 'paused', 'cancelled', 'completed');
create type public.bureau as enum ('experian', 'equifax', 'transunion');
create type public.document_kind as enum ('id', 'proof_of_address', 'credit_report', 'bureau_response', 'ftc_report', 'contract', 'other');
create type public.report_source as enum ('experian', 'equifax', 'transunion', 'annualcreditreport', 'other');
create type public.report_status as enum ('uploaded', 'parsing', 'pending_review', 'approved', 'rejected');
create type public.tradeline_type as enum ('tradeline', 'collection', 'inquiry', 'public_record');
create type public.dispute_status as enum ('draft', 'pending', 'sent', 'delivered', 'responded', 'deleted', 'verified', 'updated', 'no_response', 'closed');
create type public.round_status as enum ('pending', 'sent', 'delivered', 'response_received', 'no_response', 'returned');
create type public.round_outcome as enum ('deleted', 'verified', 'updated', 'no_response');
create type public.letter_status as enum ('draft', 'generated', 'approved', 'sent', 'void');
create type public.mail_provider as enum ('lob', 'postgrid', 'click2mail', 'manual');
create type public.mail_status as enum ('pending', 'sent', 'in_transit', 'delivered', 'returned', 'failed');
create type public.template_category as enum ('bureau_609', 'bureau_611', 'method_of_verification', 'debt_validation_809', 'goodwill', 'cease_and_desist', 'furnisher_623', 'identity_theft_605b', 'inquiry_removal', 'other');

-- ---------------------------------------------------------------- tables
create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 120),
  mode public.org_mode not null default 'personal',
  branding jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table public.users (
  id uuid primary key references auth.users (id) on delete cascade,
  org_id uuid not null references public.organizations (id) on delete cascade,
  role public.user_role not null default 'owner',
  email text not null,
  full_name text,
  created_at timestamptz not null default now()
);
create index users_org_id_idx on public.users (org_id);

create table public.clients (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  user_id uuid unique references public.users (id) on delete set null, -- portal login (role = client)
  full_name text not null,
  email text,
  phone text,
  -- PII: SSN is stored as last-4 only; full identifiers are encrypted by the app (see lib/pii.ts).
  ssn_last4 char(4) check (ssn_last4 ~ '^[0-9]{4}$'),
  ssn_encrypted text,
  dob_encrypted text,
  address jsonb not null default '{}'::jsonb,
  status public.client_status not null default 'lead',
  created_at timestamptz not null default now()
);
create index clients_org_id_idx on public.clients (org_id);

create table public.documents (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  client_id uuid not null references public.clients (id) on delete cascade,
  uploaded_by uuid references public.users (id) on delete set null,
  kind public.document_kind not null default 'other',
  storage_path text not null, -- path in a PRIVATE storage bucket; never a public URL
  file_name text not null,
  mime_type text,
  encrypted boolean not null default true,
  created_at timestamptz not null default now()
);
create index documents_org_id_idx on public.documents (org_id);
create index documents_client_id_idx on public.documents (client_id);

create table public.credit_reports (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  client_id uuid not null references public.clients (id) on delete cascade,
  document_id uuid references public.documents (id) on delete set null,
  bureau public.bureau,
  source public.report_source not null default 'other',
  status public.report_status not null default 'uploaded',
  report_date date,
  created_at timestamptz not null default now()
);
create index credit_reports_org_id_idx on public.credit_reports (org_id);
create index credit_reports_client_id_idx on public.credit_reports (client_id);

create table public.tradelines (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  client_id uuid not null references public.clients (id) on delete cascade,
  report_id uuid not null references public.credit_reports (id) on delete cascade,
  bureau public.bureau not null,
  item_type public.tradeline_type not null default 'tradeline',
  creditor_name text not null,
  account_last4 text check (account_last4 ~ '^[0-9A-Za-z]{0,4}$'), -- never the full account number
  balance_cents bigint,
  account_status text,
  date_opened date,
  date_reported date,
  created_at timestamptz not null default now()
);
create index tradelines_org_id_idx on public.tradelines (org_id);
create index tradelines_client_id_idx on public.tradelines (client_id);

create table public.disputes (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  client_id uuid not null references public.clients (id) on delete cascade,
  tradeline_id uuid not null references public.tradelines (id) on delete cascade,
  bureau public.bureau not null,
  reason text not null,
  strategy text,
  status public.dispute_status not null default 'draft',
  current_round smallint not null default 1 check (current_round between 1 and 3),
  created_at timestamptz not null default now()
);
create index disputes_org_id_idx on public.disputes (org_id);
create index disputes_client_id_idx on public.disputes (client_id);

create table public.dispute_rounds (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  dispute_id uuid not null references public.disputes (id) on delete cascade,
  round_number smallint not null check (round_number between 1 and 3),
  status public.round_status not null default 'pending',
  sent_at timestamptz,
  due_at timestamptz, -- 30/45-day response deadline
  response_received_at timestamptz,
  outcome public.round_outcome,
  created_at timestamptz not null default now(),
  unique (dispute_id, round_number)
);
create index dispute_rounds_org_id_idx on public.dispute_rounds (org_id);

create table public.templates (
  id uuid primary key default gen_random_uuid(),
  org_id uuid references public.organizations (id) on delete cascade, -- null = system template
  name text not null,
  category public.template_category not null default 'other',
  body text not null,
  merge_fields text[] not null default '{}',
  created_at timestamptz not null default now()
);
create index templates_org_id_idx on public.templates (org_id);

create table public.letters (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  dispute_id uuid not null references public.disputes (id) on delete cascade,
  round_id uuid references public.dispute_rounds (id) on delete set null,
  template_id uuid references public.templates (id) on delete set null,
  storage_path text, -- generated PDF in private storage
  status public.letter_status not null default 'draft',
  created_by uuid references public.users (id) on delete set null,
  created_at timestamptz not null default now()
);
create index letters_org_id_idx on public.letters (org_id);

create table public.mail_jobs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  letter_id uuid not null references public.letters (id) on delete cascade,
  provider public.mail_provider not null default 'manual',
  status public.mail_status not null default 'pending',
  certified boolean not null default true,
  return_receipt boolean not null default true,
  tracking_number text,
  cost_cents integer check (cost_cents >= 0),
  sent_at timestamptz,
  delivered_at timestamptz,
  created_at timestamptz not null default now()
);
create index mail_jobs_org_id_idx on public.mail_jobs (org_id);

create table public.audit_logs (
  id bigint generated always as identity primary key,
  org_id uuid not null references public.organizations (id) on delete cascade,
  actor_id uuid references public.users (id) on delete set null,
  action text not null,
  entity_type text not null,
  entity_id uuid,
  metadata jsonb not null default '{}'::jsonb, -- never put PII or report data here
  created_at timestamptz not null default now()
);
create index audit_logs_org_id_idx on public.audit_logs (org_id);

-- ---------------------------------------------------------------- helpers
-- SECURITY DEFINER so policies can look up the caller without recursive RLS.
create function public.current_org_id() returns uuid
language sql stable security definer set search_path = '' as $$
  select org_id from public.users where id = auth.uid()
$$;

create function public.current_user_role() returns public.user_role
language sql stable security definer set search_path = '' as $$
  select role from public.users where id = auth.uid()
$$;

create function public.is_org_member(target_org uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(
    exists (
      select 1 from public.users
      where id = auth.uid() and org_id = target_org and role in ('owner', 'staff')
    ), false)
$$;

create function public.current_client_ids() returns setof uuid
language sql stable security definer set search_path = '' as $$
  select id from public.clients where user_id = auth.uid()
$$;

revoke all on function public.current_org_id(), public.current_user_role(),
  public.is_org_member(uuid), public.current_client_ids() from public, anon;
grant execute on function public.current_org_id(), public.current_user_role(),
  public.is_org_member(uuid), public.current_client_ids() to authenticated;

-- Provision org + profile on sign-up. The role is NEVER read from user-supplied metadata:
-- every self-registered account is the owner of its own new org. Staff/clients are added by owners.
create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  new_org uuid;
  org_mode public.org_mode;
  display_name text;
begin
  org_mode := case when new.raw_user_meta_data ->> 'mode' = 'agency' then 'agency' else 'personal' end;
  display_name := nullif(left(trim(coalesce(new.raw_user_meta_data ->> 'full_name', '')), 120), '');

  insert into public.organizations (name, mode)
  values (
    coalesce(nullif(left(trim(coalesce(new.raw_user_meta_data ->> 'org_name', '')), 120), ''),
             coalesce(display_name, split_part(new.email, '@', 1)) || case when org_mode = 'agency' then ' Agency' else '' end),
    org_mode)
  returning id into new_org;

  insert into public.users (id, org_id, role, email, full_name)
  values (new.id, new_org, 'owner', new.email, display_name);

  if org_mode = 'personal' then
    insert into public.clients (org_id, user_id, full_name, email, status)
    values (new_org, null, coalesce(display_name, 'Me'), new.email, 'active');
  end if;
  return new;
end $$;

create trigger on_auth_user_created
after insert on auth.users for each row execute function public.handle_new_user();

-- Audit logs are append-only, enforced even for privileged roles.
create function public.audit_logs_immutable() returns trigger
language plpgsql as $$
begin
  raise exception 'audit_logs is append-only';
end $$;

create trigger audit_logs_no_update_delete
before update or delete on public.audit_logs for each row execute function public.audit_logs_immutable();
create trigger audit_logs_no_truncate
before truncate on public.audit_logs for each statement execute function public.audit_logs_immutable();

-- ---------------------------------------------------------------- RLS
alter table public.organizations enable row level security;
alter table public.users enable row level security;
alter table public.clients enable row level security;
alter table public.documents enable row level security;
alter table public.credit_reports enable row level security;
alter table public.tradelines enable row level security;
alter table public.disputes enable row level security;
alter table public.dispute_rounds enable row level security;
alter table public.templates enable row level security;
alter table public.letters enable row level security;
alter table public.mail_jobs enable row level security;
alter table public.audit_logs enable row level security;

-- Table-level privileges: anon gets nothing; authenticated is gated by RLS.
revoke all on all tables in schema public from anon;
grant select, insert, update, delete on all tables in schema public to authenticated;
revoke update, delete, truncate on public.audit_logs from authenticated;
-- Users may only edit their own display name; role/org changes go through the service role.
revoke update on public.users from authenticated;
grant update (full_name) on public.users to authenticated;
revoke insert, delete on public.users from authenticated;
revoke insert, delete on public.organizations from authenticated;

-- organizations: members see their org; owners edit it.
create policy organizations_select on public.organizations for select to authenticated
  using (id = public.current_org_id());
create policy organizations_update on public.organizations for update to authenticated
  using (id = public.current_org_id() and public.current_user_role() = 'owner')
  with check (id = public.current_org_id());

-- users: see yourself; owner/staff see their org; only own full_name is updatable.
create policy users_select on public.users for select to authenticated
  using (id = auth.uid() or public.is_org_member(org_id));
create policy users_update_self on public.users for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

-- clients: owner/staff manage within org; a client sees only their own record.
create policy clients_staff_all on public.clients for all to authenticated
  using (public.is_org_member(org_id)) with check (public.is_org_member(org_id));
create policy clients_self_select on public.clients for select to authenticated
  using (user_id = auth.uid());

-- documents: staff manage; clients see and upload their own.
create policy documents_staff_all on public.documents for all to authenticated
  using (public.is_org_member(org_id)) with check (public.is_org_member(org_id));
create policy documents_client_select on public.documents for select to authenticated
  using (client_id in (select public.current_client_ids()));
create policy documents_client_insert on public.documents for insert to authenticated
  with check (client_id in (select public.current_client_ids())
              and org_id = public.current_org_id() and uploaded_by = auth.uid());

-- credit_reports / tradelines / disputes / dispute_rounds / letters: staff manage; clients read their own.
create policy credit_reports_staff_all on public.credit_reports for all to authenticated
  using (public.is_org_member(org_id)) with check (public.is_org_member(org_id));
create policy credit_reports_client_select on public.credit_reports for select to authenticated
  using (client_id in (select public.current_client_ids()));

create policy tradelines_staff_all on public.tradelines for all to authenticated
  using (public.is_org_member(org_id)) with check (public.is_org_member(org_id));
create policy tradelines_client_select on public.tradelines for select to authenticated
  using (client_id in (select public.current_client_ids()));

create policy disputes_staff_all on public.disputes for all to authenticated
  using (public.is_org_member(org_id)) with check (public.is_org_member(org_id));
create policy disputes_client_select on public.disputes for select to authenticated
  using (client_id in (select public.current_client_ids()));

create policy dispute_rounds_staff_all on public.dispute_rounds for all to authenticated
  using (public.is_org_member(org_id)) with check (public.is_org_member(org_id));
create policy dispute_rounds_client_select on public.dispute_rounds for select to authenticated
  using (dispute_id in (select id from public.disputes where client_id in (select public.current_client_ids())));

create policy letters_staff_all on public.letters for all to authenticated
  using (public.is_org_member(org_id)) with check (public.is_org_member(org_id));
create policy letters_client_select on public.letters for select to authenticated
  using (dispute_id in (select id from public.disputes where client_id in (select public.current_client_ids())));

-- mail_jobs: staff only.
create policy mail_jobs_staff_all on public.mail_jobs for all to authenticated
  using (public.is_org_member(org_id)) with check (public.is_org_member(org_id));

-- templates: system templates (org_id null) are readable by any signed-in user; org templates by org staff.
create policy templates_select on public.templates for select to authenticated
  using ((org_id is null and public.current_user_role() in ('owner', 'staff')) or public.is_org_member(org_id));
create policy templates_staff_write on public.templates for all to authenticated
  using (org_id is not null and public.is_org_member(org_id))
  with check (org_id is not null and public.is_org_member(org_id));

-- audit_logs: any org member may append (as themselves); only owners read; no update/delete policies exist.
create policy audit_logs_insert on public.audit_logs for insert to authenticated
  with check (org_id = public.current_org_id() and actor_id = auth.uid());
create policy audit_logs_owner_select on public.audit_logs for select to authenticated
  using (org_id = public.current_org_id() and public.current_user_role() = 'owner');
-- Phase 2: private document vault, report imports (parse + review), tradeline provenance.

-- Private bucket; objects live under "<org_id>/<client_id>/<uuid>-<name>".
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('vault', 'vault', false, 10485760,
        array['application/pdf', 'image/png', 'image/jpeg', 'text/plain', 'text/html'])
on conflict (id) do update set public = false;

create policy vault_staff_select on storage.objects for select to authenticated
  using (bucket_id = 'vault' and public.is_org_member(((storage.foldername(name))[1])::uuid));
create policy vault_staff_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'vault' and public.is_org_member(((storage.foldername(name))[1])::uuid));
create policy vault_staff_delete on storage.objects for delete to authenticated
  using (bucket_id = 'vault' and public.is_org_member(((storage.foldername(name))[1])::uuid));

create type public.import_status as enum ('pending_review', 'approved', 'rejected');

create table public.report_imports (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  client_id uuid not null references public.clients (id) on delete cascade,
  document_id uuid references public.documents (id) on delete set null,
  report_id uuid references public.credit_reports (id) on delete set null,
  status public.import_status not null default 'pending_review',
  -- [{field, value, confidence, snippet}] per item; snippets are short and PII-masked by the parser.
  parsed jsonb not null default '[]'::jsonb,
  created_by uuid references public.users (id) on delete set null,
  created_at timestamptz not null default now()
);
create index report_imports_org_id_idx on public.report_imports (org_id);
create index report_imports_client_id_idx on public.report_imports (client_id);
create index report_imports_document_id_idx on public.report_imports (document_id);
create index report_imports_report_id_idx on public.report_imports (report_id);

alter table public.report_imports enable row level security;
revoke all on public.report_imports from anon;
grant select, insert, update, delete on public.report_imports to authenticated;
create policy report_imports_staff_all on public.report_imports for all to authenticated
  using (public.is_org_member(org_id)) with check (public.is_org_member(org_id));

-- Provenance + diffing support on tradelines.
alter table public.tradelines
  add column original_creditor text,
  add column date_of_first_delinquency date,
  add column confidence numeric(3, 2) check (confidence between 0 and 1),
  add column fingerprint text not null default '';
create index tradelines_report_id_idx on public.tradelines (report_id);
create index tradelines_fingerprint_idx on public.tradelines (client_id, fingerprint);
create index credit_reports_document_id_idx on public.credit_reports (document_id);
create index documents_uploaded_by_idx on public.documents (uploaded_by);

-- Client notes/tags.
alter table public.clients add column tags text[] not null default '{}', add column notes text;
