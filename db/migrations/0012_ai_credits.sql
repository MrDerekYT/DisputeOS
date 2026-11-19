-- 0012 AI credits. Every accepted AI result costs credits; an organization's balance is the sum of its ledger rows
-- (there is deliberately no balance column that could drift). New organizations have no rows, so they start at 0.
--
-- The ledger is append-only and written only by the system connection (src/lib/ai/credits.ts and
-- scripts/grant-credits.mjs). Tenant requests get SELECT for staff of the organization and nothing else, so no user
-- can grant themselves credits or erase a charge even if application code had a bug.
create table public.ai_credit_ledger (
  id bigint generated always as identity primary key,
  org_id uuid not null references public.organizations(id) on delete cascade,
  delta integer not null,
  reason text not null check (reason in ('grant', 'purchase', 'use', 'refund', 'adjust')),
  feature text,
  note text,
  actor_user_id uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint ai_credit_ledger_sign check (
    delta <> 0
    and (reason <> 'use' or delta < 0)
    and (reason not in ('grant', 'purchase', 'refund') or delta > 0))
);
create index ai_credit_ledger_org_idx on public.ai_credit_ledger (org_id, id desc);

-- Append-only for every role, the system included. Two exceptions, both made by foreign keys rather than by anyone
-- editing history: rows disappear together with their organization, and actor_user_id is cleared when that user is deleted.
create function app.ai_credit_ledger_immutable() returns trigger language plpgsql as $$
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
  raise exception 'ai_credit_ledger is append-only';
end $$;
create trigger ai_credit_ledger_no_change before update or delete on public.ai_credit_ledger
  for each row execute function app.ai_credit_ledger_immutable();

alter table public.ai_credit_ledger enable row level security;
revoke all on public.ai_credit_ledger from public;
revoke all on public.ai_credit_ledger from disputeos_rls;
grant select on public.ai_credit_ledger to disputeos_rls;
create policy ai_credit_ledger_staff_read on public.ai_credit_ledger for select to disputeos_rls using (app.is_staff(org_id));
