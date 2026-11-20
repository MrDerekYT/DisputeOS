/**
 * The agency's postal address as it is printed in every automatic email (lead follow-up and partner emails). Pure.
 *
 * Commercial email has to show a valid physical postal address of the sender (CAN-SPAM, 15 U.S.C. § 7704(a)(5)), and
 * this line is the one part of those emails an agency types freely. So it is held to the shape of an address: it
 * cannot carry a sentence, a link or a message of its own. This cannot prove the address is real; it only stops the
 * field from being used for anything else. Used when the address is saved and again when it is read, so a value saved
 * before this rule existed stops the emails until it is corrected.
 */
import { linkInName } from './lead-texts';

export const MAILING_ADDRESS_MIN = 12;
export const MAILING_ADDRESS_MAX = 160;

export const MAILING_ADDRESS_HELP =
  'Enter the postal address your business receives mail at, with its ZIP code, for example "500 Bayshore Blvd, Suite 210, Tampa, FL 33606". It is printed in every automatic email.';

/** Why the text cannot be used as the mailing address, in words for the person typing it, or null when it can. */
export function mailingAddressIssue(text: string | null | undefined): string | null {
  const t = (text ?? '').trim();
  if (!t) return MAILING_ADDRESS_HELP;
  if (t.length < MAILING_ADDRESS_MIN || t.length > MAILING_ADDRESS_MAX) return MAILING_ADDRESS_HELP;
  if (linkInName(t)) return 'A mailing address cannot contain a web address. ' + MAILING_ADDRESS_HELP;
  // Letters, digits, spaces and the punctuation addresses use. No line breaks, no sentence punctuation (! ? : ;), no symbols.
  if (!/^[\p{L}\p{N} ,.#'/&-]+$/u.test(t)) return MAILING_ADDRESS_HELP;
  // A US address has a ZIP code: five digits together.
  if (!/(?<!\d)\d{5}(?:-\d{4})?(?!\d)/.test(t)) return MAILING_ADDRESS_HELP;
  // An address is a few short parts, not prose: no part between commas runs to more than six words.
  if (t.split(',').some((part) => part.trim().split(/\s+/).length > 6)) return MAILING_ADDRESS_HELP;
  return null;
}

/** The address when it has the shape of one, otherwise the empty string (which every sender treats as "no address"). */
export const usableMailingAddress = (text: string | null | undefined): string => (mailingAddressIssue(text) ? '' : (text ?? '').trim());
