/**
 * Letter templates. ENGLISH ONLY: a letter goes to a US credit bureau, creditor, collector or agency, so it is written
 * in English whatever language the client reads the portal in.
 *
 * Every template has the same shape: the sender's heading, a "Re:" reference line, a short opening that says what is
 * asked and under which right, the account, the variable section (the client's own facts, under a heading), one request
 * paragraph, the enclosure list and the signature. They state the request and nothing more: no threat, no promise or
 * prediction of a result, no demand that anything be deleted, and nothing is called inaccurate unless the sender wrote
 * that in the reason. Not legal advice; a person reviews and edits every letter before a manager approves it.
 *
 * The situations staff choose from, and the facts each one needs, are in ./library.ts. The fields the letter brief
 * fills (./brief.ts: the account as reported, the earlier round, what is enclosed, a collector's notice date, and the
 * two lines of connective wording) are optional in every body: with nothing on file they merge to nothing.
 */
import { AGENCY_KINDS, type AgencyKind } from '../credit/agencies';

export type LetterKind = 'bureau_dispute' | 'creditor_dispute' | 'validation_request' | 'collector_communication' | 'follow_up' | 'investigation_response' | 'personal_info_correction' | 'goodwill' | 'payment_update' | 'specialty_dispute' | 'method_of_verification';

export interface LetterTemplate {
  key: string; kind: LetterKind; language: 'en'; name: string; description: string;
  recipient: 'bureau' | 'furnisher' | 'collector' | 'agency'; body: string;
}

export const KIND_LABEL: Record<LetterKind, string> = {
  bureau_dispute: 'Credit bureau dispute', creditor_dispute: 'Letter to the creditor', validation_request: 'Debt validation request',
  collector_communication: 'Collector communication', follow_up: 'Follow-up on a dispute', investigation_response: 'Response to investigation result',
  personal_info_correction: 'Personal information correction', goodwill: 'Goodwill request', payment_update: 'Request to update a paid account',
  specialty_dispute: 'Specialty agency dispute', method_of_verification: 'Request for the reinvestigation procedure',
};

export const MERGE_FIELDS = ['date', 'client_name', 'client_address', 'ssn_last4_text', 'recipient_name', 'recipient_address', 'item_label', 'creditor', 'account_text', 'bureau', 'reason', 'agency_identity_text', 'agency_item_text', 'fields_text', 'enclosures', 'round_text', 'prior_date', 'dispute_date', 'response_date', 'org_name', 'obsolete_text', 'bankruptcy_text', 'identity_theft_text', 'current_details_text', 'disputed_subject', 'validation_intro', 'validation_cease',
  // Filled from the letter brief (./brief.ts); each is empty when nothing is on file for it.
  'reported_text', 'history_text', 'enclosed_text', 'notice_text', 'lead_in', 'courtesy'] as const;

/**
 * The heading every letter starts with. {{ssn_last4_text}} is the identification under the sender's address: in a
 * letter to one of the three bureaus, the date of birth and the last four digits of the SSN (./render.ts); elsewhere
 * the SSN digits only when the person drafting asked for them.
 */
const HEAD = `{{date}}

{{client_name}}
{{client_address}}
{{ssn_last4_text}}
{{recipient_name}}
{{recipient_address}}
`;
/** The same heading with the identification lines a specialty agency asks for (consumer ID, date of birth, SSN) under the sender's address. */
const SPECIALTY_HEAD = HEAD.replace('{{ssn_last4_text}}', '{{ssn_last4_text}}{{agency_identity_text}}');
const SIGN = `Sincerely,

{{client_name}}`;
/**
 * The end of a letter that lists enclosures: a sentence naming what is enclosed and a closing courtesy line, both from the
 * letter brief and both empty without one, then the enclosure list and the signature.
 */
const CLOSE = `{{enclosed_text}}

{{courtesy}}

{{enclosures}}
${SIGN}`;
const SECTION_611 = 'Section 611 of the Fair Credit Reporting Act (15 U.S.C. § 1681i)';
const RESULTS = 'send me the results in writing, along with an updated copy of my credit report if my file changes';

/**
 * A dispute to a credit bureau about one account. `about` finishes "I am writing under Section 611 … about"; `extra` is
 * a line of recorded facts placed above the reason (it resolves to nothing when the fact is not on file, and the
 * library refuses the letter in that case); `request` finishes "Please conduct a reasonable reinvestigation" (`ask` replaces
 * that paragraph; it still opens "Please conduct", which is where the specificity check ends the reason). The earlier
 * round is stated above the reason heading, so it is never read as part of the reason; `ownHistory` leaves it out for a
 * letter whose opening already states it.
 */
