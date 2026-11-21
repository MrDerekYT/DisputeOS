import type { Db } from '../db';
import { getEnv } from '../env';
import { UserError } from '../errors';
import { dayInZone } from '../util';
import { isRealDay } from '../real-day';
import { audit } from '../audit';
import { findBlockedClaims } from '../compliance/claims';
import { logEvent } from '../crm';
import { can, PermissionError, type Role } from '../rbac';
import { buildValues, longDate, mergeTemplate, unresolvedPlaceholders } from './render';
import { buildBrief, contextFor, disputeLetterKey } from './brief';
import { loadBriefRecord } from './brief-load';
import { CITES_809B, missingFacts, missingFactsForOwnTemplate } from './library';
import { specialtyTemplateKey, templateByKey, templatesFor, type LetterKind } from './templates';
import { parseAgencyItem, specialtyAgency } from '../credit/agencies';
import { procedureDescriptionDue } from '../disputes/clock';
import { loadServiceStatus, sentDateRefusal, serviceRefusal } from '../agreements';
import { CONTENT_KINDS, contentIssues, SPECIFICITY_KINDS, specificityIssues, statesEnclosures, type SpecificityInput } from './specificity';

export interface LActor { orgId: string; userId: string; role: Role; meta?: { ip?: string | null } }
export class LetterError extends UserError {}
/** 15 U.S.C. § 1679b(a)(1): once the client has confirmed the item is reported accurately, no further letter about it is drafted or approved. */
export const CONFIRMED_ACCURATE = 'The client confirmed this item is reported accurately, so no further letter or round is offered for it.';
/** Said when someone tries to draft from an agency template that is marked as written in Spanish. */
export const SPANISH_TEMPLATE = 'This template is written in Spanish. Letters go to US bureaus, creditors and collectors and are written in English: open it under Letters, Templates, put it into English and mark it as English, or pick another letter.';

/**
 * Drafts a letter from a template through the normal pipeline: a DRAFT that a person edits, sends for approval and
 * mails. Letters are English only, whatever language the client reads the portal in.
 *
 * Everything the letter states comes from the letter brief (./brief.ts), assembled from what is on file for the client
 * and the dispute: the account as the bureau reports it, the earlier round, what is enclosed. With a dispute and no
 * template named, the letter written for the dispute's situation is used (disputeLetterKey), falling back to the
 * general letter of the dispute's kind when the facts that situation letter rests on are not on file. A template named
 * by the caller is never swapped that way: if its facts are missing, or it was not written for this dispute, the letter
 * is refused. An agency's own template is held to the same rules as the letter it was copied from, and is refused
 * while its own text still claims a right the built-in letters no longer claim (missingFactsForOwnTemplate).
 */
