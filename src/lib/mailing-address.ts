/**
 * The agency's postal address as it is printed in every automatic email (lead follow-up and partner emails). Pure.
 *
 * Commercial email has to show a valid physical postal address of the sender (CAN-SPAM, 15 U.S.C. § 7704(a)(5)), and
 * this line is the one part of those emails an agency types freely. So it is held to the shape of a US postal address:
 * it starts with a street number or a box, ends with the state and the ZIP code, and in between holds a few short
 * parts, with no link, no phone number and nothing the claims check refuses. That keeps most messages out of the
 * field. It cannot prove that the address is real, and a short phrase can still have the shape of an address part. Used when the address is saved and
 * again when it is read, so a value saved before this rule existed stops the emails until it is corrected.
 */
import { findBlockedClaims } from './compliance/claims';
import { linkInName } from './lead-texts';

export const MAILING_ADDRESS_MIN = 12;
export const MAILING_ADDRESS_MAX = 160;

export const MAILING_ADDRESS_HELP =
  'Enter the postal address your business receives mail at, from the street number or PO Box to the state and ZIP code, for example "500 Bayshore Blvd, Suite 210, Tampa, FL 33606". It is printed in every automatic email.';

/** The two-letter codes a US address ends with before the ZIP code: the states, DC, the territories and the military "states". */
const US_STATE_CODES = 'AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY PR VI GU AS MP AA AE AP';
/** The same, written out. */
const US_STATE_NAMES = [
  'Alabama', 'Alaska', 'Arizona', 'Arkansas', 'California', 'Colorado', 'Connecticut', 'Delaware', 'Florida', 'Georgia', 'Hawaii', 'Idaho',
  'Illinois', 'Indiana', 'Iowa', 'Kansas', 'Kentucky', 'Louisiana', 'Maine', 'Maryland', 'Massachusetts', 'Michigan', 'Minnesota',
  'Mississippi', 'Missouri', 'Montana', 'Nebraska', 'Nevada', 'New Hampshire', 'New Jersey', 'New Mexico', 'New York', 'North Carolina',
  'North Dakota', 'Ohio', 'Oklahoma', 'Oregon', 'Pennsylvania', 'Rhode Island', 'South Carolina', 'South Dakota', 'Tennessee', 'Texas', 'Utah',
  'Vermont', 'Virginia', 'Washington', 'West Virginia', 'Wisconsin', 'Wyoming', 'District of Columbia', 'Puerto Rico', 'Guam',
  'U\\.S\\. Virgin Islands', 'Virgin Islands', 'American Samoa', 'Northern Mariana Islands',
];
/** "... FL 33606", "... FL. 33606", "... Florida 33606", "... TX 75013-4500", with the country allowed after it. */
const ENDS_WITH_STATE_AND_ZIP = new RegExp(
  `(?:^|[ ,])(?:${US_STATE_CODES.split(' ').join('|')}|${US_STATE_NAMES.map((n) => n.replace(/ /g, '\\s+')).join('|')})\\.?[ ,]+\\d{5}(?:-\\d{4})?` +
  '(?:,?\\s+(?:USA|U\\.S\\.A|US|U\\.S|United States(?:\\s+of\\s+America)?))?$', 'i');

/**
 * How a postal address starts: with its street number or a box ("500 Bayshore Blvd", "PO Box 123", "One Financial
 * Plaza", "Suite 210, 500 Main St", "RR 2 Box 152", "N6W23001 Bluemound Rd", "Calle Loíza 1234"), not with a phrase.
 * The business name is printed before the address already, so the address itself does not start with one.
 */
const NUMBER_WORDS = 'One|Two|Three|Four|Five|Six|Seven|Eight|Nine|Ten|Eleven|Twelve|Thirteen|Fourteen|Fifteen|Sixteen|Seventeen|Eighteen|Nineteen|Twenty|Thirty|Forty|Fifty|Sixty|Seventy|Eighty|Ninety|Hundred';
const START_WORDS = 'Box|Drawer|RR|R\\.R|HC|HCR|PSC|CMR|PMB|POB|P\\.O\\.B|Unit|Suite|Ste|Apt|Apartment|Floor|Fl|Bldg|Building|Room|Rm|Tower|Lot|Rural Route|Route|Rte|Rt|' +
  'Urb|Urbanizaci[oó]n|Calle|Ave|Avenida|Carr|Carretera|Cond|Condominio|Edif|Edificio|Bo|Barrio|Apartado|Mile|Pier';
const STARTS_LIKE_AN_ADDRESS = new RegExp(
  `^(?:[A-Z]?\\d|#\\s?\\d|P\\.?\\s?O\\.?\\s?(?:Box|Drawer)\\b|Post Office (?:Box|Drawer)\\b|c/o |(?:${START_WORDS})\\.? |(?:${NUMBER_WORDS}) )`, 'iu');