function bureauTemplate(o: { key: string; name: string; description: string; subject: string; about?: string; extra?: string; request?: string; opening?: string; ask?: string; ownHistory?: boolean }): LetterTemplate {
  return {
    key: o.key, kind: 'bureau_dispute', language: 'en', recipient: 'bureau', name: o.name, description: o.description,
    body: `${HEAD}
Re: ${o.subject} — {{item_label}}{{round_text}}

To whom it may concern:

${o.opening ?? `I am writing under ${SECTION_611} about ${o.about}{{lead_in}}`}

Item: {{item_label}}
{{reported_text}}{{fields_text}}${o.extra ? `${o.extra}\n` : ''}
${o.ownHistory ? '' : '{{history_text}}'}
Reason for my request:
{{reason}}

${o.ask ?? `Please conduct a reasonable reinvestigation ${o.request}`}

${CLOSE}`,
  };
}

/**
 * Specialty agency disputes: one template per kind of agency. Each one states only what a person entered (the item as
 * it appears on the disclosure, and their reason), refers to the consumer's right to dispute under the Fair Credit
 * Reporting Act in general terms, and asks for a reinvestigation and a written result. It asks for nothing else: no
 * outcome is requested or implied, and nothing is said about what happens otherwise.
 */
const SPECIALTY_FILE: Record<AgencyKind, { label: string; file: string }> = {
  credit_bureau: { label: 'credit file', file: 'my credit file' },
  bank_account: { label: 'bank account history', file: 'the checking and savings account information in my consumer file' },
  public_records: { label: 'public records', file: 'the public record and background information in my consumer file' },
  telecom_utilities: { label: 'telecom and utilities', file: 'the telecommunications and utility account information in my consumer file' },
  check_verification: { label: 'check verification', file: 'the check writing and payment information in my consumer file' },
  alternative_credit: { label: 'alternative credit', file: 'the loan and account information in my consumer file' },
};

export const specialtyTemplateKey = (kind: AgencyKind) => `specialty_${kind}_en`;

function specialtyTemplate(kind: AgencyKind): LetterTemplate {
  const f = SPECIALTY_FILE[kind];
  return {
    key: specialtyTemplateKey(kind), kind: 'specialty_dispute', language: 'en', recipient: 'agency',
    name: `Specialty agency dispute — ${f.label}`,
    description: 'Asks a specialty consumer reporting agency to reinvestigate one item entered from the consumer’s disclosure.',
    body: `${SPECIALTY_HEAD}
Re: Dispute of information in my file — {{item_label}}{{round_text}}

To whom it may concern:

I am writing to dispute an item in ${f.file}. The Fair Credit Reporting Act gives me the right to dispute information that I believe is inaccurate or incomplete.{{lead_in}}

The item, as it appears on my disclosure:
{{agency_item_text}}
{{history_text}}
What I believe is inaccurate, incomplete or unverifiable, and why:
{{reason}}

Please conduct a reasonable reinvestigation of this item, consider the information I have provided, and send me the results in writing, along with an updated copy of my file if it changes.

${CLOSE}`,
  };
}

