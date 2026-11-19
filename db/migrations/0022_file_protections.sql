-- 0022 "Protect your file": the client's own checklist of security freezes, fraud alerts, opt-outs and similar steps.
-- Additive and safe to run again. Existing rows are untouched: the one new column has a constant default (a
-- metadata-only change on PostgreSQL 11+). No table is created, no row-level-security policy changes and nothing here
-- needs a superuser.
--
-- These are steps the consumer takes personally, with each agency, on that agency's own website, phone line or form.
-- The software never submits one and collects no credentials for one. A security freeze in particular is placed on a
-- request "directly from the consumer" (15 U.S.C. 1681c-1(i)(2)), so the only thing stored is the client's own note:
-- "I placed this on <date>".

-- {"<option key>": "YYYY-MM-DD", ...}. Option keys come from src/lib/credit/protections.ts. No key = not ticked.
alter table public.clients add column if not exists file_protections jsonb not null default '{}'::jsonb;

-- Who may write it, and what may be written.
--  * Only the client may tick their own list. The existing policy clients_self_update (0005) already limits a portal
--    user to their own clients row; this trigger adds that staff, who may update client rows in their organization,
--    cannot tick or untick on a client's behalf. Staff read the column on the client record.
--  * Whatever is written must be a flat object of option key -> day. Anything else is refused, whoever writes it.
create or replace function app.clients_file_protections_guard() returns trigger language plpgsql as $$
begin
  if new.file_protections is distinct from old.file_protections then
    if current_user = 'disputeos_rls' and old.portal_user_id is distinct from app.uid() then
      raise exception 'only the client can update their own file protection checklist';
    end if;
    if jsonb_typeof(new.file_protections) <> 'object' or pg_column_size(new.file_protections) > 4000 or exists (
         select 1 from jsonb_each(new.file_protections) e
          where e.key !~ '^[a-z0-9_]{3,60}$' or jsonb_typeof(e.value) <> 'string' or (e.value #>> '{}') !~ '^\d{4}-\d{2}-\d{2}$') then
      raise exception 'file protection checklist must map an option to a day (YYYY-MM-DD)';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists clients_file_protections_guard on public.clients;
create trigger clients_file_protections_guard before update on public.clients for each row execute function app.clients_file_protections_guard();
