import { describe, expect, it } from 'vitest';
import { findBlockedClaims } from '@/lib/compliance/claims';
import { draftReason, REASON_PROMPT, reasonIsClientsOwn } from '@/lib/disputes/reasons';
import { CATEGORIES } from '@/lib/disputes/workflow';
import { isConcreteReason, specificityIssues } from '@/lib/letters/specificity';
import type { Evidence } from '@/lib/reports/analysis';
import type { Bureau } from '@/lib/util';

/**
 * The reasons the new dispute form and bulk drafting pre-fill, as a careful person would write them: dates written out,
 * only the information the evidence is about, nothing asked of a recipient that it cannot do, nothing asked for that
 * is not owed. Each value comes from the evidence passed in; the evidence below is shaped as src/lib/reports/analysis.ts
 * stores it on a finding (dates as 2019-03-05).
 */
const rep = (bureau: Bureau, field: string, value: string, tradeline_id = 't-1'): Evidence => ({ bureau, field, value, source: 'reported', tradeline_id });
const acme = { creditor: 'Acme Bank', last4: '1234', bureau: 'experian' as const };
const ISO = /\b\d{4}-\d{2}-\d{2}\b/;

describe('a request to the creditor to check what it reports', () => {
  it('drafts nothing: the field prompts for what the creditor reports and what the client’s own records show', () => {
    // It used to pre-fill the bureau wording, which asks the creditor to verify the account "with the furnisher": itself.
    expect(draftReason({ category: 'furnisher_direct', ...acme })).toBe('');
    expect(draftReason({ category: 'furnisher_direct', ...acme, evidence: [rep('experian', 'Balance', '$640.00')] })).toBe('');
    expect(reasonIsClientsOwn('furnisher_direct')).toBe(true);
    expect(REASON_PROMPT.furnisher_direct).toMatch(/What the creditor reports/);
    expect(REASON_PROMPT.furnisher_direct).toMatch(/client’s own records show/);
    expect(REASON_PROMPT.furnisher_direct).not.toMatch(/furnisher/);
  });
});

describe('a possible duplicate', () => {
  it('asks that the debt not be reported as owed twice, not that one of the entries go', () => {
    // A collector and the original creditor may both report the debt; the original creditor should then show no balance.
    const oc = draftReason({ category: 'duplicate', ...acme, evidence: [rep('experian', 'Collector balance', '$980.00'), rep('experian', 'Original creditor balance', '$980.00', 't-2'), rep('experian', 'Original creditor named', 'FIRST HORIZON BANK')] });
    expect(oc).toBe('Acme Bank (account ending 1234) appears to be reported more than once or by more than one company for the same debt (Experian reports collector balance $980.00; Experian reports original creditor balance $980.00; Experian reports original creditor named FIRST HORIZON BANK). Please verify whether these are separate obligations and, if they are the same one, make sure the debt is not reported as owed twice.');
    const bare = draftReason({ category: 'duplicate', ...acme });
    expect(bare).toBe('Please verify whether Acme Bank (account ending 1234) is reported more than once, or by more than one company for the same debt, and if it is, make sure the debt is not reported as owed twice.');
    for (const text of [oc, bare, draftReason({ category: 'duplicate', creditor: '' })]) {
      expect(text).not.toMatch(/report(ed)? (it )?once|delet|remov/i);
      expect(findBlockedClaims(text)).toEqual([]);
    }
  });
});

