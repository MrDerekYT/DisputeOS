-- 0019 The full reinvestigation clock (15 U.S.C. 1681i), the optional steps after a result, and the "frivolous or
-- irrelevant" notice. Additive and safe to run again. Existing rows are untouched: every new column is nullable or has
-- a constant default (a metadata-only change on PostgreSQL 11+), the outcome list only grows, and no row-level-security
-- policy changes (the new columns live on tables that already have their policies). Nothing here needs a superuser.

-- Adds values to a "<column> in (...)" check without assuming what the list holds today (same helper as 0017; it lives
-- in pg_temp, so each migration that needs it defines it).
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
-- A notice that the agency will not investigate because the dispute was frivolous or irrelevant (1681i(a)(3)).
select pg_temp.widen_check('disputes', 'outcome', array['frivolous']);

-- The day the consumer sent additional relevant information during the 30-day period. Recording it extends the period
-- to 45 days (1681i(a)(1)(B)). Null when the 45-day window was ticked by hand at submission, or never extended.
alter table public.disputes add column if not exists more_info_on date;
-- The day the agency completed its reinvestigation, as its results state. Written results are due within 5 business days of it (1681i(a)(6)(A)).
alter table public.disputes add column if not exists investigation_completed_on date;
-- What the agency's frivolous notice said was missing, as typed by staff from the notice.
alter table public.disputes add column if not exists frivolous_missing text;
-- Staff tick this when the client has confirmed the item is reported accurately. No further step is offered for it.
alter table public.disputes add column if not exists client_confirmed_accurate boolean not null default false;

alter table public.disputes drop constraint if exists disputes_frivolous_missing_check;
alter table public.disputes add constraint disputes_frivolous_missing_check check (frivolous_missing is null or char_length(frivolous_missing) <= 1000);

-- ---------------------------------------------------------------- letters
-- Used by a request for the description of the reinvestigation procedure (letters.kind = 'method_of_verification'):
-- the day the agency received the request (when known), the day its description is due (15 days after receipt,
-- 1681i(a)(7); counted from the sent date until a receipt date is recorded) and the day the description arrived.
alter table public.letters add column if not exists received_on date;
alter table public.letters add column if not exists reply_due_on date;
alter table public.letters add column if not exists reply_received_on date;

-- Which approval checks a letter is held to. Stamped 1 on every letter created from now on; existing letters keep null
-- and are held only to the checks they were drafted under (the specificity check added with this release would refuse
-- every existing bureau draft that has no enclosures line). Nullable with no default: no existing row is rewritten.
alter table public.letters add column if not exists checks_version smallint;
