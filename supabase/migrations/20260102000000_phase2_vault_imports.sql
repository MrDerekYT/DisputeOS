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
