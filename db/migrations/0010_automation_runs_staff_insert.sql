-- Event automations run inline, in the acting user's own row-level-security transaction (createClient, report import,
-- dispute status changes). automation_runs only let owner/admin/manager write (0005, tier 2), so as soon as an admin
-- enabled such an automation a specialist's ordinary action failed with 42501 and was rolled back.
-- Let any staff member of the organization INSERT a run-log row. Updating or deleting a run (approve / cancel) stays
-- manager-and-up through automation_runs_write; clients still have no access at all.
-- The row must be for an automation of that same organization (the foreign key alone would accept another
-- organization's automation and let its dedupe keys be occupied), in a state the engine itself writes, and undecided.
drop policy if exists automation_runs_staff_insert on public.automation_runs;
create policy automation_runs_staff_insert on public.automation_runs for insert to disputeos_rls
  with check (
    app.is_staff(org_id)
    and status in ('completed', 'pending_approval')
    and decided_by is null
    and exists (select 1 from public.automations a where a.id = automation_runs.automation_id and a.org_id = automation_runs.org_id)
  );
