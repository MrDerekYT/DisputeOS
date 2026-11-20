import { describe, expect, it } from 'vitest';
import { protect } from '@/lib/ai/protected';
import { findBlockedClaims } from '@/lib/compliance/claims';
import {
  briefParagraphs, buildBrief, contextFor, disputeLetterKey, letterForCategory, recommendLetter, reportedValues, styleSeed, VOICE_LINES, voiceFor,
  type BriefDisputeRow, type BriefRecord, type BriefTradelineRow, type LetterBrief,
} from '@/lib/letters/brief';
import { LETTER_LIBRARY, missingFacts } from '@/lib/letters/library';
import { editableWording } from '@/lib/letters/overlap';
import { buildValues, mergeTemplate, PARAGRAPH_FIELDS, unresolvedPlaceholders } from '@/lib/letters/render';
import { approvalBlockers } from '@/lib/letters/service';
import { specificityIssues } from '@/lib/letters/specificity';
import { letterTerms, toneWordIssue } from '@/lib/letters/tailor';
import { ALL_TEMPLATES, MERGE_FIELDS, templateByKey } from '@/lib/letters/templates';

// ---------------------------------------------------------------- fixtures: two clients' files, as the loader reads them
const NOW = new Date('2026-11-19T12:00:00Z');
const REASON = 'Experian reports a balance of $1,200.00. My January 2026 statement shows a balance of $900.00.';

const jordan: BriefRecord['client'] = { id: '11111111-1111-4111-8111-111111111111', full_name: 'Jordan Rivera', address: { line1: '123 Main St', city: 'Tampa', state: 'FL', zip: '33602' }, ssn_last4: '4321', dob: '1985-03-03', bankruptcy_chapter: null, bankruptcy_filed_on: null, bankruptcy_discharged_on: null };
const maria: BriefRecord['client'] = { id: '22222222-2222-4222-8222-222222222222', full_name: 'Maria Chen', address: { line1: '9 Pine Ave', line2: 'Apt 4', city: 'Seattle', state: 'WA', zip: '98101' }, ssn_last4: '9876', dob: '1990-07-21', bankruptcy_chapter: '7', bankruptcy_filed_on: '2024-02-01', bankruptcy_discharged_on: '2024-06-03' };

const dispute = (over: Partial<BriefDisputeRow> = {}): BriefDisputeRow => ({
  id: 'd-1', item_label: 'Acme Bank ••1234 (Experian)', target_type: 'bureau', bureau: 'experian', recipient_name: 'Experian', recipient_address: null, category: 'incorrect_balance', workflow: 'standard',
  reason: REASON, fields: ['Balance'], round: 1, status: 'draft', submitted_at: null, response_at: null, due_at: null, outcome: null, client_confirmed_accurate: false, agency: null, agency_item: null, tradeline_id: 't-1', sent_on: null,
  ...over,
});
const tradeline = (over: Partial<BriefTradelineRow> = {}): BriefTradelineRow => ({
  creditor_name: 'Acme Bank', original_creditor: null, account_last4: '1234', bureau: 'experian', item_type: 'tradeline', account_status: 'Open', payment_status: 'Current', payment_history: 'CCCCCC',
  balance_cents: 120000, date_opened: '2019-03-03', date_of_first_delinquency: null, report_date: '2026-10-30', report_status: 'approved', ...over,
});
const record = (over: Partial<BriefRecord> = {}): BriefRecord => ({
  today: '2026-11-19', tz: 'America/New_York', client: jordan, dispute: dispute(), tradeline: tradeline(), prior: null, finding: null,
  evidence: ['January 2026 statement'], identityDocs: [{ key: 'id', label: 'Government-issued photo ID' }, { key: 'proof_of_address', label: 'Proof of current address' }],
  identityTheftReports: [], notices: [], letters: [], ...over,
});

/** Jordan: a first-round balance dispute with Experian, with a statement and accepted identity documents. */
const A = record({ finding: { title: 'Balance differs between bureaus for Acme Bank', basis: 'potential_discrepancy', evidence: [{ bureau: 'experian', field: 'Balance', value: '$1,200.00', source: 'reported' }, { bureau: 'equifax', field: 'Balance', value: '$900.00', source: 'reported' }] } });
/** Maria: the SAME category and the same reason, but round 2 with Equifax after a "verified" result, other documents, nothing accepted for identity. */
const B = record({
  client: maria,
  dispute: dispute({ id: 'd-2', item_label: 'Harbor Credit Union ••7788 (Equifax)', bureau: 'equifax', recipient_name: 'Equifax Information Services LLC', round: 2, tradeline_id: 't-2' }),
  tradeline: tradeline({ creditor_name: 'Harbor Credit Union', account_last4: '7788', bureau: 'equifax', balance_cents: 64050, date_opened: '2021-08-14', report_date: null, account_status: 'Paid. Closed', payment_status: '30 days past due' }),
  prior: { round: 1, submitted_at: '2026-08-04T15:00:00Z', sent_on: '2026-08-03', response_at: '2026-09-01T16:00:00Z', outcome: 'verified' },
  evidence: ['Payoff letter from Harbor Credit Union', 'Stmt. From the credit union for August'], identityDocs: [],
});

const draft = (r: BriefRecord, key?: string, recipientAddress?: string) => {
  const brief = buildBrief(r, { now: NOW, recipientAddress });
  const tpl = templateByKey(key ?? disputeLetterKey(brief)!)!;
  const context = contextFor(brief, tpl);
  return { brief, tpl, context, body: mergeTemplate(tpl.body, buildValues(context)) };
};
/** The protected terms the tailoring step builds for this letter (src/lib/letters/tailor-load.ts). */
const terms = (r: BriefRecord, body: string) => letterTerms({
  clientName: r.client.full_name, address: r.client.address, body,
  names: [r.dispute?.recipient_name, r.tradeline?.creditor_name, r.tradeline?.original_creditor, r.dispute?.item_label],
  facts: [r.dispute?.reason, r.tradeline?.account_status, r.tradeline?.payment_status],
});

