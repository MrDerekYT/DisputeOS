import { describe, expect, it } from 'vitest';
import { chargeEligibility, TSR_CAUTION, type ChargeInput } from '@/lib/billing/eligibility';
import { addBusinessDays, cancellationEndsOn, FEDERAL_HOLIDAYS, isBusinessDay, isMonth, monthRange, monthsBack } from '@/lib/business-days';
import * as clock from '@/lib/disputes/clock';
import { findBlockedClaims } from '@/lib/compliance/claims';

describe('business days (shared module)', () => {
  it('is the dispute clock’s table and helpers, not a second copy', () => {
    expect(FEDERAL_HOLIDAYS).toBe(clock.FEDERAL_HOLIDAYS);
    expect(addBusinessDays).toBe(clock.addBusinessDays);
  });
  it('skips weekends and observed federal holidays', () => {
    expect(isBusinessDay('2026-11-26')).toBe(false); // Thanksgiving
    expect(isBusinessDay('2026-07-03')).toBe(false); // Independence Day 2026 falls on a Saturday, observed Friday
    expect(isBusinessDay('2026-11-21')).toBe(false); // Saturday
    expect(isBusinessDay('2026-11-27')).toBe(true);
  });
  it('month helpers', () => {
    expect(monthRange('2026-02')).toEqual({ from: '2026-02-01', to: '2026-02-28' });
    expect(monthRange('2028-02').to).toBe('2028-02-29');
    expect(monthRange('2026-12').to).toBe('2026-12-31');
    expect(isMonth('2026-13')).toBe(false);
    expect(isMonth('2026-11')).toBe(true);
    expect(monthsBack('2026-02', '2025-11')).toEqual(['2026-02', '2026-01', '2025-12', '2025-11']);
    expect(monthsBack('2026-02', '2020-01', 3)).toEqual(['2026-02', '2026-01', '2025-12']);
  });
});

describe('cancellation period: 3 business days after signing (15 U.S.C. § 1679e(a))', () => {
  it.each([
    ['2026-11-16', '2026-11-19', 'Monday: Tue, Wed, Thu'],
    ['2026-11-20', '2026-11-25', 'Friday: the weekend is skipped'],
    ['2026-11-14', '2026-11-18', 'Saturday: counting starts on Monday'],
    ['2026-11-24', '2026-11-30', 'Tuesday before Thanksgiving: the holiday and the weekend are skipped'],
    ['2026-12-31', '2027-01-06', 'New Year’s Eve: New Year’s Day and the weekend are skipped'],
    ['2026-07-01', '2026-07-07', 'Independence Day observed on Friday July 3'],
  ])('signed %s → last day to cancel %s (%s)', (signed, ends) => {
    expect(cancellationEndsOn(signed)).toBe(ends);
  });
});

const base: ChargeInput = {
  chargeDate: '2026-11-30', period: monthRange('2026-11'), contractSignedOn: '2026-10-01', clientStatus: 'active', lettersSentOn: ['2026-11-10'], soldByPhone: false,
};
const codes = (i: Partial<ChargeInput>) => chargeEligibility({ ...base, ...i }).reasons.map((r) => r.code);

