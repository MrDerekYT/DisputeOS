import { describe, expect, it } from 'vitest';
import { applyScenario, snapshot, type WAccount } from '@/lib/credit/what-if';
import { recheck, type ReportedAccount } from '@/lib/disputes/recheck';

const asOf = new Date('2026-06-15T00:00:00Z');
const accounts: WAccount[] = [
  { creditor: 'Card A', type: 'Revolving', status: 'Open', balanceCents: 90_000, limitCents: 100_000, opened: '2020-06-01' },
  { creditor: 'Card B', type: 'Credit card', status: 'Open', balanceCents: 30_000, limitCents: 300_000, opened: '2024-06-01' },
  { creditor: 'Auto', type: 'Auto loan', status: 'Open', balanceCents: 1_200_000, limitCents: 2_000_000, opened: '2023-06-01' },
  { creditor: 'Old card', type: 'Revolving', status: 'Closed', balanceCents: 0, limitCents: 500_000, opened: '2010-01-01' },
];

describe('what-if arithmetic', () => {
  it('counts only open revolving accounts toward credit usage', () => {
    const s = snapshot(accounts, asOf);
    expect(s).toMatchObject({ openAccounts: 3, revolvingAccounts: 2, revolvingBalanceCents: 120_000, revolvingLimitCents: 400_000, utilizationPct: 30, oldestAgeMonths: 72, averageAgeMonths: 44 });
  });
  it('pays down the most heavily used card first and never below zero', () => {
    const after = applyScenario(accounts, { payDownCents: 100_000 });
    expect(after[0]!.balanceCents).toBe(0);
    expect(after[1]!.balanceCents).toBe(20_000);
    expect(snapshot(after, asOf).utilizationPct).toBe(5);
    expect(snapshot(applyScenario(accounts, { payDownCents: 99_999_999 }), asOf).revolvingBalanceCents).toBe(0);
    expect(accounts[0]!.balanceCents).toBe(90_000); // the originals are untouched
  });
  it('adding an account raises the limit and lowers the average age', () => {
    const s = snapshot(applyScenario(accounts, { add: { limitCents: 400_000, balanceCents: 0, opened: '2026-06-01' } }), asOf);
    expect(s).toMatchObject({ revolvingAccounts: 3, revolvingLimitCents: 800_000, utilizationPct: 15, averageAgeMonths: 33 });
  });
  it('reports no usage figure when no limits are reported, and exposes no score of any kind', () => {
    const s = snapshot([{ creditor: 'X', type: null, status: null, balanceCents: 500, limitCents: null, opened: null }], asOf);
    expect(s.utilizationPct).toBeNull();
    expect(s.averageAgeMonths).toBeNull();
    expect(Object.keys(s).some((k) => /score|point/i.test(k))).toBe(false);
  });
});

describe('re-checking a disputed account against a newer report', () => {
  const was: ReportedAccount = { matchKey: 'creditone|4410', balanceCents: 120_000, accountStatus: 'Open', paymentStatus: 'Late 30', dateOfFirstDelinquency: null };
  it('says so when there is nothing newer to compare with', () => expect(recheck(was, null)).toEqual({ kind: 'no_newer_report' }));
  it('reports an account that no longer appears, without calling it deleted', () => {
    expect(recheck(was, { reportDate: '2026-05-01', accounts: [] })).toEqual({ kind: 'not_on_newer_report', reportDate: '2026-05-01' });
  });
  it('lists exactly which reported values changed', () => {
    const r = recheck(was, { reportDate: '2026-05-01', accounts: [{ ...was, balanceCents: 90_000, paymentStatus: 'Current' }] });
    expect(r).toEqual({ kind: 'changed', reportDate: '2026-05-01', changes: [{ field: 'Balance', before: '$1,200.00', after: '$900.00' }, { field: 'Payment status', before: 'Late 30', after: 'Current' }] });
  });
  it('reports no change when the values match, ignoring letter case', () => {
    expect(recheck(was, { reportDate: null, accounts: [{ ...was, accountStatus: 'OPEN' }] }).kind).toBe('unchanged');
  });
});
