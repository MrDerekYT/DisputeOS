import { BUREAU_LABEL, money, type Bureau } from '../util';
import { longDate } from '../letters/render';
import type { Evidence } from '../reports/analysis';

/**
 * Deterministic dispute-reason drafting. Everything stated comes from the evidence passed in; the wording asks the
 * recipient to VERIFY, it never asserts the item is wrong and never asks for anything to be taken off the report (the
 * same rule the letter templates follow). A person edits this text before it goes anywhere.
 *
 * A reason is drafted only where a report gives it something to say. Where the reason can only be the client's own
 * account (identity theft, a bankruptcy, a payment, a goodwill request, personal information, a debt a collector is
 * asking about, a late payment the client says was on time, an inquiry the client does not recognize) nothing is
 * drafted: the field starts empty with a prompt, and a person writes what the client told them. A stock sentence in
 * those letters would state a position nobody recorded: a finding that an inquiry is more than two years old, for
 * one, says nothing about whether the client authorized it.
 *
 * A drafted reason states report values only where the reports show something to point at: two bureaus that differ,
 * entries that look like one debt, the reported date an outdated-item letter rests on. One reported value with nothing
 * to compare it with is not restated (the letter itself prints the account as the report shows it). What is drafted
 * then is a bare request to verify, worded so that the specificity check (src/lib/letters/specificity.ts) holds the
 * letter until a person adds what the client's own records show.
 */
export interface ReasonInput {
  category: string;
  /** The company the account is with, as the report shows it. Empty for an account a person is about to name on the form. */
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
  incorrect_payment_history: 'Which late payment the client disputes (the month and year the report shows it), and what the client’s own records show for that month: for example, the date the payment cleared.',
  unauthorized_inquiry: 'What the client says about this inquiry: for example, that they did not apply for credit with this company. Give the inquiry’s date as the report shows it; the letter needs it to say which inquiry is meant.',
};
/** True when a person has to write the reason for this category: nothing on a report can stand in for it. */
export const reasonIsClientsOwn = (category: string) => category in REASON_PROMPT;

const named = (i: ReasonInput) => i.creditor.trim() !== '';
/** The account as a sentence names it. With no name on hand it is "this account": a person names it on the form. */
const who = (i: ReasonInput) => (named(i) ? `${i.creditor.trim()}${i.last4 ? ` (account ending ${i.last4})` : ''}` : 'this account');
/** What the bureaus report, from the evidence. The same value from the same bureau is counted once. */
const reported = (ev: Evidence[] = []) => ev.filter((e, n) => e.source === 'reported' && e.bureau
  && ev.findIndex((o) => o.source === 'reported' && o.bureau === e.bureau && o.field === e.field && o.value === e.value) === n);
const lowerFirst = (s: string) => `${s.charAt(0).toLowerCase()}${s.slice(1)}`;
/**
 * "Experian reports $640.00; Equifax reports $600.00". When the values are of more than one kind (or `withField` is
 * set) each one is named, so a list never reads as if a creditor's name were a date or a balance:
 * "Experian reports collector balance $980.00; Experian reports original creditor named ACME BANK".
 */
const list = (ev: Evidence[] = [], withField = false) => {
  const r = reported(ev);
  const name = withField || new Set(r.map((e) => e.field)).size > 1;
  return r.map((e) => `${BUREAU_LABEL[e.bureau!]} reports ${name ? `${lowerFirst(e.field)} ` : ''}${e.value}`).join('; ');
};
/**
 * True when two DIFFERENT bureaus in the evidence report different values of the same thing: only then does a reason
 * say that the agencies differ. Two values from one bureau (an older and a newer report, or two entries) are not such
 * a difference, and nor are two values of different kinds.
 */
const differs = (ev: Evidence[] = []) => {
  const r = reported(ev);
  const value = (e: Evidence) => e.value.trim().toLowerCase();
  return r.some((a) => r.some((b) => a.bureau !== b.bureau && a.field === b.field && value(a) !== value(b)));
};
/** True when the evidence holds more than one distinct reported value: there is something to set side by side. */
const several = (ev: Evidence[] = []) => new Set(reported(ev).map((e) => `${e.field}|${e.value.trim().toLowerCase()}`)).size > 1;

