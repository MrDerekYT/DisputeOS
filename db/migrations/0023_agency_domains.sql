-- 0023 An agency's own domain name for its public website and client sign-in.
-- Additive and safe to run again: one new table, its indexes, one policy and one grant. No existing row, column,
-- check or policy is changed. Needs no superuser.
--
-- One domain per agency (org_id is unique). The www/apex twin of a domain is not a second row: both forms resolve to
-- the same row (the lookup and the uniqueness rule compare the name without a leading "www."), so a second agency
-- cannot claim the twin of a domain another agency has.
--
-- status:   pending   saved, waiting for DNS or for the hosting provider
--           verified  there is evidence the domain serves this app (the hosting provider says so, or the platform
--                     operator's check passed). Only a verified domain is ever routed to a site.
--           failed    the hosting provider refused the domain; `verification` says why
-- `verification` holds what the Website page shows: the DNS records to create, any ownership challenge, the last error.
create table if not exists public.agency_domains (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null unique references public.organizations (id) on delete cascade,
  domain text not null
    check (char_length(domain) between 4 and 253 and domain ~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])$'),
  status text not null default 'pending' check (status in ('pending', 'verified', 'failed')),
  verification jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  verified_at timestamptz,
  constraint agency_domains_verified_check check ((status = 'verified') = (verified_at is not null))
);
create unique index if not exists agency_domains_name_idx on public.agency_domains (regexp_replace(domain, '^www\.', ''));

-- Staff of the workspace may read their own row. There is no insert, update or delete grant: every change goes
-- through a server action that checks settings:manage and then writes with the system connection, so a tenant
-- request can never mark a domain verified. Host lookups for public pages also use the system connection.
alter table public.agency_domains enable row level security;
grant select on public.agency_domains to disputeos_rls;
drop policy if exists agency_domains_staff_select on public.agency_domains;
create policy agency_domains_staff_select on public.agency_domains for select to disputeos_rls using (app.is_staff(org_id));
