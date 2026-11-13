import type { Db } from '../db';
import { UserError } from '../errors';
import { audit } from '../audit';
import { findBlockedClaims } from '../compliance/claims';
import { logEvent } from '../crm';
import { can, PermissionError, type Role } from '../rbac';
import { buildValues, mergeTemplate, unresolvedPlaceholders, type LetterContext } from './render';
import { kindForWorkflow, templateByKey, templatesFor, type LetterKind } from './templates';

export interface LActor { orgId: string; userId: string; role: Role; meta?: { ip?: string | null } }
export class LetterError extends UserError {}

type ClientRow = { id: string; full_name: string; preferred_language: 'en' | 'es'; address: LetterContext['client']['address']; ssn_last4: string | null };

export async function createLetter(
  db: Db, actor: LActor,
  input: { clientId: string; disputeId?: string | null; templateKey?: string; kind?: LetterKind; reasonOverride?: string; includeSsnLast4?: boolean; orgName?: string; recipientName?: string; recipientAddress?: string },
): Promise<string> {
  if (!can(actor.role, 'letters:write')) throw new PermissionError('letters:write');
  const client = await db.row<ClientRow>('select id, full_name, preferred_language, address, ssn_last4 from public.clients where id = $1', [input.clientId]);
  if (!client) throw new LetterError('Client not found.');

  let dispute: LetterContext['dispute'] = null;
  let kind: LetterKind = input.kind ?? 'bureau_dispute';
  let enclosures: string[] = [];
  if (input.disputeId) {
    const d = await db.row<{ client_id: string; item_label: string; bureau: string | null; recipient_name: string; reason: string; fields: string[]; round: number; workflow: string; tradeline_id: string | null; parent_dispute_id: string | null }>(
      'select client_id, item_label, bureau, recipient_name, reason, fields, round, workflow, tradeline_id, parent_dispute_id from public.disputes where id = $1', [input.disputeId]);
    if (!d || d.client_id !== input.clientId) throw new LetterError('That dispute does not belong to this client.');
    const tl = d.tradeline_id ? await db.row<{ creditor_name: string; account_last4: string | null }>('select creditor_name, account_last4 from public.tradelines where id = $1', [d.tradeline_id]) : null;
    const prior = d.parent_dispute_id ? await db.row<{ submitted_at: string | null }>('select submitted_at from public.disputes where id = $1', [d.parent_dispute_id]) : null;
    enclosures = (await db.rows<{ label: string }>('select label from public.dispute_evidence where dispute_id = $1 order by created_at', [input.disputeId])).map((e) => e.label);
    dispute = { item_label: d.item_label, bureau: d.bureau, recipient_name: input.recipientName || d.recipient_name, reason: input.reasonOverride ?? d.reason, fields: d.fields, round: d.round, tradeline: tl, prior_submitted_at: prior?.submitted_at };
    if (!input.templateKey && !input.kind) kind = kindForWorkflow(d.workflow);
  }
  let tpl = input.templateKey ? templateByKey(input.templateKey) : templatesFor(kind, client.preferred_language);
  if (input.templateKey?.startsWith('org:')) {
    const o = await db.row<{ id: string; name: string; kind: LetterKind; language: 'en' | 'es'; body: string }>('select id, name, kind, language, body from public.letter_templates where id = $1 and active', [input.templateKey.slice(4)]);
    if (o) tpl = { key: `org:${o.id}`, kind: o.kind, language: o.language, name: o.name, description: '', recipient: 'bureau', body: o.body };
  }
  if (!tpl) throw new LetterError('Template not found.');
  if (tpl.kind === 'validation_request' && dispute) {
    const isCollection = input.disputeId ? await db.row("select 1 from public.disputes d join public.tradelines t on t.id = d.tradeline_id where d.id = $1 and t.item_type = 'collection'", [input.disputeId]) : null;
    if (!isCollection) throw new LetterError('Debt validation requests apply to collection accounts only. This item is not marked as a collection.');
  }

  const values = buildValues({ client, language: tpl.language, dispute, enclosures, includeSsnLast4: input.includeSsnLast4, orgName: input.orgName, recipientAddress: input.recipientAddress });
  if (!dispute) { values.reason = input.reasonOverride ?? '[REASON NEEDED]'; if (input.recipientName) values.recipient_name = input.recipientName; }
  const body = mergeTemplate(tpl.body, values);

  const letter = await db.row<{ id: string }>(
    `insert into public.letters (org_id, client_id, dispute_id, template_key, kind, title, recipient_name, recipient_address, language, created_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id`,
    [actor.orgId, input.clientId, input.disputeId ?? null, tpl.key, tpl.kind, `${tpl.name.split(' — ')[0]}${dispute ? ` — ${dispute.item_label}` : ''}`.slice(0, 200), values.recipient_name, values.recipient_address, tpl.language, actor.userId],
  );
  await db.run("insert into public.letter_versions (org_id, letter_id, version, body, source, author_id, change_note) values ($1,$2,1,$3,'template',$4,'Generated from template')", [actor.orgId, letter!.id, body, actor.userId]);
  await logEvent(db, actor, input.clientId, 'letter_created', `Letter drafted: ${tpl.name.split(' — ')[0]}`, { letter_id: letter!.id });
  await audit(db, { orgId: actor.orgId, actorId: actor.userId, action: 'letter.created', entityType: 'letter', entityId: letter!.id, ip: actor.meta?.ip, meta: { template: tpl.key } });
  return letter!.id;
}

