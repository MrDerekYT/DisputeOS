-- 0017 Disputes with specialty consumer reporting agencies (ChexSystems, Early Warning, LexisNexis, ...).
-- Additive and safe to run again. Existing rows are untouched: every new column is nullable or has a constant default,
-- the value lists only grow, and no row-level-security policy changes (the new columns live on tables that already have
-- their policies; the portal guard trigger at the end gains the two new client columns). The three-bureau column
-- `disputes.bureau` and its check stay exactly as they were: a specialty agency is recorded in its own column, so nothing
-- that reads `bureau` ever meets a value it does not know.

-- Adds values to a "<column> in (...)" check without assuming what the list holds today: it reads the current list and
-- re-creates the constraint with the union, so it stays correct whatever an earlier migration added.
create or replace function pg_temp.widen_check(tbl text, col text, extra text[]) returns void language plpgsql as $$
declare
  con text := tbl || '_' || col || '_check';
  def text;
  vals text[];
begin
  select pg_get_constraintdef(c.oid) into def from pg_constraint c where c.conrelid = ('public.' || tbl)::regclass and c.conname = con;
  if def is null then raise exception 'constraint % not found on public.%', con, tbl; end if;
  select array_agg(m[1]) into vals from regexp_matches(def, '''([a-z_0-9]+)''', 'g') m;
  if vals @> extra then return; end if;
  select array_agg(v order by ord) into vals from (
    select v, min(ord) as ord from unnest(vals || extra) with ordinality as u(v, ord) group by v) s;
  execute format('alter table public.%I drop constraint %I', tbl, con);
  execute format('alter table public.%I add constraint %I check (%I in (%s))', tbl, con, col,
    (select string_agg(quote_literal(v), ', ') from unnest(vals) v));
end $$;

-- ---------------------------------------------------------------- disputes
select pg_temp.widen_check('disputes', 'target_type', array['agency']);
select pg_temp.widen_check('disputes', 'workflow', array['specialty']);

-- Which specialty agency the dispute goes to (keys from src/lib/credit/agencies.ts). Null for every bureau, furnisher and collector dispute.
alter table public.disputes add column if not exists agency text;
-- The item exactly as a person copied it from the consumer's disclosure: {name, reference, date, amount}. These reports are never parsed.
alter table public.disputes add column if not exists agency_item jsonb;
-- Mailing address typed by staff from the agency's current instructions, used only when the registry holds no verified address.
alter table public.disputes add column if not exists recipient_address text;

alter table public.disputes drop constraint if exists disputes_agency_check;
alter table public.disputes add constraint disputes_agency_check check (agency is null or agency in (
  'chexsystems', 'early_warning', 'lexisnexis', 'innovis', 'nctue', 'telecheck', 'clarity'));
alter table public.disputes drop constraint if exists disputes_agency_target_check;
alter table public.disputes add constraint disputes_agency_target_check check ((target_type = 'agency') = (agency is not null));
alter table public.disputes drop constraint if exists disputes_recipient_address_check;
alter table public.disputes add constraint disputes_recipient_address_check check (recipient_address is null or char_length(recipient_address) <= 400);

-- ---------------------------------------------------------------- clients
-- Staff tick this when the client has a banking or background-screening concern; only then does the plan suggest specialty reports.
alter table public.clients add column if not exists banking_concern boolean not null default false;
-- Per agency: {"chexsystems": {"status": "requested" | "received", "on": "YYYY-MM-DD", "document_id": uuid | null}}. No key = not requested.
alter table public.clients add column if not exists specialty_reports jsonb not null default '{}'::jsonb;

-- ---------------------------------------------------------------- documents
-- A specialty agency's disclosure, stored as a file. It is kept, never read by the system.
select pg_temp.widen_check('documents', 'kind', array['specialty_report']);
select pg_temp.widen_check('document_requests', 'kind', array['specialty_report']);

-- The two new client columns are staff-only. Portal clients may update their own clients row (clients_self_update), and
-- this trigger is what limits them to contact fields, so both columns join its list. Same function as 0002_crm.sql with
-- the two columns added; the trigger itself is unchanged.
create or replace function app.clients_portal_guard() returns trigger language plpgsql as $$
begin
  if current_user = 'disputeos_rls' and not app.is_staff(old.org_id) then
    if (new.org_id, new.assigned_to, new.portal_user_id, new.full_name, new.email, new.status, new.stage,
        new.source, new.ssn_last4, new.ssn_encrypted, new.dob_encrypted, new.tags, new.goals, new.id,
        new.banking_concern, new.specialty_reports)
       is distinct from
       (old.org_id, old.assigned_to, old.portal_user_id, old.full_name, old.email, old.status, old.stage,
        old.source, old.ssn_last4, old.ssn_encrypted, old.dob_encrypted, old.tags, old.goals, old.id,
        old.banking_concern, old.specialty_reports) then
      raise exception 'portal users may only update phone, address and preferred language';
    end if;
  end if;
  return new;
end $$;
