/**
 * How much of one letter's wording also appears in another client's letter: a plain word-shingle overlap, worked out on
 * the server from letter text. No AI is involved and nothing is sent anywhere.
 *
 * What is compared is the whole letter from its "Re:" line to its sign-off, with what is this client's own taken out:
 * names, the reason as the letter states it, list lines (enclosures, entries) and every number. The standard
 * paragraphs stay in on purpose. The opening that cites the right, the request and the enclosure sentence are what a
 * bureau sees repeated from one consumer's letter to the next, so they are what "reads like a form letter" means. Two
 * letters drafted from the same template will therefore score high however different the facts are; what sets such a
 * letter apart is the reason and the documents, and the note beside the score says so.
 */
import { protect, TOKEN } from '../ai/protected';

/**
 * The wording of a letter an AI suggestion may see: what is left once every protected passage is taken out, line by
 * line (./tailor.ts builds the protected terms). Used by the tailoring checks, not by the overlap score.
 */
export function editableWording(body: string, protectedTerms: string[] = []): string {
  let masked: string;
  try { masked = protect(body, protectedTerms).masked; } catch { return ''; }
  return masked.replace(TOKEN, ' ').split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');
}

const SALUTATION = /^\s*(re:|to whom it may concern|dear\b)/i;
/** A date written out ("March 3, 2026", "March 2026"): a fact of the file, like any other number. */
const LONG_DATE = /\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+(?:\d{1,2},\s*)?\d{4}\b/g;
/** The three bureaus by their short names: who a letter goes to is not wording. */
const BUREAU_NAME = /\b(?:Experian|Equifax|Trans\s?Union)\b/gi;
const SIGN_OFF = /^\s*(sincerely|respectfully|regards|kind regards|best regards|yours truly|yours sincerely|cordially|thank you),?\s*$/i;
const LIST_LINE = /^\s*(?:[-•*]|\d+[.)])\s+/;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The wording a letter could share with another client's letter: its text from the "Re:" line (or the salutation) to
 * the sign-off, without `own.lines` (the reason as this letter states it), without list lines, and with `own.names`
 * (the client, the recipient, the creditor, the item), the bureaus' names, written-out dates and every number blanked.
 * Template paragraphs are kept.
 */
export function comparableWording(body: string, own: { names?: (string | null | undefined)[]; lines?: string[] } = {}): string {
  const all = body.replace(/\r\n?/g, '\n').split('\n');
  const from = all.findIndex((l) => SALUTATION.test(l));
  let to = -1;
  for (let i = all.length - 1; i > from; i--) if (SIGN_OFF.test(all[i]!)) { to = i; break; }
  const skip = new Set((own.lines ?? []).map((l) => l.trim()).filter(Boolean));
  const names = [...new Set((own.names ?? []).filter((n): n is string => typeof n === 'string' && n.trim().length >= 2).map((n) => n.trim()))].sort((a, b) => b.length - a.length);
  const blank = names.length ? new RegExp(names.map(escapeRe).join('|'), 'gi') : null;
  return all.slice(from < 0 ? 0 : from, to < 0 ? undefined : to)
    .filter((l) => l.trim() && !skip.has(l.trim()) && !LIST_LINE.test(l))
    .map((l) => (blank ? l.replace(blank, ' ') : l).replace(LONG_DATE, ' ').replace(BUREAU_NAME, ' ').replace(/\S*\d\S*/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean).join('\n');
}

const words = (text: string) => text.toLowerCase().replace(/[’‘]/g, "'").replace(/[^\p{L}\p{N}' ]+/gu, ' ').split(/\s+/).filter(Boolean);

/** Every run of `size` consecutive words in the text. Text shorter than that is one shingle. */
export function shingles(text: string, size = 3): Set<string> {
  const w = words(text);
  const out = new Set<string>();
  if (w.length > 0 && w.length < size) out.add(w.join(' '));
  for (let i = 0; i + size <= w.length; i++) out.add(w.slice(i, i + size).join(' '));
  return out;
}

export type OverlapLevel = 'low' | 'medium' | 'high';
export interface WordingOverlap {
  level: OverlapLevel;
  /** 0 to 1: the share of this letter's wording that is also in the closest other letter. */
  score: number;
  /** How many other letters it was compared with. */
  compared: number;
}

/** Below this many shingles there is too little wording for a comparison to mean anything. */
export const OVERLAP_MIN_SHINGLES = 5;
/**
 * Where the levels start, as a share of the letter's own wording: "high" is more than half of it, "medium" a quarter or
 * more. Plain fractions on purpose, so the words beside the badge are simply true ("most of this letter", "part of
 * it"). Measured on the built-in letters, across every voice: two clients' letters from the same template share 0.57
 * to 1.0 of it whatever their facts (the spread comes from the optional sentences: an earlier round, enclosures,
 * identity documents), and two different letters to a bureau share 0.52 to 0.94, because the frame, the request and
 * the enclosure sentence are the same: both read "high". A letter to a creditor shares 0.2 to 0.5 with a bureau letter
 * ("medium" or "low"), and a goodwill request, or a letter mostly in the client's own words, next to nothing ("low").
 */
export const OVERLAP_MEDIUM = 0.25;
export const OVERLAP_HIGH = 0.5;

/**
 * The overlap between one letter's wording and the closest of the others. Null when there is nothing to compare: no
 * other letters, or too little wording of its own.
 */
export function wordingOverlap(mine: string, others: string[]): WordingOverlap | null {
  const a = shingles(mine);
  const sets = others.map((o) => shingles(o)).filter((s) => s.size > 0);
  if (a.size < OVERLAP_MIN_SHINGLES || sets.length === 0) return null;
  let score = 0;
  for (const b of sets) {
    let shared = 0;
    for (const s of a) if (b.has(s)) shared++;
    score = Math.max(score, shared / a.size);
  }
  return { score, level: score >= OVERLAP_HIGH ? 'high' : score >= OVERLAP_MEDIUM ? 'medium' : 'low', compared: sets.length };
}
