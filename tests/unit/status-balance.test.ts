import { describe, expect, it } from 'vitest';
import { analyze, flagsBehind, settledWording, type AnalysisTradeline } from '@/lib/reports/analysis';
import { categoryForFinding } from '@/lib/disputes/workflow';
import { draftReason } from '@/lib/disputes/reasons';
import type { Bureau } from '@/lib/util';

let seq = 0;
const T = (bureau: Bureau, o: Partial<AnalysisTradeline> = {}): AnalysisTradeline => ({
  id: `s${++seq}`, bureau, item_type: 'tradeline', creditor_name: 'SOME BANK', original_creditor: null, account_last4: '4321', account_status: 'Open',
  payment_status: 'Pays As Agreed', balance_cents: 50000, credit_limit_cents: 100000, date_opened: '2024-01-15', date_reported: '2026-10-30',
  date_of_first_delinquency: null, payment_history: null, user_provided: {}, ...o,
});
const run = (tradelines: AnalysisTradeline[]) => analyze({ tradelines, inquiries: [], publicRecords: [], identity: [], now: new Date('2026-11-23T00:00:00Z') });
const conflicts = (tradelines: AnalysisTradeline[]) => run(tradelines).filter((f) => f.category === 'status_balance_conflict');

describe('wording that says nothing is owed any more', () => {
  it('reads paid, settled, sold and transferred to another lender', () => {
    for (const s of ['Paid, Closed/Never late.', 'Account Paid in Full; was a Charge-off', 'Settled; less than full balance', 'Transferred, closed/Never late.',
      'TRANSFERRED TO ANOTHER LENDER', 'Purchased by another lender', 'Account transferred or sold', 'PAID', 'PAID_AND_CLOSED']) {
      expect(settledWording({ account_status: s, payment_status: null }), s).toBe(s);
    }
    expect(settledWording({ account_status: 'Closed', payment_status: 'Paid, Closed; was Paid as agreed' })).toBe('Paid, Closed; was Paid as agreed');
  });
  it('does not read a payment rating, a negation or an in-house transfer as paid', () => {
    for (const s of ['Pays As Agreed', 'Paid as agreed', 'Current; Paid or Paying as Agreed', 'PAID_AS_AGREED', 'Not paid', 'Unpaid', 'Never paid',
      'Transferred to recovery', 'TRANSFERRED TO ANOTHER OFFICE', 'Transferred to collection', 'Open/Never late.', 'Closed', 'Account charged off. $690 written off.']) {
      expect(settledWording({ account_status: s, payment_status: s }), s).toBeNull();
    }
  });
});

describe('an entry reported as paid or sold that still shows a balance', () => {
  it('is flagged once, with both reported values, as something to verify', () => {
    const f = conflicts([T('experian', { creditor_name: 'OLD SERVICER', account_status: 'Transferred, closed/Never late.', payment_status: null, balance_cents: 1245000 })]);
    expect(f).toHaveLength(1);
    expect(f[0]!.severity).toBe('review');
    expect(f[0]!.basis).toBe('potential_discrepancy');
    expect(f[0]!.title).toBe('OLD SERVICER (ending 4321) on Experian is reported as “Transferred, closed/Never late.” with a balance of $12,450.00');
    expect(f[0]!.evidence.map((e) => [e.field, e.value, e.source])).toEqual([['Account status', 'Transferred, closed/Never late.', 'reported'], ['Balance', '$12,450.00', 'reported']]);
    expect(f[0]!.explanation).toContain('not a conclusion that anything is inaccurate');
  });
  it('names the payment status when that is where the wording is', () => {
    const [f] = conflicts([T('transunion', { account_status: 'Closed', payment_status: 'Account Paid in Full; was a Charge-off', balance_cents: 30000 })]);
    expect(f!.evidence[0]).toMatchObject({ field: 'Payment status', value: 'Account Paid in Full; was a Charge-off' });
  });
  it('is not flagged with a zero or unreported balance, or on an open account that pays as agreed', () => {
    expect(conflicts([
      T('experian', { account_status: 'Paid, Closed/Never late.', balance_cents: 0 }),
      T('equifax', { account_status: 'Paid', balance_cents: null }),
      T('transunion', { account_status: 'Open', payment_status: 'Current; Paid or Paying as Agreed', balance_cents: 90000 }),
      T('experian', { creditor_name: 'CARD TWO', account_last4: '9', account_status: 'Account charged off. $690 written off.', payment_status: 'Transferred to recovery', balance_cents: 69000 }),
    ])).toEqual([]);
  });
  it('starts a status dispute whose drafted reason states both values and asks only to verify', () => {
    const [f] = conflicts([T('equifax', { creditor_name: 'FIRST LENDER', account_status: 'Paid', payment_status: null, balance_cents: 120000 })]);
    const category = categoryForFinding(f!);
    expect(category).toBe('incorrect_status');
    expect(draftReason({ category: category!, creditor: 'FIRST LENDER', last4: '4321', bureau: 'equifax', evidence: f!.evidence }))
      .toBe('Please verify the account and payment status reported for FIRST LENDER (account ending 4321) (Equifax reports account status Paid; Equifax reports balance $1,200.00) with the furnisher and correct it if needed.');
  });
});

describe('a collection and its original creditor', () => {
  it('says so when the report does not name one, and shows the name when it does', () => {
    const f = run([
      T('experian', { item_type: 'collection', creditor_name: 'COLLECTOR A', account_last4: '1', balance_cents: 98000 }),
      T('experian', { item_type: 'collection', creditor_name: 'COLLECTOR B', account_last4: '2', original_creditor: 'CITY HOSPITAL', balance_cents: 40000 }),
    ]).filter((x) => x.category === 'collection_validation');
    const [a, b] = [f.find((x) => x.title.startsWith('COLLECTOR A'))!, f.find((x) => x.title.startsWith('COLLECTOR B'))!];
    expect(a.evidence.at(-1)).toMatchObject({ field: 'Original creditor', value: 'not shown', source: 'reported' });
    expect(a.explanation).toContain('Experian does not name the original creditor for this account; the validation request asks the collector for it.');
    expect(b.evidence.at(-1)).toMatchObject({ field: 'Original creditor', value: 'CITY HOSPITAL' });
    expect(b.explanation).not.toContain('does not name the original creditor');
  });
});

describe('stored flags against what the reports say now', () => {
  const row = (dedupe_key: string, status = 'suggested', generated_by = 'rules') => ({ dedupe_key, status, generated_by });
  it('is zero when every flag the analysis raises is stored, whatever a person did with it', () => {
    expect(flagsBehind(['a', 'b', 'c'], [row('a'), row('b', 'dismissed'), row('c', 'disputed')])).toBe(0);
  });
  it('counts a flag that is not stored yet, and an open suggestion the analysis no longer raises', () => {
    expect(flagsBehind(['a', 'new'], [row('a'), row('gone')])).toBe(2);
    expect(flagsBehind([], [])).toBe(0);
  });
  it('never counts a reviewed flag or another check’s flag as stale', () => {
    expect(flagsBehind([], [row('kept', 'accepted'), row('dismissed', 'dismissed'), row('sent', 'disputed'), row('reinsertion:1', 'suggested', 'reinsertion'), row('medical:1', 'suggested', 'case_tools')])).toBe(0);
  });
});
