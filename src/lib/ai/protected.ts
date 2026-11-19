/**
 * Protected rewriting. The model never sees — and can never change — anything that carries a fact.
 *
 * The text is split into units (sentences, kept line by line). A unit is LOCKED when it contains anything factual:
 * a digit (amounts, dates, account references, citations), a bureau name, any caller-supplied protected term
 * (client, creditor, furnisher names), an unfilled merge field, or the wording of a dispute assertion. Locked units are
 * replaced by opaque tokens before anything leaves the server, so the model only receives the connective wording and
 * the tokens. Afterwards the server checks that every token came back exactly once, in the original order, on the
 * line where it started, and that the model introduced no facts of its own — then puts the original units back.
 * If any check fails the caller keeps the original text.
 *
 * Why not compare numbers before and after? Because a rewrite can keep every number and still swap which bureau
 * reported which balance, or rename the creditor. Locking the whole unit makes both impossible by construction.
 */
const BUREAUS = /\b(experian|equifax|trans\s?union)\b/i;
const ASSERTION = /\b(disput|inaccurat|incorrect|incomplete|unverifi|verif|not mine|do(?:es)? not recogni[sz]e|identity theft|fraud|remov|delet|correct|investigat|reinvestigat|validat|report(?:s|ed|ing)?|balance|account|delinquen|late|charge.?off|collection|inquir|creditor|furnisher|pursuant|under the|section|u\.s\.c|fcra|fdcpa|croa|§|within \w+ days?|days?\b|enclos|attach|certif|deadline|law|legal|right|request(?:s|ed|ing)?\b)/i;
const MERGE_FIELD = /\{\{[^}]*\}\}|\[[A-Z][A-Z _]{2,}\]/;
export const TOKEN = /\[\[LOCKED_(\d+)\]\]/g;
const TOKEN_LIKE = /\[\[|\]\]|LOCKED_/;

export interface Protected { masked: string; locked: string[]; editableChars: number }
export type RestoreResult = { ok: true; text: string } | { ok: false; reason: string };

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function termMatcher(terms: string[]): RegExp | null {
  const clean = [...new Set(terms.map((t) => t.trim()).filter((t) => t.length >= 2))].sort((a, b) => b.length - a.length);
  return clean.length ? new RegExp(clean.map(escapeRe).join('|'), 'i') : null;
}

/**
 * Splits one line into whole sentences, keeping the separators so the line can be rebuilt exactly.
 * A sentence ends at . ! or ? followed by a space and a capital letter — but not after an abbreviation such as
 * "U.S.C.", "P.O." or "No.", so a citation or an address is never cut in two. Colons and semicolons do not split:
 * "Item: Acme Bank" and "Experian reports X; Equifax reports Y" each stay one unit.
 */
function units(line: string): string[] {
  const out: string[] = [];
  let start = 0;
  const re = /[.!?]+["')\]]*\s+(?=[A-ZÁÉÍÓÚÑ¿¡"'(\[])/g;
  for (let m = re.exec(line); m; m = re.exec(line)) {
    const before = line.slice(start, m.index);
    const lastWord = /(\S+)$/.exec(before)?.[1] ?? '';
    if (/^(?:[A-Za-z]|[A-Za-z](?:\.[A-Za-z])+|No|Nos|St|Ave|Rd|Blvd|Apt|Ste|Dept|Inc|Co|Corp|Ltd|Mr|Mrs|Ms|Dr|vs|etc|Sec|Art|Núm)$/.test(lastWord)) continue;
    out.push(line.slice(start, m.index + m[0].length));
    start = m.index + m[0].length;
  }
  out.push(line.slice(start));
  return out.filter((u) => u.length > 0);
}

export function isLocked(unit: string, terms: RegExp | null): boolean {
  if (!unit.trim()) return false;
  return /\d/.test(unit) || /[$%#§]/.test(unit) || BUREAUS.test(unit) || MERGE_FIELD.test(unit) || ASSERTION.test(unit) || (terms != null && terms.test(unit));
}

/** Replaces every fact-bearing unit with a token. `protectedTerms` are names that must never be editable. */
export function protect(text: string, protectedTerms: string[] = []): Protected {
  if (TOKEN_LIKE.test(text)) throw new Error('The text already contains protection markers.');
  const terms = termMatcher(protectedTerms);
  const locked: string[] = [];
  let editableChars = 0;
  const masked = text.replace(/\r\n?/g, '\n').split('\n').map((line) => {
    let out = '';
    let run = ''; // adjacent locked units collapse into one token so the model cannot reorder them
    const flush = () => { if (run) { locked.push(run); out += `[[LOCKED_${locked.length}]]`; run = ''; } };
    for (const u of units(line)) {
      if (isLocked(u, terms)) { const m = /\s+$/.exec(u); run += m ? u.slice(0, m.index) : u; if (m) { flush(); out += m[0]; } }
      else { flush(); out += u; editableChars += u.trim().length; }
    }
    flush();
    return out;
  }).join('\n');
  return { masked, locked, editableChars };
}

/**
 * Validates the model's reply against what was sent and puts the locked units back.
 * Rejects when a token is missing, repeated, invented, out of order or moved to another line, or when the editable
 * wording now contains anything factual.
 */
export function restore(original: Protected, reply: string, protectedTerms: string[] = []): RestoreResult {
  const out = reply.replace(/\r\n?/g, '\n').trim();
  const seen: number[] = [];
  for (const m of out.matchAll(TOKEN)) seen.push(Number(m[1]));
  const n = original.locked.length;
  if (seen.length !== n) return { ok: false, reason: seen.length < n ? 'a protected passage was removed' : 'a protected passage was repeated or invented' };
  for (let i = 0; i < n; i++) if (seen[i] !== i + 1) return { ok: false, reason: 'protected passages were reordered or altered' };

  const stripped = out.replace(TOKEN, '\u0000');
  if (TOKEN_LIKE.test(stripped)) return { ok: false, reason: 'a protected marker was altered' };
  const terms = termMatcher(protectedTerms);
  for (const piece of stripped.split('\u0000')) {
    for (const u of piece.split('\n').flatMap(units)) {
      if (isLocked(u, terms)) return { ok: false, reason: `the rewrite added factual wording (“${u.trim().slice(0, 60)}”)` };
    }
  }
  // each token must still be on the line it started on: paragraphs carry meaning (addresses, headings, signature)
  const linesOf = (s: string) => s.split('\n').map((l) => (l.match(TOKEN) ?? []).join('')).filter(Boolean);
  if (linesOf(original.masked.trim()).join('|') !== linesOf(out).join('|')) return { ok: false, reason: 'protected passages were moved between paragraphs' };

  const editable = stripped.replace(/\u0000/g, '').trim().length;
  if (editable > Math.max(400, original.editableChars * 2.5)) return { ok: false, reason: 'the rewrite is much longer than the original wording' };
  return { ok: true, text: out.replace(TOKEN, (_, i: string) => original.locked[Number(i) - 1]!) };
}

/** True when `proposed` keeps every protected passage of `original` unchanged, in order — used to re-check a suggestion before saving it. */
export function sameProtectedContent(original: string, proposed: string, protectedTerms: string[] = []): boolean {
  const a = protect(original, protectedTerms);
  let b: Protected;
  try { b = protect(proposed, protectedTerms); } catch { return false; }
  return a.locked.length === b.locked.length && a.locked.every((u, i) => u === b.locked[i]);
}
