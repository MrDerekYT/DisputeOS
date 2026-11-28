import { describe, expect, it } from 'vitest';
import { accountLabel, accountTags, confirmedLabel, groupLabel, isCollectorAccount, KIND_META, labelBasis, labelOrder, readKind, storedLabel, wordsSupport, type KindInput } from '@/lib/credit/account-kind';
import { categoryForAccount } from '@/lib/disputes/workflow';

const T = (o: Partial<KindInput> = {}): KindInput => ({
  item_type: 'tradeline', creditor_name: 'ACME BANK', original_creditor: null, account_type: 'Revolving', account_status: null, payment_status: null, payment_history: null, remarks: null, ...o,
});
const kind = (o: Partial<KindInput>) => readKind(T(o)).kind;

describe('what the report’s words say an account is', () => {
  it('collections: listed under collections, or worded as one', () => {
    expect(readKind(T({ item_type: 'collection' }))).toEqual({ kind: 'collection', field: 'section', words: null });
    expect(readKind(T({ item_type: 'collection', payment_status: 'Collection' }))).toEqual({ kind: 'collection', field: 'payment_status', words: 'Collection' });
    for (const s of ['PLACED FOR COLLECTION', 'Collection: Unpaid', 'Paid collection', 'In Collection', 'Transferred to collections', 'Medical collection']) expect(kind({ account_status: s }), s).toBe('collection');
    expect(kind({ account_type: 'Open Account (COLLECTION AGENCY/ATTORNEY)' })).toBe('collection');
    expect(kind({ account_type: 'Open Account (FACTORING COMPANY ACCOUNT)' })).toBe('collection');
    expect(kind({ payment_history: 'Mar 2024 90; Apr 2024 COL' })).toBe('collection');
  });

  it('charge-offs, paid or not', () => {
    for (const s of ['Charged Off', 'Charge-off', 'Charge off', 'Account charged off. $690 written off.', 'Paid in Settlement; was Charged Off as Bad Debt', 'Account Paid in Full; was a Charge-off']) {
      expect(kind({ payment_status: s }), s).toBe('charge_off');
    }
    expect(kind({ remarks: 'Estimated month and year this item will be removed: 12/2024 · PROFIT AND LOSS WRITEOFF' })).toBe('charge_off');
    expect(kind({ payment_history: 'Jan 2021 30; Feb 2021 60; Mar 2021 C/O' })).toBe('charge_off');
  });

  it('bankruptcy, foreclosure, repossession and settled', () => {
    expect(kind({ remarks: 'Included in bankruptcy' })).toBe('bankruptcy');
    expect(kind({ account_status: 'Discharged in Chapter 7 bankruptcy' })).toBe('bankruptcy');
    expect(kind({ item_type: 'collection', remarks: 'Included in bankruptcy' })).toBe('bankruptcy'); // the more telling of the two
    expect(kind({ account_status: 'Foreclosure' })).toBe('foreclosure');
    expect(kind({ remarks: 'Deed in lieu of foreclosure' })).toBe('foreclosure');
    expect(kind({ payment_status: 'Repossession' })).toBe('repossession');
    expect(kind({ payment_status: 'Voluntary surrender' })).toBe('repossession');
    expect(kind({ payment_history: 'May 2023 60; Jun 2023 RPO' })).toBe('repossession');
    expect(kind({ account_status: 'Settled for less than full balance' })).toBe('settled');
  });

  it('late now, from the status in any of its wordings', () => {
    for (const s of ['Late 30', '30 days late', 'Late 90', '30 - 59 Days Past Due', 'Account 90 Days Past Due Date', 'Open. $690 past due as of Oct 2026.', '120 days past due', 'Delinquent']) {
      expect(kind({ payment_status: s }), s).toBe('late');
    }
    expect(readKind(T({ account_status: 'Open', payment_status: 'Late 30' }))).toEqual({ kind: 'late', field: 'payment_status', words: 'Late 30' });
  });

  it('late before: a past clause, the month-by-month history or the remarks; never a date or an amount', () => {
    expect(kind({ payment_status: 'Paid, Closed; was 30 days past due' })).toBe('was_late');
    expect(readKind(T({ payment_status: 'Paid, Closed; was Paid as agreed', payment_history: 'May 2024 30; Jun 2024 60; Jul 2024 90' })))
      .toEqual({ kind: 'was_late', field: 'payment_history', words: 'May 2024 30' });
    expect(kind({ payment_status: 'Current', payment_history: 'CC30CC' })).toBe('was_late');
    expect(kind({ account_status: 'Closed', remarks: 'Previously past due' })).toBe('was_late');
    // A date or a term is not a late payment.
    expect(kind({ account_status: 'Closed 12/30/2023' })).toBe('no_negative');
    expect(kind({ account_status: 'Open', remarks: 'Terms: $120 per month; paid Monthly for 30 months' })).toBe('no_negative');
    expect(kind({ payment_status: 'Current. $0 past due' })).toBe('good');
  });

  it('good standing and nothing negative shown', () => {
    for (const s of ['Current', 'Pays As Agreed', 'Open/Never late.', 'Paid, Closed/Never late.', 'Transferred, closed/Never late.', 'Current; Paid or Paying as Agreed', 'Current Account', 'Paid, Closed; was Paid as agreed']) {
      expect(kind({ payment_status: s }), s).toBe('good');
    }
    for (const s of ['Open', 'Closed', 'Paid', 'Paid. Closed']) expect(kind({ account_status: s }), s).toBe('no_negative');
  });

  it('negative information of no other kind, including the removal month TransUnion prints only for negative items', () => {
    expect(kind({ payment_status: 'Derogatory' })).toBe('negative');
    expect(readKind(T({ remarks: 'Estimated month and year this item will be removed: 08/2033 · Terms: Paid Monthly' })))
      .toEqual({ kind: 'negative', field: 'remarks', words: 'Estimated month and year this item will be removed: 08/2033' });
  });

  it('what the review found: negative wordings never read green, and nothing reads negative from an amount of zero', () => {
    // Still owed to the same creditor: negative, but not a collector's account.
    expect(kind({ account_status: 'Transferred to recovery' })).toBe('negative');
    expect(accountTags(T({ account_status: 'Transferred to recovery' }))).toEqual([]);
    // Settled for less, in the Metro 2 comment's own words, even beside "Never late".
    expect(kind({ remarks: 'Account legally paid in full for less than the full balance' })).toBe('settled');
    expect(kind({ payment_status: 'Paid, Closed/Never late.', remarks: 'Account paid in full for less than the full balance' })).toBe('settled');
    // A negated "paid as agreed" is not good standing.
    expect(kind({ payment_status: 'Not paid as agreed' })).toBe('negative');
    expect(kind({ payment_status: 'Not current' })).toBe('negative');
    expect(kind({ payment_status: 'Never delinquent' })).toBe('good');
    // "$0.00 past due" is not late, with or without cents.
    expect(kind({ account_status: 'Open. $0.00 past due as of Oct 2026.' })).toBe('no_negative');
    expect(kind({ account_status: 'Open. $0 past due as of Oct 2026.' })).toBe('no_negative');
    expect(kind({ account_status: 'Open. $690.00 past due as of Oct 2026.' })).toBe('late');
    // Equifax keeps the amounts it prints: a zero is nothing; an amount is a charge-off or past due.
    expect(kind({ account_status: 'Open', payment_status: 'Pays As Agreed', remarks: 'Amount past due: $0 · Charge-off amount: $0.00' })).toBe('good');
    expect(kind({ account_status: 'Closed', payment_status: 'Charge Off', remarks: 'Charge-off amount: $1,200' })).toBe('charge_off');
    expect(kind({ account_status: 'Closed', remarks: 'Charge-off amount: $1,200' })).toBe('charge_off');
    // Experian's history summary, kept as the payment status, is the latest late month, not the status today.
    expect(readKind(T({ account_status: 'Open', payment_status: '30 days past due as of Mar 2024' }))).toEqual({ kind: 'was_late', field: 'payment_status', words: '30 days past due as of Mar 2024' });
    expect(kind({ account_status: 'Open. $120 past due as of Oct 2026.', payment_status: 'Open. $120 past due as of Oct 2026.' })).toBe('late');
  });

  it('not labelled when the words say nothing either way', () => {
    expect(readKind(T())).toEqual({ kind: 'unknown', field: null, words: null });
    expect(kind({ payment_status: 'Unpaid' })).toBe('unknown');
    expect(kind({ account_status: 'Not paid' })).toBe('unknown');
    expect(kind({ account_status: 'Unrated' })).toBe('unknown');
  });

  it('reads bare Metro 2 status codes and manner-of-payment ratings', () => {
    expect(kind({ account_status: '97' })).toBe('charge_off');
    expect(kind({ account_status: '93' })).toBe('collection');
    expect(kind({ account_status: '71' })).toBe('late');
    expect(kind({ account_status: '11' })).toBe('good');
    expect(kind({ account_status: '64' })).toBe('charge_off'); // paid in full, was a charge-off
    expect(kind({ payment_status: 'R1' })).toBe('good');
    expect(kind({ payment_status: 'I3' })).toBe('late');
    expect(kind({ payment_status: 'R9' })).toBe('negative');
    expect(kind({ payment_status: 'R7' })).toBe('bankruptcy');
  });
});

