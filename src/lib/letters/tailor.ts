/**
 * AI tailoring of a letter's wording, built on protected rewriting (../ai/protected.ts and rewriteSafely, both
 * unchanged). The AI does the wording and never the facts:
 *
 *  - LOCKED BY POSITION. Every line of the letter is replaced by a marker before anything leaves the server, except the
 *    lines this app itself wrote as connective wording: the standard salutation, the linking sentence, the closing
 *    courtesy and the sign-off (./brief.ts VOICE_LINES). What a line says, and in what language, makes no difference:
 *    a heading, a field list, an address line, a request, a sentence a person typed are all locked (letterTerms). The
 *    standing rules (digits, bureau names, dispute and legal wording) and the client's names still apply on top.
 *  - The model is asked to reword those few lines in one voice, picked by a style seed worked out from the client's id
 *    (./brief.ts voiceFor). The instruction is made of fixed phrases: nothing about the client is in it.
 *  - Every marker must come back once, in order, on its own line, and the protected passages are put back verbatim.
 *  - The result is then checked again here (tailorIssue): the protected content is unchanged, the claims guard passes,
 *    the wording makes no demand, legal claim, threat, deadline, promise or new request, it sits on the same lines with
 *    no more sentences and about the same length, and EVERY WORD of it is plain courtesy (COURTESY_WORDS). A reworded
 *    line therefore cannot state anything about the client, the account or earlier contact: the words are not there.
 *    A dispute letter must also still pass the specificity check. If any check fails the result is discarded, the
 *    letter is unchanged and nothing is charged (withAiCredits gives the credits back).
 *
 * Everything this produces is a suggestion or a DRAFT version. A person still reads it and a manager still approves it.
 */
import { protect, sameProtectedContent, TOKEN } from '../ai/protected';
import { getProvider, rewriteSafely, type AiProvider, type Rewritten } from '../ai/provider';
import { findBlockedClaims } from '../compliance/claims';
import { VOICE_LINES, voiceFor } from './brief';
import { editableWording } from './overlap';
import { reasonInLetter, specificityIssues, type SpecificityInput } from './specificity';

export interface TailorInput {
  /** Names and facts that must never be editable for this letter (letterTerms). */
  protectedTerms: string[];
  /** Picks the voice. Omitted, the wording is simply polished in a neutral voice. */
  seed?: number;
  /** What the specificity check reads for this letter, when it is held to that check (service.ts specificityInputFor). */
  specificity?: Omit<SpecificityInput, 'body'> | null;
}

// ---------------------------------------------------------------- what the model may never see or change

export interface TermSource {
  clientName: string;
  address?: { line1?: string; line2?: string; city?: string } | null;
  /** The recipient, the creditor, the item as labelled: locked wherever they appear. */
  names?: (string | null | undefined)[];
  /** Text a person entered as fact (the dispute reason, a status as the report shows it): locked sentence by sentence. */
  facts?: (string | null | undefined)[];
  /** The letter as it stands. Every line of it is locked except the connective wording this app wrote (REWORDABLE). */
  body?: string;
  /** The template the letter was drafted from: whatever sits where it has {{reason}} is locked, heading or not. */
  templateBody?: string | null;
}

/**
 * Splits text at least as finely as the protected-rewriting rules split a line into sentences, so that every sentence
 * they could treat as editable contains one of these pieces and is locked by it.
 */