describe('letter brief: assembled from the record, with nothing added', () => {
  it('states the recipient, the account as that bureau reports it, what is disputed and why, the history, the enclosures and the circumstances', () => {
    const b = buildBrief(A);
    expect(b.recipient).toEqual({ kind: 'bureau', name: 'Experian' });
    expect(b.account).toEqual({
      creditor: 'Acme Bank', last4: '1234', bureau: 'experian', bureauLabel: 'Experian', reportDate: '2026-10-30', isCollection: false,
      reported: [{ key: 'opened', text: 'date opened March 3, 2019' }, { key: 'balance', text: 'balance $1,200.00' }],
    });
    expect(b.disputed).toEqual({
      category: 'incorrect_balance', label: 'Balance may be incorrect', workflow: 'standard', fields: ['Balance'], reason: REASON, newInformation: null,
      finding: { title: 'Balance differs between bureaus for Acme Bank', basis: 'potential_discrepancy', evidence: ['Experian: Balance $1,200.00', 'Equifax: Balance $900.00'] },
    });
    expect(b.history).toEqual({ round: 1, status: 'draft', sentOn: null, dueOn: null, responseOn: null, outcome: null, prior: null, letters: [] });
    expect(b.enclosures).toEqual({ evidence: ['January 2026 statement'], identity: [{ key: 'id', label: 'Government-issued photo ID' }, { key: 'proof_of_address', label: 'Proof of current address' }] });
    expect(b.circumstances).toEqual({ bankruptcy: null, identityTheftReports: [], notice: null, confirmedAccurate: false });
    expect(b.seed).toBe(styleSeed(jordan.id));
    // The same record always gives the same brief and the same letter: nothing random, no clock.
    expect(buildBrief(A)).toEqual(b);
    expect(draft(A).body).toBe(draft(A).body);
  });

  it('reads stored instants as days where the agency works, and prefers the sent date staff recorded', () => {
    const b = buildBrief(B);
    expect(b.history).toMatchObject({ round: 2, prior: { round: 1, sentOn: '2026-08-03', responseOn: '2026-09-01', outcome: 'verified' } });
    // 01:30 UTC on the 20th is still the 19th in New York.
    const late = buildBrief(record({ dispute: dispute({ status: 'submitted', submitted_at: '2026-11-20T01:30:00Z', due_at: '2026-12-20T01:30:00Z' }) }));
    expect(late.history).toMatchObject({ sentOn: '2026-11-19', dueOn: '2026-12-19' });
    expect(buildBrief(B).circumstances.bankruptcy).toEqual({ chapter: '7', filedOn: '2024-02-01', dischargedOn: '2024-06-03' });
  });

  it('restates only the reported values the dispute is about, and never one the report does not carry', () => {
    const t = tradeline({ date_of_first_delinquency: '2021-06-01', original_creditor: 'Example Bank', payment_status: 'Charge-off' });
    const keys = (category: string, fields: string[] = []) => reportedValues(t, category, fields).map((v) => v.key);
    expect(keys('incorrect_balance')).toEqual(['opened', 'balance']);
    expect(keys('incorrect_status')).toEqual(['opened', 'account_status', 'payment_status']);
    expect(keys('incorrect_dates')).toEqual(['opened', 'dofd']);
    expect(keys('not_mine')).toEqual(['opened', 'balance']);
    expect(keys('other', ['Payment history', 'Dates'])).toEqual(['opened', 'payment_status', 'dofd']);
    expect(keys('unverifiable_collection')).toEqual(['opened', 'original_creditor', 'balance']);
    expect(reportedValues(tradeline({ balance_cents: null, date_opened: null }), 'incorrect_balance', ['Balance'])).toEqual([]);
    expect(reportedValues(tradeline({ balance_cents: 0 }), 'incorrect_balance', [])).toContainEqual({ key: 'balance', text: 'balance $0.00' });
    // Values read from another bureau's report are not put in this bureau's mouth, and nor are values from a report nobody has approved yet.
    expect(buildBrief(record({ tradeline: tradeline({ bureau: 'transunion' }) })).account!.reported).toEqual([]);
    expect(buildBrief(record({ tradeline: tradeline({ report_status: 'pending_review' }) })).account!.reported).toEqual([]);
    expect(draft(record({ tradeline: tradeline({ report_status: 'pending_review' }) })).body).not.toContain('As it appears on');
  });

  it('carries a collector notice only for a letter to that collector, with its validation period', () => {
    const collector = record({
      dispute: dispute({ target_type: 'collector', bureau: null, workflow: 'validation', category: 'unverifiable_collection', recipient_name: 'Northstar Recovery', item_label: 'Northstar Recovery ••5521', fields: [], reason: 'I do not recognize this debt of $640.00.', tradeline_id: 't-9' }),
      tradeline: tradeline({ creditor_name: 'Northstar Recovery', account_last4: '5521', item_type: 'collection', original_creditor: 'Example Bank', balance_cents: 64000 }), identityDocs: [],
      notices: [{ collector_name: 'Someone Else LLC', date_kind: 'received', notice_date: '2026-11-10', tradeline_id: 't-other' }, { collector_name: 'NORTHSTAR  RECOVERY', date_kind: 'received', notice_date: '2026-11-02', tradeline_id: null }],
    });
    expect(buildBrief(collector).circumstances.notice).toEqual({ kind: 'received', date: '2026-11-02', endsOn: '2026-12-02', daysLeft: 13, open: true });
    expect(draft(collector).body).toContain('in response to your written notice about the debt referenced above, which I received on November 2, 2026. Under Section 809(b)');
    expect(buildBrief(collector).context.facts).toMatchObject({ isCollection: true, notice: { kind: 'received', date: '2026-11-02', open: true } });
    expect(recommendLetter(buildBrief(collector))).toMatchObject({ templateKey: 'validation_request_en', name: 'Debt validation request', reason: 'A collector notice received on November 2, 2026 is recorded. The validation period generally ends on December 2, 2026.' });
    // Once the period has ended the date is no longer stated in the letter, and the reason says what that generally means.
    const lateRecord = { ...collector, today: '2026-12-20' };
    expect(buildBrief(lateRecord).circumstances.notice).toMatchObject({ open: false });
    expect(draft(lateRecord).body).toContain('I am writing in response to your written notice about the debt referenced above. I dispute this debt and ask that you provide validation of it, including:');
    expect(draft(lateRecord).body).not.toMatch(/809\(b\)|as the statute provides|November 2, 2026/);
    expect(recommendLetter(buildBrief(lateRecord)).reason).toMatch(/generally ended on December 2, 2026\. A request can still be sent; the collector is generally not required to answer it in the same way, so the letter asks without citing that right\./);
    // No notice on file: the letter does not say it answers one, and claims no right that depends on its date.
    const none = { ...collector, notices: [] };
    expect(recommendLetter(buildBrief(none)).reason).toMatch(/No collector notice is recorded for this debt, so the letter disputes the debt and asks for validation without citing the 30-day right/);
    expect(draft(none).body).toContain('I am writing about the debt referenced above. I dispute this debt and ask that you provide validation of it, including:');
    expect(draft(none).body).not.toMatch(/in response to your|809\(b\)|as the statute provides/);
    // A collector that has written to the client is a collection even before it is on any report: the 30 days do not wait.
    const unreported = { ...collector, tradeline: null, dispute: { ...collector.dispute!, tradeline_id: null } };
    expect(buildBrief(unreported).context.facts).toMatchObject({ isCollection: true });
    expect(recommendLetter(buildBrief(unreported))).toMatchObject({ templateKey: 'validation_request_en', missing: [] });
    expect(draft(unreported).body).toContain('which I received on November 2, 2026. Under Section 809(b)');
    // Neither on a report nor written about: nothing shows a collection, and the letter is not drafted.
    const unknown = { ...unreported, notices: [] };
    expect(buildBrief(unknown).context.facts).toMatchObject({ isCollection: false, notice: null });
    expect(recommendLetter(buildBrief(unknown)).missing.join(' ')).toMatch(/apply to collections only[\s\S]*record the collector’s notice/);
    // The same notices never reach a bureau letter.
    expect(buildBrief(record({ notices: collector.notices })).circumstances.notice).toBeNull();
  });

  it('never uses the notice of another debt held by the same collector', () => {
    // One collector, two of the client's debts. This dispute is about account 7788; the newer notice is for 9911.
    // 15 U.S.C. § 1692g(b) gives the 30-day right from the notice for the debt, so 9911's date must not reach this letter.
    const midland = (notices: BriefRecord['notices'], over: Partial<BriefDisputeRow> = {}) => record({
      dispute: dispute({ target_type: 'collector', bureau: null, workflow: 'validation', category: 'unverifiable_collection', recipient_name: 'Midland Credit', item_label: 'MIDLAND CREDIT ••7788', fields: [], reason: 'I do not recognize the amount of $412.50.', tradeline_id: 't-7788', ...over }),
      tradeline: tradeline({ creditor_name: 'MIDLAND CREDIT', account_last4: '7788', item_type: 'collection', original_creditor: 'FIRST COAST BANK', balance_cents: 41250 }), identityDocs: [], evidence: [], notices,
    });
    const other = { collector_name: 'MIDLAND CREDIT', date_kind: 'received' as const, notice_date: '2026-11-15', tradeline_id: 't-9911' };
    const own = { collector_name: 'MIDLAND CREDIT', date_kind: 'received' as const, notice_date: '2026-08-12', tradeline_id: 't-7788' };
    // Newest first, as the loader returns them: the other debt's open notice comes before this debt's closed one.
    const both = midland([other, own]);
    expect(buildBrief(both).circumstances.notice).toMatchObject({ date: '2026-08-12', open: false });
    expect(draft(both).body).toContain('I am writing in response to your written notice about the debt referenced above. I dispute this debt and ask that you provide validation of it, including:');
    expect(draft(both).body).not.toMatch(/November 15|809\(b\)|1692g|as the statute provides|cease collection/);
    expect(recommendLetter(buildBrief(both)).reason).toMatch(/^The validation period for the notice received on August 12, 2026 generally ended/);
    // Only the other debt's notice is on file: this debt has none, and the letter does not say it answers one.
    const onlyOther = midland([other]);
    expect(buildBrief(onlyOther).circumstances.notice).toBeNull();
    expect(buildBrief(onlyOther).context.facts).toMatchObject({ isCollection: true, notice: null }); // still a collection: the report says so
    expect(draft(onlyOther).body).toContain('I am writing about the debt referenced above. I dispute this debt and ask that you provide validation of it, including:');
    expect(draft(onlyOther).body).not.toMatch(/November 15|809\(b\)|in response to your written notice/);
    expect(recommendLetter(buildBrief(onlyOther)).reason).toMatch(/No collector notice is recorded for this debt/);
    // A notice recorded by the collector's name alone does not outrank this debt's own notice, and is not displaced by the other debt's.
    const byName = { collector_name: 'Midland Credit', date_kind: 'received' as const, notice_date: '2026-11-10', tradeline_id: null };
    expect(buildBrief(midland([other, byName, own])).circumstances.notice).toMatchObject({ date: '2026-08-12' });
    expect(buildBrief(midland([other, byName])).circumstances.notice).toMatchObject({ date: '2026-11-10', open: true });
    // The same debt on another report row (another bureau's report, or a later import): the loader marks it, and it counts.
    const sameDebt = { ...other, notice_date: '2026-11-12', tradeline_id: 't-7788-on-equifax', same_account: true };
    expect(buildBrief(midland([other, sameDebt])).circumstances.notice).toMatchObject({ date: '2026-11-12', open: true });
    // A dispute typed by hand, with no report account: a notice linked to some account of that collector is not assumed to be about it.
    const typed = { ...midland([other, own], { tradeline_id: null }), tradeline: null };
    expect(buildBrief(typed).circumstances.notice).toBeNull();
    expect(buildBrief(typed).context.facts).toMatchObject({ isCollection: false });
    expect(recommendLetter(buildBrief(typed)).missing.join(' ')).toMatch(/a notice recorded for another account does not count/);
  });
});

