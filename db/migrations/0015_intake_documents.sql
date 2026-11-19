-- 0015 Intake documents: what a reviewer decided about an identity document, and three more document kinds.
-- Additive and safe to run again: new columns are nullable with no default, the kind lists only grow, and the one
-- policy it replaces keeps every check it had.

-- Why a document was rejected (shown to the client so they know what to send instead).
alter table public.documents add column if not exists review_note text check (review_note is null or char_length(review_note) <= 300);
-- Dates read from the document by the reviewer, when known: the date printed on a proof of address, and the expiry of an ID.
alter table public.documents add column if not exists doc_date date;
alter table public.documents add column if not exists expires_on date;

-- "Only if this applies" intake items that had no kind of their own. The lists are widened, never rewritten: the helper
-- reads the current "<column> in (...)" check and re-creates it with the union, so running this again (or after a later
-- migration added more kinds) changes nothing and can never reject an existing row.
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

select pg_temp.widen_check('documents', 'kind', array['previous_address', 'name_change', 'power_of_attorney']);
select pg_temp.widen_check('document_requests', 'kind', array['previous_address', 'name_change', 'power_of_attorney']);

-- A client's own upload always starts unreviewed. review_status = 'accepted' is what tells staff an identity document
-- is ready to enclose, so the database, not only the upload code, keeps a portal user from setting it (or the
-- reviewer's note and dates) on their own file. Same checks as before (0005_rls.sql) plus the four review columns.
drop policy if exists documents_self_insert on public.documents;
create policy documents_self_insert on public.documents for insert to disputeos_rls
  with check (client_id in (select app.client_ids()) and org_id = app.client_org(client_id)
              and source = 'client' and uploaded_by = app.uid()
              and review_status = 'pending_review' and review_note is null and doc_date is null and expires_on is null);
