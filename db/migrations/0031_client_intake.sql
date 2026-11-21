-- 0031 Client intake: what exactly was signed, details a client may give once, cancelling from the portal, keeping
-- the signed Consumer Credit File Rights statement for 2 years, and a client's own payment terms.
-- Additive and safe to run again: new columns are nullable with no default (existing rows are untouched), functions
-- are created or replaced, the triggers are dropped and created again, and the policy is altered in place. Nothing here
-- needs a superuser.

-- ---------------------------------------------------------------- 1. the exact text of each signature
-- Every signature from now on (in the portal and recorded by staff) stores the text that was shown, title and body as
-- one string, its full SHA-256 in hex, and the language of the page. `version` keeps its format
-- ("<document version>:<first 12 hex of the hash>"), so everything that reads it keeps working. Rows signed before
-- this migration have none of these and stay as they are.
-- `recorded_by` is the staff member who recorded a signature the client gave on paper; null when the client signed in
-- the portal. No foreign key: the record of who recorded it is kept even if that account is later removed. For such a
-- row `text_shown` is the app's text of the document on the day staff recorded it (dated with the date on the paper),
-- not a copy of the paper. In a personal workspace it is the account holder, who gives their own consent in the app.
-- `signed_on` is the day the client signed: for a paper signature, the date written on the signed paper (staff enter
-- it); for a portal signature, the agency's calendar day when the client signed.
-- `cancellation_ends_on` (service agreements only) is the last day of the cancellation period, counted from signed_on
-- and fixed when the agreement is signed: the day printed in its Notice of Cancellation. The app enforces the later of
-- this day and the day it counts again, so a later change of the agency's time zone can never shorten the period
-- (src/lib/compliance/disclosures.ts).
-- `revoked_reason` says why a revoked row was revoked: 'client_cancelled' (the client used "Cancel my agreement" in the
-- portal, app.cancel_own_contract() below) or 'staff' (a staff member revoked it). Rows revoked before have none.
alter table public.client_consents add column if not exists text_shown text;
alter table public.client_consents add column if not exists text_sha256 text;
alter table public.client_consents add column if not exists page_lang text;
alter table public.client_consents add column if not exists recorded_by uuid;
alter table public.client_consents add column if not exists signed_on date;
alter table public.client_consents add column if not exists cancellation_ends_on date;
alter table public.client_consents add column if not exists revoked_reason text;

do $$
begin
  -- The database checks that the stored hash is the hash of the stored text, so the two can never disagree.
  if not exists (select 1 from pg_constraint where conname = 'client_consents_text_hash') then
    alter table public.client_consents add constraint client_consents_text_hash check (
      (text_shown is null and text_sha256 is null)
      or (text_shown is not null and text_sha256 = encode(sha256(convert_to(text_shown, 'UTF8')), 'hex')));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'client_consents_page_lang') then
    alter table public.client_consents add constraint client_consents_page_lang check (page_lang is null or page_lang in ('en', 'es'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'client_consents_revoked_reason') then
    alter table public.client_consents add constraint client_consents_revoked_reason check (
      revoked_reason is null or (revoked_at is not null and revoked_reason in ('client_cancelled', 'staff')));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'client_consents_cancellation_ends_on') then
    alter table public.client_consents add constraint client_consents_cancellation_ends_on check (cancellation_ends_on is null or kind = 'croa_contract');
  end if;
  -- 15 U.S.C. § 7001(c)(1)(C)(ii): the consent to electronic records is the client's own, given electronically. Staff
  -- never record it from paper (a client who signs on paper needs none).
  if not exists (select 1 from pg_constraint where conname = 'client_consents_esign_by_client') then
    alter table public.client_consents add constraint client_consents_esign_by_client check (kind <> 'esign' or recorded_by is null);
  end if;
end $$;

-- A portal client may add their own signatures (0005_rls.sql), but never one marked as recorded by staff, nor one
-- that is already revoked.
alter policy consents_self_insert on public.client_consents
  with check (client_id in (select app.client_ids()) and org_id = app.client_org(client_id) and recorded_by is null and revoked_at is null);

