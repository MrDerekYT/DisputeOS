-- Phase 2: document vault, report imports, parsed tradelines. RLS on every table.
create table public.documents (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  kind text not null check (kind in ('id', 'proof_of_address', 'ftc_report', 'police_report', 'credit_report', 'bureau_response', 'other')),
  storage_path text not null,
  sha256 text,
  scan_status text not null default 'pending' check (scan_status in ('pending', 'clean', 'infected')),
  uploaded_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);
create index documents_org_idx on public.documents (organization_id);
create index documents_client_idx on public.documents (client_id, kind);

create table public.report_imports (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  document_id uuid references public.documents(id) on delete set null,
  bureau text check (bureau in ('equifax', 'experian', 'transunion')),
  source text not null default 'upload',
  status text not null default 'parsing' check (status in ('parsing', 'needs_review', 'approved', 'failed')),
  warnings jsonb not null default '[]',
  created_at timestamptz not null default now()
);
create index report_imports_org_idx on public.report_imports (organization_id, created_at desc);
create index report_imports_client_idx on public.report_imports (client_id);
create index report_imports_document_idx on public.report_imports (document_id);

create table public.tradelines (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  import_id uuid not null references public.report_imports(id) on delete cascade,
  bureau text not null check (bureau in ('equifax', 'experian', 'transunion')),
  match_key text not null, -- creditor + last4; identity across imports
  creditor text not null,
  account_last4 char(4),
  account_encrypted text,
  account_type text,
  account_status text,
  payment_status text,
  date_opened date,
  dofd date,
  balance numeric(12, 2),
  high_credit numeric(12, 2),
  credit_limit numeric(12, 2),
  original_creditor text,
  payment_history text,
  field_confidence jsonb not null default '{}',
  field_sources jsonb not null default '{}',
  reviewed_at timestamptz,
  removed_in_import uuid references public.report_imports(id) on delete set null,
  created_at timestamptz not null default now()
);
create index tradelines_org_idx on public.tradelines (organization_id);
create index tradelines_client_idx on public.tradelines (client_id, bureau);
create index tradelines_import_idx on public.tradelines (import_id);
create index tradelines_match_idx on public.tradelines (client_id, bureau, match_key);
create index tradelines_removed_idx on public.tradelines (removed_in_import);

create table public.inquiries (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  import_id uuid not null references public.report_imports(id) on delete cascade,
  bureau text not null check (bureau in ('equifax', 'experian', 'transunion')),
  name text not null,
  inquiry_date date,
  created_at timestamptz not null default now()
);
create index inquiries_org_idx on public.inquiries (organization_id);
create index inquiries_client_idx on public.inquiries (client_id);
create index inquiries_import_idx on public.inquiries (import_id);

alter table public.documents enable row level security;
alter table public.report_imports enable row level security;
alter table public.tradelines enable row level security;
alter table public.inquiries enable row level security;

do $$
declare t text;
begin
  foreach t in array array['documents', 'report_imports', 'tradelines', 'inquiries'] loop
    execute format($f$create policy %1$s_staff on public.%1$s for all
      using (public.has_role(organization_id, array['owner','admin','staff']::public.member_role[]) and public.staff_aal2(organization_id))
      with check (public.has_role(organization_id, array['owner','admin','staff']::public.member_role[]) and public.staff_aal2(organization_id))$f$, t);
    execute format($f$create policy %1$s_self on public.%1$s for select
      using (exists (select 1 from public.clients c where c.id = client_id and c.user_id = auth.uid()))$f$, t);
  end loop;
end $$;

-- Private bucket for the document vault; access only through signed, short-lived URLs.
insert into storage.buckets (id, name, public) values ('vault', 'vault', false) on conflict (id) do nothing;
