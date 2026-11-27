-- 0032 Two more client updates: "we received your credit report" and "we finished reviewing it".
-- Additive and safe to run again: only the list of allowed event names on public.client_updates grows. No row changes,
-- nothing here needs a superuser.
alter table public.client_updates drop constraint if exists client_updates_event_check;
alter table public.client_updates add constraint client_updates_event_check
  check (event in ('dispute_sent', 'response_recorded', 'document_needed', 'document_rejected', 'window_passed', 'team_message',
                   'report_received', 'report_reviewed'));
