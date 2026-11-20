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
 *  - The result is then checked again here (tailorIssue): the protected content is unchanged and on the same lines, the
 *    claims guard passes, the wording makes no demand, legal claim, threat, deadline, promise or new request, and it
 *    sits on the same lines with no more sentences and about the same length. The salutation and the sign-off must each
 *    be one of a short fixed list (SALUTATIONS, SIGN_OFFS). A linking or closing sentence that was changed must be
 *    written in plain English words that are all on a list of courtesy words (COURTESY_WORDS; a linking sentence only
 *    the part of it that points to the details, POINTER_WORDS), and its line may not say "I", "me" or "my" more often
 *    than before. A dispute letter must also still pass the specificity check. If any check fails the result is
 *    discarded, the letter is unchanged and nothing is charged (withAiCredits gives the credits back).
 *
 * The facts are locked. The reworded lines are checked against a word list, which is not proof of what a sentence says:
 * one built from listed words can still say something nobody recorded. So everything this produces is a suggestion or a
 * DRAFT version: a person still reads it and a manager still approves it.
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

/** Line ends as the protected-rewriting rules read them (protect in ../ai/protected.ts): CRLF and a lone CR each end a line. */
const lf = (text: string) => text.replace(/\r\n?/g, '\n');
/**
 * Splits text at least as finely as the protected-rewriting rules split a line into sentences, so that every sentence
 * they could treat as editable contains one of these pieces and is locked by it.
 */
