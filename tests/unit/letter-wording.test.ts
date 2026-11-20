import { describe, expect, it } from 'vitest';
import { buildBrief, contextFor, disputeLetterKey, recommendLetter, type BriefDisputeRow, type BriefRecord, type BriefTradelineRow } from '@/lib/letters/brief';
import { missingFacts, renderLibraryLetter } from '@/lib/letters/library';
import { buildValues, mergeTemplate, unresolvedPlaceholders, type LetterContext } from '@/lib/letters/render';
import { templateByKey } from '@/lib/letters/templates';

/**
 * What a letter says, and which letter is drafted, where the second review found the wording wrong: a collector notice
 * recorded by name, an item still inside its reporting period, the duplicate request, the situation letters drafted on
 * another kind of dispute, the "Other" tick, the goodwill salutation, the follow-up subject, a typed specialty address,
 * the earlier round in a letter to a creditor, and the validation request's title and citation.
 */
const NOW = new Date('2026-11-19T12:00:00Z');
const client: BriefRecord['client'] = { id: '33333333-3333-4333-8333-333333333333', full_name: 'Dana Brooks', address: { line1: '40 Elm St', city: 'Columbus', state: 'OH', zip: '43215' }, ssn_last4: '4321', dob: '1985-03-03', bankruptcy_chapter: null, bankruptcy_filed_on: null, bankruptcy_discharged_on: null };
const REASON = 'Experian reports a balance of $1,200.00. My January 2026 statement shows a balance of $900.00.';
const dispute = (over: Partial<BriefDisputeRow> = {}): BriefDisputeRow => ({
  id: 'd-1', item_label: 'Acme Bank ••1234 (Experian)', target_type: 'bureau', bureau: 'experian', recipient_name: 'Experian', recipient_address: null, category: 'incorrect_balance', workflow: 'standard',
  reason: REASON, fields: ['Balance'], round: 1, status: 'draft', submitted_at: null, response_at: null, due_at: null, outcome: null, client_confirmed_accurate: false, agency: null, agency_item: null, tradeline_id: 't-1', sent_on: null,
  ...over,
});
const tradeline = (over: Partial<BriefTradelineRow> = {}): BriefTradelineRow => ({
  creditor_name: 'Acme Bank', original_creditor: null, account_last4: '1234', bureau: 'experian', item_type: 'tradeline', account_status: 'Open', payment_status: 'Current', payment_history: null,
  balance_cents: 120000, date_opened: '2019-03-03', date_of_first_delinquency: null, report_date: '2026-10-30', report_status: 'approved', ...over,
});
const record = (over: Partial<BriefRecord> = {}): BriefRecord => ({
  today: '2026-11-19', tz: 'America/New_York', client, dispute: dispute(), tradeline: tradeline(), prior: null, finding: null, evidence: ['January 2026 statement'],
  identityDocs: [{ key: 'id', label: 'Government-issued photo ID' }], identityTheftReports: [], notices: [], letters: [], ...over,
});
const draft = (r: BriefRecord, key?: string, recipientAddress?: string) => {
  const brief = buildBrief(r, { now: NOW, recipientAddress });
  const tpl = templateByKey(key ?? disputeLetterKey(brief)!)!;
  return { brief, tpl, body: mergeTemplate(tpl.body, buildValues(contextFor(brief, tpl))) };
};
const say = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