describe('optional paragraphs: each one only when the fact is on file', () => {
  const para = (r: BriefRecord, identityDocs = true) => briefParagraphs(buildBrief(r), { identityDocs });

  it('adds every paragraph field to the merge list, and each merges to nothing without a brief', () => {
    for (const f of PARAGRAPH_FIELDS) expect(MERGE_FIELDS).toContain(f);
    const plain = buildValues({ client: jordan });
    for (const f of PARAGRAPH_FIELDS) expect(plain[f]).toBe('');
  });

  it('the account line is there only for an account on that bureau’s report', () => {
    expect(para(A).reported_text).toBe('As it appears on my Experian credit report dated October 30, 2026: date opened March 3, 2019; balance $1,200.00.\n');
    expect(para(B).reported_text).toBe('As it appears on my Equifax credit report: date opened August 14, 2021; balance $640.50.\n');
    expect(para(record({ tradeline: null })).reported_text).toBe('');
    expect(draft(record({ tradeline: null })).body).not.toContain('As it appears on');
  });

  it('the earlier-round paragraph is there only when an earlier round was sent, and says what came back', () => {
    expect(para(A).history_text).toBe('');
    expect(draft(A).body).not.toMatch(/disputed this item on/);
    expect(para(B).history_text).toBe('I previously disputed this item on August 3, 2026. Your results, which I received on September 1, 2026, stated that the information was verified.\n');
    const prior = (over: Partial<NonNullable<BriefRecord['prior']>>) => para({ ...B, prior: { ...B.prior!, ...over } }).history_text;
    expect(prior({ outcome: 'no_response' })).toBe('I previously disputed this item on August 3, 2026. I have no record of receiving the results of that dispute.\n');
    expect(prior({ outcome: 'frivolous' })).toBe('I previously disputed this item on August 3, 2026. Your notice, which I received on September 1, 2026, said that you needed more information before you would investigate.\n');
    expect(prior({ outcome: 'unresolved', response_at: null })).toBe('I previously disputed this item on August 3, 2026. Your results did not resolve my dispute.\n');
    expect(prior({ outcome: 'updated' })).toBe('I previously disputed this item on August 3, 2026.\n');
    expect(para({ ...B, dispute: { ...B.dispute!, round: 3 }, prior: { ...B.prior!, round: 2 } }).history_text).toMatch(/^I previously disputed this item on August 3, 2026\./);
    // Never sent, or no earlier round on record: nothing is said.
    expect(prior({ sent_on: null, submitted_at: null })).toBe('');
    expect(para({ ...B, prior: null }).history_text).toBe('');
    // In the letter it sits above the reason heading, so the specificity check never reads it as part of the reason.
    const { body } = draft(B, 'inaccurate_balance_en');
    expect(body).toMatch(/Specific information I am asking you to review: Balance\.\n\nI previously disputed this item on August 3, 2026\.[^\n]+\n\nReason for my request:\n/);
    expect(specificityIssues({ body: body.replace(REASON, 'Please verify this item.'), category: 'incorrect_balance', reason: 'Please verify this item.', fields: ['Balance'], account: { name: 'Harbor Credit Union', reference: '7788' } }).map((i) => i.key)).toEqual(['reason']);
  });

  it('the enclosure sentence names the documents actually attached and accepted, and is absent when there are none', () => {
    expect(para(A).enclosed_text).toBe('I have enclosed the following document: January 2026 statement. To confirm my identity, I have also enclosed a copy of my government-issued photo ID and proof of my current address.');
    expect(para(B).enclosed_text).toBe('I have enclosed the following documents: Payoff letter from Harbor Credit Union; Stmt. From the credit union for August.');
    expect(para(record({ evidence: [], identityDocs: [{ key: 'id', label: 'Government-issued photo ID' }, { key: 'proof_of_address', label: 'Proof of current address' }, { key: 'ssn_proof', label: 'Proof of Social Security number' }] })).enclosed_text)
      .toBe('To confirm my identity, I have enclosed a copy of my government-issued photo ID, proof of my current address and proof of my Social Security number.');
    expect(para(record({ evidence: [], identityDocs: [] })).enclosed_text).toBe('');
    // Identity documents go only with a dispute letter to a bureau or a specialty agency.
    expect(para(A, false).enclosed_text).toBe('I have enclosed the following document: January 2026 statement.');
    const creditor = draft(record({ dispute: dispute({ target_type: 'furnisher', bureau: null, workflow: 'furnisher_direct', category: 'furnisher_direct', recipient_name: 'Acme Bank', item_label: 'Acme Bank ••1234' }) }));
    expect(creditor.tpl.key).toBe('creditor_dispute_en');
    expect(creditor.body).not.toMatch(/photo ID/);
    expect(creditor.body).toContain('Enclosures:\n  - January 2026 statement\n\nSincerely,');
    // The sentence and the list at the foot of the letter always name the same documents.
    const { body } = draft(A);
    expect(body).toContain('Enclosures:\n  - January 2026 statement\n  - Copy: Government-issued photo ID\n  - Copy: Proof of current address\n');
    expect(draft(record({ evidence: [], identityDocs: [] })).body).toContain('\nEnclosures: none\n');
  });
});

