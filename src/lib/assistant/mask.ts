/**
 * What the client assistant removes from text before that text may be put in front of an AI provider.
 *
 * The records it sends are case facts: names, statuses, dates, creditor names, balances, the last four digits of an
 * account. These never go: a Social Security number or its last four, a date of birth, a full account or card number,
 * a street address, a phone number, an email address, the contents or the file name of a document.
 *
 * Structured values are simply not selected (src/lib/assistant/records.ts never reads a client's contact details into
 * the text it builds). Free text is the risk: a staff note, a client's message, a task title or a timeline entry can
 * hold anything a person typed. It is masked here by matching, in this order:
 *   1. by pattern (src/lib/scrub.ts): Social Security numbers, card numbers, email addresses, phone numbers;
 *   2. what the app holds about that client, wherever it appears as written on file: the address lines, city and ZIP
 *      code, the SSN last four, the date of birth in common formats;
 *   3. a date that follows a word for birth, and digits that follow a word for a Social Security number;
 *   4. street addresses with a common street type, in English or Spanish order, and city-state-ZIP lines;
 *   5. any other run of five or more digits, and digit groups joined by spaces or dashes that total nine or more, which
 *      keep their last four ("[number ending 1234]"), so an account number written in a note cannot pass whole. An
 *      amount written with a currency sign is left as it is.
 * Masking works by matching, so it is not a guarantee: an address written with no street type, or a date of birth with
 * no word for birth near it that is not the one on file, is sent as typed. Notes and messages are also cut short.
 */
import { maskOnFile, maskStreetAddresses, type Redaction } from '../guide/llm';
import { scrubPii } from '../scrub';

const MONTHS = 'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?'
  + '|enero|febrero|marzo|abril|mayo|junio|julio|agosto|sep?tiembre|octubre|noviembre|diciembre';
/** A date in the forms people type, or a year standing alone. */
const DATE_LIKE = new RegExp(
  String.raw`\d{1,4}[/.-]\d{1,2}[/.-]\d{1,4}`
  + String.raw`|\b(?:${MONTHS})\b\.?\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s+\d{2,4})?`
  + String.raw`|\d{1,2}(?:st|nd|rd|th)?\s+(?:of\s+|de\s+)?(?:${MONTHS})\b\.?(?:,?\s+(?:de\s+|del\s+)?\d{2,4})?`
  + String.raw`|\b(?:${MONTHS})\b\.?\s+(?:de\s+|del\s+)?\d{4}`
  + String.raw`|\b(?:19|20)\d{2}\b`, 'giu');
const BIRTH_WORD = /(?<![\p{L}\p{N}])(?:d\.?\s?o\.?\s?b\.?|date\s+of\s+birth|birth\s*date|birth\s*day|born|fecha\s+de\s+nacimiento|nacimiento|naci[oó]|nacid[oa])(?![\p{L}\p{N}])/giu;
const SSN_WORD = /(?<![\p{L}\p{N}])(?:ssn|ss\s?#|social(?:\s+security)?(?:\s+(?:number|no\.?|#))?|seguro\s+social)(?![\p{L}\p{N}])/giu;
/** The first four digits standing alone (the last four of the number), or a whole number, that is not part of a date. */
const SSN_DIGITS = /(?<![\d/.-])(?:\d{3}[ -]?\d{2}[ -]?\d{4}|\d{4})(?![/.-]?\d)/;
/** How far after the word the date or the digits are looked for. */
const REACH = 40;

/** `mask` applied to the `REACH` characters that follow each match of `word`. */
function after(text: string, word: RegExp, mask: (tail: string) => string): string {
  let out = '';
  let from = 0;
  for (const m of text.matchAll(word)) {
    const start = m.index + m[0].length;
    if (start < from) continue;
    const end = Math.min(text.length, start + REACH);
    out += text.slice(from, start) + mask(text.slice(start, end));
    from = end;
  }
  return out + text.slice(from);
}

const DIGIT_GROUPS = /(?<![$€£\d.,/])\d+(?:[ -]\d+)+(?![\d/]|[.,]\d)/g;
const DIGIT_RUN = /(?<![$€£\d.,])\d{5,}(?!\d|[.,]\d)/g;
const ending = (digits: string) => `[number ending ${digits.slice(-4)}]`;

/**
 * Long numbers keep their last four digits: a run of five or more digits, and digit groups that total nine or more when
 * they are joined by dashes or are all four digits or longer ("1234-5678-90", "1234 5678 9012"). A date written with
 * dashes has eight digits at most and is left, and so is a list of short numbers ("30 60 90 120").
 */
export function maskLongNumbers(text: string): string {
  return text
    .replace(DIGIT_GROUPS, (m) => {
      const digits = m.replace(/\D/g, '');
      const oneNumber = !m.includes(' ') || m.split(/[ -]/).every((g) => g.length >= 4);
      return digits.length >= 9 && oneNumber ? ending(digits) : m;
    })
    .replace(DIGIT_RUN, (m) => ending(m));
}

/** Free text as it may be sent: masked (see the top of this file), on one line, with no angle brackets, at most `max` characters. */
export function safeText(raw: string | null | undefined, identifiers: Redaction[] = [], max = 300): string {
  if (!raw) return '';
  let t = maskOnFile(scrubPii(raw.replace(/\p{Cc}+/gu, ' ')), identifiers);
  t = after(t, BIRTH_WORD, (tail) => tail.replace(DATE_LIKE, '[DATE]'));
  t = after(t, SSN_WORD, (tail) => tail.replace(SSN_DIGITS, '[SSN]'));
  t = maskLongNumbers(maskStreetAddresses(t)).replace(/[<>]/g, ' ').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

/**
 * A short value that names something (a client, a specialist, a creditor, a plan, a reported status): pattern masking
 * and long numbers only. Titles and labels a person may have typed go through safeText instead.
 */
export function safeLabel(raw: string | null | undefined, max = 120): string {
  if (!raw) return '';
  const t = maskLongNumbers(scrubPii(raw.replace(/\p{Cc}+/gu, ' '))).replace(/[<>]/g, ' ').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

/** The last four characters of an account number, whatever was stored. */
export function last4(raw: string | null | undefined): string | null {
  const t = (raw ?? '').replace(/[^\p{L}\p{N}]/gu, '');
  return t ? t.slice(-4) : null;
}