export const TEMPLATES: LetterTemplate[] = [
  // ------------------------------------------------------------------ to a credit bureau
  {
    key: 'bureau_dispute_en', kind: 'bureau_dispute', language: 'en', recipient: 'bureau', name: 'Bureau dispute — reinvestigation request (FCRA § 611)',
    description: 'Asks a credit bureau to reinvestigate one item and report the results.',
    body: `${HEAD}
Re: Request for reinvestigation — {{item_label}}{{round_text}}

To whom it may concern:

I am writing under ${SECTION_611} about information in my credit file.{{lead_in}}

Item: {{item_label}}
{{reported_text}}{{fields_text}}
{{history_text}}
Reason for my request:
{{reason}}

Please conduct a reasonable reinvestigation of this item, consider the information I have provided, and ${RESULTS}. If the information is verified, please describe the method of verification used and give me the business name and address of the furnisher you contacted.

${CLOSE}`,
  },
  bureauTemplate({
    key: 'not_my_account_en', name: 'Not my account', description: 'The client does not recognize the account and has not said it is identity theft.',
    subject: 'Dispute of an account I do not recognize', about: 'an account in my credit file that I do not recognize as mine.',
    request: `of whether this account belongs to me, consider the information I have provided, and ${RESULTS}. If the account is verified, please give me the business name and address of the furnisher you contacted.`,
  }),
  bureauTemplate({
    key: 'inaccurate_balance_en', name: 'Inaccurate balance', description: 'The balance or amount shown differs from the client’s statements or records.',
    subject: 'Dispute of a reported balance', about: 'the balance reported for the account below.',
    request: `of the balance reported for this account, consider the information I have provided, and ${RESULTS}.`,
  }),
  bureauTemplate({
    key: 'inaccurate_history_dates_en', name: 'Inaccurate payment history or dates', description: 'A late payment or a reported date does not match the client’s records.',
    // {{disputed_subject}} is "the payment history", "the dates" or both, from what was ticked on the dispute (./render.ts).
    subject: 'Dispute of reported payment history or dates', about: '{{disputed_subject}} reported for the account below.',
    request: `of {{disputed_subject}} reported for this account, consider the information I have provided, and ${RESULTS}.`,
  }),
  bureauTemplate({
    key: 'inaccurate_status_en', name: 'Inaccurate account status', description: 'For example paid but reported unpaid, or closed but reported open.',
    subject: 'Dispute of a reported account status', about: 'the status reported for the account below.',
    request: `of the status reported for this account, consider the information I have provided, and ${RESULTS}.`,
  }),
  bureauTemplate({
    key: 'duplicate_account_en', name: 'Duplicate account', description: 'The same debt appears to be listed twice, or by two companies.',
    subject: 'Dispute of a duplicate entry', about: 'an account that appears to be reported more than once in my credit file.',
    request: `of whether these entries are the same obligation and, if they are, update my file so that it is reported once. Please ${RESULTS}.`,
  }),
  bureauTemplate({
    key: 'outdated_item_en', name: 'Outdated item', description: 'By the reported date of first delinquency, the item appears to be past its reporting period.',
    subject: 'Item that appears to be past the reporting period',
    opening: `I am writing under ${SECTION_611} about an item in my credit file that appears to be past the period in which it may be reported (15 U.S.C. § 1681c).`,
    extra: '{{obsolete_text}}',
    request: `of the date of first delinquency reported for this item and, if its reporting period has ended, update my file accordingly. Please ${RESULTS}.`,
  }),
  bureauTemplate({
    key: 'bankruptcy_included_en', name: 'Account included in bankruptcy', description: 'The client says the account was part of their recorded bankruptcy and it is not reported that way.',
    subject: 'Dispute of an account included in bankruptcy', about: 'how the account below is reported following my bankruptcy.', extra: '{{bankruptcy_text}}',
    request: `of how this account is reported in light of the bankruptcy, consider the information I have provided, and ${RESULTS}.`,
  }),
  bureauTemplate({
    key: 'identity_theft_block_en', name: 'Identity theft block request', description: 'Only with an FTC identity theft report or a police report on file for the client.',
    subject: 'Request to block information resulting from identity theft',
    opening: 'I am a victim of identity theft. Under the Fair Credit Reporting Act (15 U.S.C. § 1681c-2), I ask that you block the reporting of the information identified below. It resulted from the identity theft and does not relate to any transaction that I made or authorized.',
    extra: '{{identity_theft_text}}',
    ask: 'Please conduct a review of this request and the enclosed report, block the information as the statute provides, and send me written confirmation, along with an updated copy of my credit report.',
  }),
  bureauTemplate({
    key: 'redispute_new_information_en', name: 'Re-dispute with new information', description: 'After a “verified” result, and only when the client has information that was not in the earlier dispute.',
    subject: 'Further dispute with new information',
    opening: `On {{prior_date}} I disputed the item below, and your results state that the information was verified. I am writing again under ${SECTION_611} because I now have information that was not part of my earlier dispute. It is set out below.`,
    request: `that takes this new information into account, and ${RESULTS}.`, ownHistory: true,
  }),
  {
    key: 'personal_info_correction_en', kind: 'personal_info_correction', language: 'en', recipient: 'bureau', name: 'Personal information correction',
    description: 'Names, addresses, employers, phone numbers or a date of birth on the report that are wrong or not the client’s.',
    body: `${HEAD}
Re: Request to correct personal information in my file

To whom it may concern:

I am writing about the personal information section of my credit file. I ask that you review the entries described below and update my file so that it shows only identifying information that is mine and is correct.

Reported entries I am asking you to review:
{{reason}}

My correct current details:
{{current_details_text}}

Please conduct a review of these entries and send me written confirmation of the result, along with an updated copy of the personal information reported in my file.

${CLOSE}`,
  },
  {
    key: 'follow_up_en', kind: 'follow_up', language: 'en', recipient: 'bureau', name: 'Follow-up — no response recorded',
    description: 'The reinvestigation period has ended and no response has been recorded.',
    body: `${HEAD}
Re: Status of my dispute dated {{dispute_date}} — {{item_label}}

To whom it may concern:

On {{dispute_date}} I sent you a dispute about the item above. I have no record of receiving the results of your reinvestigation. Please send me a written update on its status and the results, along with an updated copy of my credit report if my file changed.

For reference, my dispute stated:
{{reason}}

${CLOSE}`,
  },

  // ------------------------------------------------------------------ to a debt collector
  {
    key: 'validation_request_en', kind: 'validation_request', language: 'en', recipient: 'collector', name: 'Debt validation request (FDCPA § 809(b))',
    description: 'A collection account, within 30 days of the collector’s first written notice. Later, or with no notice on file, it asks without citing the statute.',
    // {{validation_intro}} and {{validation_cease}} (./render.ts) cite Section 809(b) and state the notice date only when a
    // collector's notice is on file and its 30-day period is open; otherwise they dispute the debt and ask, nothing more.
    body: `${HEAD}
Re: Dispute and request for validation of debt — {{item_label}}

To whom it may concern:

{{validation_intro}}

  1. The amount of the debt and how it was calculated;
  2. The name and address of the original creditor;
  3. A copy of documents showing that I am obligated on the debt and that you are authorized to collect it.

{{reason}}

{{validation_cease}} Please also note this debt as disputed in any information you furnish to a consumer reporting agency.

${CLOSE}`,
  },
  {
    key: 'collector_communication_en', kind: 'collector_communication', language: 'en', recipient: 'collector', name: 'Request to stop communication (FDCPA § 805(c))',
    description: 'The client wants a collector to stop contacting them. It does not make the debt go away; the collector may still sue or report it.',
    body: `${HEAD}
Re: Request to cease communication — {{item_label}}

To whom it may concern:

Under Section 805(c) of the Fair Debt Collection Practices Act (15 U.S.C. § 1692c(c)), I am notifying you in writing that I want you to stop communicating with me about the debt referenced above. You may contact me only as the statute allows, for example to tell me that collection efforts are ending or that you intend to take a specific action.

{{reason}}

{{enclosures}}
${SIGN}`,
  },

  // ------------------------------------------------------------------ to the creditor (furnisher)
  {
    // No statute is cited and no investigation is asked for as of right. The direct-dispute duty of a furnisher "shall not
    // apply if the notice of the dispute is submitted by, is prepared on behalf of the consumer by, or is submitted on a
    // form supplied to the consumer by, a credit repair organization" (15 U.S.C. § 1681s-2(a)(8)(G); 12 CFR 1022.43(b)(2)),
    // and a letter drafted here is prepared by one whoever signs it. So this is a plain request to look at the records.
    key: 'creditor_dispute_en', kind: 'creditor_dispute', language: 'en', recipient: 'furnisher', name: 'Letter to the creditor about what it reports',
    description: 'Asks the company that reports the account to check it against its own records. A creditor is not required to investigate a dispute prepared by a credit repair company (15 U.S.C. § 1681s-2(a)(8)(G)); the dispute with the bureau is the route that carries a duty.',
    body: `${HEAD}
Re: Information you report about my account — {{item_label}}

To whom it may concern:

I am writing about information that your company reports to consumer reporting agencies about the account below. I ask that you check it against your account records.{{lead_in}}

Account: {{item_label}}
{{reported_text}}{{fields_text}}
{{history_text}}
Reason for my request:
{{reason}}

Please review your account records and the information I have provided, and let me know in writing what you find. If your records show that what you report is inaccurate or incomplete, please update it with each consumer reporting agency to which you furnished it.

${CLOSE}`,
  },
  {
    key: 'goodwill_en', kind: 'goodwill', language: 'en', recipient: 'furnisher', name: 'Goodwill adjustment request',
    description: 'The reporting is accurate and the client asks for a courtesy. Not a dispute; no right is asserted.',
    body: `${HEAD}
Re: Goodwill request — {{item_label}}

Dear {{recipient_name}}:

I am writing about the account above. I am not disputing what I describe below; I am asking for your consideration.

{{reason}}

I would be grateful if you would consider a goodwill adjustment to how this is reported. I understand that this is a courtesy and that the decision is yours. Thank you for your time and for considering my request.

${SIGN}`,
  },
  {
    key: 'payment_update_en', kind: 'payment_update', language: 'en', recipient: 'furnisher', name: 'Request to update a paid account',
    description: 'The client has paid the account and asks that the reporting reflect the payment accurately.',
    body: `${HEAD}
Re: Request to update a paid account — {{item_label}}

To whom it may concern:

I am writing about the account above, which I have paid. I ask that you update the information you report to the consumer reporting agencies so that it accurately reflects the payment, including the current balance and status of the account.

Details of the payment:
{{reason}}

Please send me a written response to this request. Thank you for your attention to it.

{{enclosures}}
${SIGN}`,
  },
];

