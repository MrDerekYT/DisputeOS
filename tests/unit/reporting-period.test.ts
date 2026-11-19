import { describe, expect, it } from 'vitest';
import { findBlockedClaims } from '@/lib/compliance/claims';
import {
  addDaysIso, addMonthsIso, addYearsIso, agingOffWithin, isCollectionOrChargeOff, publicRecordFallOff, tradelineFallOff, withinMonths, type ReportedItem,
} from '@/lib/credit/reporting-period';
import { findReinsertions, isExactKey, type DeletedDispute, type ReportedLine } from '@/lib/disputes/reinsertion';
import { analyze, FINDING_CATEGORIES, type AnalysisTradeline } from '@/lib/reports/analysis';
import { buildPlan } from '@/lib/plan';

const item = (o: Partial<ReportedItem> = {}): ReportedItem => ({ item_type: 'tradeline', account_status: 'Open', payment_status: 'Current', payment_history: null, date_of_first_delinquency: null, ...o });

describe('date arithmetic', () => {
  it('adds calendar days across month ends and a leap day', () => {
    expect(addDaysIso('2019-09-02', 180)).toBe('2020-02-29');
    expect(addDaysIso('2021-09-02', 180)).toBe('2022-03-01'); // no Feb 29 in 2022, so the same start lands a day later in the calendar
    expect(addDaysIso('2023-12-31', 1)).toBe('2024-01-01');
  });
  it('adds whole years; Feb 29 becomes Mar 1 when the target year has no Feb 29', () => {
    expect(addYearsIso('2018-06-15', 7)).toBe('2025-06-15');
    expect(addYearsIso('2020-02-29', 7)).toBe('2027-03-01');
    expect(addYearsIso('2020-02-29', 4)).toBe('2024-02-29');
    expect(addYearsIso('2020-02-29', 10)).toBe('2030-03-01');
  });
  it('adds months without sliding into the month after next', () => {
    expect(addMonthsIso('2025-11-19', 12)).toBe('2026-11-19');
    expect(addMonthsIso('2025-01-31', 1)).toBe('2025-03-01');
    expect(addMonthsIso('2024-02-29', 12)).toBe('2025-03-01');
  });
  it('rejects anything that is not a real date instead of guessing', () => {
    for (const bad of ['', '2020-02-30', '2020-13-01', '02/14/2020', 'unknown']) {
      expect(addDaysIso(bad, 1), bad).toBeNull();
      expect(addYearsIso(bad, 7), bad).toBeNull();
    }
  });
});

