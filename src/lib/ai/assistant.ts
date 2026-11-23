import { assertNoBlockedClaims } from '../compliance/claims';
import type { Db } from '../db';
import type { Outcome } from '../disputes/workflow';
import { findGeneratedClaims } from '../guide/llm';
import type { Stretch } from './protected';
import { getProvider, rewriteSafely, type AiProvider, type Rewritten } from './provider';

/**
 * The AI assistant's deterministic core. Every capability here works with no LLM at all; an LLM (if configured) may
 * only polish the wording through rewriteSafely(), which rejects anything that drops or adds a fact.
 * Output is always a DRAFT for a person to review and edit.
 */

// ---- Reading a bureau/furnisher reply (English + Spanish). A person always confirms the result. -----------------------
const NEGATED_DELETE = /\b(not|cannot|can't|unable to|won't|will not|did not|didn't)\b[^.]{0,30}\b(deleted|removed|remove|delete)\b|\bno\s+(se\s+)?(elimin|borr)/i;
const DELETED = /\b(deleted|removed|no longer (appear|report)|has been removed|will be removed)\b|\belimin(ad|ó|amos)|\bborrad/i;
const VERIFIED = /\b(verified|confirmed|accurate as reported|will remain|remains?|reported correctly)\b|\bverificad|\bse mantiene|\bcorrect[oa]\b/i;
const UPDATED = /\b(updated|modified|corrected|changed|revised|adjusted)\b|\bactualiz|\bmodific|\bcorreg/i;
const INSUFFICIENT = /\b(frivolous|irrelevant|insufficient information|unable to (locate|identify)|could not (locate|identify)|additional information is needed)\b/i;

export interface ResponseReading { outcome: Outcome | null; matched: string | null; needsReview: boolean; summary: string }

export function classifyResponse(text: string): ResponseReading {
  const t = text.trim();
  if (t.length < 8) return { outcome: null, matched: null, needsReview: true, summary: 'The reply is too short to interpret. Read it and record the outcome yourself.' };
  const hit = (re: RegExp) => re.exec(t)?.[0] ?? null;
  let outcome: Outcome | null = null;
  let m: string | null = null;
  if ((m = hit(NEGATED_DELETE))) outcome = 'verified';
  else if ((m = hit(DELETED))) outcome = 'deleted';
  else if ((m = hit(UPDATED))) outcome = 'updated';
  else if ((m = hit(VERIFIED))) outcome = 'verified';
  else if ((m = hit(INSUFFICIENT))) outcome = 'unresolved';
  const sentences = t.split(/(?<=[.!?])\s+/).filter((s) => s.length > 10);
  const key = m ? sentences.find((s) => s.toLowerCase().includes(m!.toLowerCase())) : undefined;
  const summary = outcome
    ? `This reply appears to say the item was ${outcome === 'deleted' ? 'removed' : outcome === 'updated' ? 'updated' : outcome === 'verified' ? 'verified as reported' : 'not resolved'}${key ? `: “${key.slice(0, 200)}”` : ''}. Confirm by reading the full reply.`
    : 'No clear outcome was found. Read the reply and record the outcome yourself.';
  return { outcome, matched: m, needsReview: true, summary };
}

// ---- Client progress note ------------------------------------------------------------------------------------------------
export interface ProgressStats { firstName: string; total: number; deleted: number; updated: number; verified: number; waiting: number; draft: number; language: 'en' | 'es' }

export type DisputeCounts = Pick<ProgressStats, 'total' | 'deleted' | 'updated' | 'verified' | 'waiting' | 'draft'>;

/** The counts a progress note is built from, read under the caller's row-level security. */
export function loadDisputeCounts(db: Db, clientId: string): Promise<DisputeCounts | null> {
  return db.row<DisputeCounts>(
    `select count(*) filter (where status in ('submitted','under_investigation','response_received','resolved'))::int as total, count(*) filter (where outcome = 'deleted')::int as deleted, count(*) filter (where outcome = 'updated')::int as updated,
            count(*) filter (where outcome = 'verified')::int as verified, count(*) filter (where status in ('submitted','under_investigation'))::int as waiting, count(*) filter (where status = 'draft')::int as draft from public.disputes where client_id = $1`, [clientId]);
}

/** The greeting is a line of its own: it carries the client's name, so the AI polish keeps it locked and rewords the rest. */
export function progressSummary(s: ProgressStats): string {
  const changed = s.deleted + s.updated;
  const es = s.language === 'es';
  const name = s.firstName.trim();
  const greeting = es ? `Hola${name ? ` ${name}` : ''},` : `Hi${name ? ` ${name}` : ''},`;
  const parts = es
    ? [
      'Este es el estado de su caso.',
      s.total === 0 ? 'Todavía no hemos enviado disputas; estamos revisando sus informes.' : `De ${s.total} cuenta${s.total === 1 ? '' : 's'} en disputa, ${changed} ${changed === 1 ? 'cambió' : 'cambiaron'} (${s.deleted} eliminada${s.deleted === 1 ? '' : 's'}, ${s.updated} corregida${s.updated === 1 ? '' : 's'}), ${s.verified} se verificaron tal como estaban y ${s.waiting} siguen en revisión.`,
      'Los resultados varían: cada decisión la toman las agencias y las empresas que reportan, no nosotros. Le avisaremos de cada respuesta.',
    ]
    : [
      'Here is where your case stands.',
      s.total === 0 ? 'We have not sent any disputes yet; we are reviewing your reports.' : `Of ${s.total} disputed item${s.total === 1 ? '' : 's'}, ${changed} changed (${s.deleted} removed, ${s.updated} corrected), ${s.verified} ${s.verified === 1 ? 'was' : 'were'} verified as reported, and ${s.waiting} ${s.waiting === 1 ? 'is' : 'are'} still under review.`,
      'Results vary: every decision is made by the credit bureaus and the companies that report to them, not by us. We will let you know about each response.',
    ];
  return assertNoBlockedClaims(`${greeting}\n\n${parts.join(' ')}`);
}

/**
 * Stands in for the client's first name in the note given to the AI. A merge field locks its line (./protected.ts), so
 * the model sees a marker in place of the whole greeting, and the real name is put back on the server afterwards.
 */
const NAME_SLOT = '{{first_name}}';

/**
 * A check of the whole polished note (the locked passages put back), on top of rewriteSafely's: no markup or
 * formatting, and none of the claims the credit guide rejects in model-written text (findGeneratedClaims: English and
 * Spanish promises and predictions of a removal, a score change or an approval).
 */
export function progressNoteIssue(text: string): string | null {
  if (/[<>*#`]/.test(text)) return 'it added markup or formatting';
  const claims = findGeneratedClaims(text);
  return claims.length ? `it contained a prohibited claim (${claims[0]!.why})` : null;
}

type NoteLang = ProgressStats['language'];

/**
 * The only words the model may use where it rewords the note's two courtesy sentences ("Here is where your case
 * stands." and "We will let you know about each response.", or "Este es el estado de su caso." and "Le avisaremos de
 * cada respuesta."), in the note's language: the words of those sentences and of their natural rewordings ("Here is a
 * short update on your case.", "We'll keep you posted on every response.", "Le mantendremos informado de cada
 * respuesta."). None of them can name a result: no credit, score, item, account or report; no removal, improvement,
 * approval, win or success; no praise or feeling ("good", "great", "happy", "love"); no word of likelihood, timing or
 * novelty ("should", "expect", "soon", "today", "new"); no negation; and no pair that says something goes away (no
 * "off", "away" or "up", no Spanish "se", so no "se va"). Compared without letter case or accents, with ’ read as '.
 * docs/INTEGRATIONS.md ("What is sent, feature by feature") lists them.
 */
export const COURTESY_WORDS: Record<NoteLang, readonly string[]> = {
  en: [
    'a', 'about', 'all', 'an', 'and', 'answer', 'answers', 'any', 'are', 'arrive', 'arrives', 'as', 'at', 'be', 'below', 'can', 'case', 'come', 'comes',
    'contact', 'each', 'every', 'file', 'for', 'from', 'get', 'gets', 'has', 'have', 'hear', 'here', "here's", 'how', 'i', "i'll", 'if', 'in', 'informed',
    'is', 'it', "it's", 'keep', 'know', 'let', "let's", 'look', 'message', 'messages', 'news', 'notify', 'now', 'of', 'on', 'once', 'or', 'our',
    'overview', 'patience', 'please', 'posted', 'question', 'questions', 'receive', 'replies', 'reply', 'response', 'responses', 'share', 'status',
    'summary', 'tell', 'thank', 'thanks', 'that', "that's", 'the', 'things', 'this', 'to', 'touch', 'update', 'updates', 'us', 'we', "we'll", "we're",
    'what', 'when', 'where', 'will', 'with', 'you', "you'll", 'your',
  ],
  es: [
    'a', 'actualización', 'ahora', 'al', 'aquí', 'así', 'avisaremos', 'avisarle', 'cada', 'caso', 'cómo', 'compartimos', 'compartiremos', 'comunicaremos',
    'con', 'contacto', 'contaremos', 'cuando', 'cuanto', 'de', 'del', 'el', 'en', 'enviaremos', 'es', 'escríbanos', 'escribiremos',
    'escribirnos', 'esta', 'está', 'están', 'estado', 'estaremos', 'este', 'esto', 'expediente', 'gracias', 'haremos', 'informada', 'informadas',
    'informado', 'informados', 'informamos', 'informaremos', 'informarle', 'la', 'las', 'le', 'les', 'llega', 'llegue', 'lleguen', 'lo', 'los',
    'mantendremos', 'mantenerle', 'más', 'mensaje', 'mensajes', 'nosotros', 'noticias', 'notificaremos', 'novedades', 'nuestras', 'nuestros', 'o',
    'paciencia', 'para', 'por', 'pregunta', 'preguntas', 'presentamos', 'puede', 'que', 'recibamos', 'recibimos', 'reciente', 'respuesta', 'respuestas',
    'resumen', 'sabrá', 'saber', 'si', 'situación', 'sobre', 'su', 'sus', 'tanto', 'tiene', 'todas', 'todos', 'un', 'una', 'usted', 'va', 'vamos', 'y',
  ],
};
/**
 * Words allowed only in one place: `words` beside one of `summaries` ("a short update", "un breve resumen"), never on
 * their own ("your case will be quick"); `afterYou` right after "you" ("we'll keep you updated", never "your file will be
 * updated"); `afterWhere` after "where" in the same sentence ("here is where your case stands", never "your case will
 * stand").
 */
export const BESIDE: Record<NoteLang, { words: readonly string[]; summaries: readonly string[]; afterYou: readonly string[]; afterWhere: readonly string[] }> = {
  en: { words: ['quick', 'short', 'brief'], summaries: ['update', 'updates', 'summary', 'overview', 'look'], afterYou: ['updated'], afterWhere: ['stand', 'stands'] },
  es: { words: ['breve'], summaries: ['resumen', 'actualización'], afterYou: [], afterWhere: [] },
};
/** Phrases allowed although a word of theirs is not ("soon" and "pronto" on their own are not). */
export const COURTESY_PHRASES: Record<NoteLang, readonly string[]> = { en: ['as soon as'], es: ['tan pronto como'] };
/** What may stand between the words: spaces and ordinary punctuation. Never a digit, a symbol or an emoji. */
const PUNCTUATION = /[\s.,;:!?¡¿'’‘"“”«»()\-–—]/gu;
const BETWEEN_WORDS = /^[\s.,;:!?¡¿'’‘"“”«»()\-–—]*$/u;
const WORD = /[\p{L}\p{M}]+(?:['’‘][\p{L}\p{M}]+)*/gu;

const fold = (w: string) => w.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[’‘]/g, "'");
const VOCABULARY = Object.fromEntries((['en', 'es'] as const).map((lang) => [lang, {
  words: new Set(COURTESY_WORDS[lang].map(fold)),
  beside: new Set(BESIDE[lang].words.map(fold)),
  summaries: new Set(BESIDE[lang].summaries.map(fold)),
  afterYou: new Set(BESIDE[lang].afterYou.map(fold)),
  afterWhere: new Set(BESIDE[lang].afterWhere.map(fold)),
  phrases: new RegExp(`(?<![\\p{L}\\p{N}])(?:${COURTESY_PHRASES[lang].map((p) => p.split(' ').join('\\s+')).join('|')})(?![\\p{L}\\p{N}])`, 'giu'),
}])) as Record<NoteLang, { words: Set<string>; beside: Set<string>; summaries: Set<string>; afterYou: Set<string>; afterWhere: Set<string>; phrases: RegExp }>;

/** Why `text`, one reworded courtesy sentence, is not made of courtesy words only (see progressWordingIssue), or null. */
export function courtesyWordingIssue(text: string, lang: NoteLang): string | null {
  const v = VOCABULARY[lang];
  const t = text.replace(v.phrases, ' ');
  const words = [...t.matchAll(WORD)];
  let from = 0;
  const gaps: string[] = [];
  for (const m of words) { gaps.push(t.slice(from, m.index)); from = m.index + m[0].length; }
  gaps.push(t.slice(from));
  const odd = gaps.find((g) => !BETWEEN_WORDS.test(g));
  if (odd !== undefined) return `it used a character outside the courtesy wording (“${odd.replace(PUNCTUATION, '').slice(0, 12)}”)`;
  const folded = words.map((m) => fold(m[0]));
  for (let i = 0; i < folded.length; i++) {
    const w = folded[i]!;
    if (v.words.has(w)) continue;
    if (v.beside.has(w) && (v.summaries.has(folded[i - 1] ?? '') || v.summaries.has(folded[i + 1] ?? ''))) continue;
    if (v.afterYou.has(w) && folded[i - 1] === 'you') continue;
    if (v.afterWhere.has(w) && folded.slice(0, i).includes('where')) continue;
    return `it used a word outside the courtesy wording (“${words[i]![0]}”)`;
  }
  return null;
}

/**
 * The check of the reworded sentences: each stretch of wording between the locked passages, as the model returned it,
 * so the locked counts and "Results vary: … the credit bureaus …" are never read. The only wording the model may change
 * is two fixed courtesy sentences, so it may use courtesy words of the note's language only (COURTESY_WORDS; BESIDE for
 * "quick", "short", "brief", "breve", "updated", "stand" and "stands"; the phrases "as soon as" and "tan pronto como"),
 * with spaces and ordinary punctuation between them. Any other word or character rejects the reply: no credits are charged and the
 * drafted note is used. It is an allowlist, so a promise worded in a new way is refused as well: it would need a word
 * that is not on it. Returns why the reply must not be used, or null.
 */
export function progressWordingIssue(stretches: Stretch[], lang: NoteLang): string | null {
  for (const { now } of stretches) {
    const issue = courtesyWordingIssue(now, lang);
    if (issue) return issue;
  }
  return null;
}

/** The words, as the goal lists them for the model ("…; quick, short or brief only before update, …"). */
function vocabularyForPrompt(lang: NoteLang): string {
  const b = BESIDE[lang];
  return [
    COURTESY_WORDS[lang].join(' '),
    `the phrase${COURTESY_PHRASES[lang].length > 1 ? 's' : ''} “${COURTESY_PHRASES[lang].join('”, “')}”`,
    `${b.words.join(', ')} only next to ${b.summaries.join(', ')}`,
    ...(b.afterYou.length ? [`${b.afterYou.join(', ')} only after “you”`] : []),
    ...(b.afterWhere.length ? [`${b.afterWhere.join(', ')} only after “where”`] : []),
  ].join('; ');
}

/**
 * Calls the LLM when a provider is given. Callers that serve users must go through withAiCredits (./credits.ts).
 * What is sent: the connective sentences only ("Here is where your case stands.", "We will let you know about each
 * response."), with markers for the greeting, the counts and the results-vary sentence, and a goal that lists the
 * courtesy words. The client's name is not sent. The reply must keep the note's lines and sentence count (no preface,
 * no added sentence), and pass progressWordingIssue (courtesy words only in the reworded sentences) and
 * progressNoteIssue (the whole note). Telling the model the words only keeps it inside them; the checks decide.
 */
export async function polishedProgress(s: ProgressStats, provider: AiProvider | null = getProvider()): Promise<Rewritten> {
  const source = progressSummary({ ...s, firstName: NAME_SLOT });
  const goal = `Make this client progress note warm and easy to read in ${s.language === 'es' ? 'Spanish' : 'English'}. Reword each sentence where it stands; do not add or remove a sentence. `
    + `Write the reworded sentences with these words only (any letter case): ${vocabularyForPrompt(s.language)}.`;
  const out = await rewriteSafely(source, goal, provider, [], { sameShape: true, wording: (stretches) => progressWordingIssue(stretches, s.language), check: progressNoteIssue });
  return { ...out, text: out.usedAi ? out.text.split(` ${NAME_SLOT}`).join(s.firstName.trim() ? ` ${s.firstName.trim()}` : '') : progressSummary(s) };
}