describe('a collector notice recorded by the collector’s name only', () => {
  // Two of the client's debts with one collector; the notice was recorded with no account chosen.
  const pra = (notices: BriefRecord['notices'], over: Partial<BriefDisputeRow> = {}) => record({
    dispute: dispute({ target_type: 'collector', bureau: null, workflow: 'validation', category: 'unverifiable_collection', recipient_name: 'PORTFOLIO RECOVERY ASSOCIATES', item_label: 'PORTFOLIO RECOVERY ASSOCIATES ••9032', fields: [], reason: 'I do not recognize a balance of $612.40 owed to Riverside Medical.', tradeline_id: 't-9032', ...over }),
    tradeline: tradeline({ creditor_name: 'PORTFOLIO RECOVERY ASSOCIATES', account_last4: '9032', item_type: 'collection', account_status: 'Collection', payment_status: null, original_creditor: 'RIVERSIDE MEDICAL', balance_cents: 61240 }),
    identityDocs: [], evidence: [], notices,
  });
  const byName = { collector_name: 'Portfolio Recovery Associates', date_kind: 'received' as const, notice_date: '2026-11-11', tradeline_id: null };

  it('is not used for a debt when the client has another collection account with that collector: no notice date, no Section 809(b)', () => {
    const r = pra([{ ...byName, other_debts: 1 }]);
    const b = buildBrief(r);
    expect(b.circumstances.notice).toBeNull();
    expect(b.context.facts).toMatchObject({ isCollection: true, notice: null });
    const { body } = draft(r, 'validation_request_en', 'PO Box 4410\nDublin, OH 43016');
    expect(body).toContain('I am writing about the debt referenced above. I dispute this debt and ask that you provide validation of it, including:');
    expect(body).not.toMatch(/809\(b\)|1692g|November 11|in response to your written notice|as the statute provides|cease collection/);
    // The recommendation says why, and what makes the notice count for this debt.
    expect(recommendLetter(b)).toMatchObject({ templateKey: 'validation_request_en', missing: [] });
    expect(recommendLetter(b).reason).toBe('A notice from this collector is recorded by name only, and the client has another collection account with that collector on an approved report, so the notice is not used for this debt and the letter asks for validation without citing the 30-day right. If the notice is about this debt, link it to the account under “Collections and bankruptcy” on the client’s page.');
  });

  it('is used when no other collection account with that collector is on an approved report', () => {
    const r = pra([{ ...byName, other_debts: 0 }]);
    expect(buildBrief(r).circumstances.notice).toMatchObject({ kind: 'received', date: '2026-11-11', open: true });
    expect(draft(r, 'validation_request_en').body).toContain('which I received on November 11, 2026. Under Section 809(b)');
    expect(recommendLetter(buildBrief(r)).reason).toMatch(/^A collector notice received on November 11, 2026 is recorded\./);
  });

  it('is not used when the other accounts were not counted', () => {
    // The loader always counts them. A record without the count is not taken to have none.
    expect(buildBrief(pra([byName])).circumstances.notice).toBeNull();
  });

  it('this debt’s own notice still comes first, and a dispute typed by hand is still a collection but gets no date', () => {
    const own = { collector_name: 'PORTFOLIO RECOVERY ASSOCIATES', date_kind: 'received' as const, notice_date: '2026-11-02', tradeline_id: 't-9032' };
    expect(buildBrief(pra([{ ...byName, other_debts: 1 }, own])).circumstances.notice).toMatchObject({ date: '2026-11-02', open: true });
    const typed = { ...pra([{ ...byName, other_debts: 1 }], { tradeline_id: null }), tradeline: null };
    expect(buildBrief(typed).circumstances.notice).toBeNull();
    expect(buildBrief(typed).context.facts).toMatchObject({ isCollection: true, notice: null });
    expect(recommendLetter(buildBrief(typed))).toMatchObject({ templateKey: 'validation_request_en', missing: [] });
    expect(draft(typed, 'validation_request_en').body).not.toMatch(/809\(b\)|November 11/);
  });
});

describe('an “Item may be past the reporting period” dispute', () => {
  // A collection first delinquent on May 9, 2023: its reporting period generally runs until November 5, 2030.
  const inside = record({
    dispute: dispute({ category: 'obsolete', fields: [], reason: 'My Experian credit report shows a date of first delinquency of May 9, 2023 for MIDLAND CREDIT MANAGEMENT (account ending 6640). Please verify that date with the furnisher.' }),
    tradeline: tradeline({ creditor_name: 'MIDLAND CREDIT MANAGEMENT', account_last4: '6640', item_type: 'collection', account_status: 'Collection', payment_status: null, date_of_first_delinquency: '2023-05-09' }),
  });

  it('gets the outdated-item letter whatever the date, so an item inside its period is refused, never drafted as a general dispute', () => {
    const b = buildBrief(inside);
    expect(disputeLetterKey(b)).toBe('outdated_item_en');
    const refusal = 'By the reported date of first delinquency, this item’s reporting period runs until November 5, 2030. It is not past the reporting period.';
    expect(missingFacts('outdated_item_en', b.context)).toEqual([refusal]);
    const rec = recommendLetter(b);
    expect(rec).toMatchObject({ templateKey: 'outdated_item_en', missing: [refusal] });
    // The line above the refusal says nothing about a period having ended.
    expect(rec.reason).toBe('The dispute says the item is past its reporting period.');
  });

  it('with no reported date, or no account, the refusal says what to use instead', () => {
    const noDate = buildBrief(record({ dispute: dispute({ category: 'obsolete', fields: [] }), tradeline: tradeline({ item_type: 'collection', account_status: 'Collection', payment_status: null }) }));
    expect(disputeLetterKey(noDate)).toBe('outdated_item_en');
    expect(recommendLetter(noDate).missing.join(' ')).toMatch(/no date of first delinquency[\s\S]*Use the general dispute/);
    const typed = buildBrief(record({ dispute: dispute({ category: 'obsolete', fields: [], tradeline_id: null, item_label: 'Old Card ••7788 (Experian)', reason: 'The collection is shown with a first delinquency date in 2015.' }), tradeline: null }));
    expect(disputeLetterKey(typed)).toBe('outdated_item_en');
    expect(recommendLetter(typed).missing).toEqual(['This dispute names no account on a report, so there is no reported date of first delinquency and no reporting period to state. Use the general dispute, and give in the reason the date the client’s report shows.']);
    // Past the period, the letter is drafted as before.
    const past = record({ dispute: dispute({ category: 'obsolete', fields: [] }), tradeline: tradeline({ item_type: 'collection', account_status: 'Collection', payment_status: null, date_of_first_delinquency: '2018-07-14' }) });
    expect(recommendLetter(buildBrief(past))).toMatchObject({ templateKey: 'outdated_item_en', missing: [], reason: 'By the reported date of first delinquency, the reporting period appears to have ended on January 10, 2026.' });
  });
});

