/**
 * Blocked-claims guard. Credit repair marketing and correspondence is regulated (CROA, FTC Act, FCRA, state laws).
 * This is a safety net, not a legal filter: it blocks the most common prohibited promises in text the system
 * generates (AI output, automation messages, templates) and WARNS on text a person writes themselves.
 */
interface Rule {
  id: string;
  pattern: RegExp;
  why: string;
}

const RULES: Rule[] = [
  { id: 'guarantee', pattern: /\bguarantee[sd]?\b|\bguaranteed\b/i, why: 'Results cannot be guaranteed.' },
  { id: 'certain-removal', pattern: /\b(will|we will|we['’]ll|are going to|going to)\s+(be\s+)?(delete[d]?|remov(e|ed)|eras(e|ed)|wip(e|ed))\b/i, why: 'Do not promise that an item will be removed.' },
  { id: 'remove-all', pattern: /\b(remove|delete|erase|wipe)\s+(all|every|any)\s+(of\s+)?(your\s+)?(negative|bad|derogatory)/i, why: 'Do not promise to remove all negative items.' },
  { id: 'score-promise', pattern: /\b(raise|boost|increase|improve|jump|add)\b[^.]{0,40}\b(score|fico)\b[^.]{0,30}\b(by|to)\s+\d+|\b\d+\s*(\+\s*)?points?\b[^.]{0,20}\b(guaranteed|in\s+\d+\s+(days|weeks))/i, why: 'Do not promise or quantify a score increase.' },
  { id: 'fixed-time', pattern: /\b(fix|repair|clean)\b[^.]{0,30}\bcredit\b[^.]{0,20}\bin\s+\d+\s+(days?|weeks?)\b/i, why: 'Do not promise results within a time frame.' },
  { id: '100pct', pattern: /\b100\s*%\s*(success|guarantee|effective|removal|deletion)/i, why: 'No success-rate promises.' },
  { id: 'new-identity', pattern: /\bCPN\b|credit privacy number|new credit identity|file segregation/i, why: 'Creating a new credit identity is illegal.' },
  { id: 'accurate-removal', pattern: /\b(accurate|correct|valid|legitimate)\b[^.]{0,40}\b(can|will|could)\s+be\s+(removed|deleted)/i, why: 'Accurate, verifiable information cannot be removed on demand.' },
  { id: 'accurate-removal-2', pattern: /\b(can|could|will|able to|going to)\s+(remove|delete|erase)\b[^.]{0,40}\b(accurate|correct|valid|legitimate|truthful|true)\b/i, why: 'Accurate, verifiable information cannot be removed on demand.' },
  { id: 'legal-guarantee', pattern: /\b(legally|by law)\s+(required|obligated|forced)\s+to\s+(delete|remove)/i, why: 'Do not misstate legal obligations.' },
];

export interface ClaimIssue {
  id: string;
  why: string;
  excerpt: string;
}

export function findBlockedClaims(text: string): ClaimIssue[] {
  const issues: ClaimIssue[] = [];
  for (const r of RULES) {
    const m = r.pattern.exec(text);
    if (m) issues.push({ id: r.id, why: r.why, excerpt: m[0].slice(0, 80) });
  }
  return issues;
}

export class BlockedClaimError extends Error {
  constructor(public issues: ClaimIssue[]) {
    super(`Text contains prohibited claims: ${issues.map((i) => `“${i.excerpt}” (${i.why})`).join('; ')}`);
  }
}

/** Throws for system-generated text. */
export function assertNoBlockedClaims(text: string): string {
  const issues = findBlockedClaims(text);
  if (issues.length) throw new BlockedClaimError(issues);
  return text;
}

/**
 * Extra rules for an agency's own public marketing copy (its hosted website), in English and Spanish. That text is
 * advertising under CROA and the FTC Act, so it is REJECTED on save, not just warned about. Still a safety net: it
 * catches the common prohibited promises, it does not make copy lawful. Nothing is ever deleted from the text before
 * it is checked: every rule reads what the agency actually typed.
 */
const NUM = String.raw`(?:\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten|twelve|thirty|sixty|ninety|un|una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|doce|treinta|sesenta|noventa)`;
const PERIOD = String.raw`(?:days?|weeks?|months?|d[ií]as|semanas|meses)`;
const SCORE = String.raw`(?:scores?|fico|puntajes?|puntuaci[oó]n)`;
const MARKETING_RULES: Rule[] = [
  { id: 'score-number', pattern: /\b\d{2,3}\s*\+?\s*(points?|pts|puntos)\b|\b[3-8]\d{2}\s*\+?\s*(credit\s+)?(scores?|fico)\b|\b(scores?|fico|puntaje|puntuaci[oó]n)\b[^.!?]{0,30}\b[3-8]\d{2}\b/i, why: 'Do not quote a score or a score increase.' },
  { id: 'score-promise', pattern: new RegExp(String.raw`\b(rais\w+|boost\w*|increas\w+|improv\w+|skyrocket\w*|better|higher|sub[aeiío]\w*|aument\w+|elev\w+|mejor\w*|increment\w+)\b[^.!?]{0,30}\b${SCORE}\b|\b${SCORE}\b[^.!?]{0,20}\b(go(es)? up|will (rise|improve|increase|go up)|subir[aá]|mejorar[aá]|aumentar[aá])\b`, 'i'), why: 'Do not promise a higher credit score.' },
  { id: 'timed-result', pattern: new RegExp(String.raw`\b(results?|resultados|fix(ed)?|repair(ed)?|clean(ed)?|improve[ds]?|arregl\w+|repar\w+|mejor\w+|limpi\w+)\b[^.!?]{0,40}\b(in|within|under|en|dentro de|menos de)\s+(as (little|few) as\s+|just\s+|only\s+|less than\s+|under\s+|solo\s+|s[oó]lo\s+|tan solo\s+|menos de\s+)?${NUM}\s+${PERIOD}\b|\b${NUM}[\s-]+${PERIOD}[\s-]+(results?|credit (repair|fix)|fix|turnaround)\b|\b(fast|quick|instant|r[aá]pidos?|inmediatos?)\s+(results?|resultados)\b|\bresultados\s+(r[aá]pidos|inmediatos)\b|\b(scores?|credit)\s+fast\b`, 'i'), why: 'Do not promise results within a time frame.' },
  { id: 'result-promise', pattern: /\b(we|i)\s+promise\s+(you\s+)?(results?|deletions?|removals?|approval|a\s+(better|higher|clean))|\b(prometemos|le prometemos|te prometemos)\s+(resultados|eliminar|borrar|quitar|un)|\bmoney[\s-]+back\b|\bor\s+(you|they)\s+(do\s+not|don['’]?t|will\s+not|won['’]?t)\s+pay\b|\bpay\s+(nothing|only)\s+(if|unless|when)\b|\b(le|les|te)\s+devolvemos\b|\bdevoluci[oó]n\s+de(l)?\s+(su\s+|tu\s+)?dinero\b|\b100\s*%\s*(efectiv\w+|garantizad\w+|segur[oa]|de [eé]xito|[eé]xito)/i, why: 'Results cannot be guaranteed.' },
  // First-person removal promises with no item named ("we remove…", "podemos eliminar cualquier cuenta"); removalIssue covers the rest.
  { id: 'removal-promise', pattern: /\bwe\s+(can\s+)?(remove|delete|erase|wipe)\b|\bget\s+[^.!?]{0,40}\b(removed|deleted|erased|wiped)\b|\b(eliminaremos|borraremos|quitaremos|removeremos)\b|\b(vamos a|podemos|logramos)\s+(eliminar|borrar|quitar|remover)\b|\b(eliminamos|borramos|quitamos|removemos)\b/i, why: 'Do not promise that an item will be removed.' },
  { id: 'approval-promise', pattern: /\b(get|getting)\s+(you\s+)?approved\b|\bpre-?approved\b|\bqualify\s+for\b|\bcalifi(que|ca|car|camos)\s+para\b|\baprobaci[oó]n\s+(segura|asegurada)\b|\b(lo|la|te|le)\s+aprueban\b/i, why: 'Do not promise a loan or credit approval.' },
  { id: 'tradelines', pattern: /\bauthorized[\s-]+user\s+tradelines?\b|\bseasoned\s+(tradelines?|accounts?)\b|\btradelines?\s+(for\s+sale|packages?|rentals?)\b|\b(buy|purchase|rent|sell|add)\b[^.!?]{0,20}\btradelines?\b|\b(venta|compra|renta)\s+de\s+(tradelines?|l[ií]neas\s+de\s+cr[eé]dito)\b/i, why: 'Do not advertise tradelines for sale.' },
  { id: 'new-identity-es', pattern: /\bnuev[oa]\s+(identidad|perfil|historial)\s+(de\s+cr[eé]dito|crediticio|crediticia)\b/i, why: 'Creating a new credit identity is illegal.' },
];

/**
 * A guarantee word (English, Spanish and the common misspelling) is a prohibited claim unless a negation directly
 * governs it: "no result is guaranteed", "we cannot guarantee…", "nadie puede garantizar…", "sin garantías". A
 * negative word somewhere earlier in the sentence ("No worries, we guarantee…", "Why not get guaranteed results")
 * does not count.
 */
const GUARANTEE_WORD = /\b(guarant\w+|guarent\w+|garant[ií]\w*|asegura(mos|do|da|dos|das))/gi;
const GUARANTEE_NEGATED = new RegExp(String.raw`\b(?:` + [
  String.raw`no (?:particular |specific |certain )?(?:results?|outcomes?|changes?|removals?|deletions?)(?: (?:is|are|can be|can ever be|is ever|are ever))?`,
  String.raw`(?:cannot|can not|can['’]?t|could not|couldn['’]?t|do not|don['’]?t|does not|doesn['’]?t|will not|won['’]?t|will never|can never|never|unable to|not able to|not|nor|or)(?: (?:and (?:do|will) not|legally|honestly|ever|promise or))?`,
  String.raw`(?:is|are|be) (?:not|never)`,
  String.raw`(?:without|no|not a|never a)(?: a| any)?`,
  String.raw`(?:nadie|ninguna (?:empresa|compañ[ií]a|agencia)) (?:puede|podr[ií]a)(?: legalmente)?`,
  String.raw`no (?:podemos|puedo|se puede|se pueden|es posible|prometemos ni)`,
  String.raw`(?:no|ni|nunca)(?: le| les| te| se)?`,
  String.raw`ning[uú]n resultado (?:est[aá]|es|puede ser)`,
  String.raw`no (?:est[aá]n?|son|es)`,
  String.raw`(?:sin|no hay|no ofrecemos|no damos)(?: ninguna)?`,
].join('|') + String.raw`)\s+$`, 'i');

function guaranteeIssue(text: string): ClaimIssue | null {
  for (const m of text.matchAll(GUARANTEE_WORD)) {
    if (!GUARANTEE_NEGATED.test(text.slice(Math.max(0, m.index - 60), m.index))) return { id: /^gua/i.test(m[0]) ? 'guarantee' : 'guarantee-es', why: 'Results cannot be guaranteed.', excerpt: m[0].slice(0, 80) };
  }
  return null;
}

/**
 * A removal verb in the same sentence as a negative item, in either order: "we delete collections", "late payments
 * erased", "eliminamos sus deudas". Allowed only when a negation directly governs the verb ("nobody can remove…").
 */
const REMOVAL_VERB = String.raw`(?:remov\w+|delet\w+|eras\w+|wip\w+|clean(?:s|ed|ing)?\s+(?:up|off)|get(?:s|ting)?\s+rid\s+of|elimin\w+|borr\w+|quit\w+|limpi\w+)`;
const NEGATIVE_ITEM = String.raw`(?:late\s+payments?|collections?|charge[\s-]?offs?|bankruptc\w+|inquir\w+|foreclosures?|repossessions?|judgments?|liens?|negative\s+\w+|derogator\w+|bad\s+credit|deudas?|cobranzas?|colecciones|mal\s+cr[eé]dito|pagos?\s+atrasados?|bancarrotas?|quiebras?|embargos?|consultas|\w+\s+negativ[oa]s?)`;
const REMOVAL = new RegExp(String.raw`\b(${REMOVAL_VERB})\b[^.!?]{0,60}\b${NEGATIVE_ITEM}\b|\b${NEGATIVE_ITEM}\b[^.!?]{0,60}\b(${REMOVAL_VERB})\b`, 'gi');
const REMOVAL_NEGATED = /\b(cannot|can not|can['’]?t|do not|don['’]?t|does not|doesn['’]?t|will not|won['’]?t|never|nobody can|no one can|not|nadie puede|no podemos|no se puede|no)(\s+(legally|be|ser|legalmente))?\s+$/i;

function removalIssue(text: string): ClaimIssue | null {
  for (const m of text.matchAll(REMOVAL)) {
    const verb = m[1] ?? m[2]!;
    const at = m.index + m[0].toLowerCase().indexOf(verb.toLowerCase(), m[1] ? 0 : 1);
    if (!REMOVAL_NEGATED.test(text.slice(Math.max(0, at - 40), at))) return { id: 'removal-promise', why: 'Do not promise that an item will be removed.', excerpt: m[0].slice(0, 80) };
  }
  return null;
}

/**
 * The only thing an agency may call free here is a first conversation ("free consultation", "free 15-minute call").
 * A consumer's own right to dispute at no cost may be stated too. Everything else the agency sells is paid.
 */
const FREE_OK = /\b(free|no[\s-]cost|complimentary)\s+(\S+\s+){0,2}(consultations?|consult|calls?|conversations?)\b|\b(consultas?|llamadas?|conversaci[oó]n)\s+(inicial\s+)?(es\s+|son\s+)?(gratis|gratuitas?|sin\s+costo)\b|\b(yourself|on\s+your\s+own|usted\s+mism[oa]|por\s+su\s+cuenta)\b[^.!?]{0,140}\b(at\s+no\s+cost|for\s+free|free\s+of\s+charge|gratis|sin\s+costo)\b/gi;
const FREE = /\b(free|no[\s-]cost|no\s+charge|complimentary|gratis|gratuit[oa]s?|sin\s+costo)\b|\$\s?0\b/i;

/** Everything `findBlockedClaims` blocks, plus the marketing rules above. Use for text an agency publishes about itself. */
export function findMarketingClaims(text: string): ClaimIssue[] {
  // The base guarantee rule has no notion of an honest disclaimer, so the guarantee check here replaces it.
  const issues = findBlockedClaims(text).filter((i) => i.id !== 'guarantee');
  const add = (i: ClaimIssue | null) => { if (i && !issues.some((x) => x.why === i.why)) issues.push(i); };
  add(guaranteeIssue(text));
  add(removalIssue(text));
  for (const r of MARKETING_RULES) {
    const m = r.pattern.exec(text);
    if (m) add({ id: r.id, why: r.why, excerpt: m[0].slice(0, 80) });
  }
  // The allowed phrases are skipped for this one test only; every other rule above has already read the full text.
  const free = FREE.exec(text.replace(FREE_OK, ' '));
  if (free) issues.push({ id: 'free', why: 'Only a first consultation may be called free. Do not call credit repair, reports, scores or results free.', excerpt: free[0] });
  return issues;
}
