import { describe, expect, it } from 'vitest';
import { addBusinessDays } from '@/lib/business-days';
import { findBlockedClaims } from '@/lib/compliance/claims';
import { auditAccounts, bankruptcyFallOff, bankruptcyFindings, type Bankruptcy, type BankruptcyLine } from '@/lib/credit/bankruptcy-audit';
import { medicalBasis, medicalScreen, medicalTests, reportSaysMedical, type MedicalLine } from '@/lib/credit/medical-screen';
import { AFTER_PERIOD_NOTE, isExcludedDay, presumedReceipt, validationPeriod } from '@/lib/credit/validation-clock';
import { buildPlan } from '@/lib/plan';

/** Nothing a tool says may promise a result, demand a deletion or state that something must come off a report. */
const expectNeutral = (text: string) => {
  expect(findBlockedClaims(text), text).toEqual([]);
  expect(text).not.toMatch(/\bmust be (removed|deleted)\b|\bdemand\b|\bviolat|\billegal|\bguarantee/i);
};

describe('collector validation period (12 CFR 1006.34(b)(5))', () => {
  it('ends 30 days after the day the client received the notice', () => {
    const p = validationPeriod({ kind: 'received', date: '2026-11-02' }, '2026-11-19');
    expect(p).toEqual({ receivedOn: '2026-11-02', presumed: false, endsOn: '2026-12-02', daysLeft: 13, open: true });
  });

  it('presumes receipt 5 days after sending, not counting Saturdays and Sundays', () => {
    expect(presumedReceipt('2026-11-02')).toBe('2026-11-09'); // sent Monday: Tue, Wed, Thu, Fri, then Monday
    expect(presumedReceipt('2026-10-31')).toBe('2026-11-06'); // sent Saturday: Mon to Fri
    const p = validationPeriod({ kind: 'sent', date: '2026-11-02' }, '2026-11-19');
    expect(p).toMatchObject({ receivedOn: '2026-11-09', presumed: true, endsOn: '2026-12-09', daysLeft: 20, open: true });
  });

  it('does not count legal public holidays', () => {
    expect(presumedReceipt('2026-11-06')).toBe('2026-11-16'); // Veterans Day, Wednesday Nov 11, 2026
    expect(presumedReceipt('2026-11-23')).toBe('2026-12-01'); // Thanksgiving, Thursday Nov 26, 2026
    expect(isExcludedDay('2026-11-26')).toBe(true);
  });

  it('counts a day that is only the observed day of a weekend holiday, which makes the date earlier, never later', () => {
    // July 4, 2026 is a Saturday. Friday July 3 is the observed day, but 5 U.S.C. 6103(a) names July 4 itself.
    expect(isExcludedDay('2026-07-03')).toBe(false);
    expect(isExcludedDay('2026-07-04')).toBe(true); // a Saturday
    expect(presumedReceipt('2026-06-29')).toBe('2026-07-06');
    expect(addBusinessDays('2026-06-29', 5)).toBe('2026-07-07'); // the dispute clock's business days would be a day later
    // New Year's Day 2028 is a Saturday, observed Friday Dec 31, 2027.
    expect(isExcludedDay('2027-12-31')).toBe(false);
  });

  it('is open through the last day and closed the day after', () => {
    expect(validationPeriod({ kind: 'received', date: '2026-11-02' }, '2026-12-02')).toMatchObject({ daysLeft: 0, open: true });
    expect(validationPeriod({ kind: 'received', date: '2026-11-02' }, '2026-12-03')).toMatchObject({ daysLeft: -1, open: false });
  });

  it('explains the end of the period without advice or a threat', () => {
    expectNeutral(AFTER_PERIOD_NOTE);
    expect(AFTER_PERIOD_NOTE).toMatch(/generally/);
    expect(AFTER_PERIOD_NOTE).toMatch(/not an admission/);
  });

  it('puts an open period in the client plan, separate from bureau disputes', () => {
    const base = { clientId: 'c1', firstName: 'Jordan', reports: 1, reportsPendingReview: 0, missingConsents: [], findingsToReview: 0, collections: [], accounts: [], disputesOverdue: 0, disputesDueSoon: 0, lettersToSend: 0 };
    expect(buildPlan(base).some((s) => s.key === 'validation-period')).toBe(false);
    const step = buildPlan({ ...base, validationWindows: [{ collector: 'ABC Collections', endsOn: '2026-12-02', daysLeft: 13 }] }).find((s) => s.key === 'validation-period')!;
    expect(step.title).toContain('ABC Collections');
    expect(step.detail).toMatch(/13 days left/);
    expect(step.detail).toMatch(/different deadline from a dispute with a credit bureau/);
    expectNeutral(`${step.title} ${step.detail}`);
  });
});

