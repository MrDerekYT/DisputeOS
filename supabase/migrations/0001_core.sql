-- Phase 1: tenancy, roles, clients, consents, audit log. RLS on every table.
create extension if not exists pgcrypto;

create type public.member_role as enum ('owner', 'admin', 'staff', 'client');

create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  mode text not null default 'agency' check (mode in ('personal', 'agency')),
  state_code char(2),
  created_at timestamptz not null default now()
);

create table public.memberships (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role public.member_role not null,
  created_at timestamptz not null default now(),
  unique (organization_id, user_id)
);
create index memberships_user_idx on public.memberships (user_id);

create table public.clients (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid references auth.users(id) on delete set null,
  full_name text not null,
  email text,
  preferred_language text not null default 'en' check (preferred_language in ('en', 'es')),
  -- Field-level encrypted (AES-256-GCM at app layer); only last 4 stored in the clear.
  ssn_encrypted text,
  ssn_last4 char(4),
  dob_encrypted text,
  tags text[] not null default '{}',
  created_at timestamptz not null default now()
);
create index clients_org_idx on public.clients (organization_id, created_at desc);
create index clients_user_idx on public.clients (user_id);

create table public.client_consents (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  kind text not null check (kind in ('croa_contract', 'croa_disclosure', 'esign', 'sms_tcpa', 'data_processing')),
  document_sha256 text,
  ip inet,
  user_agent text,
  signed_at timestamptz not null default now(),
  revoked_at timestamptz
);
create index client_consents_client_idx on public.client_consents (client_id, kind);
create index client_consents_org_idx on public.client_consents (organization_id);

create table public.audit_logs (
  id bigint generated always as identity primary key,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  actor_id uuid,
  action text not null,
  entity text,
  entity_id uuid,
  reason text,
  meta jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index audit_logs_org_idx on public.audit_logs (organization_id, created_at desc);

-- Helpers (security definer so policies don't recurse into memberships RLS).
create or replace function public.is_member(org uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from memberships where organization_id = org and user_id = auth.uid());
$$;

create or replace function public.has_role(org uuid, roles public.member_role[])
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from memberships
    where organization_id = org and user_id = auth.uid() and role = any(roles));
$$;

-- Staff roles require an MFA (aal2) session.
create or replace function public.staff_aal2(org uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select case
    when exists (select 1 from memberships where organization_id = org and user_id = auth.uid() and role in ('owner','admin','staff'))
      then coalesce(auth.jwt() ->> 'aal', 'aal1') = 'aal2'
    else true end;
$$;

alter table public.organizations enable row level security;
alter table public.memberships enable row level security;
alter table public.clients enable row level security;
alter table public.client_consents enable row level security;
alter table public.audit_logs enable row level security;

create policy org_select on public.organizations for select using (public.is_member(id));
create policy org_update on public.organizations for update
  using (public.has_role(id, array['owner']::public.member_role[]));

create policy mem_select on public.memberships for select
  using (user_id = auth.uid() or public.has_role(organization_id, array['owner','admin']::public.member_role[]));
create policy mem_write on public.memberships for all
  using (public.has_role(organization_id, array['owner','admin']::public.member_role[]) and public.staff_aal2(organization_id))
  with check (public.has_role(organization_id, array['owner','admin']::public.member_role[]) and public.staff_aal2(organization_id));

create policy clients_staff on public.clients for all
  using (public.has_role(organization_id, array['owner','admin','staff']::public.member_role[]) and public.staff_aal2(organization_id))
  with check (public.has_role(organization_id, array['owner','admin','staff']::public.member_role[]) and public.staff_aal2(organization_id));
create policy clients_self on public.clients for select using (user_id = auth.uid());

create policy consents_staff on public.client_consents for all
  using (public.has_role(organization_id, array['owner','admin','staff']::public.member_role[]) and public.staff_aal2(organization_id))
  with check (public.has_role(organization_id, array['owner','admin','staff']::public.member_role[]) and public.staff_aal2(organization_id));
create policy consents_self on public.client_consents for select
  using (exists (select 1 from public.clients c where c.id = client_id and c.user_id = auth.uid()));

-- Audit log is append-only: insert + read, never update/delete.
create policy audit_read on public.audit_logs for select
  using (public.has_role(organization_id, array['owner','admin']::public.member_role[]));
create policy audit_insert on public.audit_logs for insert
  with check (public.is_member(organization_id) and actor_id = auth.uid());
revoke update, delete on public.audit_logs from anon, authenticated;

-- Seed: Florida state rule marker lives in a later phase (state_rules table).