describe('charge eligibility', () => {
  it('eligible: signed agreement past its cancellation period, a letter sent in the period, client not cancelled', () => {
    const e = chargeEligibility(base);
    expect(e).toMatchObject({ status: 'eligible', reasons: [], workCount: 1, cancellationEndsOn: '2026-10-06' });
  });

  it('holds on the last day of the cancellation period and clears the day after', () => {
    expect(codes({ contractSignedOn: '2026-11-20', chargeDate: '2026-11-25', lettersSentOn: ['2026-11-25'] })).toEqual(['cancellation_window']);
    expect(codes({ contractSignedOn: '2026-11-20', chargeDate: '2026-11-26', lettersSentOn: ['2026-11-25'] })).toEqual([]);
    // Thanksgiving week: signed Tuesday, still inside the period on the following Monday.
    expect(codes({ contractSignedOn: '2026-11-24', chargeDate: '2026-11-30', lettersSentOn: ['2026-11-30'] })).toEqual(['cancellation_window']);
    expect(codes({ contractSignedOn: '2026-11-24', chargeDate: '2026-12-01', period: monthRange('2026-11'), lettersSentOn: ['2026-11-30'] })).toEqual([]);
  });

  it('holds on the signing day itself', () => {
    expect(codes({ contractSignedOn: '2026-11-30' })).toEqual(['cancellation_window']);
  });

  it('holds with no agreement, and says so when the last one was revoked', () => {
    expect(codes({ contractSignedOn: null })).toEqual(['no_contract']);
    const e = chargeEligibility({ ...base, contractSignedOn: null, contractRevokedOn: '2026-11-03' });
    expect(e.reasons.map((r) => r.code)).toEqual(['contract_revoked']);
    expect(e.reasons[0]!.text).toContain('Nov 3, 2026');
    expect(e.cancellationEndsOn).toBeNull();
  });

  it('completed work means a letter sent inside the period, on or before the charge date', () => {
    expect(codes({ lettersSentOn: [] })).toEqual(['no_completed_work']);
    expect(codes({ lettersSentOn: ['2026-10-31', '2026-12-01'] })).toEqual(['no_completed_work']); // other months do not count
    expect(codes({ chargeDate: '2026-11-09' })).toEqual(['no_completed_work']); // sent on the 10th: not yet done on the 9th
    expect(codes({ chargeDate: '2026-11-10' })).toEqual([]);
    expect(codes({ lettersSentOn: ['2026-11-01', '2026-11-30'] })).toEqual([]); // both ends of the period count
    expect(chargeEligibility({ ...base, lettersSentOn: ['2026-11-01', '2026-11-30', '2026-10-15'] }).workCount).toBe(2);
  });

  it('holds when the client has cancelled', () => {
    expect(codes({ clientStatus: 'cancelled' })).toEqual(['client_cancelled']);
    for (const s of ['lead', 'onboarding', 'active', 'paused', 'completed']) expect(codes({ clientStatus: s })).toEqual([]);
  });

  it('sold by phone adds the Telemarketing Sales Rule caution, worded as something to review', () => {
    const e = chargeEligibility({ ...base, soldByPhone: true });
    expect(e.status).toBe('hold');
    expect(e.reasons).toEqual([{ code: 'sold_by_phone', text: TSR_CAUTION }]);
    expect(TSR_CAUTION).toContain('16 CFR 310.4(a)(2)');
    expect(TSR_CAUTION).toContain('generally');
    expect(TSR_CAUTION).toContain('six months');
    expect(TSR_CAUTION).toMatch(/attorney/);
  });

  it('says whether the phone-sale rule was considered at all: only once staff have answered how the client was sold', () => {
    expect(chargeEligibility({ ...base, soldByPhone: null })).toMatchObject({ status: 'eligible', phoneSale: 'not_answered', reasons: [] });
    expect(chargeEligibility({ ...base, soldByPhone: false })).toMatchObject({ status: 'eligible', phoneSale: 'no' });
    expect(chargeEligibility({ ...base, soldByPhone: true })).toMatchObject({ status: 'hold', phoneSale: 'yes' });
  });

  it('lists every reason that applies', () => {
    expect(codes({ clientStatus: 'cancelled', contractSignedOn: null, lettersSentOn: [], soldByPhone: true })).toEqual(['client_cancelled', 'no_contract', 'no_completed_work', 'sold_by_phone']);
  });

  it('no reason text makes a prohibited claim', () => {
    const all = chargeEligibility({ ...base, clientStatus: 'cancelled', contractSignedOn: '2026-11-27', lettersSentOn: [], soldByPhone: true }).reasons;
    expect(all).toHaveLength(4);
    for (const r of all) expect(findBlockedClaims(r.text)).toEqual([]);
  });
});
