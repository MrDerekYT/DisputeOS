-- 0018 Client updates by text message and email: SMS consent ledger, a send queue with one row per
-- (client, event, subject, channel), and a log of inbound texts.
-- Additive and safe to run again: three new tables with their own triggers and helper functions, one index on clients, and one existing
-- trigger function replaced with the same behaviour plus a channel-aware label. No existing row, column, check or policy is changed. Needs no superuser.

-- ---------------------------------------------------------------- 1. SMS consent ledger (TCPA, 47 U.S.C. § 227; 47 CFR § 64.1200)
-- One row each time a client agrees to receive texts. A row is never edited: withdrawing consent stamps revoked_at and
-- a later agreement is a new row. `consent_text` is the exact wording the person was shown (or, for a consent a staff
-- member recorded, the wording the staff member confirmed reading to them), and `phone` is the number it was given for:
-- a text is only ever sent to that number.
create table if not exists public.sms_consents (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  client_id uuid not null references public.clients (id) on delete cascade,
  phone text not null check (phone ~ '^\+[1-9][0-9]{7,14}$'),
  language text not null default 'en' check (language in ('en', 'es')),
  consent_text text not null check (char_length(consent_text) between 20 and 2000),
  source text not null check (source in ('portal', 'staff')),
  -- Required when staff record a consent the client gave verbally or on paper: how and when it was given.
  note text check (note is null or char_length(note) <= 500),
  recorded_by uuid references public.users (id) on delete set null,
  ip text,
  user_agent text,
  granted_at timestamptz not null default now(),
  revoked_at timestamptz,
  revoked_via text check (revoked_via is null or revoked_via in ('portal', 'staff', 'sms_stop')),
  constraint sms_consents_staff_note_check check (source <> 'staff' or char_length(btrim(coalesce(note, ''))) >= 10),
  constraint sms_consents_revoked_check check ((revoked_at is null) = (revoked_via is null))
);
-- At most one consent in force per client.
create unique index if not exists sms_consents_active_idx on public.sms_consents (client_id) where revoked_at is null;
create index if not exists sms_consents_client_idx on public.sms_consents (client_id, granted_at desc);
create index if not exists sms_consents_org_idx on public.sms_consents (org_id);

-- The ledger is append-only for tenant requests: the only change allowed is stamping the revocation, once.
create or replace function app.sms_consents_guard() returns trigger language plpgsql as $$
begin
  if current_user = 'disputeos_rls' then
    if old.revoked_at is not null
       or (new.id, new.org_id, new.client_id, new.phone, new.language, new.consent_text, new.source, new.note, new.recorded_by, new.ip, new.user_agent, new.granted_at)
          is distinct from
          (old.id, old.org_id, old.client_id, old.phone, old.language, old.consent_text, old.source, old.note, old.recorded_by, old.ip, old.user_agent, old.granted_at) then
      raise exception 'an SMS consent record can only be revoked, never edited';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists sms_consents_guard on public.sms_consents;
create trigger sms_consents_guard before update on public.sms_consents for each row execute function app.sms_consents_guard();

-- Every grant and every withdrawal lands on the client's timeline. Done here, as the table owner, because a portal
-- user may not write timeline rows directly (same approach as app.on_client_consent in 0006).
create or replace function app.on_sms_consent() returns trigger language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  if tg_op = 'INSERT' then
    insert into public.client_events (org_id, client_id, actor_id, kind, summary)
      values (new.org_id, new.client_id, new.recorded_by, 'sms_consent',
              case when new.source = 'portal' then 'Client agreed to text message updates in the portal'
                   else 'Staff recorded the client''s agreement to text message updates' end);
  elsif old.revoked_at is null and new.revoked_at is not null then
    insert into public.client_events (org_id, client_id, actor_id, kind, summary)
      values (new.org_id, new.client_id, app.uid(), 'sms_consent',
              case new.revoked_via when 'sms_stop' then 'Client replied STOP by text: text message updates are off'
                                   when 'portal' then 'Client turned off text message updates in the portal'
                                   else 'Staff turned off text message updates for the client' end);
  end if;
  return new;
end $$;
drop trigger if exists sms_consents_timeline on public.sms_consents;
create trigger sms_consents_timeline after insert or update on public.sms_consents for each row execute function app.on_sms_consent();

alter table public.sms_consents enable row level security;
revoke all on public.sms_consents from public;
revoke all on public.sms_consents from disputeos_rls;
grant select, insert, update on public.sms_consents to disputeos_rls;