export async function createLetter(
  db: Db, actor: LActor,
  input: { clientId: string; disputeId?: string | null; templateKey?: string; kind?: LetterKind; reasonOverride?: string; includeSsnLast4?: boolean; orgName?: string; recipientName?: string; recipientAddress?: string },
): Promise<string> {
  if (!can(actor.role, 'letters:write')) throw new PermissionError('letters:write');
  const record = await loadBriefRecord(db, input.clientId, input.disputeId ?? null);
  if (!record) throw new LetterError('Client not found.');
  if (input.disputeId && !record.dispute) throw new LetterError('That dispute does not belong to this client.');
  if (record.dispute?.client_confirmed_accurate) throw new LetterError(CONFIRMED_ACCURATE);
  const brief = buildBrief(record, { reasonOverride: input.reasonOverride, recipientName: input.recipientName, recipientAddress: input.recipientAddress, includeSsnLast4: input.includeSsnLast4, orgName: input.orgName });
  const base = brief.context;
  const dispute = base.dispute ?? null;

  // Which letter. A specialty agency dispute uses the template for that agency's kind of file: the picker's bureau and
  // specialty entries are written for one kind of recipient, so choosing either for a specialty dispute gives the right one.
  const agency = specialtyAgency(dispute?.agency);
  const picked = input.templateKey ? templateByKey(input.templateKey) : undefined;
  let tpl = dispute && !input.templateKey && !input.kind ? templateByKey(disputeLetterKey(brief) ?? '')
    : agency && (picked?.key === 'bureau_dispute_en' || picked?.kind === 'specialty_dispute' || (!input.templateKey && input.kind === 'specialty_dispute')) ? templateByKey(specialtyTemplateKey(agency.kind))
      : input.templateKey ? picked : templatesFor(input.kind ?? 'bureau_dispute');
  // The built-in letter whose facts this one rests on: itself, or for an agency's own template the letter it was copied
  // from (failing that, the general letter of its kind).
  let gateKey = tpl?.key ?? '';
  let own: { baseKey: string | null; fallbackKey: string; kind: LetterKind; body: string } | null = null;
  if (input.templateKey?.startsWith('org:')) {
    const o = await db.row<{ id: string; name: string; kind: LetterKind; body: string; base_key: string | null; language: string }>(
      'select id, name, kind, body, base_key, language from public.letter_templates where id = $1 and active', [input.templateKey.slice(4)]);
    // Letters are English only. A template saved in Spanish before that was decided is kept for the agency to translate, not drafted from.
    if (o && o.language !== 'en') throw new LetterError(SPANISH_TEMPLATE);
    tpl = o ? { key: `org:${o.id}`, kind: o.kind, language: 'en', name: o.name, description: '', recipient: 'bureau', body: o.body } : undefined;
    if (o) {
      own = { baseKey: o.base_key, fallbackKey: templatesFor(o.kind)?.key ?? `org:${o.id}`, kind: o.kind, body: o.body };
      gateKey = own.baseKey && templateByKey(own.baseKey) ? own.baseKey : own.fallbackKey;
    }
  }
  if (!tpl) throw new LetterError('Template not found.');
  const missing = own ? missingFactsForOwnTemplate(own, base) : missingFacts(tpl.key, base);
  if (missing.length) throw new LetterError(missing.join(' '));

  // What this letter encloses and the optional paragraphs the brief adds to it (contextFor). A dispute letter to a
  // bureau or a specialty agency always says what is in the envelope, or an explicit "none".
  const context = contextFor(brief, { key: gateKey, kind: tpl.kind });
  const values = buildValues(context);
  if (!dispute) { values.reason = input.reasonOverride ?? '[REASON NEEDED]'; if (input.recipientName) values.recipient_name = input.recipientName; }
  // A follow-up or a reply about a result is about THIS dispute. An agency's own copy made from the earlier wording
  // prints {{prior_date}}, which on a later round is the round before: it gets this dispute's sent date instead.
  if (tpl.kind === 'follow_up' || tpl.kind === 'investigation_response') values.prior_date = values.dispute_date!;
  // The letters written for a debt collector (a validation request, a collector communication) never carry the last
  // four digits of the SSN, whatever was ticked on the form. A specialty agency gets the identification lines its own
  // page asks for ({{agency_identity_text}}) and not this line on top of them.
  if (tpl.kind === 'validation_request' || tpl.kind === 'collector_communication' || tpl.kind === 'specialty_dispute' || agency) values.ssn_last4_text = '';
  let body = mergeTemplate(tpl.body, values);
  // An agency's own template may have no {{enclosures}} field. The section is added at the end rather than blocking the letter later.
  if (context.enclosuresNone && !statesEnclosures(body)) body = `${body.trimEnd()}\n\n${values.enclosures}`;

  const letter = await db.row<{ id: string }>(
    `insert into public.letters (org_id, client_id, dispute_id, template_key, kind, title, recipient_name, recipient_address, language, created_by, checks_version)
     values ($1,$2,$3,$4,$5,$6,$7,$8,'en',$9,${LETTER_CHECKS_VERSION}) returning id`,
    [actor.orgId, input.clientId, input.disputeId ?? null, tpl.key, tpl.kind, `${tpl.name.split(' — ')[0]}${dispute ? ` — ${dispute.item_label}` : ''}`.slice(0, 200), values.recipient_name, values.recipient_address, actor.userId],
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

/**
 * Stamped on every letter created from now on (letters.checks_version, migration 0019). A letter drafted before the
 * specificity check existed has no stamp and is held only to the checks it was written under: it was generated without
 * an enclosures line when there was no evidence, and would otherwise be refused until someone edited it by hand.
 */
export const LETTER_CHECKS_VERSION = 1;

/**
 * Everything that blocks approval of one letter: the text checks above and, for a dispute letter to a credit bureau or
 * a specialty agency created since the check was introduced, the specificity check (which account, what about it, why,
 * and what is enclosed). A request to update a paid account and a personal information correction are held to a lighter
 * check: the section a person fills in has to state the payment, or list the entries.
 */
export async function letterBlockers(db: Db, letterId: string, body: string): Promise<string[]> {
  const out = approvalBlockers(body);
  const s = await specificityInputFor(db, letterId);
  if (s) out.push(...specificityIssues({ ...s, body }).map((i) => i.message));
  const c = await db.row<{ kind: string; checks_version: number | null; reason: string | null; creditor_name: string | null; account_last4: string | null }>(
    `select l.kind, l.checks_version, d.reason, t.creditor_name, t.account_last4
       from public.letters l left join public.disputes d on d.id = l.dispute_id left join public.tradelines t on t.id = d.tradeline_id where l.id = $1`, [letterId]);
  if (c && CONTENT_KINDS.includes(c.kind) && (c.checks_version ?? 0) >= LETTER_CHECKS_VERSION) {
    out.push(...contentIssues({ kind: c.kind, body, reason: c.reason ?? '', account: { name: c.creditor_name, reference: c.account_last4 } }).map((i) => i.message));
  }
  return out;
}

/**
 * What the specificity check reads for one letter, apart from its text. Null when the letter is not held to the check:
 * it is not a dispute letter to a bureau or a specialty agency, or it was drafted before the check existed.
 */
export async function specificityInputFor(db: Db, letterId: string): Promise<Omit<SpecificityInput, 'body'> | null> {
  const d = await db.row<{ kind: string; checks_version: number | null; category: string; reason: string; fields: string[]; agency_item: unknown; creditor_name: string | null; account_last4: string | null }>(
    `select l.kind, l.checks_version, d.category, d.reason, d.fields, d.agency_item, t.creditor_name, t.account_last4
       from public.letters l join public.disputes d on d.id = l.dispute_id left join public.tradelines t on t.id = d.tradeline_id
      where l.id = $1 and d.target_type in ('bureau', 'agency')`, [letterId]);
  if (!d || !SPECIFICITY_KINDS.includes(d.kind) || (d.checks_version ?? 0) < LETTER_CHECKS_VERSION) return null;
  const item = parseAgencyItem(d.agency_item);
  const account = item ? { name: item.name, reference: item.reference ?? null } : d.creditor_name ? { name: d.creditor_name, reference: d.account_last4 } : null;
  return { category: d.category, reason: d.reason, fields: d.fields, account };
}

const say = (day: string) => longDate(new Date(`${day}T00:00:00Z`));

/**
 * What a letter rests on that has changed since it was drafted, as a refusal, or null. A draft can wait while the file
 * moves on: a response is recorded, a collector's 30 days run out, a document is rejected, the client confirms the item
 * is reported accurately. So the checks createLetter ran are run again on the file as it is now (missingFacts for the
 * letter's template; for an agency's own template, missingFactsForOwnTemplate), and a validation request whose text
 * cites Section 809(b) needs a collector notice with an open validation period on file for the debt. Run when a letter
 * is sent for approval and when it is approved; not when it is recorded as sent (markSent), which records what happened.
 */
async function changedSinceDrafted(db: Db, letterId: string, body: string): Promise<string | null> {
  const l = await db.row<{ client_id: string; dispute_id: string | null; template_key: string | null; kind: LetterKind }>(
    'select client_id, dispute_id, template_key, kind from public.letters where id = $1', [letterId]);
  if (!l) return null;
  const record = l.dispute_id ? await loadBriefRecord(db, l.client_id, l.dispute_id) : null;
  if (record?.dispute?.client_confirmed_accurate) return CONFIRMED_ACCURATE;
  const brief = record?.dispute ? buildBrief(record) : null;
  if (brief) {
    let missing: string[] = [];
    if (l.template_key?.startsWith('org:')) {
      // The agency's template as it is now, active or not: the letter was drafted from it.
      const o = await db.row<{ kind: LetterKind; body: string; base_key: string | null }>('select kind, body, base_key from public.letter_templates where id = $1', [l.template_key.slice(4)]);
      const fallbackKey = templatesFor(o?.kind ?? l.kind)?.key ?? l.template_key;
      missing = o ? missingFactsForOwnTemplate({ baseKey: o.base_key, fallbackKey, kind: o.kind, body: o.body }, brief.context) : missingFacts(fallbackKey, brief.context, l.kind);
    } else if (l.template_key && templateByKey(l.template_key)) {
      missing = missingFacts(l.template_key, brief.context);
    }
    if (missing.length) return `This letter no longer fits what is on file. ${missing.join(' ')} Draft the letter again.`;
  }
  if (l.kind === 'validation_request' && CITES_809B.test(body) && !brief?.context.facts?.notice?.open) {
    const n = brief?.circumstances.notice;
    const why = n ? `the validation period for the notice ${n.kind} on ${say(n.date)} generally ended on ${say(n.endsOn)}`
      : brief?.circumstances.unlinkedNotice ? 'the notice recorded by this collector’s name could be about another of the client’s debts with that collector, so it is not used for this one'
        : 'no notice with an open validation period is on file for this debt';
    return `This letter cites Section 809(b) of the Fair Debt Collection Practices Act, which applies to a request sent within 30 days of the collector’s notice, and ${why}. Draft the letter again.`;
  }
  return null;
}

export async function setLetterStatus(db: Db, actor: LActor, letterId: string, to: 'pending_approval' | 'approved' | 'draft' | 'void'): Promise<void> {
  const l = await db.row<{ status: string; client_id: string; created_by: string | null; title: string }>('select status, client_id, created_by, title from public.letters where id = $1 for update', [letterId]);
  if (!l) throw new LetterError('Letter not found.');
  if (l.status === 'sent' || l.status === 'void') throw new LetterError('This letter is final.');
  const cur = await currentBody(db, letterId);
  if (to === 'pending_approval') {
    if (!can(actor.role, 'letters:write')) throw new PermissionError('letters:write');
    const changed = await changedSinceDrafted(db, letterId, cur?.body ?? '');
    if (changed) throw new LetterError(changed);
    const b = await letterBlockers(db, letterId, cur?.body ?? '');
    if (b.length) throw new LetterError(b.join(' · '));
  }
  if (to === 'approved') {
    if (!can(actor.role, 'letters:approve')) throw new PermissionError('letters:approve');
    if (l.status !== 'pending_approval') throw new LetterError('Send the letter for approval first.');
    const changed = await changedSinceDrafted(db, letterId, cur?.body ?? '');
    if (changed) throw new LetterError(changed);
    const b = await letterBlockers(db, letterId, cur?.body ?? '');
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

/**
 * Today's calendar date (YYYY-MM-DD) where the agency works (APP_TIMEZONE, default America/New_York) — not the UTC
 * date, which is already "tomorrow" every US evening. The one definition of "today" on the server: sent-on dates, task
 * due days (dueDay) and the analytics overdue count all use this zone.
 */
export function businessToday(now = new Date(), tz: string = getEnv().APP_TIMEZONE): string {
  return dayInZone(tz, now);
}

/** Records that a person mailed/delivered an approved letter. The app never sends correspondence by itself. */
/** The date a letter was sent, as typed by staff: a real calendar date, not in the future and not absurdly old. */
export function checkSentOn(sentOn: string | null | undefined, today = new Date()): string {
  const t = businessToday(today);
  if (!sentOn) return t;
  if (!isRealDay(sentOn)) throw new LetterError('Enter the date it was sent as a valid date.');
  // "Future" is judged against the later of the agency's date and the UTC date, so nobody west or east of the
  // configured zone is refused their own today.
  const utc = today.toISOString().slice(0, 10);
  if (sentOn > (utc > t ? utc : t)) throw new LetterError('The sent date cannot be in the future.');
  if (new Date(`${t}T00:00:00Z`).getTime() - new Date(`${sentOn}T00:00:00Z`).getTime() > 366 * 86_400_000) throw new LetterError('The sent date is more than a year ago. Check it.');
  return sentOn;
}

/**
 * Records that a person mailed an approved letter: a stand-alone letter, or a follow-up or method-of-verification
 * letter on a dispute already submitted (the dispute's first letter is recorded through transitionDispute). Every one
 * of them is a service to the client, so the same gate applies as to a submission (src/lib/agreements.ts): the
 * statement, the service agreement and the authorization in force (15 U.S.C. § 1679d(a)(1); an agreement the client
 * cancelled is not in force), the cancellation period over (§ 1679d(a)(2)), and a sent date after that period.
 * A personal workspace has no such gate.
 */
export async function markSent(db: Db, actor: LActor, letterId: string, method: 'certified_mail' | 'first_class_mail' | 'portal' | 'manual', tracking?: string, sentOn?: string | null): Promise<void> {
  if (!can(actor.role, 'letters:write')) throw new PermissionError('letters:write');
  const l = await db.row<{ status: string; client_id: string; kind: string }>('select status, client_id, kind from public.letters where id = $1 for update', [letterId]);
  if (!l) throw new LetterError('Letter not found.');
  if (l.status !== 'approved') throw new LetterError('Only an approved letter can be marked as sent.');
  const service = await loadServiceStatus(db, l.client_id);
  const refused = service ? serviceRefusal(service, 'send') : null;
  if (refused) throw new LetterError(refused);
  const on = checkSentOn(sentOn);
  const early = service ? sentDateRefusal(service, on, 'send') : null;
  if (early) throw new LetterError(early);
  // Recorded by a person: delivery_source stays 'staff_recorded'. Only a carrier integration may ever set 'carrier_confirmed'.
  await db.run("update public.letters set status = 'sent', sent_at = now(), sent_on = $4, sent_method = $2, tracking_number = $3, delivery_source = 'staff_recorded', sent_recorded_by = $5 where id = $1", [letterId, method, tracking?.trim().slice(0, 80) || null, on, actor.userId]);
  // 15 U.S.C. § 1681i(a)(7): the description of the reinvestigation procedure is due 15 days after the agency receives the
  // request. Until a receipt date is recorded (recordProcedureDates) the 15 days are counted from the day it was sent.
  if (l.kind === 'method_of_verification') await db.run('update public.letters set reply_due_on = $2 where id = $1', [letterId, procedureDescriptionDue(on)]);
  await logEvent(db, actor, l.client_id, 'letter_sent', `Letter marked as sent (${method.replace(/_/g, ' ')})`, { letter_id: letterId });
  await audit(db, { orgId: actor.orgId, actorId: actor.userId, action: 'letter.sent', entityType: 'letter', entityId: letterId, ip: actor.meta?.ip, meta: { method } });
}
