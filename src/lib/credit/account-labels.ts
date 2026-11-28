/**
 * Account labels kept on file (tradelines.kind_label, migration 0034): a person's label, and AI suggestions for the
 * accounts whose words the rules cannot read (./account-kind.ts says which label wins).
 *
 * AI here is a helper with a short leash:
 *  - It is asked only about accounts the rules left "Not labelled", at most AI_LABEL_LIMIT at a time, and an account it
 *    was asked about once is not sent again (a person labels it).
 *  - It is shown only the account's own words: company and original creditor, account type, status, payment status,
 *    payment history and remarks. No client name, no address, no amounts, no account numbers; what is sent is passed
 *    through scrubPii as well.
 *  - It must quote words of that account. A suggestion whose words are not there is dropped. A company name can carry
 *    only "collection" (a plainly named collector or debt buyer); "good" can rest only on a status or a history.
 *  - It costs AI_COSTS.account_label credits per press, charged only when at least one suggestion is kept
 *    (withAiCredits). With no AI provider, nothing is sent and the page says so.
 * A suggestion is labelled as one wherever it is shown, with the words it rests on, and a person's label replaces it.
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
import { accountLabel, ACCOUNT_KINDS, isStaffKind, KIND_META, type AccountKind, type LabelField, type LabelInput, type StaffKind } from './account-kind';
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
  const mine = await db.rows<{ id: string; creditor_name: string; account_last4: string | null }>(
    'select id, creditor_name, account_last4 from public.tradelines where id = any($1::uuid[]) and client_id = $2', [ids, clientId]);
  if (mine.length !== new Set(ids).size) throw new UserError('That account does not belong to this client.');
  const value = kind ? JSON.stringify({ kind, by: 'staff', at: new Date().toISOString(), user: actor.userId }) : null;
  const n = await db.run(
    `update public.tradelines set kind_label = $3::jsonb
      where client_id = $2 and (id = any($1::uuid[]) or (match_key ~ ${EXACT_KEY} and match_key in (select match_key from public.tradelines where id = any($1::uuid[]) and client_id = $2)))`,
    [ids, clientId, value]);
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
const fieldText = (t: AiLine, f: LabelField): string => (((t as unknown as Record<string, unknown>)[f] as string | null | undefined) ?? '').replace(/\s+/g, ' ').trim();
const norm = (s: string) => s.toLowerCase().replace(/[“”"'`]/g, '').replace(/\s+/g, ' ').trim();

/** The request: one numbered block per account, its own words only. */
export function aiLabelRequest(lines: AiLine[]): { system: string; user: string; refs: Map<string, AiLine> } {
  const refs = new Map<string, AiLine>();
  const blocks = lines.slice(0, AI_LABEL_LIMIT).map((t, i) => {
    const ref = `A${i + 1}`;
    refs.set(ref, t);
    const rows = FIELDS.map(([f, name]) => [name, fieldText(t, f).slice(0, 300)] as const).filter(([, v]) => v).map(([name, v]) => `${name}: ${v}`);
    return [ref, ...rows, `listed under: ${t.item_type === 'collection' ? 'collections' : 'accounts'}`].join('\n');
  });
  return { system: SYSTEM, user: scrubPii(`Accounts:\n\n${blocks.join('\n\n')}`), refs };
}

export interface AiSuggestion { id: string; kind: AccountKind; words: string | null; field: LabelField | null }

/**
 * The reply, checked line by line. Kept: a known reference and kind, with words found in that account's own text. A
 * company name may carry only "collection"; "good" and "nothing negative" only a status or a history. Everything else
 * becomes "unknown" for that account, and an account the reply does not mention is left out.
 */