describe('the duplicate letter', () => {
  it('asks that the debt not be reported as owed twice, which is right for a collector and the original creditor too', () => {
    const { body } = draft(record({ dispute: dispute({ category: 'duplicate', fields: [] }) }), 'duplicate_account_en');
    expect(body).toContain('Please conduct a reasonable reinvestigation of whether these entries are the same obligation and, if they are, update my file so that the debt is not reported as owed twice. Please send me the results in writing');
    expect(body).not.toMatch(/reported once/);
  });
});

describe('a letter about the balance, the status, or the payment history or dates', () => {
  const ctx = (category: string, fields: string[] = []): LetterContext => ({ client, now: NOW, dispute: { item_label: 'Acme Bank ••1234 (Experian)', bureau: 'experian', recipient_name: 'Experian', reason: REASON, fields, round: 1, tradeline: { creditor_name: 'Acme Bank', account_last4: '1234' }, category, target_type: 'bureau' } });
  const why = (key: string, category: string, fields: string[] = []) => missingFacts(key, ctx(category, fields)).join(' ');

  it('is drafted only for a dispute about that, so the subject, the listed field and the reason never disagree', () => {
    expect(why('inaccurate_balance_en', 'incorrect_status', ['Account status'])).toBe('This letter is about the balance reported for the account. This dispute is not entered that way, so the letter is not drafted for it. If that is what the client disputes, start a new dispute for the account and choose the type “Balance may be incorrect”.');
    expect(why('inaccurate_status_en', 'incorrect_balance', ['Balance'])).toBe('This letter is about the status reported for the account. This dispute is not entered that way, so the letter is not drafted for it. If that is what the client disputes, start a new dispute for the account and choose the type “Account or payment status”.');
    expect(why('inaccurate_history_dates_en', 'incorrect_status', ['Account status'])).toBe('This letter is about the payment history or dates reported for the account. This dispute is not entered that way, so the letter is not drafted for it. If that is what the client disputes, start a new dispute for the account and choose the type “Late payment accuracy” or “Dates (opened / delinquency)”.');
    for (const [key, category] of [['inaccurate_balance_en', 'duplicate'], ['inaccurate_status_en', 'obsolete'], ['inaccurate_history_dates_en', 'incorrect_balance'], ['inaccurate_balance_en', 'not_mine']]) {
      expect(why(key!, category!), `${key} on ${category}`).toMatch(/^This letter is about .* This dispute is not entered that way/);
    }
    // Each one on its own kind of dispute.
    expect(why('inaccurate_balance_en', 'incorrect_balance')).toBe('');
    expect(why('inaccurate_status_en', 'incorrect_status')).toBe('');
    expect(why('inaccurate_history_dates_en', 'incorrect_payment_history')).toBe('');
    expect(why('inaccurate_history_dates_en', 'incorrect_dates')).toBe('');
    // "Other" with the matching field ticked says what is disputed; without it, it does not.
    expect(why('inaccurate_balance_en', 'other', ['Balance'])).toBe('');
    expect(why('inaccurate_status_en', 'other', ['Account status'])).toBe('');
    expect(why('inaccurate_history_dates_en', 'other', ['Dates'])).toBe('');
    expect(why('inaccurate_history_dates_en', 'other', ['Payment history', 'Other'])).toBe('');
    expect(why('inaccurate_balance_en', 'other', ['Account status'])).toMatch(/^This letter is about the balance/);
    expect(why('inaccurate_history_dates_en', 'other', ['Balance'])).toMatch(/^This letter is about the payment history or dates/);
    expect(why('inaccurate_status_en', 'other')).toMatch(/^This letter is about the status/);
    // The general dispute carries any of them.
    for (const category of ['incorrect_balance', 'incorrect_status', 'incorrect_dates', 'other']) expect(why('bureau_dispute_en', category), category).toBe('');
  });
});

