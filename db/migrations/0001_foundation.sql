-- 0001 Foundation: tenancy, identity, sessions, audit.
-- Data access model: the app connects as the table owner. Tenant-scoped requests run inside a transaction that does
--   SET LOCAL ROLE disputeos_rls  +  set_config('app.user_id', <uuid>, true)
-- so every row-level-security policy below is enforced by PostgreSQL itself, not just by application code.
-- (Creating the role needs CREATEROLE once; see docs/ENVIRONMENTS.md for managed databases.)

create schema if not exists app;

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'disputeos_rls') then
    create role disputeos_rls nologin noinherit;
  end if;
end $$;

grant usage on schema public, app to disputeos_rls;

-- ---------------------------------------------------------------- tenancy
create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 160),
  slug text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  mode text not null default 'agency' check (mode in ('agency', 'personal')),
  state_code char(2),
  status text not null default 'active' check (status in ('active', 'suspended')),
  plan text not null default 'trial' check (plan in ('trial', 'starter', 'growth', 'scale')),
  plan_status text not null default 'trialing' check (plan_status in ('trialing', 'active', 'past_due', 'cancelled')),
  trial_ends_at timestamptz,
  settings jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table public.users (
  id uuid primary key default gen_random_uuid(),
  email text not null unique check (email = lower(email) and char_length(email) <= 254),
  password_hash text not null,
  full_name text not null default '' check (char_length(full_name) <= 160),
  totp_secret_encrypted text,
  totp_enabled boolean not null default false,
  totp_last_step bigint,
  failed_logins int not null default 0,
  locked_until timestamptz,
  email_verified_at timestamptz,
  last_login_at timestamptz,
  disabled_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.memberships (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  user_id uuid not null references public.users (id) on delete cascade,
  role text not null check (role in ('owner', 'admin', 'manager', 'specialist', 'client')),
  created_at timestamptz not null default now(),
  unique (org_id, user_id)
);
create index memberships_user_idx on public.memberships (user_id);

create table public.sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  org_id uuid not null references public.organizations (id) on delete cascade,
  token_hash text not null unique,
  mfa_verified boolean not null default false,
  ip text,
  user_agent text,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz
);
create index sessions_user_idx on public.sessions (user_id);

create table public.password_resets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.invites (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  email text not null check (email = lower(email)),
  role text not null check (role in ('admin', 'manager', 'specialist', 'client')),
  client_id uuid,
  token_hash text not null unique,
  invited_by uuid references public.users (id) on delete set null,
  expires_at timestamptz not null,
  accepted_at timestamptz,
  created_at timestamptz not null default now()
);
create index invites_org_idx on public.invites (org_id);

-- Fixed-window rate limiting that works across serverless instances.
create table public.rate_limits (
  key text not null,
  window_start timestamptz not null,
  hits int not null default 0,
  primary key (key, window_start)
);

-- ---------------------------------------------------------------- audit (append-only)
create table public.audit_logs (
  id bigint generated always as identity primary key,
  -- Deliberately NO foreign keys: audit rows are immutable history and must never block (or be changed by) the
  -- deletion of a user or an organization. They keep the ids as a record of what happened.
  org_id uuid,
  actor_id uuid,
  actor_label text,
  action text not null,
  entity_type text,
  entity_id uuid,
  ip text,
  metadata jsonb not null default '{}'::jsonb, -- never put PII or report contents here
  created_at timestamptz not null default now()
);
create index audit_logs_org_idx on public.audit_logs (org_id, created_at desc);

create function app.audit_immutable() returns trigger language plpgsql as $$
begin
  raise exception 'audit_logs is append-only';
end $$;
create trigger audit_logs_no_change before update or delete on public.audit_logs
  for each row execute function app.audit_immutable();
create trigger audit_logs_no_truncate before truncate on public.audit_logs
  for each statement execute function app.audit_immutable();

-- ---------------------------------------------------------------- RLS helpers
create function app.uid() returns uuid language sql stable as
  $$ select nullif(current_setting('app.user_id', true), '')::uuid $$;

create function app.staff_roles() returns text[] language sql immutable as
  $$ select array['owner', 'admin', 'manager', 'specialist'] $$;

-- SECURITY DEFINER so policies can consult memberships without recursing into its own RLS.
create function app.is_member(target_org uuid, roles text[] default null) returns boolean
language sql stable security definer set search_path = pg_catalog, public as $$
  select exists (
    select 1 from public.memberships m
    where m.org_id = target_org and m.user_id = app.uid() and (roles is null or m.role = any (roles)))
$$;

create function app.is_staff(target_org uuid) returns boolean language sql stable as
  $$ select app.is_member(target_org, app.staff_roles()) $$;

create function app.is_admin(target_org uuid) returns boolean language sql stable as
  $$ select app.is_member(target_org, array['owner', 'admin']) $$;

create function app.shares_org_with(target_user uuid) returns boolean
language sql stable security definer set search_path = pg_catalog, public as $$
  select exists (
    select 1 from public.memberships a join public.memberships b on a.org_id = b.org_id
    where a.user_id = app.uid() and b.user_id = target_user and a.role = any (app.staff_roles()))
$$;

create function app.touch_updated_at() returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;
