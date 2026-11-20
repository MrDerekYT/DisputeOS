/**
 * The recorded actions behind the legal clock and the optional next steps (rules in ./clock.ts and ./next-steps.ts).
 * Every one of them is a person recording something or asking for a draft: nothing is sent, filed or decided here.
 */
import type { Db } from '../db';
import { audit } from '../audit';
import { fireTrigger } from '../automation/engine';
import { findBlockedClaims } from '../compliance/claims';
import { logEvent } from '../crm';
import { can, PermissionError } from '../rbac';
import { createLetter, LetterError } from '../letters/service';
import { procedureTemplateKey } from '../letters/templates';
import { addDays, procedureDescriptionDue, receivedDay, REINVESTIGATION_DAYS, sayDay, withinOriginalPeriod, type Day } from './clock';
import { isAgencyDispute } from './next-steps';
import { checkReceivedOn, CONFIRMED_ACCURATE_STOP, DisputeError, notFuture, type DActor } from './service';
import { getEnv } from '../env';

export const PROCEDURE_KIND = 'method_of_verification';

/**
 * "The client sent more information on <date>". 15 U.S.C. § 1681i(a)(1)(B): when the agency receives relevant
 * information from the consumer during the 30-day period, that period may be extended by up to 15 days. Recording it
 * moves the deadline to 45 days from receipt, the latest it can run, and the dispute shows why.
 */
export async function recordMoreInformation(db: Db, actor: DActor, id: string, sentOn: Day): Promise<void> {
  if (!can(actor.role, 'disputes:write')) throw new PermissionError('disputes:write');
  const d = await db.row<{ client_id: string; status: string; target_type: string; due_at: string | null; deadline_extended: boolean; item_label: string }>(
    'select client_id, status, target_type, due_at, deadline_extended, item_label from public.disputes where id = $1 for update', [id]);
  if (!d) throw new DisputeError('Dispute not found.');
  if (!isAgencyDispute(d.target_type)) throw new DisputeError('The 45-day period applies to disputes sent to a credit bureau or a specialty agency.');
  if (!d.due_at || (d.status !== 'submitted' && d.status !== 'under_investigation')) throw new DisputeError('More information can be recorded while a submitted dispute is waiting for its response.');
  notFuture(sentOn, 'the date the information was sent');
  const received = receivedDay(d.due_at, d.deadline_extended, getEnv().APP_TIMEZONE);
  if (!withinOriginalPeriod(received, sentOn)) {
    throw new DisputeError(`Only information sent during the ${REINVESTIGATION_DAYS.standard} days after the agency received the dispute (${sayDay(received)} to ${sayDay(addDays(received, REINVESTIGATION_DAYS.standard))}) extends the period.`);
  }
  await db.run(
    `update public.disputes set more_info_on = $2, deadline_extended = true,
            due_at = case when deadline_extended then due_at else due_at + make_interval(days => $3) end where id = $1`,
    [id, sentOn, REINVESTIGATION_DAYS.extended - REINVESTIGATION_DAYS.standard]);
  await db.run('insert into public.dispute_events (org_id, dispute_id, actor_id, kind, note) values ($1, $2, $3, $4, $5)',
    [actor.orgId, id, actor.userId, 'deadline_extended', `Client sent more information on ${sayDay(sentOn)}. The reinvestigation period now runs up to ${REINVESTIGATION_DAYS.extended} days from receipt.`]);
  await audit(db, { orgId: actor.orgId, actorId: actor.userId, action: 'dispute.more_information', entityType: 'dispute', entityId: id, ip: actor.meta?.ip, meta: { sent_on: sentOn } });
}

/** Staff record that the client has confirmed the item is reported accurately. No further step is offered for it. */
export async function setConfirmedAccurate(db: Db, actor: DActor, id: string, confirmed: boolean): Promise<void> {
  if (!can(actor.role, 'disputes:write')) throw new PermissionError('disputes:write');
  const d = await db.row<{ client_confirmed_accurate: boolean }>('select client_confirmed_accurate from public.disputes where id = $1 for update', [id]);
  if (!d) throw new DisputeError('Dispute not found.');
  if (d.client_confirmed_accurate === confirmed) return;
  await db.run('update public.disputes set client_confirmed_accurate = $2 where id = $1', [id, confirmed]);
  await db.run('insert into public.dispute_events (org_id, dispute_id, actor_id, kind, note) values ($1, $2, $3, $4, $5)',
    [actor.orgId, id, actor.userId, 'note', confirmed ? 'Client confirmed the item is reported accurately. No further step, letter or round is offered for it.' : 'The note that the client confirmed the item as accurate was removed.']);
  await audit(db, { orgId: actor.orgId, actorId: actor.userId, action: 'dispute.confirmed_accurate', entityType: 'dispute', entityId: id, ip: actor.meta?.ip, meta: { confirmed } });
}

