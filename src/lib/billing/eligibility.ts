/**
 * Charge eligibility: is recording a charge on a given day consistent with the two federal timing rules that apply to
 * every credit repair organization? A pure function over facts already in the client's record. It is a consistency
 * check for staff, not legal advice and not a fee model: what an agency charges, and when, is the agency's decision.
 *
 *  - CROA § 404(b) (15 U.S.C. § 1679b(b)): no credit repair organization "may charge or receive any money or other
 *    valuable consideration for the performance of any service which the credit repair organization has agreed to
 *    perform for any consumer before such service is fully performed".
 *  - CROA § 407(a) (15 U.S.C. § 1679e(a)): the consumer may cancel without penalty or obligation "at any time before
 *    midnight of the 3rd business day which begins after the date on which the contract … is executed".
 *
 * "No hold found" (status 'eligible') needs all three: (a) a signed service agreement whose cancellation period has ended, (b) logged
 * completed work in the period being charged for, and (c) a client who has not cancelled.
 *
 * (b), precisely: at least one letter whose status is "sent", with a sent date inside the period and not after the
 * proposed charge date. A draft, an approved letter that was never sent, a message or a document review does not
 * count. Whether one sent letter is the whole of "the service … fully performed" under the agency's own contract is a
 * question for the agency and its attorney; this check only refuses the cases where no completed work is on record.
 */
import { cancellationEndsOn, holidayTableCovers, HOLIDAYS_THROUGH, sayDay, type Day } from '../business-days';

export type HoldCode = 'no_contract' | 'contract_revoked' | 'cancellation_window' | 'client_cancelled' | 'no_completed_work' | 'sold_by_phone';

export interface ChargeInput {
  /** The proposed charge date. */
  chargeDate: Day;
  /** The period being charged for, both days included. */
  period: { from: Day; to: Day };
  /** The day the service agreement now in force was signed (the latest one that has not been revoked), or null. */
  contractSignedOn: Day | null;
  /** When there is no agreement in force: the day the last one was revoked, if one was. */
  contractRevokedOn?: Day | null;
  /** clients.status */
  clientStatus: string;
  /** The sent date of every letter whose status is "sent" (any period; the check picks the ones that count). */
  lettersSentOn: Day[];
  /** clients.sold_by_phone. Null = nobody has answered how the client was sold. */
  soldByPhone: boolean | null;
}

export interface HoldReason { code: HoldCode; text: string }

export interface ChargeEligibility {
  /**
   * 'eligible' means only that none of the holds below was found in the record. It is not a finding that a charge is
   * lawful, and the UI does not say so.
   */
  status: 'eligible' | 'hold';
  /** Whether the phone-sale rule (16 CFR 310.4(a)(2)) was considered at all: only when staff have answered the question. */
  phoneSale: 'yes' | 'no' | 'not_answered';
  reasons: HoldReason[];
  /** The last day of the cancellation period, when an agreement is in force. */
  cancellationEndsOn: Day | null;
  /** Letters sent in the period, on or before the charge date. */
  workCount: number;
}

/** 16 CFR 310.4(a)(2), as a caution for staff. Deliberately worded as something to review, not as a ruling. */
export const TSR_CAUTION =
  'This client is marked as sold by phone. For credit repair services sold by telemarketing, the Telemarketing Sales Rule (16 CFR 310.4(a)(2)) generally allows a fee to be requested or received only after the period in which the services were to be provided has ended and the client has been given a consumer report, issued more than six months after the results were achieved, that documents them. Review this charge with your attorney before recording it.';

export function chargeEligibility(i: ChargeInput): ChargeEligibility {
  const reasons: HoldReason[] = [];

  // (c) the client has not cancelled
  if (i.clientStatus === 'cancelled') reasons.push({ code: 'client_cancelled', text: 'The client record is marked cancelled.' });

  // (a) signed agreement, cancellation period over. 15 U.S.C. § 1679e(a): the period runs to midnight at the end of
  // the 3rd business day after the signing day, so the first chargeable day is the day after that.
  let ends: Day | null = null;
  if (!i.contractSignedOn) {
    reasons.push(i.contractRevokedOn
      ? { code: 'contract_revoked', text: `The service agreement was revoked on ${sayDay(i.contractRevokedOn)} and no agreement is in force.` }
      : { code: 'no_contract', text: 'No signed service agreement is on record.' });
  } else {
    ends = cancellationEndsOn(i.contractSignedOn);
    if (i.chargeDate <= ends) {
      reasons.push({
        code: 'cancellation_window',
        text: `The service agreement was signed on ${sayDay(i.contractSignedOn)}. The client can cancel through ${sayDay(ends)} (3 business days after signing)${holidayTableCovers(ends) ? '' : `; federal holidays after ${HOLIDAYS_THROUGH} are not counted`}.`,
      });
    }
  }

  // (b) completed work on record for the period: 15 U.S.C. § 1679b(b)
  const workCount = i.lettersSentOn.filter((d) => d >= i.period.from && d <= i.period.to && d <= i.chargeDate).length;
  if (workCount === 0) reasons.push({ code: 'no_completed_work', text: `No letter is recorded as sent between ${sayDay(i.period.from)} and ${sayDay(i.period.to)}${i.chargeDate < i.period.to ? ` (counted through ${sayDay(i.chargeDate)})` : ''}.` });

  if (i.soldByPhone) reasons.push({ code: 'sold_by_phone', text: TSR_CAUTION });
  const phoneSale = i.soldByPhone == null ? 'not_answered' : i.soldByPhone ? 'yes' : 'no';

  return { phoneSale, status: reasons.length === 0 ? 'eligible' : 'hold', reasons, cancellationEndsOn: ends, workCount };
}
