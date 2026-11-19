/**
 * Deterministic matcher for the credit guide: keyword and token overlap, no AI, no network.
 * Same question, same answer. A question the knowledge base does not cover gets an honest "not sure" with topics.
 */
import type { Lang } from '../portal-i18n';
import { entriesFor, entryById, STARTER_IDS, type GuideAudience, type GuideEntry } from './knowledge';

export const MAX_QUESTION_CHARS = 500;

const STOP = new Set(('a an and are as at be by can do does for from how i if in is it me my of on or so that the this to was we what when where which who why will with you your am have has had about '
  + 'el la los las un una unos unas y o de del al en es que como mi mis me se su sus por para con no si yo lo le les esta este esto hay ser son puedo puede cual cuando donde quien').split(' '));

/** Lower-case, accents removed, punctuation to spaces. "30%" keeps its percent sign so it can be a keyword. */
export function normalize(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[’']/g, '').replace(/[^a-z0-9%]+/g, ' ').trim();
}

const stem = (w: string) => (w.length > 4 && w.endsWith('s') ? w.slice(0, -1) : w);
const tokens = (s: string) => normalize(s).split(' ').filter((w) => w && !STOP.has(w)).map(stem);

function score(entry: GuideEntry, lang: Lang, text: string, words: Set<string>): number {
  let total = 0;
  const padded = ` ${text} `;
  for (const k of entry.keywords) {
    const kw = normalize(k);
    if (!kw) continue;
    if (kw.includes(' ')) { if (padded.includes(` ${kw} `)) total += 3; } else if (words.has(stem(kw))) total += 1.5;
  }
  // A tapped starter or related question is the entry's own question, word for word.
  if (text === normalize(entry.question.en) || text === normalize(entry.question.es)) total += 10;
  // Words shared with the entry's own question (either language) count a little, so a rephrased starter still matches.
  for (const w of new Set([...tokens(entry.question.en), ...tokens(entry.question[lang])])) if (words.has(w)) total += 0.5;
  return total;
}

export interface GuideMatch {
  kind: 'entry' | 'fallback';
  /** The entry answered from; null for the fallback. */
  entry: GuideEntry | null;
  /** Other entries that also matched (for the fallback: the starter topics). */
  related: GuideEntry[];
}

/** Weakest score that counts as an answer: one clear keyword, or a phrase. */
const MIN_SCORE = 1.5;

export function answerFromKnowledge(question: string, lang: Lang, audience: GuideAudience = 'portal'): GuideMatch {
  const text = normalize(question.slice(0, MAX_QUESTION_CHARS));
  const words = new Set(tokens(text));
  const ranked = entriesFor(audience)
    .map((entry, i) => ({ entry, i, s: score(entry, lang, text, words) }))
    .filter((r) => r.s >= MIN_SCORE)
    .sort((a, b) => b.s - a.s || a.i - b.i);
  if (ranked.length === 0) {
    return { kind: 'fallback', entry: null, related: STARTER_IDS[audience].map(entryById).filter((e): e is GuideEntry => !!e) };
  }
  return { kind: 'entry', entry: ranked[0]!.entry, related: ranked.slice(1, 3).map((r) => r.entry) };
}

const FALLBACK: Record<GuideAudience, Record<Lang, string>> = {
  portal: {
    en: 'I am not sure about that one, and I would rather not guess. Your specialist can answer questions about your own accounts — you can message them from here. These are topics I can explain:',
    es: 'No estoy seguro de esa pregunta y prefiero no adivinar. Su especialista puede responder preguntas sobre sus propias cuentas; puede escribirle desde aquí. Estos son temas que puedo explicar:',
  },
  app: {
    en: 'I am not sure about that one, and I would rather not guess. I can only explain general credit topics and where things are in this app. These are topics I can explain:',
    es: 'No estoy seguro de esa pregunta y prefiero no adivinar. Solo puedo explicar temas generales de crédito y dónde están las cosas en esta aplicación. Estos son temas que puedo explicar:',
  },
};

export const fallbackText = (audience: GuideAudience, lang: Lang): string => FALLBACK[audience][lang];
