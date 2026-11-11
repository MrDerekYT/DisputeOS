import { BUREAU_LABEL, type Bureau } from '../util';
import type { Evidence } from '../reports/analysis';

/**
 * Deterministic dispute-reason drafting. Everything stated comes from the evidence passed in; the wording asks the
 * recipient to VERIFY, it never asserts the item is wrong. A person edits this text before it goes anywhere.
 */
export interface ReasonInput {
  category: string;
  creditor: string;
  last4?: string | null;
  bureau?: Bureau | null;
  evidence?: Evidence[];
  clientNote?: string;
}

const who = (i: ReasonInput) => `${i.creditor}${i.last4 ? ` (account ending ${i.last4})` : ''}`;
const list = (ev: Evidence[] = []) => ev.filter((e) => e.source === 'reported' && e.bureau).map((e) => `${BUREAU_LABEL[e.bureau!]} reports ${e.value}`).join('; ');

export function draftReason(i: ReasonInput): string {
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
        return `${who(i)} appears to be reported more than once or by more than one company for the same debt (${list(ev) || 'see enclosed'}). Please verify whether these are separate obligations and remove any duplicate reporting.`;
      case 'obsolete': {
        const d = ev.find((e) => /first delinquency|date filed/i.test(e.field) && e.source === 'reported');
        return `${who(i)} is reported with ${d ? `${d.field.toLowerCase()} of ${d.value}` : 'a date'} that is more than seven years ago. Please verify the date and, if the item is past the permitted reporting period, remove it.`;
      }
      case 'not_mine':
        return `I do not recognise ${who(i)}. Please provide verification that this account belongs to me, including the name and address of the furnisher and the account opening documents.`;
      case 'unauthorized_inquiry':
        return `I do not recall authorising the inquiry by ${i.creditor}. Please verify that the inquiry was made with my permissible-purpose authorisation and remove it if it cannot be verified.`;
      case 'personal_info':
        return `Please verify the personal information listed in my file (${list(ev) || 'see enclosed'}) and remove any name, address or employer that cannot be verified as belonging to me.`;
      case 'unverifiable_collection':
        return `I am disputing the debt referenced as ${who(i)} and requesting validation of the amount, the name of the original creditor, and proof that you are authorised to collect it.`;
      case 'incorrect_payment_history':
        return `The payment history reported for ${who(i)} does not match my records for the months shown. Please verify each reported late payment with the furnisher, including the dates, and correct any that cannot be verified.`;
      case 'goodwill':
        return `I am writing to ask for a goodwill adjustment on ${who(i)}. I value my history with you and would appreciate your consideration.`;
      default:
        return `Please verify the information reported for ${who(i)} with the furnisher and correct or remove it if it cannot be verified.`;
    }
  })();
  const note = i.clientNote?.trim();
  return note ? `${base}\n\nAdditional information from me: ${note}` : base;
}