describe('two clients, same kind of dispute: materially different letters without any AI', () => {
  const a = draft(A, 'inaccurate_balance_en');
  const b = draft(B, 'inaccurate_balance_en');

  it('differ in the account as reported, the history, the enclosures and the closing wording', () => {
    expect(a.tpl.key).toBe(b.tpl.key);
    expect(a.body).not.toBe(b.body);
    const only = (x: string, y: string) => x.split('\n').filter((l) => l.trim() && !y.split('\n').includes(l));
    const [onlyA, onlyB] = [only(a.body, b.body), only(b.body, a.body)];
    // Beyond the name, address, recipient and item label, the body of the letter itself differs.
    expect(onlyA.filter((l) => /As it appears on|I have enclosed|Copy:/.test(l)).length).toBeGreaterThanOrEqual(3);
    expect(onlyB.filter((l) => /As it appears on|I previously disputed|I have enclosed|Enclosures|Payoff/.test(l)).length).toBeGreaterThanOrEqual(4);
    expect(a.body).toContain('As it appears on my Experian credit report dated October 30, 2026: date opened March 3, 2019; balance $1,200.00.');
    expect(b.body).toContain('As it appears on my Equifax credit report: date opened August 14, 2021; balance $640.50.');
    expect(b.body).toContain('— request 2');
    expect(a.body).not.toContain('— request');
    // Even with the same reason typed for both, fewer than two thirds of the lines between the salutation and the signature are shared.
    const lines = (s: string) => s.slice(s.indexOf('To whom it may concern:'), s.indexOf('Sincerely,')).split('\n').filter((l) => l.trim());
    const shared = lines(a.body).filter((l) => lines(b.body).includes(l)).length;
    expect(shared / lines(a.body).length).toBeLessThan(0.67);
  });

  it('each client keeps one voice across their letters, and the voices differ between clients', () => {
    const voiceOf = (r: BriefRecord, key: string) => { const p = draft(r, key).context.paragraphs!; return `${p.lead_in}|${p.courtesy}`; };
    expect(voiceOf(A, 'inaccurate_balance_en')).toBe(voiceOf(A, 'bureau_dispute_en'));
    expect(voiceOf(A, 'inaccurate_balance_en')).toBe(voiceOf(record({ dispute: dispute({ id: 'd-7', bureau: 'transunion', category: 'not_mine' }) }), 'not_my_account_en'));
    expect(voiceOf(A, 'inaccurate_balance_en')).not.toBe(voiceOf(B, 'inaccurate_balance_en'));
    for (const body of [draft(A).body, draft(B).body]) expect(VOICE_LINES.filter((v) => body.includes(v)).length).toBeGreaterThanOrEqual(1);
    expect(voiceFor(styleSeed(jordan.id))).toEqual(voiceFor(styleSeed(jordan.id)));
    const voices = new Set(Array.from({ length: 60 }, (_, i) => { const v = voiceFor(styleSeed(`client-${i}`)); return `${v.leadIn}|${v.contact}|${v.thanks}`; }));
    expect(voices.size).toBeGreaterThan(30);
    expect(new Set(Array.from({ length: 60 }, (_, i) => voiceFor(styleSeed(`client-${i}`)).tone)).size).toBeGreaterThanOrEqual(4);
  });
});

