-- 0005 Row-level security. Every table in `public` has RLS enabled; the `disputeos_rls` role only sees what a policy allows.
-- Reading order: grants, staff policies (by RBAC tier), then portal-client policies.

create function app.client_org(target_client uuid) returns uuid
language sql stable security definer set search_path = pg_catalog, public as $$
  select org_id from public.clients where id = target_client
$$;

-- ---------------------------------------------------------------- enable RLS everywhere
do $$
declare t record;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I enable row level security', t.tablename);
  end loop;
end $$;

-- ---------------------------------------------------------------- privileges
revoke all on all tables in schema public from public;
revoke all on all tables in schema public from disputeos_rls;
revoke all on all sequences in schema public from disputeos_rls;
revoke all on all functions in schema app from public;
grant execute on all functions in schema app to disputeos_rls;
grant usage, select on all sequences in schema public to disputeos_rls;

do $$
declare t text;
begin
  foreach t in array array[
    'clients', 'client_consents', 'client_notes', 'tasks', 'communications', 'client_events', 'documents', 'document_requests',
    'credit_reports', 'tradelines', 'inquiries', 'public_records', 'report_identity_items', 'findings',
    'disputes', 'dispute_events', 'dispute_evidence', 'letter_templates', 'letters', 'letter_versions',
    'automations', 'automation_runs', 'notifications', 'service_plans', 'client_subscriptions', 'payments',
    'memberships', 'invites'
  ] loop
    execute format('grant select, insert, update, delete on public.%I to disputeos_rls', t);
  end loop;
end $$;

-- sessions, password_resets, rate_limits, webhook_events: no grants and no policies => invisible to tenant requests.

-- users: never expose password_hash / totp secret to tenant queries.
grant select (id, email, full_name, totp_enabled, last_login_at, created_at, disabled_at) on public.users to disputeos_rls;
grant update (full_name) on public.users to disputeos_rls;
-- organizations: tenants may edit descriptive fields and settings; plan/billing state is system-controlled.
grant select on public.organizations to disputeos_rls;
grant update (name, state_code, settings) on public.organizations to disputeos_rls;
-- audit log: append + read only.
grant select, insert on public.audit_logs to disputeos_rls;

-- ---------------------------------------------------------------- identity & tenancy
create policy users_select on public.users for select to disputeos_rls
  using (id = app.uid() or app.shares_org_with(id));
create policy users_update_self on public.users for update to disputeos_rls
  using (id = app.uid()) with check (id = app.uid());

create policy orgs_select on public.organizations for select to disputeos_rls using (app.is_member(id));
create policy orgs_update on public.organizations for update to disputeos_rls
  using (app.is_admin(id)) with check (app.is_admin(id));

create policy memberships_select on public.memberships for select to disputeos_rls
  using (user_id = app.uid() or app.is_staff(org_id));
create policy memberships_write on public.memberships for all to disputeos_rls
  using (app.is_admin(org_id)) with check (app.is_admin(org_id));

create policy invites_admin on public.invites for all to disputeos_rls
  using (app.is_admin(org_id)) with check (app.is_admin(org_id));

-- Any staff member may invite (and track) portal clients; staff invitations remain admin-only (policy above).
create policy invites_client_staff on public.invites for all to disputeos_rls
  using (role = 'client' and app.is_staff(org_id)) with check (role = 'client' and app.is_staff(org_id));

create policy audit_insert on public.audit_logs for insert to disputeos_rls
  with check (org_id is not null and app.is_member(org_id) and actor_id = app.uid());
create policy audit_select on public.audit_logs for select to disputeos_rls using (app.is_admin(org_id));

-- ---------------------------------------------------------------- staff policies
-- Tier 1: any staff role (owner/admin/manager/specialist) has full access inside their organization.
do $$
declare t text;
begin
  foreach t in array array[
    'clients', 'client_consents', 'client_notes', 'tasks', 'communications', 'client_events', 'documents', 'document_requests',
    'credit_reports', 'tradelines', 'inquiries', 'public_records', 'report_identity_items', 'findings',
    'disputes', 'dispute_events', 'dispute_evidence', 'letters', 'letter_versions'
  ] loop
    execute format(
      'create policy %1$s_staff on public.%1$s for all to disputeos_rls using (app.is_staff(org_id)) with check (app.is_staff(org_id))', t);
  end loop;