describe('the specific information listed in a letter', () => {
  it('leaves out the “Other” tick, and prints no line when it is the only one', () => {
    const only = draft(record({ dispute: dispute({ category: 'other', fields: ['Other'] }) }), 'bureau_dispute_en').body;
    expect(only).not.toMatch(/Specific information I am asking you to review/);
    const mixed = draft(record({ dispute: dispute({ category: 'other', fields: ['Balance', 'Other'] }) }), 'bureau_dispute_en').body;
    expect(mixed).toContain('Specific information I am asking you to review: Balance.\n');
    expect(mixed).not.toMatch(/Other\./);
  });
});

describe('the goodwill request', () => {
  it('opens as every other letter does, not with the name the report prints in capitals', () => {
    const r = record({ dispute: dispute({ category: 'goodwill', target_type: 'furnisher', bureau: null, workflow: 'goodwill', recipient_name: 'DISCOVER BANK', item_label: 'DISCOVER BANK ••1234', fields: [], reason: 'My payment for March 2025 was 30 days late while I was in the hospital. Every payment since has been on time.' }) });
    const { body } = draft(r, 'goodwill_en', 'PO Box 30943\nSalt Lake City, UT 84130');
    expect(body).toContain('Re: Goodwill request — DISCOVER BANK, account ending 1234\n\nTo whom it may concern:\n\nI am writing about the account above.');
    expect(body).not.toMatch(/Dear /);
    expect(unresolvedPlaceholders(body)).toEqual([]);
  });
});

describe('the follow-up', () => {
  it('names the earlier letter by the day it was sent, as its first sentence does', () => {
    const r = record({ dispute: dispute({ status: 'submitted', submitted_at: '2026-10-05T15:00:00Z', sent_on: '2026-10-05', due_at: '2026-11-04T15:00:00Z' }) });
    const { body } = draft(r, 'follow_up_en');
    expect(body).toContain('Re: Status of the dispute I sent on October 5, 2026 — Acme Bank, account ending 1234\n');
    expect(body).toContain('On October 5, 2026 I sent you a dispute about the item above.');
    expect(body).not.toMatch(/my dispute dated/);
  });
});

describe('the address typed for a specialty agency with no verified address', () => {
  const telecheck = (address: string) => record({
    dispute: dispute({ target_type: 'agency', bureau: null, workflow: 'specialty', category: 'specialty_item', agency: 'telecheck', agency_item: { name: 'Corner Market', reference: 'check 2204' }, recipient_name: 'TeleCheck Services, Inc.', recipient_address: address, item_label: 'Corner Market · check 2204 (TeleCheck)', fields: [], tradeline_id: null, reason: 'The report shows check 2204 as returned unpaid. My bank statement shows it cleared on June 17, 2025.' }),
    tradeline: null,
  });

  it('does not print the agency’s name twice when staff copied it with the address', () => {
    for (const first of ['TeleCheck Services, Inc.', 'TELECHECK SERVICES INC', 'Telecheck  Services Inc.']) {
      const { body } = draft(telecheck(`${first}\nAttn: Resolution Department\nP.O. Box 6806\nHagerstown, MD 21741`));
      expect(body, first).toContain('Columbus, OH 43215\n\nTeleCheck Services, Inc.\nAttn: Resolution Department\nP.O. Box 6806\nHagerstown, MD 21741\n');
    }
    // A first line that is not the agency's name is kept as typed.
    expect(draft(telecheck('Resolution Department\nP.O. Box 6806\nHagerstown, MD 21741')).body).toContain('\nTeleCheck Services, Inc.\nResolution Department\nP.O. Box 6806\n');
    // Only the name was typed: there is no address, and the letter says so.
    expect(draft(telecheck('TeleCheck Services, Inc.')).body).toContain('\nTeleCheck Services, Inc.\n[RECIPIENT ADDRESS NEEDED]\n');
  });
});

