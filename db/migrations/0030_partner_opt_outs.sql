-- 0030 One list, for the whole deployment, of the mailboxes whose owner stopped the partner emails themselves.
-- Additive and safe to run again: one new table that only the system connection reads and writes, filled once from
-- the opt-outs already on record. No existing row is changed, and nothing here needs a superuser.
--
-- Until now the scheduled job counted another workspace's opted-out partner as the recipient's own opt-out when its
-- timeline entry had no actor. That mark did not hold. When staff had pressed "Asked to stop" first, the recipient's
-- own later opt-out (the link, the mail program's button, a spam complaint) wrote no entry, so other workspaces kept
-- emailing the mailbox. Deleting a staff user empties the actor of every "Asked to stop" they recorded, which then
-- counted for every workspace. Deleting a workspace deleted the opt-outs its recipients had made.
--
-- This list holds only what a recipient did, keyed by the address as the opt-out check reads it (app.email_norm,
-- 0028). It belongs to no workspace and refers to no row, so deleting a user or a workspace removes nothing from it.
--   source  link       the button on the page behind the opt-out link
--           one_click  the mail program's own "unsubscribe" button (a POST to the List-Unsubscribe address)
--           complaint  the email service reported that the recipient marked an email as spam
create table if not exists public.partner_opt_outs (
  email_norm text primary key,
  source text not null check (source in ('link', 'one_click', 'complaint')),
  created_at timestamptz not null default now()
);

-- No tenant request can read it or write to it: row-level security is on with no policy, and neither the tenant role
-- nor Supabase's Data API roles hold any privilege on it. The opt-out endpoints and the scheduled job use the system
-- connection.
alter table public.partner_opt_outs enable row level security;
revoke all on public.partner_opt_outs from public;
revoke all on public.partner_opt_outs from disputeos_rls;
do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on public.partner_opt_outs from %I', r);
    end if;
  end loop;
end $$;

-- What is already on record. A recipient's own opt-out was written with no actor and one of two wordings; the wording
-- is matched as well, because an entry with no actor can also be a staff member's "Asked to stop" whose account was
-- deleted, or a stop that an earlier version of the job copied onto another workspace's record. The link and the mail
-- program's button wrote the same wording, so both are recorded as 'link'.
insert into public.partner_opt_outs (email_norm, source, created_at)
select distinct on (app.email_norm(p.email)) app.email_norm(p.email),
       case when e.summary like 'The recipient marked one of these emails as spam%' then 'complaint' else 'link' end,
       e.created_at
  from public.partner_events e join public.partners p on p.id = e.partner_id
 where e.kind = 'opted_out' and e.actor_id is null
   and (e.summary like 'Opted out from an email%' or e.summary like 'The recipient marked one of these emails as spam%')
 order by app.email_norm(p.email), e.created_at
on conflict (email_norm) do nothing;