end $$;

-- Tier 2: read for staff, change for managers and up (templates, automations' run log).
do $$
declare t text;
begin
  foreach t in array array['letter_templates', 'service_plans', 'automation_runs'] loop
    execute format('create policy %1$s_read on public.%1$s for select to disputeos_rls using (app.is_staff(org_id))', t);
    execute format(
      'create policy %1$s_write on public.%1$s for all to disputeos_rls using (app.is_member(org_id, array[''owner'',''admin'',''manager'']))
         with check (app.is_member(org_id, array[''owner'',''admin'',''manager'']))', t);
  end loop;
end $$;

-- Tier 3: automations are configured by admins only.
create policy automations_read on public.automations for select to disputeos_rls using (app.is_staff(org_id));
create policy automations_write on public.automations for all to disputeos_rls
  using (app.is_admin(org_id)) with check (app.is_admin(org_id));

-- Tier 4: money. Specialists cannot see or record payments.
create policy payments_billing on public.payments for all to disputeos_rls
  using (app.is_member(org_id, array['owner', 'admin', 'manager'])) with check (app.is_member(org_id, array['owner', 'admin', 'manager']));
create policy subscriptions_billing on public.client_subscriptions for all to disputeos_rls
  using (app.is_member(org_id, array['owner', 'admin', 'manager'])) with check (app.is_member(org_id, array['owner', 'admin', 'manager']));

-- Notifications: a recipient reads and clears their own; staff may create them within their org.
create policy notifications_self on public.notifications for select to disputeos_rls using (user_id = app.uid());
create policy notifications_self_update on public.notifications for update to disputeos_rls
  using (user_id = app.uid()) with check (user_id = app.uid());
create policy notifications_staff_insert on public.notifications for insert to disputeos_rls with check (app.is_staff(org_id));

-- ---------------------------------------------------------------- portal client policies (own records only)
create policy clients_self_select on public.clients for select to disputeos_rls using (portal_user_id = app.uid());
create policy clients_self_update on public.clients for update to disputeos_rls
  using (portal_user_id = app.uid()) with check (portal_user_id = app.uid());

create policy consents_self_select on public.client_consents for select to disputeos_rls
  using (client_id in (select app.client_ids()));
create policy consents_self_insert on public.client_consents for insert to disputeos_rls
  with check (client_id in (select app.client_ids()) and org_id = app.client_org(client_id));

create policy documents_self_select on public.documents for select to disputeos_rls
  using (client_id in (select app.client_ids()));
create policy documents_self_insert on public.documents for insert to disputeos_rls
  with check (client_id in (select app.client_ids()) and org_id = app.client_org(client_id)
              and source = 'client' and uploaded_by = app.uid());

create policy doc_requests_self on public.document_requests for select to disputeos_rls
  using (client_id in (select app.client_ids()));

create policy disputes_self on public.disputes for select to disputeos_rls
  using (client_id in (select app.client_ids()) and status not in ('draft', 'ready_for_review', 'cancelled'));

create policy dispute_events_self on public.dispute_events for select to disputeos_rls
  using (client_visible and dispute_id in (select id from public.disputes where client_id in (select app.client_ids())));

create policy letters_self on public.letters for select to disputeos_rls
  using (client_id in (select app.client_ids()) and status in ('approved', 'sent'));

create policy comms_self_select on public.communications for select to disputeos_rls
  using (client_id in (select app.client_ids()) and channel = 'portal' and direction <> 'internal'
         and status in ('sent', 'delivered', 'received'));
create policy comms_self_insert on public.communications for insert to disputeos_rls
  with check (client_id in (select app.client_ids()) and org_id = app.client_org(client_id)
              and direction = 'inbound' and channel = 'portal' and status = 'received' and author_id = app.uid());

create policy payments_self on public.payments for select to disputeos_rls using (client_id in (select app.client_ids()));
create policy subscriptions_self on public.client_subscriptions for select to disputeos_rls using (client_id in (select app.client_ids()));