const split = (text: string) => text.split(/\n|(?<=[.!?]["'”’)\]]*)\s+/).map((p) => p.trim());
const pieces = (text: string) => split(text).filter((p) => p.length >= 4);
const squash = (s: string) => s.replace(/\s+/g, ' ').trim();

/**
 * The only sentences of a drafted letter an AI wording suggestion may see and reword: the standard salutation and
 * sign-off of the built-in templates and the voice lines the letter brief adds. Everything else is locked by position.
 */
export const REWORDABLE: ReadonlySet<string> = new Set(['To whom it may concern:', 'Sincerely,', ...VOICE_LINES]);

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const MERGE_FIELD = /\{\{\s*\w+\s*\}\}/;

/**
 * The lines of a letter that sit where its template has {{reason}}: what a person entered as the reason, wherever the
 * template puts it and whether or not it has a heading (a standalone letter's reason is stored nowhere else). They run
 * from the template line above the field down to the next template line, the enclosure sentence or list, or the
 * letter's closing courtesy. A template line is recognised by its fixed wording, with anything where it has a merge
 * field. Empty when the line above the field is no longer in the letter.
 */
export function reasonLinesFrom(templateBody: string, letterBody: string): string[] {
  const t = templateBody.split('\n').map((l) => l.trim());
  const at = t.findIndex((l) => l.includes('{{reason}}'));
  if (at < 0) return [];
  // A line with enough wording of its own to be told apart from what a person typed; one made only of fields has none.
  const shape = (l: string) => (l.split(MERGE_FIELD).join('').trim().length >= 8 ? new RegExp(`^${l.split(MERGE_FIELD).map(escapeRe).join('.*')}$`) : null);
  const shapes = t.map(shape);
  const fixed = shapes.filter((x): x is RegExp => !!x);
  const above = shapes.slice(0, at).reverse().find((x) => !!x);
  const lines = letterBody.split('\n');
  const start = above ? lines.findIndex((l) => above.test(l.trim())) : -1;
  if (start < 0) return [];
  const out: string[] = [];
  for (const l of lines.slice(start + 1)) {
    const x = l.trim();
    if (fixed.some((re) => re.test(x)) || /^(enclosures?\b|i have enclosed|to confirm my identity)/i.test(x) || VOICE_LINES.some((v) => x.includes(v))) break;
    if (x) out.push(l);
  }
  return out;
}

/**
 * The protected terms for one letter. Over-locking is harmless (less wording is offered to the model); under-locking
 * is not, so the letter is locked by POSITION: every sentence of every line becomes a term unless it is, word for word,
 * one of the REWORDABLE sentences. The names, the reason and the list lines are added as well, so they stay locked
 * wherever else they might appear (and for a caller that passes no body).
 */
export function letterTerms(s: TermSource): string[] {
  const lines = (s.body ?? '').split('\n');
  const listLines = lines.map((l) => /^\s*(?:[-•*]|\d+[.)])\s+(.+)$/.exec(l)?.[1] ?? '').filter(Boolean);
  // The reason as the letter states it now (it can be edited in the letter after the dispute was written): where the
  // template puts it, or failing that whatever sits under a reason heading.
  let reasonLines = s.body && s.templateBody ? reasonLinesFrom(s.templateBody, s.body) : [];
  if (!reasonLines.length && s.body) {
    const stated = squash(reasonInLetter(s.body, ''));
    reasonLines = stated ? lines.filter((l) => l.trim().length >= 4 && stated.includes(squash(l))) : [];
  }
  // Every sentence of the letter that is not one of the few this app wrote as connective wording. Two characters is
  // the shortest term the protection rules accept; nothing shorter carries a fact.
  const byPosition = lines.flatMap(split).filter((p) => p.length >= 2 && !REWORDABLE.has(p));
  const out = [
    s.clientName, ...s.clientName.split(/\s+/).filter((w) => w.length > 2),
    ...[s.address?.line1, s.address?.line2, s.address?.city].filter((x): x is string => typeof x === 'string' && x.trim().length >= 3),
    ...(s.names ?? []).filter((x): x is string => typeof x === 'string' && x.trim().length >= 2),
    ...[...(s.facts ?? []), ...listLines, ...reasonLines].filter((x): x is string => typeof x === 'string' && x.length > 0).flatMap(pieces),
    ...byPosition,
  ];
  return [...new Set(out.map((t) => t.trim()).filter(Boolean))];
}

// ---------------------------------------------------------------- what the wording may not become

/**
 * Wording a letter from this office never uses, whoever wrote it: the same rules the letter library is held to. Checked
 * on the connective wording only; the protected passages are the vetted template text and the client's own facts.
 */
const TONE: [RegExp, string][] = [
  [/\b(demand\w*|insist\w*|must|shall|obligat\w*|comply|compliance|require[sd]?\s+(?:you|that)|required\s+to)\b/i, 'it reads as a demand'],
  [/\b(statut\w*|entitl\w*|regulation\w*|federal|prohibit\w*|permitted)\b/i, 'it makes a legal claim'],
  [/\b(lawsuit|sue|suing|attorney|lawyer|legal action|court|litigat\w*|complain\w*|damages|violat\w*|penalt\w*|liab\w+|regulator\w*|cfpb|consequence\w*|or else|otherwise|fail(?:s|ed|ure)?)\b/i, 'it reads as a warning or a threat'],
  [/\b(immediately|at once|without delay|no later than|as soon as possible|asap|urgent\w*|deadline\w*)\b/i, 'it sets a deadline'],
  [/\b(?:will|is going to|are going to)\s+(?:be\s+)?(?:corrected|updated|blocked|approved|fixed|changed|resolved|improve\w*|increase\w*|raise\w*)\b|\b(?:guarant\w*|promis\w*|scores?|sure to|certain to)\b/i, 'it promises or predicts a result'],
  [/\b(eras\w*|expung\w*|wip(?:e|ed|ing)|purg\w*|eliminat\w*|taken? off)\b/i, 'it asks for information to be taken off the report'],
  [/\b(illegal\w*|unlawful\w*|negligen\w*|willful\w*|false|lie[sd]?|lying)\b/i, 'it makes an accusation'],
];
const ASKS = /\b(please|kindly|i ask|i would like you to|i want you to|i need you to|i expect)\b/gi;
/** An invitation to write back is courtesy, not a request about the file: "please write to me", "kindly contact me", "please feel free to reach me". */
const INVITES = /\b(?:please|kindly)\s+(?:do\s+not\s+hesitate\s+to\s+|don['’]t\s+hesitate\s+to\s+|feel\s+free\s+to\s+)?(?:write|contact|reach|get\s+in\s+touch|let\s+me\s+know)\b/gi;
const asks = (wording: string) => wording.replace(INVITES, ' ').match(ASKS)?.length ?? 0;

/** The first thing in this wording that a letter may not say, or null. */
export function toneWordIssue(wording: string): string | null {
  for (const [re, why] of TONE) {
    const m = re.exec(wording);
    if (m) return `${why} (“${m[0]}”)`;
  }
  return null;
}

/** Why this connective wording cannot replace what the letter said before (`sourceWording`), or null. */
export function toneIssue(sourceWording: string, proposedWording: string): string | null {
  const word = toneWordIssue(proposedWording);
  if (word) return word;
  if (asks(proposedWording) > asks(sourceWording)) return 'it asks for something the letter did not ask for';
  return null;
}

/**
 * Every word a reworded line may be made of. Greetings, thanks, an invitation to write back, and the plain words that
 * join them: nothing else. There is no word here for a person's circumstances, an account, money, time that has passed,
 * an earlier letter or call, a reply, or a result, and no "have" or "has" to say that something already happened, so a
 * sentence built from this list cannot state one. That is the point: a denylist of bad phrases can always be worded
 * around, a short list of allowed words cannot. A suggestion that uses any other word is discarded (and not charged),
 * which only ever costs a suggestion, never a fact in a letter.
 */
export const COURTESY_WORDS: ReadonlySet<string> = new Set(`
  a an the and or but so if as at by for from in into of on to with about above below here there this that these those it is are am be
  i me my mine myself you your yours yourself can may might could would do does not no none nothing
  please thank thanks thanking thankful grateful gratitude appreciate appreciated appreciation appreciative obliged welcome glad pleased happy
  kind kindly courtesy courteous consideration considerate considering consider care careful carefully attention attentive time help helping
  helpful assistance assist assisting understanding cooperation effort efforts work advance
  reading look looking review reviewing taking
  details detail specifics particulars points information facts summary outline following follows follow set out laid listed
  described explained included shown stated provided put find finds well hope wish like want need
  write writing contact contacting reach reached reaching mail address hear hearing forward convenience get touch let know feel free hesitate
  questions question anything something further more most much many very also too just only all each every any other else additional
  dear sir madam hello greetings good day regards regard best warm warmly sincerely respectfully cordially truly faithfully
  whom concern matter regarding concerning
  i'm i'd you'd it's here's that's
`.split(/\s+/).filter(Boolean));

const wordsOf = (text: string) => text.toLowerCase().replace(/[’‘]/g, "'").split(/[^a-z']+/).map((w) => w.replace(/^'+|'+$/g, '')).filter(Boolean);
const sentenceCount = (line: string) => line.split(/(?<=[.!?:;])\s+/).filter((x) => x.trim()).length;
/** How long a reworded line may be: half as long again as the line it replaces (a short line such as a sign-off gets a few characters of room). */
const maxLength = (source: string) => Math.max(Math.ceil(source.length * 1.5), source.length + 16);

/** The connective wording of a letter, by the line it sits on. Null when the text cannot be read (it carries protection markers). */
function wordingByLine(body: string, terms: string[]): { lines: number; at: Map<number, string> } | null {
  let masked: string;
  try { masked = protect(body.trim(), terms).masked; } catch { return null; }
  const rows = masked.split('\n');
  const at = new Map<number, string>();
  rows.forEach((row, i) => { const w = squash(row.replace(TOKEN, ' ')); if (w) at.set(i, w); });
  return { lines: rows.length, at };
}

/**
 * Why the reworded wording is not a like-for-like replacement, or null. A rewording keeps every line where it was, puts
 * wording only where the letter already had some, adds no sentence, stays about the same length, and uses courtesy
 * words only. (A linking or closing line may be left out: less courtesy is still a correct letter.)
 */
export function rewordingIssue(source: string, proposed: string, terms: string[]): string | null {
  const a = wordingByLine(source, terms);
  const b = wordingByLine(proposed, terms);
  if (!a || !b) return 'it could not be compared with the letter';
  if (a.lines !== b.lines) return 'it adds or removes a line';
  for (const [i, text] of b.at) {
    const was = a.at.get(i);
    if (was == null) return 'it adds wording where the letter had none';
    if (sentenceCount(text) > sentenceCount(was)) return 'it adds a sentence the letter did not have';
    if (text.length > maxLength(was)) return 'it makes a line much longer than it was';
    if (text === was) continue; // unchanged wording is the letter's own, whatever its words
    // A rewording may reuse the words of the line it replaces ("this letter", "if you have any questions") and
    // otherwise only words of plain courtesy.
    const own = new Set(wordsOf(was));
    const stray = wordsOf(text).find((w) => !COURTESY_WORDS.has(w) && !own.has(w));
    if (stray) return `it uses wording that is not plain courtesy (“${stray}”)`;
  }
  return null;
}

/**
 * Why `proposed` cannot replace `source`, or null when it can. Run on the AI's result, and again on the server before
 * a suggestion is saved (the browser is not trusted and the letter may have changed).
 */
export function tailorIssue(source: string, proposed: string, o: TailorInput): string | null {
  if (!sameProtectedContent(source, proposed, o.protectedTerms)) return 'a name, amount, date or dispute statement would change';
  const claim = findBlockedClaims(proposed)[0];
  if (claim) return `it contains a prohibited claim (${claim.why})`;
  const tone = toneIssue(editableWording(source, o.protectedTerms), editableWording(proposed, o.protectedTerms));
  if (tone) return tone;
  const shape = rewordingIssue(source, proposed, o.protectedTerms);
  if (shape) return shape;
  if (o.specificity && specificityIssues({ ...o.specificity, body: proposed }).length > 0) return 'the letter would no longer state the account, what is disputed, the reason and what is enclosed';
  return null;
}

// ---------------------------------------------------------------- the rewrite

/** A salutation and a sign-off alone are not worth a model call (or a charge): there has to be a sentence to reword. */
export const MIN_WORDING = 40;

/** The instruction for one voice. Fixed phrases chosen by the seed: no name, account, date or other detail of the client. */
export function tailorGoal(seed?: number): string {
  const v = seed == null ? null : voiceFor(seed);
  return [
    'Reword only the visible wording of this consumer letter: the salutation, the short linking sentence, the closing courtesy and the sign-off.',
    v ? `Voice: ${v.tone}. ${v.habit}` : 'Voice: clear, courteous and concise.',
    'Keep every line where it is, with the same number of sentences on it and about the same length. Use plain words of courtesy only: a greeting stays a greeting, thanks stay thanks, an invitation to write back stays one.',
    'Add nothing about the writer, their circumstances, the matter, any earlier contact or what should happen next, and ask for nothing.',
  ].join(' ');
}

/**
 * The tailored wording for `source`, or `source` unchanged with a note saying why. `usedAi` is true only for a result
 * that passed every check, which is what the caller is charged for. The model is not called at all for a letter with a
 * prohibited claim, one that already fails the specificity check (rewording cannot add what such a letter is missing),
 * or one with nothing but a salutation and a sign-off to reword.
 */
export async function tailorSafely(source: string, o: TailorInput, provider: AiProvider | null = getProvider()): Promise<Rewritten> {
  const keep = (note: string): Rewritten => ({ text: source, usedAi: false, provider: provider?.name ?? 'rules', note });
  if (!provider) return { text: source, usedAi: false, provider: 'rules' };
  const claim = findBlockedClaims(source)[0];
  if (claim) return keep(`AI wording was not used: the letter contains a prohibited claim (“${claim.excerpt}”). Remove it first.`);
  const lacking = o.specificity ? specificityIssues({ ...o.specificity, body: source }) : [];
  if (lacking.length) return keep(`AI wording was not used: it rewords, it cannot add what the letter is missing. ${lacking[0]!.message}`);
  const wording = editableWording(source, o.protectedTerms);
  if (wording.length < MIN_WORDING) return keep('AI wording was not used: this letter has too little connective wording to reword. Only the standard linking sentence and closing lines can be reworded; everything else in it is locked.');
  const tone = toneWordIssue(wording);
  if (tone) return keep(`AI wording was not used: ${tone}. Reword that sentence first.`);
  const out = await rewriteSafely(source, tailorGoal(o.seed), provider, o.protectedTerms);
  if (!out.usedAi) return out;
  const issue = tailorIssue(source, out.text, o);
  return issue ? keep(`AI rewrite discarded: ${issue}.`) : out;
}
