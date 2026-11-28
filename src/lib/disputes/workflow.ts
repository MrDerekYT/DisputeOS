import type { Permission } from '../rbac';
import { reinvestigationDays } from './clock';
import type { AccountKind } from '../credit/account-kind';

export const DISPUTE_STATUSES = ['draft', 'ready_for_review', 'approved', 'submitted', 'under_investigation', 'response_received', 'resolved', 'on_hold', 'cancelled'] as const;
export type DisputeStatus = (typeof DISPUTE_STATUSES)[number];

/** The main visual pipeline, in order. `on_hold` and `cancelled` sit outside it. */
export const PIPELINE: DisputeStatus[] = ['draft', 'ready_for_review', 'approved', 'submitted', 'under_investigation', 'response_received', 'resolved'];

export const STATUS_LABEL: Record<DisputeStatus, string> = {
  draft: 'Draft', ready_for_review: 'Ready for review', approved: 'Approved', submitted: 'Submitted', under_investigation: 'Under investigation',
  response_received: 'Response received', resolved: 'Resolved', on_hold: 'On hold', cancelled: 'Cancelled',
};

export const TRANSITIONS: Record<DisputeStatus, DisputeStatus[]> = {
  draft: ['ready_for_review', 'cancelled'],
  ready_for_review: ['approved', 'draft', 'cancelled'],
  approved: ['submitted', 'draft', 'cancelled'],
  submitted: ['under_investigation', 'response_received', 'on_hold', 'cancelled'],
  under_investigation: ['response_received', 'on_hold', 'cancelled'],
  response_received: ['resolved', 'under_investigation', 'on_hold'],
  resolved: [],
  on_hold: ['submitted', 'under_investigation', 'draft', 'cancelled'],
  cancelled: ['draft'],
};

export const canTransition = (from: DisputeStatus, to: DisputeStatus) => TRANSITIONS[from]?.includes(to) ?? false;

/** Approving is a manager-level decision; everything else is ordinary case work. */
export const permissionFor = (to: DisputeStatus): Permission => (to === 'approved' ? 'disputes:approve' : 'disputes:write');

/** 'frivolous' = the agency sent notice that it will not investigate without more information (15 U.S.C. § 1681i(a)(3)); recorded with recordFrivolousNotice. */
export const OUTCOMES = ['deleted', 'updated', 'verified', 'unresolved', 'no_response', 'frivolous'] as const;
export type Outcome = (typeof OUTCOMES)[number];
export const OUTCOME_LABEL: Record<Outcome, string> = { deleted: 'Deleted', updated: 'Updated / corrected', verified: 'Verified as reported', unresolved: 'Unresolved', no_response: 'No response', frivolous: 'More information requested' };

export interface CategoryDef { label: string; workflow: 'standard' | 'furnisher_direct' | 'validation' | 'personal_info' | 'goodwill' | 'specialty'; target: 'bureau' | 'furnisher' | 'collector' | 'agency'; hint: string }
export const CATEGORIES: Record<string, CategoryDef> = {
  incorrect_balance: { label: 'Balance may be incorrect', workflow: 'standard', target: 'bureau', hint: 'Compare against a recent statement or payoff letter and attach it.' },
  incorrect_status: { label: 'Account or payment status', workflow: 'standard', target: 'bureau', hint: 'Attach a statement or closure letter that shows the actual status.' },
  incorrect_payment_history: { label: 'Late payment accuracy', workflow: 'standard', target: 'bureau', hint: 'Bank records or statements for the months in question are the strongest evidence.' },
  incorrect_dates: { label: 'Dates (opened / delinquency)', workflow: 'standard', target: 'bureau', hint: 'The date of first delinquency controls how long an item may be reported.' },
  duplicate: { label: 'Possible duplicate reporting', workflow: 'standard', target: 'bureau', hint: 'Identify both entries and explain why they look like the same debt.' },
  obsolete: { label: 'Item may be past the reporting period', workflow: 'standard', target: 'bureau', hint: 'Confirm the date of first delinquency first; cite the reported date.' },
  not_mine: { label: 'Client does not recognize the account', workflow: 'standard', target: 'bureau', hint: 'Record what the client remembers. Do not claim identity theft without an identity theft report.' },
  bankruptcy_included: { label: 'Account included in bankruptcy', workflow: 'standard', target: 'bureau', hint: 'Record the bankruptcy under “Collections and bankruptcy” first. State what the client says about this account.' },
  identity_theft: { label: 'Identity theft — block request', workflow: 'standard', target: 'bureau', hint: 'Only with the client’s FTC identity theft report or police report, and a copy of their photo ID, accepted in their documents.' },
  unauthorized_inquiry: { label: 'Inquiry not recognized', workflow: 'standard', target: 'bureau', hint: 'Confirm with the client that they did not apply for credit with this company.' },
  furnisher_direct: { label: 'Ask the creditor to check what it reports', workflow: 'furnisher_direct', target: 'furnisher', hint: 'Goes to the creditor’s address for disputes. A creditor is not required to investigate a dispute prepared by a credit repair company (15 U.S.C. § 1681s-2(a)(8)(G)): the dispute with the bureau is the route that carries a duty, and the client may also write on their own.' },
  unverifiable_collection: { label: 'Collection — request validation', workflow: 'validation', target: 'collector', hint: 'The statutory validation process covers a request sent within 30 days of the collector’s first written notice. Record that notice under “Collections and bankruptcy” so the letter can say so.' },
  personal_info: { label: 'Personal information', workflow: 'personal_info', target: 'bureau', hint: 'Names, addresses and employers that do not belong to the client.' },
  goodwill: { label: 'Goodwill adjustment request', workflow: 'goodwill', target: 'furnisher', hint: 'This is a courtesy request, not a dispute of accuracy.' },
  payment_update: { label: 'Paid account — request to update', workflow: 'goodwill', target: 'furnisher', hint: 'A request that the reporting reflect the payment accurately. State when and how much was paid.' },
  other: { label: 'Other', workflow: 'standard', target: 'bureau', hint: 'Explain the specific issue and what you would like verified.' },
  // An item on a specialty agency's disclosure (ChexSystems, LexisNexis, ...), entered by hand. Created with createSpecialtyDispute, never from a report finding.
  specialty_item: { label: 'Specialty agency item', workflow: 'specialty', target: 'agency', hint: 'State what is inaccurate, incomplete or unverifiable, using only what the disclosure and the client’s records show.' },
};
/** The category every specialty agency dispute uses. */
export const SPECIALTY_CATEGORY = 'specialty_item';

