import type { Db, Param } from '../db';
import { UserError } from '../errors';
import { audit } from '../audit';
import { fireTrigger } from '../automation/engine';
import { consentStatus } from '../compliance/disclosures';
import { logEvent } from '../crm';
import { can, PermissionError, type Role } from '../rbac';
import { BUREAU_LABEL, type Bureau } from '../util';
import {
  BUREAU_ADDRESSES, CATEGORIES, canTransition, FINDING_TO_CATEGORY, permissionFor, responseDueDate, SPECIALTY_CATEGORY, STATUS_LABEL, type DisputeStatus, type Outcome,
} from './workflow';
import { parseAgencyItem, specialtyAgency, type AgencyItem } from '../credit/agencies';
import { findBlockedClaims } from '../compliance/claims';
import type { Evidence } from '../reports/analysis';
import { draftReason, reasonIsClientsOwn } from './reasons';
import { businessToday, checkSentOn } from '../letters/service';
import { queueClientUpdate } from '../client-updates/service';

export interface DActor { orgId: string; userId: string; role: Role; meta?: { ip?: string | null } }
export class DisputeError extends UserError {}
export const CONFIRMED_ACCURATE_STOP = 'The client confirmed this item is reported accurately, so no further letter or round is offered for it.';

export interface NewDispute {
  clientId: string; tradelineId?: string | null; findingId?: string | null; category: string; reason: string; fields?: string[];
  bureau?: Bureau | null; recipientName?: string; assignedTo?: string | null; parentId?: string | null; round?: number;
  /** What the dispute is about when it is not an account on a report (for example “Personal information”). */
  itemLabel?: string;
}

export async function createDispute(db: Db, actor: DActor, d: NewDispute): Promise<string> {
  if (!can(actor.role, 'disputes:write')) throw new PermissionError('disputes:write');
  const cat = CATEGORIES[d.category];
  if (!cat) throw new DisputeError('Choose a dispute category.');
  if (cat.target === 'agency') throw new DisputeError('A specialty agency item is entered on its own form.');
  const reason = d.reason.trim();
  if (reason.length < 10) throw new DisputeError('Explain the reason in at least a sentence (10+ characters).');

  const client = await db.row<{ id: string; assigned_to: string | null }>('select id, assigned_to from public.clients where id = $1', [d.clientId]);
  if (!client) throw new DisputeError('Client not found.');

  let label = d.itemLabel?.trim().slice(0, 120) ?? '';
  let bureau: Bureau | null = d.bureau ?? null;
  let recipient = d.recipientName?.trim() ?? '';
  if (d.tradelineId) {
    const t = await db.row<{ creditor_name: string; account_last4: string | null; bureau: Bureau; client_id: string }>('select creditor_name, account_last4, bureau, client_id from public.tradelines where id = $1', [d.tradelineId]);
    if (!t || t.client_id !== d.clientId) throw new DisputeError('That account does not belong to this client.');
    label = `${t.creditor_name}${t.account_last4 ? ` ••${t.account_last4}` : ''}`;
    if (cat.target === 'bureau') bureau = bureau ?? t.bureau;
    if (cat.target !== 'bureau' && !recipient) recipient = t.creditor_name;
  }
  if (cat.target === 'bureau') {
    if (!bureau) throw new DisputeError('Choose which bureau this dispute is for.');
    recipient = BUREAU_ADDRESSES[bureau]?.name ?? BUREAU_LABEL[bureau];
    label = `${label || 'Item'} (${BUREAU_LABEL[bureau]})`;
  } else {
    if (!recipient) throw new DisputeError('Enter the name of the company this goes to.');
    label = label || recipient;
    bureau = null;
  }

  const row = await db.row<{ id: string }>(
    `insert into public.disputes (org_id, client_id, tradeline_id, finding_id, parent_dispute_id, item_label, target_type, bureau, recipient_name, category, reason, fields,
       workflow, round, assigned_to, created_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) returning id`,
    [actor.orgId, d.clientId, d.tradelineId ?? null, d.findingId ?? null, d.parentId ?? null, label, cat.target, bureau, recipient, d.category, reason, d.fields ?? [],
      cat.workflow, d.round ?? 1, d.assignedTo ?? client.assigned_to ?? actor.userId, actor.userId],
  );
  if (d.findingId) await db.run("update public.findings set status = 'disputed', reviewed_by = $2 where id = $1", [d.findingId, actor.userId]);
  await logEvent(db, actor, d.clientId, 'dispute_created', `Dispute drafted: ${label}`, { dispute_id: row!.id });
  await audit(db, { orgId: actor.orgId, actorId: actor.userId, action: 'dispute.created', entityType: 'dispute', entityId: row!.id, ip: actor.meta?.ip, meta: { category: d.category, round: d.round ?? 1 } });
  return row!.id;
}

