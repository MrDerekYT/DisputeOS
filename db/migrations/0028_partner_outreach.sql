-- 0028 Referral partners (businesses that can refer clients) with an automatic EMAIL sequence, and consented TEXT
-- follow-up for people who sent the enquiry form.
-- Additive and safe to run again: four new tables that start empty, with their own triggers, helper functions and
-- policies; three value lists that only grow (sms_consents.source, sms_consents.revoked_via, lead_outreach.step); two
-- nullable columns on organizations that only the system connection can write (the operator's approval of a workspace
-- for outreach); and three existing functions from 0018 replaced with the same behaviour plus the new values. No
-- existing row is changed, and nothing here needs a superuser.
--
-- What this schema does NOT hold, on purpose: a text or call queue for partners. A partner's phone number is stored
-- for the agency's own reference only; no table here can carry a text message or a call to a partner.

-- Adds values to a "<column> in (...)" check without assuming what the list holds today (same helper as 0017): it
-- reads the current list and re-creates the constraint with the union, so it stays correct whatever came before.
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

-- ---------------------------------------------------------------- 1. partners
-- One row per business contact the agency added itself, one at a time or from a list it attests it compiled from
-- public business contact details and its own contacts. Nothing is scraped, bought or imported from a directory.
--   status   new             added, no email sent yet
--            in_sequence     at least one email of the sequence was sent and more may follow
--            finished        every email of the sequence was sent and no reply was recorded
--            replied         staff recorded that the partner answered (replies go to the agency's own mailbox)
--            interested      staff recorded that the partner wants to refer clients
--            not_interested  staff recorded that the partner declined
--            bounced         staff recorded that an email to this address came back undelivered
--            opted_out       the partner used the opt-out link, or asked to stop and staff recorded it. Permanent.
-- `paused_at` is a manual pause: the sequence waits while it is set. `phone` is never texted or called by this system.
create table if not exists public.partners (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  business_name text not null check (char_length(btrim(business_name)) between 1 and 160),
  contact_name text check (contact_name is null or char_length(contact_name) <= 120),
  category text not null check (category in ('real_estate_agent', 'loan_officer', 'mortgage_broker', 'car_dealership', 'tax_preparer', 'property_manager', 'other')),
  email text not null check (email = lower(email) and char_length(email) between 6 and 254 and email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  phone text check (phone is null or char_length(phone) <= 30),
  city text check (city is null or char_length(city) <= 80),
  state text check (state is null or state ~ '^[A-Z]{2}$'),
  language text not null default 'en' check (language in ('en', 'es')),
  source_note text check (source_note is null or char_length(source_note) <= 300),
  status text not null default 'new' check (status in ('new', 'in_sequence', 'finished', 'replied', 'interested', 'not_interested', 'bounced', 'opted_out')),
  paused_at timestamptz,
  opted_out_at timestamptz,
  -- Who confirmed, when adding it, that the contact came from public business details or the agency's own contacts.
  attested_by uuid references public.users (id) on delete set null,
  attested_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- The email stop is `opted_out_at`, not the status: once it is set no email is ever sent to the address again. The
  -- status may later say that the partner replied or is interested (they can still write or call), so 'opted_out'
  -- needs the stamp but the stamp does not need the status.
  constraint partners_opt_out_check check (status <> 'opted_out' or opted_out_at is not null)
);
-- Safe to run again on a database that already has the table with the earlier, stricter check.
alter table public.partners drop constraint if exists partners_opt_out_check;
alter table public.partners add constraint partners_opt_out_check check (status <> 'opted_out' or opted_out_at is not null);
-- (The unique key that allows one row per mailbox per agency is created below, once app.email_norm exists.)
create index if not exists partners_org_status_idx on public.partners (org_id, status, created_at);

-- An opt-out is honoured permanently for the address, for every connection (the system one included): the stamp cannot
-- be lifted, the partner can never go back into the sequence, and the address it belongs to cannot be changed. What
-- staff may still record on an opted-out partner is that they replied, are interested or are not interested: none of
-- those sends anything. Tenant requests also cannot rewrite who attested the row.
create or replace function app.partners_guard() returns trigger language plpgsql as $$
begin
  if old.opted_out_at is not null and (new.opted_out_at is distinct from old.opted_out_at
       or new.status not in ('opted_out', 'replied', 'interested', 'not_interested')) then
    raise exception 'this partner opted out of email: an opt-out cannot be undone';
  end if;
  if new.email <> old.email or new.org_id <> old.org_id then
    raise exception 'the email address of a partner cannot be changed: add a new partner instead';
  end if;
  if current_user = 'disputeos_rls'
     and (new.id, new.attested_by, new.attested_at, new.created_at) is distinct from (old.id, old.attested_by, old.attested_at, old.created_at) then
    raise exception 'the record of who added a partner cannot be edited';
  end if;
  -- Where a partner stands in the sequence is written by the scheduled job. A signed-in person records an answer
  -- (replied, interested, not interested, bounced, asked to stop); none of them can put an address that bounced, or
  -- one whose sequence is over, back in line for another email.
  if current_user = 'disputeos_rls' and new.status is distinct from old.status and new.status in ('new', 'in_sequence', 'finished') then
    raise exception 'where a partner stands in the email sequence is set by the scheduled job only';
  end if;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists partners_guard on public.partners;
create trigger partners_guard before update on public.partners for each row execute function app.partners_guard();

-- An address as the opt-out list reads it: lower case, without a "+tag", and for Gmail without the dots it ignores.
-- dana+1@example.com is dana@example.com for this purpose, so an opt-out cannot be stepped around with a tag.
create or replace function app.email_norm(addr text) returns text language sql immutable as $$
  select case when split_part(lower(btrim(addr)), '@', 2) in ('gmail.com', 'googlemail.com')
              then replace(split_part(split_part(lower(btrim(addr)), '@', 1), '+', 1), '.', '') || '@gmail.com'
              else split_part(split_part(lower(btrim(addr)), '@', 1), '+', 1) || '@' || split_part(lower(btrim(addr)), '@', 2) end
$$;
revoke all on function app.email_norm(text) from public;
grant execute on function app.email_norm(text) to disputeos_rls;
-- Opt-outs by normalised address, across every workspace: the scheduled job reads it before each send.
create index if not exists partners_opted_out_norm_idx on public.partners (app.email_norm(email)) where opted_out_at is not null;
-- One row per mailbox per agency, read the same way. Every row gets the whole sequence, so dana@gmail.com,
-- dana+1@gmail.com and d.ana@gmail.com as three rows would write to one person three times over. With this key an
-- import cannot add the same mailbox twice, in any spelling, and an address that opted out cannot come back as a new row.
-- A database that ran the earlier version of this file has the key on the literal address (partners_org_email_idx):
-- running the file again creates the new key and then drops the old one. Should two rows of one agency already be the
-- same mailbox, creating the new key fails and names them, and the old key stays: remove one row and run the file again.
create unique index if not exists partners_org_email_norm_idx on public.partners (org_id, app.email_norm(email));
do $$
begin
  if to_regclass('public.partners_org_email_norm_idx') is not null then
    drop index if exists public.partners_org_email_idx;
  end if;
end $$;

-- Which organization a partner belongs to, for the policies below (same shape as app.client_org in 0005).
create or replace function app.partner_org(target_partner uuid) returns uuid
language sql stable security definer set search_path = pg_catalog, public as $$
  select org_id from public.partners where id = target_partner
$$;
revoke all on function app.partner_org(uuid) from public;
grant execute on function app.partner_org(uuid) to disputeos_rls;
revoke all on function app.partners_guard() from public;

-- ---------------------------------------------------------------- 2. the email sequence: one row per (partner, step)
-- The unique key is what makes a retried or concurrent scheduled run send each step once. A step is claimed as
-- 'sending' (committed) before the email is handed to the email service, then set to 'sent' or 'failed'. A row left at
-- 'sending' means the outcome is unknown; it is never sent again automatically. A failed step stops the sequence for
-- that partner until a staff member asks for another try, which sets it to 'retry'. `subject` and `body` are the email
-- exactly as it was sent. `claimed_at` is when the current attempt was claimed: the daily limit counts on it.
create table if not exists public.partner_outreach (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  partner_id uuid not null references public.partners (id) on delete cascade,
  step text not null check (step in ('intro', 'followup', 'final')),
  status text not null check (status in ('sending', 'sent', 'failed', 'retry')),
  attempts int not null default 1,
  subject text check (subject is null or char_length(subject) <= 200),
  body text check (body is null or char_length(body) <= 10000),
  provider_ref text,
  error text check (error is null or char_length(error) <= 500),
  claimed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  unique (partner_id, step)
);
create index if not exists partner_outreach_org_idx on public.partner_outreach (org_id, claimed_at desc);
-- The deployment-wide 24-hour limit is counted by claim time across every workspace, and a bounce or complaint report
-- from the email service is matched by the id that service gave the email.
create index if not exists partner_outreach_claimed_idx on public.partner_outreach (claimed_at desc);
create index if not exists partner_outreach_provider_ref_idx on public.partner_outreach (provider_ref) where provider_ref is not null;
-- The same deployment-wide limit for lead follow-up texts is counted on public.lead_outreach by creation time.
create index if not exists lead_outreach_created_idx on public.lead_outreach (created_at desc);

-- ---------------------------------------------------------------- 3. per-partner timeline
create table if not exists public.partner_events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  partner_id uuid not null references public.partners (id) on delete cascade,
  actor_id uuid references public.users (id) on delete set null,
  kind text not null check (char_length(kind) between 1 and 40),
  summary text not null check (char_length(summary) between 1 and 300),
  created_at timestamptz not null default clock_timestamp()
);
create index if not exists partner_events_partner_idx on public.partner_events (partner_id, created_at desc);
create index if not exists partner_events_org_idx on public.partner_events (org_id);

-- ---------------------------------------------------------------- 4. "referred by" on a client
-- A client can be linked to the one partner who sent them. Kept in its own table, so public.clients and its portal
-- guard trigger are not touched.
create table if not exists public.partner_referrals (
  client_id uuid primary key references public.clients (id) on delete cascade,
  partner_id uuid not null references public.partners (id) on delete cascade,
  org_id uuid not null references public.organizations (id) on delete cascade,
  created_by uuid references public.users (id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists partner_referrals_partner_idx on public.partner_referrals (partner_id);
create index if not exists partner_referrals_org_idx on public.partner_referrals (org_id);

-- ---------------------------------------------------------------- 5. row-level security for the four new tables
alter table public.partners enable row level security;
alter table public.partner_outreach enable row level security;
alter table public.partner_events enable row level security;
alter table public.partner_referrals enable row level security;
revoke all on public.partners, public.partner_outreach, public.partner_events, public.partner_referrals from public;
revoke all on public.partners, public.partner_outreach, public.partner_events, public.partner_referrals from disputeos_rls;

-- Partners: staff read, add and edit those of their own organization. A row can be removed only while nothing was
-- ever sent to it and no client is linked to it, so a mistyped entry can go but the history of an address cannot.
grant select, insert, update, delete on public.partners to disputeos_rls;
drop policy if exists partners_staff_select on public.partners;
create policy partners_staff_select on public.partners for select to disputeos_rls using (app.is_staff(org_id));
drop policy if exists partners_staff_insert on public.partners;
create policy partners_staff_insert on public.partners for insert to disputeos_rls
  with check (app.is_staff(org_id) and attested_by = app.uid() and status = 'new' and paused_at is null and opted_out_at is null);
drop policy if exists partners_staff_update on public.partners;
create policy partners_staff_update on public.partners for update to disputeos_rls
  using (app.is_staff(org_id)) with check (app.is_staff(org_id));
drop policy if exists partners_staff_delete on public.partners;
create policy partners_staff_delete on public.partners for delete to disputeos_rls
  using (app.is_staff(org_id) and status = 'new'
         and not exists (select 1 from public.partner_outreach o where o.partner_id = partners.id)
         and not exists (select 1 from public.partner_referrals r where r.partner_id = partners.id));

-- The sequence log: staff read it. Only the system connection (the scheduled job) claims, sends and records. The one
-- thing a staff member may change is asking for another try of a step that failed ('failed' -> 'retry').
grant select on public.partner_outreach to disputeos_rls;
grant update (status) on public.partner_outreach to disputeos_rls;
drop policy if exists partner_outreach_staff_select on public.partner_outreach;
create policy partner_outreach_staff_select on public.partner_outreach for select to disputeos_rls using (app.is_staff(org_id));
drop policy if exists partner_outreach_staff_retry on public.partner_outreach;
create policy partner_outreach_staff_retry on public.partner_outreach for update to disputeos_rls
  using (app.is_staff(org_id) and status = 'failed') with check (app.is_staff(org_id) and status = 'retry');

-- Timeline: staff read it and add entries under their own name for partners of their own organization.
grant select, insert on public.partner_events to disputeos_rls;
drop policy if exists partner_events_staff_select on public.partner_events;
create policy partner_events_staff_select on public.partner_events for select to disputeos_rls using (app.is_staff(org_id));
drop policy if exists partner_events_staff_insert on public.partner_events;
create policy partner_events_staff_insert on public.partner_events for insert to disputeos_rls
  with check (app.is_staff(org_id) and actor_id = app.uid() and org_id = app.partner_org(partner_id));

-- Referred by: staff link a client of their organization to a partner of the same organization, change it or clear it.
grant select, insert, update, delete on public.partner_referrals to disputeos_rls;
drop policy if exists partner_referrals_staff on public.partner_referrals;
create policy partner_referrals_staff on public.partner_referrals for all to disputeos_rls
  using (app.is_staff(org_id))
  with check (app.is_staff(org_id) and org_id = app.client_org(client_id) and org_id = app.partner_org(partner_id));

-- Supabase's Data API roles get nothing on the new tables (0014 removed their default grants; this is the same rule
-- stated for these tables). Skipped where the roles do not exist.
do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on public.partners, public.partner_outreach, public.partner_events, public.partner_referrals from %I', r);
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------- 6. text follow-up for people who sent the enquiry form
-- (a) A third source for an SMS consent: the separate, unticked text-message box on the public enquiry form. It is the
--     person's own act but it is not signed in, so it is its own value and never read as a portal consent.
select pg_temp.widen_check('sms_consents', 'source', array['enquiry_form']);
-- (b) Two text steps join the lead follow-up log. They share its unique (client_id, step) key, so each is sent once.
select pg_temp.widen_check('lead_outreach', 'step', array['text_welcome', 'text_followup']);

-- (b2) A fourth way a consent ends: the person asked the team to stop, by phone, email or in person, and a staff member
--      recorded it (the "Asked to stop" button on a lead). It is the person's own revocation, so like a STOP reply it
--      can only be undone by them, signed in to the portal: neither staff nor the public form can re-grant over it.
select pg_temp.widen_check('sms_consents', 'revoked_via', array['asked_to_stop']);
create or replace function app.sms_stopped(target_client uuid, target_phone text) returns boolean
language sql stable security definer set search_path = pg_catalog, public as $$
  select coalesce((select s.revoked_via in ('sms_stop', 'asked_to_stop') from public.sms_consents s
                    where s.client_id = target_client order by s.granted_at desc, s.id desc limit 1), false)
      or exists (select 1 from public.sms_inbound i
                  where i.kind = 'stop' and i.from_phone = target_phone
                    and i.created_at > coalesce((select max(s.granted_at) from public.sms_consents s
                                                  where s.phone = target_phone and s.source = 'portal'), '-infinity'::timestamptz))
$$;
revoke all on function app.sms_stopped(uuid, text) from public;

-- (c) The timeline entry for a consent says where it came from. Same function as 0018 with the enquiry form added.
create or replace function app.on_sms_consent() returns trigger language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  if tg_op = 'INSERT' then
    insert into public.client_events (org_id, client_id, actor_id, kind, summary)
      values (new.org_id, new.client_id, new.recorded_by, 'sms_consent',
              case new.source when 'portal' then 'Client agreed to text message updates in the portal'
                              when 'enquiry_form' then 'Agreed to text messages on the enquiry form'
                              else 'Staff recorded the client''s agreement to text message updates' end);
  elsif old.revoked_at is null and new.revoked_at is not null then
    insert into public.client_events (org_id, client_id, actor_id, kind, summary)
      values (new.org_id, new.client_id, app.uid(), 'sms_consent',
              case new.revoked_via when 'sms_stop' then 'Client replied STOP by text: text message updates are off'
                                   when 'asked_to_stop' then 'Asked the team to stop: text messages are off, and only the client can turn them back on in the portal'
                                   when 'portal' then 'Client turned off text message updates in the portal'
                                   else 'Staff turned off text message updates for the client' end);
  end if;
  return new;
end $$;

-- (d) A STOP can only be undone by the person who sent it, signed in to the portal. The public form is not signed in
--     (anyone can type a number), so a consent from it is refused over a STOP exactly as a staff-recorded one is.
--     Same function as 0018 with the enquiry form added.
create or replace function app.sms_consents_stop_guard() returns trigger language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  if new.source in ('staff', 'enquiry_form') and app.sms_stopped(new.client_id, new.phone) then
    raise exception 'the client replied STOP: only the client can turn text messages back on, in the portal';
  end if;
  return new;
end $$;
revoke all on function app.sms_consents_stop_guard() from public;

-- ---------------------------------------------------------------- 7. the operator approves a workspace for outreach
-- Sign-up is open and unverified, and the partner emails and lead texts leave through the deployment's one email
-- service and one text number. So neither is sent for a workspace until the platform operator has approved it
-- (`npm run outreach:approve -- <workspace-slug>`), whatever its own switches say. The approval is for the business
-- name it had at that moment: the name is in every subject, From line and text, so a workspace that is renamed has to
-- be approved again. Both columns are written by the system connection only: the tenant role may update no column of
-- organizations but name, state_code and settings (0005), and these are not among them.
alter table public.organizations add column if not exists outreach_approved_at timestamptz;
alter table public.organizations add column if not exists outreach_approved_name text;
