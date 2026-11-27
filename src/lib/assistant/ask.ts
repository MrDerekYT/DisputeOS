/**
 * "Ask about your clients": one question from a staff member about the workspace's own records, and its answer.
 *
 *   1. Retrieval, with no AI, under the caller's row-level security: who the question names (./match.ts), those
 *      clients' files, and the workspace's counts (./records.ts).
 *   2. The answer. Always available and free: built from those records (recordsAnswer). When the caller asks for AI,
 *      a provider is connected and the workspace has credits: one model call, paid for with AI credits only when its
 *      answer passes the checks and is shown (./answer.ts, src/lib/ai/credits.ts). Anything else falls back to the
 *      records answer, with a line saying why.
 *   3. The question and the answer are kept for the person who asked (migration 0033), and the audit trail records
 *      that a question was asked: how it was answered and how many files were read, never the question's text.
 *
 * Nothing here sends, changes or deletes anything in a client's file. The model is called outside any database
 * transaction, so a slow provider holds no connection.
 */
import { randomBytes } from 'node:crypto';
import { AI_OFF, notChargedNote, withAiCredits, type AiCharge, type AiChargeStatus } from '../ai/credits';
import { getProvider, type AiProvider } from '../ai/provider';
import { audit } from '../audit';
import type { Ctx } from '../auth/context';
import { rateLimit } from '../auth/rate-limit';
import type { Db } from '../db';
import { scrubPii } from '../scrub';
import { isUuid } from '../util';
import { buildAssistantPrompt, MAX_QUESTION_CHARS, recordsAnswer, validateAssistantAnswer, validQuestion } from './answer';
import { fold, matchClients, MAX_MATCHED, type NameMatch, type RosterName } from './match';
import { cardOf, loadClientFile, loadRoster, loadRosterNames, loadWorkspaceFacts, recordsText, ROSTER_NAMES_MAX, type ClientCard, type ClientFile } from './records';

/** Questions one person may ask in ASK_WINDOW_SEC, as for the credit guide. */
export const ASK_LIMIT = 30;
export const ASK_WINDOW_SEC = 300;
export const HISTORY_SHOWN = 10;
const MAX_STORED_ANSWER_CHARS = 6000;

export type AnswerMode = 'ai' | 'records';

export interface AssistantAnswer {
  ok: true;
  /** The history row, or null when it could not be saved. */
  id: string | null;
  at: string;
  /** The question as it is kept: Social Security, card and phone numbers and email addresses typed into it are masked. */
  question: string;
  mode: AnswerMode;
  answer: string;
  /** Things to know about how the question was read: a name several clients share, clients it named beyond the limit. */
  hints: string[];
  /** The files that were read, as shown on the page. */
  cards: ClientCard[];
  /** Why AI was not used, when it was asked for. */
  note?: string;
  /** AI credits taken for this answer. */
  charged: number;
}
export type AssistantReply = AssistantAnswer | { ok: false; error: string };

export interface AskCaller {
  userId: string;
  orgId: string;
  /** A personal workspace: someone working on their own credit. */
  personal: boolean;
  /** Whether the role may see plans and payments. */
  billing: boolean;
  ip: string | null;
  tx: Ctx['tx'];
}
export interface AskInput {
  question: unknown;
  /** A client chosen on the page (the page was opened for them). */
  clientId?: unknown;
  /** Ask for an AI answer. False: the records answer, free. */
  useAi: boolean;
}

export interface HistoryItem { id: string; at: string; question: string; answer: string; mode: AnswerMode }

/** The caller's own latest questions and answers. Row-level security already limits the table to their own rows. */
export async function loadHistory(db: Db, orgId: string, userId: string, limit = HISTORY_SHOWN): Promise<HistoryItem[]> {
  return db.rows<HistoryItem>(
    `select id, created_at as at, question, answer, mode from public.assistant_questions
      where org_id = $1 and user_id = $2 order by created_at desc, id limit $3`, [orgId, userId, limit]);
}

function hintsFor(match: NameMatch, total: number, personal: boolean): string[] {
  const who = personal ? 'people on file' : 'clients';
  return [
    ...match.ambiguous.map((a) => `${a.count} ${who} are named ${a.word}: ${a.names.join(', ')}${a.count > a.names.length ? `, and ${a.count - a.names.length} more` : ''}. Add the rest of the name to choose one.`),
    ...(match.more ? [`The question names ${match.more} more than the ${MAX_MATCHED} files read. Ask about fewer at a time to see the rest.`] : []),
    ...(total > ROSTER_NAMES_MAX ? [`Names were looked for among the ${ROSTER_NAMES_MAX.toLocaleString('en-US')} most recently active of ${total.toLocaleString('en-US')} ${who}.`] : []),
  ];
}

/** The clients an answer names in full, so the stored answer can be removed with the client (migration 0033). */
function namedIn(answer: string, names: readonly RosterName[]): string[] {
  const text = ` ${fold(answer).replace(/[^\p{L}\p{N}]+/gu, ' ')} `;
  return names.filter((n) => {
    const name = fold(n.full_name).replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    return name.length >= 3 && text.includes(` ${name} `);
  }).map((n) => n.id);
}

interface Worded { usedAi: boolean; text: string | null; why?: string }

