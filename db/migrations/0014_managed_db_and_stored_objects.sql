-- 0014 Managed databases (Supabase and similar) and database-backed document storage.
-- Safe to run as a superuser or as a non-superuser owner with CREATEROLE; nothing here needs superuser.

-- ---------------------------------------------------------------- 1. the owner must be able to SET ROLE disputeos_rls
-- withTenant() runs every tenant request as `set local role disputeos_rls`. A superuser may always do that. A
-- non-superuser may only if it holds the role with the SET option, and since PostgreSQL 16 creating a role (0001) no
-- longer gives the creator that: it gets the ADMIN option only. So the membership is granted here, explicitly.
-- If this role may not grant it (an administrator created disputeos_rls), the check below still passes when that
-- administrator has already granted it, and otherwise stops the migration with the statement to run.
do $$
begin
  begin
    execute format('grant disputeos_rls to %I', current_user);
  exception when insufficient_privilege then
    null;
  end;
  begin
    set local role disputeos_rls;
    set local role none;
  exception when insufficient_privilege then
    raise exception 'Role "%" cannot SET ROLE disputeos_rls. As a database administrator run:  grant disputeos_rls to "%";  then migrate again.', current_user, current_user;
  end;
end $$;

-- ---------------------------------------------------------------- 2. stored objects (STORAGE_DRIVER=db)
-- Uploaded documents for hosts with no persistent disk. `bytes` is what the disk driver would have written to a file:
-- already AES-256-GCM encrypted by the app (src/lib/crypto.ts), so the database and its backups never hold plaintext.
-- `key` is the same "<org>/<client>/<uuid>.bin" key the disk driver uses; documents.storage_key points at it.
create table public.stored_objects (
  key text primary key check (key ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9a-f-]{36}\.bin$'),
  org_id uuid not null references public.organizations (id) on delete cascade,
  bytes bytea not null,
  size integer not null check (size = octet_length(bytes)),
  created_at timestamptz not null default now()
);
create index stored_objects_org_idx on public.stored_objects (org_id);

-- No grants and no policies: like sessions and password_resets (0005), this table is invisible to tenant requests.
-- Only the system connection reads and writes it, from src/lib/storage.ts, whose callers have already checked (through
-- row-level security on public.documents) that the requester may see the document the key belongs to.
alter table public.stored_objects enable row level security;
revoke all on public.stored_objects from public;
revoke all on public.stored_objects from disputeos_rls;

-- ---------------------------------------------------------------- 3. Supabase Data API roles get nothing
-- Supabase projects have had default privileges that give its REST/GraphQL roles (anon, authenticated, service_role)
-- access to every table created in `public`. This app never uses that API. Row-level security already hides every row
-- from anon and authenticated (no policy names them), but service_role bypasses row-level security, so the grants
-- themselves are removed, for existing tables and for tables later migrations create. Skipped where the roles do not exist.
do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on all tables in schema public from %I', r);
      execute format('revoke all on all sequences in schema public from %I', r);
      execute format('alter default privileges in schema public revoke all on tables from %I', r);
      execute format('alter default privileges in schema public revoke all on sequences from %I', r);
      execute format('alter default privileges in schema public revoke all on functions from %I', r);
    end if;
  end loop;
end $$;
