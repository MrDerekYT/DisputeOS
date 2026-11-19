/**
 * Specificity check for a dispute letter to a credit bureau or a specialty agency, run before it can be sent for
 * approval. An agency may end a reinvestigation it finds frivolous or irrelevant, "including by reason of a failure by
 * a consumer to provide sufficient information to investigate the disputed information" (15 U.S.C. § 1681i(a)(3)(A)).
 * So the letter has to say which account, what about it, and why, and say what is enclosed.
 *
 * A pure function over the dispute's structured data and the letter text. It lists what is missing; it never writes
 * anything and never suggests a reason. A reason is only ever what the client's own facts support.
 */

export interface SpecificityInput {
  /** The letter text as it would be approved. */
  body: string;
  /** disputes.category */
  category: string;
  /** disputes.reason. What is checked is the reason as the letter states it (reasonInLetter). */
  reason: string;
  /** disputes.fields: the reporting fields ticked for review. */
  fields: string[];
  /** The account as held in structured data: the tradeline's creditor and last digits, or the specialty item's name and reference. */
  account: { name: string | null; reference: string | null } | null;
}

export type SpecificityKey = 'account' | 'information' | 'reason' | 'enclosures';
export interface SpecificityIssue { key: SpecificityKey; message: string }

/** Letter kinds the check applies to. */
export const SPECIFICITY_KINDS = ['bureau_dispute', 'specialty_dispute'];

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

/** "account ending 1234", "Acct # ••1234", "Reference: xxxx4321", "cuenta terminada en 1234": a masked number or a reference written out in the letter. */
const NUMBER_IN_TEXT = /(account|acct|reference|ref\b|number|no\.|ending|#|••|cuenta|referencia|n[uú]mero|terminad[ao])[^\n\d$]{0,16}[xX*•]*\d{2,}/i;
/** A date written out, the reference an inquiry is identified by. */
const DATE_IN_TEXT = /\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b|\b\d{4}-\d{2}-\d{2}\b|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|ene|abr|ago|dic)[a-z]*\.?\s+\d{1,2},?\s+\d{4}\b/i;

/** Categories that are not about an account with a number. */
const NO_ACCOUNT = new Set(['personal_info']);
/** Categories that already name what is disputed. "Other" and a specialty item do not. */
const VAGUE_CATEGORY = new Set(['other', 'specialty_item']);

/** Words that name a piece of reported information, in English and Spanish. */
const INFORMATION_WORD = /\b(balance|amount|status|payments?|late|dates?|opened|closed|paid|limit|names?|address(es)?|employer|inquir(y|ies)|duplicate|ownership|owner|recogni[sz]e|charge[- ]?off|collection|saldo|monto|importe|estado|pagos?|atras\w*|fechas?|abiert\w+|cerrad\w+|pagad\w+|l[ií]mite|nombres?|direcci[oó]n(es)?|empleador|consultas?|duplicad\w+|titular\w*|reconozc\w+|cobranza)\b/i;

/** Stock sentences that say nothing about this account. What is left after removing them has to carry the reason. */
const STOCK = [
  /\bplease\s+(verify|investigate|reinvestigate|remove|delete|correct|review|fix|update|look into)\b[^.!?\n]*/gi,
  /\b(this|the)\s+(item|account|information|entry|debt|record)\s+(is|are|was)\s+(inaccurate|incorrect|not accurate|not correct|wrong|erroneous|false|not mine|unverifiable|invalid)\b/gi,
  /\b(i|we)\s+(dispute|am disputing|are disputing)\s+(this|the)\s+(item|account|information|entry|debt)\b/gi,
  /\b(it|this)\s+(is|should be)\s+(inaccurate|incorrect|wrong|removed|deleted|investigated|verified|corrected)\b/gi,
  /\b(should|must|needs? to)\s+be\s+(removed|deleted|investigated|verified|corrected|fixed)\b/gi,
  /\b(inaccurate|incorrect|erroneous|wrong)\s+(information|reporting|item|account|data)\b/gi,
  /\bnot\s+mine\b/gi,
  /\bpor favor\s+(verifi\w+|investig\w+|elimin\w+|corrij\w+|revis\w+|borr\w+)\b[^.!?\n]*/gi,
  /\b(esta|este|la|el)\s+(cuenta|dato|informaci[oó]n|deuda)\s+(es|est[aá])\s+(inexact[oa]|incorrect[oa]|err[oó]ne[oa]|fals[oa])\b/gi,
  /\bno\s+es\s+m[ií][ao]\b/gi,
];

/**
 * A concrete reason says what is reported and what the client's records or recollection show instead. A figure or a
 * date counts on its own; otherwise at least four content words must remain once the stock sentences are taken out.
 */
