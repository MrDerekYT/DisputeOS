-- Clients could see their approved/sent letters in the portal but not the letter text, so "Download PDF" answered 404.
-- Let a client read exactly one thing: the CURRENT version of their OWN letter, and only once it is approved or sent.
-- Drafts, earlier versions and other clients' letters stay invisible to them.
create policy letter_versions_self on public.letter_versions for select to disputeos_rls
  using (exists (
    select 1 from public.letters l
     where l.id = letter_versions.letter_id
       and l.client_id in (select app.client_ids())
       and l.status in ('approved', 'sent')
       and l.current_version = letter_versions.version));
