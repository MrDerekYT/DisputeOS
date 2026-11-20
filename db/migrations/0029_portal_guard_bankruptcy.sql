-- 0029 The portal guard on public.clients also covers the three bankruptcy columns of 0025.
-- Safe to run again (create or replace) and needs no superuser. Only the body of app.clients_portal_guard changes: no
-- table, row, policy, grant or trigger is touched, and replacing a function keeps its owner and its privileges.
--
-- Portal clients may update their own clients row (clients_self_update), and this trigger is what limits them to
-- phone, address and preferred language. 0025 added bankruptcy_chapter, bankruptcy_filed_on and
-- bankruptcy_discharged_on ("as staff entered it") without adding them here, so a portal user could set them on their
-- own row. They feed the bankruptcy findings and the bankruptcy letter. Same function as 0017_specialty_agencies.sql,
-- its newest definition, with the three columns added to both lists. Staff are not affected: the check is for
-- non-staff only.
create or replace function app.clients_portal_guard() returns trigger language plpgsql as $$
begin
  if current_user = 'disputeos_rls' and not app.is_staff(old.org_id) then
    if (new.org_id, new.assigned_to, new.portal_user_id, new.full_name, new.email, new.status, new.stage,
        new.source, new.ssn_last4, new.ssn_encrypted, new.dob_encrypted, new.tags, new.goals, new.id,
        new.banking_concern, new.specialty_reports,
        new.bankruptcy_chapter, new.bankruptcy_filed_on, new.bankruptcy_discharged_on)
       is distinct from
       (old.org_id, old.assigned_to, old.portal_user_id, old.full_name, old.email, old.status, old.stage,
        old.source, old.ssn_last4, old.ssn_encrypted, old.dob_encrypted, old.tags, old.goals, old.id,
        old.banking_concern, old.specialty_reports,
        old.bankruptcy_chapter, old.bankruptcy_filed_on, old.bankruptcy_discharged_on) then
      raise exception 'portal users may only update phone, address and preferred language';
    end if;
  end if;
  return new;
end $$;