export async function saveVersion(db: Db, actor: LActor, letterId: string, body: string, source: 'manual_edit' | 'ai_draft' = 'manual_edit', note?: string): Promise<number> {
  if (!can(actor.role, 'letters:write')) throw new PermissionError('letters:write');
  const l = await db.row<{ status: string; current_version: number; client_id: string }>('select status, current_version, client_id from public.letters where id = $1 for update', [letterId]);
  if (!l) throw new LetterError('Letter not found.');
  if (l.status === 'sent' || l.status === 'void') throw new LetterError('A sent or voided letter cannot be edited. Create a new letter instead.');
  const text = body.replace(/\r\n?/g, '\n').trim() + '\n';
  if (text.length < 20) throw new LetterError('The letter is empty.');
  const latest = await db.row<{ body: string }>('select body from public.letter_versions where letter_id = $1 and version = $2', [letterId, l.current_version]);
  if (latest && latest.body === text) return l.current_version; // nothing changed
  const v = l.current_version + 1;
  await db.run('insert into public.letter_versions (org_id, letter_id, version, body, source, author_id, change_note) values ($1,$2,$3,$4,$5,$6,$7)', [actor.orgId, letterId, v, text, source, actor.userId, note?.slice(0, 300) ?? null]);
  // Editing invalidates any earlier approval: what gets mailed must be exactly what a person approved.
  await db.run("update public.letters set current_version = $2, status = 'draft', approved_by = null, approved_at = null where id = $1", [letterId, v]);
  await audit(db, { orgId: actor.orgId, actorId: actor.userId, action: 'letter.edited', entityType: 'letter', entityId: letterId, ip: actor.meta?.ip, meta: { version: v, source } });
  return v;
}

export async function currentBody(db: Db, letterId: string): Promise<{ body: string; version: number } | null> {
  const r = await db.row<{ body: string; version: number }>(
    'select v.body, v.version from public.letters l join public.letter_versions v on v.letter_id = l.id and v.version = l.current_version where l.id = $1', [letterId]);
  return r;
}

/** Problems that must be fixed before a person can approve. */
export function approvalBlockers(body: string): string[] {
  const out: string[] = [];
  const un = unresolvedPlaceholders(body);
  if (un.length) out.push(`Fill in or remove: ${un.join(', ')}`);
  for (const c of findBlockedClaims(body)) out.push(`Prohibited claim “${c.excerpt}” — ${c.why}`);
  return out;
}

