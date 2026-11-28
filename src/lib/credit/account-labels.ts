/**
 * Account labels kept on file (tradelines.kind_label, migration 0034): a person's label, and AI suggestions for the
 * accounts whose words the rules cannot read (./account-kind.ts says which label is shown and which one counts).
 *
 * AI here is a helper with a short leash:
 *  - It is asked only about accounts the rules left "Not labelled", at most AI_LABEL_LIMIT at a time. An account entry
 *    it was asked about is not sent again; the same account on a newer report can be.
 *  - It is shown the account's own words: company and original creditor, account type, status, payment status,
 *    payment history and remarks. Before they are sent, amounts and long numbers are replaced, remarks about who holds
 *    the account (responsibility, owner, joint holders) are left out, the client's own name is masked, and the text
 *    goes through scrubPii. No address, date of birth or account number is ever part of it.
 *  - It must quote whole words of that account, not negated ("paid" from "Not paid" is refused), that show the kind
 *    (./account-kind.ts wordsSupport). A company name can carry only "collection".
 *  - A suggestion is shown as one, with its words, and does nothing until a person confirms it: no finding, no
 *    pre-chosen collector notice, no suggested dispute (confirmedLabel). AI never makes an account green: an answer of
 *    good standing is kept as a hint for a person to confirm.
 *  - It costs AI_COSTS.account_label credits per press, charged only when something it said is kept (withAiCredits).
 *    With no AI provider, nothing is sent and the page says so.
 */
import { withAiCredits, type AiCharge } from '../ai/credits';
import { getProvider, type AiProvider } from '../ai/provider';
import { audit } from '../audit';
import type { Ctx } from '../auth/context';
import { logEvent } from '../crm';
import type { Db } from '../db';
import { UserError } from '../errors';
import { can, PermissionError, type Role } from '../rbac';
import { scrubPii } from '../scrub';
import { accountLabel, ACCOUNT_KINDS, isStaffKind, KIND_META, wordsSupport, type AccountKind, type LabelField, type LabelInput, type StaffKind } from './account-kind';
import { syncCaseFindings } from './case-tools';
import { EXACT_KEY, kindLabelSql } from './kind-label-sql';

export interface LActor { orgId: string; userId: string; role: Role; meta?: { ip?: string | null } }

// ------------------------------------------------------------------------------------------------- a person's label

/**
 * A person says what an account is, for the lines it was shown with (one per bureau), or clears their label (null) so
 * the report's words decide again. The same account on the client's earlier reports gets the same answer, so a later
 * report does not bring back one that was changed. AI suggestions on those lines are replaced.
 */
export async function setAccountKind(db: Db, actor: LActor, clientId: string, ids: string[], kind: StaffKind | null): Promise<number> {
  if (!can(actor.role, 'reports:write')) throw new PermissionError('reports:write');
  if (!ids.length || ids.length > 6) throw new UserError('Choose an account.');
  if (kind !== null && !isStaffKind(kind)) throw new UserError('Choose a label.');
  // In the organization the person is working in: row-level security lets someone who is staff in two see both.
  const c = await db.row<{ id: string }>('select id from public.clients where id = $1 and org_id = $2', [clientId, actor.orgId]);
  if (!c) throw new UserError('That account does not belong to this client.');
  const mine = await db.rows<{ id: string; creditor_name: string; account_last4: string | null }>(
    'select id, creditor_name, account_last4 from public.tradelines where id = any($1::uuid[]) and client_id = $2 and org_id = $3', [ids, clientId, actor.orgId]);
  if (mine.length !== new Set(ids).size) throw new UserError('That account does not belong to this client.');
  const value = kind ? JSON.stringify({ kind, by: 'staff', at: new Date().toISOString(), user: actor.userId }) : null;
  // The same account on the client's other reports gets the same answer: by creditor and account number, or, for a
  // report that prints no number, by creditor and open date (the rule kindLabelSql carries a label by).
  const n = await db.run(
    `update public.tradelines u set kind_label = $3::jsonb
      where u.client_id = $2 and u.org_id = $4 and (u.id = any($1::uuid[]) or exists (
        select 1 from public.tradelines g where g.id = any($1::uuid[]) and g.client_id = $2 and g.match_key = u.match_key
           and (g.match_key ~ ${EXACT_KEY} or (g.date_opened is not null and g.date_opened = u.date_opened))))`,
    [ids, clientId, value, actor.orgId]);
  const who = `${mine[0]!.creditor_name}${mine[0]!.account_last4 ? ` ••${mine[0]!.account_last4}` : ''}`;
  await logEvent(db, actor, clientId, 'case_tools', kind ? `Account labelled: ${who} — ${KIND_META[kind].label}` : `Account label cleared: ${who}`);
  await audit(db, { orgId: actor.orgId, actorId: actor.userId, action: 'account.label', entityType: 'client', entityId: clientId, ip: actor.meta?.ip, meta: { kind, lines: n } });
  // The medical collection screen looks at collections; a label can make an account one, or stop it being one.
  await syncCaseFindings(db, actor, clientId);
  return n;
}