/** Kept out of TEMPLATES: a specialty dispute's letter picks the right one by the agency's kind of file. */
export const SPECIALTY_TEMPLATES: LetterTemplate[] = AGENCY_KINDS.map((k) => specialtyTemplate(k));

/**
 * Request for the description of the reinvestigation procedure ("method of verification"), 15 U.S.C. § 1681i(a)(6)(B)(iii)
 * and (a)(7). Offered only after a result of "verified as reported" is recorded. It asks for the description the statute
 * names and nothing else: it is not a new dispute, it asks for no change to the file, and it says nothing about what
 * happens otherwise. The agency generally has 15 days from receipt.
 */
export const procedureTemplateKey = () => 'method_of_verification_en';
export const PROCEDURE_TEMPLATES: LetterTemplate[] = [
  {
    key: procedureTemplateKey(), kind: 'method_of_verification', language: 'en', recipient: 'bureau', name: 'Request for the reinvestigation procedure — FCRA § 611(a)(7)',
    description: 'Asks the agency to describe the procedure it used to verify an item. A request for information only.',
    body: `${SPECIALTY_HEAD}
Re: Request for a description of your reinvestigation procedure — {{item_label}}

To whom it may concern:

On {{dispute_date}} I sent you a dispute about the item above. Your results, which I received on {{response_date}}, state that the information was verified.

Under Section 611(a)(7) of the Fair Credit Reporting Act (15 U.S.C. § 1681i(a)(7)), I request a description of the procedure used to determine the accuracy and completeness of the information, including the business name and address of any furnisher of information contacted in connection with it and, if reasonably available, the telephone number of that furnisher.

This letter is a request for that description. It is not a new dispute.

${SIGN}`,
  },
];