/**
 * Words that do not count towards the length of an address part: house and unit numbers, and the standard address
 * words and abbreviations. "3000 E Dr Martin Luther King Jr Blvd" is three words of a name; a sentence is not.
 */
const ADDRESS_WORD = /^(?:N|S|E|W|NE|NW|SE|SW|North|South|East|West|St|Street|Ave|Avenue|Blvd|Boulevard|Dr|Drive|Rd|Road|Ln|Lane|Ct|Court|Pl|Place|Hwy|Highway|Pkwy|Parkway|Ste|Suite|Apt|Unit|Fl|Floor|Bldg|Building|Rm|Room|Lot|Box|PO|PMB|Jr|Sr|Mt|Ft)\.?$/i;
/** Most words one part between commas may hold, and the whole address when it was typed without commas. */
const MAX_WORDS_PER_PART = 5;
const MAX_WORDS_WITHOUT_COMMAS = 9;

/** A US phone number, with or without a leading 1, brackets, spaces, dots or dashes; or any run of ten digits or more. */
const PHONE_NUMBER = /(?<!\d)(?:1[ .-]?)?\(?\d{3}\)?[ .-]?\d{3}[ .-]?\d{4}(?!\d)|\d{10,}/;

/** The text as it is checked: typographic quotes and dashes made plain, one trailing full stop or comma dropped. */
function normalise(text: string): string {
  // Spaces and tabs only: a line break stays and is refused below (the address is printed as one line).
  return text.trim().replace(/[’‘]/g, "'").replace(/[–—]/g, '-').replace(/[ \t\u00a0\u2007\u202f]+/g, ' ').replace(/[.,]$/, '').trim();
}

/** Why the text cannot be used as the mailing address, in words for the person typing it, or null when it can. */
export function mailingAddressIssue(text: string | null | undefined): string | null {
  const t = normalise(text ?? '');
  if (!t) return MAILING_ADDRESS_HELP;
  if (t.length < MAILING_ADDRESS_MIN || t.length > MAILING_ADDRESS_MAX) return MAILING_ADDRESS_HELP;
  // "P.O.Box" is a PO box, not a web address.
  if (linkInName(t.replace(/\bP\.\s?O\.\s?(Box|Drawer)\b/gi, 'PO $1'))) return 'A mailing address cannot contain a web address. ' + MAILING_ADDRESS_HELP;
  // Letters, digits, spaces and the punctuation addresses use. No line breaks, no sentence punctuation (! ? : ;), no symbols.
  if (!/^[\p{L}\p{N} ,.#'/&()-]+$/u.test(t)) return MAILING_ADDRESS_HELP;
  // A phone number is the start of a message ("call ..."), never part of a postal address. The ZIP+4 is set aside first.
  if (PHONE_NUMBER.test(t.replace(/\d{5}-\d{4}(?=(?:,?\s+\S+)?$)/, ''))) return 'A mailing address cannot contain a phone number. ' + MAILING_ADDRESS_HELP;
  // The same claims check every lead email is held to when it is sent: a promise here would stop every one of them.
  const claim = findBlockedClaims(t)[0];
  if (claim) return `A mailing address cannot carry a promise or an offer: ${claim.why} (“${claim.excerpt}”) ${MAILING_ADDRESS_HELP}`;
  // A US address starts with a street number or a box and ends with its state and ZIP code. A phrase with five digits
  // somewhere in it, or an address with a message in front of it, is not one.
  // A state code written with full stops ("D.C. 20500", "N.Y. 10001") is read as the code.
  const ending = t.replace(/\b([a-z])\.\s?([a-z])\.?(?=[ ,]+\d{5})/gi, '$1$2');
  if (!STARTS_LIKE_AN_ADDRESS.test(t) || !ENDS_WITH_STATE_AND_ZIP.test(ending)) return MAILING_ADDRESS_HELP;
  // An address is a few short parts, not prose.
  const words = (part: string) => part.trim().split(' ').filter((w) => w && !/\d/.test(w) && !ADDRESS_WORD.test(w)).length;
  const parts = t.split(',');
  if (parts.length === 1 ? words(t) > MAX_WORDS_WITHOUT_COMMAS : parts.some((p) => words(p) > MAX_WORDS_PER_PART)) {
    return 'Each part of the address should be short: the street, then the suite, the city, and the state with the ZIP code, separated by commas. ' + MAILING_ADDRESS_HELP;
  }
  return null;
}

/** The address when it has the shape of one, otherwise the empty string (which every sender treats as "no address"). */
export const usableMailingAddress = (text: string | null | undefined): string => (mailingAddressIssue(text) ? '' : (text ?? '').trim());