export const FINDING_TO_CATEGORY: Record<string, string> = {
  balance_mismatch: 'incorrect_balance', status_mismatch: 'incorrect_status', date_mismatch: 'incorrect_dates', dofd_mismatch: 'incorrect_dates',
  duplicate_account: 'duplicate', obsolete_item: 'obsolete', missing_on_bureau: 'other', personal_info: 'personal_info', collection_validation: 'unverifiable_collection', negative_item: 'incorrect_payment_history',
  old_inquiry: 'unauthorized_inquiry', client_statement: 'not_mine',
  // One entry that is reported as paid, sold or transferred and still shows a balance: a request to verify the status, with both values.
  status_balance_conflict: 'incorrect_status',
  // Still reported after the removal month the bureau itself prints: a neutral "please verify" that a person completes.
  removal_month_passed: 'other',
  // Case tools: the two report checks start as a neutral "please verify" to the bureau; a collector notice starts a validation request to the collector.
  medical_collection: 'other', bankruptcy_reporting: 'other', collector_notice: 'unverifiable_collection',
};

/**
 * The type of dispute the new dispute form suggests for an account, from its confirmed label (the report's words or a
 * person's: src/lib/credit/account-kind.ts confirmedLabel; an AI suggestion suggests nothing). Only an account that
 * carries something negative gets one, and it is a starting point a person changes freely. A validation request is
 * for a collector's account only (`collector`): a creditor's own account in collection gets a status dispute. It is
 * never "not mine" or identity theft: only the client can say that.
 */
export function categoryForAccount(kind: AccountKind, collector: boolean): string | undefined {
  if (kind === 'collection') return collector ? 'unverifiable_collection' : 'incorrect_status';
  if (kind === 'bankruptcy') return 'bankruptcy_included';
  if (kind === 'late' || kind === 'was_late') return 'incorrect_payment_history';
  if (kind === 'charge_off' || kind === 'foreclosure' || kind === 'repossession' || kind === 'settled' || kind === 'negative') return 'incorrect_status';
  return undefined;
}

/**
 * The dispute category a finding starts as. A "client statement" finding records one of two different things the
 * client said, told apart by its key (src/lib/reports/analysis.ts): "I do not recognize this account" is a not-mine
 * dispute, and "my payments were never late" is a dispute of the payment history, never of whose account it is.
 */
export function categoryForFinding(f: { category: string; dedupe_key?: string | null }): string | undefined {
  if (f.category === 'client_statement' && f.dedupe_key?.startsWith('client-never-late:')) return 'incorrect_payment_history';
  return FINDING_TO_CATEGORY[f.category];
}

/**
 * FCRA § 611(a)(1): a bureau has 30 days from RECEIPT of a dispute to investigate (45 if the consumer sends
 * additional relevant information during that window). We count from the received date when known, otherwise the
 * date it was submitted — the UI says so. Other workflow types use 30 days as a follow-up checkpoint.
 * The day counts, and every other deadline on a dispute, live in ./clock.ts.
 */
export function responseDueDate(start: Date, extended = false): Date {
  const d = new Date(start);
  d.setUTCDate(d.getUTCDate() + reinvestigationDays(extended));
  return d;
}

export const daysRemaining = (due: Date | string, now = new Date()) => Math.ceil((new Date(due).getTime() - now.getTime()) / 86_400_000);