const split = (text: string) => lf(text).split(/\n|(?<=[.!?]["'”’)\]]*)\s+/).map((p) => p.trim());
const pieces = (text: string) => split(text).filter((p) => p.length >= 4);
const squash = (s: string) => s.replace(/\s+/g, ' ').trim();

/**
 * The salutations and the sign-offs a letter may carry after rewording: first the one the built-in letters use, then a
 * few ordinary alternatives. Each is a whole line taken as it is, so it cannot be emptied, moved or given a name.
 */
export const SALUTATIONS: ReadonlySet<string> = new Set(['To whom it may concern:', 'To Whom It May Concern:', 'Dear Sir or Madam:', 'Dear Madam or Sir:']);
export const SIGN_OFFS: ReadonlySet<string> = new Set(['Sincerely,', 'Respectfully,', 'Regards,', 'Kind regards,', 'Best regards,', 'Yours truly,', 'Yours sincerely,', 'Cordially,', 'Thank you,']);

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
  const t = lf(templateBody).split('\n').map((l) => l.trim());
  const at = t.findIndex((l) => l.includes('{{reason}}'));
  if (at < 0) return [];
  // A line with enough wording of its own to be told apart from what a person typed; one made only of fields has none.
  const shape = (l: string) => (l.split(MERGE_FIELD).join('').trim().length >= 8 ? new RegExp(`^${l.split(MERGE_FIELD).map(escapeRe).join('.*')}$`) : null);
  const shapes = t.map(shape);
  const fixed = shapes.filter((x): x is RegExp => !!x);
  const above = shapes.slice(0, at).reverse().find((x) => !!x);
  const lines = lf(letterBody).split('\n');
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
  // Split into lines exactly where the protected-rewriting rules split it, or a line locked here would not match there.
  const body = lf(s.body ?? '');
  const lines = body.split('\n');
  const listLines = lines.map((l) => /^\s*(?:[-•*]|\d+[.)])\s+(.+)$/.exec(l)?.[1] ?? '').filter(Boolean);
  // The reason as the letter states it now (it can be edited in the letter after the dispute was written): where the
  // template puts it, or failing that whatever sits under a reason heading.
  let reasonLines = body && s.templateBody ? reasonLinesFrom(s.templateBody, body) : [];
  if (!reasonLines.length && body) {
    const stated = squash(reasonInLetter(body, ''));
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
  // A term is looked for inside one line, so a name that carries a line break is locked part by part.
  return [...new Set(out.flatMap((t) => lf(t).split('\n')).map((t) => t.trim()).filter(Boolean))];
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
  // "Thank you for writing to me", "It is good to hear from you", "Regarding your contact", "About your questions",
  // "As you write to me": each says the reader contacted the writer first. Nothing on file says so, and it can be made
  // of courtesy words only, so the word list below cannot catch it. (It also discards "I would appreciate hearing from
  // you" and "write to me with your questions"; that costs a suggestion, nothing else.)
  [/\b(?:thank(?:s|ing|ful)?|grateful|gratitude|appreciat\w*|glad|pleased|happy|good|nice|kind)\b[^.!?;:]*\b(?:writing|contacting|reaching|hear(?:ing)?\s+from|getting\s+in\s+touch|letting\s+me\s+know)\b|\byour\s+(?:contact|mail|note|message|letter|reply|response|call|questions?|writing)\b|(?<!\bif\s)\byou\s+(?:write|contact|reach)\b/i, 'it refers to earlier contact that is not on file'],
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
 * The words a changed linking or closing sentence may be made of: thanks, an invitation to write back, a pointer to the
 * details, and the plain words that join them. Left out on purpose are the usual words for saying that something is
 * someone's, or has happened, been said or been sent: "is", "are" and "am", every past form and "have", "my" and
 * "mine", and any word for mail, a letter or a reply. So are the words for wanting, needing or keeping something,
 * "will", "should" and "must", "not", "no", "but" and "only", and words that are also first names ("may", "hope"). A
 * few phrases are allowed by name (BY_NAME). A suggestion that uses any other word is discarded and not charged. A word
 * list narrows what a sentence can say; it does not prove what one says, which is why the result is only ever a draft
 * for a person to read.
 */
export const COURTESY_WORDS: ReadonlySet<string> = new Set(`
  a an the and or so if as at by for in into of on to with about above below here this that these those it
  i me you your can would
  please thank thanks thanking thankful grateful gratitude appreciate appreciation appreciative
  kind kindly courtesy courteous consideration considerate considering carefully attention attentive help helping
  assistance assisting understanding cooperation effort efforts
  reading looking reviewing
  details specifics particulars follows follow
  write writing contact reach convenience
  anything most much many very also all any other else
  matter regarding
  i'd
`.split(/\s+/).filter(Boolean));
/**
 * The part of the list a linking sentence may use. It points to the details and does nothing else; a closing line gives
 * thanks or invites a reply and does not bring the details up (in a closing line the same words would ask for them).
 */
export const POINTER_WORDS: ReadonlySet<string> = new Set('a the this these those of as matter details specifics particulars follow follows below here'.split(' '));
const POINTER = /^(?:details|specifics|particulars)$/;
/**
 * Phrases of plain courtesy whose key word is not on the list, because on its own it could say more ("I hear that", "in
 * time", "be kind", "address this", "this questions"): each is allowed in this one form, and read as the listed words
 * beside it. Applied in this order before the words are checked.
 */
export const BY_NAME: [phrase: string, find: RegExp, readAs: string][] = [
  ['to hear from you', /\bto\s+hear(?:ing)?\s+from\s+you\b/gi, 'to you'],
  ['look forward to', /\blook(?:ing)?\s+forward\s+to\b/gi, 'to'],
  ['do not hesitate to', /\b(?:do\s+not|don['’]t)\s+hesitate\s+to\b/gi, 'to'],
  ['feel free to', /\bfeel\s+free\s+to\b/gi, 'to'],
  ['would be grateful', /\b(would|I['’]d)\s+be(?=\s+(?:(?:so|very|most)\s+)?(?:grateful|thankful|appreciative)\b)/gi, '$1'],
  ['your time', /\byour\s+time\b/gi, 'your'],
  ['the address above', /\bthe\s+address\s+above\b/gi, 'above'],
  ['any questions', /\b(any(?:\s+other)?|with)\s+questions\b/gi, '$1'],
  ['in advance', /\bin\s+advance\b/gi, 'in'],
];
/** One token of a reworded line: a plain English word, with an apostrophe or hyphen inside it and ordinary punctuation around it at most. */
const PLAIN_WORD = /^["'“‘(]?[A-Za-z]+(?:['’-][A-Za-z]+)*[.,;:!?"'”’)]*$/;
/** A capital letter belongs at the start of a sentence and in "I". Anywhere else it shouts, or makes a word read as a name. */
const oddCapital = (word: string, first: boolean) => /[A-Z]/.test(first || /^I(?![A-Za-z])/.test(word) ? word.slice(1) : word);
const FIRST_PERSON = /\b(?:i|me|my|mine|we|us|our)\b/gi;
const firstPerson = (line: string) => line.match(FIRST_PERSON)?.length ?? 0;

const wordsOf = (text: string) => text.toLowerCase().replace(/[’‘]/g, "'").split(/[^a-z']+/).map((w) => w.replace(/^'+|'+$/g, '')).filter(Boolean);
const sentences = (line: string) => line.split(/(?<=[.!?:;])\s+/).filter((x) => x.trim());
/** How long a reworded line may be: half as long again as the line it replaces (a short line gets a few characters of room). */
const maxLength = (source: string) => Math.max(Math.ceil(source.length * 1.5), source.length + 16);

/**
 * A letter line by line: the connective wording each line carries, and how many protected passages each line holds.
 * Only spaces and tabs are folded into one space: any other blank or invisible character stays in the wording, where
 * the plain-word check finds it. Null when the text cannot be read (it carries protection markers).
 */
function wordingByLine(body: string, terms: string[]): { locked: number[]; at: Map<number, string> } | null {
  let masked: string;
  try { masked = protect(body.trim(), terms).masked; } catch { return null; }
  const rows = masked.split('\n');
  const at = new Map<number, string>();
  rows.forEach((row, i) => { const w = row.replace(TOKEN, ' ').replace(/[ \t]+/g, ' ').trim(); if (w) at.set(i, w); });
  return { locked: rows.map((row) => row.match(TOKEN)?.length ?? 0), at };
}

/**
 * Why the reworded wording is not a like-for-like replacement, or null. A rewording keeps every line and every
 * protected passage where it was, puts wording only where the letter already had some, adds no sentence and stays about
 * the same length. The salutation and the sign-off stay, each as one of the fixed lists. A linking or closing line may
 * be left out (less courtesy is still a correct letter); one that is changed is held to the word checks below.
 */
export function rewordingIssue(source: string, proposed: string, terms: string[]): string | null {
  const a = wordingByLine(source, terms);
  const b = wordingByLine(proposed, terms);
  if (!a || !b) return 'it could not be compared with the letter';
  if (a.locked.length !== b.locked.length) return 'it adds or removes a line';
  if (a.locked.join() !== b.locked.join()) return 'it moves a protected passage to another line';
  for (const [i, was] of a.at) {
    const list = SALUTATIONS.has(was) ? SALUTATIONS : SIGN_OFFS.has(was) ? SIGN_OFFS : null;
    if (list && !list.has(b.at.get(i) ?? '')) return `the ${list === SALUTATIONS ? 'salutation' : 'sign-off'} is missing or is not one of the standard ones`;
  }
  for (const [i, text] of b.at) {
    const was = a.at.get(i);
    if (was == null) return 'it adds wording where the letter had none';
    // Unchanged wording is the letter's own, whatever its words. A salutation or a sign-off was settled above.
    if (text === was || SALUTATIONS.has(was) || SIGN_OFFS.has(was)) continue;
    const odd = text.split(' ').find((t) => !PLAIN_WORD.test(t));
    if (odd) return /^[\x21-\x7e]+$/.test(odd) ? `it uses something that is not a plain English word (“${odd}”)` : 'it uses characters that are not plain English letters';
    if (sentences(text).length > sentences(was).length) return 'it adds a sentence the letter did not have';
    if (text.length > maxLength(was)) return 'it makes a line much longer than it was';
    // A sentence left exactly as it was keeps its words. A changed one gets no words from the line it replaces: every
    // word of it has to be on the list.
    const kept = new Set(sentences(was));
    const changed = sentences(text).filter((x) => !kept.has(x));
    const words = wordsOf(BY_NAME.reduce((t, [, re, to]) => t.replace(re, to), changed.join(' ')));
    const stray = words.find((w) => !COURTESY_WORDS.has(w));
    if (stray) return `it uses wording that is not plain courtesy (“${stray}”)`;
    // A line that pointed to the details is the linking sentence: it keeps to POINTER_WORDS. No other line brings the details up.
    const linking = wordsOf(was).some((w) => POINTER.test(w));
    const beyond = words.find((w) => (linking ? !POINTER_WORDS.has(w) : POINTER.test(w)));
    if (beyond) return linking ? `it makes the linking sentence do more than point to the details (“${beyond}”)` : 'it brings up the details in a line that did not mention them';
    const capital = changed.flatMap((x) => x.split(' ').map((t, i) => [t.replace(/^["'“‘(]/, ''), i === 0] as const)).find(([w, first]) => oddCapital(w, first));
    if (capital) return `it uses a capital letter where a plain word has none (“${capital[0]}”)`;
    if (firstPerson(text) > firstPerson(was)) return 'it uses “I”, “me” or “my” more often than the line it replaces';
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

/**
 * The instruction for one voice. Fixed phrases chosen by the seed: no name, account, date or other detail of the client.
 * It names what the checks accept (the fixed salutations and sign-offs, the word list), so a rewording is not discarded
 * for a word the model could not have known was off the list.
 */
export function tailorGoal(seed?: number): string {
  const v = seed == null ? null : voiceFor(seed);
  return [
    'Reword only the visible wording of this consumer letter: the salutation, the short linking sentence, the closing courtesy and the sign-off.',
    v ? `Voice: ${v.tone}. ${v.habit}` : 'Voice: clear, courteous and concise.',
    'Keep every line where it is, with the same number of sentences on it and about the same length. Use plain words of courtesy only: a greeting stays a greeting, thanks stay thanks, an invitation to write back stays one.',
    `Keep the salutation, or replace it with one of these, exactly as written: ${[...SALUTATIONS].map((x) => `“${x}”`).join(' ')}. Keep the sign-off, or replace it with one of these, exactly as written: ${[...SIGN_OFFS].map((x) => `“${x}”`).join(' ')}.`,
    `Leave the linking sentence exactly as it is, or rewrite it using only these words: ${[...POINTER_WORDS].join(' ')}.`,
    `Leave any other sentence exactly as it is, or rewrite it using only these words: ${[...COURTESY_WORDS].filter((w) => !POINTER.test(w)).join(' ')}; and these phrases: ${BY_NAME.map(([phrase]) => phrase).join(', ')}. Do not use “I” or “me” more often on a line than the line does now.`,
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
  // Line ends as protect() reads them, so a result that differs from the letter only in its line ends is not a change.
  const text = lf(source);
  const out = await rewriteSafely(text, tailorGoal(o.seed), provider, o.protectedTerms);
  if (!out.usedAi) return { ...out, text: source };
  const issue = tailorIssue(text, out.text, o);
  return issue ? keep(`AI rewrite discarded: ${issue}.`) : out;
}