describe('fall-off date (15 U.S.C. 1681c)', () => {
  it('shows nothing for an item with no negative information', () => {
    expect(tradelineFallOff(item({ date_of_first_delinquency: '2020-01-01' }))).toBeNull();
  });
  it('a late-payment account: 7 years from the date of first delinquency', () => {
    expect(tradelineFallOff(item({ payment_status: 'Late 60', date_of_first_delinquency: '2020-03-10' }))).toEqual({ kind: 'date', date: '2027-03-10', rule: 'seven_years', from: '2020-03-10' });
  });
  it('a collection: the 7 years start 180 days after the date of first delinquency', () => {
    const f = tradelineFallOff(item({ item_type: 'collection', payment_status: 'Collection', date_of_first_delinquency: '2020-01-01' }));
    expect(f).toEqual({ kind: 'date', date: '2027-06-29', rule: 'seven_years_plus_180_days', from: '2020-01-01' }); // 2020-01-01 + 180 days = 2020-06-29
  });
  it('a charge-off gets the same 180 days, whichever status field says so', () => {
    expect(isCollectionOrChargeOff(item({ payment_status: 'Charge-off' }))).toBe(true);
    expect(isCollectionOrChargeOff(item({ account_status: 'Charged off' }))).toBe(true);
    expect(isCollectionOrChargeOff(item({ payment_status: 'Late 90' }))).toBe(false);
    expect(tradelineFallOff(item({ account_status: 'Closed', payment_status: 'Charge off', date_of_first_delinquency: '2019-09-02' })))
      .toMatchObject({ date: '2027-03-01', rule: 'seven_years_plus_180_days' }); // + 180 days = 2020-02-29, + 7 years = 2027-03-01
  });
  it('the 180 days are counted first, then the 7 years', () => {
    // 2018-08-31 + 180 days = 2019-02-27, + 7 years = 2026-02-27.
    expect(tradelineFallOff(item({ item_type: 'collection', date_of_first_delinquency: '2018-08-31' }))).toMatchObject({ date: '2026-02-27' });
    // The order matters when the 180 days cross a leap day: 2023-09-05 + 180 days = 2024-03-03, + 7 years = 2031-03-03.
    // (7 years first would give 2030-09-05 + 180 days = 2031-03-04.)
    expect(tradelineFallOff(item({ item_type: 'collection', date_of_first_delinquency: '2023-09-05' }))).toMatchObject({ date: '2031-03-03' });
  });
  it('says "not available" when a negative item has no reported date, and never estimates one', () => {
    expect(tradelineFallOff(item({ item_type: 'collection', payment_status: 'Collection' }))).toEqual({ kind: 'not_available' });
    expect(tradelineFallOff(item({ payment_status: 'Late 30', date_of_first_delinquency: 'not a date' }))).toEqual({ kind: 'not_available' });
  });
  it('bankruptcy: 10 years from the filing date; other public records are not computed', () => {
    expect(publicRecordFallOff({ kind: 'Chapter 7 Bankruptcy', filed_date: '2017-05-20' })).toEqual({ kind: 'date', date: '2027-05-20', rule: 'bankruptcy_ten_years', from: '2017-05-20' });
    expect(publicRecordFallOff({ kind: 'Chapter 7 Bankruptcy', filed_date: '2016-02-29' })).toMatchObject({ date: '2026-03-01' });
    expect(publicRecordFallOff({ kind: 'Bankruptcy', filed_date: null })).toEqual({ kind: 'not_available' });
    expect(publicRecordFallOff({ kind: 'Civil judgment', filed_date: '2019-01-01' })).toBeNull();
    expect(publicRecordFallOff({ kind: 'Tax lien', filed_date: '2019-01-01' })).toBeNull();
  });
});

describe('aging off within 12 months', () => {
  const today = '2026-11-19';
  it('includes today through the same day next year, and nothing outside it', () => {
    expect(withinMonths('2026-11-19', today)).toBe(true);
    expect(withinMonths('2027-11-19', today)).toBe(true);
    expect(withinMonths('2027-11-20', today)).toBe(false);
    expect(withinMonths('2026-11-18', today)).toBe(false);
  });
  it('lists the soonest first, merges the same item across bureaus, and skips items with no date', () => {
    const coll = item({ item_type: 'collection', date_of_first_delinquency: '2020-01-01' }); // 2027-06-29
    const late = item({ payment_status: 'Late 30', date_of_first_delinquency: '2020-02-01' }); // 2027-02-01
    const list = agingOffWithin([
      { label: 'MIDLAND ••7766', bureau: 'Experian', fallOff: tradelineFallOff(coll) },
      { label: 'MIDLAND ••7766', bureau: 'Equifax', fallOff: tradelineFallOff(coll) },
      { label: 'ACME ••1234', bureau: 'Experian', fallOff: tradelineFallOff(late) },
      { label: 'NO DATE', bureau: 'Experian', fallOff: tradelineFallOff(item({ item_type: 'collection' })) },
      { label: 'FAR OFF', bureau: 'Experian', fallOff: tradelineFallOff(item({ payment_status: 'Late 30', date_of_first_delinquency: '2025-01-01' })) },
      { label: 'ALREADY PAST', bureau: 'Experian', fallOff: tradelineFallOff(item({ payment_status: 'Late 30', date_of_first_delinquency: '2018-01-01' })) },
      { label: 'CLEAN', bureau: 'Experian', fallOff: tradelineFallOff(item()) },
    ], today);
    expect(list).toEqual([
      { label: 'ACME ••1234', date: '2027-02-01', rule: 'seven_years', from: '2020-02-01', bureaus: ['Experian'] },
      { label: 'MIDLAND ••7766', date: '2027-06-29', rule: 'seven_years_plus_180_days', from: '2020-01-01', bureaus: ['Experian', 'Equifax'] },
    ]);
  });
});

