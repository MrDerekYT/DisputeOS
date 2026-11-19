-- 0013 AI credits: make every charge recoverable, and keep a paid letter suggestion on the server.
--
-- 1. A 'use' row is a reservation until its outcome is recorded: either `settled_at` is set (an AI result was returned,
--    the charge stands) or a 'refund' row points at it through `ref_id`. A reservation with neither after a few minutes
--    belongs to a request that died mid-call; the scheduled jobs give it back (refundUnsettled in src/lib/ai/credits.ts).
alter table public.ai_credit_ledger
  add column ref_id bigint references public.ai_credit_ledger (id),
  add column settled_at timestamptz;
-- One refund per charge, enforced by the database.
create unique index ai_credit_ledger_one_refund on public.ai_credit_ledger (ref_id) where reason = 'refund';
create index ai_credit_ledger_open_idx on public.ai_credit_ledger (created_at) where reason = 'use' and settled_at is null;

-- Still append-only. The one new permitted change: a 'use' row's settled_at may be set once, and nothing else with it.
create or replace function app.ai_credit_ledger_immutable() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    if exists (select 1 from public.organizations where id = old.org_id) then
      raise exception 'ai_credit_ledger is append-only';
    end if;
    return old;
  end if;
  if new.actor_user_id is null and (to_jsonb(new) - 'actor_user_id') = (to_jsonb(old) - 'actor_user_id') then
    return new;
  end if;
  if old.reason = 'use' and old.settled_at is null and new.settled_at is not null
     and (to_jsonb(new) - 'settled_at') = (to_jsonb(old) - 'settled_at') then
    return new;
  end if;
  raise exception 'ai_credit_ledger is append-only';
end $$;

-- Charges made before this migration have no recorded outcome; they stand as they are and are never swept.
update public.ai_credit_ledger set settled_at = created_at where reason = 'use' and settled_at is null;

-- 2. A paid letter suggestion is stored for the letter version it was made from, so a lost response or a reload does
--    not lose it and asking again for the same version is not charged again. It goes when the letter goes.
create table public.letter_suggestions (
  letter_id uuid not null references public.letters (id) on delete cascade,
  version int not null,
  org_id uuid not null references public.organizations (id) on delete cascade,
  body text not null,
  provider text not null,
  created_by uuid references public.users (id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (letter_id, version)
);
alter table public.letter_suggestions enable row level security;
revoke all on public.letter_suggestions from public;
revoke all on public.letter_suggestions from disputeos_rls;
grant select, insert on public.letter_suggestions to disputeos_rls;
create policy letter_suggestions_staff_read on public.letter_suggestions for select to disputeos_rls using (app.is_staff(org_id));
create policy letter_suggestions_staff_insert on public.letter_suggestions for insert to disputeos_rls with check (app.is_staff(org_id));
