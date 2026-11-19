-- 0003 Credit reports, findings, disputes, letters.

create table public.credit_reports (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  client_id uuid not null references public.clients (id) on delete cascade,
  document_id uuid references public.documents (id) on delete set null,
  bureau text check (bureau in ('experian', 'equifax', 'transunion')),
  source text not null default 'upload' check (source in ('upload', 'csv', 'provider', 'manual')),
  status text not null default 'pending_review' check (status in ('pending_review', 'approved', 'rejected')),
  report_date date,
  warnings jsonb not null default '[]'::jsonb,
  created_by uuid references public.users (id) on delete set null,
  approved_by uuid references public.users (id) on delete set null,
  created_at timestamptz not null default now()
);
create index credit_reports_client_idx on public.credit_reports (client_id, created_at desc);
create index credit_reports_org_idx on public.credit_reports (org_id);

create table public.tradelines (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  client_id uuid not null references public.clients (id) on delete cascade,
  report_id uuid not null references public.credit_reports (id) on delete cascade,
  bureau text not null check (bureau in ('experian', 'equifax', 'transunion')),
  item_type text not null default 'tradeline' check (item_type in ('tradeline', 'collection')),
  creditor_name text not null check (char_length(creditor_name) <= 200),
  original_creditor text,
  account_last4 text check (account_last4 is null or account_last4 ~ '^[0-9A-Za-z]{0,4}$'), -- never the full number
  account_type text,
  account_status text,       -- open / closed / paid / transferred ...
  payment_status text,       -- current / late_30 / charge_off / collection ...
  balance_cents bigint,
  credit_limit_cents bigint,
  high_balance_cents bigint,
  date_opened date,
  date_reported date,
  date_of_first_delinquency date,
  payment_history text,      -- month codes as reported, e.g. "CCC30C"
  remarks text,
  match_key text not null default '',
  confidence numeric(3, 2) check (confidence between 0 and 1),
  field_meta jsonb not null default '{}'::jsonb,  -- per-field confidence + masked source snippet
  user_provided jsonb not null default '{}'::jsonb, -- what the client/staff asserts; kept apart from reported data
  reviewed_at timestamptz,
  created_at timestamptz not null default now()
);
create index tradelines_client_idx on public.tradelines (client_id, bureau);
create index tradelines_report_idx on public.tradelines (report_id);
create index tradelines_match_idx on public.tradelines (client_id, match_key);
create index tradelines_org_idx on public.tradelines (org_id);

create table public.inquiries (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  client_id uuid not null references public.clients (id) on delete cascade,
  report_id uuid not null references public.credit_reports (id) on delete cascade,
  bureau text not null check (bureau in ('experian', 'equifax', 'transunion')),
  name text not null check (char_length(name) <= 200),
  inquiry_date date,
  kind text not null default 'hard' check (kind in ('hard', 'soft')),
  created_at timestamptz not null default now()
);
create index inquiries_client_idx on public.inquiries (client_id);
create index inquiries_report_idx on public.inquiries (report_id);
create index inquiries_org_idx on public.inquiries (org_id);

create table public.public_records (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  client_id uuid not null references public.clients (id) on delete cascade,
  report_id uuid not null references public.credit_reports (id) on delete cascade,
  bureau text not null check (bureau in ('experian', 'equifax', 'transunion')),
  kind text not null check (char_length(kind) <= 80),
  court text,
  amount_cents bigint,
  filed_date date,
  status text,
  created_at timestamptz not null default now()
);
create index public_records_client_idx on public.public_records (client_id);
create index public_records_report_idx on public.public_records (report_id);
create index public_records_org_idx on public.public_records (org_id);

-- Personal-information lines as each bureau reports them (names, addresses, employers).
create table public.report_identity_items (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  client_id uuid not null references public.clients (id) on delete cascade,
  report_id uuid not null references public.credit_reports (id) on delete cascade,
  bureau text not null check (bureau in ('experian', 'equifax', 'transunion')),
  kind text not null check (kind in ('name', 'address', 'employer')),
  value text not null check (char_length(value) <= 300),
  created_at timestamptz not null default now()
);
create index report_identity_client_idx on public.report_identity_items (client_id);
create index report_identity_report_idx on public.report_identity_items (report_id);
create index report_identity_org_idx on public.report_identity_items (org_id);