-- ---------------------------------------------------------------- 2. date of birth and SSN: written once by the client
-- Same function as 0029_portal_guard_bankruptcy.sql, its newest definition. The only change: a portal user may set
-- dob_encrypted, ssn_last4 and ssn_encrypted while they are empty (the welcome steps ask for them), and never change
-- one once it is on file. Everything else the guard protects stays protected, with the same message. Staff are not
-- affected: the check is for non-staff only.
create or replace function app.clients_portal_guard() returns trigger language plpgsql as $$
begin
  if current_user = 'disputeos_rls' and not app.is_staff(old.org_id) then
    if (new.org_id, new.assigned_to, new.portal_user_id, new.full_name, new.email, new.status, new.stage,
        new.source, new.tags, new.goals, new.id,
        new.banking_concern, new.specialty_reports,
        new.bankruptcy_chapter, new.bankruptcy_filed_on, new.bankruptcy_discharged_on)
       is distinct from
       (old.org_id, old.assigned_to, old.portal_user_id, old.full_name, old.email, old.status, old.stage,
        old.source, old.tags, old.goals, old.id,
        old.banking_concern, old.specialty_reports,
        old.bankruptcy_chapter, old.bankruptcy_filed_on, old.bankruptcy_discharged_on)
       or (old.ssn_last4 is not null and new.ssn_last4 is distinct from old.ssn_last4)
       or (old.ssn_encrypted is not null and new.ssn_encrypted is distinct from old.ssn_encrypted)
       or (old.dob_encrypted is not null and new.dob_encrypted is distinct from old.dob_encrypted) then
      raise exception 'portal users may only update phone, address and preferred language';
    end if;
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------- 3. the client cancels their own contract
-- Clients have no UPDATE policy on client_consents. This function revokes the service agreement of the signed-in
-- portal user's own client record, and nothing else: it takes no argument, so it cannot be pointed at anyone else.
-- The application checks the exact last day of the cancellation period (business days, federal holidays, the agency's
-- zone) before calling it and posts the client's written notice in the same transaction; the 10 days here are only an
-- outer limit (3 business days never span more than 7 calendar days), so a contract signed long ago is never touched.
-- For each agreement it revokes it also:
--  - records why (revoked_reason 'client_cancelled'), so the portal and the staff pages can say the client cancelled;
--  - sets the client's status to 'cancelled' (the charge check then holds, and report imports stop: credit/pull.ts);
--  - adds a line to the client's timeline;
--  - notifies the agency's owners and admins and the assigned specialist (the message trigger, 0018, only tells the
--    specialist, and only when one is assigned).
-- Returns the number of agreements revoked (0 or 1).
create or replace function app.cancel_own_contract() returns integer
language plpgsql security definer set search_path = pg_catalog, public as $$
declare n integer := 0; r record; who text;
begin
  if app.uid() is null then return 0; end if;
  for r in
    update public.client_consents k set revoked_at = now(), revoked_reason = 'client_cancelled'
     where k.kind = 'croa_contract' and k.revoked_at is null and k.signed_at > now() - interval '10 days'
       and k.client_id in (select c.id from public.clients c where c.portal_user_id = app.uid())
    returning k.org_id, k.client_id
  loop
    n := n + 1;
    update public.clients set status = 'cancelled' where id = r.client_id returning full_name into who;
    insert into public.client_events (org_id, client_id, actor_id, kind, summary)
      values (r.org_id, r.client_id, app.uid(), 'consent_revoked', 'Client cancelled the service agreement in the client portal. Status set to Cancelled.');
    insert into public.notifications (org_id, user_id, title, body, href)
      select r.org_id, t.user_id, 'A client cancelled their service agreement',
             left(coalesce(who, 'A client') || ' used “Cancel my agreement” in the client portal within the cancellation period. The agreement is revoked and the client is marked Cancelled. Their written notice is in Messages.', 1000),
             '/app/clients/' || r.client_id
        from (select m.user_id from public.memberships m where m.org_id = r.org_id and m.role in ('owner', 'admin')
              union
              select c.assigned_to from public.clients c where c.id = r.client_id and c.assigned_to is not null) t;
  end loop;
  return n;
end $$;
revoke all on function app.cancel_own_contract() from public;
grant execute on function app.cancel_own_contract() to disputeos_rls;

-- A client who cancelled may later sign a new service agreement, in the portal or on paper recorded by staff. The
-- signing code (src/lib/agreements.ts, signAgreement) calls this right after storing it, in the same transaction, when
-- the agreement before it was the one the client cancelled. It undoes what the cancellation did to the client's file:
--  - the client's status goes from Cancelled back to Active (left alone if staff have set another status since);
--  - a line is added to the client's timeline;
--  - the agency's owners and admins and the assigned specialist are told, as they were of the cancellation (not the
--    staff member who recorded it).
-- A portal client can do neither themselves (the portal guard keeps the status, and only staff add notifications). It
-- acts only for a caller who can see the client (staff of its agency, or the client themselves), only while a service
-- agreement is in force, and only when the latest one revoked before it was cancelled by the client; otherwise it does
-- nothing. Returns 1 when it acted, else 0.
create or replace function app.client_signed_again(target_client uuid) returns integer
language plpgsql security definer set search_path = pg_catalog, public as $$
declare c record; latest_revoked text; reopened boolean := false;
begin
  if app.uid() is null then return 0; end if;
  select cl.id, cl.org_id, cl.full_name, cl.status, cl.assigned_to into c from public.clients cl
   where cl.id = target_client and (cl.portal_user_id = app.uid() or app.is_staff(cl.org_id));
  if not found then return 0; end if;
  if not exists (select 1 from public.client_consents k where k.client_id = c.id and k.kind = 'croa_contract' and k.revoked_at is null) then return 0; end if;
  select k.revoked_reason into latest_revoked from public.client_consents k
   where k.client_id = c.id and k.kind = 'croa_contract' and k.revoked_at is not null order by k.signed_at desc limit 1;
  if latest_revoked is distinct from 'client_cancelled' then return 0; end if;
  if c.status = 'cancelled' then
    update public.clients set status = 'active' where id = c.id;
    reopened := true;
  end if;
  insert into public.client_events (org_id, client_id, actor_id, kind, summary)
    values (c.org_id, c.id, app.uid(), 'status_changed', 'New service agreement signed after the client cancelled the last one in the client portal. '
      || case when reopened then 'Status set from Cancelled to Active.' else 'Status left as it was.' end);
  insert into public.notifications (org_id, user_id, title, body, href)
    select c.org_id, t.user_id, 'A client signed a new service agreement',
           left(coalesce(c.full_name, 'A client') || ' signed a new service agreement after cancelling the last one in the client portal. '
             || case when reopened then 'Their status is Active again. ' else '' end
             || 'No service may be provided before its cancellation period ends.', 1000),
           '/app/clients/' || c.id
      from (select m.user_id from public.memberships m where m.org_id = c.org_id and m.role in ('owner', 'admin')
            union
            select c.assigned_to where c.assigned_to is not null) t
     where t.user_id is distinct from app.uid();
  return 1;
