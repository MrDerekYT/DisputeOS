-- 0011 Leads: consent-based automatic follow-up email.
-- A lead who uses the opt-out link in any automatic email gets no further automatic lead email.
alter table public.clients add column if not exists outreach_opt_out_at timestamptz;

-- One row per lead per step. The unique key is what makes a retried or concurrent scheduled run send each step once.
-- A step is claimed as 'sending' (committed) before the email is handed to the email service, then set to 'sent' or 'failed'.
-- A row left at 'sending' means the outcome is unknown; it is never sent again automatically.
create table if not exists public.lead_outreach (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  client_id uuid not null references public.clients (id) on delete cascade,
  step text not null check (step in ('welcome', 'followup', 'final')),
  status text not null check (status in ('sending', 'sent', 'failed')),
  attempts int not null default 1,
  error text check (error is null or char_length(error) <= 500),
  communication_id uuid references public.communications (id) on delete set null,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  unique (client_id, step)
);
create index if not exists lead_outreach_org_idx on public.lead_outreach (org_id, created_at desc);
create index if not exists lead_outreach_comm_idx on public.lead_outreach (communication_id);

-- Staff may read their organization's log; only the system (enquiry form, scheduled jobs) writes it.
alter table public.lead_outreach enable row level security;
grant select on public.lead_outreach to disputeos_rls;
drop policy if exists lead_outreach_staff on public.lead_outreach;
create policy lead_outreach_staff on public.lead_outreach for select to disputeos_rls using (app.is_staff(org_id));