/**
 * Drafts the request for the description of the reinvestigation procedure (15 U.S.C. § 1681i(a)(6)(B)(iii), (a)(7)).
 * Only after a result of "verified as reported" is recorded, never for an item the client has confirmed is accurate,
 * and one at a time. The result is an ordinary DRAFT letter: it is edited, sent for approval, approved and mailed by
 * people like any other. Its 15-day clock starts when it is recorded as sent (markSent).
 */
export async function requestProcedureDescription(db: Db, actor: DActor, id: string, orgName?: string): Promise<string> {
  const d = await db.row<{ client_id: string; status: string; target_type: string; outcome: string | null; response_at: string | null; client_confirmed_accurate: boolean }>(
    'select client_id, status, target_type, outcome, response_at, client_confirmed_accurate from public.disputes where id = $1 for update', [id]);
  if (!d) throw new DisputeError('Dispute not found.');
  if (!isAgencyDispute(d.target_type)) throw new DisputeError('This request goes to a credit bureau or a specialty agency.');
  if (d.outcome !== 'verified' || !d.response_at || !['response_received', 'resolved'].includes(d.status)) throw new DisputeError('This request follows a recorded result of “verified as reported”.');
  if (d.client_confirmed_accurate) throw new DisputeError(CONFIRMED_ACCURATE_STOP);
  const existing = await db.row<{ id: string }>("select id from public.letters where dispute_id = $1 and kind = $2 and status <> 'void'", [id, PROCEDURE_KIND]);
  if (existing) throw new LetterError('A request for the reinvestigation procedure already exists for this dispute.');
  const letterId = await createLetter(db, actor, { clientId: d.client_id, disputeId: id, templateKey: procedureTemplateKey(), orgName });
  await db.run('insert into public.dispute_events (org_id, dispute_id, actor_id, kind, note) values ($1, $2, $3, $4, $5)',
    [actor.orgId, id, actor.userId, 'note', 'Request for the description of the reinvestigation procedure drafted. It needs approval before it is mailed.']);
  return letterId;
}

/**
 * Dates on a sent request for the reinvestigation procedure: the day the agency received it (the 15 days of
 * § 1681i(a)(7) are then counted from that day instead of the sent date) and the day its description arrived.
 */
export async function recordProcedureDates(db: Db, actor: DActor, letterId: string, r: { receivedOn?: Day | null; replyOn?: Day | null }): Promise<void> {
  if (!can(actor.role, 'disputes:write')) throw new PermissionError('disputes:write');
  const l = await db.row<{ kind: string; status: string; sent_on: string | null; dispute_id: string | null; received_on: string | null }>(
    'select kind, status, sent_on, dispute_id, received_on from public.letters where id = $1 for update', [letterId]);
  if (!l || l.kind !== PROCEDURE_KIND) throw new LetterError('Letter not found.');
  if (l.status !== 'sent' || !l.sent_on) throw new LetterError('Record the request as sent first.');
  if (!r.receivedOn && !r.replyOn) throw new LetterError('Enter a date.');
  const notes: string[] = [];
  if (r.receivedOn) {
    notFuture(r.receivedOn, 'the date the agency received the request');
    if (r.receivedOn < l.sent_on) throw new LetterError('The agency cannot have received the request before it was sent.');
    await db.run('update public.letters set received_on = $2, reply_due_on = $3 where id = $1', [letterId, r.receivedOn, procedureDescriptionDue(r.receivedOn)]);
    notes.push(`The agency received the request for its reinvestigation procedure on ${sayDay(r.receivedOn)}.`);
  }
  if (r.replyOn) {
    notFuture(r.replyOn, 'the date the description arrived');
    if (r.replyOn < l.sent_on) throw new LetterError('The description cannot have arrived before the request was sent.');
    await db.run('update public.letters set reply_received_on = $2 where id = $1', [letterId, r.replyOn]);
    notes.push(`The agency’s description of its reinvestigation procedure arrived on ${sayDay(r.replyOn)}.`);
  }
  if (l.dispute_id) {
    for (const note of notes) await db.run('insert into public.dispute_events (org_id, dispute_id, actor_id, kind, note) values ($1, $2, $3, $4, $5)', [actor.orgId, l.dispute_id, actor.userId, 'note', note]);
  }
  await audit(db, { orgId: actor.orgId, actorId: actor.userId, action: 'letter.procedure_dates', entityType: 'letter', entityId: letterId, ip: actor.meta?.ip, meta: { received_on: r.receivedOn ?? null, reply_on: r.replyOn ?? null } });
}

