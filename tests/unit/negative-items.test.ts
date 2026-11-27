import { describe, expect, it } from 'vitest';
import { analyze, canonAccountStatus, canonPaymentStatus, groupAccounts, sameAccountScore, type AnalysisTradeline } from '@/lib/reports/analysis';
import { historyShowsLate, isNegative } from '@/lib/credit/reporting-period';
import { TU_NO_LATES } from '@/lib/reports/bureau-layouts';
import type { Bureau } from '@/lib/util';

let seq = 0;
const T = (bureau: Bureau, o: Partial<AnalysisTradeline> = {}): AnalysisTradeline => ({
  id: `n${++seq}`, bureau, item_type: 'tradeline', creditor_name: 'SOME BANK', original_creditor: null, account_last4: null, account_status: 'Open',
  payment_status: 'Pays As Agreed', balance_cents: 50000, credit_limit_cents: 100000, date_opened: '2024-01-15', date_reported: '2026-10-30',
  date_of_first_delinquency: null, payment_history: null, user_provided: {}, ...o,
});
const run = (tradelines: AnalysisTradeline[]) => analyze({ tradelines, inquiries: [], publicRecords: [], identity: [], now: new Date('2026-11-23T00:00:00Z') });

describe('what counts as negative', () => {
  it('"Never late", "Pays As Agreed" and dates are not late', () => {
    expect(isNegative({ item_type: 'tradeline', account_status: 'Open/Never late.', payment_status: null, payment_history: null })).toBe(false);
    expect(isNegative({ item_type: 'tradeline', account_status: 'Paid, Closed/Never late.', payment_status: null, payment_history: null })).toBe(false);
    expect(isNegative({ item_type: 'tradeline', account_status: 'Closed 12/30/2023', payment_status: 'Pays As Agreed', payment_history: null })).toBe(false);
  });
  it('past due, 30-59 days and charge-offs are', () => {
    expect(isNegative({ item_type: 'tradeline', account_status: 'Open. $690 past due as of Oct 2026.', payment_status: null, payment_history: null })).toBe(true);
    expect(isNegative({ item_type: 'tradeline', account_status: 'Open', payment_status: '30 - 59 Days Past Due', payment_history: null })).toBe(true);
    expect(isNegative({ item_type: 'tradeline', account_status: 'Closed', payment_status: 'Charge-off', payment_history: null })).toBe(true);
  });

  describe('from the payment history alone', () => {
    const withHistory = (payment_history: string | null) => isNegative({ item_type: 'tradeline', account_status: 'Open', payment_status: 'Pays As Agreed', payment_history });

    it('days late count, written together or apart, 120 included', () => {
      for (const late of ['CCC30CCC', '2026 30', 'OK OK 60', 'Jul 2026 30; Aug 2026 60', 'Sep 2030 90', '120', 'OK 120 OK', 'CC150C', '30/60/90']) expect([late, withHistory(late)]).toEqual([late, true]);
    });
    it('TransUnion’s codes count: COL, c/o, RPO, FC and vs, and CO for a charge-off', () => {
      for (const code of ['Oct 2026 COL; Nov 2026 COL', 'Jan 2026 c/o', 'Mar 2026 RPO', 'Mar 2026 FC', 'Mar 2026 vs', 'OK OK CO', 'C.O.', 'Late codes reported: COL (months not matched; see the original)']) expect([code, withHistory(code)]).toEqual([code, true]);
    });
    it('a year such as 2030, a date, and a history with no late month do not', () => {
      for (const fine of [null, '', 'CCCCCCCC', 'OK OK OK', 'N/R x OK', '2030', '2030 * * *', '2030; 2029', 'Closed 12/30/2030', '2023-12-30', TU_NO_LATES]) expect([fine, withHistory(fine)]).toEqual([fine, false]);
      expect(historyShowsLate('2030')).toBe(false);
      expect(historyShowsLate('2030 30')).toBe(true);
    });
    it('the old test read every year from 2030 on as 30 days late', () => {
      // An Equifax history row is the year and that year's codes: a clean 2030 row is just "2030".
      expect(/[3-9]0/.test('2030')).toBe(true);
      expect(withHistory('2030')).toBe(false);
    });
  });
});

describe('negative items are flagged', () => {
  it('late payments become a review finding; collections are strong', () => {
    const f = run([
      T('equifax', { creditor_name: 'AUTO LENDER', payment_status: '30 - 59 Days Past Due', account_last4: '7125' }),
      T('equifax', { item_type: 'collection', creditor_name: 'COLLECTOR', original_creditor: 'LANDLORD', account_last4: '9166', date_of_first_delinquency: '2025-06-30' }),
      T('equifax', { creditor_name: 'GOOD CARD', account_last4: '1111' }),
    ]);
    const late = f.filter((x) => x.category === 'negative_item');
    expect(late).toHaveLength(1);
    expect(late[0]!.severity).toBe('review');
    expect(late[0]!.title).toBe('AUTO LENDER (ending 7125) on Equifax reports late payments');
    expect(f.find((x) => x.category === 'collection_validation')!.severity).toBe('strong');
    expect(f.some((x) => x.title.includes('GOOD CARD'))).toBe(false);
  });
  it('a charge-off is strong', () => {
    const [f] = run([T('equifax', { payment_status: 'Charge-off', account_status: 'Closed' })]).filter((x) => x.category === 'negative_item');
    expect(f!.severity).toBe('strong');
  });
  it('an account whose only negative mark is a code in its history is flagged, and a clean history in 2030 is not', () => {
    const flagged = (payment_history: string) => run([T('transunion', { payment_history })]).filter((x) => x.category === 'negative_item').length;
    expect(flagged('Mar 2026 RPO')).toBe(1);
    expect(flagged('Jul 2026 30; Aug 2026 60')).toBe(1);
    expect(flagged(TU_NO_LATES)).toBe(0);
    expect(flagged('2030')).toBe(0);
  });
  it('the client’s "never late" is set against the history only when the history shows a late code', () => {
    const stated = (payment_history: string) => run([T('equifax', { payment_history, user_provided: { never_late: true } })]).filter((x) => x.dedupe_key.startsWith('client-never-late:')).length;
    expect(stated('2026 30')).toBe(1);
    expect(stated('Oct 2026 COL; Nov 2026 COL')).toBe(1);
    expect(stated('2030')).toBe(0);
    expect(stated(TU_NO_LATES)).toBe(0);
  });
});