describe('what the brief writes is held to the same rules as the library', () => {
  const samples = [
    draft(A), draft(B, 'inaccurate_balance_en'), draft(B, 'bureau_dispute_en'),
    draft(record({ dispute: dispute({ category: 'incorrect_status', fields: ['Account status'] }), tradeline: tradeline({ payment_status: '120 days past due' }) })),
    draft(record({ client: maria, dispute: dispute({ category: 'bankruptcy_included', fields: [], reason: 'This account was included in my bankruptcy and still shows a balance of $2,500.00.' }) })),
    draft({ ...B, prior: { ...B.prior!, outcome: 'frivolous' } }, 'not_my_account_en'),
    draft({ ...B, prior: { ...B.prior!, outcome: 'no_response' } }, 'inaccurate_history_dates_en'),
    draft({ ...B, prior: { ...B.prior!, outcome: 'unresolved' } }, 'duplicate_account_en'),
    draft(record({ dispute: dispute({ target_type: 'furnisher', bureau: null, workflow: 'furnisher_direct', category: 'furnisher_direct', recipient_name: 'Acme Bank', item_label: 'Acme Bank ••1234' }) }), undefined, 'PO Box 1, Anytown, ST 00000'),
    draft(record({ dispute: dispute({ target_type: 'agency', bureau: null, workflow: 'specialty', category: 'specialty_item', agency: 'chexsystems', agency_item: { name: 'First Coast Bank', reference: 'xxxx4321', amount: '$312.40' }, recipient_name: 'Chex Systems, Inc.', item_label: 'First Coast Bank · xxxx4321 (ChexSystems)', fields: [], round: 2, tradeline_id: null, reason: 'The disclosure lists an unpaid balance of $312.40. My bank statement dated 04/02/2024 shows the account was paid in full.' }), tradeline: null, prior: B.prior })),
  ];

  it('no deletion demand, no threat, no deadline of its own, no result promise, and nothing left unfilled', () => {
    for (const s of samples) {
      const text = s.body;
      expect(findBlockedClaims(text), s.tpl.key).toEqual([]);
      expect(text, s.tpl.key).not.toMatch(/\b(delet\w*|remov\w*|eras\w*|expung\w*|wip(e|ed|ing))\b/i);
      expect(text, s.tpl.key).not.toMatch(/\b(demand\w*|must|shall|failure|fail(s|ed)? to|otherwise|lawsuit|sue|attorney|legal action|court|complaint|damages|violat\w*|penalt\w*)\b/i);
      expect(text, s.tpl.key).not.toMatch(/\b(within|in|no later than)\s+\d+\s+(business\s+|calendar\s+)?days\b/i);
      expect(text, s.tpl.key).not.toMatch(/\b(will|is going to|are going to)\s+(be\s+)?(corrected|updated|blocked|approved|improve\w*|increase\w*|raise\w*)\b|\bguarant\w*|\bscore\b/i);
      if (s.tpl.kind !== 'specialty_dispute') expect(unresolvedPlaceholders(text), s.tpl.key).toEqual([]); // ChexSystems asks for a date of birth and SSN a person types
      if (s.tpl.kind !== 'specialty_dispute') expect(approvalBlockers(text), s.tpl.key).toEqual([]);
      expect(text.split('\n').length, s.tpl.key).toBeLessThan(54);
      expect(text.trimEnd().endsWith(`Sincerely,\n\n${s.context.client.full_name}`), s.tpl.key).toBe(true);
    }
  });

  it('a dispute letter the brief drafts passes the specificity check', () => {
    for (const s of samples.filter((x) => x.tpl.kind === 'bureau_dispute')) {
      const d = s.context.dispute!;
      const category = s.brief.disputed!.category;
      expect(specificityIssues({ body: s.body, category, reason: d.reason, fields: d.fields, account: { name: d.tradeline!.creditor_name, reference: d.tradeline!.account_last4 } }), s.tpl.key).toEqual([]);
    }
  });

  it('every fact the brief writes is out of reach of an AI wording suggestion: only the salutation, the voice lines and the sign-off are editable', () => {
    const status = { ...B, dispute: { ...B.dispute!, category: 'incorrect_status', fields: ['Account status'] } };
    const records = [A, B, status, { ...B, prior: { ...B.prior!, outcome: 'frivolous' } }, { ...B, prior: { ...B.prior!, outcome: 'no_response' } }, { ...B, prior: { ...B.prior!, outcome: 'unresolved', response_at: null } }];
    for (const r of records) {
      for (const key of ['inaccurate_balance_en', 'bureau_dispute_en', 'not_my_account_en', 'inaccurate_status_en']) {
        const { body, brief } = draft(r, key);
        const v = voiceFor(brief.seed);
        const allowed = new Set(['To whom it may concern:', 'Sincerely,', v.leadIn, [v.contact, v.thanks].filter(Boolean).join(' ')].filter(Boolean));
        const editable = editableWording(body, terms(r, body)).split('\n');
        for (const line of editable) expect(allowed.has(line), `${key}: “${line}” is editable`).toBe(true);
        // And the wording that is editable is really there for the model to work with.
        expect(editable.join(' ').length, key).toBeGreaterThanOrEqual(60);
      }
    }
    // Checked the hard way too: a status or a document label that contains a full stop is still locked, piece by piece.
    const { body } = draft(status);
    expect(body).toContain('account status “Paid. Closed”; payment status “30 days past due”.');
    const masked = protect(body, terms(status, body)).masked.replace(/\[\[LOCKED_\d+\]\]/g, '▮');
    expect(masked).not.toMatch(/Closed|From the credit union|Payoff|Harbor|Maria|Chen|Seattle|Pine|\d|\$/);
  });

  it('every voice line is plain courtesy: editable under the protection rules, with no demand, deadline, promise or request for a result', () => {
    expect(VOICE_LINES.length).toBeGreaterThanOrEqual(12);
    for (const line of VOICE_LINES) {
      expect(protect(line).locked, line).toEqual([]);
      expect(toneWordIssue(line), line).toBeNull();
      expect(findBlockedClaims(line), line).toEqual([]);
      expect(line, line).not.toMatch(/\d|\b(report|account|dispute|verif|investigat|correct|updat|law|right)\w*/i);
    }
    // The built-in templates leave room for them; a template without the fields simply does not carry them.
    expect(ALL_TEMPLATES.filter((t) => t.body.includes('{{courtesy}}')).length).toBeGreaterThanOrEqual(15);
    for (const t of ALL_TEMPLATES.filter((x) => x.body.includes('{{history_text}}'))) expect(t.body.indexOf('{{history_text}}'), t.key).toBeLessThan(t.body.indexOf('{{reason}}'));
    expect(templateByKey('redispute_new_information_en')!.body).not.toContain('{{history_text}}'); // its opening already states the earlier dispute
  });
});