/** The drafted reason for a category, or '' when the reason has to be the client's own words (reasonIsClientsOwn). */
export function draftReason(i: ReasonInput): string {
  if (reasonIsClientsOwn(i.category)) return '';
  const ev = i.evidence ?? [];
  const base = ((): string => {
    switch (i.category) {
      case 'incorrect_balance':
        // A difference between two bureaus is stated, with both figures. A single reported figure is not restated: it
        // says nothing about why the balance is in question, and the letter prints the balance as the report shows it.
        // What is left is a request to verify, which the specificity check holds until a person adds to it.
        if (differs(ev)) return `The balance reported for ${who(i)} differs between the credit reporting agencies (${list(ev)}). Please verify the balance with the furnisher and correct it if it is not accurate or cannot be verified.`;
        return `Please verify the balance reported for ${who(i)} with the furnisher and correct it if it is not accurate or cannot be verified.`;
      case 'incorrect_status':
        if (differs(ev)) return `The account or payment status reported for ${who(i)} is not consistent across the credit reporting agencies (${list(ev)}). Please verify the status with the furnisher and correct it if needed.`;
        return `Please verify the account and payment status reported for ${who(i)}${several(ev) ? ` (${list(ev)})` : ''} with the furnisher and correct it if needed.`;
      case 'incorrect_dates':
        // Values are listed when there are several to set side by side (for example a collection's date of first
        // delinquency and the original creditor's, on one bureau's report); a single reported date is not restated.
        if (differs(ev)) return `The dates reported for ${who(i)} (${list(ev)}) do not match across the credit reporting agencies. Please verify the dates, including the date of first delinquency, with the furnisher and correct them if needed.`;
        return `Please verify the dates reported for ${who(i)}${several(ev) ? ` (${list(ev)})` : ''}, including the date of first delinquency, with the furnisher and correct them if needed.`;
      case 'duplicate':
        // With the entries a report shows, they are listed. Without them it is a bare request to verify: which entries
        // look like the same debt, and why, is for a person to add.
        if (reported(ev).length) return `${named(i) ? who(i) : 'This account'} appears to be reported more than once or by more than one company for the same debt (${list(ev, true)}). Please verify whether these are separate obligations and, if they are the same one, report it once.`;
        return `Please verify whether ${who(i)} is reported more than once, or by more than one company for the same debt, and if it is, report it once.`;
      case 'obsolete': {
        // The reported date is stated as it is. Whether a reporting period has ended, and for what (the whole item, or
        // only the late payment information of an account that is only late), is worked out by the letter itself from
        // the same date, and the letter makes the request, so the reason says neither.
        const d = ev.find((e) => /first delinquency|date filed/i.test(e.field) && e.source === 'reported');
        if (d) return `My ${d.bureau ? `${BUREAU_LABEL[d.bureau]} ` : ''}credit report shows a ${d.field.toLowerCase()} of ${d.value} for ${who(i)}. Please verify that date with the furnisher.`;
        return `Please verify the date of first delinquency reported for ${who(i)} and, if the item is past the reporting period, update my file accordingly.`;
      }
      case 'not_mine':
        return `I do not recognize ${who(i)}. Please provide verification that ${named(i) ? 'this account' : 'it'} belongs to me, including the name and address of the furnisher and the account opening documents.`;
      default:
        return `Please verify the information reported for ${who(i)} with the furnisher and correct it if it cannot be verified.`;
    }
  })();
  const note = i.clientNote?.trim();
  return note ? `${base}\n\nAdditional information from me: ${note}` : base;
}

/** One account as one approved report shows it: what the new dispute form reads for the accounts it offers. */
export interface ReportedRow {
  id: string; bureau: Bureau; creditor_name: string; account_last4: string | null;
  balance_cents: number | string | null; date_opened: string | null; date_of_first_delinquency: string | null;
  /** True when the row is on the newest approved report of its bureau (the rule the comparison uses: reports/service.ts loadAnalysisInput). */
  newest: boolean;
}

const sayDay = (day: string) => longDate(new Date(`${day}T00:00:00Z`));

/**
 * The values the approved reports show for one account, for the reason of a dispute started from the account itself
 * (not from a finding). One value per bureau, never two from the same one: the chosen row speaks for its own bureau,
 * and each other bureau is represented by the same account (creditor name and last four digits) on that bureau's
 * newest approved report. An older report of a bureau is never compared with anything: a row chosen from one stands
 * alone, so no difference between agencies is drafted from it.
 */
export function reportedFor(category: string, tl: ReportedRow | undefined, all: ReportedRow[]): Evidence[] {
  if (!tl) return [];
  const others = tl.newest && tl.account_last4
    ? all.filter((t) => t.newest && t.bureau !== tl.bureau && t.creditor_name === tl.creditor_name && t.account_last4 === tl.account_last4)
    : [];
  const same = [tl, ...others.filter((t, n) => others.findIndex((o) => o.bureau === t.bureau) === n)];
  const of = (field: string, value: (t: ReportedRow) => string | null, from: ReportedRow[] = same): Evidence[] =>
    from.flatMap((t) => { const v = value(t); return v ? [{ bureau: t.bureau, field, value: v, source: 'reported' as const, tradeline_id: t.id }] : []; });
  switch (category) {
    case 'incorrect_balance': return of('Balance', (t) => (t.balance_cents == null ? null : money(Number(t.balance_cents))));
    case 'incorrect_dates': return of('Date opened', (t) => (t.date_opened ? sayDay(t.date_opened) : null));
    case 'obsolete': return of('Date of first delinquency', (t) => (t.date_of_first_delinquency ? sayDay(t.date_of_first_delinquency) : null), [tl]);
    default: return [];
  }
}
