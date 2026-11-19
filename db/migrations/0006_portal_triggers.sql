-- 0006 Portal side-effects that a client's own role may not perform directly (they run as the table owner).

-- A client-uploaded document fulfils the oldest open matching request, lands in the timeline, and tells the specialist.
create function app.on_client_document() returns trigger language plpgsql security definer set search_path = pg_catalog, public as $$
declare req uuid; assignee uuid;
begin
  if new.source <> 'client' then return new; end if;
  select id into req from public.document_requests
    where client_id = new.client_id and kind = new.kind and fulfilled_document_id is null order by created_at limit 1;
  if req is not null then update public.document_requests set fulfilled_document_id = new.id where id = req; end if;
  insert into public.client_events (org_id, client_id, actor_id, kind, summary)
    values (new.org_id, new.client_id, new.uploaded_by, 'document', 'Client uploaded ' || left(new.file_name, 120));
  update public.clients set last_activity_at = now() where id = new.client_id returning assigned_to into assignee;
  if assignee is not null then
    insert into public.notifications (org_id, user_id, title, body, href)
      values (new.org_id, assignee, 'Client uploaded a document', left(new.file_name, 120), '/app/clients/' || new.client_id || '?tab=documents');
  end if;
  return new;
end $$;
create trigger documents_client_upload after insert on public.documents for each row execute function app.on_client_document();

-- A client's portal message counts as activity and notifies the specialist.
create function app.on_client_message() returns trigger language plpgsql security definer set search_path = pg_catalog, public as $$
declare assignee uuid;
begin
  if new.direction <> 'inbound' then return new; end if;
  update public.clients set last_activity_at = now() where id = new.client_id returning assigned_to into assignee;
  insert into public.client_events (org_id, client_id, actor_id, kind, summary) values (new.org_id, new.client_id, new.author_id, 'message', 'Client sent a portal message');
  if assignee is not null then
    insert into public.notifications (org_id, user_id, title, body, href)
      values (new.org_id, assignee, 'New message from a client', left(new.body, 140), '/app/clients/' || new.client_id || '?tab=messages');
  end if;
  return new;
end $$;
create trigger communications_client_message after insert on public.communications for each row execute function app.on_client_message();

-- A client e-signing a consent is recorded on their timeline.
create function app.on_client_consent() returns trigger language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  if app.uid() is not null and exists (select 1 from public.clients where id = new.client_id and portal_user_id = app.uid()) then
    insert into public.client_events (org_id, client_id, actor_id, kind, summary) values (new.org_id, new.client_id, app.uid(), 'consent', 'Client e-signed: ' || new.kind);
  end if;
  return new;
end $$;
create trigger consents_client_sign after insert on public.client_consents for each row execute function app.on_client_consent();