/**
 * Intake for a "frivolous or irrelevant" notice. 15 U.S.C. § 1681i(a)(3): an agency may end a reinvestigation when the
 * consumer has not given it enough information to investigate, and its notice must say why and identify "any
 * information required to investigate the disputed information". Staff type what the notice asked for; that, and only
 * that, becomes a task and a document request the client sees in the portal. No reason is suggested or invented here.
 * The day the notice arrived is required: the next round's letter states it as the day the client received the notice.
 */
export async function recordFrivolousNotice(db: Db, actor: DActor, id: string, r: { missing: string; receivedOn?: Day | null }): Promise<void> {
  if (!can(actor.role, 'disputes:write')) throw new PermissionError('disputes:write');
  const d = await db.row<{ client_id: string; status: string; target_type: string; item_label: string; recipient_name: string; assigned_to: string | null; submitted_at: string | null }>(
    'select client_id, status, target_type, item_label, recipient_name, assigned_to, submitted_at from public.disputes where id = $1 for update', [id]);
  if (!d) throw new DisputeError('Dispute not found.');
  if (!isAgencyDispute(d.target_type)) throw new DisputeError('This notice comes from a credit bureau or a specialty agency.');
  if (!['submitted', 'under_investigation', 'response_received'].includes(d.status)) throw new DisputeError('Only a submitted dispute can have a response recorded.');
  const missing = r.missing.replace(/\s+/g, ' ').trim().slice(0, 1000);
  if (missing.length < 5) throw new DisputeError('Enter what the agency’s notice said was missing, in its words.');
  const claim = findBlockedClaims(missing)[0];
  if (claim) throw new DisputeError(`That text contains a claim we cannot allow: “${claim.excerpt}” — ${claim.why}`);
  const receivedOn = checkReceivedOn(r.receivedOn, d.submitted_at, 'the date the notice was received');

  await db.run(
    `update public.disputes set outcome = 'frivolous', frivolous_missing = $2, response_at = $3, status = 'response_received' where id = $1`,
    [id, missing, `${receivedOn}T12:00:00Z`]);
  await db.run('insert into public.dispute_events (org_id, dispute_id, actor_id, kind, note, client_visible) values ($1, $2, $3, $4, $5, true)',
    [actor.orgId, id, actor.userId, 'outcome', `${d.recipient_name} asked for more information before it investigates.`]);
  // The staff task: exactly what the notice asked for, nothing added. One open task per dispute; recording again updates it.
  await db.run(
    `insert into public.tasks (org_id, client_id, dispute_id, assignee_id, created_by, title, detail, kind, dedupe_key)
     values ($1, $2, $3, $4, $5, $6, $7, 'document', $8)
     on conflict (org_id, dedupe_key) where dedupe_key is not null and status = 'open' do update set title = excluded.title, detail = excluded.detail`,
    [actor.orgId, d.client_id, id, d.assigned_to ?? actor.userId, actor.userId, `Client to provide: ${missing}`.slice(0, 200),
      `${d.recipient_name} said it needs this to investigate the dispute about “${d.item_label}”: ${missing}`.slice(0, 2000), `frivolous:${id}`]);
  // What the client sees in the portal, under documents to send.
  const note = `${d.recipient_name} asked for this to investigate your dispute about ${d.item_label}: ${missing}`.slice(0, 500);
  await db.run(
    `insert into public.document_requests (org_id, client_id, kind, note, created_by)
     select $1, $2, 'evidence', $3, $4 where not exists (select 1 from public.document_requests where client_id = $2 and note = $3 and fulfilled_document_id is null)`,
    [actor.orgId, d.client_id, note, actor.userId]);
  await logEvent(db, actor, d.client_id, 'dispute_outcome', `${d.recipient_name} asked for more information on “${d.item_label}”`, { dispute_id: id });
  await audit(db, { orgId: actor.orgId, actorId: actor.userId, action: 'dispute.outcome', entityType: 'dispute', entityId: id, ip: actor.meta?.ip, meta: { outcome: 'frivolous' } });
  await fireTrigger(db, actor, 'dispute_status_changed', { type: 'dispute', id }, { toStatus: 'response_received' });
}