// ------------------------------------------------------------------------------------------------- AI suggestions

export const AI_LABEL_LIMIT = 30;

type AiLine = LabelInput & { id: string };
const AI_KINDS = ACCOUNT_KINDS as readonly string[];

const SYSTEM = [
  'You label accounts from a consumer credit report. For each account below, say what the report\'s own words show it is.',
  'Kinds: collection, charge_off, foreclosure, repossession, bankruptcy, settled, late (past due now), was_late (late payments in the past; current or closed now),',
  'negative (negative information of another kind), good (current, paid or paying as agreed, never late), no_negative (only neutral words such as open or closed), unknown.',
  'Rules:',
  '- Use only the words given for that account.',
  '- Copy, exactly, the words that show the kind. They must appear in that account\'s text.',
  '- A company name can show a collection only when the company is plainly a debt collector or debt buyer; then copy the name. A name never shows any other kind.',
  '- When the words do not show the kind, answer unknown.',
  'Answer with one line per account and nothing else: <reference>|<kind>|<words>',
].join('\n');

const FIELDS: [LabelField, string][] = [
  ['creditor_name', 'company'], ['original_creditor', 'original creditor'], ['account_type', 'account type'], ['account_status', 'status'],
  ['payment_status', 'payment status'], ['payment_history', 'payment history'], ['remarks', 'remarks'],
];
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Remarks about who holds the account name people ("Responsibility: Joint with ..."): never sent. */
const HOLDER_REMARK = /responsib|\bowner\b|\bjoint\b|co-?signer|co-?maker|authori[sz]ed user/i;