export function isConcreteReason(reason: string): boolean {
  const text = reason.replace(/\[[A-Z ]+NEEDED\]/g, ' ');
  if (/\d/.test(text) && text.trim().split(/\s+/).length >= 4) return true;
  let rest = text;
  for (const re of STOCK) rest = rest.replace(re, ' ');
  return rest.split(/[^\p{L}]+/u).filter((w) => w.length > 2).length >= 4;
}

/** Where the reason ends in the built-in templates: the request paragraph, the enclosures or the closing. */
const AFTER_REASON = /^\s*(please conduct|les pido|enclosures?\b|encl\.|anexos?\b|adjuntos?\b|sincerely|atentamente)/i;
const REASON_HEADING = /^\s*(reason for my request|what i believe is inaccurate[^\n]*|motivo de mi solicitud|lo que considero inexacto[^\n]*)\s*:?\s*$/i;

/**
 * The reason as the letter states it. The dispute's own reason cannot be edited once it is created, but the letter
 * can, so what gets checked is what would be mailed: everything under the letter's reason heading, up to the request that follows it. A letter with no
 * such heading (an agency's own template) falls back to the dispute's reason when the letter still carries it, and to
 * the whole letter otherwise.
 */
export function reasonInLetter(body: string, reason: string): string {
  const lines = body.split('\n');
  const at = lines.findIndex((l) => REASON_HEADING.test(l));
  if (at >= 0) {
    const rest = lines.slice(at + 1);
    const end = rest.findIndex((l) => AFTER_REASON.test(l));
    return rest.slice(0, end < 0 ? undefined : end).join(' ').replace(/\s+/g, ' ').trim();
  }
  return norm(body).includes(norm(reason)) ? reason : body;
}

/** True when the letter has an enclosures section that lists something, or says "none" in so many words. */
export function statesEnclosures(body: string): boolean {
  const lines = body.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*(enclosures?|encl\.?|attachments?|anexos?|adjuntos?)\s*:?\s*(.*)$/i.exec(lines[i]!);
    if (!m) continue;
    if (m[2]!.trim().length >= 2) return true; // "Enclosures: none", "Enclosures: copy of ID, utility bill"
    const next = lines.slice(i + 1).find((l) => l.trim() !== '');
    if (next && /^\s*([-•*]|\d+[.)])\s*\S/.test(next)) return true;
  }
  return false;
}

export function specificityIssues(i: SpecificityInput): SpecificityIssue[] {
  const out: SpecificityIssue[] = [];
  const body = norm(i.body);

  // 1. The account: its name and a masked number or reference, written in the letter.
  if (!NO_ACCOUNT.has(i.category)) {
    const name = i.account?.name?.trim() || null;
    const ref = i.account?.reference?.trim() || null;
    const nameOk = name ? body.includes(norm(name)) : false;
    // A reference held in structured data has to be the one in the letter. With none on record, any masked number or
    // reference written out counts; an inquiry has no number, so the date given in the reason identifies it.
    const refOk = ref ? body.includes(norm(ref)) : i.category === 'unauthorized_inquiry' ? DATE_IN_TEXT.test(reasonInLetter(i.body, i.reason)) : NUMBER_IN_TEXT.test(i.body);
    if (name && !nameOk) out.push({ key: 'account', message: `Name the account in the letter: “${name}” does not appear in it.` });
    if (!refOk) {
      out.push({
        key: 'account',
        message: i.category === 'unauthorized_inquiry' ? 'Identify the inquiry: give its date, as shown on the report, in the reason.'
          : ref ? `Identify the account: add its masked number or reference (“${ref}”) as shown on the report.`
            : 'Identify the account: add the last digits of the account number, or a reference number, as shown on the report (for example “account ending 1234”).',
      });
    }
  }

  // 2. The specific information disputed: a ticked field, a category that names it, or the letter naming it.
  const reason = reasonInLetter(i.body, i.reason);
  const ticked = i.fields.filter((f) => f.toLowerCase() !== 'other');
  const named = ticked.length > 0 || !VAGUE_CATEGORY.has(i.category) || INFORMATION_WORD.test(reason);
  if (!named) out.push({ key: 'information', message: 'State the specific information disputed (for example the balance, the status, a date or the payment history).' });

  // 3. A concrete reason, as the letter states it.
  if (!isConcreteReason(reason)) {
    out.push({ key: 'reason', message: 'Give a concrete reason in the letter: what is reported, and what the client’s own records or recollection show instead. Use only what the client has told you.' });
  }

  // 4. Enclosures: listed, or an explicit "none".
  if (!statesEnclosures(i.body)) {
    out.push({ key: 'enclosures', message: 'List what is enclosed (at least the identity documents: a copy of a photo ID and a proof of address), or write “Enclosures: none”.' });
  }
  return out;
}