const med = (o: Partial<MedicalLine> = {}): MedicalLine => ({
  id: 't1', bureau: 'experian', item_type: 'collection', creditor_name: 'ABC Collections', original_creditor: null, account_last4: '4321', account_type: 'Collection', account_status: 'Open',
  payment_status: 'Collection', remarks: null, balance_cents: 120000, date_of_first_delinquency: '2024-01-15', match_key: 'abc collections|4321', medical_flag: null, ...o,
});
const TODAY = '2026-11-19';

describe('medical collection screen', () => {
  it('treats an account as medical only when the report says so or staff marked it', () => {
    expect(medicalBasis(med())).toBeNull();
    expect(reportSaysMedical(med({ account_type: 'Medical collection' }))).toBe(true);
    expect(medicalBasis(med({ remarks: 'Medical' }))).toBe('report');
    expect(medicalBasis(med({ original_creditor: 'Riverside Hospital' }))).toBe('report');
    expect(medicalBasis(med({ medical_flag: true }))).toBe('staff');
    expect(medicalBasis(med({ remarks: 'Medical', medical_flag: false }))).toBeNull(); // staff's answer wins
    // The collector's own name is a suggestion, below what the report says and what staff said.
    expect(medicalBasis(med({ creditor_name: 'VALLEY RADIOLOGY ASSOC' }))).toBe('name');
    expect(medicalBasis(med({ creditor_name: 'VALLEY RADIOLOGY ASSOC', medical_flag: false }))).toBeNull();
    expect(medicalBasis(med({ account_type: '90' }))).toBe('report'); // Metro 2 account type 90: medical debt
  });

  it('makes no finding when only the collector’s name suggests medical: that is a guess for staff to confirm', () => {
    expect(medicalScreen([med({ creditor_name: 'VALLEY RADIOLOGY ASSOC', balance_cents: 30000 })], TODAY)).toEqual([]);
    // Once staff tick it, it is theirs to say, and the finding says so.
    expect(medicalScreen([med({ creditor_name: 'VALLEY RADIOLOGY ASSOC', balance_cents: 30000, medical_flag: true })], TODAY)[0]!.explanation).toMatch(/^Staff marked this collection as a medical debt/);
  });

  it('applies the three policy tests to the reported values', () => {
    expect(medicalTests(med(), TODAY)).toEqual([]); // $1,200, unpaid, over a year old
    expect(medicalTests(med({ balance_cents: 0 }), TODAY)).toEqual(['paid']);
    expect(medicalTests(med({ account_status: 'Paid collection' }), TODAY)).toEqual(['paid']);
    expect(medicalTests(med({ account_status: 'Unpaid' }), TODAY)).toEqual([]);
    expect(medicalTests(med({ balance_cents: 49999 }), TODAY)).toEqual(['under_500']);
    expect(medicalTests(med({ balance_cents: 50000 }), TODAY)).toEqual([]); // exactly $500 is not under $500
    expect(medicalTests(med({ date_of_first_delinquency: '2025-11-20' }), TODAY)).toEqual(['under_one_year']);
    expect(medicalTests(med({ date_of_first_delinquency: '2025-11-19' }), TODAY)).toEqual([]); // one year old today
    expect(medicalTests(med({ balance_cents: null, date_of_first_delinquency: null }), TODAY)).toEqual([]); // nothing reported, nothing claimed
  });

  it('creates one finding per medical collection that meets a test, and none otherwise', () => {
    expect(medicalScreen([med({ balance_cents: 30000 })], TODAY)).toEqual([]); // under $500 but not medical
    expect(medicalScreen([med({ medical_flag: true })], TODAY)).toEqual([]); // medical but meets no test
    // Not a collector's account: a card, and a creditor's own account whose status says "Collection" (no collector there).
    expect(medicalScreen([med({ item_type: 'tradeline', account_type: 'Credit card', account_status: 'Open', payment_status: 'Current', medical_flag: true, balance_cents: 0 })], TODAY)).toEqual([]);
    expect(medicalScreen([med({ item_type: 'tradeline', account_type: 'Credit card', medical_flag: true, balance_cents: 0 })], TODAY)).toEqual([]);
    // A collector's account by its account type, wherever it is listed.
    expect(medicalScreen([med({ item_type: 'tradeline', medical_flag: true, balance_cents: 0 })], TODAY)).toHaveLength(1);
    const [f, ...rest] = medicalScreen([med({ medical_flag: true, balance_cents: 30000, date_of_first_delinquency: '2026-03-01' })], TODAY);
    expect(rest).toEqual([]);
    expect(f!.dedupe_key).toBe('medical:experian:abc collections|4321');
    expect(f!.tradeline_ids).toEqual(['t1']);
    expect(f!.explanation).toMatch(/under \$500/);
    expect(f!.explanation).toMatch(/less than one year ago/);
  });

  it('says it is bureau policy, not law, with the source and date, and never that the item must come off', () => {
    const f = medicalScreen([med({ remarks: 'Medical', balance_cents: 0 })], TODAY)[0]!;
    expect(f.explanation).toMatch(/own policy, not a law/);
    expect(f.explanation).toMatch(/March 18, 2022 and April 11, 2023/);
    expect(f.explanation).toMatch(/vacated by a court on July 11, 2025/);
    expect(f.explanation).toMatch(/generally/);
    expect(f.explanation).toMatch(/against the client’s records/);
    expectNeutral(`${f.title} ${f.explanation}`);
    expect(f.evidence.some((e) => e.field === 'Compared on' && e.value === TODAY)).toBe(true);
  });

  it('keys a line without an account number by its row, so two unnumbered accounts stay apart', () => {
    const f = medicalScreen([med({ id: 'x9', match_key: 'abc collections|', account_last4: null, medical_flag: true, balance_cents: 0 })], TODAY)[0]!;
    expect(f.dedupe_key).toBe('medical:experian:x9');
  });
});