// ---------------------------------------------------------------- re-aging detector
let n = 0;
const T = (bureau: AnalysisTradeline['bureau'], o: Partial<AnalysisTradeline> = {}): AnalysisTradeline => ({
  id: `t${++n}`, bureau, item_type: 'tradeline', creditor_name: 'Capital One', original_creditor: null, account_last4: '4821', account_status: 'Closed', payment_status: 'Charge-off',
  balance_cents: 100000, credit_limit_cents: null, date_opened: '2015-03-01', date_reported: '2026-10-01', date_of_first_delinquency: '2021-04-01', payment_history: null, user_provided: {}, ...o,
});
const run = (tradelines: AnalysisTradeline[], now = new Date('2026-11-19T00:00:00Z')) => analyze({ tradelines, inquiries: [], publicRecords: [], identity: [], now });
const dofd = (tradelines: AnalysisTradeline[]) => run(tradelines).filter((f) => f.category === 'dofd_mismatch');

describe('re-aging detector (date mismatch)', () => {
  it('flags the same account showing different dates of first delinquency across bureaus, with both values and sources', () => {
    const [f, ...rest] = dofd([T('experian'), T('equifax', { date_of_first_delinquency: '2022-01-01' })]);
    expect(rest).toEqual([]);
    expect(f!.title).toBe('Date of first delinquency differs for Capital One (ending 4821)');
    expect(f!.evidence.map((e) => `${e.bureau}:${e.value}:${e.source}`).sort()).toEqual(['equifax:2022-01-01:reported', 'experian:2021-04-01:reported']);
    expect(f!.explanation).toMatch(/The dates differ and should be checked against the client’s records\./);
    expect(f!.explanation).toMatch(/15 U\.S\.C\. § 1681c/);
    expect(f!.basis).toBe('potential_discrepancy');
  });
  it('stays silent when the dates agree, or when only one bureau reports a date', () => {
    expect(dofd([T('experian'), T('equifax'), T('transunion')])).toEqual([]);
    expect(dofd([T('experian'), T('equifax', { date_of_first_delinquency: null })])).toEqual([]);
  });
  it('needs the exact match key: no account number, no cross-bureau date finding', () => {
    expect(dofd([T('experian', { account_last4: null }), T('equifax', { account_last4: null, date_of_first_delinquency: '2022-01-01' })])).toEqual([]);
    expect(dofd([T('experian'), T('equifax', { account_last4: '9999', date_of_first_delinquency: '2022-01-01' })])).toEqual([]);
  });
  it('flags a collection dated later than the original creditor’s account', () => {
    const orig = T('experian');
    const coll = T('experian', { item_type: 'collection', creditor_name: 'Midland Funding', original_creditor: 'CAPITAL ONE BANK', account_last4: '7766', payment_status: 'Collection', date_of_first_delinquency: '2023-02-01' });
    const [f, ...rest] = dofd([orig, coll]);
    expect(rest).toEqual([]);
    expect(f!.title).toBe('Experian: Midland Funding shows a later date of first delinquency than Capital One');
    expect(f!.evidence.slice(0, 2).map((e) => e.value)).toEqual(['2023-02-01', '2021-04-01']);
    expect(f!.evidence.every((e) => e.source === 'reported' && e.bureau === 'experian')).toBe(true);
    expect(f!.tradeline_ids).toEqual([coll.id, orig.id]);
    expect(f!.explanation).toMatch(/should be checked against the client’s records/);
  });
  it('does not flag a collection with the same or an earlier date, a missing date, or an ambiguous original account', () => {
    const coll = (o: Partial<AnalysisTradeline>) => T('experian', { item_type: 'collection', creditor_name: 'Midland Funding', original_creditor: 'Capital One', account_last4: '7766', payment_status: 'Collection', ...o });
    expect(dofd([T('experian'), coll({ date_of_first_delinquency: '2021-04-01' })])).toEqual([]);
    expect(dofd([T('experian'), coll({ date_of_first_delinquency: '2020-12-01' })])).toEqual([]);
    expect(dofd([T('experian', { date_of_first_delinquency: null }), coll({ date_of_first_delinquency: '2023-02-01' })])).toEqual([]);
    // Two Capital One accounts: the software cannot tell which one the collection came from, so it says nothing.
    expect(dofd([T('experian'), T('experian', { account_last4: '1111' }), coll({ date_of_first_delinquency: '2023-02-01' })])).toEqual([]);
    // The original creditor's account is on another bureau's report only: not compared.
    expect(dofd([T('equifax'), coll({ date_of_first_delinquency: '2023-02-01' })])).toEqual([]);
  });
  it('keeps the same dedupe key when the report is imported again', () => {
    const mk = () => dofd([T('experian'), T('experian', { item_type: 'collection', creditor_name: 'Midland Funding', original_creditor: 'Capital One', account_last4: '7766', date_of_first_delinquency: '2023-02-01' })])[0]!.dedupe_key;
    expect(mk()).toBe(mk());
  });
  it('never says which date is wrong and passes the claims guard', () => {
    const all = dofd([T('experian'), T('equifax', { date_of_first_delinquency: '2022-01-01' }),
      T('experian', { item_type: 'collection', creditor_name: 'Midland Funding', original_creditor: 'Capital One', account_last4: '7766', date_of_first_delinquency: '2023-02-01' })]);
    expect(all).toHaveLength(2);
    for (const f of all) {
      const text = `${f.title} ${f.explanation}`;
      expect(findBlockedClaims(text), f.dedupe_key).toEqual([]);
      expect(text.replace(/not a conclusion that anything is inaccurate/g, '')).not.toMatch(/inaccura|incorrect|\bwrong\b|\berror\b|violat|illegal|re-?aged|must be (removed|deleted)|score/i);
    }
  });
});

