-- Delivery records: what staff typed in is kept apart from what a carrier confirmed.
-- Today every delivery is 'staff_recorded' (a person mailed the letter and entered the details).
-- 'carrier_confirmed' is reserved for a print-and-mail integration that reports delivery itself; nothing sets it yet.
alter table public.letters
  add column sent_on date,
  add column delivery_source text not null default 'staff_recorded' check (delivery_source in ('staff_recorded', 'carrier_confirmed')),
  add column carrier_delivered_at timestamptz,
  add column sent_recorded_by uuid references public.users (id) on delete set null;
alter table public.letters add constraint letters_carrier_delivery_chk check (carrier_delivered_at is null or delivery_source = 'carrier_confirmed');
update public.letters set sent_on = sent_at::date where sent_at is not null and sent_on is null;

-- One row per organization per scheduled-jobs run, so an operator can see when jobs last ran and whether they failed.
create table public.job_runs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null check (status in ('ok', 'failed')),
  executed int not null default 0,
  pending int not null default 0,
  skipped int not null default 0,
  error text check (error is null or char_length(error) <= 1000)
);
create index job_runs_org_idx on public.job_runs (org_id, started_at desc);

alter table public.job_runs enable row level security;
grant select on public.job_runs to disputeos_rls;
create policy job_runs_staff on public.job_runs for select to disputeos_rls using (app.is_staff(org_id));