const bk: Bankruptcy = { chapter: '7', filedOn: '2023-06-01', dischargedOn: '2023-09-15' };
const acct = (o: Partial<BankruptcyLine> = {}): BankruptcyLine => ({
  id: 'a1', bureau: 'equifax', item_type: 'tradeline', creditor_name: 'ACME BANK', account_last4: '1234', account_status: 'Closed', payment_status: 'Charge-off', payment_history: null, remarks: null,
  balance_cents: 250000, date_opened: '2020-02-01', date_of_first_delinquency: '2022-12-01', match_key: 'acme|1234', ...o,
});

describe('bankruptcy discharge audit', () => {
  it('works out the reporting period of the bankruptcy itself, with the bureau policy for Chapter 13 kept apart', () => {
    expect(bankruptcyFallOff({ chapter: '7', filedOn: '2023-06-01' })).toEqual({ statute: '2033-06-01', policy: null });
    expect(bankruptcyFallOff({ chapter: '13', filedOn: '2023-06-01' })).toEqual({ statute: '2033-06-01', policy: '2030-06-01' });
    expect(bankruptcyFallOff({ chapter: '7', filedOn: 'not a date' })).toBeNull();
  });

  it('checks nothing until a discharge date is recorded', () => {
    expect(auditAccounts({ ...bk, dischargedOn: null }, [acct()])).toEqual([]);
  });

  it('looks only at accounts dated before the filing', () => {
    expect(auditAccounts(bk, [acct({ date_opened: '2023-06-01' })])).toEqual([]); // opened on the filing date
    expect(auditAccounts(bk, [acct({ date_opened: '2024-01-01' })])).toEqual([]);
    expect(auditAccounts(bk, [acct({ date_opened: null })])).toEqual([]); // no date, no guess
    // A collection placed after the filing for a debt that went delinquent before it.
    expect(auditAccounts(bk, [acct({ item_type: 'collection', date_opened: '2023-08-01' })])).toHaveLength(1);
  });

  it('notes a balance, a status with no mention of the bankruptcy, and a delinquency dated after the filing', () => {
    expect(auditAccounts(bk, [acct()])[0]!.notes).toEqual(['balance', 'status']);
    expect(auditAccounts(bk, [acct({ balance_cents: 0, account_status: 'Included in bankruptcy', payment_status: null })])[0]).toMatchObject({ result: 'checked', notes: [] });
    expect(auditAccounts(bk, [acct({ balance_cents: 0, remarks: 'Discharged in Chapter 7 bankruptcy', date_of_first_delinquency: '2023-07-10' })])[0]!.notes).toEqual(['delinquency_after_filing']);
  });

  it('leaves alone an account in good standing that never mentions the bankruptcy', () => {
    const [row] = auditAccounts(bk, [acct({ account_status: 'Open', payment_status: 'Current', date_of_first_delinquency: null })]);
    expect(row).toMatchObject({ result: 'not_checked', notes: [] });
    expect(bankruptcyFindings(bk, [acct({ account_status: 'Open', payment_status: 'Current', date_of_first_delinquency: null })])).toEqual([]);
  });

  it('writes a "worth checking" finding that cites the expectation and asserts no error', () => {
    const [f, ...rest] = bankruptcyFindings(bk, [acct(), acct({ id: 'a2', bureau: 'experian', balance_cents: 0, account_status: 'Included in bankruptcy' })]);
    expect(rest).toEqual([]); // the consistent line produces nothing
    expect(f!.dedupe_key).toBe('bankruptcy:equifax:acme|1234');
    expect(f!.title).toMatch(/worth checking/);
    expect(f!.explanation).toMatch(/reports a balance of \$2,500\.00/);
    expect(f!.explanation).toMatch(/generally expected/);
    expect(f!.explanation).toMatch(/Supervisory Highlights/);
    expect(f!.explanation).toMatch(/confirm with the client’s bankruptcy papers/);
    expect(f!.explanation).toMatch(/not a conclusion that anything is reported wrongly/);
    expectNeutral(`${f!.title} ${f!.explanation}`);
  });
});