-- Staff: read their organization's ledger, record a consent given outside the portal (labelled 'staff', with a note),
-- and revoke.
drop policy if exists sms_consents_staff_select on public.sms_consents;
create policy sms_consents_staff_select on public.sms_consents for select to disputeos_rls using (app.is_staff(org_id));
drop policy if exists sms_consents_staff_insert on public.sms_consents;
create policy sms_consents_staff_insert on public.sms_consents for insert to disputeos_rls
  with check (app.is_staff(org_id) and org_id = app.client_org(client_id) and source = 'staff' and recorded_by = app.uid() and revoked_at is null);
drop policy if exists sms_consents_staff_update on public.sms_consents;
create policy sms_consents_staff_update on public.sms_consents for update to disputeos_rls
  using (app.is_staff(org_id)) with check (app.is_staff(org_id));
-- The client: read their own, agree in the portal (labelled 'portal'), and withdraw.
drop policy if exists sms_consents_self_select on public.sms_consents;
create policy sms_consents_self_select on public.sms_consents for select to disputeos_rls using (client_id in (select app.client_ids()));
drop policy if exists sms_consents_self_insert on public.sms_consents;
create policy sms_consents_self_insert on public.sms_consents for insert to disputeos_rls
  with check (client_id in (select app.client_ids()) and org_id = app.client_org(client_id) and source = 'portal' and recorded_by = app.uid() and revoked_at is null);
drop policy if exists sms_consents_self_update on public.sms_consents;
create policy sms_consents_self_update on public.sms_consents for update to disputeos_rls
  using (client_id in (select app.client_ids())) with check (client_id in (select app.client_ids()));

-- ---------------------------------------------------------------- 2. the send queue
-- One row per (client, event, subject, channel). The unique key is what makes a repeated or concurrent trigger send
-- once. A row is written 'queued' inside the transaction that caused it, claimed as 'sending' (committed) before the
-- message is handed to the provider, then set to 'sent', 'failed' or 'skipped'. A row left at 'sending' means the
-- outcome is unknown; it is never sent again automatically.
create table if not exists public.client_updates (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  client_id uuid not null references public.clients (id) on delete cascade,
  event text not null check (event in ('dispute_sent', 'response_recorded', 'document_needed', 'document_rejected', 'window_passed', 'team_message')),
  subject_id text not null check (char_length(subject_id) between 1 and 80),
  channel text not null check (channel in ('sms', 'email')),
  status text not null default 'queued' check (status in ('queued', 'sending', 'sent', 'failed', 'skipped')),
  -- Which driver handled it ('twilio', 'resend', or the development stand-in 'log'). Null until it is attempted.
  provider text,
  provider_ref text,
  -- Why it failed or was skipped (no consent, daily limit, provider error...).
  error text check (error is null or char_length(error) <= 500),
  communication_id uuid references public.communications (id) on delete set null,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  unique (client_id, event, subject_id, channel)
);
create index if not exists client_updates_due_idx on public.client_updates (org_id, created_at) where status = 'queued';
create index if not exists client_updates_client_idx on public.client_updates (client_id, created_at desc);
create index if not exists client_updates_comm_idx on public.client_updates (communication_id);

-- Staff may read their organization's rows and add a 'queued' one (the transaction that records the event does that).
-- Everything after that — claiming, sending, recording the outcome — is done by the system connection only.
alter table public.client_updates enable row level security;
revoke all on public.client_updates from public;
revoke all on public.client_updates from disputeos_rls;
grant select, insert on public.client_updates to disputeos_rls;
drop policy if exists client_updates_staff_select on public.client_updates;
create policy client_updates_staff_select on public.client_updates for select to disputeos_rls using (app.is_staff(org_id));
drop policy if exists client_updates_staff_insert on public.client_updates;
create policy client_updates_staff_insert on public.client_updates for insert to disputeos_rls
  with check (app.is_staff(org_id) and org_id = app.client_org(client_id) and status = 'queued'
              and provider is null and provider_ref is null and communication_id is null and sent_at is null);