export type DeadlineState = 'ok' | 'soon' | 'overdue' | 'none';
export function deadlineState(due: string | null | undefined, now = new Date()): DeadlineState {
  if (!due) return 'none';
  // Overdue the moment the deadline passes — the same test the overdue counts and filters use (due_at < now).
  if (new Date(due).getTime() < now.getTime()) return 'overdue';
  return daysRemaining(due, now) <= DUE_SOON_DAYS ? 'soon' : 'ok';
}
/** One "due soon" window for every count, filter and badge. */
export const DUE_SOON_DAYS = 7;
/** Whole days past the deadline, never less than 1 once it has passed. */
export const daysOverdue = (due: Date | string, now = new Date()) => Math.max(1, Math.ceil((now.getTime() - new Date(due).getTime()) / 86_400_000));

export const BUREAU_ADDRESSES: Record<string, { name: string; address: string }> = {
  experian: { name: 'Experian', address: 'P.O. Box 4500, Allen, TX 75013' },
  equifax: { name: 'Equifax Information Services LLC', address: 'P.O. Box 740256, Atlanta, GA 30374' },
  transunion: { name: 'TransUnion Consumer Solutions', address: 'P.O. Box 2000, Chester, PA 19016' },
};

export interface NextStepInput { status: DisputeStatus; round: number; due_at: string | null; outcome: Outcome | null; hasApprovedLetter: boolean; evidenceCount: number; confirmedAccurate?: boolean }
/** Plain, rule-based suggestions. They advise; they never act. */
export function nextSteps(d: NextStepInput, now = new Date()): string[] {
  const out: string[] = [];
  switch (d.status) {
    case 'draft': out.push(d.evidenceCount ? 'Finish the reason, then mark ready for review.' : 'Add supporting evidence (statements, letters) if the client has any, then mark ready for review.'); break;
    case 'ready_for_review': out.push('A manager reviews the reason and letter, then approves.'); break;
    case 'approved': out.push(d.hasApprovedLetter ? 'Mail the approved letter (certified, with return receipt) and record the submission.' : 'Create and approve a letter before submitting.'); break;
    case 'submitted': case 'under_investigation': {
      const s = deadlineState(d.due_at, now);
      if (s === 'overdue') out.push('The response window has passed. Send a follow-up letter and note the date; talk to counsel before relying on any legal consequence of the delay.');
      else if (s === 'soon') out.push(`Response due in ${daysRemaining(d.due_at!, now)} day(s). Prepare a follow-up.`);
      else out.push('Wait for the response. A reminder task is created as the deadline approaches.');
      break;
    }
    case 'response_received': out.push('Read the response, record the outcome, and update the client.'); break;
    case 'resolved':
      // 15 U.S.C. § 1679b(a)(1): nothing may be offered that would have the client dispute information they say is accurate.
      if (d.confirmedAccurate) out.push('The client confirmed this item is reported accurately. No further letter or round is offered for it.');
      else if (d.outcome === 'verified' || d.outcome === 'unresolved' || d.outcome === 'no_response')
        out.push('Only start another round if you have NEW information or evidence — repeating the same dispute without it can be treated as frivolous. Consider requesting the method of verification.');
      else if (d.outcome === 'frivolous') out.push('The agency asked for more information. When the client has provided it, start another round that includes it.');
      else out.push('Confirm the change on the next report pull and tell the client.');
      break;
    case 'on_hold': out.push('Resume when the blocking issue (e.g. a missing document) is resolved.'); break;
    default: break;
  }
  return out;
}

/**
 * True when the new dispute form has to be given the account's name: a dispute with a bureau about an account that is
 * on no imported report. Without a name the letter could only call it “Item”. Personal information is not an account.
 */
export const mustNameAccount = (category: string, hasReportAccount: boolean): boolean =>
  !hasReportAccount && CATEGORIES[category]?.target === 'bureau' && category !== 'personal_info';

/**
 * The label the new dispute form gives an item that is on no imported report: the company the account is with, and the
 * last digits when typed; “Personal information” for a personal information dispute. Undefined for an account on a
 * report (createDispute labels it from the report row) and when nothing was typed that names the item.
 */
export function typedItemLabel(x: { category: string; hasReportAccount: boolean; accountName?: string; accountLast4?: string; recipientName?: string }): string | undefined {
  if (x.hasReportAccount) return undefined;
  // Typed for a bureau dispute; for a letter to a creditor or collector it is the company the letter goes to.
  const accountWith = x.accountName || (CATEGORIES[x.category]?.target !== 'bureau' ? x.recipientName : undefined);
  if (accountWith && (x.accountName || x.accountLast4)) return `${accountWith}${x.accountLast4 ? ` ••${x.accountLast4}` : ''}`;
  return x.category === 'personal_info' ? 'Personal information' : undefined;
}

/** Reporting fields a dispute can ask the recipient to review. */
export const FIELD_OPTIONS = ['Balance', 'Account status', 'Payment history', 'Dates', 'Account ownership', 'Personal information', 'Other'];