describe('flags', () => {
  it('medical, student loan, child support, authorized user, a dispute noted, transferred', () => {
    expect(accountTags(T({ creditor_name: 'RIVERSIDE HOSPITAL' }))).toEqual(['medical']);
    expect(accountTags(T({ creditor_name: 'ABC RECOVERY', original_creditor: 'Valley Radiology Associates' }))).toEqual(['medical']);
    expect(accountTags(T({ creditor_name: 'NAVIENT' }))).toEqual(['student_loan']);
    expect(accountTags(T({ creditor_name: 'EXAMPLE STATE CHILD SUPPORT OFFICE', account_type: 'Open Account (CHILD SUPPORT)' }))).toEqual(['child_support']);
    expect(accountTags(T({ remarks: 'Responsibility: Authorized User' }))).toEqual(['authorized_user']);
    expect(accountTags(T({ remarks: 'ACCT INFO DISPUTED BY CONSUMR' }))).toEqual(['disputed']);
    expect(accountTags(T({ payment_status: 'Transferred, closed/Never late.' }))).toEqual(['transferred']);
    expect(accountTags(T({ account_status: 'Transferred to recovery' }))).toEqual([]); // that is a collection, not a transfer
  });
});

describe('the label shown: a person, then the report, then AI', () => {
  it('a person’s choice wins, and the report’s words are kept beside it when they differ', () => {
    const l = accountLabel({ ...T({ payment_status: 'Charged Off' }), kind_label: { kind: 'good', by: 'staff' } });
    expect(l).toMatchObject({ kind: 'good', by: 'staff', reported: { kind: 'charge_off', words: 'Charged Off' } });
    expect(labelBasis(l)).toBe('Labelled by staff. The report says charge-off (“Charged Off”).');
  });

  it('an AI suggestion is used only where the report’s words say nothing', () => {
    const ai = { kind: 'collection', by: 'ai', words: 'MIDLAND CREDIT MANAGEMENT', field: 'creditor_name' };
    expect(accountLabel({ ...T({ creditor_name: 'MIDLAND CREDIT MANAGEMENT' }), kind_label: ai })).toMatchObject({ kind: 'collection', by: 'ai' });
    expect(labelBasis(accountLabel({ ...T({ creditor_name: 'MIDLAND CREDIT MANAGEMENT' }), kind_label: ai }))).toBe('AI suggestion, from the company name. Company name: “MIDLAND CREDIT MANAGEMENT”. Nothing is done with it until a person confirms it.');
    // Shown, but nothing is done with it: the label that counts is still the report's words.
    expect(confirmedLabel({ ...T({ creditor_name: 'MIDLAND CREDIT MANAGEMENT' }), kind_label: ai })).toMatchObject({ kind: 'unknown', by: 'rules' });
    // An AI reading of good standing is a hint for a person, never a label: the account stays grey.
    const hinted = accountLabel({ ...T({ payment_status: 'Satisfactory' }), kind_label: { kind: 'unknown', by: 'ai', hint: 'good', words: 'Satisfactory', field: 'payment_status' } });
    expect(hinted).toMatchObject({ kind: 'unknown', aiHint: { kind: 'good', words: 'Satisfactory' } });
    expect(labelBasis(hinted)).toBe('AI reads good standing in “Satisfactory”. Only the report’s own words or a person mark an account good: confirm it if the report says so.');
    expect(accountLabel({ ...T({ payment_status: 'Current' }), kind_label: ai })).toMatchObject({ kind: 'good', by: 'rules' });
    // AI asked and could not tell: still not labelled, and the page says so.
    const tried = accountLabel({ ...T(), kind_label: { kind: 'unknown', by: 'ai' } });
    expect(tried).toMatchObject({ kind: 'unknown', aiTried: true });
    expect(labelBasis(tried)).toBe('AI could not tell either. Choose a label.');
  });

  it('ignores a stored label that is not one', () => {
    expect(storedLabel({ kind: 'great', by: 'staff' })).toBeNull();
    expect(storedLabel({ kind: 'good', by: 'someone' })).toBeNull();
    expect(storedLabel(null)).toBeNull();
    expect(accountLabel({ ...T({ payment_status: 'Late 30' }), kind_label: { kind: 'great', by: 'staff' } }).kind).toBe('late');
  });

  it('a collector’s account is listed under collections, typed as a collector’s, or labelled one by a person; a creditor’s own account in collection is not', () => {
    expect(isCollectorAccount(T({ item_type: 'collection' }))).toBe(true);
    expect(isCollectorAccount(T({ account_type: 'Open Account (COLLECTION AGENCY/ATTORNEY)' }))).toBe(true);
    expect(isCollectorAccount(T({ account_type: 'Open Account (FACTORING COMPANY ACCOUNT)' }))).toBe(true);
    expect(isCollectorAccount(T({ account_type: '48' }))).toBe(true);
    expect(isCollectorAccount({ ...T(), kind_label: { kind: 'collection', by: 'staff' } })).toBe(true);
    // In collection, or transferred to recovery, but still the creditor's own account: negative, with no collector.
    expect(isCollectorAccount(T({ payment_status: 'Collection' }))).toBe(false);
    expect(isCollectorAccount(T({ account_status: '93' }))).toBe(false);
    expect(isCollectorAccount(T({ account_status: 'Transferred to recovery' }))).toBe(false);
    // An AI suggestion makes nothing a collector's account.
    expect(isCollectorAccount({ ...T(), kind_label: { kind: 'collection', by: 'ai', words: 'X', field: 'creditor_name' } })).toBe(false);
  });

  it('checks that words an AI quotes can show the kind it gave', () => {
    expect(wordsSupport('collection', 'MIDLAND CREDIT MANAGEMENT', 'creditor_name')).toBe(true);
    expect(wordsSupport('good', 'MIDLAND CREDIT MANAGEMENT', 'creditor_name')).toBe(false); // a name shows only a collection
    expect(wordsSupport('charge_off', 'CHRG OFF', 'payment_status')).toBe(true); // an abbreviation the rules do not read
    expect(wordsSupport('charge_off', 'Unrated', 'remarks')).toBe(false);
    expect(wordsSupport('negative', 'Unrated', 'remarks')).toBe(false);
    expect(wordsSupport('was_late', 'for 30 months', 'remarks')).toBe(false); // a term, not lateness
    expect(wordsSupport('was_late', 'May 2024 30', 'payment_history')).toBe(true);
    expect(wordsSupport('charge_off', 'Paid as agreed', 'payment_status')).toBe(false); // words that say the opposite
    expect(wordsSupport('good', 'Satisfactory', 'payment_status')).toBe(true);
    expect(wordsSupport('good', 'Satisfactory', 'remarks')).toBe(false); // good only from a status or a history
    expect(wordsSupport('good', 'Unpaid', 'payment_status')).toBe(false);
    expect(wordsSupport('good', 'Not paid', 'payment_status')).toBe(false);
  });

  it('one account on several bureaus is bad when any of them reports something negative', () => {
    const g = groupLabel([T({ payment_status: 'Current' }), T({ payment_status: '30 days late' }), T()]);
    expect(g.label.kind).toBe('late');
    expect(g.differs).toBe(true);
    expect(groupLabel([T({ payment_status: 'Current' }), T()]).label.kind).toBe('good'); // a bureau that says nothing does not hide one that says good
    expect(groupLabel([T(), T()]).label.kind).toBe('unknown');
    expect(groupLabel([T({ payment_status: 'Current' }), T({ payment_status: 'Pays as agreed' })]).differs).toBe(false);
  });

  it('lists bad accounts first, most serious first, then the unlabelled, then the good', () => {
    const kinds = ['good', 'unknown', 'late', 'collection', 'no_negative', 'charge_off'] as const;
    expect([...kinds].sort((a, b) => labelOrder(a) - labelOrder(b))).toEqual(['collection', 'charge_off', 'late', 'unknown', 'good', 'no_negative']);
    expect(Object.values(KIND_META).filter((m) => m.tone === 'bad')).toHaveLength(9);
  });
});

