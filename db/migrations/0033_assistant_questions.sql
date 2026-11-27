-- 0033 "Ask about your clients" on the AI assistant page: what a staff member asked and what they were answered.
-- Additive and safe to run again: one new table with its indexes and policies, and one trigger on public.clients that
-- only removes rows of the new table. No existing row changes, and nothing here needs a superuser.
--
-- A row is the staff member's own question, the answer they were shown, whether an AI wrote it ('ai') or it was built
-- straight from the records ('records'), and which clients the answer is about. It is history for that person: the
-- page shows their last ten. The answer text is kept so the history reads the same later, whatever the records say by
-- then. The question is stored after Social Security, card and phone numbers and email addresses typed into it are
-- masked (src/lib/assistant/ask.ts).
create table if not exists public.assistant_questions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  user_id uuid not null references public.users (id) on delete cascade,
  question text not null check (char_length(question) between 1 and 500),
  answer text not null check (char_length(answer) between 1 and 6000),
  mode text not null check (mode in ('ai', 'records')),
  -- The clients whose files were read for the answer, and any other client the answer names in full.
  client_ids uuid[] not null default '{}',
  created_at timestamptz not null default now()
);
create index if not exists assistant_questions_user_idx on public.assistant_questions (org_id, user_id, created_at desc);
create index if not exists assistant_questions_clients_idx on public.assistant_questions using gin (client_ids);

-- Staff of the organization only, and each staff member reads and adds only their own rows: a question can name a
-- client and the answer states what is on that client's file, so a colleague's questions are shown to nobody else.
-- Rows are never edited, and the tenant role cannot delete them.
alter table public.assistant_questions enable row level security;
revoke all on public.assistant_questions from public;
revoke all on public.assistant_questions from disputeos_rls;
do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on public.assistant_questions from %I', r);
    end if;
  end loop;
end $$;
grant select, insert on public.assistant_questions to disputeos_rls;
drop policy if exists assistant_questions_own_select on public.assistant_questions;
create policy assistant_questions_own_select on public.assistant_questions for select to disputeos_rls
  using (user_id = app.uid() and app.is_staff(org_id));
drop policy if exists assistant_questions_own_insert on public.assistant_questions;
create policy assistant_questions_own_insert on public.assistant_questions for insert to disputeos_rls
  with check (user_id = app.uid() and app.is_staff(org_id));

-- Deleting a client deletes what was written about them here too. An answer is a copy of facts from the client's file,
-- so it must not outlive the file. The person deleting the client is usually not the person who asked, and the tenant
-- role may not delete these rows at all, so the function runs with its owner's rights and does this one thing: remove
-- the rows of the deleted client's own organization that are about that client.
create or replace function app.assistant_forget_client() returns trigger language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  delete from public.assistant_questions q where q.org_id = old.org_id and q.client_ids @> array[old.id];
  return old;
end $$;
revoke all on function app.assistant_forget_client() from public;
drop trigger if exists clients_forget_assistant_answers on public.clients;
create trigger clients_forget_assistant_answers after delete on public.clients for each row execute function app.assistant_forget_client();