/**
 * No longer offered (the request for the reinvestigation procedure replaced it), but still resolvable: an agency's own
 * template may have been customised from it.
 */
const LEGACY_TEMPLATES: LetterTemplate[] = [
  {
    key: 'investigation_response_en', kind: 'investigation_response', language: 'en', recipient: 'bureau', name: 'Response to a "verified" result — request method of verification',
    description: 'Use after a result says the item was verified. Include any NEW information or documents.',
    body: `${HEAD}
Re: Your response to my dispute dated {{dispute_date}} — {{item_label}}

To whom it may concern:

I received your response stating that the item above was verified. Under Section 611(a)(7) of the Fair Credit Reporting Act (15 U.S.C. § 1681i(a)(7)), please provide a description of the procedure used to determine the accuracy and completeness of the information, including the business name, address and telephone number of any furnisher you contacted.

{{reason}}

{{enclosures}}
${SIGN}`,
  },
];
export const ALL_TEMPLATES = [...TEMPLATES, ...SPECIALTY_TEMPLATES, ...PROCEDURE_TEMPLATES, ...LEGACY_TEMPLATES];

export const templateByKey = (key: string) => ALL_TEMPLATES.find((t) => t.key === key);
/** The general template of a kind (the first one listed for it). */
export const templatesFor = (kind: LetterKind) => ALL_TEMPLATES.find((t) => t.kind === kind);

const WORKFLOW_TO_KIND: Record<string, LetterKind> = {
  standard: 'bureau_dispute', furnisher_direct: 'creditor_dispute', validation: 'validation_request', personal_info: 'personal_info_correction', goodwill: 'goodwill',
  specialty: 'specialty_dispute',
};
export const kindForWorkflow = (w: string): LetterKind => WORKFLOW_TO_KIND[w] ?? 'bureau_dispute';