describe('recommend a letter', () => {
  const rec = (r: BriefRecord) => recommendLetter(buildBrief(r));
  const sent = (over: Partial<BriefDisputeRow>, more: Partial<BriefRecord> = {}) => record({ dispute: dispute({ status: 'submitted', submitted_at: '2026-10-01T15:00:00Z', sent_on: '2026-10-01', due_at: '2026-11-01T15:00:00Z', ...over }), letters: [{ template_key: 'inaccurate_balance_en', kind: 'bureau_dispute', status: 'sent' }], ...more });

  it('before the dispute is sent: the letter written for its situation, with a one-line reason from the file', () => {
    expect(rec(A)).toEqual({ templateKey: 'inaccurate_balance_en', name: 'Inaccurate balance', reason: 'The dispute is about the balance Experian reports ($1,200.00).', missing: [], exists: false });
    expect(rec(record({ dispute: dispute({ category: 'incorrect_status' }) }))).toMatchObject({ templateKey: 'inaccurate_status_en', reason: 'The dispute is about the status Experian reports (“Open”).' });
    expect(rec(record({ dispute: dispute({ category: 'not_mine' }) }))).toMatchObject({ templateKey: 'not_my_account_en', reason: 'The client does not recognize this account, and it is not entered as identity theft.' });
    // Round 2 after "verified" with something new on file: the re-dispute. Without anything new: the category's own letter.
    const again = { ...B, dispute: { ...B.dispute!, reason: `${REASON}\n\nNew information since my previous request: the payoff letter dated September 12, 2026 confirms a balance of $0.00.` } };
    expect(rec(again)).toMatchObject({ templateKey: 'redispute_new_information_en', name: 'Re-dispute with new information', reason: 'Round 2 follows a result of “verified as reported” received on September 1, 2026, and new information is on file for it.' });
    expect(rec(B)).toMatchObject({ templateKey: 'inaccurate_balance_en' });
    // An outdated item with no reported date falls back to the general dispute, and the reason says why.
    expect(rec(record({ dispute: dispute({ category: 'obsolete', fields: [] }), tradeline: tradeline({ item_type: 'collection', payment_status: 'Collection' }) })))
      .toMatchObject({ templateKey: 'bureau_dispute_en', name: 'General dispute', reason: expect.stringMatching(/no date of first delinquency/) });
    expect(rec(record({ dispute: dispute({ category: 'obsolete', fields: [] }), tradeline: tradeline({ item_type: 'collection', payment_status: 'Collection', date_of_first_delinquency: '2018-07-14' }) })))
      .toMatchObject({ templateKey: 'outdated_item_en', reason: 'By the reported date of first delinquency, the reporting period appears to have ended on January 10, 2026.' });
    // An account that is only late: the reason says what has aged, and that the account itself stays.
    expect(rec(record({ dispute: dispute({ category: 'obsolete', fields: [] }), tradeline: tradeline({ payment_status: '30 days late', date_of_first_delinquency: '2019-03-10' }) })))
      .toMatchObject({ templateKey: 'outdated_item_en', reason: 'By the reported date of first delinquency, the reporting period for the late payment information from that date appears to have ended on March 10, 2026. The account itself stays reportable, so the letter is about that late payment information only.' });
    expect(rec(record({ dispute: dispute({ category: 'other' }) }))).toMatchObject({ templateKey: 'bureau_dispute_en', reason: 'No letter is written for this kind of dispute, so the general dispute carries the reason as entered.' });
  });

  it('names the fact a letter still needs instead of drafting around it', () => {
    const theft = rec(record({ dispute: dispute({ category: 'identity_theft' }) }));
    expect(theft).toMatchObject({ templateKey: 'identity_theft_block_en', name: 'Identity theft block request' });
    expect(theft.missing.join(' ')).toMatch(/needs an identity theft report/);
    expect(rec(record({ dispute: dispute({ category: 'identity_theft' }), identityTheftReports: ['FTC identity theft report'] }))).toMatchObject({ missing: [], reason: 'An identity theft report is on file (FTC identity theft report).' });
    // The report alone is not enough: the block also rests on accepted proof of the client's identity.
    const noId = rec(record({ dispute: dispute({ category: 'identity_theft' }), identityTheftReports: ['FTC identity theft report'], identityDocs: [{ key: 'proof_of_address', label: 'Proof of current address' }] }));
    expect(noId.missing).toEqual([expect.stringMatching(/also needs proof of the client’s identity[\s\S]*government-issued photo ID/)]);
    expect(buildBrief(record()).context.facts).toMatchObject({ identityProof: ['id', 'proof_of_address'] });
    // The creditor letter says in its reason that it carries no duty, with the citation.
    const creditor = rec(record({ dispute: dispute({ target_type: 'furnisher', bureau: null, workflow: 'furnisher_direct', category: 'furnisher_direct', recipient_name: 'Acme Bank', item_label: 'Acme Bank ••1234' }) }));
    expect(creditor).toMatchObject({ templateKey: 'creditor_dispute_en', name: 'Letter to the creditor', missing: [] });
    expect(creditor.reason).toMatch(/not required to investigate a dispute prepared by a credit repair company \(15 U\.S\.C\. § 1681s-2\(a\)\(8\)\(G\); 12 CFR 1022\.43\(b\)\(2\)\), so the dispute with the bureau is the route that carries a duty/);
    expect(creditor.reason).not.toMatch(/client’s own letter|signed and sent by the client/);
    expect(rec(record({ dispute: dispute({ category: 'bankruptcy_included' }) })).missing.join(' ')).toMatch(/No bankruptcy is recorded/);
    expect(rec(record({ client: maria, dispute: dispute({ category: 'bankruptcy_included' }) }))).toMatchObject({ templateKey: 'bankruptcy_included_en', missing: [], reason: 'A Chapter 7 bankruptcy filed on February 1, 2024 is recorded for this client.' });
  });

  it('after the letter went out: nothing while the period runs, the follow-up once it has ended with no response, the method of verification after “verified”', () => {
    const waiting = rec(sent({ due_at: '2026-12-01T15:00:00Z' }));
    expect(waiting).toMatchObject({ templateKey: null, reason: 'This dispute was sent on October 1, 2026 and the reinvestigation period runs until December 1, 2026. No further letter fits until a response is recorded or the period ends.' });
    // The period ended on November 1; written results generally follow within 5 business days, plus the mail.
    expect(rec({ ...sent({}), today: '2026-11-05' })).toMatchObject({ templateKey: null, reason: expect.stringMatching(/allow for the mail before following up/) });
    expect(rec(sent({}))).toMatchObject({ templateKey: 'follow_up_en', name: 'Follow-up, no response recorded', missing: [], exists: false, reason: expect.stringMatching(/^No response is recorded and the reinvestigation period ended on November 1, 2026\./) });
    const verified = sent({ status: 'response_received', response_at: '2026-10-28T15:00:00Z', outcome: 'verified' });
    expect(rec(verified)).toMatchObject({ templateKey: 'method_of_verification_en', name: 'Method of verification request', missing: [], exists: false, reason: 'A result of “verified as reported” was recorded on October 28, 2026. This asks how the information was verified; it is not a new dispute.' });
    expect(rec({ ...verified, letters: [...verified.letters, { template_key: 'method_of_verification_en', kind: 'method_of_verification', status: 'draft' }] })).toMatchObject({ exists: true });
    for (const outcome of ['deleted', 'updated', 'unresolved', 'frivolous']) expect(rec(sent({ status: 'resolved', response_at: '2026-10-28T15:00:00Z', outcome })).templateKey, outcome).toBeNull();
    expect(rec(sent({ status: 'resolved', response_at: '2026-10-28T15:00:00Z', outcome: 'frivolous' })).reason).toMatch(/^Experian asked for more information/);
  });

  it('offers nothing for an item the client confirmed as accurate, and says a letter of that kind already exists', () => {
    expect(rec(record({ dispute: dispute({ client_confirmed_accurate: true }) }))).toEqual({ templateKey: null, name: null, reason: 'The client confirmed this item is reported accurately, so no letter is offered for it.', missing: [], exists: false });
    expect(rec(record({ dispute: dispute({ status: 'cancelled' }) })).templateKey).toBeNull();
    expect(rec(record({ letters: [{ template_key: 'bureau_dispute_en', kind: 'bureau_dispute', status: 'draft' }] }))).toMatchObject({ templateKey: 'inaccurate_balance_en', exists: true });
    expect(rec(record({ dispute: null, tradeline: null })).templateKey).toBeNull();
  });

  it('every recommendation is a letter staff can also pick by hand, and its reason promises nothing', () => {
    const cases = [A, B, record({ dispute: dispute({ category: 'duplicate' }) }), record({ dispute: dispute({ category: 'payment_update', target_type: 'furnisher', bureau: null, workflow: 'goodwill', recipient_name: 'Acme Bank' }) }),
      record({ dispute: dispute({ category: 'goodwill', target_type: 'furnisher', bureau: null, workflow: 'goodwill', recipient_name: 'Acme Bank' }) }), record({ dispute: dispute({ category: 'personal_info', workflow: 'personal_info', tradeline_id: null }), tradeline: null }),
      record({ dispute: dispute({ category: 'incorrect_payment_history' }) }), sent({}), sent({ status: 'resolved', response_at: '2026-10-28T15:00:00Z', outcome: 'verified' })];
    for (const r of cases) {
      const x = rec(r);
      expect(x.templateKey, x.reason).not.toBeNull();
      expect(LETTER_LIBRARY.some((e) => e.templateKey === x.templateKey), x.templateKey!).toBe(true);
      expect(x.reason.length).toBeGreaterThan(20);
      expect(x.reason).not.toContain('\n');
      expect(findBlockedClaims(x.reason), x.reason).toEqual([]);
      expect(x.reason).not.toMatch(/\b(will|should) (be )?(remov|delet|correct|improv|rais)\w*|score|guarant/i);
      expect(missingFacts(x.templateKey!, buildBrief(r).context)).toEqual(x.missing);
    }
    const specialty = rec(record({ dispute: dispute({ target_type: 'agency', bureau: null, workflow: 'specialty', category: 'specialty_item', agency: 'chexsystems', agency_item: { name: 'First Coast Bank', reference: 'xxxx4321' }, recipient_name: 'Chex Systems, Inc.', tradeline_id: null }), tradeline: null }));
    expect(specialty).toMatchObject({ templateKey: 'specialty_bank_account_en', name: 'Account-record dispute', reason: expect.stringMatching(/^This dispute is with ChexSystems/) });
  });

  it('names the letter a finding’s dispute starts with', () => {
    expect(letterForCategory('incorrect_balance')).toMatchObject({ name: 'Inaccurate balance' });
    expect(letterForCategory('other')).toMatchObject({ name: 'General dispute' });
    expect(letterForCategory('unverifiable_collection')).toMatchObject({ name: 'Debt validation request' });
    expect(letterForCategory('furnisher_direct')).toMatchObject({ name: 'Letter to the creditor', useWhen: expect.stringMatching(/need not investigate a dispute this office prepared/) });
    expect(letterForCategory('nope')).toBeNull();
  });
});

// Type-only use, so an unused import is never the reason a fixture compiles.
export type _Brief = LetterBrief;
