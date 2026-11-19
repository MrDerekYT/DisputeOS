import { BUREAU_LABEL, type Bureau } from '../util';
import type { Evidence } from '../reports/analysis';

/**
 * Deterministic dispute-reason drafting. Everything stated comes from the evidence passed in; the wording asks the
 * recipient to VERIFY, it never asserts the item is wrong and never asks for anything to be taken off the report (the
 * same rule the letter templates follow). A person edits this text before it goes anywhere.
 *
 * A reason is drafted only where a report gives it something to say. Where the reason can only be the client's own
 * account (identity theft, a bankruptcy, a payment, a goodwill request, personal information, a debt a collector is
 * asking about) nothing is drafted: the field starts empty with a prompt, and a person writes what the client told
 * them. A stock sentence in those letters would state a position nobody recorded.
 */
export interface ReasonInput {
  category: string;
  creditor: string;
  last4?: string | null;
  bureau?: Bureau | null;
  evidence?: Evidence[];
  clientNote?: string;
}

/**
 * Categories with no drafted reason, each with what to write instead. Shown as the empty field's prompt on the new
 * dispute form; it is guidance for the person typing and never becomes letter text.
 */
export const REASON_PROMPT: Record<string, string> = {
  identity_theft: 'What the client reports, in their words: that they did not open or authorize this account, and when they found out about it.',
  bankruptcy_included: 'What the client says about this account: that it was part of the bankruptcy, and how it is reported now (for example, a balance still shown).',
  payment_update: 'When the client paid, how much, to whom, and how the account is reported now.',
  goodwill: 'What happened, in the client’s words: which late payment or event, when, and why. Do not say that anything is inaccurate.',
  personal_info: 'Each entry as the report shows it, and whether it is not the client’s or is not correct. Marking the entries under “Personal information on reports” on the client’s Reports tab drafts this for you.',
  unverifiable_collection: 'What the client says about this debt: for example, the amount or the creditor they do not recognize. The letter itself asks for validation.',
};
/** True when a person has to write the reason for this category: nothing on a report can stand in for it. */
export const reasonIsClientsOwn = (category: string) => category in REASON_PROMPT;

const who = (i: ReasonInput) => `${i.creditor}${i.last4 ? ` (account ending ${i.last4})` : ''}`;
const list = (ev: Evidence[] = []) => ev.filter((e) => e.source === 'reported' && e.bureau).map((e) => `${BUREAU_LABEL[e.bureau!]} reports ${e.value}`).join('; ');

/** The drafted reason for a category, or '' when the reason has to be the client's own words (reasonIsClientsOwn). */
export function draftReason(i: ReasonInput): string {
  if (reasonIsClientsOwn(i.category)) return '';
  const ev = i.evidence ?? [];
  const base = ((): string => {
    switch (i.category) {
      case 'incorrect_balance':
        return `The balance reported for ${who(i)} differs between the credit reporting agencies (${list(ev)}). I am asking that the balance be verified with the furnisher and corrected if it is not accurate.`;
      case 'incorrect_status':
        return `The account or payment status reported for ${who(i)} is not consistent across the credit reporting agencies (${list(ev)}). Please verify the status with the furnisher and correct it if needed.`;
      case 'incorrect_dates':
        return `The dates reported for ${who(i)} (${list(ev) || 'see enclosed'}) do not match across the credit reporting agencies. Please verify the dates, including the date of first delinquency, with the furnisher and correct them if needed.`;
      case 'duplicate':
        return `${who(i)} appears to be reported more than once or by more than one company for the same debt (${list(ev) || 'see enclosed'}). Please verify whether these are separate obligations and, if they are the same one, report it once.`;
      case 'obsolete': {
        const d = ev.find((e) => /first delinquency|date filed/i.test(e.field) && e.source === 'reported');
        return `${who(i)} is reported with ${d ? `${d.field.toLowerCase()} of ${d.value}` : 'a date'} that is more than seven years ago. Please verify the date and, if the item is past the permitted reporting period, update my file accordingly.`;
      }
      case 'not_mine':
        return `I do not recognize ${who(i)}. Please provide verification that this account belongs to me, including the name and address of the furnisher and the account opening documents.`;
      case 'unauthorized_inquiry':
        return `I do not recall authorizing the inquiry by ${i.creditor}. Please verify that the inquiry was made with my authorization and for a permissible purpose, and update my file if it cannot be verified.`;
      case 'incorrect_payment_history':
        return `The payment history reported for ${who(i)} does not match my records for the months shown. Please verify each reported late payment with the furnisher, including the dates, and correct any that cannot be verified.`;
      default:
        return `Please verify the information reported for ${who(i)} with the furnisher and correct it if it cannot be verified.`;
    }
  })();
  const note = i.clientNote?.trim();
  return note ? `${base}\n\nAdditional information from me: ${note}` : base;
}
