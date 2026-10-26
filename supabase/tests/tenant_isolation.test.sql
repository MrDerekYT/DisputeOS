-- Tenant-isolation test. Run against a local Supabase: `supabase test db`.
begin;
select plan(4);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'a@example.com'),
  ('00000000-0000-0000-0000-0000000000b1', 'b@example.com');
insert into public.organizations (id, name) values
  ('10000000-0000-0000-0000-00000000000a', 'Org A'),
  ('10000000-0000-0000-0000-00000000000b', 'Org B');
insert into public.memberships (organization_id, user_id, role) values
  ('10000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000a1', 'owner'),
  ('10000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-0000000000b1', 'owner');
insert into public.clients (organization_id, full_name) values
  ('10000000-0000-0000-0000-00000000000a', 'Client of A'),
  ('10000000-0000-0000-0000-00000000000b', 'Client of B');

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000000a1","aal":"aal2","role":"authenticated"}', true);

select is((select count(*)::int from public.clients), 1, 'Org A user sees only own clients');
select is((select count(*)::int from public.clients where full_name = 'Client of B'), 0, 'cross-tenant read returns nothing');
select throws_ok(
  $$insert into public.clients (organization_id, full_name) values ('10000000-0000-0000-0000-00000000000b', 'x')$$,
  '42501', null, 'cross-tenant insert is blocked');

select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000000a1","aal":"aal1","role":"authenticated"}', true);
select is((select count(*)::int from public.clients), 0, 'staff without MFA (aal1) sees nothing');

select * from finish();
rollback;
