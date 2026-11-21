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
  { id: 'new-identity', pattern: /\bCPNs?\b|credit privacy numbers?|new credit identit(?:y|ies)|file segregation/i, why: 'Creating a new credit identity is illegal.' },
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

// ---------------------------------------------------------------- the terms of a contract a client signs

/** A sentence ends at "!", "?" or a full stop that is not a decimal point ("$99.00" is one sentence). */
const SENTENCE_END = /[!?]|(?<!\d)\.|\.(?!\d)/;

/**
 * A promise inside a disclaimer is no promise: "we cannot guarantee that any negative item will be deleted", "we do not
 * promise that your score will improve", "no one can promise you will qualify for a loan". True when such a disclaimer
 * governs the text just before `at`: in the same sentence, at most 100 characters back, with no "but", "however",
 * "yet" or "instead" between it and the claim.
 */
const DISCLAIMER = new RegExp(String.raw`\b(?:(?:cannot|can not|can['’]?t|could not|couldn['’]?t|do not|don['’]?t|does not|doesn['’]?t|did not|will not|won['’]?t|never|not|no one can|nobody can|no company can)\s+(?:\w+\s+){0,2}?(?:guarantee|promise|predict|claim|represent|assure|warrant|say|know|tell)\w*|(?:no|without|not a|not any|never a)\s+(?:\w+\s+)?(?:guarantees?|promises?|representations?|assurances?|warrant(?:y|ies)|predictions?))\b(?:(?!\b(?:but|however|yet|although|though|except|instead)\b)[^!?;]){0,100}$`, 'i');
const disclaimed = (text: string, at: number) => DISCLAIMER.test(text.slice(Math.max(0, at - 180), at).split(SENTENCE_END).pop()!);