describe('past the reporting period uses the same arithmetic', () => {
  const coll = (d: string) => T('experian', { item_type: 'collection', creditor_name: 'Midland Funding', account_last4: '7766', payment_status: 'Collection', date_of_first_delinquency: d });
  it('a collection 7 years and 2 months past its date of first delinquency is not flagged: the 180 days have not run', () => {
    expect(run([coll('2019-09-19')]).some((f) => f.category === 'obsolete_item')).toBe(false); // ends 2027-03-17
  });
  it('it is flagged once 7 years plus 180 days have passed, with the computed date as evidence', () => {
    const f = run([coll('2019-01-10')]).find((x) => x.category === 'obsolete_item')!; // + 180 days = 2019-07-09, + 7 years = 2026-07-09
    expect(f.evidence.find((e) => e.field === 'Reporting period generally ends')).toMatchObject({ value: '2026-07-09', source: 'derived' });
    expect(f.explanation).toMatch(/generally 7 years, starting 180 days after the reported date of first delinquency \(15 U\.S\.C\. § 1681c\)/);
    expect(findBlockedClaims(f.explanation)).toEqual([]);
  });
});

// ---------------------------------------------------------------- reinsertion watch
describe('reinsertion watch (matching)', () => {
  const report = { id: 'r2', bureau: 'experian' as const, date: '2026-03-20' };
  const line = (o: Partial<ReportedLine> = {}): ReportedLine => ({ tradelineId: 'new-1', matchKey: 'acme|1234', creditorName: 'ACME BANK', accountLast4: '1234', ...o });
  const del = (o: Partial<DeletedDispute> = {}): DeletedDispute => ({ disputeId: 'd1', bureau: 'experian', matchKey: 'acme|1234', deletedOn: '2026-02-15', ...o });

  it('one finding that states both facts and asks about the written notice', () => {
    const [f, ...rest] = findReinsertions(report, [line(), line({ tradelineId: 'new-2', matchKey: 'other|9999', creditorName: 'OTHER' })], [del()]);
    expect(rest).toEqual([]);
    expect(f).toMatchObject({ category: 'possible_reinsertion', dedupe_key: 'reinsertion:d1', severity: 'review', basis: 'potential_discrepancy', tradeline_ids: ['new-1'] });
    expect(f!.title).toBe('ACME BANK (ending 1234) appears on Experian again after a recorded deletion');
    expect(f!.explanation).toMatch(/recorded as deleted \(response recorded on 2026-02-15\)/);
    expect(f!.explanation).toMatch(/appears again in the Experian report dated 2026-03-20/);
    expect(f!.explanation).toMatch(/Ask the client whether they received a written notice/);
    expect(f!.explanation).toMatch(/generally notify the consumer in writing within 5 business days \(15 U\.S\.C\. § 1681i\(a\)\(5\)\(B\)\)/);
    expect(FINDING_CATEGORIES.possible_reinsertion).toBe('Possible reinsertion');
  });
  it('does not assert a violation, promise anything or mention a score', () => {
    const f = findReinsertions(report, [line()], [del()])[0]!;
    const text = `${f.title} ${f.explanation} ${JSON.stringify(f.evidence)}`;
    expect(findBlockedClaims(text)).toEqual([]);
    expect(text).not.toMatch(/violat|illegal|unlawful|sue|damages|must be (removed|deleted)|will be (removed|deleted)|score|guarantee/i);
    expect(text).toMatch(/not a conclusion that anything was done wrong/);
  });
  it('exact key only: a different last 4, a different creditor or a key without a last 4 never matches', () => {
    expect(isExactKey('acme|1234')).toBe(true);
    for (const k of ['acme|', '|1234', '', 'acme']) expect(isExactKey(k), k).toBe(false);
    expect(findReinsertions(report, [line({ matchKey: 'acme|1235' })], [del()])).toEqual([]);
    expect(findReinsertions(report, [line({ matchKey: 'acme usa|1234' })], [del()])).toEqual([]);
    expect(findReinsertions(report, [line({ matchKey: 'acme|' })], [del({ matchKey: 'acme|' })])).toEqual([]);
  });
  it('nothing for another bureau, or for a report dated on or before the day the deletion was recorded', () => {
    expect(findReinsertions(report, [line()], [del({ bureau: 'equifax' })])).toEqual([]);
    expect(findReinsertions({ ...report, date: '2026-02-15' }, [line()], [del()])).toEqual([]);
    expect(findReinsertions({ ...report, date: '2026-01-05' }, [line()], [del()])).toEqual([]);
  });
  it('two recorded deletions of the same account give one finding, tied to the latest', () => {
    const out = findReinsertions(report, [line()], [del(), del({ disputeId: 'd2', deletedOn: '2026-03-01' })]);
    expect(out.map((f) => f.dedupe_key)).toEqual(['reinsertion:d2']);
  });
});

describe('the plan does not turn fall-off dates into a prediction', () => {
  it('no plan step mentions aging off, a fall-off date or a score change', () => {
    const steps = buildPlan({ clientId: 'c1', firstName: 'Jordan', reports: 3, reportsPendingReview: 0, missingConsents: [], findingsToReview: 4, collections: ['Midland Funding'], accounts: [], disputesOverdue: 0, disputesDueSoon: 0, lettersToSend: 0 });
    const text = steps.map((s) => `${s.title} ${s.detail}`).join(' ');
    expect(text).not.toMatch(/aging off|fall.?off|score (will|would|should|could)|points/i);
  });
});
