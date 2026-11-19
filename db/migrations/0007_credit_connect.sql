-- 0007 Credit Connect: API keys, report pulls (automatic import), reported credit scores.

create table public.api_keys (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  prefix text not null unique check (prefix ~ '^[a-z0-9]{8}$'),
  key_hash text not null unique, -- sha-256 of the full key; the key itself is shown once and never stored
  scopes text[] not null default '{}',
  created_by uuid not null references public.users (id) on delete cascade, -- API calls run with this user's row-level security
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
create index api_keys_org_idx on public.api_keys (org_id);

-- One row per attempt to bring a report in automatically (provider pull or inbound API push).
create table public.report_pulls (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  client_id uuid not null references public.clients (id) on delete cascade,
  provider text not null check (char_length(provider) <= 40),
  mode text not null check (mode in ('pull', 'inbound')),
  status text not null default 'requested' check (status in ('requested', 'imported', 'failed')),
  consent_id uuid references public.client_consents (id) on delete set null, -- the written authorization relied on
  external_ref text check (external_ref is null or char_length(external_ref) <= 120),
  report_ids uuid[] not null default '{}',
  error text check (error is null or char_length(error) <= 500),
  requested_by uuid references public.users (id) on delete set null,
  actor_label text,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);
create index report_pulls_client_idx on public.report_pulls (client_id, created_at desc);
create index report_pulls_org_idx on public.report_pulls (org_id, created_at desc);

-- Scores exactly as a report states them. Never computed, estimated or projected.
create table public.credit_scores (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  client_id uuid not null references public.clients (id) on delete cascade,
  report_id uuid not null references public.credit_reports (id) on delete cascade,
  bureau text not null check (bureau in ('experian', 'equifax', 'transunion')),
  model text not null check (char_length(model) <= 60),
  score int not null check (score between 250 and 900),
  scored_on date not null,
  created_at timestamptz not null default now(),
  unique (report_id, model)
);
create index credit_scores_client_idx on public.credit_scores (client_id, scored_on);
create index credit_scores_org_idx on public.credit_scores (org_id);

alter table public.api_keys enable row level security;
alter table public.report_pulls enable row level security;
alter table public.credit_scores enable row level security;

grant select, insert, update, delete on public.api_keys, public.report_pulls, public.credit_scores to disputeos_rls;

create policy api_keys_admin on public.api_keys for all to disputeos_rls
  using (app.is_admin(org_id)) with check (app.is_admin(org_id) and created_by = app.uid());
create policy report_pulls_staff on public.report_pulls for all to disputeos_rls
  using (app.is_staff(org_id)) with check (app.is_staff(org_id));
create policy credit_scores_staff on public.credit_scores for all to disputeos_rls
  using (app.is_staff(org_id)) with check (app.is_staff(org_id));
create policy credit_scores_self on public.credit_scores for select to disputeos_rls
  using (client_id in (select app.client_ids()));
