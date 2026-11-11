import type { Permission } from '../rbac';

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

export const OUTCOMES = ['deleted', 'updated', 'verified', 'unresolved', 'no_response'] as const;
export type Outcome = (typeof OUTCOMES)[number];
export const OUTCOME_LABEL: Record<Outcome, string> = { deleted: 'Deleted', updated: 'Updated / corrected', verified: 'Verified as reported', unresolved: 'Unresolved', no_response: 'No response' };

export interface CategoryDef { label: string; workflow: 'standard' | 'furnisher_direct' | 'validation' | 'personal_info' | 'goodwill'; target: 'bureau' | 'furnisher' | 'collector'; hint: string }
export const CATEGORIES: Record<string, CategoryDef> = {
  incorrect_balance: { label: 'Balance may be incorrect', workflow: 'standard', target: 'bureau', hint: 'Compare against a recent statement or payoff letter and attach it.' },
  incorrect_status: { label: 'Account or payment status', workflow: 'standard', target: 'bureau', hint: 'Attach a statement or closure letter that shows the actual status.' },
  incorrect_payment_history: { label: 'Late payment accuracy', workflow: 'standard', target: 'bureau', hint: 'Bank records or statements for the months in question are the strongest evidence.' },
  incorrect_dates: { label: 'Dates (opened / delinquency)', workflow: 'standard', target: 'bureau', hint: 'The date of first delinquency controls how long an item may be reported.' },
  duplicate: { label: 'Possible duplicate reporting', workflow: 'standard', target: 'bureau', hint: 'Identify both entries and explain why they look like the same debt.' },
  obsolete: { label: 'Item may be past the reporting period', workflow: 'standard', target: 'bureau', hint: 'Confirm the date of first delinquency first; cite the reported date.' },
  not_mine: { label: 'Client does not recognise the account', workflow: 'standard', target: 'bureau', hint: 'Record what the client remembers. Do not claim identity theft without an identity theft report.' },
  unauthorized_inquiry: { label: 'Inquiry not recognised', workflow: 'standard', target: 'bureau', hint: 'Confirm with the client that they did not apply for credit with this company.' },
  furnisher_direct: { label: 'Dispute directly with the creditor', workflow: 'furnisher_direct', target: 'furnisher', hint: 'Send to the furnisher’s dispute address, not the bureau.' },
  unverifiable_collection: { label: 'Collection — request validation', workflow: 'validation', target: 'collector', hint: 'Must be sent within 30 days of the collector’s first written notice to use the statutory validation process.' },
  personal_info: { label: 'Personal information', workflow: 'personal_info', target: 'bureau', hint: 'Names, addresses and employers that do not belong to the client.' },
  goodwill: { label: 'Goodwill adjustment request', workflow: 'goodwill', target: 'furnisher', hint: 'This is a courtesy request, not a dispute of accuracy.' },
  other: { label: 'Other', workflow: 'standard', target: 'bureau', hint: 'Explain the specific issue and what you would like verified.' },
};

export const FINDING_TO_CATEGORY: Record<string, string> = {
  balance_mismatch: 'incorrect_balance', status_mismatch: 'incorrect_status', date_mismatch: 'incorrect_dates', dofd_mismatch: 'incorrect_dates',
  duplicate_account: 'duplicate', obsolete_item: 'obsolete', missing_on_bureau: 'other', personal_info: 'personal_info', collection_validation: 'unverifiable_collection',
  old_inquiry: 'unauthorized_inquiry', client_statement: 'not_mine',
};

/**
 * FCRA § 611(a)(1): a bureau has 30 days from RECEIPT of a dispute to investigate (45 if the consumer sends
 * additional relevant information during that window). We count from the received date when known, otherwise the
 * date it was submitted — the UI says so. Other workflow types use 30 days as a follow-up checkpoint.
 */
export function responseDueDate(start: Date, extended = false): Date {
  const d = new Date(start);
  d.setUTCDate(d.getUTCDate() + (extended ? 45 : 30));
  return d;
}

export const daysRemaining = (due: Date | string, now = new Date()) => Math.ceil((new Date(due).getTime() - now.getTime()) / 86_400_000);

export type DeadlineState = 'ok' | 'soon' | 'overdue' | 'none';
export function deadlineState(due: string | null | undefined, now = new Date()): DeadlineState {
  if (!due) return 'none';
  const d = daysRemaining(due, now);
  return d < 0 ? 'overdue' : d <= 5 ? 'soon' : 'ok';
}

export const BUREAU_ADDRESSES: Record<string, { name: string; address: string }> = {
  experian: { name: 'Experian', address: 'P.O. Box 4500, Allen, TX 75013' },
  equifax: { name: 'Equifax Information Services LLC', address: 'P.O. Box 740256, Atlanta, GA 30374' },
  transunion: { name: 'TransUnion Consumer Solutions', address: 'P.O. Box 2000, Chester, PA 19016' },
};

export interface NextStepInput { status: DisputeStatus; round: number; due_at: string | null; outcome: Outcome | null; hasApprovedLetter: boolean; evidenceCount: number }
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
      if (d.outcome === 'verified' || d.outcome === 'unresolved' || d.outcome === 'no_response')
        out.push('Only start another round if you have NEW information or evidence — repeating the same dispute without it can be treated as frivolous. Consider requesting the method of verification.');
      else out.push('Confirm the change on the next report pull and tell the client.');
      break;
    case 'on_hold': out.push('Resume when the blocking issue (e.g. a missing document) is resolved.'); break;
    default: break;
  }
  return out;
}

/** Reporting fields a dispute can ask the recipient to review. */
export const FIELD_OPTIONS = ['Balance', 'Account status', 'Payment history', 'Dates', 'Account ownership', 'Personal information', 'Other'];