async function wordWithAi(provider: AiProvider | null, x: { question: string; records: string; files: ClientFile[]; personal: boolean }): Promise<Worded> {
  if (!provider) return { usedAi: false, text: null };
  try {
    const canary = `REF-${randomBytes(6).toString('hex')}`;
    const prompt = buildAssistantPrompt({ question: x.question, records: x.records, identifiers: x.files.flatMap((f) => f.identifiers), personal: x.personal, canary });
    // No output cap of its own, as for the credit guide: length is asked for in the prompt and checked below.
    const out = (await provider.complete({ system: prompt.system, user: prompt.user })).trim();
    const check = validateAssistantAnswer(out, x.records, prompt.question, canary);
    return check.ok ? { usedAi: true, text: out } : { usedAi: false, text: null, why: `was discarded by the safety checks (${check.reason})` };
  } catch (e) {
    return { usedAi: false, text: null, why: `was not available (${(e as Error).message})` };
  }
}

const FROM_RECORDS = 'This answer is from the records.';

/** What the person is told when they asked for AI and the answer shown is the one from the records. */
function noteFor(ai: AiCharge, why: string | undefined): string {
  if (ai.status === 'no_provider') return `${AI_OFF.no_provider} ${FROM_RECORDS}`;
  if (ai.status === 'no_credits') return `${AI_OFF.no_credits} ${FROM_RECORDS}`;
  return `The AI answer ${why ?? 'was not used'}. ${FROM_RECORDS} ${notChargedNote(ai)}`;
}

export async function askAssistant(who: AskCaller, input: AskInput, provider: AiProvider | null = getProvider(), now: Date = new Date()): Promise<AssistantReply> {
  const question = validQuestion(input.question);
  if (!question) return { ok: false, error: 'Ask a question of up to 500 characters.' };
  if (!(await rateLimit(`assistant:user:${who.userId}`, ASK_LIMIT, ASK_WINDOW_SEC, now.getTime())).allowed) {
    return { ok: false, error: 'Too many questions in a short time. Try again in a few minutes.' };
  }
  const pinned = isUuid(input.clientId) ? input.clientId : null;
  const useAi = input.useAi === true;

  // 1. Retrieval: everything is read as the caller, for the caller's organization.
  const read = await who.tx(async (db) => {
    const { names, total } = await loadRosterNames(db, who.orgId);
    const match = matchClients(question, names, pinned);
    // A personal workspace is one person's own file: a question that names nobody is about it.
    const ids = who.personal && match.matched.length === 0 && names.length === 1 ? [names[0]!.id] : match.matched;
    const files: ClientFile[] = [];
    for (const id of ids) {
      const file = await loadClientFile(db, who.orgId, id, { personal: who.personal, billing: who.billing, now });
      if (file) files.push(file);
    }
    const facts = await loadWorkspaceFacts(db, who.orgId, now);
    const roster = useAi && provider ? await loadRoster(db, who.orgId, files.map((f) => f.id), now) : [];
    return { names, total, match, files, facts, roster };
  });

  // 2. The answer.
  const fromRecords = recordsAnswer({ question, files: read.files, facts: read.facts, personal: who.personal });
  let answer = fromRecords;
  let mode: AnswerMode = 'records';
  let note: string | undefined;
  let charged = 0;
  let status: AiChargeStatus | 'not_asked' = 'not_asked';
  if (useAi) {
    const records = provider ? recordsText({ facts: read.facts, roster: read.roster, files: read.files, personal: who.personal, now }) : '';
    const { result, ai } = await withAiCredits(
      { orgId: who.orgId, feature: 'client_question', actorUserId: who.userId },
      (p) => wordWithAi(p, { question, records, files: read.files, personal: who.personal }), provider);
    status = ai.status;
    if (result.usedAi && result.text) { answer = result.text; mode = 'ai'; charged = ai.cost; } else note = noteFor(ai, result.why);
  }

  // 3. History and the audit trail. A failure here does not take the answer away from the person who asked.
  const kept = scrubPii(question).slice(0, MAX_QUESTION_CHARS);
  const hints = hintsFor(read.match, read.total, who.personal);
  // The history shows the answer with what was said about how the question was read, so it reads the same later.
  const stored = [answer, ...hints].join('\n').slice(0, MAX_STORED_ANSWER_CHARS);
  const clientIds = [...new Set([...read.files.map((f) => f.id), ...namedIn(stored, read.names)])];
  let id: string | null = null;
  try {
    id = await who.tx(async (db) => {
      const row = await db.row<{ id: string }>(
        'insert into public.assistant_questions (org_id, user_id, question, answer, mode, client_ids) values ($1, $2, $3, $4, $5, $6::uuid[]) returning id',
        [who.orgId, who.userId, kept, stored, mode, clientIds]);
      await audit(db, { orgId: who.orgId, actorId: who.userId, action: 'assistant.asked', entityType: 'assistant_question', entityId: row!.id, ip: who.ip,
        meta: { mode, files_read: read.files.length, ai: status } });
      return row!.id;
    });
  } catch (e) {
    console.error('[assistant] the question could not be saved:', (e as Error).message);
    note = [note, 'This answer could not be saved to your history.'].filter(Boolean).join(' ');
  }

  return {
    ok: true, id, at: now.toISOString(), question: kept, mode, answer, charged, note, hints,
    cards: read.files.map(cardOf),
  };
}
