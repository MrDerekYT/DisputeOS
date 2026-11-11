-- 0004 Automation engine, in-app notifications, billing.

create table public.automations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 160),
  trigger text not null check (trigger in ('client_created', 'missing_documents', 'dispute_deadline', 'dispute_status_changed', 'client_inactive', 'report_uploaded', 'weekly_digest')),
  conditions jsonb not null default '{}'::jsonb,
  actions jsonb not null default '[]'::jsonb,
  enabled boolean not null default false,
  -- Safeguards: client-facing actions wait for a human unless explicitly turned off, and a single run is capped.
  requires_approval boolean not null default true,
  max_subjects_per_run int not null default 25 check (max_subjects_per_run between 1 and 500),
  cooldown_days int not null default 7 check (cooldown_days between 0 and 365),
  created_by uuid references public.users (id) on delete set null,
  created_at timestamptz not null default now()
);
create index automations_org_idx on public.automations (org_id, enabled);

create table public.automation_runs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  automation_id uuid not null references public.automations (id) on delete cascade,
  -- Idempotency: one run per (automation, subject, cooldown bucket). Duplicate messages are impossible by construction.
  dedupe_key text not null,
  subject_type text not null,
  subject_id uuid,
  status text not null check (status in ('completed', 'pending_approval', 'cancelled', 'failed')),
  result jsonb not null default '{}'::jsonb,
  decided_by uuid references public.users (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (automation_id, dedupe_key)
);
create index automation_runs_org_idx on public.automation_runs (org_id, created_at desc);

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  user_id uuid not null references public.users (id) on delete cascade,
  title text not null check (char_length(title) <= 200),
  body text check (body is null or char_length(body) <= 1000),
  href text,
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create index notifications_user_idx on public.notifications (user_id, read_at, created_at desc);
create index notifications_org_idx on public.notifications (org_id);

-- ---------------------------------------------------------------- billing (the agency's own client billing)
create table public.service_plans (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  name text not null check (char_length(name) <= 120),
  price_cents bigint not null check (price_cents >= 0),
  interval text not null default 'month' check (interval in ('month', 'one_time')),
  description text check (description is null or char_length(description) <= 500),
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create index service_plans_org_idx on public.service_plans (org_id);

create table public.client_subscriptions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  client_id uuid not null references public.clients (id) on delete cascade,
  plan_id uuid not null references public.service_plans (id) on delete restrict,
  status text not null default 'active' check (status in ('active', 'paused', 'cancelled')),
  started_at timestamptz not null default now(),
  cancelled_at timestamptz,
  created_at timestamptz not null default now()
);
create index client_subscriptions_client_idx on public.client_subscriptions (client_id);
create index client_subscriptions_org_idx on public.client_subscriptions (org_id, status);

create table public.payments (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  client_id uuid not null references public.clients (id) on delete cascade,
  subscription_id uuid references public.client_subscriptions (id) on delete set null,
  amount_cents bigint not null check (amount_cents > 0),
  currency char(3) not null default 'USD',
  method text not null default 'other' check (method in ('card', 'ach', 'cash', 'check', 'other')),
  status text not null default 'succeeded' check (status in ('succeeded', 'pending', 'failed', 'refunded')),
  provider text not null default 'manual' check (provider in ('manual', 'stripe')),
  provider_ref text,
  note text check (note is null or char_length(note) <= 500),
  paid_at timestamptz not null default now(),
  recorded_by uuid references public.users (id) on delete set null,
  created_at timestamptz not null default now()
);
create index payments_client_idx on public.payments (client_id, paid_at desc);
create index payments_org_idx on public.payments (org_id, paid_at desc);
create unique index payments_provider_ref_idx on public.payments (provider, provider_ref) where provider_ref is not null;

-- Payment-provider webhooks are idempotent on (provider, event_id). System access only.
create table public.webhook_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  event_id text not null,
  payload jsonb not null,
  processed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (provider, event_id)
);