-- Potential reporting issues surfaced for a human to review. Never an automatic accusation.
create table public.findings (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  client_id uuid not null references public.clients (id) on delete cascade,
  category text not null,
  severity text not null default 'review' check (severity in ('info', 'review', 'strong')),
  title text not null check (char_length(title) <= 200),
  explanation text not null,
  evidence jsonb not null default '[]'::jsonb, -- [{bureau, field, value, basis}] — what supports the finding
  basis text not null check (basis in ('verified_fact', 'user_provided', 'potential_discrepancy')),
  tradeline_ids uuid[] not null default '{}',
  status text not null default 'suggested' check (status in ('suggested', 'accepted', 'dismissed', 'disputed')),
  generated_by text not null default 'rules',
  dedupe_key text not null,
  reviewed_by uuid references public.users (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (client_id, dedupe_key)
);
create index findings_client_idx on public.findings (client_id, status);
create index findings_org_idx on public.findings (org_id);

-- ---------------------------------------------------------------- disputes
create table public.disputes (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  client_id uuid not null references public.clients (id) on delete cascade,
  tradeline_id uuid references public.tradelines (id) on delete set null,
  finding_id uuid references public.findings (id) on delete set null,
  parent_dispute_id uuid references public.disputes (id) on delete set null,
  item_label text not null check (char_length(item_label) <= 300), -- denormalised so the portal never needs report access
  target_type text not null default 'bureau' check (target_type in ('bureau', 'furnisher', 'collector')),
  bureau text check (bureau in ('experian', 'equifax', 'transunion')),
  recipient_name text not null,
  category text not null,
  reason text not null check (char_length(reason) between 10 and 4000),
  fields text[] not null default '{}',
  workflow text not null default 'standard' check (workflow in ('standard', 'furnisher_direct', 'validation', 'personal_info', 'goodwill')),
  status text not null default 'draft' check (status in ('draft', 'ready_for_review', 'approved', 'submitted', 'under_investigation', 'response_received', 'resolved', 'on_hold', 'cancelled')),
  round int not null default 1 check (round >= 1),
  submitted_at timestamptz,
  due_at timestamptz,
  deadline_extended boolean not null default false,
  response_at timestamptz,
  outcome text check (outcome in ('deleted', 'updated', 'verified', 'unresolved', 'no_response')),
  outcome_notes text check (outcome_notes is null or char_length(outcome_notes) <= 4000),
  assigned_to uuid references public.users (id) on delete set null,
  created_by uuid references public.users (id) on delete set null,
  approved_by uuid references public.users (id) on delete set null,
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index disputes_org_status_idx on public.disputes (org_id, status);
create index disputes_client_idx on public.disputes (client_id);
create index disputes_due_idx on public.disputes (org_id, due_at) where status in ('submitted', 'under_investigation');
create trigger disputes_touch before update on public.disputes for each row execute function app.touch_updated_at();

alter table public.tasks add constraint tasks_dispute_fk foreign key (dispute_id) references public.disputes (id) on delete cascade;

-- Complete audit trail for each dispute. Status transitions are written by trigger so no code path can skip them.
create table public.dispute_events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  dispute_id uuid not null references public.disputes (id) on delete cascade,
  actor_id uuid references public.users (id) on delete set null,
  kind text not null,
  from_status text,
  to_status text,
  note text check (note is null or char_length(note) <= 2000),
  client_visible boolean not null default false,
  created_at timestamptz not null default clock_timestamp() -- not now(): several changes in one transaction must stay ordered
);
create index dispute_events_dispute_idx on public.dispute_events (dispute_id, created_at);
create index dispute_events_org_idx on public.dispute_events (org_id);

create function app.log_dispute_transition() returns trigger language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  if tg_op = 'INSERT' then
    insert into public.dispute_events (org_id, dispute_id, actor_id, kind, to_status, note)
    values (new.org_id, new.id, app.uid(), 'created', new.status, 'Dispute created');
  elsif new.status is distinct from old.status then
    insert into public.dispute_events (org_id, dispute_id, actor_id, kind, from_status, to_status, client_visible)
    values (new.org_id, new.id, app.uid(), 'status_changed', old.status, new.status,
            new.status in ('submitted', 'under_investigation', 'response_received', 'resolved'));
  end if;
  return new;
end $$;
create trigger disputes_log_insert after insert on public.disputes for each row execute function app.log_dispute_transition();
create trigger disputes_log_update after update on public.disputes for each row execute function app.log_dispute_transition();

create table public.dispute_evidence (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  dispute_id uuid not null references public.disputes (id) on delete cascade,
  document_id uuid references public.documents (id) on delete set null,
  label text not null check (char_length(label) <= 200),
  note text check (note is null or char_length(note) <= 1000),
  added_by uuid references public.users (id) on delete set null,
  created_at timestamptz not null default now()
);
create index dispute_evidence_dispute_idx on public.dispute_evidence (dispute_id);
create index dispute_evidence_org_idx on public.dispute_evidence (org_id);

-- ---------------------------------------------------------------- letters
create table public.letter_templates (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  base_key text, -- system template this was customised from
  name text not null check (char_length(name) <= 160),
  kind text not null,
  language text not null default 'en' check (language in ('en', 'es')),
  body text not null check (char_length(body) <= 20000),
  version int not null default 1,
  active boolean not null default true,
  created_by uuid references public.users (id) on delete set null,
  created_at timestamptz not null default now()
);
create index letter_templates_org_idx on public.letter_templates (org_id);

create table public.letters (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  client_id uuid not null references public.clients (id) on delete cascade,
  dispute_id uuid references public.disputes (id) on delete set null,
  template_key text,
  kind text not null,
  title text not null check (char_length(title) <= 200),
  recipient_name text not null,
  recipient_address text,
  language text not null default 'en' check (language in ('en', 'es')),
  status text not null default 'draft' check (status in ('draft', 'pending_approval', 'approved', 'sent', 'void')),
  current_version int not null default 1,
  created_by uuid references public.users (id) on delete set null,
  approved_by uuid references public.users (id) on delete set null,
  approved_at timestamptz,
  sent_at timestamptz,
  sent_method text check (sent_method in ('certified_mail', 'first_class_mail', 'portal', 'manual')),
  tracking_number text,
  created_at timestamptz not null default now()
);
create index letters_client_idx on public.letters (client_id, created_at desc);
create index letters_dispute_idx on public.letters (dispute_id);
create index letters_org_idx on public.letters (org_id, status);

create table public.letter_versions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  letter_id uuid not null references public.letters (id) on delete cascade,
  version int not null,
  body text not null check (char_length(body) <= 30000),
  source text not null default 'template' check (source in ('template', 'manual_edit', 'ai_draft')),
  author_id uuid references public.users (id) on delete set null,
  change_note text check (change_note is null or char_length(change_note) <= 300),
  created_at timestamptz not null default now(),
  unique (letter_id, version)
);
create index letter_versions_org_idx on public.letter_versions (org_id);