describe('dates in a drafted reason', () => {
  it('a date the evidence holds as 2019-03-05 is written out, in every list and branch', () => {
    const differ = draftReason({ category: 'incorrect_dates', creditor: 'CITIBANK NA', last4: '5521', evidence: [rep('experian', 'Date opened', '2019-03-05'), rep('equifax', 'Date opened', '2018-03-05', 't-2')] });
    expect(differ).toBe('The date opened reported for CITIBANK NA (account ending 5521) differs between the credit reporting agencies (Experian reports March 5, 2019; Equifax reports March 5, 2018). Please verify the date opened with the furnisher and correct it if needed.');
    const outdated = draftReason({ category: 'obsolete', creditor: 'OLD LATE CARD', last4: '3003', evidence: [
      rep('experian', 'Date of first delinquency', '2018-02-10'), { field: 'Age at report review', value: '8.8 years', source: 'derived' }, { field: 'Reporting period generally ends', value: '2025-02-10', source: 'derived' }] });
    expect(outdated).toBe('My Experian credit report shows a date of first delinquency of February 10, 2018 for OLD LATE CARD (account ending 3003). Please verify that date with the furnisher.');
    // Two dates from one report (an older and a newer value), and two kinds of date: each written out.
    const one = draftReason({ category: 'incorrect_dates', ...acme, evidence: [rep('experian', 'Date opened', '2019-03-05'), rep('experian', 'Date opened', '2019-04-09')] });
    expect(one).toBe('Please verify the date opened reported for Acme Bank (account ending 1234) (Experian reports March 5, 2019; Experian reports April 9, 2019) with the furnisher and correct it if needed.');
    const kinds = draftReason({ category: 'incorrect_dates', ...acme, evidence: [rep('experian', 'Date opened', '2019-03-05'), rep('equifax', 'Date of first delinquency', '2021-04-09', 't-2')] });
    expect(kinds).toBe('Please verify the dates reported for Acme Bank (account ending 1234) (Experian reports date opened March 5, 2019; Equifax reports date of first delinquency April 9, 2021), including the date of first delinquency, with the furnisher and correct them if needed.');
    for (const text of [differ, outdated, one, kinds]) expect(text).not.toMatch(ISO);
    // Every category the form drafts for, with dates in its evidence: none is left as 2019-03-05.
    const dated = [rep('experian', 'Date opened', '2019-03-05'), rep('equifax', 'Date opened', '2018-03-05', 't-2'), rep('experian', 'Date of first delinquency', '2018-02-10')];
    for (const category of Object.keys(CATEGORIES).filter((c) => !reasonIsClientsOwn(c) && c !== 'specialty_item')) {
      expect(draftReason({ category, ...acme, evidence: dated }), category).not.toMatch(ISO);
    }
  });

  it('asks about the date of first delinquency only when the evidence is about it', () => {
    // An open, current account whose open dates differ has no date of first delinquency to speak of.
    const opened = draftReason({ category: 'incorrect_dates', ...acme, evidence: [rep('experian', 'Date opened', 'July 15, 2020'), rep('transunion', 'Date opened', 'August 1, 2020', 't-2')] });
    expect(opened).not.toMatch(/first delinquency/);
    expect(draftReason({ category: 'incorrect_dates', ...acme, evidence: [rep('experian', 'Date opened', 'March 5, 2019')] }))
      .toBe('Please verify the date opened reported for Acme Bank (account ending 1234) with the furnisher and correct it if needed.');
    expect(draftReason({ category: 'incorrect_dates', ...acme })).toBe('Please verify the dates reported for Acme Bank (account ending 1234) with the furnisher and correct them if needed.');
    // Where it is the date in question, it is the one named.
    expect(draftReason({ category: 'incorrect_dates', ...acme, evidence: [rep('experian', 'Date of first delinquency', '2019-03-01'), rep('equifax', 'Date of first delinquency', '2019-05-01', 't-2')] }))
      .toBe('The date of first delinquency reported for Acme Bank (account ending 1234) differs between the credit reporting agencies (Experian reports March 1, 2019; Equifax reports May 1, 2019). Please verify the date of first delinquency with the furnisher and correct it if needed.');
    // A collection that shows none: the date is named, and "not reported" is not restated as if it were a value.
    expect(draftReason({ category: 'incorrect_dates', ...acme, evidence: [rep('experian', 'Date of first delinquency', 'not reported')] }))
      .toBe('Please verify the date of first delinquency reported for Acme Bank (account ending 1234) with the furnisher and correct it if needed.');
  });

  it('a collection that shows a later date of first delinquency than its original creditor: the two dates, and no name in the list of dates', () => {
    const reAged = draftReason({ category: 'incorrect_dates', creditor: 'NORTHSTAR RECOVERY', last4: '7003', bureau: 'experian', evidence: [
      rep('experian', 'Date of first delinquency (collection)', '2024-06-01'), rep('experian', 'Date of first delinquency (original creditor)', '2023-01-15', 't-2'), rep('experian', 'Original creditor named', 'FIRST HORIZON BANK')] });
    expect(reAged).toBe('Please verify the date of first delinquency reported for NORTHSTAR RECOVERY (account ending 7003) (Experian reports June 1, 2024 for the collection; Experian reports January 15, 2023 for the original creditor) with the furnisher and correct it if needed.');
    expect(reAged).not.toMatch(/FIRST HORIZON|named|\(collection\)/);
  });

  it('a public record is “this record”, and nothing asks a furnisher about it', () => {
    // A bankruptcy or a judgment is not an account: no furnisher reports it.
    const record = draftReason({ category: 'obsolete', creditor: '', evidence: [{ bureau: 'experian', field: 'Date filed', value: '2015-02-03', source: 'reported' }] });
    expect(record).toBe('My Experian credit report shows a filing date of February 3, 2015 for this record. Please verify that date.');
    expect(record).not.toMatch(/account|furnisher/);
  });

  it('states only what the evidence holds, asks for no removal, and passes the claims guard', () => {
    const evidence = [rep('experian', 'Date opened', '2019-03-05'), rep('equifax', 'Date opened', '2018-03-05', 't-2'), rep('experian', 'Balance', '$1,200.00'), rep('equifax', 'Balance', '$900.00', 't-2')];
    const years = new Set(['2019', '2018']);
    const amounts = new Set(['$1,200.00', '$900.00']);
    for (const category of Object.keys(CATEGORIES).filter((c) => !reasonIsClientsOwn(c) && c !== 'specialty_item')) {
      for (const input of [{ ...acme, evidence }, { ...acme }, { creditor: '', evidence }]) {
        const text = draftReason({ category, ...input });
        expect(text, category).not.toMatch(/\b(delet\w*|remov\w*|eras\w*|expung\w*)\b/i);
        // Every year and every amount in the text is one the evidence holds: nothing is added.
        for (const y of text.match(/\b(?:19|20)\d\d\b/g) ?? []) expect(years.has(y), `${category}: ${y}`).toBe(true);
        for (const a of text.match(/\$[\d,]+\.\d\d/g) ?? []) expect(amounts.has(a), `${category}: ${a}`).toBe(true);
        expect(findBlockedClaims(text), category).toEqual([]);
      }
    }
  });
});