/** What a field says, as it is sent to the AI and as AI answers are checked against: the same text both times. */
function fieldText(t: AiLine, f: LabelField, mask: RegExp | null): string {
  let v = (((t as unknown as Record<string, unknown>)[f] as string | null | undefined) ?? '').replace(/\s+/g, ' ').trim();
  if (f === 'remarks') v = v.split(/\s+·\s+|;\s+/).filter((p) => p && !HOLDER_REMARK.test(p)).join(' · ');
  if (f !== 'creditor_name' && f !== 'original_creditor') v = v.replace(/\$\s?[\d,]+(?:\.\d{1,2})?/g, '[amount]').replace(/\b\d{5,}\b/g, '[number]');
  if (mask) v = v.replace(mask, '[name]');
  return scrubPii(v).slice(0, 300);
}
/** The client's own name, word by word (three letters or more), to be masked wherever it appears. */
const nameMask = (name: string | null | undefined): RegExp | null => {
  const words = [...new Set((name ?? '').split(/[^A-Za-zÀ-ÿ'-]+/).filter((w) => w.length >= 3))];
  return words.length ? new RegExp(`(?<![A-Za-zÀ-ÿ])(?:${words.map(escapeRe).join('|')})(?![A-Za-zÀ-ÿ])`, 'gi') : null;
};

/** The request: one numbered block per account, its own words only, masked as described above. */
export function aiLabelRequest(lines: AiLine[], clientName?: string | null): { system: string; user: string; refs: Map<string, AiLine>; texts: Map<string, Partial<Record<LabelField, string>>> } {
  const refs = new Map<string, AiLine>();
  const texts = new Map<string, Partial<Record<LabelField, string>>>();
  const mask = nameMask(clientName);
  const blocks = lines.slice(0, AI_LABEL_LIMIT).map((t, i) => {
    const ref = `A${i + 1}`;
    refs.set(ref, t);
    const sent: Partial<Record<LabelField, string>> = {};
    const rows: string[] = [];
    for (const [f, name] of FIELDS) { const v = fieldText(t, f, mask); if (v) { sent[f] = v; rows.push(`${name}: ${v}`); } }
    texts.set(t.id, sent);
    return [ref, ...rows, `listed under: ${t.item_type === 'collection' ? 'collections' : 'accounts'}`].join('\n');
  });
  return { system: SYSTEM, user: `Accounts:\n\n${blocks.join('\n\n')}`, refs, texts };
}

/** Where `words` stand in `text` as whole words, not negated just before ("Not paid", "never late"): their start, or -1. */
function wholeWords(text: string, words: string): number {
  const re = new RegExp(`(?<![A-Za-z0-9])${escapeRe(words)}(?![A-Za-z0-9])`, 'i');
  const m = re.exec(text);
  if (!m) return -1;
  return /\b(?:not|never|no|non)[\s-]*$/i.test(text.slice(Math.max(0, m.index - 8), m.index)) ? -1 : m.index;
}

/**
 * One AI answer, as kept: a negative kind (a suggestion, confirmed by a person before it counts), a `hint` of good
 * standing (never a label), or unknown.
 */
export interface AiSuggestion { id: string; kind: AccountKind; words: string | null; field: LabelField | null; hint?: AccountKind }

/**
 * The reply, checked line by line against the text that was sent for that account (`texts`). Kept: a known reference
 * and kind, with words of at least three letters that stand as whole words in one field, are not negated there, and
 * show the kind (wordsSupport). Good standing and "nothing negative" become a hint. Anything else becomes "unknown"
 * for that account, and an account the reply does not mention is left out.
 */
export function parseAiLabels(reply: string, refs: Map<string, AiLine>, texts?: Map<string, Partial<Record<LabelField, string>>>): AiSuggestion[] {
  const out = new Map<string, AiSuggestion>();
  for (const raw of reply.split('\n')) {
    const m = /^\s*[-*]?\s*(A\d{1,3})\s*\|\s*([a-z_]+)\s*\|?\s*(.*)$/i.exec(raw);
    if (!m) continue;
    const t = refs.get(m[1]!.toUpperCase());
    if (!t || out.has(t.id)) continue;
    const kind = m[2]!.toLowerCase();
    const words = m[3]!.trim().replace(/^["“'`]+|["”'`]+$/g, '').replace(/\s+/g, ' ').trim().slice(0, 200);
    const unknown: AiSuggestion = { id: t.id, kind: 'unknown', words: null, field: null };
    if (!AI_KINDS.includes(kind) || kind === 'unknown' || !/[A-Za-z]{3,}/.test(words)) { out.set(t.id, unknown); continue; }
    const sent = texts?.get(t.id);
    const field = FIELDS.map(([f]) => f).find((f) => wholeWords(sent?.[f] ?? fieldText(t, f, null), words) >= 0) ?? null;
    if (!field || !wordsSupport(kind as AccountKind, words, field)) { out.set(t.id, unknown); continue; }
    out.set(t.id, kind === 'good' || kind === 'no_negative' ? { ...unknown, words, field, hint: kind as AccountKind } : { id: t.id, kind: kind as AccountKind, words, field });
  }
  return [...out.values()];
}

export interface AiLabelResult { asked: number; labelled: number; hinted: number; unknown: number; ai: AiCharge }

/**
 * Asks AI about the client's accounts that have no label yet, on the newest approved report of each bureau, and keeps
 * what passes the checks. Read and written as the caller (row-level security), for the caller's organization only.
 */
export async function labelAccountsWithAi(who: { orgId: string; userId: string; role: Role; ip?: string | null; tx: Ctx['tx'] }, clientId: string, provider: AiProvider | null = getProvider()): Promise<AiLabelResult> {
  if (!can(who.role, 'reports:write')) throw new PermissionError('reports:write');
  const { lines, name } = await who.tx(async (db) => {
    const c = await db.row<{ id: string; full_name: string }>('select id, full_name from public.clients where id = $1 and org_id = $2', [clientId, who.orgId]);
    if (!c) throw new UserError('Client not found.');
    const rows = await db.rows<AiLine & { own: unknown }>(
      `select t.id, t.item_type, t.creditor_name, t.original_creditor, t.account_type, t.account_status, t.payment_status, t.payment_history, t.remarks, t.kind_label as own, ${kindLabelSql('t')}
         from public.tradelines t
        where t.client_id = $1 and t.org_id = $2 and t.report_id in (
          select distinct on (bureau) id from public.credit_reports where client_id = $1 and status = 'approved' and bureau is not null
           order by bureau, coalesce(report_date, created_at::date) desc, created_at desc)
        order by t.creditor_name, t.bureau`, [clientId, who.orgId]);
    return { lines: rows.filter((t) => t.own == null && accountLabel(t).kind === 'unknown'), name: c.full_name };
  });
  const ask = lines.slice(0, AI_LABEL_LIMIT);
  if (!ask.length) return { asked: 0, labelled: 0, hinted: 0, unknown: 0, ai: { status: 'not_called', cost: 0 } };

  const req = aiLabelRequest(ask, name);
  const { result, ai } = await withAiCredits({ orgId: who.orgId, feature: 'account_label', actorUserId: who.userId }, async (p) => {
    if (!p) return { usedAi: false, labels: [] as AiSuggestion[], answered: false };
    const reply = await p.complete({ system: req.system, user: req.user, maxTokens: 60 + ask.length * 40 });
    const labels = parseAiLabels(reply, req.refs, req.texts);
    return { usedAi: labels.some((l) => l.kind !== 'unknown' || l.hint), labels, answered: true };
  }, provider);
  if (!result.answered) return { asked: 0, labelled: 0, hinted: 0, unknown: 0, ai };

  const at = new Date().toISOString();
  const kept = result.labels.filter((l) => l.kind !== 'unknown');
  const hinted = result.labels.filter((l) => l.hint);
  await who.tx(async (db) => {
    for (const l of result.labels) {
      const value = l.kind !== 'unknown' ? { kind: l.kind, by: 'ai', words: l.words, field: l.field, at }
        : l.hint ? { kind: 'unknown', by: 'ai', hint: l.hint, words: l.words, field: l.field, at } : { kind: 'unknown', by: 'ai', at };
      // Never over a person's label, or a suggestion written by a press at the same moment.
      await db.run('update public.tradelines set kind_label = $3::jsonb where id = $1 and client_id = $2 and org_id = $4 and kind_label is null', [l.id, clientId, JSON.stringify(value), who.orgId]);
    }
    await logEvent(db, { orgId: who.orgId, userId: who.userId }, clientId, 'case_tools', `AI suggested labels for ${kept.length + hinted.length} of ${ask.length} account entr${ask.length === 1 ? 'y' : 'ies'} the rules could not label`);
    await audit(db, { orgId: who.orgId, actorId: who.userId, action: 'account.label_ai', entityType: 'client', entityId: clientId, ip: who.ip ?? null,
      meta: { asked: ask.length, labelled: kept.length, hinted: hinted.length, ai: ai.status } });
    // Nothing else changes: a suggestion starts nothing until a person confirms it (./account-kind.ts confirmedLabel).
  });
  return { asked: ask.length, labelled: kept.length, hinted: hinted.length, unknown: result.labels.length - kept.length - hinted.length, ai };
}
