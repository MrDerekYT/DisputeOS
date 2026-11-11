import type { Db, Param } from '../db';
import { UserError } from '../errors';
import { audit } from '../audit';
import { fireTrigger } from '../automation/engine';
import { consentStatus } from '../compliance/disclosures';
import { logEvent } from '../crm';
import { can, PermissionError, type Role } from '../rbac';
import { BUREAU_LABEL, type Bureau } from '../util';
import {
  BUREAU_ADDRESSES, CATEGORIES, canTransition, FINDING_TO_CATEGORY, permissionFor, responseDueDate, STATUS_LABEL, type DisputeStatus, type Outcome,
} from './workflow';
import { findBlockedClaims } from '../compliance/claims';
import type { Evidence } from '../reports/analysis';
import { draftReason } from './reasons';

export interface DActor { orgId: string; userId: string; role: Role; meta?: { ip?: string | null } }
export class DisputeError extends UserError {}

export interface NewDispute {
  clientId: string; tradelineId?: string | null; findingId?: string | null; category: string; reason: string; fields?: string[];
  bureau?: Bureau | null; recipientName?: string; assignedTo?: string | null; parentId?: string | null; round?: number;
}

export async function createDispute(db: Db, actor: DActor, d: NewDispute): Promise<string> {
  if (!can(actor.role, 'disputes:write')) throw new PermissionError('disputes:write');
  const cat = CATEGORIES[d.category];
  if (!cat) throw new DisputeError('Choose a dispute category.');
  const reason = d.reason.trim();
  if (reason.length < 10) throw new DisputeError('Explain the reason in at least a sentence (10+ characters).');

  const client = await db.row<{ id: string; assigned_to: string | null }>('select id, assigned_to from public.clients where id = $1', [d.clientId]);
  if (!client) throw new DisputeError('Client not found.');

  let label = '';
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
  opts: { receivedOn?: string | null; extended?: boolean; note?: string; sentMethod?: 'certified_mail' | 'first_class_mail' | 'portal' | 'manual'; tracking?: string | null } = {},
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
    const letter = await db.row<{ id: string }>("select id from public.letters where dispute_id = $1 and status in ('approved', 'sent') order by created_at desc limit 1", [id]);
    if (!letter) throw new DisputeError('This dispute has no approved letter. A person must approve the letter before it can be submitted.');
    const consents = await db.rows<{ kind: string; signed_at: string; revoked_at: string | null }>('select kind, signed_at, revoked_at from public.client_consents where client_id = $1', [d.client_id]);
    const cs = consentStatus(consents);
    if (cs.missing.length) throw new DisputeError(`Required consents are missing for this client: ${cs.missing.join(', ').replace(/_/g, ' ')}. Record them before submitting.`);
    const received = opts.receivedOn ? new Date(`${opts.receivedOn}T12:00:00Z`) : new Date();
    const submitted = new Date();
    set('submitted_at', submitted);
    set('deadline_extended', !!opts.extended);
    set('due_at', responseDueDate(received, !!opts.extended));
    await db.run("update public.letters set status = 'sent', sent_at = now(), sent_method = $2, tracking_number = $3 where id = $1 and status = 'approved'", [letter.id, opts.sentMethod ?? 'certified_mail', opts.tracking ?? null]);
    await db.run("update public.clients set stage = 'disputing', status = case when status in ('lead','onboarding') then 'active' else status end where id = $1", [d.client_id]);
  }
  await db.run(`update public.disputes set ${sets.join(', ')} where id = $1`, p);
  if (opts.note) await db.run('insert into public.dispute_events (org_id, dispute_id, actor_id, kind, note) values ($1, $2, $3, $4, $5)', [actor.orgId, id, actor.userId, 'note', opts.note.slice(0, 2000)]);
  await logEvent(db, actor, d.client_id, 'dispute_status', `Dispute “${d.item_label}” → ${STATUS_LABEL[to]}`, { dispute_id: id });
  await audit(db, { orgId: actor.orgId, actorId: actor.userId, action: `dispute.${to}`, entityType: 'dispute', entityId: id, ip: actor.meta?.ip, meta: { from: d.status, to } });
  await fireTrigger(db, actor, 'dispute_status_changed', { type: 'dispute', id }, { toStatus: to });
}

export async function recordResponse(db: Db, actor: DActor, id: string, r: { outcome: Outcome; notes?: string; receivedOn?: string }): Promise<void> {
  if (!can(actor.role, 'disputes:write')) throw new PermissionError('disputes:write');
  const d = await db.row<{ status: DisputeStatus; client_id: string }>('select status, client_id from public.disputes where id = $1 for update', [id]);
  if (!d) throw new DisputeError('Dispute not found.');
  if (!['submitted', 'under_investigation', 'response_received'].includes(d.status)) throw new DisputeError('Only a submitted dispute can have a response recorded.');
  await db.run(
    `update public.disputes set outcome = $2, outcome_notes = $3, response_at = $4, status = 'response_received' where id = $1`,
    [id, r.outcome, r.notes?.slice(0, 4000) ?? null, r.receivedOn ? `${r.receivedOn}T12:00:00Z` : new Date()],
  );
  await db.run('insert into public.dispute_events (org_id, dispute_id, actor_id, kind, note, client_visible) values ($1, $2, $3, $4, $5, true)', [actor.orgId, id, actor.userId, 'outcome', `Outcome recorded: ${r.outcome.replace(/_/g, ' ')}`]);
  await logEvent(db, actor, d.client_id, 'dispute_outcome', `Dispute outcome recorded: ${r.outcome.replace(/_/g, ' ')}`, { dispute_id: id });
  await audit(db, { orgId: actor.orgId, actorId: actor.userId, action: 'dispute.outcome', entityType: 'dispute', entityId: id, ip: actor.meta?.ip, meta: { outcome: r.outcome } });
  await fireTrigger(db, actor, 'dispute_status_changed', { type: 'dispute', id }, { toStatus: 'response_received' });
}

/**
 * Another round against the same item. Because repeating an identical dispute with nothing new can be treated as
 * frivolous, the next round must state what is NEW (information or evidence) and differ from the previous reason.
 */
export async function startNextRound(db: Db, actor: DActor, id: string, input: { reason: string; newInformation: string }): Promise<string> {
  if (!can(actor.role, 'disputes:write')) throw new PermissionError('disputes:write');
  const prev = await db.row<{ client_id: string; tradeline_id: string | null; category: string; reason: string; bureau: Bureau | null; fields: string[]; round: number; status: DisputeStatus; recipient_name: string; assigned_to: string | null }>(
    'select client_id, tradeline_id, category, reason, bureau, fields, round, status, recipient_name, assigned_to from public.disputes where id = $1', [id]);
  if (!prev) throw new DisputeError('Dispute not found.');
  if (prev.status !== 'resolved') throw new DisputeError('Resolve the current round before starting the next one.');
  if (input.newInformation.trim().length < 15) throw new DisputeError('Describe the new information or evidence that justifies another round.');
  if (input.reason.trim().toLowerCase() === prev.reason.trim().toLowerCase()) throw new DisputeError('The reason is identical to the previous round. Explain what is different this time.');
  const newId = await createDispute(db, actor, {
    clientId: prev.client_id, tradelineId: prev.tradeline_id, category: prev.category, bureau: prev.bureau, recipientName: prev.recipient_name, fields: prev.fields,
    reason: `${input.reason.trim()}\n\nNew information since my previous request: ${input.newInformation.trim()}`, parentId: id, round: prev.round + 1, assignedTo: prev.assigned_to,
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