export function parseAiLabels(reply: string, refs: Map<string, AiLine>): AiSuggestion[] {
  const out = new Map<string, AiSuggestion>();
  for (const raw of reply.split('\n')) {
    const m = /^\s*[-*]?\s*(A\d{1,3})\s*\|\s*([a-z_]+)\s*\|?\s*(.*)$/i.exec(raw);
    if (!m) continue;
    const t = refs.get(m[1]!.toUpperCase());
    if (!t || out.has(t.id)) continue;
    const kind = m[2]!.toLowerCase();
    const words = m[3]!.trim().replace(/^["“']|["”']$/g, '').trim().slice(0, 200);
    const unknown: AiSuggestion = { id: t.id, kind: 'unknown', words: null, field: null };
    if (!AI_KINDS.includes(kind) || kind === 'unknown' || !words) { out.set(t.id, unknown); continue; }
    const field = FIELDS.map(([f]) => f).find((f) => norm(fieldText(t, f)).includes(norm(words)) && norm(words).length >= 2) ?? null;
    const byName = field === 'creditor_name' || field === 'original_creditor';
    const fine = field && (byName ? kind === 'collection'
      : kind === 'good' || kind === 'no_negative' ? field === 'account_status' || field === 'payment_status' || field === 'payment_history' : true);
    out.set(t.id, fine ? { id: t.id, kind: kind as AccountKind, words, field } : unknown);
  }
  return [...out.values()];
}

export interface AiLabelResult { asked: number; labelled: number; unknown: number; ai: AiCharge }

/**
 * Asks AI about the client's accounts that have no label yet, on the newest approved report of each bureau, and keeps
 * what passes the checks. Read and written as the caller (row-level security), for the caller's organization only.
 */
export async function labelAccountsWithAi(who: { orgId: string; userId: string; role: Role; ip?: string | null; tx: Ctx['tx'] }, clientId: string, provider: AiProvider | null = getProvider()): Promise<AiLabelResult> {
  if (!can(who.role, 'reports:write')) throw new PermissionError('reports:write');
  const lines = await who.tx(async (db) => {
    const c = await db.row<{ id: string }>('select id from public.clients where id = $1 and org_id = $2', [clientId, who.orgId]);
    if (!c) throw new UserError('Client not found.');
    const rows = await db.rows<AiLine & { own: unknown }>(
      `select t.id, t.item_type, t.creditor_name, t.original_creditor, t.account_type, t.account_status, t.payment_status, t.payment_history, t.remarks, t.kind_label as own, ${kindLabelSql('t')}
         from public.tradelines t
        where t.client_id = $1 and t.report_id in (
          select distinct on (bureau) id from public.credit_reports where client_id = $1 and status = 'approved' and bureau is not null
           order by bureau, coalesce(report_date, created_at::date) desc, created_at desc)
        order by t.creditor_name, t.bureau`, [clientId]);
    return rows.filter((t) => t.own == null && accountLabel(t).kind === 'unknown');
  });
  const ask = lines.slice(0, AI_LABEL_LIMIT);
  if (!ask.length) return { asked: 0, labelled: 0, unknown: 0, ai: { status: 'not_called', cost: 0 } };

  const req = aiLabelRequest(ask);
  const { result, ai } = await withAiCredits({ orgId: who.orgId, feature: 'account_label', actorUserId: who.userId }, async (p) => {
    if (!p) return { usedAi: false, labels: [] as AiSuggestion[], answered: false };
    const reply = await p.complete({ system: req.system, user: req.user, maxTokens: 60 + ask.length * 40 });
    const labels = parseAiLabels(reply, req.refs);
    return { usedAi: labels.some((l) => l.kind !== 'unknown'), labels, answered: true };
  }, provider);
  if (!result.answered) return { asked: 0, labelled: 0, unknown: 0, ai };

  const at = new Date().toISOString();
  const kept = result.labels.filter((l) => l.kind !== 'unknown');
  await who.tx(async (db) => {
    for (const l of result.labels) {
      const value = l.kind === 'unknown' ? { kind: 'unknown', by: 'ai', at } : { kind: l.kind, by: 'ai', words: l.words, field: l.field, at };
      // Never over a person's label, or a suggestion written by a press at the same moment.
      await db.run('update public.tradelines set kind_label = $3::jsonb where id = $1 and client_id = $2 and kind_label is null', [l.id, clientId, JSON.stringify(value)]);
    }
    await logEvent(db, { orgId: who.orgId, userId: who.userId }, clientId, 'case_tools', `AI labelled ${kept.length} of ${ask.length} account${ask.length === 1 ? '' : 's'} the rules could not label`);
    await audit(db, { orgId: who.orgId, actorId: who.userId, action: 'account.label_ai', entityType: 'client', entityId: clientId, ip: who.ip ?? null,
      meta: { asked: ask.length, labelled: kept.length, ai: ai.status } });
    await syncCaseFindings(db, { orgId: who.orgId }, clientId);
  });
  return { asked: ask.length, labelled: kept.length, unknown: result.labels.length - kept.length, ai };
}