-- ---------------------------------------------------------------- 3. inbound texts
-- Every text the provider delivers to the webhook, once (provider_ref is the provider's message id, so a retried
-- delivery is ignored). A text matched to exactly one client is also stored as an inbound communication on that client.
-- One that matches nobody, or more than one client, is kept here unmatched for a person to review: never guessed.
create table if not exists public.sms_inbound (
  id uuid primary key default gen_random_uuid(),
  provider_ref text not null unique,
  -- Null when the sender matched no client, or clients in more than one organization.
  org_id uuid references public.organizations (id) on delete cascade,
  client_id uuid references public.clients (id) on delete set null,
  from_phone text not null check (char_length(from_phone) <= 30),
  to_phone text check (to_phone is null or char_length(to_phone) <= 40),
  kind text not null check (kind in ('message', 'stop', 'start', 'help')),
  body text not null check (char_length(body) <= 1600),
  reviewed_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists sms_inbound_org_idx on public.sms_inbound (org_id, created_at desc);

alter table public.sms_inbound enable row level security;
revoke all on public.sms_inbound from public;
revoke all on public.sms_inbound from disputeos_rls;
grant select on public.sms_inbound to disputeos_rls;
grant update (reviewed_at) on public.sms_inbound to disputeos_rls;
drop policy if exists sms_inbound_staff_select on public.sms_inbound;
create policy sms_inbound_staff_select on public.sms_inbound for select to disputeos_rls using (org_id is not null and app.is_staff(org_id));
drop policy if exists sms_inbound_staff_update on public.sms_inbound;
create policy sms_inbound_staff_update on public.sms_inbound for update to disputeos_rls
  using (org_id is not null and app.is_staff(org_id)) with check (org_id is not null and app.is_staff(org_id));

-- Finds the clients a sender's number belongs to (last ten digits; the app then compares the full number).
create index if not exists clients_phone_digits_idx on public.clients ((right(regexp_replace(phone, '\D', '', 'g'), 10))) where phone is not null;

-- ---------------------------------------------------------------- 4. an inbound text is not "a portal message"
-- Same function as 0006_portal_triggers.sql; the only change is the wording when the inbound message is a text.
create or replace function app.on_client_message() returns trigger language plpgsql security definer set search_path = pg_catalog, public as $$
declare assignee uuid;
begin
  if new.direction <> 'inbound' then return new; end if;
  update public.clients set last_activity_at = now() where id = new.client_id returning assigned_to into assignee;
  insert into public.client_events (org_id, client_id, actor_id, kind, summary)
    values (new.org_id, new.client_id, new.author_id, 'message', case when new.channel = 'sms' then 'Client sent a text message' else 'Client sent a portal message' end);
  if assignee is not null then
    insert into public.notifications (org_id, user_id, title, body, href)
      values (new.org_id, assignee, case when new.channel = 'sms' then 'New text message from a client' else 'New message from a client' end, left(new.body, 140), '/app/clients/' || new.client_id || '?tab=messages');
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------- 5. a STOP can only be undone by the person who sent it
-- 47 U.S.C. § 227; 47 CFR § 64.1200(a)(10): a revocation of consent has to be honoured. Staff may record a consent a
-- client gave outside the portal, but not over a STOP. "Stopped" means either
--   (a) the client's most recent consent record ended with a STOP reply, or
--   (b) the number has sent a STOP to this deployment since its owner last agreed in the portal (this also covers a
--       client record that never had a consent, e.g. the same number typed into another workspace).
-- A portal consent is the client's own act and is never blocked here.
-- Internal: reads across workspaces, so it is not callable by the tenant role.
create or replace function app.sms_stopped(target_client uuid, target_phone text) returns boolean
language sql stable security definer set search_path = pg_catalog, public as $$
  select coalesce((select s.revoked_via = 'sms_stop' from public.sms_consents s
                    where s.client_id = target_client order by s.granted_at desc, s.id desc limit 1), false)
      or exists (select 1 from public.sms_inbound i
                  where i.kind = 'stop' and i.from_phone = target_phone
                    and i.created_at > coalesce((select max(s.granted_at) from public.sms_consents s
                                                  where s.phone = target_phone and s.source = 'portal'), '-infinity'::timestamptz))
$$;

-- What the app asks before it offers or records a staff consent. Answers only for a client of the caller's own workspace.
create or replace function app.sms_stop_blocks_staff(target_client uuid, target_phone text) returns boolean
language sql stable security definer set search_path = pg_catalog, public as $$
  select app.is_staff(app.client_org(target_client)) and app.sms_stopped(target_client, target_phone)
$$;

-- The same rule in the table itself, for every connection.
create or replace function app.sms_consents_stop_guard() returns trigger language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  if new.source = 'staff' and app.sms_stopped(new.client_id, new.phone) then
    raise exception 'the client replied STOP: only the client can turn text messages back on, in the portal';
  end if;
  return new;
end $$;
drop trigger if exists sms_consents_stop_guard on public.sms_consents;
create trigger sms_consents_stop_guard before insert on public.sms_consents for each row execute function app.sms_consents_stop_guard();

revoke all on function app.sms_stopped(uuid, text) from public;
revoke all on function app.sms_stop_blocks_staff(uuid, text) from public;
revoke all on function app.sms_consents_stop_guard() from public;
grant execute on function app.sms_stop_blocks_staff(uuid, text) to disputeos_rls;
