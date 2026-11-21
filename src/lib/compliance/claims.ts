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
 * "yet", "instead", "so" or "then" between it and the claim, and no new clause ("we cannot guarantee results, and we
 * will remove…", "no promises, we remove…").
 */
const DISCLAIMER = new RegExp(String.raw`\b(?:(?:cannot|can not|can['’]?t|could not|couldn['’]?t|do not|don['’]?t|does not|doesn['’]?t|did not|will not|won['’]?t|never|not|no one can|nobody can|no company can)\s+(?:\w+\s+){0,2}?(?:guarantee|promise|predict|claim|represent|assure|warrant|say|know|tell)\w*|(?:no|without|not a|not any|never a)\s+(?:\w+\s+)?(?:guarantees?|promises?|representations?|assurances?|warrant(?:y|ies)|predictions?)|nothing\s+(?:(?:in|of)\s+(?:this|the|our)\s+[\w-]+\s+)?(?:promises?|guarantees?|assures?|warrants?|represents?|predicts?))\b(?:(?!\b(?:but|however|yet|although|though|except|instead|so|then)\b|,\s*(?:(?:and|so|then)\s+)?(?:we|you|they|our|i)\b|\band\s+(?:we|you|they|our|i)\b)[^!?;]){0,100}$`, 'i');
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

/**
 * A removal verb in a request: "ask the bureaus to correct or delete…", "requesting the deletion of…", "we request
 * that the bureaus delete…", "demand verification or deletion", "we dispute the items you select for correction or
 * deletion". Describes the work, promises nothing.
 */
const REQUESTED = /\b(?:ask(?:s|ed|ing)?|request(?:s|ed|ing)?|petition(?:s|ed|ing)?)\b[^.!?;]{0,100}\bto\s+(?:(?:consider|kindly|please|promptly)\s+)?(?:(?:[\w'’-]+\s+){1,3}?(?:or|and|and\/or)\s+)?$|\b(?:request(?:s|ed|ing)?|seek(?:s|ing)?|ask(?:s|ed|ing)?\s+for|demand(?:s|ed|ing)?)\s+(?:the\s+|their\s+|its\s+)?(?:(?:[\w'’-]+\s+){1,3}?(?:or|and|and\/or)\s+)?$|\b(?:disput|challeng|contest|submit)\w*\b[^.!?;]{0,80}\bfor\s+(?:possible\s+)?(?:(?:[\w'’-]+\s+){1,3}?(?:or|and|and\/or)\s+)?$|\b(?:ask(?:s|ed|ing)?|request(?:s|ed|ing)?|demand(?:s|ed|ing)?)\s+that\s+(?:[\w'’-]+\s+){1,6}?(?:\w+\s+(?:or|and|and\/or)\s+)?$/i;

type Exempt = 'none' | 'negation' | 'disclaimer';
/** `credit`: a removal rule, which in a contract counts only when what is removed is on a credit report (aboutCredit). */
interface ContractRule { id: string; pattern: RegExp; why: string; exempt: Exempt; credit?: boolean }

const COUNT = String.raw`(?:\d{1,3}(?:,\d{3})+|\d+|a few|several|many|dozens|hundreds|thousands|two|three|four|five|six|seven|eight|nine|ten|twelve|fifteen|twenty)`;
const ITEMS = String.raw`(?:items?|accounts?|negatives?|entries|marks?|collections?|late\s+payments?|inquir(?:y|ies)|charge[\s-]?offs?|bankruptc(?:y|ies)|judgments?|liens?|repossessions?|foreclosures?|tradelines?)`;
const GONE = String.raw`(?:removed|deleted|erased|wiped(?:\s+(?:off|out|clean))?|taken\s+(?:off|down)|knocked\s+off|cleared(?:\s+(?:off|up))?)`;
const REMOVE_WE = String.raw`(?:remov|delet|eras|wip)(?:e|es|ed|ing)?`;

/*
 * What a removal is about. In a contract, removing or deleting something is a promise of a result unless it is the
 * agency's own record ("when you close your account, we delete your documents within 30 days"): that is a data practice,
 * and passes. These words name what is on a credit report:
 *  - REPORT_ITEM: items, entries, negative items, collections, late payments, inquiries, charge-offs, bankruptcies,
 *    judgments, liens, tradelines, debts, errors, bad credit, anything negative or derogatory;
 *  - QUALIFIED_ITEM: an account or information described as such an item ("negative accounts", "inaccurate
 *    information", "collection accounts");
 *  - ON_REPORT: anything taken "from your credit report", "off your reports", "on your credit file".
 */
const REPORT_ITEM = String.raw`(?:items?|entries|marks?|negatives|collections?|late\s+payments?|inquir(?:y|ies)|charge[\s-]?offs?|bankruptc(?:y|ies)|judgments?|liens?|repossessions?|foreclosures?|tradelines?|debts?|errors?|mistakes?|bad\s+credit|negative\s+[\w-]+|derogator\w+)`;
const QUALIFIED_ITEM = String.raw`(?:(?:inaccurate|incorrect|erroneous|unverifiable|unverified|outdated|obsolete|disputed|delinquent|adverse|past[\s-]due|charged[\s-]off|late|collection)\s+(?:[\w-]+\s+)?(?:accounts?|information|records?|data|entries|histor(?:y|ies))|credit\s+accounts?)`;
const REPORT_DET = String.raw`(?:(?:your|the|their|a|his|her|my|each|every|all|any|both|these|those)\s+)?`;
const BUREAU = String.raw`(?:credit|consumer|bureau|experian|equifax|transunion)`;
const ON_REPORT = String.raw`(?:(?:on|from|off|in|out\s+of)\s+${REPORT_DET}(?:(?:three|3|${BUREAU})\s+){0,2}reports?|(?:on|from|off|in|out\s+of)\s+${REPORT_DET}(?:(?:three|3)\s+)?${BUREAU}\s+(?:files?|histor(?:y|ies)|records?|profiles?))`;

/**
 * Where the words a removal is about stop: the end of a sentence, ";" or ":", "but", "however", "then", "so" and the
 * like, and a comma, "and" or "or" that starts a new clause ("…, and we also remove…", "…, then we…", "…, such as…").
 * A comma inside a list ("your documents, your messages and your notes") or a number ("1,200") does not.
 */
const NEW_CLAUSE = String.raw`(?:we|you|they|it|he|she|i|our|this|that|these|those|which|who|where|such\s+as|including|if|when|once|after|before|unless|except|while|because|so|then|but)\b`;
const CLAUSE_STOP = new RegExp(String.raw`[!?;:]|(?<!\d)\.|\.(?!\d)|,\s*(?:(?:and|or|but|then|so|yet)\s+)?(?=${NEW_CLAUSE})|\b(?:but|however|then|so|yet|although|though|while|because|whereas)\b|\b(?:and|or)\s+(?=(?:we|you|they|it|our|i)\b)`, 'i');

/** The clause a word at text[at, end) stands in (CLAUSE_STOP), the parts of it before and after the word, and its sentence. */
function removalScope(text: string, at: number, end: number): { before: string; after: string; clause: string; sentence: string } {
  const word = text.slice(at, end);
  // Cut with the word in place, so that "… and we will delete" stops at "and" when "we" starts the word.
  const last = text.slice(Math.max(0, at - 160), end).split(CLAUSE_STOP).pop()!;
  const before = last.endsWith(word) ? last.slice(0, last.length - word.length) : text.slice(Math.max(0, at - 160), at).split(CLAUSE_STOP).pop()!;
  const after = text.slice(end, end + 160).split(CLAUSE_STOP)[0]!;
  const sentence = `${text.slice(Math.max(0, at - 240), at).split(SENTENCE_END).pop()!}${word}${text.slice(end, end + 240).split(SENTENCE_END)[0]!}`;
  return { before, after, clause: `${before}${word}${after}`, sentence };
}

/** The agency's own places: "from our servers", "in our billing system", "from our mailing list", "from your portal". */
const OWN_PLACE = String.raw`\b(?:from|in|on|off|out\s+of)\s+(?:(?:our|my)\s+(?:own\s+)?(?:systems?|servers?|storage|files?|records?|databases?|billing\s+systems?|(?:mailing|contact|email|marketing|call(?:ing)?|text(?:ing)?)\s+lists?|lists?|archives?|backups?|cloud|platform|app|website|site|software|offices?|portal|crm)|your\s+(?:portal|profile|workspace|dashboard|client\s+file|(?:portal|user|online|client|login)\s+account)|the\s+(?:client\s+)?(?:portal|app))\b`;
/*
 * The agency's own records: the client's documents, uploads, files, data, information, records, profile, messages,
 * notes, login, card, bank, billing or payment details, Social Security number, date of birth, ID, email address,
 * consent, copies of their reports, their portal or user account; and anything taken from the agency's own places.
 * "Your account" on its own is not one of them (ownAccount below).
 */
const OWN_RECORD = new RegExp(String.raw`\b(?:documents?|letters?|drafts?|versions?|uploads?|uploaded\s+(?:files?|documents?|images?|photos?)|files?|data|information|info|records|profiles?|messages?|e-?mails?|texts?|chats?|recordings?|voicemails?|notes?|logins?|credentials|passwords?|(?:personal|contact|account|billing|payment|bank(?:\s+account)?|card|login)\s+(?:information|data|details|info|numbers?|methods?|credentials)|cop(?:y|ies)\s+of|(?:credit\s+|debit\s+)?cards?|social\s+security\s+numbers?|ssns?|dates?\s+of\s+birth|photos?\s+of\s+your\s+id|your\s+id|ids?|identification(?:\s+documents?)?|email\s+address(?:es)?|phone\s+numbers?|consents?|authorizations?|(?:portal|user|online|client|login)\s+accounts?|account\s+with\s+us)\b|${OWN_PLACE}`, 'i');
/**
 * Own records whose words name something on a credit report, set aside before looking for one: "copies of your credit
 * reports", "the credit reports you uploaded", "credit card details", "bank account details", "bank statements".
 */
const OWN_WITH_CREDIT_WORD = /\bcop(?:y|ies)\s+of\s+(?:[\w'’-]+\s+){0,3}?(?:credit\s+)?reports?\b|\b(?:(?:the|your|any)\s+)?(?:credit\s+)?reports?\s+(?:that\s+|which\s+)?you\s+(?:upload(?:s|ed)?|sen[dt]|provided?|gave|give|share[ds]?)\b|\buploaded\s+(?:credit\s+)?reports?\b|\b(?:credit|debit)\s+cards?(?:\s+(?:information|details|numbers?|on\s+file))?\b|\bbank\s+(?:account\s+)?(?:details|information|info|numbers?|statements?)\b|\baccount\s+(?:information|details|settings|passwords?)\b|\b(?:portal|user|online|client|login)\s+accounts?\b/gi;
/**
 * Words of a credit file: the items above, the bureaus, the consumer reporting agencies (also ChexSystems, Early
 * Warning, LexisNexis, Innovis, SageStream, NCTUE), creditors, lenders, banks, collectors and furnishers, "credit",
 * reports, accounts, loans, bills, repos, evictions, hard pulls, public records, scores, information that cannot be
 * verified, and what the client disputes.
 */
const CREDIT_HINT = new RegExp(String.raw`\b(?:${QUALIFIED_ITEM}|${REPORT_ITEM}|${ON_REPORT})\b|\b(?:credit|bureaus?|equifax|experian|transunion|reports?|accounts|loans?|bills?|repos?|evictions?|hard\s+pulls?|tradelines?|inquir\w*|(?:consumer\s+|credit\s+)?reporting\s+agenc(?:y|ies)|cras?|chex\s?systems?|early\s+warning|lexis\s?nexis|innovis|sage\s?stream|nctue|creditors?|lenders?|banks?|collectors?|furnishers?|public\s+records?|scores?|fico)\b|\b(?:cannot|can\s+not|can['’]?t|could\s+not|couldn['’]?t)\s+be\s+verified\b|\bunverif\w*|\b(?:you|we|they)\s+disput\w*`, 'i');
/** "from <somewhere>" that is not the agency's own place, a time or a person: read as from a credit file ("from ChexSystems", "from the furnisher's records"). */
const FROM_ELSEWHERE = /\bfrom\s+(?!(?:our|my)\s|your\s+(?:portal|profile|workspace|dashboard|client\s+file|files?|(?:portal|user|online|client|login)\s+account)\b|(?:the\s+)?(?:client\s+)?(?:portal|app|platform|date|day|time|moment|end|start|beginning|outset|effective\s+date)\b|(?:the|your|our)\s+(?:documents?|uploads?|files?|settings|profile|messages?|account|billing|home|dashboard|letters?|disputes?)\s+(?:page|tab|screen|section|folder|menu)\b|(?:now|then|today|signing|when|you|us|them|it|this|that|day|time)\b)[\w'’$-]+/i;
/** The client's account at a creditor or an agency: "your account with Capital One", "your accounts at the bank". */
const ACCOUNT_ELSEWHERE = /\byour\s+(?:[\w'’&-]+\s+){0,3}?accounts?\s+(?:(?:with|from)\s+(?!us\b)|at\s+(?!(?:any|once|no|all|least|times?|first|us)\b|the\s+(?:end|same|time|start|moment)\b))/i;
const YOUR_ACCOUNT = /\byour\s+account\b/i;
/** The agency named as the other side: "your account with us", "by writing to us", "ask us". */
const WITH_US = /\b(?:with|to)\s+us\b|\b(?:ask|asks|asked|asking|tell|tells|telling|contact|contacts|contacting|email|emails|emailing|writ(?:e|es|ing)|call|calls|calling)\s+(?:to\s+)?us\b/i;
/** Closing the account or ending the agreement: "when you close your account", "when you cancel", "when this agreement ends". */
const CLOSING = /\b(?:when|once|after|if|upon|as\s+soon\s+as)\s+(?:you\s+)?(?:close|closes|closed|closing|cancel\w*|end|ends|ended|terminat\w*|leave|leaves|left|quit\w*)\b|\b(?:agreement|contract|services?|subscription|membership|plan)\s+(?:ends|ended|expires|expired|terminates|terminated|is\s+(?:cancel(?:l)?ed|terminated|over|closed|ended))\b|\bclos(?:e|es|ed|ing)\s+(?:your|the|this)\s+account\b|\bcancel\w*\s+(?:this|the|your)\s+(?:agreement|contract)\b/i;
/** "get … removed", "have … deleted": a result someone else brings about. */
const GET_GONE = /\b(?:get|gets|getting|got|have|has|had|having)\s+(?:[\w'’-]+\s+){0,4}?(?:removed|deleted|erased|wiped|taken\s+off|cleared)\b/i;
/**
 * "Your account" is the client's account with the agency only where the sentence says so: closing it ("when you close
 * your account", "when you cancel, we delete your account", "when this agreement ends"), or the agency as the other
 * side ("your account with us", "by writing to us"). Inside "get … removed" only the second counts.
 */
const ownAccount = (clause: string, sentence: string) =>
  YOUR_ACCOUNT.test(clause) && (GET_GONE.test(clause) ? WITH_US.test(sentence) : WITH_US.test(sentence) || CLOSING.test(sentence));

/** A list or a letter in the app, not a credit file: "remove any item from your dispute list", "take an item off the list". */
const IN_APP_LIST = /\b(?:from|off)\s+(?:your|the|our|this)\s+(?:dispute\s+)?(?:list|letters?|selection|queue|drafts?)\b/i;
const ON_CREDIT_FILE = /\b(?:from|off)\s+(?:(?:your|the|their|all|each|every|both)\s+)?(?:(?:three|3)\s+)?(?:credit|bureaus?|equifax|experian|transunion|reports?|files?)\b/i;

/** Whether the clause of a removal names anything on a credit file, once the agency's own records that use such words are set aside. */
function namesCredit(clause: string): boolean {
  const rest = clause.replace(OWN_WITH_CREDIT_WORD, ' ');
  return CREDIT_HINT.test(rest) || FROM_ELSEWHERE.test(rest) || ACCOUNT_ELSEWHERE.test(rest);
}

/*
 * A removal is a data practice, and passes in a contract, only when its clause names the agency's own records
 * (OWN_RECORD, the client's account with the agency) and nothing on a credit file (namesCredit): no bureau or other
 * consumer reporting agency, no creditor, no "credit" (other than a credit card), no report (other than the copies the
 * client gave), no item, account, loan or debt of the kind a report lists, and nothing taken "from" anywhere but the
 * agency's own systems. So "we delete your documents within 30 days of your request", "we delete the credit reports you
 * uploaded" and "your credit card is removed from our billing system" pass, while "we remove accounts from Experian",
 * "we delete your account with the original creditor" and "we remove your personal information from ChexSystems" do not.
 */
function dataPractice(text: string, at: number, end: number): boolean {
  const { before, after, clause, sentence } = removalScope(text, at, end);
  // A pronoun object right after the removal verb ("we keep your records for five years, then delete them", "… and
  // delete them within 60 days") and a passive with no subject of its own or a pronoun subject ("emails are kept for two
  // years and then deleted", "…, and then they are deleted") are read with their whole sentence.
  const verb = /\b(?:remov|delet|eras|wip|purg|expung)\w*/i.exec(text.slice(at, end));
  const object = verb ? text.slice(at + verb.index + verb[0].length, at + verb.index + verb[0].length + 40) : after;
  const scope = PRONOUN_OBJECT.test(object) || PASSIVE_LEAD.test(before) ? sentence : clause;
  if (IN_APP_LIST.test(scope) && !ON_CREDIT_FILE.test(scope)) return true;
  // A security freeze or fraud alert the client lifts, or their name taken off marketing lists or prescreened offers, is
  // neither a record of the agency's nor an item on a credit report.
  const rest = scope.replace(NOT_A_RESULT, ' ');
  if (rest !== scope && !namesCredit(rest)) return true;
  if (namesCredit(scope)) return false;
  return OWN_RECORD.test(scope) || scope.replace(OWN_WITH_CREDIT_WORD, ' ') !== scope || ownAccount(scope, sentence);
}

const PRONOUN_OBJECT = /^\s*(?:it|them|those|these|this|that|both|all\s+of\s+them)\b/i;
const PASSIVE_LEAD = /^\s*(?:(?:and|or|then|also|later|afterwards?)\s+)*(?:(?:they|it|these|those|both|all\s+of\s+them|each|which)\s+)?(?:(?:are|is|will\s+be|shall\s+be|get|gets|may\s+be|can\s+be|would\s+be|have\s+been|has\s+been)\s+)?(?:(?:then|also|permanently|securely|automatically|promptly)\s+)*$/i;
const FREEZE_AT = String.raw`(?:\s+(?:with|at|from|on)\s+(?:(?:each|every|all|the|both|any|your)\s+)?(?:(?:three|3)\s+)?(?:(?:credit|nationwide)\s+)?(?:bureaus?|equifax|experian|transunion|(?:consumer\s+|credit\s+)?reporting\s+agenc(?:y|ies)))?`;
const NOT_A_RESULT = new RegExp(String.raw`\b(?:security|credit)\s+freezes?${FREEZE_AT}|\bfraud\s+alerts?${FREEZE_AT}|\b(?:pre-?screened|firm)\s+(?:credit\s+)?offers?\b|\bopt(?:s|ed|ing)?[\s-]+out\b|\b(?:marketing|mailing|telemarketing|solicitation)\s+lists?\b`, 'gi');

/** Whether a removal found at text[at, end) is about something on a credit report: anything that is not a data practice. */
const aboutCredit = (text: string, at: number, end: number): boolean => !dataPractice(text, at, end);

/**
 * A statement of the law: the bureau "must correct or delete" information "that cannot be verified", "the law requires
 * it to correct or delete that item" (an obligation right before the verb, and information that cannot be verified in
 * the same sentence).
 */
const OBLIGED = /\b(?:must|shall|ha(?:s|ve)\s+to|(?:is|are)\s+(?:required|obligated|obliged)\s+to|(?:law|statute|act|fcra|regulations?|rules?)\s+(?:requires?|obligates?)\s+(?:[\w'’-]+\s+){0,3}?to)\s+(?:be\s+)?(?:(?:promptly|either)\s+)?(?:[\w-]+\s+(?:or|and|and\/or)\s+)?$/i;
const UNVERIFIED = /\b(?:cannot|can\s+not|can['’]?t|could\s+not|couldn['’]?t|unable\s+to|fails?\s+to|does\s+not|doesn['’]?t|do\s+not|don['’]?t|is\s+not|are\s+not|isn['’]t|aren['’]t)\s+(?:be\s+)?verif\w*|\bunverif\w*|\bnot\s+(?:be\s+)?verified\b/i;
/**
 * A condition or a question, not a promise: "if an item is deleted, we let you know", "the bureaus decide whether an
 * item is corrected, updated or deleted". The last "if" or "whether" of the sentence before the verb, with no comma
 * between, or only a list of what may happen ("is corrected, updated or …"). "If you sign today, we delete…" is no
 * condition on the removal.
 */
function hypothetical(before: string): boolean {
  let from = -1;
  for (const m of before.matchAll(/\b(?:if|whether)\b/gi)) from = m.index + m[0].length;
  if (from < 0) return false;
  const rest = before.slice(from);
  if (/[;:]/.test(rest)) return false;
  if (!rest.includes(',')) return true;
  return /^[^,]*\b(?:is|are|was|were|be|been|get|gets|got|to)\s+[\w-]+\s*,/i.test(rest) && /,\s*(?:[\w-]+\s*,\s*)*[\w-]+\s+(?:or|and)\s+$/i.test(rest);
}
/** What the client is told happened: "which items were deleted, updated or verified", "we tell you when an item has been deleted". */
const REPORTED = /(?:\b(?:which|what)|\b(?:tell|tells|told|let|lets|notify|notifies|inform|informs|show|shows|update|updates|email|emails|alert|alerts|see|know)\s+(?:you\s+)?(?:know\s+)?(?:when|whether|if|which|what|how\s+many))\s+(?:[\w'’-]+\s+){0,4}?(?:is|are|was|were|has\s+been|have\s+been|had\s+been|gets?|got)\s+(?:[\w-]+,?\s+(?:or\s+|and\s+)?){0,3}?$/i;
/**
 * The reporting periods of the law (15 U.S.C. § 1681c): most negative information may be reported for up to seven
 * years, a bankruptcy for ten.
 */
const OBSOLETE = /\b(?:after|for\s+(?:up\s+to\s+)?|up\s+to|older\s+than|more\s+than|beyond|past)\s+(?:seven|7|ten|10)(?:\s*(?:or|to|-|–)\s*(?:seven|7|ten|10))?\s+years\b/i;
/** A bureau or furnisher as the one who removes: "after which the bureau removes them", "a bureau that deletes an item". */
const BUREAU_SUBJECT = /\b(?:the\s+|a\s+|each\s+|any\s+)?(?:credit\s+)?(?:bureaus?|furnishers?|creditors?|(?:consumer\s+|credit\s+)?reporting\s+agenc(?:y|ies)|cras?|experian|equifax|transunion)\s+(?:(?:that|which|who)\s+)?(?:(?:must|will|shall|then|later|automatically|generally|usually|typically)\s+)?$/i;
/** Putting a deleted item back, which the law lets a bureau do only with notice (15 U.S.C. § 1681i(a)(5)(B)). */
const REINSERTED = /\b(?:re-?insert\w*|puts?\s+(?:it|them|the\s+\w+)\s+back|put\s+back|reappear\w*|reported\s+again)\b/i;
/**
 * A statement of the reporting law, not a promise: what a bureau does after the reporting period ("late payments stay on
 * your report for up to seven years, after which the bureau removes them"), what falls off after it with no one of the
 * agency's doing it ("most negative items fall off your report after seven years"), and the rule for putting a deleted
 * item back ("a bureau that deletes an item and later puts it back must notify you").
 */
function lawOfReporting(inSentence: string, before: string, clause: string, sentence: string): boolean {
  if (BUREAU_SUBJECT.test(inSentence) && (OBSOLETE.test(sentence) || (REINSERTED.test(sentence) && /\b(?:must|shall|required|law|fcra)\b/i.test(sentence)))) return true;
  return OBSOLETE.test(clause) && !/\b(?:we|our|us|i)\b/i.test(before) && !/\b(?:sooner|faster|quicker|earlier|quickly|right\s+away|instead\s+of\s+waiting)\b/i.test(sentence);
}
/**
 * A possible outcome, one of several: "a dispute can end with the item verified, updated or deleted", "a successful
 * dispute may lead to an item being corrected or removed".
 */
const MAY_LEAD = /\b(?:can|could|may|might)\s+(?:\w+\s+){0,2}?(?:end|result|lead|conclude)\w*\s+(?:with|in|to)\b[^;:]*$/i;
const OTHER_OUTCOME = /\b(?:verified|updated|corrected|confirmed|modified|changed|unchanged|kept|remains?|stays?|verification|update|correction)\b/i;
const possibleOutcome = (inSentence: string, sentence: string) => MAY_LEAD.test(inSentence) && OTHER_OUTCOME.test(sentence);
/** What a bureau or furnisher decides, named as a thing: "items the bureaus delete or update are shown in your portal". */
const BUREAU_DECIDES = /\b(?:items?|entries|accounts?|information|anything|everything|whatever|what)\s+(?:that\s+|which\s+)?(?:the\s+|a\s+|any\s+|each\s+)?(?:credit\s+)?(?:bureaus?|furnishers?|creditors?|lenders?|companies|company|agenc(?:y|ies)|consumer\s+reporting\s+agenc(?:y|ies)|experian|equifax|transunion|they)\s+(?:may\s+|might\s+|can\s+|could\s+|do\s+|does\s+|did\s+)?$/i;
/** What only a bureau or furnisher may do: "only the credit bureaus and furnishers can correct or delete information". */
const BUREAU_ACTS = /\b(?:credit\s+)?(?:bureaus?|furnishers?|creditors?|lenders?|consumer\s+reporting\s+agenc(?:y|ies)|companies\s+that\s+report(?:\s+to\s+(?:them|the\s+bureaus))?)\s+(?:can|may|might|could|decide\s+(?:whether\s+)?to)\s+(?:(?:[\w'’-]+\s+){1,2}?(?:or|and|and\/or)\s+)?$/i;
/** A removal named as the thing asked for: "removal requests", "deletion letters". */
const REMOVAL_REQUEST = /^\s*(?:requests?|letters?|disputes?|forms?)\b/i;
/** "There is no account we cannot remove": a negation of a negation is a promise. */
const DOUBLE_NEGATIVE = /\b(?:no|nothing|none|not\s+(?:a|an|one|any|a\s+single)|never\s+(?:a|an)|(?:is|are|was|were)n['’]t\s+(?:a|an|any|one))\s+(?:[\w'’-]+\s+){0,4}?(?:that\s+|which\s+)?(?:we|you|our\s+[\w-]+|they|i)\s+(?:cannot|can\s+not|can['’]?t|could\s+not|couldn['’]?t|are\s+unable\s+to|fail\s+to|won['’]?t|will\s+not|do\s+not|don['’]?t)\s+(?:be\s+able\s+to\s+)?$/i;
/** A negation that governs a removal verb: "we cannot remove", "accurate information cannot be removed"; not "there is no account we cannot remove", "not only do we remove", "we never fail to remove". */
function removalNegated(text: string, at: number): boolean {
  const before = text.slice(Math.max(0, at - 80), at);
  if (DOUBLE_NEGATIVE.test(before)) return false;
  if (/\bnot\s+only\s+(?:[^\s.!?;:,]+\s+){0,3}$/i.test(before)) return false;
  if (/\b(?:fail|fails|failed|stop|stops|hesitate|forget)\s+to\s+$/i.test(before)) return false;
  return REMOVAL_NEGATED.test(before.slice(-40)) || negated(text, at);
}

/**
 * A removal word that promises nothing: negated, disclaimed, requested ("we ask the bureaus to delete…", "we request
 * that the bureaus delete…", "removal requests"), a statement of the law, a condition or question, what the client is
 * told happened, or what a bureau decides. Whether what is removed is the agency's own record is dataPractice's.
 */
function removalExempt(text: string, at: number, end: number): boolean {
  const back = text.slice(Math.max(0, at - 200), at);
  const inSentence = back.split(SENTENCE_END).pop()!;
  const word = text.slice(at, end);
  if (removalNegated(text, at) || disclaimed(text, at) || REQUESTED.test(back)) return true;
  if (/(?:al|als|ion|ions)$/i.test(word) && REMOVAL_REQUEST.test(text.slice(end, end + 30))) return true;
  const { before, clause, sentence } = removalScope(text, at, end);
  if (OBLIGED.test(inSentence) && (UNVERIFIED.test(sentence) || OBSOLETE.test(sentence))) return true;
  if (lawOfReporting(inSentence, before, clause, sentence) || possibleOutcome(inSentence, sentence)) return true;
  return hypothetical(inSentence) || REPORTED.test(inSentence) || BUREAU_DECIDES.test(inSentence) || BUREAU_ACTS.test(inSentence);
}

/**
 * For the removal rules of findBlockedClaims and CONTRACT_RULES (whose matches start before the verb): a condition, a
 * question, what a bureau decides or a statement of the law is no promise. Whether it is about the agency's own
 * records is aboutCredit's.
 */
const contextExempt = (text: string, at: number, end: number) => {
  const inSentence = text.slice(Math.max(0, at - 200), at).split(SENTENCE_END).pop()!;
  if (hypothetical(inSentence) || REPORTED.test(inSentence) || BUREAU_DECIDES.test(inSentence)) return true;
  const { before, clause, sentence } = removalScope(text, at, end);
  if (lawOfReporting(inSentence, before, clause, sentence) || possibleOutcome(inSentence, sentence)) return true;
  return /\b(?:must|shall|required|obligated|obliged|law|statute)\b/i.test(`${inSentence}${text.slice(at, end)}`) && (UNVERIFIED.test(sentence) || OBSOLETE.test(sentence));
};

/** What "we remove …" must remove to be a promise: an item on a credit report (the same three kinds as REPORT_ITEM, QUALIFIED_ITEM, ON_REPORT). */
const CREDIT_OBJECT = String.raw`(?:(?:your|the|any|all|every|those|these|its|their|negative|bad|old|inaccurate|unverifiable|outdated|derogatory|such)\s+){0,3}(?:${QUALIFIED_ITEM}|${REPORT_ITEM}|(?:[\w'’-]+\s+){1,3}?${ON_REPORT})`;
const CONTRACT_RULES: ContractRule[] = [
  // In a contract the marketing check's two broadest rules are read more narrowly, so that ordinary terms pass ("we
  // delete your documents when you ask", "you get a letter each time…", "you may qualify for a refund"):
  // a first-person removal of something on a credit report, or "get … removed" about such a thing.
  { id: 'removal-promise', pattern: new RegExp(String.raw`\bwe(?:['’](?:ll|re|ve)\b)?\s+(?:(?:can|will|are|have|also|then|just|simply|quickly|\w+ly|and)\s+){0,3}${REMOVE_WE}\s+(?:${CREDIT_OBJECT}|(?:[\w'’-]+\s+){0,4}?(?:accounts?|bills?|loans?|repos|repossessions?|evictions?|(?:hard\s+)?pulls?)\b|[^.!?]{0,60}?\b(?:from|off)\s+(?:(?:your|the|all|each|every|both)\s+)?(?:(?:three|3)\s+)?(?:credit|bureaus?|equifax|experian|transunion|reports?)\b)|\b(?:get|gets|getting|got)\s+(?:[\w'’-]+\s+){0,4}?${GONE}\b`, 'gi'), why: 'Do not promise that an item will be removed.', exempt: 'disclaimer', credit: true },
  { id: 'approval-promise', pattern: /\b(?:get|getting)\s+(?:you\s+)?approved\b|\bpre-?approved\b|\bqualify\s+for\s+(?:a\s+|an\s+|the\s+|your\s+)?(?:[\w-]+\s+){0,2}?(?:loans?|mortgages?|credit|cards?|cars?|auto|homes?|houses?|apartments?|leases?|financing|rates?)\b/gi, why: 'Do not promise a loan or credit approval.', exempt: 'disclaimer' },
  // "5 to 10 items removed", "over 1,200 negative items deleted for our clients", "removed 300 accounts".
  { id: 'removal-count', pattern: new RegExp(String.raw`\b${COUNT}(?:\s*(?:\+|%|percent)|\s+(?:to|or|-|–)\s+${COUNT})?\s+(?:of\s+)?(?:[\w-]+\s+){0,3}?${ITEMS}\b[^.!?]{0,30}\b${GONE}\b|\b(?:removed|deleted|erased)\s+(?:over\s+|more\s+than\s+|about\s+|nearly\s+)?${COUNT}\s+(?:[\w-]+\s+){0,2}?${ITEMS}\b`, 'gi'), why: 'Do not state how many items are removed.', exempt: 'disclaimer' },
  // "items deleted within 30 days", "removed in as little as 45 days" (not "we delete your documents within 30 days").
  { id: 'removal-timed', pattern: new RegExp(String.raw`\b(?:remov|delet|eras|wip)\w*\b[^.!?]{0,40}\b(?:in|within|under)\s+(?:as (?:little|few) as\s+|just\s+|only\s+|less than\s+)?${NUM}\s+${PERIOD}\b`, 'gi'), why: 'Do not promise results within a time frame.', exempt: 'disclaimer', credit: true },
  // "we clean up your credit", "a clean credit report", "a clean slate".
  { id: 'clean-credit', pattern: /\bclean(?:s|ed|ing)?\s+(?:up\s+)?(?:your\s+|the\s+|a\s+)?(?:(?:transunion|experian|equifax|innovis|chexsystems|bureau|consumer)\s+)?(?:credit|reports?|file|history)\b|\bclean\s+slate\b|\bwip(?:e|es|ed|ing)\s+(?:your\s+|the\s+)?(?:credit|reports?|file|history|slate)\s+clean\b/gi, why: 'Do not promise a clean credit report.', exempt: 'disclaimer' },
  // Disputing accurate information as if it were wrong: "we challenge accurate negative items", "including accurate late payments".
  { id: 'dispute-accurate', pattern: new RegExp(String.raw`\b(?:disput|challeng|contest)\w*\b[^.!?]{0,60}\b(?:(?:accurate|valid|legitimate|verified)\s+(?:negative\s+|late\s+)?(?:${ITEMS}|information|debts?|records?)|(?:even\s+(?:if|when|though)\s+(?:they|it|the\s+\w+)\s+(?:are|is)|(?:that|which)\s+(?:are|is))\s+(?:accurate|valid|legitimate|verified)\b)`, 'gi'), why: 'Do not offer to dispute information that is accurate.', exempt: 'negation' },
];

/**
 * The first match of a rule that is a claim: not negated (or disclaimed) where the rule allows that, and, for a removal
 * rule (`credit`), about something on a credit report and not a condition, a question or a statement of the law.
 */
function firstClaim(text: string, pattern: RegExp, exempt: Exempt, credit = false): RegExpMatchArray | null {
  const re = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
  for (const m of text.matchAll(re)) {
    if (exempt === 'negation' && negatedList(text, m.index!)) continue;
    if (exempt === 'disclaimer' && (negated(text, m.index!) || disclaimed(text, m.index!))) continue;
    if (credit && (!aboutCredit(text, m.index!, m.index! + m[0].length) || contextExempt(text, m.index!, m.index! + m[0].length))) continue;
    return m;
  }
  return null;
}

/*
 * Every word of a removal, in any tense, voice or person, and the nouns: remove, delete, erase, wipe, purge, expunge,
 * removal, deletion. In a contract each one is a promise unless removalExempt or dataPractice says otherwise.
 */
const REMOVAL_WORD = /\b(?:remov(?:e|es|ed|ing|als?)|delet(?:e|es|ed|ing|ions?)|eras(?:e|es|ed|ing|ure)|wip(?:e|es|ed|ing)|purg(?:e|es|ed|ing)|expung(?:e|es|ed|ing|ement))\b/gi;
/**
 * Words that also have ordinary meanings ("eliminate the guesswork", "take $10 off your first month", "make it clear
 * from the start", "we have gone through your file", "drop off your documents"), so they count only where their clause
 * names something on a credit file: eliminate; take, knock or get … off; come, fall, drop or roll off; clear … of or
 * from; disappear, vanish, go away, be gone, no longer appear, say goodbye to.
 */
const REMOVAL_IF_CREDIT = /\b(?:elimin(?:ate|ates|ated|ating|ation)|(?:tak(?:e|es|en|ing)|took|knock(?:s|ed|ing)?|get(?:s|ting)?|got)\s+(?:[\w'’$-]+\s+){0,4}?off|(?:come|comes|coming|came|fall|falls|falling|fell|drop|drops|dropping|dropped|roll|rolls|rolling|rolled)\s+off|clear(?:s|ed|ing)(?=(?:\s+[\w'’-]+){0,4}?\s+(?:of|from|off)\b)|(?<!\b(?:is|are|was|were|be|been|it|very|more|most|so|as|a|an|the|make|makes|made|keep|keeps|stay|stays|in|crystal|perfectly)\s+)clear(?=(?:\s+[\w'’-]+){0,4}?\s+(?:of|from|off)\b)|disappear\w*|vanish\w*|go(?:es|ing)?\s+away|(?:be|is|are|was|were|been|get|gets)\s+gone|no\s+longer\s+(?:appear\w*|show\w*|be\s+(?:reported|listed|shown))|say\s+goodbye\s+to)\b/gi;
/** "$10 off your first month", "20% off the fee": a discount, not a removal. */
const DISCOUNT = /^\s*(?:your|the|each|every|a|our)\s+(?:first\s+|next\s+|monthly\s+|total\s+)?(?:bill|invoice|fee|price|payment|total|month|cost|charge|plan)s?\b/i;
/** The Spanish removal words of the marketing check (eliminamos, vamos a eliminar, serán eliminadas, sacamos, …). */
const REMOVAL_ES = /(?<![\p{L}])(?:eliminaremos|borraremos|quitaremos|removeremos|sacaremos|eliminamos|borramos|quitamos|removemos|sacamos|(?:vamos\s+a|podemos|logramos|lograremos)\s+(?:eliminar|borrar|quitar|remover|sacar)|(?:ser[aá]n?|son|es|fue|fueron|han\s+sido|ha\s+sido|quedar[aá]n?)\s+(?:eliminad|borrad|quitad|removid|sacad)[oa]s?|se\s+(?:elimin|borr|quit|sac)(?:a|an|ar[aá]n?))(?![\p{L}])/giu;
const ES_NEGATED = /(?<![\p{L}])(?:no|nunca|jam[aá]s|nadie\s+puede|ninguna\s+empresa\s+puede)(?:\s+(?:le|les|se|lo|la|los|las|podemos|puede|pueden|vamos\s+a|va\s+a))*\s+$/iu;
/**
 * The other Spanish removal words (elimina, eliminar, eliminación, remueve, borra, desaparecerán, limpiar): a promise
 * only where the clause names a credit file (ES_CREDIT), like REMOVAL_IF_CREDIT.
 */
const REMOVAL_ES_IF_CREDIT = /(?<![\p{L}])(?:elimin(?:a|an|ar|ar[aá]n?|e|en|ando|aci[oó]n|aciones)|borr(?:a|an|ar|ar[aá]n?|e|en|ando)|quit(?:a|an|ar|ar[aá]n?|e|en|ando)|remov(?:er|er[aá]n?|iendo)|remuev(?:e|en|a|an)|remoci[oó]n|desaparec\p{L}*|limpi(?:a|an|ar|amos|aremos|ar[aá]n?))(?![\p{L}])/giu;
/** A Spanish disclaimer: "no podemos prometer que…", "no garantizamos que ninguna cuenta…", "nadie puede garantizar…". */
const ES_DISCLAIMER = /(?<![\p{L}])(?:no|nunca|jam[aá]s|nadie\s+puede|ninguna\s+empresa\s+puede)(?:\s+(?:le|les|te|se|lo|la|podemos|puede|pueden|vamos\s+a|va\s+a))*\s+(?:promet\p{L}*|garantiz\p{L}*|asegur\p{L}*|predec\p{L}*)(?:\s+(?:le|les|te))?(?:\s+que)?(?:\s+\p{L}+){0,5}\s+$/iu;
/** A Spanish request: "solicitamos a los burós que corrijan o eliminen…", "pedimos al buró la eliminación de…", "cartas de eliminación". */
const ES_REQUESTED = /(?<![\p{L}])(?:solicit|ped|pid|exig|requer|reclam)\p{L}*(?![\p{L}])[^.!?;]{0,100}?(?<![\p{L}])que\s+(?:\p{L}+\s+(?:o|y|u)\s+)?$|(?<![\p{L}])(?:solicit|ped|pid|exig|requer|reclam)\p{L}*(?![\p{L}])[^.!?;]{0,60}?(?<![\p{L}])(?:la|su|una)\s+$|(?<![\p{L}])(?:solicitud(?:es)?|petici[oó]n(?:es)?|cartas?)\s+de\s+$/iu;
/** A Spanish statement of the law: "deben corregir o eliminar la información que no se puede verificar". */
const ES_OBLIGED = /(?<![\p{L}])(?:debe|deben|tiene\s+que|tienen\s+que|est[aá]n?\s+obligad[oa]s?\s+a|(?:la\s+)?ley\s+(?:exige|obliga|requiere)\s+(?:\p{L}+\s+){0,4}?(?:a|que))\s+(?:\p{L}+\s+(?:o|y|u)\s+)?$/iu;
const ES_UNVERIFIED = /(?<![\p{L}])no\s+(?:se\s+)?pued[ea]n?\s+(?:ser\s+)?verific|no\s+verificad|(?:siete|7|diez|10)\s+años/iu;
/** A Spanish condition: "si el buró elimina un dato…", "cuando un buró borra…" (no comma between). */
const ES_IF = /(?<![\p{L}])(?:si|cuando)(?![\p{L}])[^,;:]*$/iu;
/** Whether a Spanish removal word at `at` is negated, disclaimed, requested, a statement of the law or a condition. */
function esExempt(text: string, at: number): boolean {
  const inSentence = text.slice(Math.max(0, at - 160), at).split(SENTENCE_END).pop()!;
  const sentence = `${inSentence}${text.slice(at, at + 200).split(SENTENCE_END)[0]!}`;
  if (ES_NEGATED.test(inSentence.slice(-40)) || ES_DISCLAIMER.test(inSentence) || ES_REQUESTED.test(inSentence) || ES_IF.test(inSentence)) return true;
  return ES_OBLIGED.test(inSentence) && ES_UNVERIFIED.test(sentence);
}
const ES_OWN = /(?<![\p{L}])(?:documentos?|archivos?|datos|informaci[oó]n\s+personal|fotos?|copias?|mensajes?|notas?|identificaci[oó]n|tarjeta|cuenta\s+(?:del\s+portal|de\s+usuario|con\s+nosotros))(?![\p{L}])/iu;
const ES_CREDIT = /(?<![\p{L}])(?:cr[eé]dito|reportes?|informes?|historial|bur[oó]s?|agencias?|equifax|experian|transunion|cuentas|deudas?|cobranzas?|colecciones|pr[eé]stamos|desalojos|consultas|negativ\p{L}*|morosidad|acreedor\p{L}*|bancos?|embargos?|quiebras?|bancarrotas?)(?![\p{L}])/iu;

/** A few words of the clause around a removal at text[at, end), for the message. */
function removalExcerpt(text: string, at: number, end: number): string {
  const { before, after } = removalScope(text, at, end);
  const lead = before.trim().split(/\s+/).filter(Boolean).slice(-3).join(' ');
  return `${lead ? `${lead} ` : ''}${text.slice(at, end)}${after.replace(/\s+$/, '')}`.trim().slice(0, 80);
}

/**
 * Removals in a contract, read the other way round from the marketing check: every removal word is a promise unless
 * it is negated, disclaimed, requested, a statement of the law, a condition or question, or about the agency's own
 * records (removalExempt, dataPractice). First the marketing check's removalIssue (a removal word beside a negative
 * item, with those exemptions), then every other removal word, then the words with ordinary meanings where their clause
 * names a credit file, then the Spanish ones.
 */
function contractRemovalIssue(text: string): ClaimIssue | null {
  const issue = (excerpt: string): ClaimIssue => ({ id: 'removal-promise', why: 'Do not promise that an item will be removed.', excerpt: excerpt.slice(0, 80) });
  for (const m of text.matchAll(REMOVAL)) {
    const verb = m[1] ?? m[2]!;
    const at = m.index + m[0].toLowerCase().indexOf(verb.toLowerCase(), m[1] ? 0 : 1);
    if (removalExempt(text, at, at + verb.length)) continue;
    return issue(m[0]);
  }
  for (const m of text.matchAll(REMOVAL_WORD)) {
    const end = m.index + m[0].length;
    if (removalExempt(text, m.index, end) || dataPractice(text, m.index, end)) continue;
    return issue(removalExcerpt(text, m.index, end));
  }
  for (const m of text.matchAll(REMOVAL_IF_CREDIT)) {
    const end = m.index + m[0].length;
    if (/off$/i.test(m[0]) && DISCOUNT.test(text.slice(end, end + 40))) continue;
    const { clause } = removalScope(text, m.index, end);
    if (removalExempt(text, m.index, end) || !namesCredit(clause) || (IN_APP_LIST.test(clause) && !ON_CREDIT_FILE.test(clause))) continue;
    return issue(removalExcerpt(text, m.index, end));
  }
  for (const m of text.matchAll(REMOVAL_ES)) {
    const end = m.index + m[0].length;
    const { clause, after } = removalScope(text, m.index, end);
    if (esExempt(text, m.index) || (ES_OWN.test(clause) && !ES_CREDIT.test(clause))) continue;
    // "Sacamos una copia de sus reportes": pulling a copy, not taking anything off.
    if (/^sac/i.test(m[0]) && /^\s+(?:(?:una?|las?|los|sus?)\s+)?(?:copias?|reportes?|informes?|puntajes?)(?![\p{L}])/iu.test(after)) continue;
    return issue(removalExcerpt(text, m.index, end));
  }
  for (const m of text.matchAll(REMOVAL_ES_IF_CREDIT)) {
    const end = m.index + m[0].length;
    const { clause } = removalScope(text, m.index, end);
    if (!ES_CREDIT.test(clause) || esExempt(text, m.index)) continue;
    return issue(removalExcerpt(text, m.index, end));
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
 * In a contract "you pay nothing when you sign" and "you pay nothing if you cancel" are payment terms, not the
 * marketing check's "pay nothing unless we get results".
 */
const CONTRACT_PATTERN: Record<string, RegExp> = {
  'result-promise': /\b(we|i)\s+promise\s+(you\s+)?(results?|deletions?|removals?|approval|a\s+(better|higher|clean))|\b(prometemos|le prometemos|te prometemos)\s+(resultados|eliminar|borrar|quitar|un)|\bmoney[\s-]+back\b|\bor\s+(you|they)\s+(do\s+not|don['’]?t|will\s+not|won['’]?t)\s+pay\b|\bpay\s+(nothing|only)\s+(if|unless|when)\b(?!\s+(?:you\s+|the\s+client\s+)?(?:sign|cancel|enrol|join|register))|\b(le|les|te)\s+devolvemos\b|\bdevoluci[oó]n\s+de(l)?\s+(su\s+|tu\s+)?dinero\b|\b100\s*%\s*(efectiv\w+|garantizad\w+|segur[oa]|de [eé]xito|[eé]xito)/i,
};

/**
 * The claims check for the terms an agency writes into the service agreement its clients sign (Settings → Client
 * agreement, and a client's own payment terms). It reads every rule of findBlockedClaims and of the marketing check
 * except "free" (an ordinary payment term such as "no charge for paper copies" belongs in a contract), with the
 * removal and approval rules read for a contract (see CONTRACT_RULES), plus counts of items removed, removal in a set
 * time, a "clean" credit report and offers to dispute accurate information. A promise is refused; an honest negation
 * ("we do not sell tradelines"), disclaimer ("we cannot guarantee that any item will be deleted") or request ("we ask
 * the bureaus to correct or delete information that cannot be verified") is not. Every removal word (remove, delete,
 * erase, wipe, purge, the nouns removal and deletion, in any tense, voice or person, and eliminate, take or knock off,
 * clear and disappear where the clause names a credit file) counts unless it is about the agency's own records
 * (dataPractice), so the agency can say how it deletes them ("we delete your account and your documents within 30 days
 * of your request", "emails are kept for two years and then deleted"). Requests and disclaimers ("we dispute the items
 * you select for correction or deletion", "nothing in this agreement promises…"), possible outcomes ("a dispute can end
 * with the item verified, updated or deleted"), statements of the reporting law (the seven-year period, a bureau that
 * puts a deleted item back) and a security freeze or opt-out the client asks for pass too; the Spanish removal words
 * are read the same way. Like the rest of this file it is a list of rules: it catches the common promises, it does not
 * make a contract lawful.
 */
export function findContractClaims(text: string): ClaimIssue[] {
  const issues: ClaimIssue[] = [];
  const add = (i: ClaimIssue | null) => { if (i && !issues.some((x) => x.why === i.why)) issues.push(i); };
  const read = (rules: { id: string; pattern: RegExp; why: string }[], exempt: (id: string) => Exempt, credit: (id: string) => boolean = () => false) => {
    for (const r of rules) {
      const m = firstClaim(text, CONTRACT_PATTERN[r.id] ?? r.pattern, exempt(r.id), credit(r.id));
      if (m) add({ id: r.id, why: r.why, excerpt: m[0].slice(0, 80) });
    }
  };
  add(guaranteeIssue(text));
  read(RULES.filter((r) => r.id !== 'guarantee'), (id) => BASE_EXEMPT[id] ?? 'none', (id) => BASE_REMOVAL.has(id));
  // A count of items removed says more than "a removal", so its message comes first ("5 to 10 items removed").
  read(CONTRACT_RULES.filter((r) => r.id === 'removal-count'), (id) => CONTRACT_RULES.find((r) => r.id === id)!.exempt);
  add(contractRemovalIssue(text));
  read(MARKETING_RULES.filter((r) => r.id in MARKETING_EXEMPT), (id) => MARKETING_EXEMPT[id]!);
  read(CONTRACT_RULES, (id) => CONTRACT_RULES.find((r) => r.id === id)!.exempt, (id) => !!CONTRACT_RULES.find((r) => r.id === id)!.credit);
  return issues;
}

// ---------------------------------------------------------------- payment asked for before the work (§ 1679b(b))

/** A word of paying or of a payment, in English or Spanish ("due to" is not one). */
const PAYMENT_WORD = /\b(?:pay\w*|paid|charg\w*|fees?|due(?!\s+to\b)|bill\w*|collect(?:s|ed|ing)?|invoic\w*|costs?|prices?)\b|(?<![\p{L}])(?:pag(?:o|os|a|as|an|ar|ará|arán|ue|uen|ado|ada)|cobr(?:o|a|an|amos|ar|ará|arán|ado|ada|e|en)|cuotas?|tarifas?|honorarios|cargos?|factur\p{L}*)(?![\p{L}])/iu;
/** An amount of money other than $0. */
const AMOUNT = /\$\s?(?!0+(?:\.0+)?\b)\d/;
const PAY_TERM = String.raw`(?:pay(?:s|ing|ment|ments|able)?|paid|charg(?:e|es|ed|ing)|fees?|due|bill(?:s|ed|ing)?|collect(?:s|ed|ing)?|invoic\w*|costs?|prices?|deposits?|retainers?|money|owe[ds]?|owing)`;
const LIGHT = String.raw`(?:is|are|was|were|be|been|being|ever|a|an|any|the|other|extra|additional|hidden|further|separate|set-?up|upfront|up-front|advance|enrol(?:l)?ment|sign-?up|monthly|first|initial|one-time|you|we|us|have|has|had|to|need|needs|required|asked|ask|for|or|accept|take|make|request|require|do|does|did|will|would|shall|can|may|must|yet|your|card|such|of|at|in|on)`;
/**
 * A payment that is named only to say there is none: "no payment is due", "no fee or deposit is due", "nothing is
 * charged", "you will not be charged", "we do not ask for or accept any payment", "you pay nothing", "costs nothing",
 * "free of charge", "$0". A cap is not one: "never more than $99", "we never charge over $99" (the amount stays).
 */
const NEGATED_PAYMENT = new RegExp(String.raw`(?:\b(?:no|not|never|nothing|none|without|neither|nor|zero)|n['’]t)\s+(?:${LIGHT}\s+){0,5}?${PAY_TERM}\b(?:\s+(?:or|nor)\s+(?:${LIGHT}\s+){0,2}?${PAY_TERM}\b)*(?:\s+(?:(?:is|are|will\s+be|shall\s+be|gets?)\s+)?(?:ever\s+)?(?:due|charged|owed|payable|collected|billed|required|taken|made|paid|accepted|requested))?|\b(?:pay|pays|owe|owes|cost|costs|charge|charges|bill|bills)\s+(?:you\s+)?(?:nothing|zero|\$\s?0+(?:\.0+)?)\b|\bfree\s+of\s+charge\b|\bno[\s-]cost\b|\$\s?0+(?:\.0+)?\b`, 'gi');
/**
 * The same in Spanish: "no cobramos nada", "nunca cobramos", "no se cobra nada", "no hay pagos", "ningún pago", "sin
 * cargos", "nada se cobra".
 */
const NEGATED_PAYMENT_ES = /(?<![\p{L}])(?:(?:no|nunca|jam[aá]s)(?:\s+(?:se|le|les|te|lo|la|hay|habr[aá]|existen?))*(?:\s+(?:cobr|pag|exig|requ|ped|pid|solicit|factur|carg)\p{L}*)?(?:\s+(?:nada|ning[uú]n|ninguna|ningunos|ningunas|otros?|otras?))?(?:\s+(?:pagos?|cargos?|cobros?|cuotas?|tarifas?|honorarios|dep[oó]sitos?|anticipos?|costos?))?|(?:ning[uú]n|ninguna)\s+(?:pago|cargo|cobro|cuota|tarifa|dep[oó]sito|anticipo|costo)|sin(?:\s+(?:ning[uú]n|ninguna|otros?|otras?))?\s+(?:pagos?|cargos?|cobros?|costos?|cuotas?|dep[oó]sitos?|anticipos?)|nada\s+(?:se\s+)?(?:cobra|paga|debe))(?![\p{L}])/giu;
/**
 * A payment that is stopped, not asked for: "we stop billing you right away", "billing stops immediately", "we will
 * stop all charges at once if you cancel".
 */
const STOPPED_PAYMENT = /\b(?:stop|stops|stopped|stopping|end|ends|ended|ending|cease[sd]?|ceasing|halt\w*|discontinu\w*|suspend\w*|pause[sd]?|pausing|cancel\w*)\s+(?:(?:all|any|the|your|our|further|future|recurring|monthly|automatic|scheduled)\s+){0,3}(?:charg\w*|bill\w*|collect\w*|draft\w*|debit\w*|payments?|withdrawals?)\b|\b(?:charg\w*|bill\w*|collections?|drafts?|debits?|payments?)\s+(?:(?:will|shall|would|is|are|also)\s+)?(?:stop|stops|stopped|end|ends|ended|cease[sd]?|halt\w*|(?:be\s+)?(?:cancel(?:l)?ed|discontinued|suspended|paused|stopped))\b/gi;
/** Whether a clause asks for a payment: a payment word or an amount, once the payments named as none, and fees only explained, are taken out. A refund owed to the client is no payment by them. */
const EXPLAINED_FEES = /\b(?:explain|describe|discuss|review|go\s+over|list|show\s+you|tell\s+you\s+about)\w*\s+(?:[\w'’-]+\s+){0,2}?(?:fees?|charges?|costs?|prices?|pricing|payments?|billing)\b/gi;
function asksPayment(clause: string): boolean {
  // "We explain our fees before we start work": a fee named as something explained, not as a payment (an amount stays).
  let rest = clause.replace(NEGATED_PAYMENT, ' ').replace(NEGATED_PAYMENT_ES, ' ').replace(STOPPED_PAYMENT, ' ').replace(EXPLAINED_FEES, ' ');
  if (/\brefund(?:s|ed)?\b/i.test(rest)) rest = rest.replace(/\b(?:due|payable|owed|owing|paid|pay\w*)\b|\$\s?\d[\d,]*(?:\.\d+)?/gi, ' ');
  return PAYMENT_WORD.test(rest) || AMOUNT.test(rest);
}

const ADVANCE_PAYMENT = /\b(?:deposits?|retainers?|down[\s-]?payments?|pre-?pa(?:id|y|ys|ying|yment|yments)|(?:set[\s-]?up|start[\s-]?up|enrol(?:l)?ment|sign(?:ing)?[\s-]?up|activation|initiation|onboarding|registration|joining)\s+(?:fees?|charges?|costs?|payments?)|dep[oó]sitos?|anticipos?|cuotas?\s+(?:de\s+)?(?:inscripci[oó]n|apertura|activaci[oó]n|afiliaci[oó]n|ingreso))(?![\p{L}])/giu;
/**
 * A negation of a fee right before it, at most six words back and through a list ("no setup fee", "no deposit or
 * retainer", "we do not charge a setup, enrollment or activation fee", "no se requiere ningún depósito"), but not a cap,
 * a list that goes on or a new clause ("never more than a $50 deposit", "no interest and a $50 deposit", "no refunds,
 * we take a deposit").
 */
const FEE_NEGATION = /(?:\b(?:no|not|never|nor|without|cannot|nothing|none|zero|neither|sin|nunca|ning[uú]n|ninguna)|\bjam[aá]s|n['’]t)(?=\s)/gi;
function feeNegated(before: string): boolean {
  for (const m of before.matchAll(FEE_NEGATION)) {
    const rest = before.slice(m.index + m[0].length);
    if (/[.!?;:]/.test(rest) || rest.trim().split(/\s+/).filter(Boolean).length > 6) continue;
    if (/\$|\b(?:and|but|more|over|than|above|beyond|exceed\w*|except|other|besides|only|just|y|pero|m[aá]s)\b|,\s*(?:we|you|they|it|i|our|their|the\s+client)\b/i.test(rest)) continue;
    return true;
  }
  return false;
}
/** The client signing: "you sign", "signing this agreement", "the agreement is signed", "enrollment" (never "sign in" to the portal). */
const SIGNING = String.raw`(?:(?:you|the\s+client)\s+sign(?:s|ed)?(?!\s+in(?:to)?\b)|(?:you(?:['’]ve|\s+have)|the\s+client\s+has)\s+signed(?!\s+in(?:to)?\b)|signing(?!\s+in(?:to)?\b)|(?:this|the)\s+(?:agreement|contract)\s+is\s+signed|(?:you|the\s+client)\s+enrol(?:l)?(?:s|ed)?|enrol(?:l)?(?:ment|ing))`;
/** The day the agreement takes effect: "the effective date", "your start date", "the date of this agreement", "execution of this agreement". */
const EFFECTIVE = String.raw`(?:(?:(?:the|your|this)\s+)?(?:effective|start(?:ing)?|commencement|enrol(?:l)?ment|sign(?:ing|-?up))\s+date|the\s+date\s+of\s+(?:this|the)\s+(?:agreement|contract)|(?:the\s+)?execution\s+of\s+(?:this|the)\s+(?:agreement|contract))`;
const PAYMENT_NOUN = String.raw`(?:payment|\$\s?\d[\d,.]*|fees?|deposit)`;
const ADVANCE_TIME = new RegExp(String.raw`\b(?:` + [
  String.raw`in\s+advance|up[\s-]?front|today`,
  String.raw`(?:immediately|right|just|directly)\s+after\s+(?:you\s+|the\s+client\s+)?sign\w*`,
  String.raw`(?:when|once|as\s+soon\s+as|upon|on|at|before|prior\s+to|by\s+the\s+time)\s+(?:you\s+|the\s+client\s+)?(?:sign(?:s|ing)?(?:\s+up)?(?!\s+in(?:to)?\b)|enrol(?:l)?(?:s|ed|ing|ment)?|join(?:s|ing)?|register(?:s|ing)?|registration)`,
  String.raw`(?:when|once|as\s+soon\s+as|upon)\s+(?:you(?:['’]ve|\s+have)|the\s+client\s+has)\s+signed(?!\s+in(?:to)?\b)`,
  // "the moment you sign", "the minute this agreement is signed".
  String.raw`(?:at\s+)?the\s+(?:very\s+)?(?:moment|minute|instant|second)\s+(?:that\s+)?${SIGNING}`,
  String.raw`at\s+(?:the\s+)?(?:time\s+of\s+)?(?:signing|sign[\s-]?up|enrol(?:l)?ment|registration)`,
  // "on the day you sign", "the same day you sign", "the day this agreement is signed", "at the time you sign", "within
  // 24 hours of signing", "within 3 days of the effective date", "on the effective date", "upon execution of this agreement".
  String.raw`(?:on\s+)?the\s+(?:same\s+)?(?:day|date)\s+(?:(?:that|of|on\s+which)\s+)?${SIGNING}`,
  String.raw`at\s+the\s+(?:same\s+)?time\s+(?:(?:that|of)\s+)?${SIGNING}`,
  String.raw`within\s+${NUM}\s+(?:(?:business|calendar)\s+)?(?:hours?|days?)\s+(?:of|after|from)\s+(?:${SIGNING}|${EFFECTIVE})`,
  // "due 48 hours after signing", "payable once the contract is signed", "due immediately", "pay $99 now to get
  // started", "required to begin services", "services begin once your first payment is received", "charged when your
  // account is opened".
  String.raw`(?:${NUM}\s+(?:(?:business|calendar)\s+)?hours?|(?:[1-7]|one|two|three|four|five|six|seven)\s+(?:(?:business|calendar)\s+)?days?)\s+(?:after|from)\s+(?:${SIGNING}|${EFFECTIVE})`,
  // Later after signing, with no work named that it pays for (LATER, FOR_WORK_DONE): "due 10 days after you sign", "two
  // weeks after you sign", "on the first of the month after you sign".
  String.raw`(?:\d+|a\s+few|several|${NUM})\s+(?:(?:business|calendar)\s+)?(?:days?|weeks?|months?)\s+(?:after|from|following)\s+(?:${SIGNING}|${EFFECTIVE})`,
  String.raw`(?:on\s+)?the\s+(?:first|1st)\s+(?:day\s+)?of\s+the\s+(?:next\s+|following\s+)?month\s+(?:after|following)\s+(?:${SIGNING}|${EFFECTIVE}|(?:you\s+)?sign\w*)`,
  String.raw`(?:when|once|as\s+soon\s+as|upon)\s+(?:this|the)\s+(?:agreement|contract)\s+(?:is|has\s+been)\s+signed`,
  String.raw`due\s+immediately|(?:immediately|now)\s+(?:due|payable)|payable\s+immediately|(?:now|today)\s+to\s+(?:get\s+started|begin|start)`,
  String.raw`(?:required|needed|necessary)\s+(?:to|before\s+(?:we\s+)?(?:can\s+)?)\s*(?:begin|start|get\s+started|open|activate)`,
  String.raw`(?:begin|begins|start|starts|open|opens|opened|activat\w*)\s+(?:\w+\s+){0,2}?(?:once|when|after|upon|as\s+soon\s+as)\s+(?:we\s+)?(?:receive|get|collect)\w*\s+(?:\w+\s+){0,3}?(?:payment|\$\s?\d[\d,.]*)`,
  String.raw`(?:begin|begins|start|starts)\s+(?:once|when|after|upon)\s+(?:\w+\s+){0,4}?payment\b[^.!?]{0,24}?\b(?:is|has\s+been)\s+received`,
  // "work begins after your first $99 payment clears", "your plan is activated once payment is received", "we will not
  // start work until your first payment of $99 is received", "services start upon receipt of payment".
  String.raw`(?:begin|begins|began|start|starts|started|open|opens|opened|activat\w*)\s+(?:[^\s.!?;:,]+\s+){0,3}?(?:after|once|when|upon|as\s+soon\s+as)\s+(?:[^\s.!?;:,]+\s+){0,5}?${PAYMENT_NOUN}(?:\s+[^\s.!?;:,]+){0,3}?\s+(?:clears|has\s+cleared|(?:is|has\s+been)\s+(?:received|made|processed|paid|collected|cleared))`,
  String.raw`until\s+(?:[^\s.!?;:,]+\s+){0,5}?${PAYMENT_NOUN}(?:\s+[^\s.!?;:,]+){0,3}?\s+(?:clears|has\s+cleared|(?:is|are|has\s+been|have\s+been)\s+(?:received|made|paid|collected|processed|cleared))|until\s+(?:you|the\s+client)\s+(?:have\s+|has\s+)?pa(?:y|ys|id)|until\s+we\s+(?:receive|collect|get)\w*\s+(?:[^\s.!?;:,]+\s+){0,3}?${PAYMENT_NOUN}`,
  String.raw`upon\s+receipt\s+of\s+(?:[^\s.!?;:,]+\s+){0,3}?${PAYMENT_NOUN}`,
  // "charged when your account is opened", "as soon as your enrollment is complete", "before your file is opened", "at the
  // time your account is set up", "when the agreement takes effect" (SOFT_START: unless the clause bills in arrears).
  String.raw`(?:when|once|as\s+soon\s+as|upon|before|at\s+the\s+time)\s+(?:your\s+|the\s+)?(?:account|file|case|plan|subscription|enrol(?:l)?ment|sign[\s-]?up|registration|application)\s+(?:is|has\s+been)\s+(?:opened|created|set\s+up|activated|complete|completed|done|finished|processed|approved|accepted)`,
  String.raw`(?:when|once|as\s+soon\s+as|upon)\s+(?:this|the|your)\s+(?:agreement|contract)\s+(?:takes\s+effect|becomes\s+effective|is\s+in\s+effect)`,
  String.raw`(?:on|upon|by|at)\s+${EFFECTIVE}`,
  // Billing at the start of a month for that month's work, which is not done yet: "charged at the beginning of each
  // month for that month's work", "on the 1st of each month for the month ahead" (not "on the 1st of each month for the
  // work fully performed in the month before").
  String.raw`(?:at|on)\s+the\s+(?:very\s+)?(?:beginning|start|first\s+day|1st|first)\s+of\s+(?:each|every|the|a)\s+(?:calendar\s+)?month\b[^.!?]{0,60}?\bfor\s+(?:(?:the\s+)?(?:work|services?)\s+(?:(?:to\s+be\s+)?(?:(?:fully|actually)\s+)?(?:done|performed|provided|delivered)\s+)?(?:(?:of|in|during|for|within)\s+)?)?(?:(?:that|this|the\s+same|the\s+current|the\s+coming|the\s+upcoming|the\s+next|the\s+following)\s+month|the\s+(?:month|period)\s+ahead)`,
  String.raw`(?:at|on)\s+the\s+(?:very\s+)?(?:beginning|start|first\s+day|1st|first)\s+of\s+(?:each|every|the|a)\s+(?:calendar\s+)?month\b[^.!?]{0,80}?\b(?:we\s+will\s+(?:do|perform|provide)|(?:to\s+be|that\s+will\s+be)\s+(?:done|performed|provided))`,
  String.raw`(?:at|on)\s+the\s+(?:1st|first)\s+for\s+(?:the\s+)?(?:current|same|this|that|coming|upcoming|next|following)\s+month`,
  // The start of any period, unless the sentence says the payment is for work already done (PRIOR_PERIOD): "paid at the
  // start of the month", "at the beginning of the program", "at the beginning of each billing cycle".
  String.raw`(?:at|on)\s+the\s+(?:very\s+)?(?:beginning|start|first\s+day|1st|first)\s+of\s+(?:each|every|the|a|this|that|your)\s+(?:(?:calendar|service|billing|new|monthly|program|contract|subscription|\d+-day|thirty-day)\s+){0,2}(?:month|billing\s+(?:cycle|period)|period|program|cycle|subscription|term|plan)`,
  String.raw`for\s+(?:the\s+)?(?:month|period|cycle|year|program)\s+ahead|for\s+the\s+(?:coming|upcoming|next|following)\s+(?:month|period|cycle|year)`,
  // Before the work: "before work starts", "before we send your first letters", "prior to the start of the disputes",
  // "before we review your reports", "before we do anything", "before the cancellation period ends".
  String.raw`(?:before|prior\s+to)\s+(?:(?:any|the|we|our|your|you|first|initial)\s+)?(?:\w+\s+){0,3}?(?:begin\w*|start\w*|work\w*|perform\w*|services?|disputes?|letters?|review\w*|audit\w*|consult\w*|do\s+anything|(?:cancel\w*|rescission|waiting)\s+period)`,
  String.raw`at\s+the\s+outset|at\s+(?:the\s+)?(?:very\s+)?(?:start|beginning)(?!\s+of\b)|on\s+day\s+(?:one|1)|at\s+check-?out`,
  // "please include your first payment with this signed agreement", "return this agreement with your $99 payment".
  String.raw`with\s+(?:this|the|your)\s+signed\s+(?:agreement|contract|form|application)|(?:return|send|submit|mail|bring)\w*\s+(?:this|the|your)\s+(?:signed\s+)?(?:agreement|contract|form|application)\s+(?:together\s+|along\s+)?with`,
  // Right away, next to a payment word: "charged right away", "we charge your card immediately", "drafted immediately"
  // (not "charged immediately after each round of letters is sent").
  String.raw`(?:charg|bill|collect|draft|debit|process|run)\w*\s+(?:[^\s.!?;:,]+\s+){0,3}?(?:right\s+away|instantly|immediately|at\s+once)(?!\s+(?:after|once|when|upon|following|as\s+soon\s+as)\b)|(?:due|payable|paid)\s+(?:in\s+full\s+)?(?:right\s+away|instantly|at\s+once)|(?:right\s+away|instantly|immediately|at\s+once)\s+(?:[^\s.!?;:,]+\s+){0,2}?(?:charg|bill|collect|draft|debit)\w*`,
  // "we require a $99 payment to open your file", "a credit audit fee is due at your first consultation", "pay $99 now".
  String.raw`requir(?:e|es|ed|ing)\s+(?:[^\s.!?;:,]+\s+){0,4}?${PAYMENT_NOUN}(?:\s+[^\s.!?;:,]+){0,3}?\s+(?:to|before|prior\s+to|in\s+order\s+to)\s+(?:(?:we|you|us|can|could)\s+){0,2}(?:begin|start|open|activat|get\s+started|review|work|do|prepar|send|mail|file|process|enrol|set\s+up|proceed)\w*`,
  String.raw`at\s+(?:your|the|our)\s+(?:(?:first|initial)\s+)?(?:consultation|consult|appointment|meeting|session)|(?:at|upon|on)\s+onboarding`,
  // "collected in the first week", "billed within the first 3 days" (unless for work already performed: LATER),
  // "a $99 payment starts your program", "$99 secures your spot".
  String.raw`(?:in|within|during)\s+(?:the\s+)?first\s+(?:\d+\s+|few\s+|two\s+|three\s+|four\s+|five\s+|six\s+|seven\s+)?(?:days?|weeks?|month)`,
  String.raw`(?:payment|\$\s?\d[\d,.]*|fees?|deposit)\s+(?:[^\s.!?;:,]+\s+){0,2}?(?:starts?|begins?|activates?|opens?|secures?|reserves?|unlocks?|holds?)\s+(?:your|the)\s+(?:program|plan|services?|file|account|membership|subscription|spot|place|seat|enrol(?:l)?ment|work|case)`,
  String.raw`(?:pay|charg\w*|bill\w*)\s+(?:you\s+)?(?:\$\s?\d[\d,.]*\s+)?(?:right\s+)?now(?!\s+and\s+then)`,
  // Spanish: "se cobra al firmar", "paga por adelantado".
  String.raw`al\s+firmar|(?:al|en\s+el)\s+momento\s+de\s+(?:firmar|la\s+firma|inscribirse|la\s+inscripci[oó]n)|por\s+(?:adelantado|anticipado)|(?:al|antes\s+de)\s+(?:la\s+)?(?:firma|inscripci[oó]n)|antes\s+de\s+(?:empezar|comenzar|iniciar|enviar|mandar|preparar|revisar|disputar|trabajar|hacer|realizar|prestar)`,
  String.raw`el\s+(?:mismo\s+)?d[ií]a\s+(?:en\s+)?(?:que|de)\s+(?:usted\s+)?(?:firma|firme|firmar|la\s+firma)|al\s+(?:inscribirse|registrarse|afiliarse|contratar)|al\s+(?:inicio|comienzo|principio)\s+de\s+(?:cada|el|este|su)\s+(?:mes|per[ií]odo|ciclo|programa)`,
].join('|') + String.raw`)\b`, 'gi');

/** Later after signing (more than 7 days, or weeks or months), the first of the month after, or in the first days of the program: an advance fee unless it pays for work already done. */
const LATER = /^(?:in|within|during)\s+(?:the\s+)?first\b|^(?:(?:[89]|[1-9]\d+|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|sixty|ninety|a\s+few|several)\s+(?:(?:business|calendar)\s+)?days?|\S+\s+(?:weeks?|months?))\s+(?:after|from|following)\b|^(?:on\s+)?the\s+(?:first|1st)\s+(?:day\s+)?of\s+the\s+(?:next\s+|following\s+)?month\s+(?:after|following)\b/i;
const FOR_WORK_DONE = /\b(?:for|cover(?:s|ing)?|pays?\s+for)\s+(?:only\s+)?(?:the\s+|all\s+|any\s+)?(?:work|services?|letters?|disputes?)\b[^;]{0,50}?\b(?:already\s+)?(?:performed|done|completed|provided|rendered|delivered|sent|mailed)\b|\bin\s+arrears\b|\bpor\s+(?:el\s+)?(?:trabajo|servicios?)\s+(?:ya\s+)?(?:realizados?|completados?|hechos?|prestados?)/i;
/** The start of a period, alone: an advance fee unless the sentence says it pays for the period before (PRIOR_PERIOD). */
const PERIOD_START = /^(?:at|on)\s+the\s+(?:very\s+)?(?:beginning|start|first\s+day|1st|first)\s+of\s+(?:each|every|the|a|this|that|your)\s+(?:(?:calendar|service|billing|new|monthly|program|contract|subscription|\d+-day|thirty-day)\s+){0,2}(?:month|billing\s+(?:cycle|period)|period|program|cycle|subscription|term|plan)$|^al\s+(?:inicio|comienzo|principio)\s+de\s+(?:cada|el|este|su)\s+(?:mes|per[ií]odo|ciclo|programa)$/i;
const PRIOR_PERIOD = /\b(?:previous|prior|preceding|last|past)\s+(?:calendar\s+)?(?:month|period|cycle|billing\s+(?:cycle|period))|\b(?:month|period|cycle)\s+before\b|\bin\s+arrears\b|\b(?:we|you)\s+(?:have\s+)?(?:completed|performed|did|finished|done)\b|\balready\s+(?:been\s+)?(?:performed|done|completed|provided|delivered)\b|\b(?:mes|per[ií]odo|ciclo)\s+anterior\b|\b(?:trabajo|servicios?)\s+(?:ya\s+)?(?:realizados?|completados?|hechos?|prestados?)/i;

/** Where one clause of a payment term ends: ";", ":", a comma, and, but, otherwise, then, unless, except. */
const FEE_CLAUSE_END = /[;:!?]|(?<!\d)[.,]|[.,](?!\d)|\b(?:and|but|otherwise|then|unless|except|or\s+else|pero|sino)\b/i;
/** A sentence of a payment term, for what it says the payment is for: up to ";" or the end of the sentence. */
const FEE_SENTENCE_END = /[;!?]|(?<!\d)\.|\.(?!\d)/;

/**
 * The time word's own clause: the words before it and after it up to FEE_CLAUSE_END. A time phrase that opens its
 * clause ("When you sign, you pay $99", "Upon signing, a fee is charged", "Before work begins, you pay $99", "Prior to
 * the start of services, a fee of $199 is due") also takes the clause after its comma.
 */
function feeClause(text: string, at: number, end: number): { before: string; after: string; clause: string; sentence: string } {
  const before = text.slice(Math.max(0, at - 120), at).split(FEE_CLAUSE_END).pop()!;
  const tail = text.slice(end, end + 160);
  let after = tail.split(FEE_CLAUSE_END)[0]!;
  const stop = FEE_CLAUSE_END.exec(tail);
  if (!/\S/.test(before) && stop?.[0] === ',') after = `${tail.slice(0, stop.index)} ${tail.slice(stop.index + 1).split(FEE_CLAUSE_END)[0]!}`;
  const sentence = `${text.slice(Math.max(0, at - 240), at).split(FEE_SENTENCE_END).pop()!}${text.slice(at, end)}${text.slice(end, end + 240).split(FEE_SENTENCE_END)[0]!}`;
  return { before, after, clause: `${before} ${text.slice(at, end)} ${after}`, sentence };
}

/**
 * A negated verb of charging covers the list after it, up to the time word: "we do not charge a setup fee, a
 * cancellation fee or any fee in advance". Not across a new clause or an amount ("we do not charge interest, and we
 * bill $99 when you sign", "we never charge over $99 when you sign").
 */
const NEGATED_CHARGE = /(?:\b(?:do|does|did|will|shall|would|can|could|may)\s+not|\bnever|n['’]t)\s+(?:ever\s+)?(?:charge|bill|collect|ask\s+(?:you\s+)?for|require|take|accept|request)\b(?:(?!\b(?:but|however|yet|otherwise|then|unless|except)\b|\band\s+(?:we|you|they|it|i|our|the\s+client)\b|[;:]|\$\s?\d|,\s*(?:and\s+)?(?:we|you|they|it|i|our|the\s+client)\b)[^.!?])*$/i;
/** The same in Spanish: "nunca cobramos por adelantado", "no pedimos ningún pago al firmar", "no se cobra … al firmar" (not across "pero" or an amount). */
const NEGATED_CHARGE_ES = /(?<![\p{L}])(?:no|nunca|jam[aá]s)(?:\s+(?:se|le|les|te|lo|la))*\s+(?:cobr|ped|pid|exig|requ|solicit|factur|carg|acept|recib|tom)\p{L}*(?:(?!(?<![\p{L}])(?:pero|sino|excepto|salvo|aunque)(?![\p{L}])|[;:]|\$\s?\d)[^.!?])*$/iu;
/**
 * A start that is not signing (the account set up, the enrollment complete, the agreement in effect) is an advance fee
 * only if the clause does not bill in arrears: "once your account is set up, you are billed at the end of each month for
 * the work performed that month" passes.
 */
const SOFT_START = /^(?:when|once|as\s+soon\s+as|upon|at\s+the\s+time)\s+(?:your\s+|the\s+|this\s+)?(?:account|file|case|plan|subscription|enrol|sign|registration|application|agreement|contract)/i;
const ARREARS = /\b(?:at|by)\s+the\s+end\s+of\s+(?:each|every|the|a|your)\b|\bafter\s+(?:the\s+|each\s+|every\s+)?(?:work|services?|month|round|letters?)\b[^.;]{0,40}?\b(?:performed|done|completed|provided|delivered|sent|mailed|ends?|over)\b/i;

/**
 * A time word that is the object of a cancellation, not a time to pay: "if you cancel before work starts, you pay
 * nothing", "you may cancel this agreement without penalty within 3 business days after you sign", "you have 3 business
 * days after you sign to cancel". A cancellation anywhere else in the sentence does not count ("if you cancel, you pay
 * nothing; otherwise $99 is due when you sign", "non-cancellable: $99 is due when you sign").
 */
const CANCEL_BEFORE = /(?<![\w-])cancel(?:s|led|ling|lation)?\s+(?:(?:this|the|your)\s+(?:agreement|contract|services?|enrol(?:l)?ment)\s+|it\s+)?(?:(?:at\s+)?any\s*time\s+|without\s+(?:any\s+)?(?:penalty|obligation|charge|cost|fee)s?\s+(?:or\s+(?:penalty|obligation|charge|cost|fee)s?\s+)?|at\s+no\s+(?:charge|cost)\s+|for\s+free\s+|free\s+of\s+charge\s+|in\s+writing\s+)*$/i;
const cancellationTerm = (text: string, at: number, end: number, word: string) =>
  (/^(?:before|within|prior\s+to|by\s+the\s+time)\b/i.test(word) && CANCEL_BEFORE.test(text.slice(Math.max(0, at - 120), at))) || /^\s+(?:in\s+which\s+)?to\s+cancel\b/i.test(text.slice(end, end + 30));

/**
 * Payment asked for at or before signing, or in advance, which 15 U.S.C. § 1679b(b) forbids: no credit repair
 * organization "may charge or receive any money or other valuable consideration for the performance of any service …
 * before such service is fully performed". Read in the agency's contract terms. A deposit, retainer, prepayment or a
 * setup, enrollment, sign-up or activation fee is a payment wherever it is named; a time word counts when a payment
 * word (pay, charge, fee, due, bill, $…) is in its own clause:
 *  - at or before signing: when you sign, at signing, upon enrollment, today, on or the same day you sign, at the time
 *    you sign, the moment you sign, once you've signed, within 24 hours of signing, with this signed agreement;
 *  - when the agreement takes effect: on the effective date or your start date, within 3 days of it, upon execution,
 *    when the agreement takes effect, when or before the account is set up or the enrollment is complete (unless the
 *    clause bills at the end of the period or for work performed: SOFT_START);
 *  - later after signing (10 days, two weeks, the first of the month after you sign) or in the first days or weeks,
 *    unless it pays for work already performed ("…, for the work performed during those 30 days");
 *  - before the work: up front, in advance, at the outset, at checkout, on day one, at onboarding, right away or
 *    immediately next to a payment word, before work starts, before we send your first letters or review your reports,
 *    until or once a payment is received or clears, required to begin, a payment that starts or secures the program, at
 *    your first consultation, and billing at the start of a month, a program or a billing cycle (a service month, every
 *    30-day period, the 1st for the current month) unless it is for the period before;
 *  - in Spanish: al firmar, el día que firma, al inscribirse, por adelantado, antes de empezar or de enviar, al inicio de
 *    cada mes, and a depósito or anticipo.
 * Payments named only to say there are none pass ("there is no setup fee", "we do not charge a setup, enrollment or
 * activation fee", "nothing is charged when you sign", "we never charge in advance", "costs nothing", "no cobramos nada
 * por adelantado", "no hay pagos por adelantado"), as do fees only explained ("we explain our fees before we start
 * work") and billing that stops ("if you cancel, we stop billing you right away"), but a cap does not ("never more than
 * $99 at signing"); so does a refund owed to the client, and a time word that is the object of a cancellation ("if you
 * cancel before work starts, you pay nothing"). A list of rules, like the claims check: it catches the common wordings.
 */
export function findAdvanceFee(text: string): ClaimIssue | null {
  const why = 'This asks for payment before the work it pays for is done. Federal law (15 U.S.C. § 1679b(b)) does not allow charging for a service before it is fully performed.';
  for (const m of text.matchAll(ADVANCE_PAYMENT)) {
    if (!feeNegated(text.slice(Math.max(0, m.index - 80), m.index))) return { id: 'advance-fee', why, excerpt: m[0] };
  }
  for (const m of text.matchAll(ADVANCE_TIME)) {
    const at = m.index, end = at + m[0].length;
    if (cancellationTerm(text, at, end, m[0])) continue;
    const { before, after, clause, sentence } = feeClause(text, at, end);
    // "Payment is not up front", "never in advance", "we do not charge a setup fee, a cancellation fee or any fee in
    // advance", "no cobramos nada por adelantado", "nunca cobramos por adelantado".
    if (/(?:\b(?:no|not|never|nothing|none|without|zero|nada|nunca|sin)|\bjam[aá]s|n['’]t)\s+$/i.test(before)) continue;
    const sentenceBefore = text.slice(Math.max(0, at - 240), at).split(FEE_SENTENCE_END).pop()!;
    if ((NEGATED_CHARGE.test(sentenceBefore) || NEGATED_CHARGE_ES.test(sentenceBefore)) && !AMOUNT.test(after)) continue;
    if (!asksPayment(clause)) continue;
    if (LATER.test(m[0]) && FOR_WORK_DONE.test(sentence)) continue;
    if (PERIOD_START.test(m[0]) && PRIOR_PERIOD.test(sentence)) continue;
    if (SOFT_START.test(m[0]) && (ARREARS.test(clause) || FOR_WORK_DONE.test(clause))) continue;
    return { id: 'advance-fee', why, excerpt: m[0] };
  }
  return null;
}