describe('the type of dispute suggested for an account', () => {
  it('follows the confirmed label, only for accounts that carry something negative, and is never "not mine"', () => {
    expect(categoryForAccount('collection', true)).toBe('unverifiable_collection'); // a collector's account
    expect(categoryForAccount('collection', false)).toBe('incorrect_status'); // a creditor's own account in collection: no validation request
    expect(categoryForAccount('late', false)).toBe('incorrect_payment_history');
    expect(categoryForAccount('was_late', false)).toBe('incorrect_payment_history');
    expect(categoryForAccount('charge_off', false)).toBe('incorrect_status');
    expect(categoryForAccount('bankruptcy', true)).toBe('bankruptcy_included');
    // A person who says a listed collection is in good standing gets no suggestion.
    expect(categoryForAccount(confirmedLabel({ ...T({ item_type: 'collection' }), kind_label: { kind: 'good', by: 'staff' } }).kind, true)).toBeUndefined();
    for (const k of ['good', 'no_negative', 'unknown'] as const) expect(categoryForAccount(k, true)).toBeUndefined();
    for (const k of Object.keys(KIND_META) as (keyof typeof KIND_META)[]) for (const c of [true, false]) expect(['not_mine', 'identity_theft']).not.toContain(categoryForAccount(k, c));
  });
});