export interface NewSpecialtyDispute {
  clientId: string; agency: string; item: AgencyItem; reason: string;
  /** Typed by staff from the agency's current instructions. Used, and required, only when the registry holds no verified address. */
  recipientAddress?: string | null; assignedTo?: string | null; parentId?: string | null; round?: number;
}

/**
 * A dispute about an item on a specialty agency's disclosure (ChexSystems, LexisNexis, ...). Nothing is read from a
 * report: a person typed the item as it appears on the consumer's disclosure and wrote why it is inaccurate, incomplete
 * or unverifiable. From here it is an ordinary dispute: the same review, approval, letter, submission and 30-day window.
 */
export async function createSpecialtyDispute(db: Db, actor: DActor, d: NewSpecialtyDispute): Promise<string> {
  if (!can(actor.role, 'disputes:write')) throw new PermissionError('disputes:write');
  const agency = specialtyAgency(d.agency);
  if (!agency) throw new DisputeError('Choose the reporting agency.');
  const clean = (v: string | null | undefined, max: number) => (v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
  const item: AgencyItem = { name: clean(d.item.name, 160), reference: clean(d.item.reference, 60) || null, date: clean(d.item.date, 40) || null, amount: clean(d.item.amount, 40) || null, consumerId: clean(d.item.consumerId, 60) || null };
  if (item.name.length < 2) throw new DisputeError('Enter the company or account name as it appears on the disclosure.');
  const reason = d.reason.trim();
  if (reason.length < 10) throw new DisputeError('Explain what is inaccurate, incomplete or unverifiable, and why (10+ characters).');
  // The registry's verified address always wins; a typed one is kept only where the registry has none.
  const typed = (d.recipientAddress ?? '').replace(/\r\n?/g, '\n').split('\n').map((l) => l.trim()).filter(Boolean).join('\n').slice(0, 400);
  if (!agency.disputeAddress && typed.length < 10) throw new DisputeError(`Enter the dispute mailing address from ${agency.shortName}’s current instructions. There is no verified address on file for it.`);

  const client = await db.row<{ id: string; assigned_to: string | null }>('select id, assigned_to from public.clients where id = $1', [d.clientId]);
  if (!client) throw new DisputeError('Client not found.');
  const label = `${item.name}${item.reference ? ` · ${item.reference}` : ''} (${agency.shortName})`.slice(0, 300);
  const row = await db.row<{ id: string }>(
    `insert into public.disputes (org_id, client_id, parent_dispute_id, item_label, target_type, bureau, agency, agency_item, recipient_name, recipient_address, category, reason,
       workflow, round, assigned_to, created_by)
     values ($1,$2,$3,$4,'agency',null,$5,$6,$7,$8,$9,$10,'specialty',$11,$12,$13) returning id`,
    [actor.orgId, d.clientId, d.parentId ?? null, label, agency.key, JSON.stringify(item), agency.name, agency.disputeAddress ? null : typed, SPECIALTY_CATEGORY, reason,
      d.round ?? 1, d.assignedTo ?? client.assigned_to ?? actor.userId, actor.userId],
  );
  await logEvent(db, actor, d.clientId, 'dispute_created', `Dispute drafted: ${label}`, { dispute_id: row!.id });
  await audit(db, { orgId: actor.orgId, actorId: actor.userId, action: 'dispute.created', entityType: 'dispute', entityId: row!.id, ip: actor.meta?.ip, meta: { category: SPECIALTY_CATEGORY, agency: agency.key, round: d.round ?? 1 } });
  return row!.id;
}

interface DisputeRow {
  id: string; client_id: string; status: DisputeStatus; round: number; workflow: string; due_at: string | null; submitted_at: string | null; approved_by: string | null;
  deadline_extended: boolean; item_label: string; created_by: string | null;
}

/**
 * Move a dispute along the pipeline. Gates (all enforced here, not just in the UI):
 *  - the transition must be legal; approving needs the approve permission
 *  - submitting needs an APPROVED letter and the client's required consents on file
 *  - nothing is sent by the system: "submitted" records that a person mailed it
 */
export async function transitionDispute(
  db: Db, actor: DActor, id: string, to: DisputeStatus,
  opts: { receivedOn?: string | null; extended?: boolean; note?: string; sentMethod?: 'certified_mail' | 'first_class_mail' | 'portal' | 'manual'; tracking?: string | null; sentOn?: string | null } = {},
): Promise<void> {
  const d = await db.row<DisputeRow>('select id, client_id, status, round, workflow, due_at, submitted_at, approved_by, deadline_extended, item_label, created_by from public.disputes where id = $1 for update', [id]);
  if (!d) throw new DisputeError('Dispute not found.');
  if (!canTransition(d.status, to)) throw new DisputeError(`A dispute that is “${STATUS_LABEL[d.status]}” cannot move to “${STATUS_LABEL[to]}”.`);
  const perm = permissionFor(to);
  if (!can(actor.role, perm)) throw new PermissionError(perm);

  const sets: string[] = ['status = $2'];
  const p: Param[] = [id, to];
  const set = (col: string, v: Param) => { p.push(v); sets.push(`${col} = $${p.length}`); };

  if (to === 'approved') {
    set('approved_by', actor.userId);
    set('approved_at', new Date());
  }
  if (to === 'ready_for_review') {
    const letter = await db.row('select 1 from public.letters where dispute_id = $1 and status <> \'void\'', [id]);
    if (!letter) throw new DisputeError('Create a letter for this dispute before sending it for review.');
  }
  if (to === 'submitted') {
    const letter = await db.row<{ id: string }>("select id from public.letters where dispute_id = $1 and status in ('approved', 'sent') and kind <> 'method_of_verification' order by created_at desc limit 1", [id]);
    if (!letter) throw new DisputeError('This dispute has no approved letter. A person must approve the letter before it can be submitted.');
    const consents = await db.rows<{ kind: string; signed_at: string; revoked_at: string | null }>('select kind, signed_at, revoked_at from public.client_consents where client_id = $1', [d.client_id]);
    const cs = consentStatus(consents);
    if (cs.missing.length) throw new DisputeError(`Required consents are missing for this client: ${cs.missing.join(', ').replace(/_/g, ' ')}. Record them before submitting.`);
    const received = opts.receivedOn ? new Date(`${opts.receivedOn}T12:00:00Z`) : new Date();
    // When no sent date is given it defaults to today — or to the received date, if that is earlier (it cannot have arrived before it was sent).
    const receivedDay = received.toISOString().slice(0, 10);
    const sentOn = checkSentOn(opts.sentOn ?? (opts.receivedOn && receivedDay < businessToday() ? receivedDay : null));
    // submitted_at is the day the letter was actually sent (as recorded by staff), not the moment someone clicked.
    // A date that is not in the past (today, or "today" for someone ahead of the agency's zone) is recorded as now — never a future time.
    const submitted = sentOn >= businessToday() ? new Date() : new Date(`${sentOn}T12:00:00Z`);
    // Only a typed received date can contradict the sent date; with none, receipt is now and the sent date is already not in the future.
    if (opts.receivedOn && received.getTime() < new Date(`${sentOn}T00:00:00Z`).getTime()) throw new DisputeError('The received date cannot be before the sent date.');
    set('submitted_at', submitted);
    set('deadline_extended', !!opts.extended);
    set('due_at', responseDueDate(received, !!opts.extended));
    await db.run("update public.letters set status = 'sent', sent_at = now(), sent_on = $4, sent_method = $2, tracking_number = $3, delivery_source = 'staff_recorded', sent_recorded_by = $5 where id = $1 and status = 'approved'", [letter.id, opts.sentMethod ?? 'certified_mail', opts.tracking?.trim().slice(0, 80) || null, sentOn, actor.userId]);
    await db.run("update public.clients set stage = 'disputing', status = case when status in ('lead','onboarding') then 'active' else status end where id = $1", [d.client_id]);
  }
  await db.run(`update public.disputes set ${sets.join(', ')} where id = $1`, p);
  if (opts.note) await db.run('insert into public.dispute_events (org_id, dispute_id, actor_id, kind, note) values ($1, $2, $3, $4, $5)', [actor.orgId, id, actor.userId, 'note', opts.note.slice(0, 2000)]);
  await logEvent(db, actor, d.client_id, 'dispute_status', `Dispute “${d.item_label}” → ${STATUS_LABEL[to]}`, { dispute_id: id });
  await audit(db, { orgId: actor.orgId, actorId: actor.userId, action: `dispute.${to}`, entityType: 'dispute', entityId: id, ip: actor.meta?.ip, meta: { from: d.status, to } });
  await fireTrigger(db, actor, 'dispute_status_changed', { type: 'dispute', id }, { toStatus: to });
  if (to === 'submitted') await queueClientUpdate(db, { orgId: actor.orgId, clientId: d.client_id, event: 'dispute_sent', subjectId: id });
}

export async function recordResponse(db: Db, actor: DActor, id: string, r: { outcome: Outcome; notes?: string; receivedOn?: string; completedOn?: string }): Promise<void> {
  if (!can(actor.role, 'disputes:write')) throw new PermissionError('disputes:write');
  const d = await db.row<{ status: DisputeStatus; client_id: string }>('select status, client_id from public.disputes where id = $1 for update', [id]);
  if (!d) throw new DisputeError('Dispute not found.');
  if (!['submitted', 'under_investigation', 'response_received'].includes(d.status)) throw new DisputeError('Only a submitted dispute can have a response recorded.');
  // The day the agency says it completed its reinvestigation: written results are due 5 business days later (15 U.S.C. § 1681i(a)(6)(A), see ./clock.ts).
  if (r.completedOn && r.completedOn > (r.receivedOn ?? businessToday())) throw new DisputeError('The reinvestigation cannot have been completed after the response was received.');
  await db.run(
    `update public.disputes set outcome = $2, outcome_notes = $3, response_at = $4, investigation_completed_on = coalesce($5::date, investigation_completed_on), status = 'response_received' where id = $1`,
    [id, r.outcome, r.notes?.slice(0, 4000) ?? null, r.receivedOn ? `${r.receivedOn}T12:00:00Z` : new Date(), r.completedOn ?? null],
  );
  await db.run('insert into public.dispute_events (org_id, dispute_id, actor_id, kind, note, client_visible) values ($1, $2, $3, $4, $5, true)', [actor.orgId, id, actor.userId, 'outcome', `Outcome recorded: ${r.outcome.replace(/_/g, ' ')}`]);
  await logEvent(db, actor, d.client_id, 'dispute_outcome', `Dispute outcome recorded: ${r.outcome.replace(/_/g, ' ')}`, { dispute_id: id });
  await audit(db, { orgId: actor.orgId, actorId: actor.userId, action: 'dispute.outcome', entityType: 'dispute', entityId: id, ip: actor.meta?.ip, meta: { outcome: r.outcome } });
  await fireTrigger(db, actor, 'dispute_status_changed', { type: 'dispute', id }, { toStatus: 'response_received' });
  await queueClientUpdate(db, { orgId: actor.orgId, clientId: d.client_id, event: 'response_recorded', subjectId: id });
}

/**
 * Another round against the same item. Because repeating an identical dispute with nothing new can be treated as
 * frivolous, the next round must state what is NEW (information or evidence) and differ from the previous reason.
 */
export async function startNextRound(db: Db, actor: DActor, id: string, input: { reason: string; newInformation: string }): Promise<string> {
  if (!can(actor.role, 'disputes:write')) throw new PermissionError('disputes:write');
  const prev = await db.row<{ client_id: string; tradeline_id: string | null; category: string; reason: string; bureau: Bureau | null; fields: string[]; round: number; status: DisputeStatus; recipient_name: string; assigned_to: string | null; agency: string | null; agency_item: unknown; recipient_address: string | null; client_confirmed_accurate: boolean }>(
    'select client_id, tradeline_id, category, reason, bureau, fields, round, status, recipient_name, assigned_to, agency, agency_item, recipient_address, client_confirmed_accurate from public.disputes where id = $1', [id]);
  if (!prev) throw new DisputeError('Dispute not found.');
  if (prev.status !== 'resolved') throw new DisputeError('Resolve the current round before starting the next one.');
  // 15 U.S.C. § 1679b(a)(1): once the client has confirmed the item is reported accurately, it is not disputed again.
  if (prev.client_confirmed_accurate) throw new DisputeError(CONFIRMED_ACCURATE_STOP);
  if (input.newInformation.trim().length < 15) throw new DisputeError('Describe the new information or evidence that justifies another round.');
  if (input.reason.trim().toLowerCase() === prev.reason.trim().toLowerCase()) throw new DisputeError('The reason is identical to the previous round. Explain what is different this time.');
  const reason = `${input.reason.trim()}\n\nNew information since my previous request: ${input.newInformation.trim()}`;
  const item = prev.agency ? parseAgencyItem(prev.agency_item) : null;
  const newId = prev.agency && item
    ? await createSpecialtyDispute(db, actor, { clientId: prev.client_id, agency: prev.agency, item, reason, recipientAddress: prev.recipient_address, parentId: id, round: prev.round + 1, assignedTo: prev.assigned_to })
    : await createDispute(db, actor, {
      clientId: prev.client_id, tradelineId: prev.tradeline_id, category: prev.category, bureau: prev.bureau, recipientName: prev.recipient_name, fields: prev.fields,
      reason, parentId: id, round: prev.round + 1, assignedTo: prev.assigned_to,
    });
  await db.run('insert into public.dispute_events (org_id, dispute_id, actor_id, kind, note) values ($1, $2, $3, $4, $5)', [actor.orgId, newId, actor.userId, 'round_started', `Round ${prev.round + 1} started from the previous dispute`]);
  return newId;
}

export async function addEvidence(db: Db, actor: DActor, disputeId: string, e: { documentId?: string | null; label: string; note?: string }): Promise<void> {
  if (!can(actor.role, 'disputes:write')) throw new PermissionError('disputes:write');
  const d = await db.row<{ client_id: string }>('select client_id from public.disputes where id = $1', [disputeId]);
  if (!d) throw new DisputeError('Dispute not found.');
  if (e.documentId) {
    const doc = await db.row<{ client_id: string }>('select client_id from public.documents where id = $1', [e.documentId]);
    if (!doc || doc.client_id !== d.client_id) throw new DisputeError('That document does not belong to this client.');
  }
  await db.run('insert into public.dispute_evidence (org_id, dispute_id, document_id, label, note, added_by) values ($1,$2,$3,$4,$5,$6)', [actor.orgId, disputeId, e.documentId ?? null, e.label.slice(0, 200), e.note?.slice(0, 1000) ?? null, actor.userId]);
  await db.run('insert into public.dispute_events (org_id, dispute_id, actor_id, kind, note) values ($1, $2, $3, $4, $5)', [actor.orgId, disputeId, actor.userId, 'evidence', `Evidence added: ${e.label.slice(0, 120)}`]);
}

export interface BulkDraftResult { created: { id: string; findingId: string }[]; skipped: { findingId: string; title: string; why: string }[] }
export const BULK_DRAFT_LIMIT = 25;

/**
 * Drafts one dispute per selected finding, with the reason written from that finding's own evidence.
 * These are DRAFTS only: each one still has to be read, sent for review, approved and have an approved letter
 * before it can be submitted — the same gates as a dispute started by hand. Findings that cannot be drafted
 * automatically (already disputed, dismissed, or missing an account) are skipped and reported, never guessed at.
 */
export async function draftDisputesFromFindings(db: Db, actor: DActor, clientId: string, findingIds: string[]): Promise<BulkDraftResult> {
  if (!can(actor.role, 'disputes:write')) throw new PermissionError('disputes:write');
  const ids = [...new Set(findingIds)];
  if (ids.length === 0) throw new DisputeError('Select at least one finding.');
  if (ids.length > BULK_DRAFT_LIMIT) throw new DisputeError(`Select up to ${BULK_DRAFT_LIMIT} findings at a time.`);
  const findings = await db.rows<{ id: string; category: string; title: string; status: string; evidence: Evidence[]; tradeline_ids: string[] }>(
    'select id, category, title, status, evidence, tradeline_ids from public.findings where client_id = $1 and id = any($2) order by created_at', [clientId, ids]);
  const tradelines = await db.rows<{ id: string; creditor_name: string; account_last4: string | null; bureau: Bureau }>(
    "select t.id, t.creditor_name, t.account_last4, t.bureau from public.tradelines t where t.client_id = $1 and exists (select 1 from public.credit_reports r where r.id = t.report_id and r.status = 'approved')", [clientId]);
  const out: BulkDraftResult = { created: [], skipped: [] };
  for (const id of ids) if (!findings.some((f) => f.id === id)) out.skipped.push({ findingId: id, title: 'Unknown finding', why: 'It does not belong to this client.' });
  for (const f of findings) {
    const skip = (why: string) => out.skipped.push({ findingId: f.id, title: f.title, why });
    if (f.status === 'disputed') { skip('A dispute was already started for it.'); continue; }
    if (f.status === 'dismissed') { skip('It was dismissed.'); continue; }
    const category = FINDING_TO_CATEGORY[f.category];
    const cat = category ? CATEGORIES[category] : undefined;
    if (!category || !cat) { skip('This kind of finding needs a dispute type chosen by hand.'); continue; }
    const tl = tradelines.find((t) => f.tradeline_ids.includes(t.id));
    if (!tl) { skip('No account from an approved report is linked to it — start this one by hand.'); continue; }
    // No reason is drafted where it can only be the client's own account (a debt a collector asks about, personal information).
    if (reasonIsClientsOwn(category)) { skip('This kind of dispute needs the client’s own words for its reason. Start it by hand.'); continue; }
    const reason = draftReason({ category, creditor: tl.creditor_name, last4: tl.account_last4, bureau: tl.bureau, evidence: f.evidence });
    if (findBlockedClaims(reason).length) { skip('The drafted wording needs a person to write it.'); continue; }
    try {
      const newId = await createDispute(db, actor, { clientId, tradelineId: tl.id, findingId: f.id, category, reason, fields: [] });
      out.created.push({ id: newId, findingId: f.id });
    } catch (e) {
      if (e instanceof DisputeError) { skip(e.message); continue; }
      throw e;
    }
  }
  return out;
}