describe('the earlier round in a letter to a creditor', () => {
  const creditor = (outcome: string, responseAt: string | null = '2026-10-05T16:00:00Z') => record({
    dispute: dispute({ target_type: 'furnisher', bureau: null, workflow: 'furnisher_direct', category: 'furnisher_direct', recipient_name: 'CAPITAL CITY BANK', item_label: 'CAPITAL CITY BANK ••4417', round: 2, reason: 'You still report a balance of $1,284.00 to Experian.\n\nNew information since my previous request: Your own letter dated October 21, 2026 confirms the balance was $884.00 as of October 1, 2026.' }),
    tradeline: tradeline({ creditor_name: 'CAPITAL CITY BANK', account_last4: '4417', balance_cents: 128400, date_opened: '2018-06-01', report_date: '2026-10-28' }),
    prior: { round: 1, submitted_at: '2026-09-10T15:00:00Z', sent_on: '2026-09-10', response_at: responseAt, outcome },
  });
  const history = (outcome: string, responseAt?: string | null) => draft(creditor(outcome, responseAt), 'creditor_dispute_en', 'PO Box 1\nAnytown, ST 00000').body;

  it('says what was written to that company and what it replied, in a creditor’s terms', () => {
    expect(history('verified')).toContain('\nI wrote to you about this account on September 10, 2026. Your reply, which I received on October 5, 2026, said the information was verified.\n\nReason for my request:');
    expect(history('no_response')).toContain('\nI wrote to you about this account on September 10, 2026. I have no record of receiving a reply.\n');
    expect(history('frivolous')).toContain('\nI wrote to you about this account on September 10, 2026. Your reply, which I received on October 5, 2026, said you needed more information before you would review it.\n');
    expect(history('unresolved', null)).toContain('\nI wrote to you about this account on September 10, 2026. Your reply did not resolve the matter.\n');
    expect(history('updated')).toContain('\nI wrote to you about this account on September 10, 2026.\n\nReason for my request:');
    for (const o of ['verified', 'no_response', 'frivolous', 'unresolved', 'updated']) expect(history(o), o).not.toMatch(/previously disputed|Your results|reinvestigat|investigat/i);
  });

  it('keeps the bureau wording in a letter to a bureau', () => {
    const bureau = record({ dispute: dispute({ round: 2 }), prior: { round: 1, submitted_at: '2026-09-10T15:00:00Z', sent_on: '2026-09-10', response_at: '2026-10-05T16:00:00Z', outcome: 'verified' } });
    expect(draft(bureau, 'inaccurate_balance_en').body).toContain('I previously disputed this item on September 10, 2026. Your results, which I received on October 5, 2026, stated that the information was verified.\n');
  });
});

describe('the debt validation request', () => {
  const collector = (notice: NonNullable<LetterContext['facts']>['notice']): LetterContext => ({
    client, now: NOW, recipientAddress: 'PO Box 9\nAnytown, ST 00000', facts: { today: '2026-11-19', isCollection: true, notice },
    dispute: { item_label: 'Northstar Recovery ••5521', bureau: null, recipient_name: 'Northstar Recovery', reason: 'I do not recognize this debt of $640.00.', fields: [], round: 1, tradeline: { creditor_name: 'Northstar Recovery', account_last4: '5521' }, category: 'unverifiable_collection', target_type: 'collector' },
  });

  it('is not titled with the statute, which it cites only within the 30 days', () => {
    expect(templateByKey('validation_request_en')!.name).toBe('Debt validation request');
    expect(templateByKey('validation_request_en')!.name.split(' — ')[0]).not.toMatch(/809|FDCPA|§/);
  });

  it('cites the statute for the dispute, and asks for the list as a request', () => {
    const r = renderLibraryLetter('debt_validation', collector({ kind: 'received', date: '2026-11-02', open: true }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.body).toContain(`I am writing in response to your written notice about the debt referenced above, which I received on ${say('2026-11-02')}. Under Section 809(b) of the Fair Debt Collection Practices Act (15 U.S.C. § 1692g(b)), I dispute this debt. I ask that you provide validation of it. Please include:\n\n  1. The amount of the debt and how it was calculated;`);
    expect(r.body).not.toMatch(/validation of it, including:/);
    expect(r.body).toContain('Until you mail me verification of the debt, I ask that you cease collection of it, as the statute provides.');
    // Without an open notice nothing is cited, and the wording is unchanged.
    const late = renderLibraryLetter('debt_validation', collector({ kind: 'received', date: '2026-08-02', open: false }));
    expect(late.ok && late.body).toContain('I am writing in response to your written notice about the debt referenced above. I dispute this debt and ask that you provide validation of it, including:');
    expect(late.ok && late.body).not.toMatch(/809\(b\)|Please include/);
  });
});
