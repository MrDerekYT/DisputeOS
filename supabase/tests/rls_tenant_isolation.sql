-- Tenant-isolation tests. Run via scripts/test-rls.sh. Any failed assertion aborts with an error.
\set ON_ERROR_STOP on

create or replace function pg_temp.as_user(uid uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', coalesce(uid::text, ''), false);
  execute 'set role authenticated';
end $$;

create or replace function pg_temp.reset() returns void language plpgsql as $$
begin
  execute 'reset role';
  perform set_config('request.jwt.claim.sub', '', false);
end $$;

create or replace function pg_temp.assert_eq(label text, actual bigint, expected bigint) returns void
language plpgsql as $$
begin
  if actual is distinct from expected then
    raise exception 'FAIL: % (expected %, got %)', label, expected, actual;
  end if;
  raise notice 'ok: %', label;
end $$;

-- Two agencies (A, B) and one personal org (P), via the real signup trigger.
insert into auth.users (id, email, raw_user_meta_data) values
  ('a0000000-0000-0000-0000-000000000001', 'owner-a@test.dev', '{"mode":"agency","org_name":"Agency A"}'),
  ('b0000000-0000-0000-0000-000000000001', 'owner-b@test.dev', '{"mode":"agency","org_name":"Agency B"}'),
  ('c0000000-0000-0000-0000-000000000001', 'solo@test.dev',    '{"mode":"personal"}');

-- Add staff + a client portal user to A (service role path), plus data in both orgs.
insert into auth.users (id, email) values
  ('a0000000-0000-0000-0000-000000000002', 'staff-a@test.dev'),
  ('a0000000-0000-0000-0000-000000000003', 'client-a@test.dev');
-- handle_new_user made each their own org; move them into Agency A as staff/client.
delete from public.organizations where id in (
  select org_id from public.users where id in ('a0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-000000000003'));
insert into public.users (id, org_id, role, email)
select 'a0000000-0000-0000-0000-000000000002', org_id, 'staff', 'staff-a@test.dev' from public.users where id = 'a0000000-0000-0000-0000-000000000001';
insert into public.users (id, org_id, role, email)
select 'a0000000-0000-0000-0000-000000000003', org_id, 'client', 'client-a@test.dev' from public.users where id = 'a0000000-0000-0000-0000-000000000001';

insert into public.clients (id, org_id, user_id, full_name)
select 'a1000000-0000-0000-0000-000000000001', org_id, null, 'Alice (A)' from public.users where id = 'a0000000-0000-0000-0000-000000000001';
insert into public.clients (id, org_id, user_id, full_name)
select 'a1000000-0000-0000-0000-000000000002', org_id, 'a0000000-0000-0000-0000-000000000003', 'Portal Client (A)' from public.users where id = 'a0000000-0000-0000-0000-000000000001';
insert into public.clients (id, org_id, full_name)
select 'b1000000-0000-0000-0000-000000000001', org_id, 'Bob (B)' from public.users where id = 'b0000000-0000-0000-0000-000000000001';

select org_id as org_b from public.users where id = 'b0000000-0000-0000-0000-000000000001' \gset
select set_config('t.org_b', :'org_b', false);

-- 1. Staff/owner of A sees only A's clients.
select pg_temp.as_user('a0000000-0000-0000-0000-000000000001');
select pg_temp.assert_eq('owner A sees 2 clients (own org only)', (select count(*) from public.clients), 2);
select pg_temp.assert_eq('owner A cannot read B client', (select count(*) from public.clients where full_name = 'Bob (B)'), 0);
select pg_temp.assert_eq('owner A sees only own org row', (select count(*) from public.organizations), 1);
select pg_temp.assert_eq('owner A sees only A users', (select count(*) from public.users), 3);

-- 2. Cross-tenant writes are rejected or affect zero rows.
update public.clients set full_name = 'pwned' where id = 'b1000000-0000-0000-0000-000000000001';
delete from public.clients where id = 'b1000000-0000-0000-0000-000000000001';
select pg_temp.reset();
select pg_temp.assert_eq('B client untouched by A', (select count(*) from public.clients where id = 'b1000000-0000-0000-0000-000000000001' and full_name = 'Bob (B)'), 1);

select pg_temp.as_user('a0000000-0000-0000-0000-000000000001');
do $$ begin
  insert into public.clients (org_id, full_name) values (current_setting('t.org_b')::uuid, 'injected');
  raise exception 'FAIL: cross-tenant insert succeeded';
exception when insufficient_privilege then raise notice 'ok: cross-tenant insert blocked by RLS';
end $$;

-- 3. Owners cannot escalate role or move org.
do $$ begin
  update public.users set role = 'owner' where id = 'a0000000-0000-0000-0000-000000000002';
  raise exception 'FAIL: role update allowed';
exception when insufficient_privilege then raise notice 'ok: role column not updatable';
end $$;

-- 4. Client portal user sees only their own record, never staff-wide data.
select pg_temp.as_user('a0000000-0000-0000-0000-000000000003');
select pg_temp.assert_eq('client sees only own client row', (select count(*) from public.clients), 1);
select pg_temp.assert_eq('client cannot see org users', (select count(*) from public.users where id <> auth.uid()), 0);
select pg_temp.assert_eq('client cannot read audit logs', (select count(*) from public.audit_logs), 0);

-- 5. Org B and personal org are isolated from A.
select pg_temp.as_user('b0000000-0000-0000-0000-000000000001');
select pg_temp.assert_eq('owner B sees only Bob', (select count(*) from public.clients), 1);
select pg_temp.as_user('c0000000-0000-0000-0000-000000000001');
select pg_temp.assert_eq('personal user sees only own org clients', (select count(*) from public.clients where full_name in ('Alice (A)','Bob (B)')), 0);

-- 6. Anonymous (no JWT) sees nothing / has no privileges.
select pg_temp.reset();
set role anon;
do $$ begin
  perform count(*) from public.clients;
  raise exception 'FAIL: anon can query clients';
exception when insufficient_privilege then raise notice 'ok: anon has no table access';
end $$;
reset role;

-- 7. Audit log is append-only, spoofing actor is blocked, and staff cannot read it.
select pg_temp.as_user('a0000000-0000-0000-0000-000000000001');
insert into public.audit_logs (org_id, actor_id, action, entity_type)
select org_id, id, 'test', 'client' from public.users where id = auth.uid();
do $$ begin
  update public.audit_logs set action = 'tampered';
  raise exception 'FAIL: audit update allowed';
exception when insufficient_privilege then raise notice 'ok: audit_logs update denied';
end $$;
do $$ begin
  insert into public.audit_logs (org_id, actor_id, action, entity_type)
  select org_id, 'a0000000-0000-0000-0000-000000000002', 'spoof', 'client' from public.users where id = auth.uid();
  raise exception 'FAIL: actor spoofing allowed';
exception when insufficient_privilege then raise notice 'ok: actor spoofing blocked';
end $$;
select pg_temp.as_user('a0000000-0000-0000-0000-000000000002');
select pg_temp.assert_eq('staff cannot read audit logs', (select count(*) from public.audit_logs), 0);

select pg_temp.reset();
do $$ begin
  delete from public.audit_logs;
  raise exception 'FAIL: privileged delete on audit_logs succeeded';
exception when raise_exception then
  if sqlerrm like 'FAIL%' then raise; end if;
  raise notice 'ok: audit_logs immutable even for superuser';
end $$;

-- 7b. Phase 2: report_imports and vault storage are tenant-isolated.
select pg_temp.reset();
insert into public.report_imports (org_id, client_id)
select org_id, 'a1000000-0000-0000-0000-000000000001' from public.users where id = 'a0000000-0000-0000-0000-000000000001';
select org_id as org_a from public.users where id = 'a0000000-0000-0000-0000-000000000001' \gset
select set_config('t.org_a', :'org_a', false);
insert into storage.objects (bucket_id, name) values
  ('vault', :'org_a' || '/a1000000-0000-0000-0000-000000000001/id.pdf'),
  ('vault', :'org_b' || '/b1000000-0000-0000-0000-000000000001/id.pdf');
select pg_temp.as_user('a0000000-0000-0000-0000-000000000001');
select pg_temp.assert_eq('A sees own report_imports', (select count(*) from public.report_imports), 1);
select pg_temp.assert_eq('A sees only own vault objects', (select count(*) from storage.objects where bucket_id = 'vault'), 1);
select pg_temp.as_user('b0000000-0000-0000-0000-000000000001');
select pg_temp.assert_eq('B sees no A report_imports', (select count(*) from public.report_imports), 0);
select pg_temp.assert_eq('B sees only own vault objects', (select count(*) from storage.objects where bucket_id = 'vault' and name like current_setting('t.org_a') || '%'), 0);
select pg_temp.as_user('a0000000-0000-0000-0000-000000000003');
select pg_temp.assert_eq('portal client cannot read report_imports', (select count(*) from public.report_imports), 0);
select pg_temp.assert_eq('portal client cannot read vault', (select count(*) from storage.objects), 0);
do $$ begin
  insert into storage.objects (bucket_id, name) values ('vault', current_setting('t.org_a') || '/x/evil.pdf');
  raise exception 'FAIL: portal client wrote to vault';
exception when insufficient_privilege then raise notice 'ok: portal client vault write blocked';
end $$;
select pg_temp.reset();

-- 8. Every public table has RLS enabled.
select pg_temp.assert_eq('all public tables have RLS enabled',
  (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity), 0);