export async function setLetterStatus(db: Db, actor: LActor, letterId: string, to: 'pending_approval' | 'approved' | 'draft' | 'void'): Promise<void> {
  const l = await db.row<{ status: string; client_id: string; created_by: string | null; title: string }>('select status, client_id, created_by, title from public.letters where id = $1 for update', [letterId]);
  if (!l) throw new LetterError('Letter not found.');
  if (l.status === 'sent' || l.status === 'void') throw new LetterError('This letter is final.');
  const cur = await currentBody(db, letterId);
  if (to === 'pending_approval') {
    if (!can(actor.role, 'letters:write')) throw new PermissionError('letters:write');
    const b = approvalBlockers(cur?.body ?? '');
    if (b.length) throw new LetterError(b.join(' · '));
  }
  if (to === 'approved') {
    if (!can(actor.role, 'letters:approve')) throw new PermissionError('letters:approve');
    if (l.status !== 'pending_approval') throw new LetterError('Send the letter for approval first.');
    const b = approvalBlockers(cur?.body ?? '');
    if (b.length) throw new LetterError(b.join(' · '));
  }
  if (to === 'void' && !can(actor.role, 'letters:write')) throw new PermissionError('letters:write');
  await db.run(
    `update public.letters set status = $2, approved_by = case when $2 = 'approved' then $3::uuid else null end, approved_at = case when $2 = 'approved' then now() else null end where id = $1`,
    [letterId, to, actor.userId],
  );
  await logEvent(db, actor, l.client_id, 'letter_status', `Letter “${l.title}” → ${to.replace(/_/g, ' ')}`, { letter_id: letterId });
  await audit(db, { orgId: actor.orgId, actorId: actor.userId, action: `letter.${to}`, entityType: 'letter', entityId: letterId, ip: actor.meta?.ip, meta: { version: cur?.version ?? 0 } });
}

/** Records that a person mailed/delivered an approved letter. The app never sends correspondence by itself. */
/** The date a letter was sent, as typed by staff: a real calendar date, not in the future and not absurdly old. */
export function checkSentOn(sentOn: string | null | undefined, today = new Date()): string {
  const t = today.toISOString().slice(0, 10);
  if (!sentOn) return t;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(sentOn) || Number.isNaN(new Date(`${sentOn}T00:00:00Z`).getTime())) throw new LetterError('Enter the date it was sent as a valid date.');
  if (sentOn > t) throw new LetterError('The sent date cannot be in the future.');
  if (new Date(`${t}T00:00:00Z`).getTime() - new Date(`${sentOn}T00:00:00Z`).getTime() > 366 * 86_400_000) throw new LetterError('The sent date is more than a year ago. Check it.');
  return sentOn;
}

export async function markSent(db: Db, actor: LActor, letterId: string, method: 'certified_mail' | 'first_class_mail' | 'portal' | 'manual', tracking?: string, sentOn?: string | null): Promise<void> {
  if (!can(actor.role, 'letters:write')) throw new PermissionError('letters:write');
  const l = await db.row<{ status: string; client_id: string }>('select status, client_id from public.letters where id = $1 for update', [letterId]);
  if (!l) throw new LetterError('Letter not found.');
  if (l.status !== 'approved') throw new LetterError('Only an approved letter can be marked as sent.');
  const on = checkSentOn(sentOn);
  // Recorded by a person: delivery_source stays 'staff_recorded'. Only a carrier integration may ever set 'carrier_confirmed'.
  await db.run("update public.letters set status = 'sent', sent_at = now(), sent_on = $4, sent_method = $2, tracking_number = $3, delivery_source = 'staff_recorded', sent_recorded_by = $5 where id = $1", [letterId, method, tracking?.trim().slice(0, 80) || null, on, actor.userId]);
  await logEvent(db, actor, l.client_id, 'letter_sent', `Letter marked as sent (${method.replace(/_/g, ' ')})`, { letter_id: letterId });
  await audit(db, { orgId: actor.orgId, actorId: actor.userId, action: 'letter.sent', entityType: 'letter', entityId: letterId, ip: actor.meta?.ip, meta: { method } });
}