describe('the same account under different names or numbers', () => {
  it('pairs accounts that a bureau names differently when the reported facts line up', () => {
    const g = groupAccounts([
      T('experian', { creditor_name: 'NISSAN MOTOR ACCEPTANCE', date_opened: '2025-08-05', balance_cents: 414000, credit_limit_cents: null }),
      T('equifax', { creditor_name: 'INFINITI MOTOR ACCEPTANCE CORP', account_last4: '7125', date_opened: '2025-08-05', balance_cents: 414000, credit_limit_cents: null }),
      T('experian', { creditor_name: 'CB INDIGO/CCI', date_opened: '2026-07-26', balance_cents: 119600 }),
      T('equifax', { creditor_name: 'CB INDIGO', account_last4: '9523', date_opened: '2026-07-26', balance_cents: 119600 }),
    ]);
    expect(g).toHaveLength(2);
    expect(g.every((x) => x.bureauCount === 2)).toBe(true);
    // The account-number key is kept.
    expect(g.map((x) => x.key).sort()).toEqual(['tradeline|cb indigo|9523', 'tradeline|infiniti motor acceptance|7125']);
  });
  it('pairs a debt reported by two collectors through the original creditor and balance', () => {
    const g = groupAccounts([
      T('experian', { item_type: 'collection', creditor_name: 'COLUMBIA DEBT RECOVERY', original_creditor: 'ARBORS AVENTURA', date_opened: '2026-07-17', balance_cents: 261400 }),
      T('equifax', { item_type: 'collection', creditor_name: 'GENESISCRE', original_creditor: 'ARBORS AVENTURA', account_last4: '1745', date_opened: null, balance_cents: 261400 }),
    ]);
    expect(g).toHaveLength(1);
  });
  it('picks the best match when two accounts opened the same day', () => {
    const g = groupAccounts([
      T('experian', { creditor_name: 'KIKOFF LENDING LLC', date_opened: '2022-12-28', balance_cents: 17500, credit_limit_cents: 350000 }),
      T('experian', { creditor_name: 'KIKOFF/COASTAL COMMUNITY', date_opened: '2022-12-28', balance_cents: 0, credit_limit_cents: null }),
      T('equifax', { creditor_name: 'KIKOFF LENDING, LLC', account_last4: 'C7UC', date_opened: '2022-12-28', balance_cents: 17500, credit_limit_cents: 350000 }),
      T('equifax', { creditor_name: 'KIKOFF/CCB', account_last4: 'OAFE', date_opened: '2022-12-28', balance_cents: 0, credit_limit_cents: null }),
    ]);
    const byEq = Object.fromEntries(g.map((x) => [x.byBureau.equifax?.account_last4, x.byBureau.experian?.creditor_name]));
    expect(byEq).toEqual({ C7UC: 'KIKOFF LENDING LLC', OAFE: 'KIKOFF/COASTAL COMMUNITY' });
  });
  it('never pairs on facts alone: an identifier has to line up', () => {
    expect(sameAccountScore(T('experian', { date_opened: '2020-01-01' }), T('equifax', { date_opened: '2021-01-01' }))).toBe(0);
  });
});

describe('statuses compared by meaning', () => {
  it('treats different wording of the same status as the same', () => {
    expect(canonAccountStatus('Open/Never late.')).toBe(canonAccountStatus('Open'));
    expect(canonPaymentStatus('$690 past due as of Oct 2026.')).toBe(canonPaymentStatus('30 - 59 Days Past Due'));
    expect(canonPaymentStatus('Pays As Agreed')).not.toBe(canonPaymentStatus('30 days past due as of Oct 2026'));
    const f = run([T('experian', { account_status: 'Open/Never late.', account_last4: '1' }), T('equifax', { account_status: 'Open', account_last4: '1' })]);
    expect(f.filter((x) => x.category === 'status_mismatch')).toEqual([]);
  });
  it('the same address with or without ZIP+4 is not a difference', () => {
    const f = analyze({ tradelines: [T('experian'), T('equifax')], inquiries: [], publicRecords: [], now: new Date('2026-11-23'),
      identity: [{ bureau: 'experian', kind: 'address', value: '16945 SW 95TH ST MIAMI FL, 33196-4768' }, { bureau: 'equifax', kind: 'address', value: '16945 SW 95TH ST, MIAMI, FL 33196' }] });
    expect(f.filter((x) => x.category === 'personal_info')).toEqual([]);
  });
});