/** A negation right before `at` (at most three words back, no punctuation between): "we do not sell tradelines", "no deposit". */
const NEGATION = /(?:\b(?:no|not|never|nor|without|cannot|nothing|none|zero|neither)|n['’]t)\s+(?:[^\s.!?;:,]+\s+){0,3}$/i;
const negated = (text: string, at: number) => NEGATION.test(text.slice(Math.max(0, at - 60), at));
/**
 * The same, through a list: "we do not sell tradelines, credit privacy numbers or new credit identities". A comma may
 * come between, but not a new clause ("no refunds, we sell tradelines" is not negated).
 */
const NEGATED_LIST = /(?:\b(?:no|not|never|nor|without|cannot|neither)|n['’]t)\s+(?:(?!(?:but|however|yet|although|though|except|instead|we|you|they|i|it|he|she|our|your|their|us)\b)[^\s.!?;:]+\s+){0,8}$/i;
const negatedList = (text: string, at: number) => NEGATED_LIST.test(text.slice(Math.max(0, at - 100), at));

/** A removal verb in a request: "ask the bureaus to correct or delete…", "requesting the deletion of…". Describes the work, promises nothing. */
const REQUESTED = /\b(?:ask(?:s|ed|ing)?|request(?:s|ed|ing)?|petition(?:s|ed|ing)?)\b[^.!?;]{0,100}\bto\s+(?:\w+\s+(?:or|and|and\/or)\s+)?$|\b(?:request(?:s|ed|ing)?|seek(?:s|ing)?|ask(?:s|ed|ing)?\s+for)\s+(?:the\s+|their\s+|its\s+)?$/i;

type Exempt = 'none' | 'negation' | 'disclaimer';
/** `credit`: a removal rule, which in a contract counts only when what is removed is on a credit report (aboutCredit). */
interface ContractRule { id: string; pattern: RegExp; why: string; exempt: Exempt; credit?: boolean }

const COUNT = String.raw`(?:\d{1,3}(?:,\d{3})+|\d+|a few|several|many|dozens|hundreds|thousands|two|three|four|five|six|seven|eight|nine|ten|twelve|fifteen|twenty)`;
const ITEMS = String.raw`(?:items?|accounts?|negatives?|entries|marks?|collections?|late\s+payments?|inquir(?:y|ies)|charge[\s-]?offs?|bankruptc(?:y|ies)|judgments?|liens?|repossessions?|foreclosures?|tradelines?)`;
const GONE = String.raw`(?:removed|deleted|erased|wiped(?:\s+(?:off|out|clean))?|taken\s+(?:off|down)|knocked\s+off|cleared(?:\s+(?:off|up))?)`;
const REMOVE_WE = String.raw`(?:remov|delet|eras|wip)(?:e|es|ed|ing)?`;

/*
 * What a removal is about. In a contract, removing or deleting something is a promise of a result only when that thing
 * is on a credit report. An agency also states what it does with its own records ("when you close your account, we
 * delete your documents within 30 days"): that is a data practice, and passes.
 *  - REPORT_ITEM: words that name what is on a credit report wherever they stand: items, entries, negative items,
 *    collections, late payments, inquiries, charge-offs, bankruptcies, judgments, liens, tradelines, debts, errors, bad
 *    credit, anything negative or derogatory;
 *  - QUALIFIED_ITEM: an account or information only when it is described as such an item ("negative accounts",
 *    "inaccurate information", "collection accounts"). "Your account" alone is the client's account with the agency;
 *  - ON_REPORT: anything taken "from your credit report", "off your reports", "on your credit file".
 */
const REPORT_ITEM = String.raw`(?:items?|entries|marks?|negatives|collections?|late\s+payments?|inquir(?:y|ies)|charge[\s-]?offs?|bankruptc(?:y|ies)|judgments?|liens?|repossessions?|foreclosures?|tradelines?|debts?|errors?|mistakes?|bad\s+credit|negative\s+[\w-]+|derogator\w+)`;
const QUALIFIED_ITEM = String.raw`(?:(?:inaccurate|incorrect|erroneous|unverifiable|unverified|outdated|obsolete|disputed|delinquent|adverse|past[\s-]due|charged[\s-]off|late|collection)\s+(?:[\w-]+\s+)?(?:accounts?|information|records?|data|entries|histor(?:y|ies))|credit\s+accounts?)`;
const REPORT_DET = String.raw`(?:(?:your|the|their|a|his|her|my|each|every|all|any|both|these|those)\s+)?`;
const BUREAU = String.raw`(?:credit|consumer|bureau|experian|equifax|transunion)`;
const ON_REPORT = String.raw`(?:(?:on|from|off|in|out\s+of)\s+${REPORT_DET}(?:(?:three|3|${BUREAU})\s+){0,2}reports?|(?:on|from|off|in|out\s+of)\s+${REPORT_DET}(?:(?:three|3)\s+)?${BUREAU}\s+(?:files?|histor(?:y|ies)|records?|profiles?))`;
const ABOUT_CREDIT = new RegExp(String.raw`\b(?:${QUALIFIED_ITEM}|${REPORT_ITEM}|${ON_REPORT})\b`, 'i');
/** Where the words a removal is about stop: the end of a sentence or a clause (a comma that is not inside "1,200"). */
const CLAUSE_END = /[!?;:]|(?<!\d)[.,]|[.,](?!\d)/;

/**
 * Whether a removal found at text[at, end) is about something on a credit report: in its clause, the words just before
 * it ("items deleted within 45 days", "…negative items, to get them taken off"), the match itself, or the words just
 * after it ("we will delete your collections"). "We delete your documents within 30 days" and "we delete your account"
 * are not.
 */
function aboutCredit(text: string, at: number, end: number): boolean {
  return !dataPractice(text, at, end);
}

/*
 * A removal is a data practice, and passes in a contract, only when its clause names the agency's own records (the
 * client's documents, uploads, copies, data or personal information, card or payment details, or their account with
 * the agency) and nothing on a credit report: no bureau, no "credit" (other than a credit card), no report, no item,
 * account or debt of the kind a report lists. Everything else that is removed or deleted is read as a promise. So "we
 * delete your documents within 30 days of your request" and "we delete copies of your credit reports when you ask"
 * pass, while "we remove accounts from Experian, Equifax and TransUnion", "we will delete hard pulls within 30 days" and
 * "we delete your account from your credit report" do not.
 */
const OWN_RECORD = /\b(?:documents?|uploads?|uploaded\s+files?|data|personal\s+(?:information|data|details)|cop(?:y|ies)\s+of|(?:credit\s+|debit\s+)?card\s+(?:information|details|numbers?)|payment\s+(?:information|details)|photos?\s+of\s+your\s+id|your\s+id\b|identification\s+documents?|your\s+(?:portal\s+|user\s+|online\s+|client\s+)?account(?!s)\b)/i;
/** Own-record phrases that contain a credit word, set aside before looking for one: "copies of your credit reports", "credit card details". */
const OWN_WITH_CREDIT_WORD = /\bcop(?:y|ies)\s+of\s+(?:[\w'’-]+\s+){0,3}?(?:credit\s+)?reports?\b|\b(?:credit|debit)\s+card\s+(?:information|details|numbers?)\b/gi;
const CREDIT_HINT = new RegExp(String.raw`\b(?:${QUALIFIED_ITEM}|${REPORT_ITEM}|${ON_REPORT})\b|\b(?:credit|bureaus?|equifax|experian|transunion|reports?|accounts|loans?|bills?|repos?|evictions?|hard\s+pulls?|tradelines?|inquir\w*)\b`, 'i');

function dataPractice(text: string, at: number, end: number): boolean {
  const before = text.slice(Math.max(0, at - 100), at).split(CLAUSE_END).pop()!;
  const after = text.slice(end, end + 80).split(CLAUSE_END)[0]!;
  const clause = `${before}${text.slice(at, end)}${after}`;
  return OWN_RECORD.test(clause) && !CREDIT_HINT.test(clause.replace(OWN_WITH_CREDIT_WORD, ' '));
}

/** What "we remove …" must remove to be a promise: an item on a credit report (the same three kinds as ABOUT_CREDIT). */
const CREDIT_OBJECT = String.raw`(?:(?:your|the|any|all|every|those|these|its|their|negative|bad|old|inaccurate|unverifiable|outdated|derogatory|such)\s+){0,3}(?:${QUALIFIED_ITEM}|${REPORT_ITEM}|(?:[\w'’-]+\s+){1,3}?${ON_REPORT})`;
const CONTRACT_RULES: ContractRule[] = [
  // In a contract the marketing check's two broadest rules are read more narrowly, so that ordinary terms pass ("we
  // delete your documents when you ask", "you get a letter each time…", "you may qualify for a refund"):
  // a first-person removal of something on a credit report, or "get … removed" about such a thing.
  { id: 'removal-promise', pattern: new RegExp(String.raw`\bwe\s+(?:can\s+|will\s+|['’]ll\s+|also\s+|then\s+|simply\s+|quickly\s+)?${REMOVE_WE}\s+(?:${CREDIT_OBJECT}|(?:[\w'’-]+\s+){0,4}?(?:accounts?|bills?|loans?|repos|repossessions?|evictions?|(?:hard\s+)?pulls?)\b|[^.!?]{0,60}?\b(?:from|off)\s+(?:(?:your|the|all|each|every|both)\s+)?(?:(?:three|3)\s+)?(?:credit|bureaus?|equifax|experian|transunion|reports?)\b)|\b(?:get|gets|getting|got)\s+(?:[\w'’-]+\s+){0,4}?${GONE}\b`, 'gi'), why: 'Do not promise that an item will be removed.', exempt: 'disclaimer', credit: true },
  { id: 'approval-promise', pattern: /\b(?:get|getting)\s+(?:you\s+)?approved\b|\bpre-?approved\b|\bqualify\s+for\s+(?:a\s+|an\s+|the\s+|your\s+)?(?:[\w-]+\s+){0,2}?(?:loans?|mortgages?|credit|cards?|cars?|auto|homes?|houses?|apartments?|leases?|financing|rates?)\b/gi, why: 'Do not promise a loan or credit approval.', exempt: 'disclaimer' },
  // "5 to 10 items removed", "over 1,200 negative items deleted for our clients", "removed 300 accounts".
  { id: 'removal-count', pattern: new RegExp(String.raw`\b${COUNT}(?:\s*(?:\+|%|percent)|\s+(?:to|or|-|–)\s+${COUNT})?\s+(?:of\s+)?(?:[\w-]+\s+){0,3}?${ITEMS}\b[^.!?]{0,30}\b${GONE}\b|\b(?:removed|deleted|erased)\s+(?:over\s+|more\s+than\s+|about\s+|nearly\s+)?${COUNT}\s+(?:[\w-]+\s+){0,2}?${ITEMS}\b`, 'gi'), why: 'Do not state how many items are removed.', exempt: 'disclaimer' },
  // "items deleted within 30 days", "removed in as little as 45 days" (not "we delete your documents within 30 days").
  { id: 'removal-timed', pattern: new RegExp(String.raw`\b(?:remov|delet|eras|wip)\w*\b[^.!?]{0,40}\b(?:in|within|under)\s+(?:as (?:little|few) as\s+|just\s+|only\s+|less than\s+)?${NUM}\s+${PERIOD}\b`, 'gi'), why: 'Do not promise results within a time frame.', exempt: 'disclaimer', credit: true },
  // "we clean up your credit", "a clean credit report", "a clean slate".
  { id: 'clean-credit', pattern: /\bclean(?:s|ed|ing)?\s+(?:up\s+)?(?:your\s+|the\s+|a\s+)?(?:credit|reports?|file|history)\b|\bclean\s+slate\b|\bwip(?:e|es|ed|ing)\s+(?:your\s+|the\s+)?(?:credit|reports?|file|history|slate)\s+clean\b/gi, why: 'Do not promise a clean credit report.', exempt: 'disclaimer' },
  // Disputing accurate information as if it were wrong: "we challenge accurate negative items", "including accurate late payments".
  { id: 'dispute-accurate', pattern: new RegExp(String.raw`\b(?:disput|challeng|contest)\w*\b[^.!?]{0,60}\b(?:(?:accurate|valid|legitimate|verified)\s+(?:negative\s+|late\s+)?(?:${ITEMS}|information|debts?|records?)|(?:even\s+(?:if|when|though)\s+(?:they|it|the\s+\w+)\s+(?:are|is)|(?:that|which)\s+(?:are|is))\s+(?:accurate|valid|legitimate|verified)\b)`, 'gi'), why: 'Do not offer to dispute information that is accurate.', exempt: 'negation' },
];

/**
 * The first match of a rule that is a claim: not negated (or disclaimed) where the rule allows that, and, for a removal
 * rule (`credit`), about something on a credit report.
 */
function firstClaim(text: string, pattern: RegExp, exempt: Exempt, credit = false): RegExpMatchArray | null {
  const re = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
  for (const m of text.matchAll(re)) {
    if (exempt === 'negation' && negatedList(text, m.index!)) continue;
    if (exempt === 'disclaimer' && (negated(text, m.index!) || disclaimed(text, m.index!))) continue;
    if (credit && !aboutCredit(text, m.index!, m.index! + m[0].length)) continue;
    return m;
  }
  return null;
}

/** The removal check of removalIssue, for a contract: an honest negation, disclaimer or request ("ask the bureaus to delete…") is no promise. */
function contractRemovalIssue(text: string): ClaimIssue | null {
  for (const m of text.matchAll(REMOVAL)) {
    const verb = m[1] ?? m[2]!;
    const at = m.index + m[0].toLowerCase().indexOf(verb.toLowerCase(), m[1] ? 0 : 1);
    const before = text.slice(Math.max(0, at - 180), at);
    if (REMOVAL_NEGATED.test(before.slice(-40)) || negated(text, at) || disclaimed(text, at) || REQUESTED.test(before)) continue;
    return { id: 'removal-promise', why: 'Do not promise that an item will be removed.', excerpt: m[0].slice(0, 80) };
  }
  return null;
}

/** How each rule of findBlockedClaims and of the marketing check is read in a contract ('guarantee' is guaranteeIssue's). */
const BASE_EXEMPT: Record<string, Exempt> = {
  'certain-removal': 'disclaimer', 'remove-all': 'disclaimer', 'score-promise': 'none', 'fixed-time': 'disclaimer', '100pct': 'none', 'new-identity': 'negation',
  'accurate-removal': 'disclaimer', 'accurate-removal-2': 'disclaimer', 'legal-guarantee': 'disclaimer',
};
/** The removal rules of findBlockedClaims: in a contract they count only about an item on a credit report (aboutCredit). */
const BASE_REMOVAL = new Set(['certain-removal', 'remove-all', 'accurate-removal', 'accurate-removal-2', 'legal-guarantee']);
const MARKETING_EXEMPT: Record<string, Exempt> = {
  'score-number': 'none', 'score-promise': 'disclaimer', 'timed-result': 'disclaimer', 'result-promise': 'disclaimer', tradelines: 'negation', 'new-identity-es': 'negation',
};

/**
 * The claims check for the terms an agency writes into the service agreement its clients sign (Settings → Client
 * agreement, and a client's own payment terms). It reads every rule of findBlockedClaims and of the marketing check
 * except "free" (an ordinary payment term such as "no charge for paper copies" belongs in a contract), with the
 * removal and approval rules read for a contract (see CONTRACT_RULES), plus counts of items removed, removal in a set
 * time, a "clean" credit report and offers to dispute accurate information. A promise is refused; an honest negation
 * ("we do not sell tradelines"), disclaimer ("we cannot guarantee that any item will be deleted") or request ("we ask
 * the bureaus to correct or delete information that cannot be verified") is not. The removal rules count only when
 * what is removed is on a credit report (aboutCredit), so the agency can say how it deletes its own records ("we
 * delete your account and your documents within 30 days of your request"). Like the rest of this file it is a list of
 * rules: it catches the common promises, it does not make a contract lawful.
 */
export function findContractClaims(text: string): ClaimIssue[] {
  const issues: ClaimIssue[] = [];
  const add = (i: ClaimIssue | null) => { if (i && !issues.some((x) => x.why === i.why)) issues.push(i); };
  const read = (rules: { id: string; pattern: RegExp; why: string }[], exempt: (id: string) => Exempt, credit: (id: string) => boolean = () => false) => {
    for (const r of rules) {
      const m = firstClaim(text, r.pattern, exempt(r.id), credit(r.id));
      if (m) add({ id: r.id, why: r.why, excerpt: m[0].slice(0, 80) });
    }
  };
  add(guaranteeIssue(text));
  read(RULES.filter((r) => r.id !== 'guarantee'), (id) => BASE_EXEMPT[id] ?? 'none', (id) => BASE_REMOVAL.has(id));
  add(contractRemovalIssue(text));
  read(MARKETING_RULES.filter((r) => r.id in MARKETING_EXEMPT), (id) => MARKETING_EXEMPT[id]!);
  read(CONTRACT_RULES, (id) => CONTRACT_RULES.find((r) => r.id === id)!.exempt, (id) => !!CONTRACT_RULES.find((r) => r.id === id)!.credit);
  return issues;
}

const NO_PAYMENT = /\b(?:pay\s+nothing|owe\s+nothing|no\s+(?:\w+\s+)?(?:charges?|fees?|payments?|costs?)\b|not\s+be\s+(?:charged|billed)|free\s+of\s+charge|without\s+(?:charge|cost)|nothing\s+(?:is\s+)?(?:due|owed|charged))/i;
const PAYMENT_WORD = /\b(?:pay\w*|paid|charg\w*|fees?|due|bill\w*|collect\w*|invoic\w*|costs?|prices?)\b|\$\s?\d/i;
const ADVANCE_PAYMENT = /\b(?:deposits?|retainers?|down[\s-]?payments?|pre-?pa(?:id|y|ys|ying|yment|yments)|(?:set[\s-]?up|start[\s-]?up|enrol(?:l)?ment|sign(?:ing)?[\s-]?up|activation|initiation|onboarding|registration|joining)\s+(?:fees?|charges?|costs?|payments?))\b/gi;
/** The client signing: "you sign", "signing this agreement", "the agreement is signed", "enrollment". */
const SIGNING = String.raw`(?:(?:you|the\s+client)\s+sign(?:s|ed)?|signing|(?:this|the)\s+(?:agreement|contract)\s+is\s+signed|(?:you|the\s+client)\s+enrol(?:l)?(?:s|ed)?|enrol(?:l)?(?:ment|ing))`;
/** The day the agreement takes effect: "the effective date", "the date of this agreement", "execution of this agreement". */
const EFFECTIVE = String.raw`(?:(?:the\s+)?(?:effective|start(?:ing)?|commencement)\s+date|the\s+date\s+of\s+(?:this|the)\s+(?:agreement|contract)|(?:the\s+)?execution\s+of\s+(?:this|the)\s+(?:agreement|contract))`;
const ADVANCE_TIME = new RegExp(String.raw`\b(?:` + [
  String.raw`in\s+advance|up[\s-]?front|today`,
  String.raw`(?:immediately|right|just|directly)\s+after\s+(?:you\s+|the\s+client\s+)?sign\w*`,
  String.raw`(?:when|once|as\s+soon\s+as|upon|on|at|before|prior\s+to|by\s+the\s+time)\s+(?:you\s+|the\s+client\s+)?(?:sign(?:s|ing)?(?:\s+up)?|enrol(?:l)?(?:s|ed|ing|ment)?|join(?:s|ing)?|register(?:s|ing)?|registration)`,
  String.raw`at\s+(?:the\s+)?(?:time\s+of\s+)?(?:signing|sign[\s-]?up|enrol(?:l)?ment|registration)`,
  // "on the day you sign", "on the day of signing", "at the time you sign", "within 24 hours of signing", "within 3 days
  // of the effective date", "on the effective date", "upon execution of this agreement".
  String.raw`on\s+the\s+(?:same\s+)?(?:day|date)\s+(?:(?:that|of|on\s+which)\s+)?${SIGNING}`,
  String.raw`at\s+the\s+(?:same\s+)?time\s+(?:(?:that|of)\s+)?${SIGNING}`,
  String.raw`within\s+${NUM}\s+(?:(?:business|calendar)\s+)?(?:hours?|days?)\s+(?:of|after|from)\s+(?:${SIGNING}|${EFFECTIVE})`,
  // "due 48 hours after signing", "payable once the contract is signed", "due immediately", "pay $99 now to get
  // started", "required to begin services", "services begin once your first payment is received", "charged when your
  // account is opened".
  String.raw`(?:${NUM}\s+(?:(?:business|calendar)\s+)?hours?|(?:[1-7]|one|two|three|four|five|six|seven)\s+(?:(?:business|calendar)\s+)?days?)\s+(?:after|from)\s+(?:${SIGNING}|${EFFECTIVE})`,
  String.raw`(?:when|once|as\s+soon\s+as|upon)\s+(?:this|the)\s+(?:agreement|contract)\s+(?:is|has\s+been)\s+signed`,
  String.raw`due\s+immediately|(?:immediately|now)\s+(?:due|payable)|payable\s+immediately|(?:now|today)\s+to\s+(?:get\s+started|begin|start)`,
  String.raw`(?:required|needed|necessary)\s+(?:to|before\s+(?:we\s+)?(?:can\s+)?)\s*(?:begin|start|get\s+started|open|activate)`,
  String.raw`(?:begin|begins|start|starts)\s+(?:\w+\s+){0,2}?(?:once|when|after|upon)\s+(?:we\s+)?(?:receive|get|collect)\w*\s+(?:\w+\s+){0,3}?(?:payment|\$)`,
  String.raw`(?:begin|begins|start|starts)\s+(?:once|when|after|upon)\s+(?:\w+\s+){0,4}?payment\b[^.!?]{0,24}?\b(?:is|has\s+been)\s+received`,
  String.raw`when\s+(?:your\s+)?(?:account|file|case)\s+is\s+(?:opened|created|set\s+up|activated)`,
  String.raw`(?:on|upon|by|at)\s+${EFFECTIVE}`,
  // Billing at the start of a month for that month's work, which is not done yet: "charged at the beginning of each
  // month for that month's work", "on the 1st of each month for the month ahead" (not "on the 1st of each month for the
  // work fully performed in the month before").
  String.raw`(?:at|on)\s+the\s+(?:very\s+)?(?:beginning|start|first\s+day|1st|first)\s+of\s+(?:each|every|the|a)\s+(?:calendar\s+)?month\b[^.!?]{0,60}?\bfor\s+(?:(?:the\s+)?(?:work|services?)\s+(?:(?:to\s+be\s+)?(?:(?:fully|actually)\s+)?(?:done|performed|provided|delivered)\s+)?(?:(?:of|in|during|for|within)\s+)?)?(?:(?:that|this|the\s+same|the\s+current|the\s+coming|the\s+upcoming|the\s+next|the\s+following)\s+month|the\s+(?:month|period)\s+ahead)`,
  String.raw`(?:at|on)\s+the\s+(?:very\s+)?(?:beginning|start|first\s+day|1st|first)\s+of\s+(?:each|every|the|a)\s+(?:calendar\s+)?month\b[^.!?]{0,80}?\b(?:we\s+will\s+(?:do|perform|provide)|(?:to\s+be|that\s+will\s+be)\s+(?:done|performed|provided))`,
  // Before the work: "before work starts", "before we send your first letters", "prior to the start of the disputes".
  String.raw`(?:before|prior\s+to)\s+(?:(?:any|the|we|our|your|you|first|initial)\s+)?(?:\w+\s+){0,3}?(?:begin\w*|start\w*|work\w*|perform\w*|services?|disputes?|letters?)`,
].join('|') + String.raw`)\b`, 'gi');

/**
 * Payment asked for at or before signing, or in advance, which 15 U.S.C. § 1679b(b) forbids: no credit repair
 * organization "may charge or receive any money or other valuable consideration for the performance of any service …
 * before such service is fully performed". Read in the agency's contract terms. A deposit, retainer, prepayment or a
 * setup, enrollment, sign-up or activation fee is a payment wherever it is named; a time word counts when a payment
 * word (pay, charge, fee, due, bill, $…) is close to it in the same sentence:
 *  - at or before signing: when you sign, at signing, upon enrollment, today, on the day you sign, at the time you
 *    sign, within 24 hours of signing;
 *  - when the agreement takes effect: on the effective date, within 3 days of the effective date, upon execution;
 *  - before the work: up front, in advance, before work starts, before we send your first letters, and billing at the
 *    start of a month for that month's work.
 * A negation right before it is honest wording and passes: "there is no setup fee", "nothing is charged when you
 * sign", "we never charge in advance"; so do "charged at the end of each month for the work fully performed that month"
 * and "billed after each round of letters has been sent". A list of rules, like the claims check: it catches the
 * common wordings.
 */
export function findAdvanceFee(text: string): ClaimIssue | null {
  const why = 'This asks for payment before the work it pays for is done. Federal law (15 U.S.C. § 1679b(b)) does not allow charging for a service before it is fully performed.';
  for (const m of text.matchAll(ADVANCE_PAYMENT)) {
    if (!negated(text, m.index)) return { id: 'advance-fee', why, excerpt: m[0] };
  }
  for (const m of text.matchAll(ADVANCE_TIME)) {
    if (negated(text, m.index)) continue;
    // "If you cancel before the work starts, you pay nothing": a cancellation condition, not a time to pay.
    if (/\bcancel\w*\b/i.test(text.slice(Math.max(0, m.index - 120), m.index).split(SENTENCE_END).pop()!)) continue;
    // A payment word in the same sentence, close to the time word: "$99 is charged today", "due when you sign".
    const before = text.slice(Math.max(0, m.index - 60), m.index).split(SENTENCE_END).pop()!;
    const after = text.slice(m.index + m[0].length, m.index + m[0].length + 50).split(SENTENCE_END)[0]!;
    if (!PAYMENT_WORD.test(before) && !PAYMENT_WORD.test(after) && !PAYMENT_WORD.test(m[0])) continue;
    // "…at no charge", "no fee is due", "you will not be charged": the only payment named is none.
    if (NO_PAYMENT.test(`${before.split(/[;:,]/).pop()} ${m[0]} ${after.split(/[;:,]/)[0]}`)) continue;
    return { id: 'advance-fee', why, excerpt: m[0] };
  }
  return null;
}
