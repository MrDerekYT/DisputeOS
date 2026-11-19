-- 0002 CRM: clients, consents, notes, tasks, communications, timeline, document vault.

create table public.clients (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  assigned_to uuid references public.users (id) on delete set null,
  portal_user_id uuid unique references public.users (id) on delete set null,
  full_name text not null check (char_length(full_name) between 1 and 160),
  email text check (email is null or email = lower(email)),
  phone text check (phone is null or char_length(phone) <= 30),
  preferred_language text not null default 'en' check (preferred_language in ('en', 'es')),
  status text not null default 'lead' check (status in ('lead', 'onboarding', 'active', 'paused', 'completed', 'cancelled')),
  stage text not null default 'intake' check (stage in ('intake', 'analysis', 'disputing', 'monitoring', 'graduated')),
  source text check (source is null or char_length(source) <= 80),
  address jsonb not null default '{}'::jsonb,
  -- Only the last 4 are stored in the clear; full values are AES-256-GCM encrypted by the app.
  ssn_last4 char(4) check (ssn_last4 ~ '^[0-9]{4}$'),
  ssn_encrypted text,
  dob_encrypted text,
  tags text[] not null default '{}',
  goals text check (goals is null or char_length(goals) <= 2000),
  last_activity_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index clients_org_idx on public.clients (org_id, created_at desc);
create index clients_assigned_idx on public.clients (org_id, assigned_to);
create index clients_status_idx on public.clients (org_id, status);
create trigger clients_touch before update on public.clients for each row execute function app.touch_updated_at();

create function app.client_ids() returns setof uuid
language sql stable security definer set search_path = pg_catalog, public as $$
  select id from public.clients where portal_user_id = app.uid()
$$;

-- Portal clients may update only contact fields on their own record; everything else is staff-only.
create function app.clients_portal_guard() returns trigger language plpgsql as $$
begin
  if current_user = 'disputeos_rls' and not app.is_staff(old.org_id) then
    if (new.org_id, new.assigned_to, new.portal_user_id, new.full_name, new.email, new.status, new.stage,
        new.source, new.ssn_last4, new.ssn_encrypted, new.dob_encrypted, new.tags, new.goals, new.id)
       is distinct from
       (old.org_id, old.assigned_to, old.portal_user_id, old.full_name, old.email, old.status, old.stage,
        old.source, old.ssn_last4, old.ssn_encrypted, old.dob_encrypted, old.tags, old.goals, old.id) then
      raise exception 'portal users may only update phone, address and preferred language';
    end if;
  end if;
  return new;
end $$;
create trigger clients_portal_guard before update on public.clients for each row execute function app.clients_portal_guard();

-- Consent ledger: CROA disclosure/contract, FCRA authorization, e-sign, communications.
create table public.client_consents (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  client_id uuid not null references public.clients (id) on delete cascade,
  kind text not null check (kind in ('croa_disclosure', 'croa_contract', 'fcra_authorization', 'esign', 'communications', 'data_processing')),
  version text not null,
  signed_name text not null check (char_length(signed_name) between 1 and 160),
  ip text,
  user_agent text,
  signed_at timestamptz not null default now(),
  revoked_at timestamptz
);
create index client_consents_client_idx on public.client_consents (client_id, kind);
create index client_consents_org_idx on public.client_consents (org_id);

create table public.client_notes (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  client_id uuid not null references public.clients (id) on delete cascade,
  author_id uuid references public.users (id) on delete set null,
  body text not null check (char_length(body) between 1 and 5000),
  pinned boolean not null default false,
  created_at timestamptz not null default now()
);
create index client_notes_client_idx on public.client_notes (client_id, created_at desc);
create index client_notes_org_idx on public.client_notes (org_id);

create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  client_id uuid references public.clients (id) on delete cascade,
  dispute_id uuid,
  assignee_id uuid references public.users (id) on delete set null,
  created_by uuid references public.users (id) on delete set null,
  title text not null check (char_length(title) between 1 and 200),
  detail text check (detail is null or char_length(detail) <= 2000),
  kind text not null default 'general' check (kind in ('general', 'follow_up', 'document', 'review', 'deadline')),
  due_at timestamptz,
  status text not null default 'open' check (status in ('open', 'done', 'cancelled')),
  source text not null default 'manual' check (source in ('manual', 'automation')),
  dedupe_key text,
  completed_at timestamptz,
  created_at timestamptz not null default now()
);
create index tasks_org_open_idx on public.tasks (org_id, status, due_at);
create index tasks_assignee_idx on public.tasks (assignee_id, status);
create index tasks_client_idx on public.tasks (client_id);
create unique index tasks_dedupe_idx on public.tasks (org_id, dedupe_key) where dedupe_key is not null and status = 'open';

create table public.communications (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  client_id uuid not null references public.clients (id) on delete cascade,
  direction text not null check (direction in ('inbound', 'outbound', 'internal')),
  channel text not null check (channel in ('portal', 'email', 'sms', 'call', 'mail')),
  subject text check (subject is null or char_length(subject) <= 200),
  body text not null check (char_length(body) between 1 and 10000),
  status text not null default 'sent' check (status in ('draft', 'pending_approval', 'queued', 'sent', 'delivered', 'failed', 'received')),
  author_id uuid references public.users (id) on delete set null,
  approved_by uuid references public.users (id) on delete set null,
  provider_ref text,
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create index communications_client_idx on public.communications (client_id, created_at desc);
create index communications_org_idx on public.communications (org_id, created_at desc);

-- Client activity timeline.
create table public.client_events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  client_id uuid not null references public.clients (id) on delete cascade,
  actor_id uuid references public.users (id) on delete set null,
  kind text not null,
  summary text not null check (char_length(summary) <= 300),
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default clock_timestamp()
);
create index client_events_client_idx on public.client_events (client_id, created_at desc);
create index client_events_org_idx on public.client_events (org_id);

-- Document vault. Bytes live in the configured storage backend, always encrypted (AES-256-GCM) before write.
create table public.documents (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  client_id uuid not null references public.clients (id) on delete cascade,
  kind text not null default 'other' check (kind in ('id', 'proof_of_address', 'ssn_proof', 'credit_report', 'bureau_response', 'ftc_report', 'police_report', 'contract', 'evidence', 'other')),
  file_name text not null check (char_length(file_name) <= 200),
  mime_type text not null,
  size_bytes bigint not null check (size_bytes >= 0),
  sha256 text not null,
  storage_key text not null,
  uploaded_by uuid references public.users (id) on delete set null,
  source text not null default 'staff' check (source in ('staff', 'client')),
  review_status text not null default 'pending_review' check (review_status in ('pending_review', 'accepted', 'rejected')),
  created_at timestamptz not null default now()
);
create index documents_client_idx on public.documents (client_id, created_at desc);
create index documents_org_idx on public.documents (org_id);

create table public.document_requests (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  client_id uuid not null references public.clients (id) on delete cascade,
  kind text not null check (kind in ('id', 'proof_of_address', 'ssn_proof', 'credit_report', 'bureau_response', 'ftc_report', 'police_report', 'evidence', 'other')),
  note text check (note is null or char_length(note) <= 500),
  due_at timestamptz,
  fulfilled_document_id uuid references public.documents (id) on delete set null,
  created_by uuid references public.users (id) on delete set null,
  created_at timestamptz not null default now()
);
create index document_requests_client_idx on public.document_requests (client_id);
create index document_requests_org_idx on public.document_requests (org_id);