describe('an account the client does not recognize', () => {
  it('states the client’s statement and nothing a bureau cannot give', () => {
    // A bureau holds no account opening documents, and the letter itself asks for the furnisher's name and address.
    expect(draftReason({ category: 'not_mine', ...acme })).toBe('I do not recognize Acme Bank (account ending 1234) as my account.');
    expect(draftReason({ category: 'not_mine', creditor: 'ACME BANK', last4: null })).toBe('I do not recognize ACME BANK as my account.');
    expect(draftReason({ category: 'not_mine', creditor: '' })).toBe('I do not recognize this account as mine.');
    for (const text of [draftReason({ category: 'not_mine', ...acme }), draftReason({ category: 'not_mine', creditor: '' })]) expect(text).not.toMatch(/opening documents|verification|furnisher/);
  });

  it('counts as a concrete reason in the letter, with or without the account’s digits: it is the client’s statement the dispute type records', () => {
    const letter = (reason: string, item: string) => `To whom it may concern:\n\nItem: ${item}\n\nReason for my request:\n${reason}\n\nPlease conduct a reasonable reinvestigation of whether this account belongs to me.\n\nEnclosures: none\n\nSincerely`;
    const cases: [string, { name: string; reference: string | null } | null, string][] = [
      [draftReason({ category: 'not_mine', ...acme }), { name: 'Acme Bank', reference: '1234' }, 'Acme Bank, account ending 1234'],
      [draftReason({ category: 'not_mine', creditor: 'ACME BANK', last4: null }), { name: 'ACME BANK', reference: null }, 'ACME BANK, account ending 5521'],
      [draftReason({ category: 'not_mine', creditor: '' }), null, 'Summit Finance, account ending 4410'],
    ];
    for (const [reason, account, item] of cases) {
      expect(specificityIssues({ body: letter(reason, item), category: 'not_mine', reason, fields: [], account }).map((i) => i.key), reason).toEqual([]);
    }
    expect(isConcreteReason(draftReason({ category: 'not_mine', ...acme }), { name: 'Acme Bank', reference: '1234' })).toBe(true);
    // Only for that dispute type, and only that statement: a bare "not mine" or a request to verify is still not a reason.
    const keys = (reason: string, category: string) => specificityIssues({ body: letter(reason, 'Acme Bank, account ending 1234'), category, reason, fields: category === 'incorrect_balance' ? ['Balance'] : [], account: { name: 'Acme Bank', reference: '1234' } }).map((i) => i.key);
    for (const reason of ['Not mine.', 'Please verify this account.']) expect(keys(reason, 'not_mine'), reason).toEqual(['reason']);
    expect(keys('I do not recognize it.', 'not_mine')).toEqual([]);
    expect(keys('I do not recognize it.', 'incorrect_balance')).toEqual(['reason']);
  });
});

describe('the specific information disputed, for a specialty agency item and “Other”', () => {
  const letter = (reason: string) => `To whom it may concern:\n\nCompany or account name: Superior Court of Ohio\nReference or masked number: 21-CV-0412\n\nWhat I believe is inaccurate, incomplete or unverifiable, and why:\n${reason}\n\nPlease conduct a reasonable reinvestigation of this item.\n\nEnclosures: none\n\nSincerely`;
  const keys = (reason: string, category = 'specialty_item') => specificityIssues({ body: letter(reason), category, reason, fields: [], account: { name: 'Superior Court of Ohio', reference: '21-CV-0412' } }).map((i) => i.key);

  it('a reason that plainly says what is disputed is not asked to name it again', () => {
    for (const reason of [
      'The judgment was vacated on May 12, 2021; a copy of the order is enclosed.',
      'The report shows check 2204 as returned unpaid. My bank statement shows it cleared on June 17, 2025.',
      'This was a joint account with my former spouse, and the report lists it as an individual account of mine.',
    ]) {
      expect(keys(reason), reason).toEqual([]);
      expect(keys(reason, 'other'), reason).toEqual([]);
    }
  });

  it('an empty or bare reason is still held', () => {
    expect(keys('')).toEqual(['information', 'reason']);
    expect(keys('Please verify this item.')).toEqual(['information', 'reason']);
    expect(keys('This item is inaccurate.', 'other')).toEqual(['information', 'reason']);
  });
});