end $$;
revoke all on function app.client_signed_again(uuid) from public;
grant execute on function app.client_signed_again(uuid) to disputeos_rls;

-- ---------------------------------------------------------------- 4. keep the signed statement for 2 years
-- 15 U.S.C. § 1679c(c)(2): the statement signed by the consumer is kept "for 2 years after the date on which the
-- statement is signed". Deleting a client would delete it with them, so staff (the tenant role) cannot delete a client
-- whose statement was signed less than 2 years ago; the app says the date it can be deleted and points to marking the
-- client cancelled instead (src/lib/agreements.ts, deletionBlock). Only requests made as the tenant role are checked:
-- the platform's own maintenance (removing a whole test workspace) is not. A personal workspace (someone working on
-- their own credit) is no credit repair organization and has no such duty, so it is not checked either.
create or replace function app.clients_keep_signed_statement() returns trigger language plpgsql as $$
declare signed timestamptz;
begin
  if current_user = 'disputeos_rls' and coalesce((select o.mode from public.organizations o where o.id = old.org_id), 'agency') <> 'personal' then
    select max(k.signed_at) into signed from public.client_consents k where k.client_id = old.id and k.kind = 'croa_disclosure';
    if signed is not null and signed > now() - interval '2 years' then
      raise exception 'This client signed the Consumer Credit File Rights statement on %. It must be kept for 2 years (15 U.S.C. 1679c(c)), so the client cannot be deleted before %. Set the client''s status to Cancelled instead.',
        to_char(signed, 'YYYY-MM-DD'), to_char(signed + interval '2 years', 'YYYY-MM-DD');
    end if;
  end if;
  return old;
end $$;
drop trigger if exists clients_keep_signed_statement on public.clients;
create trigger clients_keep_signed_statement before delete on public.clients for each row execute function app.clients_keep_signed_statement();
revoke all on function app.clients_keep_signed_statement() from public;
grant execute on function app.clients_keep_signed_statement() to disputeos_rls;

-- ---------------------------------------------------------------- 5. this client's own payment terms
-- 15 U.S.C. § 1679d(b)(1): the contract states the terms of payment, "including the total amount of all payments to be
-- made by the consumer". An agency with more than one plan sets, on the client page and before the client signs, this
-- client's own payment terms and total; the service agreement is then built with them instead of the agency's
-- (Settings → Client agreement). Both null: the agency's terms apply. Both are set together, or neither.
-- The application checks the text as it checks the agency's terms (no promise of a result, no payment asked for before
-- the work is done). Here: only staff may set them, and never while a service agreement is in force for the client,
-- so the figures on the client record are the ones the agreement in force was signed with (to change them, staff
-- revoke that agreement and the client signs a new one). The signing code locks the client row while it builds the
-- agreement, so a change and a signature cannot cross.
alter table public.clients add column if not exists agreement_payment_terms text;
alter table public.clients add column if not exists agreement_total_cents integer;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'clients_agreement_terms') then
    alter table public.clients add constraint clients_agreement_terms check (
      (agreement_payment_terms is null and agreement_total_cents is null)
      or (agreement_payment_terms is not null and char_length(agreement_payment_terms) between 10 and 2000
          and agreement_total_cents between 0 and 100000000));
  end if;
end $$;

create or replace function app.clients_agreement_terms_guard() returns trigger language plpgsql as $$
begin
  if (new.agreement_payment_terms, new.agreement_total_cents) is distinct from (old.agreement_payment_terms, old.agreement_total_cents) then
    if current_user = 'disputeos_rls' and not app.is_staff(old.org_id) then
      raise exception 'portal users may not change the payment terms of their service agreement';
    end if;
    if exists (select 1 from public.client_consents k where k.client_id = old.id and k.kind = 'croa_contract' and k.revoked_at is null) then
      raise exception 'This client has a service agreement in force: its payment terms and total cannot be changed. Revoke it first, then the client signs a new one.';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists clients_agreement_terms_guard on public.clients;
create trigger clients_agreement_terms_guard before update on public.clients for each row execute function app.clients_agreement_terms_guard();
revoke all on function app.clients_agreement_terms_guard() from public;
grant execute on function app.clients_agreement_terms_guard() to disputeos_rls;
