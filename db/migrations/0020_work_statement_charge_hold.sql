-- 0020 Work statement, charge-eligibility hold and chargeback evidence pack.
-- Additive and safe to run again. Existing rows are untouched: the one new column is nullable with no default (a
-- metadata-only change). No table is created, no row-level-security policy changes and nothing here
-- needs a superuser. The statement itself is never stored: it is built on request from letters, disputes, documents
-- and messages, under the row-level security those tables already have.

-- ---------------------------------------------------------------- clients: how the service was sold
-- Staff answer whether the service was sold to the client by telephone. Null = nobody has answered yet, which the
-- charge check says in so many words instead of assuming "no". True only adds a caution where a payment is recorded
-- (Telemarketing Sales Rule, 16 CFR 310.4(a)(2)); the software makes no legal determination from it.
alter table public.clients add column if not exists sold_by_phone boolean;
-- A database that ran an earlier draft of this file has the column as "not null default false": make it the same.
alter table public.clients alter column sold_by_phone drop not null;
alter table public.clients alter column sold_by_phone drop default;

-- A portal client may update contact fields on their own record (0002). This column is staff-only.
create or replace function app.clients_sold_by_phone_guard() returns trigger language plpgsql as $$
begin
  if current_user = 'disputeos_rls' and not app.is_staff(old.org_id) and new.sold_by_phone is distinct from old.sold_by_phone then
    raise exception 'portal users may not change how the service was sold';
  end if;
  return new;
end $$;
drop trigger if exists clients_sold_by_phone_guard on public.clients;
create trigger clients_sold_by_phone_guard before update on public.clients for each row execute function app.clients_sold_by_phone_guard();

-- ---------------------------------------------------------------- two narrow reads for the statement and the evidence pack
-- When staff reviewed the client's documents (timeline rows written by the review action since 0002). The timeline is
-- staff-only, so the client's own "What we did for you" page reads just these timestamps: no text, no staff names.
create or replace function app.client_document_reviews(target_client uuid) returns setof timestamptz
language sql stable security definer set search_path = pg_catalog, public as $$
  select e.created_at from public.client_events e
   where e.client_id = target_client and e.kind = 'document_reviewed'
     and (app.is_staff(e.org_id) or target_client in (select app.client_ids()))
$$;

-- When the client signed in to the portal, from the append-only audit log (action 'auth.login'). The audit log is
-- readable by admins only; the evidence pack is also open to managers (billing), so they get these timestamps and
-- nothing else from it. Anyone else gets no rows.
create or replace function app.client_portal_signins(target_client uuid) returns setof timestamptz
language sql stable security definer set search_path = pg_catalog, public as $$
  select a.created_at from public.audit_logs a join public.clients c on c.id = target_client
   where a.action = 'auth.login' and a.actor_id = c.portal_user_id and a.org_id = c.org_id
     and app.is_member(c.org_id, array['owner', 'admin', 'manager'])
   order by a.created_at desc limit 500
$$;

revoke all on function app.clients_sold_by_phone_guard() from public;
revoke all on function app.client_document_reviews(uuid) from public;
revoke all on function app.client_portal_signins(uuid) from public;
grant execute on function app.clients_sold_by_phone_guard() to disputeos_rls;
grant execute on function app.client_document_reviews(uuid) to disputeos_rls;
grant execute on function app.client_portal_signins(uuid) to disputeos_rls;
