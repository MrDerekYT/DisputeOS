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
  // One run of spaces, "+" or "-" between the number and the word ("100 points", "100+ points", "a 100-point jump"), so
  // that a long run of spaces is read once, not split in every way.
  { id: 'score-number', pattern: /\b\d{2,3}[\s+-]*(?:(?:more|extra|additional|m[aá]s)\s+)?(points?|pts|puntos)\b|\b[3-8]\d{2}[\s+]*(credit\s+)?(scores?|fico)\b|\b(scores?|fico|puntaje|puntuaci[oó]n)\b[^.!?]{0,30}\b[3-8]\d{2}\b|\b(?:the|low|mid|high|upper)\s+[5-8]\d0s\b/i, why: 'Do not quote a score or a score increase.' },
  { id: 'score-promise', pattern: new RegExp(String.raw`\b(rais\w+|boost\w*|increas\w+|improv\w+|skyrocket\w*|better|higher|sub[aeiío]\w*|aument\w+|elev\w+|mejor\w*|increment\w+)\b[^.!?]{0,30}\b${SCORE}\b|\b${SCORE}\b[^.!?]{0,20}\b(?:go(?:es)? up|will (?:rise|improve|increase|go up|climb|jump|soar)|shoot(?:s|ing)?\s+up|soar(?:s|ing)?|skyrocket(?:s|ing)?)\b|\b${SCORE}\b[^.!?]{0,20}(?<![\wáéíóúñü])(?:subir[aá]n?|mejorar[aá]n?|aumentar[aá]n?)(?![\wáéíóúñü])`, 'i'), why: 'Do not promise a higher credit score.' },
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
 * governs it: "no result is guaranteed", "we cannot guarantee…", "we do not promise, imply or guarantee…", "nadie puede
 * garantizar…", "ninguna parte de este contrato garantiza…", "sin garantías". A negative word somewhere earlier in the
 * sentence ("No worries, we guarantee…", "Why not get guaranteed results"), an "or" with no negation before it
 * ("results assured or guaranteed", "the Standard or Guaranteed plan") and a boast ("nothing guarantees results like
 * our team") do not count. "Nos aseguramos de que…" (we make sure) and "aseguradora" (an insurer) are no guarantee.
 */
const GUARANTEE_WORD = /\b(guarant\w+|guarent\w+|garant[ií]\w*|(?<!\bnos\s{1,3})asegura(?:mos|do|da|dos|das)(?![a-záéíóúñü]))/gi;
/** "Nothing guarantees results like our team": a comparison after the guarantee word makes it a boast. */
const BOAST_AFTER = /^\s+(?:[\w'’-]+\s+){0,4}?(?:like|better\s+than|as\s+well\s+as|more\s+than|the\s+way)\s+(?:our|we|us|ours)\b/i;
const GUARANTEE_NEGATED = new RegExp(String.raw`\b(?:` + [
  String.raw`no (?:particular |specific |certain )?(?:results?|outcomes?|changes?|removals?|deletions?)(?: (?:is|are|can be|can ever be|is ever|are ever))?`,
  String.raw`(?:cannot|can not|can['’]?t|could not|couldn['’]?t|do not|don['’]?t|does not|doesn['’]?t|will not|won['’]?t|will never|can never|never|unable to|not able to|not|nor|(?<=\b(?:not|never|no|cannot|can['’]?t|won['’]?t|don['’]?t|doesn['’]?t|nor)\b[^.;:!?]{0,40})or)(?: (?:and (?:do|will) not|legally|honestly|ever|promise or))?`,
  String.raw`(?:is|are|be) (?:not|never)`,
  String.raw`(?:without|no|not a|never a)(?: a| any)?`,
  // "nothing guarantees…", "nothing in this agreement guarantees…".
  String.raw`nothing(?: (?:in|of) (?:this|the|our) [\w-]+)?`,
  String.raw`(?:nadie|ninguna (?:empresa|compañ[ií]a|agencia)) (?:puede|podr[ií]a)(?: legalmente)?`,
  String.raw`(?:ninguna (?:parte|cl[aá]usula|secci[oó]n) de (?:este|el|esta|la)|nada (?:en|de) (?:este|el)) (?:contrato|acuerdo)`,
  String.raw`no (?:podemos|puedo|se puede|se pueden|es posible|prometemos ni)`,
  String.raw`(?:no|ni|nunca)(?: le| les| te| se)?`,
  String.raw`ning[uú]n resultado (?:est[aá]|es|puede ser)`,
  String.raw`no (?:est[aá]n?|son|es)`,
  String.raw`(?:sin|no hay|no ofrecemos|no damos)(?: ninguna)?`,
].join('|') + String.raw`)\s+$`, 'i');

function guaranteeIssue(text: string): ClaimIssue | null {
  for (const m of text.matchAll(GUARANTEE_WORD)) {
    const end = m.index + m[0].length;
    if (!GUARANTEE_NEGATED.test(text.slice(Math.max(0, m.index - 60), m.index)) || BOAST_AFTER.test(text.slice(end, end + 60))) return { id: /^gua/i.test(m[0]) ? 'guarantee' : 'guarantee-es', why: 'Results cannot be guaranteed.', excerpt: m[0].slice(0, 80) };
  }
  return null;
}

/**
 * A removal verb in the same sentence as a negative item, in either order: "we delete collections", "late payments
 * erased", "eliminamos sus deudas". Allowed only when a negation directly governs the verb ("nobody can remove…").
 */
// The Spanish stems borr- and quit- leave out the English words that share them (borrow, borrowers, quits, quitting,
// and "quite" unless an article or pronoun follows it: "quite las cuentas" is Spanish, "quite common" is not).
const REMOVAL_VERB = String.raw`(?:remov\w+|delet\w+|eras\w+|wip\w+|clean(?:s|ed|ing)?\s+(?:up|off)|get(?:s|ting)?\s+rid\s+of|elimin[\wáéíóú]+|borr(?!ow)[\wáéíóú]+|quit(?!s\b|t|e\s+(?!(?:las?|los|el|lo|les?|sus?|es[ao]s?|est[ao]s?|tod[oa]s|una?s?|cualquier)\b))[\wáéíóú]+|limpi[\wáéíóú]+)`;
const NEGATIVE_ITEM = String.raw`(?:late\s+payments?|collections?|charge[\s-]?offs?|bankruptc\w+|inquir\w+|foreclosures?|repossessions?|judgments?|liens?|negative\s+\w+|derogator\w+|bad\s+credit|deudas?|cobranzas?|colecciones|mal\s+cr[eé]dito|pagos?\s+atrasados?|bancarrotas?|quiebras?|embargos?|consultas|\w+\s+negativ[oa]s?)`;
// "\b" after the verb would miss "eliminó" and "borró" (a final "ó" is no word character): the end is read as no letter.
const REMOVAL = new RegExp(String.raw`\b(${REMOVAL_VERB})(?![\wáéíóúñü])[^.!?]{0,60}\b${NEGATIVE_ITEM}\b|\b${NEGATIVE_ITEM}\b[^.!?]{0,60}\b(${REMOVAL_VERB})(?![\wáéíóúñü])`, 'gi');
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

/**
 * A sentence ends at "!", "?" or a full stop that is not a decimal point ("$99.00" is one sentence). Read by hand, not
 * by splitting with a regular expression: it runs several times for every removal word.
 */
const isDigit = (c: number) => c >= 48 && c <= 57;
const endsAt = (s: string, i: number) => { const c = s.charCodeAt(i); return c === 33 || c === 63 || (c === 46 && !(isDigit(s.charCodeAt(i - 1)) && isDigit(s.charCodeAt(i + 1)))); };
/** The text after the last sentence end of `s`. */
function sinceSentenceStart(s: string): string { for (let i = s.length - 1; i >= 0; i--) if (endsAt(s, i)) return s.slice(i + 1); return s; }
/** The text before the first sentence end of `s`. */
function untilSentenceEnd(s: string): string { for (let i = 0; i < s.length; i++) if (endsAt(s, i)) return s.slice(0, i); return s; }

/**
 * A promise inside a disclaimer is no promise: "we cannot guarantee that any negative item will be deleted", "we do not
 * promise that your score will improve", "no one can promise you will qualify for a loan", "our fee does not depend on
 * how many items are removed", "we never advise paying a collector to have an item removed", "nothing in this
 * agreement requires a bureau to delete any item". True when such a disclaimer governs the text just before `at`: in
 * the same sentence, at most 100 characters back, with no "but", "however", "yet", "instead", "so", "then", "beyond",
 * "other than", "what we", "like our", no clause that opens with "only", no colon or dash and no new clause between it
 * and the claim ("we cannot guarantee results, and we will remove…", "no promises, we remove…", "no promises — your
 * collections are deleted", "nothing here promises a score, only that…", "we do not promise anything beyond the removal
 * of…", "no company can promise what we promise, which is deletion…", "nothing guarantees results like our 30-day
 * deletion process"). An "only" inside what is disclaimed does not end it ("we do not guarantee … that only negative
 * items will be removed").
 */
const DISCLAIMER = new RegExp(String.raw`\b(?:(?:cannot|can not|can['’]?t|could not|couldn['’]?t|do not|don['’]?t|does not|doesn['’]?t|did not|will not|won['’]?t|never|not|no one can|nobody can|no company can)\s+(?:\w+\s+){0,2}?(?:guarantee|promise|predict|claim|represent|assure|warrant|say|know|tell|depend|requir|advis|recommend|suggest|encourag|tied|based|conditioned|linked|contingent)\w*|(?:no|without|not a|not any|never a)\s+(?:\w+\s+)?(?:guarantees?|promises?|representations?|assurances?|warrant(?:y|ies)|predictions?)|nothing\s+(?:(?:in|of)\s+(?:this|the|our)\s+[\w-]+\s+)?(?:promises?|guarantees?|assures?|warrants?|represents?|predicts?|requires?|obligates?|forces?|compels?))\b(?:(?!\b(?:but|however|yet|although|though|except|instead|so|then|beyond|besides|other\s+than|apart\s+from|aside\s+from|what\s+we|like\s+(?:our|us|we)|better\s+than|as\s+well\s+as|(?:because|since)\s+(?:we|our|i))\b|,\s*only\b|\bonly\s+that\b|,\s*(?:(?:and|so|then)\s+)?(?:we|you|they|our|i)\b|\band\s+(?:we|you|they|our|i)\b|\s-\s)[^!?;:—–]){0,100}$`, 'i');
const disclaimed = (text: string, at: number) => DISCLAIMER.test(sinceSentenceStart(text.slice(Math.max(0, at - 180), at)));

/**
 * A negation right before `at` (at most three words back, no punctuation between): "we do not sell tradelines", "no
 * deposit", "paying does not mean the bureau will delete it". Not "not only" ("not only do we raise your score…"), and
 * not an exception that names what is meant ("no promise other than deleting…", "nothing but…").
 */
const NEGATION = /(?:\b(?:no|not(?!\s+only\b)|never|nor|without|cannot|nothing|none|zero|neither)|n['’]t)\s+(?:(?!(?:other|than|except|beyond|besides|save|but|only|just)\b)[^\s.!?;:,]+\s+){0,3}$/i;
const NOT_MEAN = /(?:\b(?:does|do|did|will|would)\s+not|\b(?:doesn|don|didn|won|wouldn)['’]t)\s+mean\s+(?:that\s+)?(?:[\w'’-]+\s+){0,5}?$/i;
const negated = (text: string, at: number) => { const lead = text.slice(Math.max(0, at - 60), at); return NEGATION.test(lead) || NOT_MEAN.test(lead); };
/**
 * The same, through a list: "we do not sell tradelines, credit privacy numbers or new credit identities". A comma may
 * come between, but not a new clause ("no refunds, we sell tradelines" is not negated).
 */
const NEGATED_LIST = /(?:\b(?:no|not|never|nor|without|cannot|neither)|n['’]t)\s+(?:(?!(?:but|however|yet|although|though|except|instead|we|you|they|i|it|he|she|our|your|their|us)\b)[^\s.!?;:]+\s+){0,8}$/i;
const negatedList = (text: string, at: number) => NEGATED_LIST.test(text.slice(Math.max(0, at - 100), at));

/**
 * A removal verb in a request, where the request verb governs it: "ask the bureaus to correct or delete…", "asking
 * Equifax, Experian and TransUnion to investigate and correct or remove…", "requesting the deletion of…", "we request
 * that the bureaus delete…", "demand verification or deletion", "we dispute the items you select for correction or
 * deletion". Describes the work, promises nothing. The words between the request verb and the removal are its object
 * only: a new subject or verb ends the request ("once you request it, our team is able to delete…", "all we request is
 * your signature to delete…", "we request that you sign so our team can delete…"), and so does a payment ("we ask for a
 * small monthly fee to remove your negative items").
 */
const NOT_REQUEST_OBJECT = String.raw`(?!(?:is|was|be|been|able|so|because|then|once|when|after|we|our|signature|permission|consent|for|fees?|payments?|money|deposits?|charges?|prices?)\b)`;
const NOT_THAT_SUBJECT = String.raw`(?!(?:you|we|our|us|i|so|then|can|could|will|would|may|might|is|are|able|sign\w*)\b)`;
const OR_LIST = String.raw`(?:(?:[\w'’-]+\s+){1,3}?(?:or|and|and\/or)\s+)?`;
const REQUESTED = new RegExp([
  String.raw`\b(?:ask|request|petition)(?:s|ed|ing)?\s+(?:${NOT_REQUEST_OBJECT}[\w'’&-]+,?\s+){0,14}?to\s+(?:(?:consider|kindly|please|promptly)\s+)?${OR_LIST}$`,
  String.raw`\b(?:request(?:s|ed|ing)?|seek(?:s|ing)?|ask(?:s|ed|ing)?\s+for|demand(?:s|ed|ing)?)\s+(?:the\s+|their\s+|its\s+)?${OR_LIST}$`,
  String.raw`\b(?:disput|challeng|contest|submit)\w*\s+(?:${NOT_REQUEST_OBJECT}[\w'’&-]+,?\s+){0,10}?for\s+(?:possible\s+)?${OR_LIST}$`,
  String.raw`\b(?:ask|request|demand)(?:s|ed|ing)?\s+that\s+(?:${NOT_THAT_SUBJECT}[\w'’-]+\s+){1,4}?${OR_LIST}$`,
].join('|'), 'i');
/**
 * What makes a removal that someone else may do (a request, a bureau's decision, what the client is told) a promise
 * again when it follows in the sentence: "and the bureaus always grant it", "they comply every time", "and they agree
 * in nearly all cases", "and it is usually all of them", "whether they are deleted is never in doubt", "the bureaus
 * rarely refuse", "never comes back", "consider them gone". Not a bare "usually" or "typically" ("which usually takes
 * 30 days" is honest).
 */
const CERTAIN_AFTER = /\b(?:always|every\s+(?:single\s+)?time|each\s+time|without\s+fail|invariably|never\s+in\s+doubt|hardly\s+in\s+doubt|(?:is|are)\s+(?:certain|a\s+given|assured)|(?:all|every\s+(?:single\s+)?one)\s+of\s+them|(?:nearly|almost|virtually|practically)\s+(?:all|every|always)|rarely\s+(?:refuse|decline|say\s+no|fail|object)|never\s+(?:comes?\s+back|returns?|refuses?|reappears?|fails?|declines?)|for\s+good|permanently|consider\s+(?:it|them|those|these)\s+(?:gone|done|deleted|removed)|as\s+good\s+as\s+(?:gone|done|deleted|removed))\b/i;
/** A time frame: "within 30 days", "in as little as 45 days", "30 days or less", "within the first month", "by next month", "about 45 days". */
const TIMED_SOURCE = String.raw`\b(?:in|within|under)\s+(?:as\s+(?:little|few)\s+as\s+|just\s+|only\s+|less\s+than\s+|about\s+|around\s+)?${NUM}\s+(?:(?:business|calendar)\s+)?${PERIOD}\b|\b${NUM}\s+(?:(?:business|calendar)\s+)?${PERIOD}\s+or\s+(?:less|fewer|sooner)\b|\b(?:in|within|by|during)\s+(?:the\s+|your\s+)?(?:first|second|third|next|1st|2nd|3rd)\s+(?:few\s+|couple\s+of\s+)?(?:days?|weeks?|months?|rounds?|cycles?)\b|\b(?:by\s+)?next\s+(?:week|month)\b|\bwithin\s+(?:a\s+few\s+|several\s+|a\s+couple\s+of\s+)?(?:days|weeks|months)\b|\b(?:about|around|roughly|approximately|approx\.)\s+${NUM}\s+(?:(?:business|calendar)\s+)?${PERIOD}\b`;
// One compiled pattern, read with a fresh start each time (a global pattern keeps where it stopped).
const TIMED_G = new RegExp(TIMED_SOURCE, 'gi');
const TIMED = { test: (s: string) => { TIMED_G.lastIndex = 0; return TIMED_G.test(s); } };
/** What may come between a removal and its own time frame: a few words with no new clause, or "which happens…". */
const TO_TIMED = /^(?:\s*,)?(?:\s+(?!(?:and|or|then|but|so|we|you|they|i|it|he|she)\b)[\w'’$-]+){0,6}\s*,?\s*(?:(?:which|that|this|it)\s+(?:usually\s+|typically\s+|often\s+|generally\s+|normally\s+)?(?:happens?|takes?|occurs?|is\s+done|comes?|tends?\s+to\s+(?:happen|take))\s+)?$/i;
/**
 * A time frame for the removal itself, right after it: "deleted within 30 days", "removed from your credit report in 45
 * days", "deleted, usually within the first month", "deleted, which happens within 30 days", "removed with our method,
 * about 45 days". Not the time frame of another verb later in the sentence ("we tell you when an item is deleted and
 * send you the bureau's letter within 5 days"). (Each time frame in the first words is found, then what comes before it
 * is read: one search, not one per word.)
 */
// Every time frame names a period: a quick look for one first.
const PERIOD_WORD = /day|week|month|round|cycle|d[ií]a|semana|mes/i;
function timedAfter(rest: string): boolean {
  const head = rest.slice(0, 160);
  if (!PERIOD_WORD.test(head)) return false;
  TIMED_G.lastIndex = 0; // matchAll starts where the pattern last stopped
  for (const m of head.matchAll(TIMED_G)) if (TO_TIMED.test(head.slice(0, m.index))) return true;
  return false;
}
/**
 * Where the result is the agency's doing or certain after all, said after a removal someone else may do: "with our
 * letters they choose to", "except our clients", "and most clients see them gone within 60 days", "…is what we
 * deliver".
 */
const PROMISE_AFTER = /\bwith\s+(?:our|us)\b|\b(?:what\s+we|we|our\s+(?:team|firm|company))\s+(?:always\s+)?(?:deliver|guarantee|promise|achieve)\w*\b|\bthanks\s+to\s+(?:us|our)\b|\b(?:except|unless|other\s+than|save\s+for|besides)\b[^.!?;]{0,30}?\b(?:our|us|we)\b|\b(?:they|it)(?<!\b(?:if|whether|when|once|unless|until)\s{1,3}(?:they|it))\s+(?:(?:always|usually|typically|generally|all|then)\s+)?(?:do|does|did|choose\s+to|chooses\s+to|agree(?:s|d)?|comply|complies|complied|grant\s+(?:it|them)|say\s+yes)\b(?!\s+not\b)/i;
/** A result named again with a time frame: "…, and most clients see them gone within 60 days". */
const GONE_AGAIN = /\b(?:gone|removed|deleted|erased|wiped|off\s+(?:your|the)\s+reports?)\b/gi;
function promiseAfter(rest: string): boolean {
  if (CERTAIN_AFTER.test(rest) || PROMISE_AFTER.test(rest)) return true;
  for (const m of rest.matchAll(GONE_AGAIN)) if (TIMED.test(rest.slice(m.index, m.index + m[0].length + 60))) return true;
  return false;
}

type Exempt = 'none' | 'negation' | 'disclaimer';
/** `credit`: a removal rule, which in a contract counts only when what is removed is on a credit report (aboutCredit). */
interface ContractRule { id: string; pattern: RegExp; why: string; exempt: Exempt; credit?: boolean }

const COUNT = String.raw`(?:\d{1,3}(?:,\d{3})+|\d+|a few|several|many|dozens|hundreds|thousands|two|three|four|five|six|seven|eight|nine|ten|twelve|fifteen|twenty)`;
const ITEMS = String.raw`(?:items?|accounts?|negatives?|entries|marks?|collections?|late\s+payments?|inquir(?:y|ies)|charge[\s-]?offs?|bankruptc(?:y|ies)|judgments?|liens?|repossessions?|foreclosures?|tradelines?)`;
const GONE = String.raw`(?:removed|deleted|erased|wiped(?:\s+(?:off|out|clean))?|taken\s+(?:off|down)|knocked\s+off|cleared(?:\s+(?:off|up))?|gone)`;
const REMOVE_WE = String.raw`(?:remov|delet|eras|wip)(?:e|es|ed|ing)?`;

/*
 * What a removal is about. In a contract, removing or deleting something is a promise of a result unless it is the
 * agency's own record ("when you close your account, we delete your documents within 30 days"): that is a data practice,
 * and passes. These words name what is on a credit report:
 *  - REPORT_ITEM: items, entries, negative items, collections, late payments, inquiries, charge-offs, bankruptcies,
 *    judgments, liens, tradelines, debts, errors, bad credit, anything negative or derogatory;
 *  - QUALIFIED_ITEM: an account or information described as such an item ("negative accounts", "inaccurate
 *    information", "harmful information", "collection accounts");
 *  - ON_REPORT: anything taken "from your credit report", "off your reports", "on your credit file".
 */
const REPORT_ITEM = String.raw`(?:items?|entries|marks?|negatives|collections?|late\s+payments?|inquir(?:y|ies)|charge[\s-]?offs?|bankruptc(?:y|ies)|judgments?|liens?|repossessions?|foreclosures?|tradelines?|debts?|errors?|mistakes?|bad\s+credit|negative\s+[\w-]+|derogator\w+)`;
const QUALIFIED_ITEM = String.raw`(?:(?:inaccurate|incorrect|erroneous|unverifiable|unverified|outdated|obsolete|disputed|delinquent|adverse|harmful|hurtful|damaging|unfavou?rable|bad|past[\s-]due|charged[\s-]off|late|collection)\s+(?:[\w-]+\s+)?(?:accounts?|information|records?|data|entries|histor(?:y|ies))|credit\s+accounts?)`;
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
const CLAUSE_STOP_G = new RegExp(CLAUSE_STOP.source, 'gi');
/** The text after the last clause stop of `s`, and the text before the first (what splitting by CLAUSE_STOP gives, without the split). */
function sinceClauseStart(s: string): string { let from = 0; for (const m of s.matchAll(CLAUSE_STOP_G)) from = m.index + m[0].length; return s.slice(from); }
function untilClauseEnd(s: string): string { const m = CLAUSE_STOP.exec(s); return m ? s.slice(0, m.index) : s; }
interface Scope { before: string; after: string; clause: string; sentence: string }
// The same word's scope is read several times (removalExempt, dataPractice, contextExempt): the last text's are kept.
let scopeText = '';
const scopeMemo = new Map<number, Scope>();
function removalScope(text: string, at: number, end: number): Scope {
  if (text !== scopeText) { scopeText = text; scopeMemo.clear(); }
  const key = at * 65536 + end;
  const known = scopeMemo.get(key);
  if (known) return known;
  const word = text.slice(at, end);
  // Cut with the word in place, so that "… and we will delete" stops at "and" when "we" starts the word.
  const last = sinceClauseStart(text.slice(Math.max(0, at - 160), end));
  const before = last.endsWith(word) ? last.slice(0, last.length - word.length) : sinceClauseStart(text.slice(Math.max(0, at - 160), at));
  const after = untilClauseEnd(text.slice(end, end + 160));
  const sentence = `${sinceSentenceStart(text.slice(Math.max(0, at - 240), at))}${word}${untilSentenceEnd(text.slice(end, end + 240))}`;
  const scope = { before, after, clause: `${before}${word}${after}`, sentence };
  scopeMemo.set(key, scope);
  return scope;
}

/** The agency's own places: "from our servers", "in our billing system", "from our mailing list or newsletter", "from your portal". */
const OWN_PLACE = String.raw`\b(?:from|in|on|off|out\s+of)\s+(?:(?:our|my)\s+(?:own\s+)?(?:systems?|servers?|storage|files?|records?|databases?|billing\s+systems?|(?:mailing|contact|email|marketing|call(?:ing)?|text(?:ing)?)\s+lists?|lists?|newsletters?|archives?|backups?|cloud|platform|app|website|site|software|offices?|portal|crm)|your\s+(?:portal|workspace|dashboard|client\s+file|(?:portal|user|online|client|login)\s+(?:account|profile))|the\s+(?:client\s+)?(?:portal|app))\b`;
/*
 * The agency's own records: the client's documents, uploads (the files or photos they uploaded or sent), data, records,
 * client or case file, messages, notes, recordings, login, signature, card, bank, billing or payment details, Social
 * Security number, date of birth, ID, driver's license or passport and photos of them, email address, phone number,
 * consent, the answers to an intake form, copies of their reports, their portal or user account; and anything taken
 * from the agency's own places.
 * "Your account" on its own is not one of them (ownAccount below), and neither is a bare "file", "information" or
 * "profile", which can be a credit file (BARE_OWN below).
 */
const OWN_RECORD = new RegExp(String.raw`\b(?:documents?|letters?|drafts?|versions?|uploads?|uploaded\s+(?:files?|documents?|images?|photos?)|(?:files?|documents?|photos?|images?|pictures?)\s+(?:that\s+|which\s+)?you\s+(?:upload(?:s|ed)?|sen[dt]|provided?|gave|give|share[ds]?)|(?:client|case)\s+files?|data|records|messages?|e-?mails?|texts?|chats?|recordings?|voicemails?|notes?|logins?|credentials|passwords?|signatures?|(?:personal|contact|account|billing|payment|bank(?:\s+account)?|card|login)\s+(?:information|data|details|info|numbers?|methods?|credentials)|(?:portal|user|online|client|login)\s+profiles?|cop(?:y|ies)\s+of|(?:credit\s+|debit\s+)?cards?|social\s+security\s+numbers?|ssns?|dates?\s+of\s+birth|photos?\s+of\s+your\s+(?:[\w'’-]+\s+){0,2}?(?:id|license|licence|passport|card|identification)|driver['’]?s?\s+licen[cs]es?|passports?|ids?|identification(?:\s+documents?)?|email\s+address(?:es)?|phone\s+numbers?|consents?|authorizations?|(?:portal|user|online|client|login)\s+accounts?|account\s+with\s+us|answers?|responses?\s+(?:you\s+)?(?:typed|gave|entered|submitted)|(?:staff|employee|team|admin|user|agent)\s+(?:access|logins?|permissions?)|access\s+(?:rights|permissions?)|(?:intake|enrol(?:l)?ment|sign-?up|application|questionnaire)\s+(?:forms?|answers?|responses?)|questionnaires?)\b|${OWN_PLACE}`, 'i');
/**
 * A bare "file", "information" or "profile" is the agency's record only where the sentence says how the agency
 * handles its records: when the client closes the account or the agreement ends (CLOSING), at the client's request
 * ("within 30 days of your request", "when you ask"), or how long it keeps them (RETENTION: "we keep your information
 * for five years, then delete it", "when it is no longer needed", "30 days after your last payment", "files are
 * deleted after two years"; not seven or ten years, the reporting periods of the law). "We delete your
 * file within 30 days after the agreement ends" passes; "we remove the account from your file" and "we remove harmful
 * information within 60 days" do not (namesCredit is read first).
 */
const BARE_OWN = /\b(?:files?|information|info|profiles?)\b/i;
const RETENTION = new RegExp(String.raw`\b(?:keep|keeps|kept|retain\w*|stor(?:e|es|ed|ing)|hold(?:s|ing)?)\b[^.;]{0,80}\b(?:for|until)\b|\bno\s+longer\s+(?:needed|required|necessary)\b|\bafter\s+your\s+last\s+(?:payment|login|visit|activity|contact|message)\b|\bafter\s+(?!(?:seven|7|ten|10)\s)${NUM}\s+(?:years?|months?)\b`, 'i');
const CLIENT_REQUEST = /\b(?:of|after|upon|on|following)\s+(?:your|a|any|the\s+client['’]s)\s+(?:written\s+|verified\s+|valid\s+)?request\b|\b(?:when|if|once|whenever|after)\s+you\s+(?:ask|request|tell\s+us|write\s+to\s+us)\b|\bat\s+your\s+request\b|\bupon\s+(?:a\s+)?(?:valid\s+|written\s+)?request\b/i;
/**
 * Own records whose words name something on a credit report, set aside before looking for one: "copies of your credit
 * reports", "the credit reports you uploaded", "the utility bills and paystubs you uploaded", "credit card details",
 * "bank account details", "bank statements", "your saved bank account", "staff accounts", "support inquiries you send
 * us".
 */
const OWN_WITH_CREDIT_WORD = /\b(?:bills?|statements?|pay\s?stubs?|w-?2s?)(?:,?\s+(?:and|or)\s+[\w-]+(?:\s+[\w-]+)?){0,2}\s+(?:that\s+|which\s+)?you\s+(?:upload|sen[dt]|provide|gave|give|share|mail)\w*|\b(?:staff|employee|team|admin|user|agent)\s+accounts?\b|\b(?:saved|stored|linked|connected)\s+(?:bank\s+)?(?:accounts?|cards?|payment\s+methods?)\b|\bcop(?:y|ies)\s+of\s+(?:[\w'’-]+\s+){0,3}?(?:credit\s+)?reports?\b|\b(?:(?:the|your|any)\s+)?(?:credit\s+)?reports?\s+(?:that\s+|which\s+)?you\s+(?:upload(?:s|ed)?|sen[dt]|provided?|gave|give|share[ds]?)\b|\buploaded\s+(?:credit\s+)?reports?\b|\b(?:credit|debit)\s+cards?(?:\s+(?:information|details|numbers?|on\s+file))?\b|\bbank\s+(?:account\s+)?(?:details|information|info|numbers?|statements?)\b|\baccount\s+(?:information|details|settings|passwords?)\b|\b(?:portal|user|online|client|login)\s+accounts?\b|\bsupport\s+(?:inquir(?:y|ies)|requests?|tickets?)\b|\binquir(?:y|ies)\s+(?:that\s+)?you\s+(?:send|sent|make|made|submit(?:ted)?)(?:\s+(?:to\s+)?us)?\b/gi;
/**
 * Words of a credit file: the items above, the bureaus, the consumer reporting agencies (also ChexSystems, Early
 * Warning, LexisNexis, Innovis, SageStream, NCTUE), creditors, lenders, banks, collectors and furnishers, "credit",
 * reports, accounts, loans, bills, repos, evictions, hard pulls, public records, scores, information that cannot be
 * verified, and what the client disputes.
 */
const CREDIT_HINT = new RegExp(String.raw`\b(?:${QUALIFIED_ITEM}|${REPORT_ITEM}|${ON_REPORT})\b|\b(?:credit|bureaus?|equifax|experian|transunion|reports?|accounts|loans?|bills?|repos?|evictions?|hard\s+pulls?|tradelines?|inquir\w*|(?:consumer\s+|credit\s+)?reporting\s+agenc(?:y|ies)|cras?|chex\s?systems?|early\s+warning|lexis\s?nexis|innovis|sage\s?stream|nctue|creditors?|lenders?|banks?|collectors?|furnishers?|public\s+records?|scores?|fico)\b|\b(?:cannot|can\s+not|can['’]?t|could\s+not|couldn['’]?t)\s+be\s+verified\b|\bunverif\w*|\b(?:you|we|they)\s+disput\w*`, 'i');
/** "from <somewhere>" that is not the agency's own place, a time or a person: read as from a credit file ("from ChexSystems", "from the furnisher's records"). */
const FROM_ELSEWHERE = /\bfrom\s+(?!(?:our|my)\s|your\s+(?:portal|profile|workspace|dashboard|client\s+file|files?|(?:portal|user|online|client|login)\s+account)\b|(?:the\s+)?(?:client\s+)?(?:portal|app|platform|date|day|time|moment|end|start|beginning|outset|effective\s+date)\b|(?:the|your|our)\s+(?:documents?|uploads?|files?|settings|profile|messages?|account|billing|home|dashboard|letters?|disputes?)\s+(?:page|tab|screen|section|folder|menu)\b|(?:the|those|these|such|any|all)\s+(?:lists?|mailings?)\b|(?:now|then|today|signing|when|you|us|them|it|this|that|day|time)\b)[\w'’$-]+/i;
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

/**
 * A list, a plan or a letter in the app, not a credit file: "remove any item from your dispute list", "take an item off
 * the list", "add or remove items from your dispute plan", "remove it from your next round of letters". Not a list that
 * is a credit file by another name ("the list of accounts your lenders see", "the list your creditors report").
 */
const IN_APP_LIST = /\b(?:from|off)\s+(?:your|the|our|this)\s+(?:(?:dispute|next|first|current|upcoming)\s+)?(?:list|letters?|selection|queue|drafts?|plan|round(?:\s+of\s+(?:letters|disputes))?)\b(?!\s+(?:of\s+(?:accounts|items|debts|collections)|(?:that\s+|which\s+)?(?:your\s+)?(?:lenders?|creditors?|banks?|bureaus?)))/i;
const ON_CREDIT_FILE = /\b(?:from|off)\s+(?:(?:your|the|their|all|each|every|both)\s+)?(?:(?:three|3)\s+)?(?:credit|bureaus?|equifax|experian|transunion|reports?|files?)\b/i;

/** Whether the clause of a removal names anything on a credit file, once the agency's own records that use such words are set aside. */
function namesCredit(clause: string): boolean {
  const rest = clause.replace(OWN_WITH_CREDIT_WORD, ' ');
  return CREDIT_HINT.test(rest) || FROM_ELSEWHERE.test(rest) || ACCOUNT_ELSEWHERE.test(rest);
}

/*
 * A removal is a data practice, and passes in a contract, only when what it removes is the agency's own record
 * (OWN_RECORD, a bare file or information with a CLOSING or CLIENT_REQUEST in the sentence, the client's account with
 * the agency) and its clause names nothing on a credit file (namesCredit): no bureau or other consumer reporting agency,
 * no creditor, no "credit" (other than a credit card), no report (other than the copies the client gave), no item,
 * account, loan or debt of the kind a report lists, and nothing taken "from" anywhere but the agency's own systems. So
 * "we delete your documents within 30 days of your request", "we delete the credit reports you uploaded" and "your
 * credit card is removed from our billing system" pass, while "we remove accounts from Experian", "we delete your
 * account with the original creditor" and "we remove your personal information from ChexSystems" do not.
 *
 * What is removed is read from the removal's own clause, except with a pronoun object ("we keep your records for five
 * years, then delete them") or a passive with no subject of its own ("emails are kept for two years and then deleted",
 * "…, and then they are deleted"): then from the sentence up to the removal, where the thing was named, never from a
 * clause after it ("our team then deletes them and sends you copies of the letters" names no record of the agency's).
 */
function dataPractice(text: string, at: number, end: number): boolean {
  const verb = REMOVE_STEM.exec(text.slice(at, end));
  const verbAt = verb ? at + verb.index : at;
  const verbEnd = verb ? verbAt + verb[0].length : end;
  const { after, clause, sentence } = removalScope(text, verbAt, verbEnd);
  // The sentence up to the removal verb (with whatever of the match came before it, such as "we").
  const lead = sinceSentenceStart(text.slice(Math.max(0, verbAt - 240), verbAt));
  const verbText = text.slice(verbAt, verbEnd);
  const pronoun = PRONOUN_OBJECT.exec(after);
  // A participle ("… and then deleted"), not a verb with its own object ("… and delete your documents").
  const passive = !pronoun && /ed$/i.test(verbText) && passiveLead(lead);
  // What is removed (its object, or for a pronoun or a passive the sentence before it), and the words that say where
  // from (the rest of the removal's own clause too: "then delete them from your credit report").
  const what = pronoun ? `${lead}${verbText}${pronoun[0]}` : passive ? `${lead}${verbText}` : clause;
  const scope = pronoun || passive ? `${lead}${verbText}${after}` : clause;
  const object = pronoun || passive ? what : `${verbText}${after}`;
  if (IN_APP_LIST.test(scope) && !ON_CREDIT_FILE.test(scope)) return true;
  // The client taken off something ("we remove you from our newsletter", "removing yourself as an authorized user").
  if (PERSON_OBJECT.test(after) && !ON_CREDIT_FILE.test(after) && !(/\bfrom\b/i.test(after) && (namesCredit(after) || SCREENING.test(after)))) return true;
  // A security freeze or fraud alert the client lifts, or their name taken off marketing lists or prescreened offers, is
  // neither a record of the agency's nor an item on a credit report, where it is what the removal removes.
  if (NOT_A_RESULT_ONE.test(object) && !namesCredit(object.replace(NOT_A_RESULT, ' ')) && !ON_CREDIT_FILE.test(after)) return true;
  if (namesCredit(scope)) return false;
  return OWN_RECORD.test(what) || (BARE_OWN.test(what) && (CLOSING.test(sentence) || CLIENT_REQUEST.test(sentence) || RETENTION.test(sentence)))
    || what.replace(OWN_WITH_CREDIT_WORD, ' ') !== what || ownAccount(clause, sentence);
}

/** The removal verb inside a match that may start before it ("we delete the old routing and account"). */
const REMOVE_STEM = /\b(?:remov|delet|eras|wip|purg|expung)\w*/i;
const PRONOUN_OBJECT = /^\s*(?:it|them|those|these|this|that|both|all\s+of\s+them)\b/i;
/** Screening and public-record databases that are credit files by another name. */
const SCREENING = /\b(?:public\s+records?|tenant\s+screening|background\s+(?:check|screening)|screening\s+(?:database|company|report)|consumer\s+(?:database|file)|do-?not-?lend|blacklists?|databases?\s+(?:of|for)\s+(?:lenders?|banks?|landlords?))\b/i;
/**
 * "You" or "yourself" as what is removed, from one of the agency's lists or as an authorized user on someone's card (not
 * from a credit file by another name: "the ChexSystems database", "public records databases", "the tenant screening
 * database").
 */
const PERSON_OBJECT = /^\s*(?:you|yourself)\s+(?:as\s+(?:an?\s+)?authori[sz]ed\s+users?\b|from\s+(?:our|my|the|this|that|those|these|any|all|every)\b)/i;
/**
 * A passive with no subject of its own, read at the end of the sentence before the participle: "… and then [deleted]",
 * "…, and then they are [deleted]", "They are then [deleted]": a run of these words (and, then, a pronoun, is or are,
 * permanently…) right after a clause boundary (the start, a comma, "and", "or", "then"). It needs at least one word, so
 * it never matches empty text, and a clause with its own subject is none ("your account with us is [deleted]", "…, we
 * [delete]"). One run of words, read on the last 80 characters, so that it cannot backtrack far.
 */
const PASSIVE_LEAD = /(?:^|[,;]|\b(?:and|or|then))\s*(?:(?:and|or|then|also|later|afterwards?|they|it|these|those|both|all\s+of\s+them|each|which|are|is|will\s+be|shall\s+be|get|gets|may\s+be|can\s+be|would\s+be|have\s+been|has\s+been|permanently|securely|automatically|promptly)\s+)*$/i;
const passiveLead = (lead: string) => { const m = PASSIVE_LEAD.exec(lead.slice(-80)); return !!m && /\w/.test(m[0]); };
const FREEZE_AT = String.raw`(?:\s+(?:with|at|from|on)\s+(?:(?:each|every|all|the|both|any|your)\s+)?(?:(?:three|3)\s+)?(?:(?:credit|nationwide)\s+)?(?:bureaus?|equifax|experian|transunion|(?:consumer\s+|credit\s+)?reporting\s+agenc(?:y|ies)))?`;
const NOT_A_RESULT_SOURCE = String.raw`\b(?:security|credit)\s+freezes?${FREEZE_AT}|\bfraud\s+alerts?${FREEZE_AT}|\b(?:pre-?screened|firm)\s+(?:credit\s+)?offers?\b|\bopt(?:s|ed|ing)?[\s-]+out\b|\b(?:marketing|mailing|telemarketing|solicitation)\s+lists?\b|\bnames?\s+(?:off|from)\s+(?:(?:our|the|your|any|all|these|those|their|this|that|mailing|marketing|call(?:ing)?|telemarketing|solicitation|contact|e-?mail|text(?:ing)?|prescreen(?:ed|ing)?|do-?not-?call)\s+){0,2}?lists?\b`;
const NOT_A_RESULT = new RegExp(NOT_A_RESULT_SOURCE, 'gi');
const NOT_A_RESULT_ONE = new RegExp(NOT_A_RESULT_SOURCE, 'i');

/** Whether a removal found at text[at, end) is about something on a credit report: anything that is not a data practice. */
const aboutCredit = (text: string, at: number, end: number): boolean => !dataPractice(text, at, end);

/**
 * A statement of the law: the bureau "must correct or delete" information "that cannot be verified", "the law requires
 * it to correct or delete that item", "if the furnisher does not respond in time, the bureau must delete the disputed
 * account", "a bureau must block or remove information that resulted from identity theft" (an obligation right before
 * the verb, and in the same sentence information that cannot be verified, a furnisher that does not respond, or
 * identity theft).
 */
const OBLIGED = /\b(?:must|shall|ha(?:s|ve)\s+to|(?:is|are)\s+(?:required|obligated|obliged)\s+to|(?:law|statute|act|fcra|regulations?|rules?)\s+(?:requires?|obligates?)\s+(?:[\w'’-]+\s+){0,3}?to)\s+(?:be\s+)?(?:(?:promptly|either)\s+)?(?:[\w-]+\s+(?:or|and|and\/or)\s+)?$/i;
const UNVERIFIED = /\b(?:cannot|can\s+not|can['’]?t|could\s+not|couldn['’]?t|unable\s+to|fails?\s+to|does\s+not|doesn['’]?t|do\s+not|don['’]?t|is\s+not|are\s+not|isn['’]t|aren['’]t)\s+(?:be\s+)?verif\w*|\bunverif\w*|\bnot\s+(?:be\s+)?verified\b|\b(?:does\s+not|doesn['’]t|do\s+not|don['’]t|did\s+not|didn['’]t|fails?\s+to|failed\s+to)\s+respond\b|\bidentity\s+theft\b/i;
/**
 * A condition or a question, not a promise: "if an item is deleted, we let you know", "the bureaus decide whether an
 * item is corrected, updated or deleted", "we do not charge extra when an item is deleted", "when an item is removed,
 * it is because the bureau decided so". The last "if" or "whether" of the sentence before the verb, with no comma
 * between, or only a list of what may happen ("is corrected, updated or …"); or "when", "whenever" or "once" with an
 * item of no one in particular as the subject of a passive removal ("when an item is deleted", "whenever any account is
 * removed"), or a bureau as the subject of an active one ("when a bureau deletes…"). "If you sign today, we delete…" is
 * no condition on the removal, and neither is "if you enroll this week we delete…" (the agency right before the verb,
 * AGENCY_SUBJECT, makes it the main clause), "if you enroll today every collection is deleted…" or "if our letters go
 * out this week your late payments are gone…" (with no comma, a condition that is the client's purchase or the
 * agency's own act is followed by the main clause).
 */
const CONDITION_PASSIVE = /\b(?:when|whenever|once|if|in\s+case)\s+(?:(?:an?|any|one|some)\s+(?:(?!(?:we|our|i|you|us|they|is|are|was|were|be|been|every|all|each)\b)[\w'’-]+\s+){1,3}?(?:is|are|was|were|gets?|got|has\s+been|have\s+been|had\s+been)\s+(?:(?:later|eventually|ever|actually|finally)\s+)?|(?:a|an|the|any|each)\s+(?:credit\s+)?(?:bureaus?|furnishers?|creditors?|lenders?)\s+(?:(?:later|ever|actually|then)\s+)?)$/i;
/** A condition that is the client's purchase or signing, or the agency's own act: "if you enroll today", "if our letters go out this week". */
const OWN_CONDITION = /\b(?:enrol\w*|sign(?:s|ed|ing)?|join\w*|hire\w*|pay(?:s|ing)?|paid|buy\w*|bought|purchas\w*|start\w*|subscrib\w*)\b|^\s*(?:we|our|us)\b/i;
function hypothetical(before: string): boolean {
  let from = -1;
  for (const m of before.matchAll(/\b(?:if|whether)\b/gi)) from = m.index + m[0].length;
  if (from >= 0) {
    const rest = before.slice(from);
    if (!/[;:]/.test(rest)) {
      if (!rest.includes(',')) { if (!OWN_CONDITION.test(rest)) return true; }
      else if (/^[^,]*\b(?:is|are|was|were|be|been|get|gets|got|to)\s+[\w-]+\s*,/i.test(rest) && /,\s*(?:[\w-]+\s*,\s*)*[\w-]+\s+(?:or|and)\s+$/i.test(rest)) return true;
    }
  }
  return CONDITION_PASSIVE.test(before.slice(-120));
}
/** The agency right before a removal verb, as its subject: "… we delete", "… our team will remove". */
const AGENCY_SUBJECT = /\b(?:we|i|our\s+(?:team|firm|company|staff|specialists?|attorneys?|agency|experts?))\s+(?:(?:will|can|then|also|now|just|\w+ly)\s+){0,2}$/i;
/**
 * What the client is told happened: "which items were deleted, updated or verified", "we tell you when an item has been
 * deleted", "we will tell you in writing which accounts the bureaus verified and which they removed", "when a bureau
 * tells us an item was deleted", "a response that shows an account as deleted", "notices that an item was deleted" (a
 * notice of what has happened: past tense only). Not the agency's own act ("what we do is delete…", "we mark your
 * collections as deleted"), and not with a time frame for the removal after it ("we tell you when each collection is
 * deleted, which happens within 30 days").
 */
const TOLD = String.raw`(?:tell|tells|told|let|lets|notify|notifies|notified|inform|informs|informed|show|shows|showed|update|updates|email|emails|alert|alerts|see|know|confirm|confirms|confirmed|report|reports|reported)`;
const REPORTED = new RegExp([
  String.raw`(?:\b(?:which|what)|\b${TOLD}\s+(?:(?:you|us)\s+)?(?:know\s+)?(?:(?:in\s+writing|by\s+(?:mail|e-?mail|letter|text))\s+)?(?:when|whether|if|which|what|how\s+many))\s+(?!(?:we|our|i|us)\b)(?:[\w'’-]+\s+){0,4}?(?:is|are|was|were|has\s+been|have\s+been|had\s+been|gets?|got)\s+(?:[\w-]+,?\s+(?:or\s+|and\s+)?){0,3}?$`,
  // "a bureau tells us an item was deleted", "the bureau confirmed that the account had been removed".
  String.raw`\b${TOLD}\s+(?:you|us)\s+(?:(?:in\s+writing|by\s+(?:mail|e-?mail|letter|text))\s+)?(?:that\s+)?(?:(?!(?:we|our|i|us|you)\b)[\w'’-]+\s+){1,4}?(?:was|were|has\s+been|have\s+been|had\s+been)\s+$`,
  // "notices that an item was deleted", "the bureau's letter confirming that the late payment was removed".
  String.raw`\b(?:notices?|notifications?|confirmations?|confirming|letters?|proof|responses?|results?)\s+(?:(?:from\s+)?(?:the\s+|a\s+|each\s+)?(?:bureaus?|furnishers?|creditors?)\s+)?that\s+(?:(?!(?:we|our|i|us)\b)[\w'’-]+\s+){0,4}?(?:was|were|has\s+been|have\s+been|had\s+been)\s+(?:[\w-]+,?\s+(?:or\s+|and\s+)?){0,3}?$`,
  // "a response that shows an account as deleted", "the bureau lists the late payment as removed" (not "we mark…").
  String.raw`(?<!\b(?:we|i)\s{1,3}(?:(?:will|can|also|then|just)\s{1,3})?)\b(?:shows?|showed|shown|lists?|listed|marks?|marked|codes?|coded|reports?|reported)\s+(?:an?|the|each|any|every|your|that|this|those|these)\s+(?:[\w'’-]+\s+){0,2}?as\s+$`,
].join('|'), 'i');
/** The same with a bureau as the subject of a past removal: "we will tell you in writing which accounts the bureaus verified and which they removed". */
const REPORTED_ACTIVE = new RegExp(String.raw`\b${TOLD}\b[^.!?;:]{0,120}?\bwhich\s+(?:(?:ones?|items?|accounts?|of\s+them)\s+)?(?:they|it|the\s+(?:credit\s+)?bureaus?|the\s+furnishers?|the\s+creditors?|each\s+bureau)\s+(?:have\s+|has\s+|had\s+)?$`, 'i');
const reported = (inSentence: string, word: string) => REPORTED.test(inSentence) || (/ed$/i.test(word) && REPORTED_ACTIVE.test(inSentence));
/**
 * An explanation of the law's timing or of a bureau's reply: "we explain how long each item can remain on your report
 * and when it should drop off", "we explain each bureau's response, including any deletions". Not the agency's own
 * removal, one it presupposes or one sooner than the law's ("we explain when we delete…", "…when your items will be
 * deleted", "we explain why your collections are deleted so quickly", "…how long items take to be removed with our
 * method").
 */
const EXPLAINED = /\b(?:explain|explains|explained|explaining|describe|describes|teach|teaches)\b[^.!?;:]{0,100}?\b(?:(?:when|whether|how\s+long|why)\s+(?:(?!(?:we|our|i|you|will|going|gonna)\b)[\w'’-]+\s+){1,4}?|(?:including|such\s+as)\s+(?:any\s+)?)$/i;
const explainedOnly = (inSentence: string, rest: string) => EXPLAINED.test(inSentence) && !SOONER.test(rest) && !/\b(?:with|by|using|through)\s+(?:our|us)\b|\bso\s+(?:quickly|fast|soon)\b/i.test(rest);
/**
 * The client's own wish: "the items you want removed", "accounts you would like to have deleted" (not "the items you
 * choose are deleted", "the items you want removed and we remove them").
 */
const WISHED = /\b(?:you|clients?|the\s+client)\s+(?:(?:may|might|would|do|does)\s+)?(?:want|wants|wish|wishes|like|choose|chooses|select|selects|hope|hopes)\s+(?:(?:to\s+)?(?:have|get|see)\s+)?(?:(?!(?:is|are|was|were|will|be|been|get|gets|and|or|but|so|then|we|our|i|they|it)\b)[\w'’-]+\s+){0,3}?$/i;
/**
 * A removal disclaimed or left to a bureau after it, in its own clause: "removal of any item is not guaranteed", "a
 * deletion is never promised", "removal of inaccurate information is decided by each bureau after its investigation".
 * Not across a new clause ("late payments are removed in most cases although results are not guaranteed"), and not
 * when it says who does promise or deliver it ("…is not promised, just delivered", "…is not guaranteed by the bureaus
 * but by us").
 */
const AFTER_WORDS = String.raw`(?:\s+(?!(?:although|though|but|and|or|while|whereas|however|yet|so|we|you|they|it|this|that|which|who|whose|results?)\b)[\w'’-]+){0,6}?`;
const NOT_BUT_US = String.raw`(?![^.!?;]*\b(?:but|just|only|rather|instead|by\s+(?:us|our|me))\b)`;
const DISCLAIMED_AFTER = new RegExp(String.raw`^${AFTER_WORDS}\s+(?:(?:is|are|will\s+be|can\s+be|could\s+be)\s+(?:not|never)|cannot\s+be|can\s+not\s+be|can['’]t\s+be)\s+(?:guaranteed|promised|assured|warranted|certain)\b${NOT_BUT_US}`, 'i');
const DECIDED_AFTER = new RegExp(String.raw`^${AFTER_WORDS}\s+(?:is|are|will\s+be)\s+(?:(?:always|only|solely)\s+)?(?:decided|determined|made|controlled)\s+(?:only\s+|solely\s+)?by\s+(?:the|each|a|any|every)\s+(?:credit\s+)?(?:bureaus?|furnishers?|creditors?|lenders?|cras?|(?:consumer\s+|credit\s+)?reporting\s+agenc(?:y|ies))\b${NOT_BUT_US}`, 'i');
/**
 * A removal noun that names what a bureau did or does, as a thing: "every deletion the bureaus report to us", "any
 * deletion shown in your portal", "deletion of an item by one bureau", "before the deletion".
 */
const NOUN_REPORTED = /^\s+(?:(?:that|which)\s+)?(?:the\s+|a\s+|each\s+|any\s+)?(?:credit\s+)?(?:bureaus?|furnishers?|creditors?|cras?|experian|equifax|transunion)\s+(?:reports?|reported|sends?|sent|confirms?|confirmed|makes?|made|lists?|listed|shows?|showed|records?|recorded)\b|^\s+(?:shown|listed|reported|recorded|confirmed|noted)\b|^\s+(?:of\s+(?:[\w'’-]+\s+){1,4}?)?by\s+(?:(?:a|an|one|the|each|any|that|this|every)\s+)?(?:credit\s+)?(?:bureaus?|furnishers?|creditors?|cras?|experian|equifax|transunion)\b/i;
const NOUN_AT_TIME = /\b(?:before|after|since|prior\s+to|following)\s+(?:the|a|its|their|any|each|that)\s+$/i;
/**
 * A right no one has (15 U.S.C. § 1679c(a)): "neither you nor any 'credit repair' company or credit repair organization
 * has the right to have accurate, current, and verifiable information removed from your credit report". Not "nobody but
 * our team has the right…", and not with an exception after it ("…, except our clients": promiseAfter).
 */
const NO_RIGHT = /\b(?:neither|nor|no\s+one|nobody|no\s+(?:[\w'’-]+\s+){0,3}?(?:company|organi[sz]ation|person|consumer|business))\b(?:(?!\b(?:but|except|besides|save)\b)[^.!?;:]){0,120}?\b(?:has|have)\s+(?:the|a|any)\s+(?:legal\s+)?right\s+to\s+(?:have\s+)?(?:(?!(?:but|however|yet|so|then|we|our|i|they|remov\w*|delet\w*|eras\w*)\b)[\w'’-]+,?\s+){0,6}?$/i;
/**
 * The reporting periods of the law (15 U.S.C. § 1681c): most negative information may be reported (or stay, remain) for
 * up to seven years, a bankruptcy for ten, and "only if it is over 7 years old" in the words of § 1679c(a). "For" counts
 * only after such a verb, so a tenure is none ("for 10 years, our clients have…", "over the past 10 years").
 */
const YEARS = String.raw`(?:seven|7|ten|10)(?:\s*(?:or|to|-|–)\s*(?:seven|7|ten|10))?\s+years`;
const OBSOLETE = new RegExp(String.raw`\b(?:after|up\s+to|older\s+than|more\s+than|beyond)\s+${YEARS}\b|\b(?:report\w*|stay\w*|remain\w*|appear\w*|listed|kept)\b[^.!?;]{0,80}?\bfor\s+(?:up\s+to\s+)?${YEARS}\b|\bover\s+(?:seven|7|ten|10)\s+years\s+old\b`, 'i');
/**
 * A bureau or furnisher as the one who removes: "after which the bureau removes them", "a bureau that deletes an item",
 * "should a bureau ever reinstate an account it deleted" ("it" or "they" after a bureau named earlier in the sentence).
 */
const BUREAU_SUBJECT = /\b(?:the\s+|a\s+|each\s+|any\s+)?(?:credit\s+)?(?:bureaus?|furnishers?|creditors?|(?:consumer\s+|credit\s+)?reporting\s+agenc(?:y|ies)|cras?|experian|equifax|transunion)\s+(?:(?:that|which|who)\s+)?(?:(?:must|will|shall|then|later|automatically|generally|usually|typically)\s+)?$/i;
const BUREAU_NAMED = /\b(?:bureaus?|furnishers?|creditors?|cras?|experian|equifax|transunion)\b/i;
const bureauSubject = (inSentence: string) => BUREAU_SUBJECT.test(inSentence) || (/\b(?:it|they)\s+(?:(?:had|has|have|then|later)\s+)?$/i.test(inSentence) && BUREAU_NAMED.test(inSentence));
/** Putting a deleted item back, which the law lets a bureau do only with notice (15 U.S.C. § 1681i(a)(5)(B)). */
const REINSERTED = /\b(?:re-?insert\w*|reinstat\w*|puts?\s+(?:it|them|the\s+\w+)\s+back|(?:be|is|are|was|were|been|being|get|gets|got)\s+put\s+back|put\s+back|reappear\w*|reported\s+again|(?:comes?|came|coming)\s+back|return(?:s|ed|ing)?\s+to\s+(?:a|the|your)\s+(?:credit\s+)?reports?)\b/i;
/**
 * A removal before the reporting period ends, or of newer items, which no law says: "sooner with our help", "newer ones
 * too", "our clients don't wait that long".
 */
const SOONER = /\b(?:sooner|faster|quicker|earlier|quickly|right\s+away|instead\s+of\s+waiting|newer|younger|more\s+recent|that\s+long)\b|(?:\b(?:do|does|will|need)\s+not|n['’]t|\bnever)\s+(?:have\s+to\s+|need\s+to\s+)?wait\b/i;
/** A participle used as an adjective before what it names: "removed items", "a deleted account", "the deleted collection". */
const PARTICIPLE_BEFORE = /(?:^\s*|\b(?:a|an|the|any|each|some|those|these|its|their|such|previously|already|once)\s+)$/i;
/** The same as a relative clause: "an item that is deleted can be put back…", "accounts that were removed may reappear". */
const RELATIVE_PASSIVE = /\b(?:an?|any|the|some)?\s*(?:[\w-]+\s+)?(?:items?|accounts?|collections?|entries|information|late\s+payments?|debts?|records?|tradelines?|marks?)\s+(?:that|which)\s+(?:is|are|was|were|has\s+been|have\s+been|had\s+been|gets?|got)\s+(?:(?:later|ever|once|previously)\s+)?$/i;
const PARTICIPLE_NOUN = /^\s+(?:[\w-]+\s+)?(?:items?|accounts?|collections?|entries|information|late\s+payments?|debts?|records?|tradelines?|inquir(?:y|ies)|charge-?offs?|marks?|judgments?|liens?)\b/i;
/** Medical debt the bureaus stopped reporting: "paid medical collections should no longer appear on your reports". */
const MEDICAL_RULE = /\b(?:paid\s+)?medical\s+(?:collections?|debts?|bills?|accounts?)\b/i;
/**
 * A statement of the reporting law, not a promise: what a bureau does after the reporting period ("late payments stay on
 * your report for up to seven years, after which the bureau removes them"), what falls off after it with no one of the
 * agency's doing it in its clause ("most negative items fall off your report after seven years"), the rule for putting a
 * deleted item back ("a bureau that deletes an item and later puts it back must notify you", "should a bureau ever
 * reinstate an account it deleted, the law requires it to tell you", "a deleted account can be put back on your report
 * if the furnisher later certifies it", "removed items sometimes reappear"), a deleted item others may still see
 * ("lenders may still see a deleted collection", also "an item that is deleted can be put back…"), and medical debt the
 * bureaus no longer report. Never with SOONER in the
 * sentence, never with the agency in the clause.
 */
function lawOfReporting(inSentence: string, clause: string, sentence: string, word = '', after = ''): boolean {
  if (SOONER.test(sentence)) return false;
  if (bureauSubject(inSentence) && (OBSOLETE.test(sentence) || (REINSERTED.test(sentence) && /\b(?:must|shall|required|requires|law|fcra)\b/i.test(sentence)))) return true;
  const agency = /\b(?:we|our|us|i)\b/i.test(clause);
  if (OBSOLETE.test(clause) && !agency) return true;
  const named = (PARTICIPLE_BEFORE.test(inSentence.slice(-30)) && PARTICIPLE_NOUN.test(after)) || RELATIVE_PASSIVE.test(inSentence.slice(-80));
  if (/ed$/i.test(word) && named && !agency && !/\b(?:will|['’]ll|guarantee\w*)\b/i.test(clause) && !TIMED.test(sentence)) {
    const back = REINSERTED.exec(clause);
    if (back && !/(?:\b(?:never|not|no|rarely|cannot)|n['’]t)\s+(?:[\w'’-]+\s+){0,2}$/i.test(clause.slice(0, back.index))) return true;
    if (/\bstill\b/i.test(clause)) return true;
  }
  // "Paid medical collections should no longer appear on your reports" (not "medical bills are removed from your report").
  return /^no\s+longer\b/i.test(word) && /\b(?:should|must|shall|may|can|are|is)\s+$/i.test(inSentence) && MEDICAL_RULE.test(clause) && !agency && !TIMED.test(sentence);
}
/**
 * A possible outcome, one of several: "a dispute can end with the item verified, updated or deleted", "a successful
 * dispute may lead to an item being corrected or removed". Not "can only end with…", and not a second outcome that is
 * certain or the agency's ("…, and for our clients it leads to deletion").
 */
const MAY_LEAD = /\b(?:can|could|may|might)\s+(?:(?!only\b)\w+\s+){0,2}?(?:end|result|lead|conclude)\w*\s+(?:with|in|to)\b(?:(?!\b(?:only|always|our|we|us|leads?|ends?|results?|concludes?)\b)[^;:])*$/i;
const OTHER_OUTCOME = /\b(?:verified|updated|corrected|confirmed|modified|changed|unchanged|kept|remains?|stays?|verification|update|correction)\b/i;
const possibleOutcome = (inSentence: string, sentence: string) => MAY_LEAD.test(inSentence) && OTHER_OUTCOME.test(sentence);
/*
 * A removal named as one outcome in a list of what a bureau may do or decide, in any order: "removed, updated or
 * verified", "corrected, deleted or left unchanged", "keeping, changing or deleting", "verify, update or delete",
 * "eliminadas, corregidas o verificadas". Never the agency's own actions ("we verify and remove…", "our team will
 * verify, update or delete…", "verificamos y eliminamos…"). A list of alternatives that keeps the item as one of them
 * (verified, kept, unchanged) counts as it is. A list of changes only ("corrected or deleted") counts only where
 * something says it may happen (may, can, could, might, a bureau or creditor that decides, "whether") and nothing makes
 * it certain or the agency's: not "will" or "every", "each … ends up corrected or deleted", "either deleted or updated
 * in your favor", a time frame after it or "by our team".
 */
const OUTCOME = String.raw`(?:verif\w*|updat\w*|correct\w*|modif\w*|confirm\w*|chang\w*|keep(?:s|ing)?|kept|remov\w*|delet\w*|eras\w*|(?:left\s+)?unchanged|left\s+as\s+(?:is|it\s+(?:is|was)))`;
const OUTCOME_LIST = new RegExp(String.raw`\b${OUTCOME}(?:\s*,\s*${OUTCOME})*\s*,?\s+(?:or|and|and\/or)\s+${OUTCOME}\b`, 'gi');
const OUTCOME_ES = String.raw`(?:(?:verific|actualiz|correg|corrij|corrig|modific|confirm|manten|mantien|elimin|borr|quit|remov)\p{L}*|sin\s+cambios)`;
const OUTCOME_LIST_ES = new RegExp(String.raw`(?<![\p{L}])${OUTCOME_ES}(?:\s*,\s*${OUTCOME_ES})*\s*,?\s+(?:o|u|y)\s+${OUTCOME_ES}(?![\p{L}])`, 'giu');
const KEPT = /verif|unchanged|\bleft\s+as|\bkeep|\bkept|sin\s+cambios|manten|mantien/i;
/** The agency, "will" or the Spanish future before a list of outcomes (a whole word: "será" ends in a letter \b does not see). */
const AGENCY_OR_FUTURE = /(?<![\p{L}\p{N}_])(?:we|our|i|us|will|going\s+to|ser[aá]n?|vamos)(?![\p{L}\p{N}_])/iu;
/** What says a change may happen, or who decides it. */
const MAY_HAPPEN = /(?<![\p{L}])(?:may|might|can|could|whether|if|decides?|choose|chooses|determines?|bureaus?|furnishers?|creditors?|lenders?|pueden?|podr[ií]an?|decide[n]?|si|bur[oó]s?|acreedor(?:es)?)(?![\p{L}])/iu;
/** What makes a list of changes certain: every item, "ends up", "either … or", "in your favor". */
const CERTAIN_LIST = /(?<![\p{L}])(?:each|every|all|always|either|ends?\s+up|in\s+your\s+favou?r|cada|todas?|todos|siempre)(?![\p{L}])/iu;
function outcomeInList(text: string, at: number, end: number, list: RegExp): boolean {
  const from = Math.max(0, at - 100);
  for (const m of text.slice(from, end + 100).matchAll(list)) {
    // The list holds the removal word (the end of a match such as "fueron eliminadas").
    const s = from + m.index, e = s + m[0].length;
    if (s >= end || e < end) continue;
    const lead = sinceClauseStart(text.slice(Math.max(0, s - 120), s));
    // Who may do it can be named earlier in the sentence ("the credit bureau must then reinvestigate and modify or remove…").
    const sentenceLead = text.slice(Math.max(0, s - 160), s).split(/[;:!?]|(?<!\d)\.|\.(?!\d)/).pop()!;
    const tail = untilSentenceEnd(text.slice(e, e + 160));
    if (AGENCY_SUBJECT.test(lead) || /\p{L}mos(?![\p{L}])/iu.test(m[0])) return false;
    if (KEPT.test(m[0]) && /\s(?:or|o|u|and\/or)\s/i.test(m[0])) return true;
    return !AGENCY_OR_FUTURE.test(lead) && MAY_HAPPEN.test(sentenceLead) && !CERTAIN_LIST.test(`${lead} ${untilClauseEnd(tail)}`)
      && !timedAfter(tail) && !/^[^,;:]*?\bby\s+(?:us|our|me|nosotros|nuestro)\b/i.test(tail);
  }
  return false;
}
/** What a bureau or furnisher decides, named as a thing: "items the bureaus delete or update are shown in your portal". */
const BUREAU_DECIDES = /\b(?:items?|entries|accounts?|information|anything|everything|whatever|what)\s+(?:that\s+|which\s+)?(?:the\s+|a\s+|any\s+|each\s+)?(?:credit\s+)?(?:bureaus?|furnishers?|creditors?|lenders?|companies|company|agenc(?:y|ies)|consumer\s+reporting\s+agenc(?:y|ies)|experian|equifax|transunion|they)\s+(?:may\s+|might\s+|can\s+|could\s+|do\s+|does\s+|did\s+)?$/i;
/**
 * What only a bureau, creditor or furnisher may do or agree to, or decides itself: "only the credit bureaus and
 * furnishers can correct or delete information", "a creditor may agree to remove a late payment as a courtesy",
 * "Experian, Equifax and TransUnion each make their own decision on deletion".
 */
const BUREAU_ACTS = /\b(?:credit\s+)?(?:bureaus?|furnishers?|creditors?|lenders?|experian|equifax|transunion|cras?|consumer\s+reporting\s+agenc(?:y|ies)|companies\s+that\s+report(?:\s+to\s+(?:them|the\s+bureaus))?)\s+(?:(?:can|may|might|could)\s+(?:(?:agree|choose|decide)\s+(?:whether\s+)?to\s+)?|(?:agree|choose|decide)s?\s+(?:whether\s+)?to\s+)(?:(?:[\w'’-]+\s+){1,2}?(?:or|and|and\/or)\s+)?$/i;
const BUREAU_DECISION = /\b(?:bureaus?|furnishers?|creditors?|lenders?|experian|equifax|transunion|cras?)\s+(?:each\s+|alone\s+|themselves\s+)?(?:make|makes|made|reach|reaches|have|has)\s+(?:its|their|a|the)\s+(?:own\s+)?(?:final\s+)?(?:decisions?|determinations?|call|say)\s+(?:on|about|regarding|as\s+to|over)\s+(?:(?:the|any|each|a|every)\s+)?$/i;
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
 * A removal word that promises nothing: negated, disclaimed (before it, or after it: "removal of any item is not
 * guaranteed", "…is decided by each bureau"), a right no one has, requested ("we ask the bureaus to delete…", "we request
 * that the bureaus delete…", "removal requests"), what the client wants removed, a statement of the law, a possible
 * outcome or one of a list of outcomes, what the client is told happened or what is explained, a condition or question,
 * what a bureau did ("every deletion the bureaus report", "any deletion shown in your portal") or decides or may do.
 * Each of these reads the words that govern the removal (right before it, or in its own clause). Those about what
 * someone else may do fail when the rest of the sentence makes the removal certain or the agency's (promiseAfter: "and
 * the bureaus always grant it", "and they agree in nearly all cases", "with our letters they choose to", "except our
 * clients", "and most clients see them gone within 60 days"), and every one but a disclaimer, a negation or the law
 * fails when a time frame for the removal follows it (timedAfter). Whether what is removed is the agency's own record
 * is dataPractice's.
 */
function removalExempt(text: string, at: number, end: number): boolean {
  const inSentence = sinceSentenceStart(text.slice(Math.max(0, at - 200), at));
  const word = text.slice(at, end);
  const rest = untilSentenceEnd(text.slice(end, end + 240));
  if (removalNegated(text, at) || disclaimed(text, at) || DISCLAIMED_AFTER.test(rest)) return true;
  if (promiseAfter(rest)) return false;
  if (NO_RIGHT.test(inSentence) || DECIDED_AFTER.test(rest)) return true;
  const timed = timedAfter(rest);
  const noun = /(?:al|als|ion|ions)$/i.test(word);
  if (noun && REMOVAL_REQUEST.test(rest.slice(0, 30))) return true;
  if (!timed && (REQUESTED.test(inSentence) || WISHED.test(inSentence))) return true;
  const { clause, after, sentence } = removalScope(text, at, end);
  if (OBLIGED.test(inSentence) && (UNVERIFIED.test(sentence) || OBSOLETE.test(sentence))) return true;
  if (lawOfReporting(inSentence, clause, sentence, word, after)) return true;
  if (timed) return false;
  if (noun && (NOUN_REPORTED.test(rest) || NOUN_AT_TIME.test(inSentence))) return true;
  if (possibleOutcome(inSentence, sentence) || outcomeInList(text, at, end, OUTCOME_LIST)) return true;
  // What the client is told happened is a participle ("which items were deleted"), not a noun ("…, which is deletion of
  // every collection").
  if ((!noun && reported(inSentence, word)) || explainedOnly(inSentence, rest)) return true;
  if (hypothetical(inSentence) && !AGENCY_SUBJECT.test(inSentence)) return true;
  return BUREAU_DECIDES.test(inSentence) || BUREAU_ACTS.test(inSentence) || BUREAU_DECISION.test(inSentence);
}

/**
 * For the removal rules of findBlockedClaims and CONTRACT_RULES (whose matches start before the verb, or run on to a time
 * frame): a condition, a question, what the client is told, what a bureau decides or a statement of the law is no
 * promise, read as in removalExempt (never with a time frame for the removal right after it, so "removal in a set time"
 * is never excused as a condition). Whether it is about the agency's own records is aboutCredit's.
 */
const contextExempt = (text: string, at: number, end: number) => {
  const inSentence = sinceSentenceStart(text.slice(Math.max(0, at - 200), at));
  const match = text.slice(at, end);
  const rest = untilSentenceEnd(text.slice(at, at + 240));
  // The time frame of the removal itself, right after its verb ("deleted, which happens within 30 days").
  const verb = REMOVE_STEM.exec(match);
  const afterVerb = verb ? rest.slice(verb.index + verb[0].length) : rest;
  const timed = timedAfter(afterVerb);
  const open = !promiseAfter(afterVerb) && !timed;
  if (open && hypothetical(inSentence) && !AGENCY_SUBJECT.test(inSentence) && !/^(?:we|i|our)\b/i.test(match)) return true;
  if (open && (reported(inSentence, verb?.[0] ?? match) || BUREAU_DECIDES.test(inSentence))) return true;
  const { clause, sentence } = removalScope(text, at, end);
  if (lawOfReporting(inSentence, clause, sentence) || (open && possibleOutcome(inSentence, sentence))) return true;
  return /\b(?:must|shall|required|obligated|obliged|law|statute)\b/i.test(`${inSentence}${match}`) && (UNVERIFIED.test(sentence) || OBSOLETE.test(sentence));
};

/** What "we remove …" must remove to be a promise: an item on a credit report (the same three kinds as REPORT_ITEM, QUALIFIED_ITEM, ON_REPORT). */
const CREDIT_OBJECT = String.raw`(?:(?:your|the|any|all|every|those|these|its|their|negative|bad|old|inaccurate|unverifiable|outdated|derogatory|such)\s+){0,3}(?:${QUALIFIED_ITEM}|${REPORT_ITEM}|(?:[\w'’-]+\s+){1,3}?${ON_REPORT})`;
const CONTRACT_RULES: ContractRule[] = [
  // In a contract the marketing check's two broadest rules are read more narrowly, so that ordinary terms pass ("we
  // delete your documents when you ask", "you get a letter each time…", "you may qualify for a refund"):
  // a first-person removal of something on a credit report, or "get … removed" about such a thing.
  { id: 'removal-promise', pattern: new RegExp(String.raw`\bwe(?:['’](?:ll|re|ve)\b)?\s+(?:(?:can|will|are|have|also|then|just|simply|quickly|\w+ly|and)\s+){0,3}${REMOVE_WE}\s+(?:${CREDIT_OBJECT}|(?:[\w'’-]+\s+){0,4}?(?:accounts?|bills?|loans?|repos|repossessions?|evictions?|(?:hard\s+)?pulls?)\b|[^.!?]{0,60}?\b(?:from|off)\s+(?:(?:your|the|all|each|every|both)\s+)?(?:(?:three|3)\s+)?(?:credit|bureaus?|equifax|experian|transunion|reports?)\b)|\b(?:get|gets|getting|got)\s+(?:[\w'’-]+\s+){0,4}?${GONE}\b`, 'gi'), why: 'Do not promise that an item will be removed.', exempt: 'disclaimer', credit: true },
  // "will be", "'ll be", "are" or "is approved for a loan", but not in a condition ("this agreement ends when you are
  // approved for a mortgage", "if your spouse is approved for a car loan") or by someone named ("clients are approved
  // for financing by their lenders, not by us"); lenders "saying yes" or "approving you", "eligible for prime auto
  // loans", "calificará para una hipoteca".
  { id: 'approval-promise', pattern: /\b(?:get|getting)\s+(?:you\s+)?approved\b|\bpre-?approved\b|\bqualify\s+for\s+(?:a\s+|an\s+|the\s+|your\s+)?(?:[\w-]+\s+){0,2}?(?:loans?|mortgages?|credit|cards?|cars?|auto|homes?|houses?|apartments?|leases?|financing|rates?)\b|\b(?:will\s+be|['’]ll\s+be|are|is|gets?)(?<!\b(?:when|once|until|unless|after|before|whether|if)\s{1,3}(?:[\w'’-]{1,30}\s{1,3}){1,3}(?:will\s+be|['’]ll\s+be|are|is|gets?))\s+approved\s+for\s+(?!(?:[\w-]+\s+){0,3}?by\s+(?:their|your|the|a|its)\s+(?:lenders?|banks?|creditors?)\b)(?:a\s+|an\s+|the\s+|your\s+|their\s+)?(?:[\w-]+\s+){0,2}?(?:loans?|mortgages?|credit|cards?|cars?|auto|homes?|houses?|apartments?|leases?|financing)\b|\b(?:will|['’]ll|going\s+to)\s+(?:start\s+|begin\s+)?approv(?:e|ing)\s+(?:you|your\s+applications?)\b|\b(?:start|starts|begin|begins)\s+approving\s+you\b|\bsay(?<!\bwhether\s{1,3}to\s{1,3}say)(?:s|ing)?\s+yes\s+to\s+(?:your|the)\s+(?:applications?|loans?|mortgages?|requests?)\b|\b(?:will|['’]ll)\s+(?:be|become)\s+eligible\s+for\s+(?:[\w-]+\s+){0,3}?(?:loans?|mortgages?|credit|cards?|financing|rates?)\b|(?<![a-záéíóúñ])(?:calificar[aá]n?|ser[aá]n?\s+aprobad[oa]s?)\s+para(?![a-záéíóúñ])/gi, why: 'Do not promise a loan or credit approval.', exempt: 'disclaimer' },
  // "5 to 10 items removed", "over 1,200 negative items deleted for our clients", "removed 300 accounts".
  { id: 'removal-count', pattern: new RegExp(String.raw`\b(?:${COUNT})(?<!\bhow\s{1,3}many)(?:\s*(?:\+|%|percent)|\s+(?:to|or|-|–)\s+${COUNT})?\s+(?:of\s+)?(?:[\w-]+\s+){0,3}?${ITEMS}\b[^.!?]{0,30}\b${GONE}\b|\b(?:removed|deleted|erased)\s+(?:over\s+|more\s+than\s+|about\s+|nearly\s+)?${COUNT}\s+(?:[\w-]+\s+){0,2}?${ITEMS}\b`, 'gi'), why: 'Do not state how many items are removed.', exempt: 'disclaimer' },
  // "items deleted within 30 days", "removed in as little as 45 days" (not "we delete your documents within 30 days").
  { id: 'removal-timed', pattern: new RegExp(String.raw`\b(?:remov|delet|eras|wip)\w*\b[^.!?]{0,40}\b(?:in|within|under)\s+(?:as (?:little|few) as\s+|just\s+|only\s+|less than\s+)?${NUM}\s+${PERIOD}\b`, 'gi'), why: 'Do not promise results within a time frame.', exempt: 'disclaimer', credit: true },
  // "we clean up your credit", "a clean credit report", "a clean slate".
  { id: 'clean-credit', pattern: /\bclean(?:s|ed|ing)?\s+(?:up\s+)?(?:your\s+|the\s+|a\s+)?(?:(?:transunion|experian|equifax|innovis|chexsystems|bureau|consumer)\s+)?(?:credit|reports?|file|history)\b|\bclean\s+slate\b|\bwip(?:e|es|ed|ing)\s+(?:your\s+|the\s+)?(?:credit|reports?|file|history|slate)\s+clean\b/gi, why: 'Do not promise a clean credit report.', exempt: 'disclaimer' },
  // Credit that is or will be clean, spotless or repaired, the agency fixing or restoring it, a default reversed (not in a
  // condition: "if your report is already error-free, we tell you so").
  { id: 'credit-result', pattern: /\b(?:credit|reports?|file|history|record)(?<!\b(?:if|whether|when|once|unless)\s{1,3}(?:[\w'’-]{1,30}\s{1,3}){0,3}(?:credit|reports?|file|history|record))\s+(?:is|are|will\s+be|['’]ll\s+be|becomes?|will\s+become|ends?\s+up|gets?)\s+(?:(?:fully|completely|totally|entirely|finally|all|now|truly|really|perfectly|100%)\s+)?(?:clean|spotless|perfect|flawless|pristine|error[\s-]free|repaired|fixed|restored|rebuilt)\b|\b(?:we|i|our\s+(?:team|firm|company|experts?|specialists?))\s+(?:(?:will|can|then|also|quickly)\s+)?(?:fix|fixes|repair|repairs|restore|restores|rebuild|rebuilds)\s+(?:your\s+|the\s+|a\s+)?(?:credit|reports?|history|scores?)\b|\b(?:default|delinquenc(?:y|ies)|charge-?offs?|bankruptc(?:y|ies)|repossessions?|judgments?)\s+(?:is\s+|are\s+)?(?:reversed|overturned|undone|vacated)\b/gi, why: 'Do not promise repaired, restored or clean credit.', exempt: 'disclaimer' },
  // "a 98% success rate", "an approval rate of over 90%".
  { id: 'success-rate', pattern: /\b\d{1,3}(?:\.\d+)?\s*(?:%|percent)\s+(?:success|approval|removal|deletion|win)\s+rates?\b|\b(?:success|approval|removal|deletion|win)\s+rates?\s+(?:of\s+)?(?:over\s+|above\s+|more\s+than\s+|nearly\s+)?\d{1,3}(?:\.\d+)?\s*(?:%|percent)/gi, why: 'Do not state a success rate.', exempt: 'negation' },
  // Disputing accurate information as if it were wrong: "we challenge accurate negative items", "including accurate late payments".
  { id: 'dispute-accurate', pattern: new RegExp(String.raw`\b(?:disput|challeng|contest)\w*\b[^.!?]{0,60}\b(?:(?:accurate|valid|legitimate|verified)\s+(?:negative\s+|late\s+)?(?:${ITEMS}|information|debts?|records?)|(?:even\s+(?:if|when|though)\s+(?:they|it|the\s+\w+)\s+(?:are|is)|(?:that|which)\s+(?:are|is))\s+(?:accurate|valid|legitimate|verified)\b)`, 'gi'), why: 'Do not offer to dispute information that is accurate.', exempt: 'negation' },
];

/** A claim disclaimed after it in its own clause: "a higher score is not guaranteed" (DISCLAIMED_AFTER). */
const disclaimedAfter = (text: string, end: number) => DISCLAIMED_AFTER.test(untilSentenceEnd(text.slice(end, end + 240)));
/** A score that may go either way: "your score may go up, go down or stay the same". */
const eitherWay = (match: string, after: string) => /\b(?:may|might|can|could)\b/i.test(match) && /^\s*,?\s*(?:go(?:es)?\s+down|(?:or|and)\s+(?:go(?:es)?\s+)?(?:down|fall|drop|decrease|stay|remain))\b/i.test(after);
/**
 * The first match of a rule that is a claim: not negated (or disclaimed, before or after it) where the rule allows
 * that, and, for a removal rule (`credit`), about something on a credit report and not a condition, a question or a
 * statement of the law.
 */
function firstClaim(text: string, pattern: RegExp, exempt: Exempt, credit = false): RegExpMatchArray | null {
  const re = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
  for (const m of text.matchAll(re)) {
    if (exempt === 'negation' && negatedList(text, m.index!)) continue;
    if (exempt === 'disclaimer' && (negated(text, m.index!) || disclaimed(text, m.index!) || disclaimedAfter(text, m.index! + m[0].length) || eitherWay(m[0], text.slice(m.index! + m[0].length, m.index! + m[0].length + 60)))) continue;
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
 * from; disappear, vanish, go away, be gone or history, no longer appear or report, say goodbye to; pulled, struck or
 * taken down from a report; suppress.
 */
const REMOVAL_IF_CREDIT = /\b(?:elimin(?:ate|ates|ated|ating|ation)|(?:tak(?:e|es|en|ing)|took|knock(?:s|ed|ing)?|get(?:s|ting)?|got)\s+(?:[\w'’$-]+\s+){0,4}?off|(?:come|comes|coming|came|fall|falls|falling|fell|drop|drops|dropping|dropped|roll|rolls|rolling|rolled)\s+off|clear(?:s|ed|ing)(?=(?:\s+[\w'’-]+){0,4}?\s+(?:of|from|off)\b)|(?<!\b(?:is|are|was|were|be|been|it|very|more|most|so|as|a|an|the|make|makes|made|keep|keeps|stay|stays|in|crystal|perfectly)\s+)clear(?=(?:\s+[\w'’-]+){0,4}?\s+(?:of|from|off)\b)|disappear\w*|vanish\w*|go(?:es|ing)?\s+away|(?:be|is|are|was|were|been|get|gets)\s+gone|(?:will\s+be|['’]ll\s+be|are|is|become|becomes)\s+history|no\s+longer\s+(?:appear\w*|show\w*|be\s+(?:reported|listed|shown)|report(?:s|ing)?)|say\s+goodbye\s+to|(?:pulled|struck|taken\s+down|knocked\s+down)\s+(?:off|from)\s+(?:(?:your|the|their|all|each|every|both)\s+)?(?:(?:three|3|credit|equifax|experian|transunion)\s+){0,2}(?:reports?|files?|histor(?:y|ies)|records?)|suppress(?:es|ed|ing)?)\b/gi;
/** "$10 off your first month", "20% off the fee": a discount, not a removal. */
const DISCOUNT = /^\s*(?:your|the|each|every|a|our)\s+(?:first\s+|next\s+|monthly\s+|total\s+)?(?:bill|invoice|fee|price|payment|total|month|cost|charge|plan)s?\b/i;
/** The Spanish removal words of the marketing check (eliminamos, vamos a eliminar, serán eliminadas, sacamos, …). */
const REMOVAL_ES = /(?<![\p{L}])(?:eliminaremos|borraremos|quitaremos|removeremos|sacaremos|eliminamos|borramos|quitamos|removemos|sacamos|(?:vamos\s+a|podemos|logramos|lograremos)\s+(?:eliminar|borrar|quitar|remover|sacar)|(?:ser[aá]n?|son|es|fue|fueron|han\s+sido|ha\s+sido|quedar[aá]n?)\s+(?:eliminad|borrad|quitad|removid|sacad)[oa]s?|se\s+(?:elimin|borr|quit|sac)(?:a|an|ar[aá]n?))(?![\p{L}])/giu;
const ES_NEGATED = /(?<![\p{L}])(?:no|nunca|jam[aá]s|nadie\s+puede|ninguna\s+empresa\s+puede)(?:\s+(?:le|les|se|lo|la|los|las|podemos|puede|pueden|vamos\s+a|va\s+a))*\s+$|(?<![\p{L}])(?:no|nunca)\s+(?:hace|hacen|har[aá]|significa|quiere\s+decir)\s+que\s+(?:(?:se|le|lo|la|los|las)\s+)?$/iu;
/**
 * The other Spanish removal words (elimina, eliminar, eliminación, remueve, borra, desaparecerán, limpiar, "salgan de su
 * reporte", "quedará sin cuentas negativas"): a promise only where the clause names a credit file (ES_CREDIT), like
 * REMOVAL_IF_CREDIT.
 */
const REMOVAL_ES_IF_CREDIT = /(?<![\p{L}])(?:elimin(?:a|an|ar|ar[aá]n?|e|en|ando|aci[oó]n|aciones)|borr(?:a|an|ar|ar[aá]n?|e|en|ando)|quit(?:a|an|ar|ar[aá]n?|e|en|ando)|remov(?:er|er[aá]n?|iendo)|remuev(?:e|en|a|an)|remoci[oó]n|desaparec\p{L}*|desaparez\p{L}*|limpi(?:a|an|ar|amos|aremos|ar[aá]n?)|salg(?:a|an)\s+de\s+(?:su|tu|sus|el|los)\s+(?:reportes?|historial|informes?|expediente)|quedar(?:[aá]|[aá]n)\s+(?:limpi[oa]s?|sin\s+(?:cuentas|deudas|cobros|marcas|atrasos)))(?![\p{L}])/giu;
/**
 * A Spanish disclaimer: "no podemos prometer que…", "no garantizamos que ninguna cuenta…", "nadie puede garantizar…",
 * "ninguna parte de este contrato garantiza…". Not "no prometemos nada más que eliminar…" ("nothing but").
 */
const ES_DISCLAIMER = /(?<![\p{L}])(?:no|nunca|jam[aá]s|nadie\s+puede|ninguna\s+empresa\s+puede|ninguna\s+(?:parte|cl[aá]usula|secci[oó]n)\s+de\s+(?:este|el|esta|la)\s+(?:contrato|acuerdo)|nada\s+(?:en|de)\s+(?:este|el)\s+(?:contrato|acuerdo))(?:\s+(?:le|les|te|se|lo|la|podemos|puede|pueden|vamos\s+a|va\s+a))*\s+(?:promet\p{L}*|garantiz\p{L}*|asegur\p{L}*|predec\p{L}*)(?:\s+(?:le|les|te))?(?:\s+que)?(?:\s+(?!(?:m[aá]s|sino|salvo|excepto|aparte|menos)(?![\p{L}]))\p{L}+){0,5}\s+$/iu;
/**
 * A Spanish request: "solicitamos a los burós que corrijan o eliminen…", "le ayudamos a solicitar que el buró corrija o
 * elimine…", "pedimos al buró la eliminación de…", "cartas de eliminación". "Pedimos la eliminación" is the agency's
 * request; "solicite hoy su eliminación" is a pitch to the client, not one.
 */
const ES_REQUESTED = /(?<![\p{L}])(?:solicit|ped|pid|exig|requer|reclam)\p{L}*(?![\p{L}])[^.!?;]{0,100}?(?<![\p{L}])que\s+(?:(?!(?:nosotros|nuestr\p{L}*)(?![\p{L}]))\p{L}+\s+){0,3}?(?:\p{L}+\s+(?:o|y|u)\s+)?$|(?<![\p{L}])(?:solicit|ped|pid|exig|requer|reclam)\p{L}*mos(?![\p{L}])[^.!?;]{0,60}?(?<![\p{L}])(?:la|su|una)\s+$|(?<![\p{L}])(?:solicitud(?:es)?|petici[oó]n(?:es)?|cartas?)\s+de\s+$/iu;
/** A Spanish statement of the law: "deben corregir o eliminar la información que no se puede verificar". */
const ES_OBLIGED = /(?<![\p{L}])(?:debe|deben|tiene\s+que|tienen\s+que|est[aá]n?\s+obligad[oa]s?\s+a|(?:la\s+)?ley\s+(?:exige|obliga|requiere)\s+(?:\p{L}+\s+){0,4}?(?:a|que))\s+(?:\p{L}+\s+(?:o|y|u)\s+)?$/iu;
const ES_UNVERIFIED = /(?<![\p{L}\p{N}])(?:no\s+(?:se\s+)?pued[ea]n?\s+(?:ser\s+)?verific|no\s+verificad|no\s+(?:responde|responden|respondi[oó]|contesta|contestan)|robo\s+de\s+identidad|(?:siete|7|diez|10)\s+años)/iu;
/**
 * A Spanish condition: "si el buró elimina un dato…", "cuando un buró borra…" (no comma between). Not the client's own
 * signing or payment ("si usted firma hoy sus cobranzas son eliminadas…"), and not one with a time frame for the
 * removal ("…en 30 días").
 */
const ES_IF = /(?<![\p{L}])(?:si|cuando)(?![\p{L}])[^,;:]*$/iu;
const ES_OWN_CONDITION = /(?<![\p{L}])(?:firm|contrat|inscrib|pag|compr|nos\s+contrat|nuestr)\p{L}*/iu;
const ES_TIMED = new RegExp(String.raw`(?<![\p{L}])(?:en|dentro\s+de|antes\s+de)\s+(?:solo\s+|s[oó]lo\s+|menos\s+de\s+)?${NUM}\s+${PERIOD}(?![\p{L}])|(?<![\p{L}])(?:el|la)\s+pr[oó]xim[oa]\s+(?:mes|semana)(?![\p{L}])`, 'iu');
/**
 * What only a bureau or creditor may do: "solo el buró o el acreedor pueden eliminar…", "los burós pueden verificar,
 * actualizar o eliminar…", "las agencias de crédito pueden…" (not "nuestra agencia puede eliminar…": the agency itself).
 */
const ES_BUREAU_ACTS = /(?<![\p{L}])(?:bur[oó]s?|acreedor(?:es)?|agencias?\s+de\s+(?:cr[eé]dito|informes?(?:\s+de\s+cr[eé]dito)?))\s+(?:pueden|puede|podr[ií]an?|podr[aá]n?|deciden?\s+si)\s+(?:(?:\p{L}+,\s+)*\p{L}+\s+(?:o|u|y)\s+)?$/iu;
/** What the client is told happened: "cada carta del buró que diga que una cuenta fue eliminada", "le diremos qué cuentas fueron eliminadas". */
const ES_REPORTED = /(?<![\p{L}])(?:diga|digan|dice|dicen|indique|indica|confirme|confirma|muestre|muestra|avisa|informa|diremos|decimos|avisamos|informamos|indicamos|mostramos|confirmamos|ver[aá]|sabr[aá])\s+(?:si|que|qu[eé]|cu[aá]ndo|cu[aá]les)\s+(?:(?!(?:nosotros|nuestr\p{L}*)(?![\p{L}]))\p{L}+\s+){0,4}?$/iu;
/**
 * "Siempre", "cada vez" after a removal someone else may do makes it a promise again, as CERTAIN_AFTER in English, and
 * so does the agency's part in it ("…, y con nuestras cartas lo hacen", "normalmente son todas").
 */
const ES_CERTAIN_AFTER = /(?<![\p{L}])(?:siempre|cada\s+vez|sin\s+falta|lo\s+hacen|lo\s+hace|con\s+nuestr[oa]s?\s+(?:cartas?|ayuda|m[eé]todos?|servicios?|programas?|equipos?|disputas?|trabajo)|gracias\s+a\s+(?:nosotros|nuestr\p{L}*)|son\s+todas|son\s+todos|casi\s+todas)(?![\p{L}])/iu;
/**
 * Whether a Spanish removal word at text[at, end) is negated, disclaimed, requested, a statement of the law, a
 * condition, what the client is told happened, what a bureau or creditor may do, or one of a list of outcomes. A
 * condition does not cover the agency's own verb ("si nos contrata hoy borramos…", "cuando firma eliminamos…": the
 * removal is the main clause), the client's signing or payment ("si usted firma hoy sus cobranzas son eliminadas…") or
 * a time frame for the removal ("…en 30 días").
 */
function esExempt(text: string, at: number, end: number): boolean {
  const inSentence = sinceSentenceStart(text.slice(Math.max(0, at - 160), at));
  const rest = untilSentenceEnd(text.slice(end, end + 200));
  const sentence = `${inSentence}${text.slice(at, end)}${rest}`;
  const word = text.slice(at, end);
  if (ES_NEGATED.test(inSentence.slice(-40)) || ES_DISCLAIMER.test(inSentence)) return true;
  if (ES_CERTAIN_AFTER.test(rest)) return false;
  const agency = /mos(?![\p{L}])/iu.test(word) || /^(?:vamos|podemos|logramos|lograremos)(?![\p{L}])/iu.test(word);
  const condition = ES_IF.exec(inSentence);
  if (ES_REQUESTED.test(inSentence) || (condition && !agency && !ES_OWN_CONDITION.test(condition[0]) && !ES_TIMED.test(rest))) return true;
  if (ES_REPORTED.test(inSentence) && !agency && /^(?:fue|fueron|ha\s+sido|han\s+sido)(?![\p{L}])|(?:ad|id)[oa]s?$/iu.test(word) && !ES_TIMED.test(rest)) return true;
  if (ES_BUREAU_ACTS.test(inSentence) || outcomeInList(text, at, end, OUTCOME_LIST_ES)) return true;
  return ES_OBLIGED.test(inSentence) && ES_UNVERIFIED.test(sentence);
}
/**
 * The agency's own records in Spanish: documents, files, the client's data, photos, copies, messages, notes, call
 * recordings, phone number, email, signature, password, ID, card, the agency's call or mailing lists and newsletter,
 * the portal account. Not "esos datos" on its own (the data of a sentence before may be a credit file's).
 */
const ES_OWN = /(?<![\p{L}])(?:documentos?|archivos?|(?:sus|tus|mis)\s+datos|datos\s+(?:personales|de\s+contacto|de\s+pago|bancarios)|informaci[oó]n\s+personal|fotos?|copias?|mensajes?|notas?|grabaci[oó]n(?:es)?|n[uú]meros?\s+de\s+tel[eé]fono|tel[eé]fonos?|correos?(?:\s+electr[oó]nicos?)?|firmas?|contrase[nñ]as?|identificaci[oó]n|tarjeta|listas?\s+de\s+(?:llamadas|correo|contactos|env[ií]os|mercadeo)|bolet[ií]n(?:es)?|cuenta\s+(?:del\s+portal|de\s+usuario|con\s+nosotros))(?![\p{L}])/iu;
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
    const end = at + verb.length;
    // A Spanish verb ("sea eliminada") is read as the Spanish loops read it; an English one as REMOVAL_WORD is read below.
    const spanish = /^(?:borr|quit|limpi)|^elimin(?!at)/i.test(verb);
    if (spanish ? esExempt(text, at, end) || removalExempt(text, at, end) : removalExempt(text, at, end) || (/^(?:remov|delet|eras|wip)/i.test(verb) && dataPractice(text, at, end))) continue;
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
    if (esExempt(text, m.index, end) || (ES_OWN.test(clause) && !ES_CREDIT.test(clause))) continue;
    // "Sacamos una copia de sus reportes": pulling a copy, not taking anything off.
    if (/^sac/i.test(m[0]) && /^\s+(?:(?:una?|las?|los|sus?)\s+)?(?:copias?|reportes?|informes?|puntajes?)(?![\p{L}])/iu.test(after)) continue;
    return issue(removalExcerpt(text, m.index, end));
  }
  for (const m of text.matchAll(REMOVAL_ES_IF_CREDIT)) {
    const end = m.index + m[0].length;
    const { clause } = removalScope(text, m.index, end);
    if (!ES_CREDIT.test(clause) || esExempt(text, m.index, end)) continue;
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
 * time, a "clean", repaired or restored credit report, a success rate and offers to dispute accurate information. A
 * promise is refused; an honest negation ("we do not sell tradelines"), disclaimer ("we cannot guarantee that any item
 * will be deleted", "a higher score is not guaranteed") or request ("we ask the bureaus to correct or delete
 * information that cannot be verified") is not. Every removal word (remove, delete, erase, wipe, purge, the nouns
 * removal and deletion, in any tense, voice or person, and eliminate, take or knock off, clear, disappear and "be
 * history" where the clause names a credit file) counts unless it is about the agency's own records (dataPractice), so
 * the agency can say how it deletes them ("we delete your account and your documents within 30 days of your request",
 * "emails are kept for two years and then deleted"). Requests and disclaimers ("we dispute the items you select for
 * correction or deletion", "nothing in this agreement promises…", "removal of any item is not guaranteed"), the right
 * no one has (15 U.S.C. § 1679c(a), word for word), possible outcomes ("a dispute can end with the item verified,
 * updated or deleted", "we tell you whether each account was corrected, deleted or left unchanged"), what the client is
 * told a bureau did ("every deletion the bureaus report to us"), a condition ("we do not charge extra when an item is
 * deleted"), the items the client wants removed, statements of the reporting law (the seven-year period, a bureau that
 * puts a deleted item back, a furnisher that does not respond) and a security freeze or opt-out the client asks for
 * pass too; the Spanish removal words are read the same way. Each exemption reads the words that govern the removal
 * (removalExempt): those before it in its sentence, and the rest of the sentence after it, which can make the removal
 * certain or the agency's again ("…, and the bureaus always grant it", "…, except our clients", "with our letters they
 * choose to", "…, consider them gone") or give it a time frame ("…, usually within the first month"). A promise made
 * in another clause with no removal word in it is not read ("bureaus must delete what they cannot verify, and our
 * letters are written so they cannot verify your collections"). Like the rest of this file it is a list of rules: it catches the
 * common wordings of a promise, it does not make a contract lawful.
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
  read(CONTRACT_RULES.filter((r) => r.id !== 'removal-count'), (id) => CONTRACT_RULES.find((r) => r.id === id)!.exempt, (id) => !!CONTRACT_RULES.find((r) => r.id === id)!.credit);
  return issues;
}

// ---------------------------------------------------------------- payment asked for before the work (§ 1679b(b))

/**
 * A word of paying or of a payment, in English or Spanish: a deposit, a retainer, dues, an installment, a debit, a draft,
 * money that "comes out of" an account, a card that is "run", months that are "taken" or "settled", a balance that is
 * "cleared", "your money", "se descuenta" ("due to" is not one).
 */
const PAYMENT_WORD = /\b(?:pay\w*|paid|charg\w*|fees?|due(?!\s+to\b)|dues|bill\w*|collect(?:s|ed|ing)?|invoic\w*|costs?|prices?|deposits?|retainers?|installments?|debit(?:s|ed|ing)?|draft(?:s|ed|ing)?|settl(?:e|es|ed|ing)|withdr[ae]w\w*|deduct\w*|(?:comes?|came|taken)\s+out\s+of|run(?:s|ning)?\s+(?:your|the|a)\s+(?:credit\s+|debit\s+)?card|(?:take|takes|taking|took)\s+(?:care\s+of\s+)?(?:the|your)\s+(?:first|full|whole|entire)|(?:program|account|full|remaining|outstanding)\s+balance|balances?\s+(?:is\s+|are\s+)?(?:cleared|settled|paid|due)|(?:your|the|any|all)\s+money)\b|(?<![\p{L}])(?:pag(?:o|os|a|as|an|ar|ará|arán|ue|uen|ado|ada)|cobr(?:o|a|an|amos|ar|ará|arán|ado|ada|e|en)|cuotas?|tarifas?|honorarios|cargos?|factur\p{L}*|dep[oó]sitos?|descuent(?:a|an)|descont(?:amos|ar\p{L}*|ad[oa]s?))(?![\p{L}])/iu;
/** An amount of money other than $0. */
const AMOUNT = /\$\s?(?!0+(?:\.0+)?\b)\d/;
const PAY_TERM = String.raw`(?:pay(?:s|ing|ment|ments|able)?|paid|charg(?:e|es|ed|ing)|fees?|due|bill(?:s|ed|ing)?|collect(?:s|ed|ing)?|invoic\w*|costs?|prices?|deposits?|retainers?|money|owe[ds]?|owing|draft(?:s|ed|ing)?|debit(?:s|ed|ing)?)`;
const LIGHT = String.raw`(?:is|are|was|were|be|been|being|ever|a|an|any|the|other|extra|additional|hidden|further|separate|set-?up|upfront|up-front|advance|enrol(?:l)?ment|sign-?up|monthly|first|initial|one-time|you|we|us|have|has|had|to|need|needs|required|asked|ask|for|or|accept|take|make|request|require|do|does|did|will|would|shall|can|may|must|yet|your|card|such|of|at|in|on)`;
/**
 * A payment that is named only to say there is none: "no payment is due", "no fee or deposit is due", "nothing (at all)
 * is charged", "no payment of any kind is due", "no fee may be charged", "you will not be charged", "we do not ask for
 * or accept any payment", "you pay nothing", "costs nothing", "free of charge", "$0"; and the same with the negation
 * after the payment: "payment is not required", "fees are never collected", "a deposit is never required". A cap is not
 * one ("never more than $99", "we never charge over $99", "we never collect more than one month in advance"), and
 * neither is a payment that is only put off to a time ("payment is not due until the day you sign").
 */
const NO_KIND = String.raw`(?:\s+(?:of\s+any\s+(?:kind|sort)|whatsoever|at\s+all))?`;
const PAID_STATE = String.raw`(?:due|charged|owed|payable|collected|billed|required|taken|made|paid|accepted|requested|asked\s+for)`;
// Not a cap ("more than…") and not "until", "unless" or "except" after it.
const CAP = String.raw`(?:more\s+than|over\s+(?:\$|\d|one|a|an|two|three|the\s+first)|above\s+(?:\$|\d)|beyond\s+(?:\$|\d|one|the\s+first)|in\s+excess\s+of|upwards\s+of|anything\s+more)`;
const NOT_CAP = String.raw`(?!\s+(?:(?:you|us)\s+)?${CAP})`;
const NOT_UNTIL = String.raw`(?!\s+(?:until|till|unless|except)\b)`;
const NEGATED_PAYMENT = new RegExp([
  String.raw`(?:\b(?:no|not|never|nothing|none|without|neither|nor|zero)|n['’]t)${NO_KIND}\s+(?:${LIGHT}\s+){0,5}?${PAY_TERM}\b${NOT_CAP}(?:\s+(?:or|nor)\s+(?:${LIGHT}\s+){0,2}?${PAY_TERM}\b)*${NO_KIND}(?:\s+(?:(?:is|are|will|shall|can|may|must|would|could|gets?)\s+)?(?:be\s+)?(?:ever\s+)?${PAID_STATE})?${NOT_UNTIL}`,
  String.raw`\b${PAY_TERM}\b${NO_KIND}\s+(?:is|are|will|shall|can|may|must|would|could)\s+(?:not|never)\s+(?:be\s+)?(?:ever\s+)?${PAID_STATE}\b${NOT_UNTIL}`,
  String.raw`\b(?:pay|pays|owe|owes|cost|costs|charge|charges|bill|bills)\s+(?:you\s+)?(?:nothing|zero|\$\s?0+(?:\.0+)?)\b|\bfree\s+of\s+charge\b|\bno[\s-]cost\b|\$\s?0+(?:\.0+)?\b`,
].join('|'), 'gi');
/**
 * The same in Spanish: "no cobramos nada", "nunca cobramos", "no se cobra nada", "no hay pagos", "ningún pago", "sin
 * cargos", "nada se cobra", and a list that goes on with "ni": "no hay depósito, cuota de inscripción ni pago…", "ningún
 * depósito ni cuota".
 */
const NEGATED_PAYMENT_ES = /(?<![\p{L}])(?:(?:no|nunca|jam[aá]s)(?:\s+(?:se|le|les|te|lo|la|hay|habr[aá]|existen?))*(?:\s+(?:cobr|pag|exig|requ|ped|pid|solicit|factur|carg)\p{L}*)?(?:\s+(?:nada|ning[uú]n|ninguna|ningunos|ningunas|otros?|otras?))?(?:\s+(?:pagos?|cargos?|cobros?|cuotas?|tarifas?|honorarios|dep[oó]sitos?|anticipos?|costos?))?|(?:ning[uú]n|ninguna)\s+(?:pago|cargo|cobro|cuota|tarifa|dep[oó]sito|anticipo|costo)|sin(?:\s+(?:ning[uú]n|ninguna|otros?|otras?))?\s+(?:pagos?|cargos?|cobros?|costos?|cuotas?|dep[oó]sitos?|anticipos?)|ni\s+(?:(?:ning[uú]n|ninguna|otros?|otras?|un|una)\s+)?(?:pagos?|cargos?|cobros?|cuotas?|tarifas?|honorarios|dep[oó]sitos?|anticipos?|costos?)|nada\s+(?:se\s+)?(?:cobra|paga|debe))(?![\p{L}])/giu;
/**
 * A payment that is stopped, not asked for: "we stop billing you right away", "billing stops immediately", "we will
 * stop all charges at once if you cancel". "Front-end payments" are not ended ones.
 */
const STOPPED_PAYMENT = /(?<![\w-])(?:stop|stops|stopped|stopping|end|ends|ended|ending|cease[sd]?|ceasing|halt\w*|discontinu\w*|suspend\w*|pause[sd]?|pausing|cancel\w*)\s+(?:(?:all|any|the|your|our|further|future|recurring|monthly|automatic|scheduled)\s+){0,3}(?:charg\w*|bill\w*|collect\w*|draft\w*|debit\w*|payments?|withdrawals?)\b|\b(?:charg\w*|bill\w*|collections?|drafts?|debits?|payments?)\s+(?:(?:will|shall|would|is|are|also)\s+)?(?:stop|stops|stopped|end|ends|ended|cease[sd]?|halt\w*|(?:be\s+)?(?:cancel(?:l)?ed|discontinued|suspended|paused|stopped))\b/gi;
/**
 * Fees only explained, disclosed or confirmed: "we explain our fees before we start work", "before you sign, we tell
 * you the total cost", "we disclose all fees in writing before you sign", "we confirm your monthly price with you",
 * "antes de firmar, le explicamos todos los cargos".
 */
const EXPLAINED_FEES = /\b(?:explain|describe|discuss|review|go\s+over|list|show\s+you|tell\s+you(?:\s+about)?|disclos|confirm|notif|announc|quot|itemiz|outline|spell\s+out)\w*\s+(?:[\w'’-]+\s+){0,4}?(?:fees?|charges?|costs?|prices?|pricing|payments?|billing)\b|(?<![\p{L}])(?:explic|inform|detall|muestr|mostr|revis|confirm)\p{L}*\s+(?:\p{L}+\s+){0,3}?(?:cargos?|cuotas?|tarifas?|pagos?|costos?|precios?|honorarios)(?![\p{L}])/giu;
/**
 * Words about payment that ask for none: a payment schedule or plan handed over, a payment method or billing details
 * collected or verified, a price that is locked in ("at the start of your program, we give you a payment schedule",
 * "your payment method is verified when you enroll", "we collect your billing details when you sign", "your monthly
 * price is locked in when you enroll", "le entregamos un calendario de pagos").
 */
const NOT_A_PAYMENT = /\b(?:(?:collect|take|get|ask\s+for|request|verify|confirm|save|store|keep|add|enter|set\s+up|update)\w*\s+(?:your\s+|the\s+|a\s+)?)?(?:billing|payment|card|bank)\s+(?:details|information|info|method|methods|address|schedule|plan|calendar|options?)\b(?:\s+(?:is|are|will\s+be|gets?)\s+(?:collected|verified|saved|stored|taken|confirmed|added|entered|requested|kept|updated)\b)?|\bschedule\s+of\s+(?:payments?|fees|charges)\b|\b(?:price|rate|fee)s?\s+(?:is|are)\s+(?:locked(?:\s+in)?|fixed|set)\b|(?<![\p{L}])(?:calendario|plan|programa)\s+de\s+pagos?(?![\p{L}])/giu;
/**
 * A refund owed to the client, which is no payment by them: "any refund owed to you is due immediately", "refunds are
 * paid within 10 days", "we refund it", "we will refund any payment taken before…", "a full refund of any payment". A
 * payment of theirs that is refunded only if they cancel stays a payment ("the $299 payment due in advance is refunded if
 * you cancel", "$500 at signing subject to a refund", "any refund or fee is due at signing").
 */
const REFUND_OWED = /\b(?:(?:any|a|the|your|each|all|full)\s+)?refunds?\b(?:\s+(?:owed|due)\s+to\s+(?:you|the\s+client))?(?:\s+(?!(?:fees?|payments?|charges?|prices?|costs?|deposits?|or|and)\b)[\w'’-]+){0,3}?\s+(?:is|are|will\s+be|shall\s+be|gets?)\s+(?:\w+\s+)?(?:due|payable|paid|issued|sent|made|returned|credited)\b|\brefund(?:s|ed|ing)?\s+(?:it|them|that|this|anything|everything|(?:the|any|all|your|each|every)\s+(?:[\w'’-]+\s+){0,2}?(?:payments?|fees?|charges?|amounts?|money|deposits?))(?:\s+(?:charged|taken|collected|paid|billed|received))?\b|\brefunds?\s+of\s+(?:any|all|the|your)\s+(?:[\w'’-]+\s+){0,2}?(?:payments?|fees?|charges?|amounts?|money)\b/gi;
/** The work a payment is for, named by it in a relative clause: "before the work it pays for is done" (not "it pays for the coming month"). */
const PAYS_FOR = /\b(?:it|they|each\s+(?:payment|fee))\s+pays?\s+for(?=\s+(?:is|are|was|were|has|have|will|gets?)\b)/gi;
/**
 * Whether a clause asks for a payment: a payment word or an amount, once the payments named as none, stopped or only
 * explained, the words about payment that ask for none, and a refund owed to the client, are taken out.
 */
function asksPayment(clause: string): boolean {
  const rest = clause.replace(NEGATED_PAYMENT, ' ').replace(NEGATED_PAYMENT_ES, ' ').replace(STOPPED_PAYMENT, ' ').replace(EXPLAINED_FEES, ' ').replace(NOT_A_PAYMENT, ' ').replace(REFUND_OWED, ' ').replace(PAYS_FOR, ' ');
  return PAYMENT_WORD.test(rest) || AMOUNT.test(rest);
}

const ADVANCE_PAYMENT = /\b(?:deposits?|retainers?|down[\s-]?payments?|pre-?pa(?:id|y|ys|ying|yment|yments)|(?:set[\s-]?up|start[\s-]?up|enrol(?:l)?ment|sign(?:ing)?[\s-]?up|activation|initiation|onboarding|registration|joining)\s+(?:fees?|charges?|costs?|payments?)|dep[oó]sitos?|anticipos?|cuotas?\s+(?:de\s+)?(?:inscripci[oó]n|apertura|activaci[oó]n|afiliaci[oó]n|ingreso))(?![\p{L}])/giu;
/**
 * A negation of a fee right before it, at most six words back and through a list ("no setup fee", "no deposit or
 * retainer", "we do not charge a setup, enrollment or activation fee", "no se requiere ningún depósito"), but not a cap,
 * a list that goes on or a new clause ("never more than a $50 deposit", "no interest and a $50 deposit", "no refunds,
 * we take a deposit"). A comma counts only inside a list of fees: "no long-term contract, a refundable deposit…" and
 * "sin contratos largos, un depósito…" negate the contract, not the deposit.
 */
const FEE_LIST_WORD = /^(?:fees?|deposits?|retainers?|charges?|payments?|costs?|set-?up|enrol(?:l)?ment|activation|sign(?:ing)?[\s-]?up|registration|onboarding|cancellation|initiation|joining|start-?up|cargos?|cuotas?|dep[oó]sitos?|pagos?|inscripci[oó]n|apertura|activaci[oó]n|afiliaci[oó]n)\s*,$/iu;
const FEE_NEGATION = /(?:\b(?:no|not|never|nor|without|cannot|nothing|none|zero|neither|sin|nunca|ning[uú]n|ninguna)|\bjam[aá]s|n['’]t)(?=\s)/gi;
function feeNegated(before: string): boolean {
  for (const m of before.matchAll(FEE_NEGATION)) {
    const rest = before.slice(m.index + m[0].length);
    if (/[.!?;:]/.test(rest) || rest.trim().split(/\s+/).filter(Boolean).length > 6) continue;
    if (/\$|\b(?:and|but|more|over|than|above|beyond|exceed\w*|except|other|besides|only|just|y|pero|m[aá]s|s[oó]lo|salvo|excepto|menos)\b|,\s*(?:we|you|they|it|i|our|their|the\s+client)\b/iu.test(rest)) continue;
    if (rest.split(',').slice(0, -1).some((part) => !FEE_LIST_WORD.test(`${part.trim().split(/\s+/).pop() ?? ''},`))) continue;
    return true;
  }
  return false;
}
/** A fee denied right after it: "a deposit is never required", "a retainer is not charged" (not "…is not required until the day you sign"). */
const FEE_DENIED_AFTER = /^\s+(?:is|are|will\s+be|shall\s+be)\s+(?:not|never)\s+(?:be\s+)?(?:required|charged|collected|taken|due|needed|asked\s+for|requested|accepted)\b(?!\s+(?:until|till|unless|except)\b)/i;
/**
 * The client signing: "you sign", "they sign", "clients sign", "you e-sign", "signing this agreement", "the agreement is
 * signed", "your signature", "enrollment", "you're enrolled" (never "sign in" to the portal).
 */
const SIGNER = String.raw`(?:you|they|clients?|customers?|the\s+(?:client|consumer|customer|buyer))`;
// One signer, then what they do: sign or e-sign, enroll, "have signed", "'re enrolled" (never "sign in").
const SIGNING = String.raw`(?:${SIGNER}(?:\s+(?:e-?)?sign(?:s|ed)?|\s+enrol(?:l)?(?:s|ed)?|(?:['’]ve|\s+have|\s+has)\s+(?:e-?)?signed|['’]re\s+(?:enrol(?:l)?ed|signed\s+up|registered))(?!\s+in(?:to)?\b)|(?:e-?)?signing(?!\s+in(?:to)?\b)|(?:this|the)\s+(?:agreement|contract)\s+is\s+(?:e-?)?signed|(?:your|the\s+client['’]s|their)\s+(?:e-?)?signature|enrol(?:l)?(?:ment|ing))`;
/** The day the agreement takes effect: "the effective date", "your start date", "the date of this agreement", "execution of this agreement". */
const EFFECTIVE = String.raw`(?:(?:(?:the|your|this)\s+)?(?:effective|start(?:ing)?|commencement|enrol(?:l)?ment|sign(?:ing|-?up))\s+date|the\s+date\s+of\s+(?:this|the)\s+(?:agreement|contract)|(?:the\s+)?execution\s+of\s+(?:this|the)\s+(?:agreement|contract))`;
const PAYMENT_NOUN = String.raw`(?:payment|\$\s?\d[\d,.]*|fees?|deposits?|retainers?)`;
const ADVANCE_TIME = new RegExp(String.raw`\b(?:` + [
  String.raw`in\s+advance|up[\s-]?front|today`,
  String.raw`(?:immediately|right|just|directly)\s+after\s+(?:you\s+|the\s+client\s+|they\s+)?(?:e-?)?sign\w*`,
  String.raw`(?:when|once|as\s+soon\s+as|upon|on|at|before|prior\s+to|by\s+the\s+time)\s+(?:${SIGNER}\s+)?(?:(?:e-?)?sign(?:s|ing)?(?:\s+up)?(?!\s+in(?:to)?\b)|enrol(?:l)?(?:s|ed|ing|ment)?|join(?:s|ing)?|register(?:s|ing)?|registration)`,
  String.raw`(?:when|once|as\s+soon\s+as|upon)\s+(?:you(?:['’]ve|\s+have)|the\s+client\s+has|they(?:['’]ve|\s+have))\s+(?:e-?)?signed(?!\s+in(?:to)?\b)`,
  // "upon your signature", "once you're enrolled", "during enrollment", "when we open your file", "as soon as we receive
  // your signed agreement", "while you can still cancel".
  String.raw`(?:upon|on|at|with|after|once)\s+(?:your|the\s+client['’]s|their)\s+(?:e-?)?signature|(?:when|once|as\s+soon\s+as|after|upon)\s+you['’]re\s+(?:enrol(?:l)?ed|signed\s+up|registered)|(?:during|as\s+part\s+of|at\s+the\s+time\s+of)\s+(?:your\s+|the\s+)?(?:enrol(?:l)?ment|sign[\s-]?up|registration|onboarding)`,
  String.raw`(?:when|once|after|as\s+soon\s+as|upon)\s+we\s+(?:open|set\s+up|create|receive|get|start)\s+(?:your\s+|the\s+)?(?:file|account|case|signed\s+(?:agreement|contract|form|application)|enrol(?:l)?ment|application)|while\s+you\s+(?:can|may|are)\s+(?:still\s+)?(?:able\s+to\s+)?cancel`,
  // A payment that gets the work going: "pay for your first three months to get started", "a one-time $149 charge to
  // open your case", "our team gets to work as soon as you pay", "we begin as soon as the card on file is charged".
  String.raw`to\s+(?:get\s+started|get\s+(?:your|the)\s+(?:case|file|program|plan|work|disputes?|account)\s+(?:started|going|open(?:ed)?)|open\s+(?:your|a|the)\s+(?:file|case|account)|reserve\s+(?:your|a|the)\s+(?:spot|place|seat)|activate\s+(?:your|the)\s+(?:account|plan|program|file)|(?:start|begin)\s+(?:your|the)\s+(?:program|plan|services?|work|file|case|disputes?))`,
  String.raw`(?:begin|begins|start|starts|gets?\s+to\s+work|goes?\s+to\s+work|gets?\s+started)\s+(?:\w+\s+){0,2}?(?:as\s+soon\s+as|once|when|after|the\s+moment|right\s+after)\s+(?:you\s+|the\s+client\s+|clients?\s+)?(?:pay|pays|paid|have\s+paid|has\s+paid|make\s+(?:the|your|a)\s+(?:first\s+)?payment)`,
  String.raw`(?:begin|begins|start|starts|gets?\s+started)\s+(?:\w+\s+){0,2}?(?:as\s+soon\s+as|once|when|after|upon)\s+(?:[\w'’-]+\s+){0,5}?(?:is|are|has\s+been|have\s+been)\s+(?:charged|paid|billed|collected|drafted|debited|processed)`,
  // "the moment you sign", "the minute this agreement is signed".
  String.raw`(?:at\s+)?the\s+(?:very\s+)?(?:moment|minute|instant|second)\s+(?:that\s+)?(?:${SIGNING}|(?:your\s+|the\s+)?(?:account|file|case|plan|subscription|enrol(?:l)?ment)\s+(?:is|has\s+been)\s+(?:opened|created|set\s+up|activated|approved))`,
  // "the morning after you sign", "on the first business day after you sign up".
  String.raw`the\s+(?:morning|evening|night|day)\s+after\s+${SIGNING}|(?:on\s+)?the\s+(?:first|1st|next)\s+(?:(?:business|calendar)\s+)?day\s+(?:after|following)\s+${SIGNING}`,
  String.raw`at\s+(?:the\s+)?(?:time\s+of\s+)?(?:signing|sign[\s-]?up|enrol(?:l)?ment|registration)`,
  // "on the day you sign", "the same day you sign", "the day this agreement is signed", "at the time you sign", "within
  // 24 hours of signing", "within 3 days of the effective date", "on the effective date", "upon execution of this agreement".
  String.raw`(?:on\s+)?the\s+(?:same\s+)?(?:day|date|week)\s+(?:(?:that|of|on\s+which|in\s+which)\s+)?(?:${SIGNING}|(?:your\s+|the\s+)?(?:account|file|case|plan|subscription|enrol(?:l)?ment)\s+(?:is|was|has\s+been)\s+(?:opened|created|set\s+up|activated|approved))`,
  String.raw`at\s+the\s+(?:same\s+)?time\s+(?:(?:that|of)\s+)?${SIGNING}`,
  // "within 24 hours of signing", "due 48 hours after signing", "within 3 days of the effective date"; and later after
  // signing, with no work named that it pays for (LATER, FOR_WORK_DONE): "due 10 days after you sign", "two weeks after
  // you sign", "on the first of the month after you sign".
  String.raw`(?:within\s+${NUM}\s+(?:(?:business|calendar)\s+)?(?:hours?|days?)\s+(?:of|after|from)|(?:\d+|a\s+few|several|${NUM})\s+(?:(?:business|calendar)\s+)?(?:hours?|days?|weeks?|months?)\s+(?:after|from|following)|(?:on\s+)?the\s+(?:first|1st)\s+(?:day\s+)?of\s+the\s+(?:next\s+|following\s+)?month\s+(?:after|following))\s+(?:(?:your|the)\s+)?(?:${SIGNING}|${EFFECTIVE}|(?:you\s+)?sign\w*)`,
  // "payable once the contract is signed", "due immediately", "pay $99 now to get started", "required to begin
  // services", "services begin once your first payment is received", "charged when your account is opened".
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
  String.raw`(?:before|prior\s+to)\s+(?:(?:any|the|we|our|your|you|first|initial)\s+)?(?:\w+\s+){0,3}?(?:begin\w*|start\w*|work\w*|perform\w*|services?|disputes?|letters?|review\w*|audit\w*|consult\w*|pull\w*|assign\w*|look\w*|do\s+anything|(?:cancel\w*|rescission|waiting)\s+period)`,
  String.raw`at\s+the\s+outset|at\s+(?:the\s+)?(?:very\s+)?(?:start|beginning)(?!\s+of\b)|on\s+day\s+(?:one|two|three|[1-7])|on\s+your\s+(?:very\s+)?first\s+day|at\s+check-?out`,
  // "please include your first payment with this signed agreement", "return this agreement with your $99 payment".
  String.raw`with\s+(?:this|the|your)\s+signed\s+(?:agreement|contract|form|application)|(?:return|send|submit|mail|bring)\w*\s+(?:this|the|your)\s+(?:signed\s+)?(?:agreement|contract|form|application)\s+(?:together\s+|along\s+)?with`,
  // Right away, next to a payment word: "charged right away", "we charge your card immediately", "drafted immediately"
  // (not "charged immediately after each round of letters is sent").
  String.raw`(?:charg|bill|collect|draft|debit|process|run)\w*\s+(?:[^\s.!?;:,]+\s+){0,3}?(?:right\s+away|instantly|immediately|at\s+once)(?!\s+(?:after|once|when|upon|following|as\s+soon\s+as)\b)|(?:due|payable|paid)\s+(?:in\s+full\s+)?(?:right\s+away|instantly|at\s+once)|(?:right\s+away|instantly|immediately|at\s+once)\s+(?:[^\s.!?;:,]+\s+){0,2}?(?:charg|bill|collect|draft|debit)\w*`,
  // "we require a $99 payment to open your file", "a credit audit fee is due at your first consultation", "pay $99 now".
  String.raw`requir(?:e|es|ed|ing)\s+(?:[^\s.!?;:,]+\s+){0,4}?${PAYMENT_NOUN}(?:\s+[^\s.!?;:,]+){0,3}?\s+(?:to|before|prior\s+to|in\s+order\s+to)\s+(?:(?:we|you|us|can|could)\s+){0,2}(?:begin|start|open|activat|get\s+started|review|work|do|prepar|send|mail|file|process|enrol|set\s+up|proceed)\w*`,
  String.raw`(?:at|after|following|upon)\s+(?:your|the|our)\s+(?:(?:first|initial)\s+)?(?:consultation|consult|appointment|meeting|session|kick-?off(?:\s+(?:call|meeting))?|(?:welcome|intake|onboarding)\s+(?:call|meeting|interview|session))|(?:at|upon|on|during)\s+onboarding|(?:upon|on|after)\s+(?:approval|acceptance)\s+of\s+(?:your|their|the)\s+(?:application|enrol(?:l)?ment)`,
  // "collected in the first week", "billed within the first 3 days" (unless for work already performed: LATER),
  // "a $99 payment starts your program", "$99 secures your spot".
  String.raw`(?:in|within|during)\s+(?:the\s+|your\s+)?first\s+(?:\d+\s+|few\s+|two\s+|three\s+|four\s+|five\s+|six\s+|seven\s+)?(?:hours?|days?|weeks?|month)`,
  String.raw`${PAYMENT_NOUN}\s+(?:[^\s.!?;:,]+\s+){0,2}?(?:starts?|begins?|activates?|opens?|secures?|reserves?|unlocks?|holds?)\s+(?:your|the)\s+(?:program|plan|services?|file|account|membership|subscription|spot|place|seat|enrol(?:l)?ment|work|case)`,
  String.raw`(?:pay|charg\w*|bill\w*)\s+(?:[^\s.!?;:,]+\s+){0,4}?(?:right\s+)?now(?!\s+and\s+then)`,
  // Spanish: "se cobra al firmar", "paga por adelantado".
  String.raw`al\s+firmar|(?:al|en\s+el)\s+momento\s+de\s+(?:firmar|la\s+firma|inscribirse|la\s+inscripci[oó]n)|por\s+(?:adelantado|anticipado)|(?:al|antes\s+de)\s+(?:la\s+)?(?:firma|inscripci[oó]n)|antes\s+de\s+(?:empezar|comenzar|iniciar|enviar|mandar|preparar|revisar|disputar|trabajar|hacer|realizar|prestar|firmar|inscribirse|contratar)`,
  // "cuando firme", "en cuanto usted firma", "cuando usted se inscribe".
  String.raw`(?:cuando|en\s+cuanto|apenas|tan\s+pronto\s+como)\s+(?:usted\s+)?(?:firm[ae]n?|se\s+inscrib[ae]n?|contrat[ae]n?)`,
  String.raw`el\s+(?:mismo\s+)?d[ií]a\s+(?:en\s+)?(?:que|de)\s+(?:usted\s+)?(?:firma|firme|firmar|la\s+firma)|el\s+(?:mismo\s+)?d[ií]a\s+de\s+(?:la\s+)?(?:inscripci[oó]n|firma|afiliaci[oó]n)|al\s+(?:inscribirse|registrarse|afiliarse|contratar|comenzar|empezar|iniciar)|al\s+(?:inicio|comienzo|principio)\s+de\s+(?:cada|el|este|su)\s+(?:mes|per[ií]odo|ciclo|programa)`,
  // "pague hoy" (not "a partir de hoy", "desde hoy": from today on).
  String.raw`hoy(?<!\b(?:partir\s+de|desde)\s{1,3}hoy)`,
].join('|') + String.raw`)\b`, 'gi');

/** Later after signing (more than 7 days, or weeks or months), the first of the month after, or in the first days of the program: an advance fee unless it pays for work already done. */
const LATER = /^(?:in|within|during)\s+(?:the\s+|your\s+)?first\b|^(?:(?:[89]|[1-9]\d+|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|sixty|ninety|a\s+few|several)\s+(?:(?:business|calendar)\s+)?days?|\S+\s+(?:weeks?|months?))\s+(?:after|from|following)\b|^(?:on\s+)?the\s+(?:first|1st)\s+(?:day\s+)?of\s+the\s+(?:next\s+|following\s+)?month\s+(?:after|following)\b/i;
/*
 * For work already done ("…, for the work performed during those 30 days", "covering the first month of completed
 * work", "once those disputes are complete"), not work still to come: "to be performed", "that will be done", "we will
 * have performed", "rendered under this agreement", "completed over the next six months", "mailed during the program".
 */
const NOT_YET = String.raw`(?!\s+(?:under\s+(?:this|the)|during\s+the\s+(?:program|term|agreement|contract|plan)|over\s+the\s+(?:next|coming|program|term|life)|throughout|in\s+the\s+(?:next|coming|months?\s+ahead))\b)`;
const FOR_WORK_DONE = new RegExp(String.raw`\b(?:for|cover(?:s|ing)?|pays?\s+for)\s+(?:only\s+)?(?:the\s+|all\s+|any\s+)?(?:work|services?|letters?|disputes?)\b[^;]{0,50}?\b(?<!\b(?:to|will|shall|would)\s+be\s+|\b(?:will|shall|would)\s+have\s+)(?:already\s+)?(?:performed|done|completed|provided|rendered|delivered|sent|mailed)\b${NOT_YET}|\b(?:for|cover(?:s|ing)?|pays?\s+for)\s+(?:only\s+)?(?:the\s+|all\s+|any\s+)?(?:[\w'’-]+\s+){0,3}?(?:completed|performed|finished|delivered)\s+(?:work|services?|disputes?|letters?|rounds?)\b|\b(?:once|after|when)\s+(?:that|the|those|this|each|its|their|your)\s+(?:month['’]s\s+)?(?:work|disputes?|round|letters?)\s+(?:is|are|has\s+been|have\s+been)\s+(?:complete|completed|done|finished|performed|mailed|sent)\b|\bin\s+arrears\b|\bpor\s+(?:el\s+)?(?:trabajo|servicios?)\s+(?:ya\s+)?(?:realizados?|completados?|hechos?|prestados?)`, 'i');
/** The start of a period, alone: an advance fee unless its own clause says it pays for the period before (PRIOR_PERIOD). */
const PERIOD_START = /^(?:at|on)\s+the\s+(?:very\s+)?(?:beginning|start|first\s+day|1st|first)\s+of\s+(?:each|every|the|a|this|that|your)\s+(?:(?:calendar|service|billing|new|monthly|program|contract|subscription|\d+-day|thirty-day)\s+){0,2}(?:month|billing\s+(?:cycle|period)|period|program|cycle|subscription|term|plan)$|^al\s+(?:inicio|comienzo|principio)\s+de\s+(?:cada|el|este|su)\s+(?:mes|per[ií]odo|ciclo|programa)$/i;
/** Words that add something to a charge, so the period they name is not what the charge is for: "together with anything left from the previous month". */
const ADDED_TO = /\b(?:together\s+with|along\s+with|plus|in\s+addition\s+to)\b[^,;.!?]*|(?<![\p{L}])(?:junto\s+con|adem[aá]s\s+de)(?![\p{L}])[^,;.!?]*/giu;
const PRIOR_PERIOD = /\b(?:previous|prior|preceding|last|past)\s+(?:calendar\s+)?(?:month|period|cycle|billing\s+(?:cycle|period))|\b(?:month|period|cycle)\s+before\b|\bin\s+arrears\b|\b(?:we|you)\s+(?:have\s+)?(?:completed|performed|did|finished|done)\b|\balready\s+(?:been\s+)?(?:performed|done|completed|provided|delivered)\b|\b(?:mes|per[ií]odo|ciclo)\s+anterior\b|\b(?:trabajo|servicios?)\s+(?:ya\s+)?(?:realizados?|completados?|hechos?|prestados?)/i;

/**
 * Where one clause of a payment term ends: ";", ":", and, but, otherwise, then, unless, except, and a comma before a new
 * subject or condition ("…, and we bill…", "…, you pay…", "…, if…"). A comma that sets off words about the payment does
 * not end it ("your full payment, made at signing, covers…", "the fee is $99, taken when you sign", "$99, which is taken
 * at signing").
 */
const FEE_CLAUSE_END = /[;:!?]|(?<!\d)\.|\.(?!\d)|,(?=\s*(?:(?:and|or|but|then|so|y|pero)\s+)?(?:we|you|they|it|i|he|she|our|your|their|the\s+client|usted|nosotros|if|when|once|unless|otherwise|si|cuando)\b)|\b(?:and|but|otherwise|then|unless|except|or\s+else|pero|sino)\b/i;
/** A sentence of a payment term, for what it says the payment is for: up to ";" or the end of the sentence. */
const FEE_SENTENCE_END = /[;!?]|(?<!\d)\.|\.(?!\d)/;

const FEE_CLAUSE_END_G = new RegExp(FEE_CLAUSE_END.source, 'gi');
/** A clause after "and" with no subject of its own goes on from the one before: "billing runs for six months and starts the day you sign". */
const GOES_ON = /^\s*(?:(?:then|also|only|always)\s+)?(?:starts?|begins?|commences?|kicks?\s+in|is|are|will|comes?|falls?|becomes?|occurs?|happens?|takes?\s+place|recurs?|renews?|applies?|continues?|gets?)\b/i;
/** "Not after the work but up front": the payment named before "not … but" is this one's. */
const NOT_LATER = /\bnot\s+(?:(?:only|just)\s+)?(?:after|once|when|until|later|at\s+the\s+end|in\s+arrears|monthly|each\s+month)\b[^;:.!?]*$/i;
/** Back to the time word in the next clause: "…at signing and collect them right then", "…on day one, and the charge for it posts the same day". */
const BACK_TO_TIME = /\b(?:right\s+then|then\s+and\s+there|at\s+that\s+(?:time|point|moment)|(?:on\s+)?the\s+same\s+day|that\s+(?:same\s+)?day|right\s+away|at\s+once)\b/i;

/**
 * The time word's own clause: the words before it and after it up to FEE_CLAUSE_END. A time phrase that opens its
 * clause ("When you sign, you pay $99", "Upon signing, a fee is charged", "Before work begins, you pay $99", "Prior to
 * the start of services, a fee of $199 is due") also takes the clause after its comma. A clause after "and" with no
 * subject of its own takes the one before it ("billing runs for six months and starts the day you sign"), "not after
 * the work but up front" takes the words before "not", and a next clause that goes back to the time word is read with
 * it ("we go over the fees at signing and collect them right then").
 */
function feeClause(text: string, at: number, end: number): { before: string; after: string; clause: string; sentence: string } {
  const lead = text.slice(Math.max(0, at - 160), at);
  let cut: RegExpExecArray | null = null;
  for (const m of lead.matchAll(FEE_CLAUSE_END_G)) cut = m;
  let before = cut ? lead.slice(cut.index + cut[0].length) : lead;
  if (cut && ((/^and$/i.test(cut[0]) && GOES_ON.test(before)) || (/^but$/i.test(cut[0]) && NOT_LATER.test(lead.slice(0, cut.index))))) {
    before = `${lead.slice(0, cut.index).split(FEE_CLAUSE_END).pop()!}${cut[0]}${before}`;
  }
  const tail = text.slice(end, end + 160);
  let after = tail.split(FEE_CLAUSE_END)[0]!;
  const stop = FEE_CLAUSE_END.exec(tail);
  if (!/\S/.test(before) && stop?.[0] === ',') after = `${tail.slice(0, stop.index)} ${tail.slice(stop.index + 1).split(FEE_CLAUSE_END)[0]!}`;
  else if (stop && /^and$/i.test(stop[0])) {
    // Up to a comma or "but": "then" in "right then" ends no clause here.
    const next = tail.slice(stop.index + stop[0].length).split(/[;:!?,]|(?<!\d)\.|\.(?!\d)|\b(?:but|otherwise|unless|except|pero|sino)\b/i)[0]!;
    if (BACK_TO_TIME.test(next)) after = `${after} and ${next}`;
  }
  const sentence = `${text.slice(Math.max(0, at - 240), at).split(FEE_SENTENCE_END).pop()!}${text.slice(at, end)}${text.slice(end, end + 240).split(FEE_SENTENCE_END)[0]!}`;
  return { before, after, clause: `${before} ${text.slice(at, end)} ${after}`, sentence };
}

/**
 * A negated verb of charging covers the list after it, up to the time word: "we do not charge a setup fee, a
 * cancellation fee or any fee in advance", "federal law does not allow us to charge you before the work is complete".
 * Not across "and", "so", "because", "since", "which", a cap ("more than", "over"), a dash, a new clause or an amount
 * ("we do not charge interest, and the first month is paid when you sign", "we do not bill hourly, so the fee is due at
 * signing", "we don't charge interest because you pay the full price when you sign", "we never collect more than one
 * month in advance", "we never ask for a deposit — the first months are billed up front", "we never charge over $99
 * when you sign").
 */
const NEGATED_CHARGE = new RegExp(String.raw`(?:\b(?:do|does|did|will|shall|would|can|could|may)\s+not|\bnever|n['’]t)\s+(?:ever\s+)?(?:(?:allow|permit)\s+(?:us|anyone|any\s+\w+)\s+to\s+|let\s+(?:us|anyone)\s+)?(?:charge|bill|collect|ask\s+(?:you\s+)?for|require|take|accept|request)\b(?:(?!\b(?:but|however|yet|otherwise|then|unless|except|and|so|because|since|which|given|exceed\w*|provided|while|as\s+long\s+as|so\s+long\s+as)\b|\b${CAP}|[;:—–]|\s-\s|\$\s?\d|,\s*(?:we|you|they|it|i|our|the\s+client)\b)[^.!?])*$`, 'i');
/**
 * The same in Spanish: "nunca cobramos por adelantado", "no pedimos ningún pago al firmar", "no se cobra … al firmar",
 * "no hay depósito, cuota de inscripción ni pago por adelantado". Not across "pero", "y", "así que", "pues", "porque",
 * "ya que", "como", "más de", a dash or an amount.
 */
const NEGATED_CHARGE_ES = /(?<![\p{L}])(?:no|nunca|jam[aá]s)(?:\s+(?:se|le|les|te|lo|la))*\s+(?:cobr|ped|pid|exig|requ|solicit|factur|carg|acept|recib|tom|hay|habr[aá]|existen?)\p{L}*(?:(?!(?<![\p{L}])(?:pero|sino|excepto|salvo|aunque|y|as[ií]\s+que|pues|porque|ya\s+que|como|dado\s+que|m[aá]s\s+de)(?![\p{L}])|[;:—–]|\s-\s|\$\s?\d)[^.!?])*$/iu;
/**
 * A start that is not signing (the account set up, the agreement in effect) is an advance fee only if the clause does
 * not bill in arrears: "once your account is set up, you are billed at the end of each month for the work performed
 * that month" passes. Signing or enrolling is no soft start: after it only a bill at the end of each period, or one for
 * work already done, passes ("upon signing, you are billed at the end of each month for the work performed that
 * month"; not "upon enrollment, the full fee is charged, with a final reconciliation at the end of the term").
 */
const SOFT_START = /^(?:when|once|as\s+soon\s+as|upon|at\s+the\s+time)\s+(?:your\s+|the\s+|this\s+)?(?:account|file|case|plan|subscription|registration|application|agreement|contract)/i;
const SIGN_START = /^(?:when|once|as\s+soon\s+as|upon|at\s+the\s+time)\s+(?:your\s+|the\s+|this\s+)?(?:enrol|sign)/i;
const EACH_PERIOD_END = /\b(?:at|by)\s+the\s+end\s+of\s+(?:each|every)\s+(?:(?:calendar|billing|service)\s+)?(?:months?|periods?|cycles?|rounds?|quarters?)\b/i;
// The end of a billing period ("at the end of each month"), not of the first day or week of the program.
const ARREARS = /\b(?:at|by)\s+the\s+end\s+of\s+(?:each|every|the|a|your)\s+(?:(?:calendar|billing|service)\s+)?(?:months?|periods?|cycles?|rounds?|quarters?|terms?)\b|\bafter\s+(?:the\s+|each\s+|every\s+)?(?:work|services?|month|round|letters?)\b[^.;]{0,40}?\b(?:performed|done|completed|provided|delivered|sent|mailed|ends?|over)\b/i;

/**
 * A time word that is the object of a cancellation, not a time to pay: "if you cancel before work starts, you pay
 * nothing", "you may cancel this agreement without penalty within 3 business days after you sign", "you have 3 business
 * days after you sign to cancel". A cancellation anywhere else in the sentence does not count ("if you cancel, you pay
 * nothing; otherwise $99 is due when you sign", "non-cancellable: $99 is due when you sign").
 */
const CANCEL_BEFORE = /(?<![\w-])(?<!\b(?:unless|or\s+else|otherwise)\s{1,3}(?:(?:you|they|the\s+client)\s{1,3})?)cancel(?:s|led|ling|lation)?\s+(?:(?:this|the|your)\s+(?:agreement|contract|services?|enrol(?:l)?ment)\s+|it\s+)?(?:(?:at\s+)?any\s*time\s+|without\s+(?:any\s+)?(?:penalty|obligation|charge|cost|fee)s?\s+(?:or\s+(?:penalty|obligation|charge|cost|fee)s?\s+)?|at\s+no\s+(?:charge|cost)\s+|for\s+free\s+|free\s+of\s+charge\s+|in\s+writing\s+)*$/i;
// "… days after you sign to cancel" is a period to cancel in; "$299 at signing to cancel it" is a payment for cancelling,
// and "within 3 days of signing to cancel the waitlist hold on your file" cancels something else. "Your $499 is charged
// unless you cancel before signing" is a charge.
const CANCEL_OBJECT = /^\s+(?:in\s+which\s+)?to\s+cancel\b(?!\s+(?:the|a|an|any|your|our)\s+(?!(?:agreement|contract|services?|enrol(?:l)?ment|program|plan|subscription|membership)\b)[\w-]+)/i;
const cancellationTerm = (text: string, at: number, end: number, word: string) =>
  (/^(?:before|within|prior\s+to|by\s+the\s+time)\b/i.test(word) && CANCEL_BEFORE.test(text.slice(Math.max(0, at - 120), at)))
  || (/\b(?:days?|hours?|weeks?|before|within|prior|by\s+the\s+time)\b/i.test(word) && CANCEL_OBJECT.test(text.slice(end, end + 60)));

/**
 * "Up front" and "in advance" in their honest senses: being open about the fees ("we are upfront about all of our fees",
 * "we tell you up front what each month will cost") and notice given ahead ("we will notify you in writing 30 days in
 * advance of any change to your monthly fee", "any price increase is announced at least 60 days in advance").
 */
const OPEN_ABOUT = /\b(?:(?:we|i|our\s+(?:team|staff|company|firm|agency))\s+(?:(?:are|am|is|try\s+to\s+be|always|will\s+be|stay|remain|want\s+to\s+be)\s+)+|(?:tell|tells|told|explain\w*|disclos\w*|show\w*|share\w*|quot\w*|list\w*)\s+(?:you\s+|clients?\s+|everyone\s+)?)$/i;
const NOTICE_AHEAD = new RegExp(String.raw`\b(?:notif\w*|notice|announc\w*|inform\w*|tell|told|warn\w*|let\s+you\s+know)\b[^.;]{0,60}?\b(?:at\s+least\s+)?${NUM}\s+(?:(?:business|calendar)\s+)?(?:days?|weeks?|months?)\s+$`, 'i');
function honestTime(text: string, at: number, end: number, word: string): boolean {
  const lead = text.slice(Math.max(0, at - 120), at), next = text.slice(end, end + 60);
  if (/^up[\s-]?front$/i.test(word)) return OPEN_ABOUT.test(lead) || /^\s+(?:about|regarding|when\s+it\s+comes\s+to)\b/i.test(next);
  if (/^in\s+advance$/i.test(word)) return NOTICE_AHEAD.test(lead) || /^\s+of\s+(?:any|a|the|each|every|such)\s+(?:[\w-]+\s+)?(?:changes?|increases?|adjustments?|updates?|modifications?)\b/i.test(next);
  return false;
}
/** "…, then we start work", "…, and only then do we begin": the work after a payment. */
const PAY_THEN_WORK = /\b(?:then|and\s+then|only\s+then|after\s+that|afterwards)\s*,?\s+(?:do\s+)?(?:we|our\s+(?:team|staff|specialists?))\s+(?:will\s+|can\s+)?(?:start|begin|get\s+to\s+work|get\s+started|pull|open|review|send|mail|prepare|work|dispute)\w*/gi;
/** A payment with a time of its own after the work ("you pay at the end of each month, then we start the next round"). */
const LATER_PAYMENT = /\b(?:after|at\s+the\s+end|once|when|monthly|each\s+month|every\s+month|in\s+arrears|for\s+(?:the\s+)?(?:work|services?|letters?))\b/i;

/**
 * Payment asked for at or before signing, or in advance, which 15 U.S.C. § 1679b(b) forbids: no credit repair
 * organization "may charge or receive any money or other valuable consideration for the performance of any service …
 * before such service is fully performed". Read in the agency's contract terms. A deposit, retainer, prepayment or a
 * setup, enrollment, sign-up or activation fee is a payment wherever it is named (unless denied: "a deposit is never
 * required"); a time word counts when a payment word (pay, charge, fee, due, bill, deposit, retainer, dues, debited,
 * drafted, settled, "comes out of your account", "we run your card", $…) is in its own clause (feeClause: a comma that
 * only sets off words about the payment does not end it, "your full payment, made at signing, covers…"; a clause after
 * "and" with no subject of its own goes on from the one before, "billing runs for six months and starts the day you
 * sign"; "not after the work but up front" reads the words before "not"; a next clause that goes back to the time word
 * is read with it, "we go over the fees at signing and collect them right then"):
 *  - at or before signing: when you sign (or they, clients, the customer sign), you e-sign, upon your signature, at
 *    signing, upon or during enrollment, once you're enrolled, today, on or the same day or week you sign, at the time
 *    you sign, the moment you sign, once you've signed, within 24 hours of signing, the morning after you sign, the
 *    first business day after you sign up, with this signed agreement, while you can still cancel;
 *  - when the agreement takes effect: on the effective date or your start date, within 3 days of it, upon execution,
 *    when the agreement takes effect, the moment, the day or when the account is created or set up or the enrollment is
 *    complete (unless the clause bills at the end of a billing period or for work performed: SOFT_START), when we open
 *    your file or receive your signed agreement, upon approval or acceptance of the application;
 *  - later after signing (10 days, two weeks, the first of the month after you sign) or in the first hours, days or
 *    weeks, unless it pays for work already performed ("…, for the work performed during those 30 days", "covering the
 *    first month of completed work", "once those disputes are complete"; not work "to be performed", "we will have
 *    performed", "rendered under this agreement" or "completed over the next six months");
 *  - before the work: up front and in advance (not "we are upfront about our fees", "we tell you up front what each
 *    month costs" or notice given "30 days in advance of any change"), at the outset, at checkout, on day one or day 3,
 *    on your first day, at or during onboarding, at your kickoff call or after your intake interview, right away or
 *    immediately next to a payment word, before work starts, before we send your first letters, review, pull or look at
 *    your reports or assign your file, until or once a payment is received or clears, required to begin, a payment that
 *    starts or secures the program, "to get started" or "to open your case", work that begins as soon as you pay or the
 *    card is charged, "payment first, then we pull your reports", at your first consultation, and billing at the start
 *    of a month, a program or a billing cycle (a service month, every 30-day period, the 1st for the current month)
 *    unless its own clause says it is for the period before (not a balance carried "together with" it);
 *  - in Spanish: al firmar, el día que firma, el día de la inscripción, cuando o en cuanto firma, antes de firmar, al
 *    inscribirse, al comenzar, hoy, por adelantado, antes de empezar or de enviar, al inicio de cada mes, and a depósito
 *    or anticipo.
 * Payments named only to say there are none pass ("there is no setup fee", "we do not charge a setup, enrollment or
 * activation fee", "nothing is charged when you sign", "payment is not required at signing", "no payment of any kind is
 * due", "we never charge in advance", "costs nothing", "no cobramos nada por adelantado", "no hay depósito ni pago por
 * adelantado"), as do fees only explained, disclosed or confirmed ("we explain our fees before we start work", "we
 * disclose all fees in writing before you sign"), words about payment that ask for none ("a payment schedule", "your
 * payment method is verified", "your price is locked in") and billing that stops ("if you cancel, we stop billing you
 * right away"). A cap does not ("never more than $99 at signing", "we never collect more than one month in advance"),
 * nor a payment put off only to a time ("payment is not due until the day you sign"), and a negated charge reaches no
 * further than "and", "so", "because", "since", "which", a dash or a new clause ("we do not charge interest, and the
 * first month is paid when you sign", "we don't charge interest because you pay the full price when you sign"). A
 * refund owed to the client passes too ("any refund owed to you is due immediately"; not "$500 at signing, subject to
 * a refund" or "any refund or fee is due at signing"), and so does a time word that is the object of a cancellation
 * ("if you cancel before work starts, you pay nothing"; not "within 3 days of signing to cancel the waitlist hold"). A
 * list of rules, like the claims check: it catches the common wordings.
 */
export function findAdvanceFee(text: string): ClaimIssue | null {
  const why = 'This asks for payment before the work it pays for is done. Federal law (15 U.S.C. § 1679b(b)) does not allow charging for a service before it is fully performed.';
  for (const m of text.matchAll(ADVANCE_PAYMENT)) {
    const end = m.index + m[0].length;
    if (!feeNegated(text.slice(Math.max(0, m.index - 80), m.index)) && !FEE_DENIED_AFTER.test(text.slice(end, end + 60))) return { id: 'advance-fee', why, excerpt: m[0] };
  }
  // A time word asks for payment only with a payment word or an amount in its clause: with none in the text, none does.
  if (!PAYMENT_WORD.test(text) && !AMOUNT.test(text)) return null;
  for (const m of text.matchAll(ADVANCE_TIME)) {
    const at = m.index, end = at + m[0].length;
    if (cancellationTerm(text, at, end, m[0]) || honestTime(text, at, end, m[0])) continue;
    const { before, after, clause, sentence } = feeClause(text, at, end);
    // "Payment is not up front", "never in advance", "we do not charge a setup fee, a cancellation fee or any fee in
    // advance", "no cobramos nada por adelantado", "nunca cobramos por adelantado".
    if (/(?:\b(?:no|not|never|nothing|none|without|zero|nada|nunca|sin)|\bjam[aá]s|n['’]t)\s+$/i.test(before)) continue;
    const sentenceBefore = text.slice(Math.max(0, at - 240), at).split(FEE_SENTENCE_END).pop()!;
    if ((NEGATED_CHARGE.test(sentenceBefore) || NEGATED_CHARGE_ES.test(sentenceBefore)) && !AMOUNT.test(after)) continue;
    if (!asksPayment(clause)) continue;
    if (LATER.test(m[0]) && FOR_WORK_DONE.test(sentence)) continue;
    if (PERIOD_START.test(m[0]) && PRIOR_PERIOD.test(clause.replace(ADDED_TO, ' '))) continue;
    if (SOFT_START.test(m[0]) && (ARREARS.test(clause) || FOR_WORK_DONE.test(clause))) continue;
    if (SIGN_START.test(m[0]) && (EACH_PERIOD_END.test(clause) || FOR_WORK_DONE.test(clause))) continue;
    return { id: 'advance-fee', why, excerpt: m[0] };
  }
  // "We charge the first month's fee, then we start work", "Payment first, then we pull your reports": a payment, and the
  // work only after it.
  for (const m of text.matchAll(PAY_THEN_WORK)) {
    const before = text.slice(Math.max(0, m.index - 160), m.index).split(FEE_SENTENCE_END).pop()!;
    if (asksPayment(before) && !LATER_PAYMENT.test(before) && !NEGATED_CHARGE.test(before)) return { id: 'advance-fee', why, excerpt: `${before.trim().split(/\s+/).slice(-4).join(' ')} ${m[0]}`.slice(0, 80) };
  }
  return null;
}
