/**
 * Wording the Credit Repair Organizations Act prescribes, word for word. Pure: no database, no environment.
 *
 * Source: the U.S. Code as published by the Legal Information Institute (from the Office of the Law Revision Counsel),
 * read on 2026-11-20: https://www.law.cornell.edu/uscode/text/15/1679c, /1679d and /1679e. Copies of those pages are
 * kept in tests/fixtures/statutes/, and tests/unit/intake-agreements.test.ts compares every string below with them, so
 * a change here that strays from the statute fails the tests.
 *
 * The U.S. Code prints a quoted statement of several paragraphs with an opening quotation mark at the start of each
 * paragraph and a closing mark (followed by the Code's own full stop) at the very end. Those marks belong to the Code's
 * quoting, not to the statement, so they are left out here and nothing else is changed.
 *
 * NOT LEGAL ADVICE. Several states add their own rules (registration, a bond, a longer cancellation period, specific
 * contract wording). The agency's attorney confirms what applies to it.
 */

/** 15 U.S.C. § 1679c(a): the heading of the statement a credit repair organization gives before any contract. */
export const CROA_STATEMENT_TITLE = 'Consumer Credit File Rights Under State and Federal Law';

/** 15 U.S.C. § 1679c(a): the statement, one entry per paragraph of the statute (the last three are the FTC's address). */
export const CROA_STATEMENT: readonly string[] = [
  "You have a right to dispute inaccurate information in your credit report by contacting the credit bureau directly. However, neither you nor any 'credit repair' company or credit repair organization has the right to have accurate, current, and verifiable information removed from your credit report. The credit bureau must remove accurate, negative information from your report only if it is over 7 years old. Bankruptcy information can be reported for 10 years.",
  'You have a right to obtain a copy of your credit report from a credit bureau. You may be charged a reasonable fee. There is no fee, however, if you have been turned down for credit, employment, insurance, or a rental dwelling because of information in your credit report within the preceding 60 days. The credit bureau must provide someone to help you interpret the information in your credit file. You are entitled to receive a free copy of your credit report if you are unemployed and intend to apply for employment in the next 60 days, if you are a recipient of public welfare assistance, or if you have reason to believe that there is inaccurate information in your credit report due to fraud.',
  'You have a right to sue a credit repair organization that violates the Credit Repair Organization Act. This law prohibits deceptive practices by credit repair organizations.',
  'You have the right to cancel your contract with any credit repair organization for any reason within 3 business days from the date you signed it.',
  'Credit bureaus are required to follow reasonable procedures to ensure that the information they report is accurate. However, mistakes may occur.',
  'You may, on your own, notify a credit bureau in writing that you dispute the accuracy of information in your credit file. The credit bureau must then reinvestigate and modify or remove inaccurate or incomplete information. The credit bureau may not charge any fee for this service. Any pertinent information and copies of all documents you have concerning an error should be given to the credit bureau.',
  "If the credit bureau's reinvestigation does not resolve the dispute to your satisfaction, you may send a brief statement to the credit bureau, to be kept in your file, explaining why you think the record is inaccurate. The credit bureau must include a summary of your statement about disputed information with any report it issues about you.",
  'The Federal Trade Commission regulates credit bureaus and credit repair organizations. For more information contact:',
  'The Public Reference Branch',
  'Federal Trade Commission',
  'Washington, D.C. 20580',
];

/** How many of the entries above are the address block at the end (printed as lines of one paragraph). */
export const CROA_STATEMENT_ADDRESS_LINES = 3;

/**
 * 15 U.S.C. § 1679d(b)(4): the statement every contract carries "in bold face type, in immediate proximity to the
 * space reserved for the consumer's signature".
 */
export const CROA_CANCEL_STATEMENT = 'You may cancel this contract without penalty or obligation at any time before midnight of the 3rd business day after the date on which you signed the contract. See the attached notice of cancellation form for an explanation of this right.';

/** 15 U.S.C. § 1679e(b): the heading of the cancellation form that accompanies each contract, in duplicate. */
export const NOTICE_HEADING = 'Notice of Cancellation';

/** The blanks of the § 1679e(b) form, exactly as the statute writes them. */
export const NOTICE_BLANK = {
  name: '[ name of credit repair organization ]',
  address: '[ address of credit repair organization ]',
  date: '[ date ]',
  purchaserDate: '[ date ]',
  signature: "[ purchaser's signature ].",
} as const;

/**
 * 15 U.S.C. § 1679e(b): the statement of the form, one entry per line of the statute, with its blanks unfilled. The
 * last two lines are the consumer's own: the date and their signature when they cancel.
 */
export const NOTICE_TEMPLATE: readonly string[] = [
  'You may cancel this contract, without any penalty or obligation, at any time before midnight of the 3rd day which begins after the date the contract is signed by you.',
  `To cancel this contract, mail or deliver a signed, dated copy of this cancellation notice, or any other written notice to ${NOTICE_BLANK.name} at ${NOTICE_BLANK.address} before midnight on ${NOTICE_BLANK.date}`,
  'I hereby cancel this transaction,',
  NOTICE_BLANK.purchaserDate,
  NOTICE_BLANK.signature,
];

/**
 * The form as the agency hands it over: its name, its address and the last day of the period filled in, as § 1679e(b)
 * requires. The consumer's two blanks stay blank, printed as labelled lines to write on, the way a paper form has them.
 */
export function noticeOfCancellation(f: { name: string; address: string; date: string }): string[] {
  const [first, second, third] = NOTICE_TEMPLATE as [string, string, string];
  return [
    first,
    second.replace(NOTICE_BLANK.name, f.name).replace(NOTICE_BLANK.address, f.address).replace(NOTICE_BLANK.date, f.date),
    third,
    `Date: ${BLANK_LINE}`,
    `Purchaser's signature: ${BLANK_LINE}`,
  ];
}
export const BLANK_LINE = '______________________________';

/** "December 3, 2026": how a date is written in the agreements (a calendar day, not an instant). */
export const longDay = (day: string): string =>
  new Date(`${day}T00:00:00Z`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
