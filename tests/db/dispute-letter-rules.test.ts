import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { recordCollectorNotice } from '@/lib/credit/case-tools';
import { setConfirmedAccurate } from '@/lib/disputes/escalation';
import { draftReason, reportedFor } from '@/lib/disputes/reasons';
import { createDispute, createSpecialtyDispute, draftDisputesFromFindings, loadReportedRows, startNextRound, type DActor } from '@/lib/disputes/service';
import { categoryForFinding } from '@/lib/disputes/workflow';
import { recommendLetter } from '@/lib/letters/brief';
import { loadBrief } from '@/lib/letters/brief-load';
import { OLD_CREDITOR_WORDING, OLD_OUTDATED_WORDING, OLD_VALIDATION_WORDING } from '@/lib/letters/library';
import { createLetter, currentBody, letterBlockers } from '@/lib/letters/service';
import { parseReportText } from '@/lib/reports/parser';
import { decideReport, regenerateFindings, storeParsedReport } from '@/lib/reports/service';
import type { ParsedReport, ParsedTradeline } from '@/lib/reports/types';
import type { Bureau } from '@/lib/util';
import { addClient, asUser, closePool, makeOrg, uniq, withSystem, type TestOrg } from './helpers';

/**
 * What a dispute and its letter may say, checked through the real pipeline: which dispute a finding starts, what the
 * reason is drafted from, which collector notice belongs to a debt, what a later round keeps, who gets the SSN digits,
 * what an agency's own copy of an earlier letter may still claim, and when a second first-round dispute is refused.
 */
let A: TestOrg;
let B: TestOrg;
let owner: DActor;

const line = (o: Partial<ParsedTradeline> & { creditor_name: string }): ParsedTradeline => ({
  bureau: null, item_type: 'tradeline', original_creditor: null, account_last4: null, account_type: null, account_status: 'Open', payment_status: 'Current',
  balance_cents: null, credit_limit_cents: null, high_balance_cents: null, date_opened: '2019-03-05', date_reported: null, date_of_first_delinquency: null,
  payment_history: null, remarks: null, confidence: 0.99, field_meta: {}, ...o,
});
const collection = (creditor: string, last4: string, cents: number) => line({ creditor_name: creditor, item_type: 'collection', account_last4: last4, account_status: 'Collection', payment_status: null, balance_cents: cents, date_of_first_delinquency: '2025-06-15' });

async function newClient(name: string): Promise<string> {
  const id = await addClient(A.orgId, name);
  await withSystem((db) => db.run(`update public.clients set address = '{"line1":"123 Main St","city":"Tampa","state":"FL","zip":"33602"}' where id = $1`, [id]));
  return id;
}
/** Imports a report and approves it through the real service. Returns the report id. */
async function approve(clientId: string, bureau: Bureau, reportDate: string, tradelines: ParsedTradeline[]): Promise<string> {
  const parsed: ParsedReport = { bureau: null, reportDate, tradelines, inquiries: [], publicRecords: [], identity: [], warnings: [] };
  const [id] = await asUser(owner.userId, (db) => storeParsedReport(db, owner, { clientId, parsed, bureau, source: 'manual' }));
  await asUser(owner.userId, (db) => decideReport(db, owner, id!, 'approved'));
  return id!;
}
const rowOn = (reportId: string, last4: string) => withSystem(async (db) => (await db.row<{ id: string }>('select id from public.tradelines where report_id = $1 and account_last4 = $2', [reportId, last4]))!.id);
const dispute = (id: string) => withSystem((db) => db.row<{ category: string; item_label: string; round: number; status: string; reason: string }>('select category, item_label, round, status, reason from public.disputes where id = $1', [id]));
const create = (d: Parameters<typeof createDispute>[2]) => asUser(owner.userId, (db) => createDispute(db, owner, d));
const letter = async (input: Parameters<typeof createLetter>[2]) => {
  const id = await asUser(owner.userId, (db) => createLetter(db, owner, input));
  return { id, body: (await withSystem((db) => currentBody(db, id)))!.body };
};
/** A response as staff record it, written directly: the gates on the way to "submitted" are covered in workflow.test.ts. */
const answer = (id: string, outcome: string, status = 'resolved') => withSystem((db) => db.run(
  "update public.disputes set status = $2, outcome = $3, submitted_at = now() - interval '50 days', due_at = now() - interval '20 days', response_at = now() - interval '22 days' where id = $1", [id, status, outcome]));
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
const BALANCE = 'Experian reports a balance of $640.00. My statement dated September 2, 2026 shows $0.00.';

beforeAll(async () => {
  A = await makeOrg('Rules');
  B = await makeOrg('RulesOther');
  owner = { orgId: A.orgId, userId: A.ownerId, role: 'owner' };
});
afterAll(closePool);

describe('a finding starts the dispute it describes', () => {
  it('“client says payments were never late” becomes a payment-history dispute a person starts, never a “not my account” one', async () => {
    const c = await newClient('Avery Stone');
    const report = await approve(c, 'experian', '2026-10-01', [
      line({ creditor_name: 'ACME BANK', account_last4: '1234', balance_cents: 64000, payment_history: 'CCC30CCCCCCC' }),
      line({ creditor_name: 'ODD LENDER', account_last4: '7001', balance_cents: 5000 }),
    ]);
    // What the report screen stores when staff tick "Client says every payment was on time" and "Client does not recognize this account".
    const [acme, odd] = [await rowOn(report, '1234'), await rowOn(report, '7001')];
    await withSystem((db) => db.run(`update public.tradelines set user_provided = '{"never_late": true}' where id = $1`, [acme]));
    await withSystem((db) => db.run(`update public.tradelines set user_provided = '{"not_mine": true}' where id = $1`, [odd]));
    await asUser(owner.userId, (db) => regenerateFindings(db, owner, c, 'Avery Stone', '123 Main St'));
    const findings = await withSystem((db) => db.rows<{ id: string; category: string; dedupe_key: string; title: string }>("select id, category, dedupe_key, title from public.findings where client_id = $1 and category = 'client_statement'", [c]));
    const neverLate = findings.find((f) => f.dedupe_key.startsWith('client-never-late:'))!;
    const notMine = findings.find((f) => f.dedupe_key.startsWith('client-not-mine:'))!;
    expect(neverLate.title).toMatch(/^Client says payments were never late/);
    expect(categoryForFinding(neverLate)).toBe('incorrect_payment_history');
    expect(categoryForFinding(notMine)).toBe('not_mine');

    // Bulk drafting: the never-late finding is left for a person (its reason is the client's own account of the
    // payment); the not-mine finding is drafted as before.
    const r = await asUser(owner.userId, (db) => draftDisputesFromFindings(db, owner, c, [neverLate.id, notMine.id]));
    expect(r.created.map((x) => x.findingId)).toEqual([notMine.id]);
    expect(r.skipped).toEqual([{ findingId: neverLate.id, title: neverLate.title, why: 'This kind of dispute needs the client’s own words for its reason. Start it by hand.' }]);
    const all = await withSystem((db) => db.rows<{ category: string; reason: string; item_label: string }>('select category, reason, item_label from public.disputes where client_id = $1', [c]));
    expect(all.map((d) => [d.category, d.item_label])).toEqual([['not_mine', 'ODD LENDER ••7001 (Experian)']]);
    expect(all.some((d) => /do not recognize ACME BANK/.test(d.reason))).toBe(false);

    // Started by hand, as the form does it: the category the finding maps to, and the reason a person typed.
    const id = await create({ clientId: c, tradelineId: acme, findingId: neverLate.id, category: categoryForFinding(neverLate)!, fields: ['Payment history'],
      reason: 'Experian shows a 30-day late payment for April 2026. My bank record shows that payment cleared on April 3, 2026.' });
    expect((await dispute(id))!.category).toBe('incorrect_payment_history');
    const l = await letter({ clientId: c, disputeId: id });
    expect(l.body).toContain('Re: Dispute of the payment history reported — ACME BANK, account ending 1234\n');
    expect(l.body).not.toMatch(/do not recognize/);
  });
});

describe('a dispute started from a “balance differs” finding', () => {
  // The same synthetic reports the browser journeys upload (e2e/journey.cjs): one account, two bureaus, two balances,
  // and a collection that names the account's creditor as its original creditor.
  const EXPERIAN = `Experian Credit Report
Report Date: 01/15/2026

Accounts
Account Name: ACME BANK USA
Account Number: 411111111234
Account Type: Revolving
Account Status: Open
Payment Status: Current
Balance: $1,200.00
Credit Limit: $5,000
Date Opened: 03/2018
Date Reported: 01/02/2026

Collections
Collection Agency: FIRST RECOVERY LLC
Original Creditor: ACME BANK
Account Number: 00099887766
Balance: $980
Date of First Delinquency: 02/14/2016
Date Reported: 12/20/2025
`;
  const EQUIFAX = EXPERIAN.replace('Experian Credit Report', 'Equifax Credit Report').replace('$1,200.00', '$900.00');

  it('drafts a reason from both bureaus’ figures, and its letter can be sent for approval as drafted; the rest can be drafted in bulk', async () => {
    const c = await newClient('Journey Client');
    for (const text of [EXPERIAN, EQUIFAX]) {
      const [id] = await asUser(owner.userId, (db) => storeParsedReport(db, owner, { clientId: c, parsed: parseReportText(text), source: 'upload' }));
      await asUser(owner.userId, (db) => decideReport(db, owner, id!, 'approved'));
    }
    const findings = await withSystem((db) => db.rows<{ id: string; category: string; dedupe_key: string; evidence: Parameters<typeof draftReason>[0]['evidence']; tradeline_ids: string[] }>(
      'select id, category, dedupe_key, evidence, tradeline_ids from public.findings where client_id = $1 order by created_at', [c]));
    const balance = findings.find((f) => f.category === 'balance_mismatch')!;
    const rows = await asUser(owner.userId, (db) => loadReportedRows(db, c));
    const tl = rows.find((t) => balance.tradeline_ids.includes(t.id))!;
    // What the form pre-fills for it, and what the journeys look for.
    const reason = draftReason({ category: categoryForFinding(balance)!, creditor: tl.creditor_name, last4: tl.account_last4, bureau: tl.bureau, evidence: balance.evidence });
    expect(reason).toBe('The balance reported for ACME BANK USA (account ending 1234) differs between the credit reporting agencies (Experian reports $1,200.00; Equifax reports $900.00). Please verify the balance with the furnisher and correct it if it is not accurate or cannot be verified.');
    const id = await create({ clientId: c, tradelineId: tl.id, findingId: balance.id, category: 'incorrect_balance', fields: ['Balance'], reason });
    const l = await letter({ clientId: c, disputeId: id });
    expect(l.body).toContain(`Re: Dispute of a reported balance — ACME BANK USA, account ending 1234\n`);
    expect(l.body).toContain('Specific information I am asking you to review: Balance.');
    // The reason states what the two reports show, so the letter is not held: only its text checks apply.
    expect(await asUser(owner.userId, (db) => letterBlockers(db, l.id, l.body))).toEqual([]);

    // The other findings in bulk: the old collection and the possible duplicate are drafted, each bureau its own
    // dispute; the collection's validation request needs the client's words and is left to a person.
    const others = findings.filter((f) => f.id !== balance.id);
    const r = await asUser(owner.userId, (db) => draftDisputesFromFindings(db, owner, c, others.map((f) => f.id)));
    const category = (findingId: string) => others.find((f) => f.id === findingId)!.category;
    expect(r.created.map((x) => category(x.findingId)).sort()).toEqual(['duplicate_account', 'duplicate_account', 'obsolete_item', 'obsolete_item']);
    expect(r.skipped.map((x) => [category(x.findingId), x.why]).sort()).toEqual([
      ['collection_validation', 'This kind of dispute needs the client’s own words for its reason. Start it by hand.'],
      ['collection_validation', 'This kind of dispute needs the client’s own words for its reason. Start it by hand.'],
    ]);
    const drafts = await withSystem((db) => db.rows<{ status: string; reason: string }>('select status, reason from public.disputes where client_id = $1 and id <> $2', [c, id]));
    expect(drafts.every((d) => d.status === 'draft')).toBe(true);
    expect(drafts.filter((d) => /appears to be reported more than once/.test(d.reason)).every((d) => /reports collector balance \$980\.00; \w+ reports original creditor balance \$[\d,.]+; \w+ reports original creditor named ACME BANK\)/.test(d.reason))).toBe(true);
  });
});

describe('the reason drafted for an account on the new dispute form', () => {
  it('never says the agencies differ because two approved reports of ONE bureau show different balances', async () => {
    const c = await newClient('Jamie Cole');
    // A monthly refresh: the same account on two approved Experian reports.
    const sep = await approve(c, 'experian', '2026-09-01', [line({ creditor_name: 'ACME BANK', account_last4: '1234', balance_cents: 70000 })]);
    const oct = await approve(c, 'experian', '2026-10-01', [line({ creditor_name: 'ACME BANK', account_last4: '1234', balance_cents: 64000 })]);
    const [older, newer] = [await rowOn(sep, '1234'), await rowOn(oct, '1234')];
    let rows = await asUser(owner.userId, (db) => loadReportedRows(db, c));
    expect(rows.map((t) => [t.id, t.bureau, t.newest]).sort()).toEqual([[older, 'experian', false], [newer, 'experian', true]].sort());
    const shown = (id: string, category = 'incorrect_balance') => reportedFor(category, rows.find((t) => t.id === id)!, rows).map((e) => `${e.bureau} ${e.value}`);
    const reasonFor = (id: string, category = 'incorrect_balance') => { const tl = rows.find((t) => t.id === id)!; return draftReason({ category, creditor: tl.creditor_name, last4: tl.account_last4, bureau: tl.bureau, evidence: reportedFor(category, tl, rows) }); };
    // Each row speaks for itself only: the two Experian reports are never set side by side.
    expect(shown(newer)).toEqual(['experian $640.00']);
    expect(shown(older)).toEqual(['experian $700.00']);
    expect(shown(newer, 'incorrect_dates')).toEqual(['experian March 5, 2019']); // once, not once per report
    // With nothing to compare, the drafted reason is a request to verify. It states no difference and no figure.
    const bare = 'Please verify the balance reported for ACME BANK (account ending 1234) with the furnisher and correct it if it is not accurate or cannot be verified.';
    for (const id of [older, newer]) expect(reasonFor(id)).toBe(bare);
    // The letter drafted from it prints the balance as that report shows it, and is held until a person adds the client's side.
    const id = await create({ clientId: c, tradelineId: newer, category: 'incorrect_balance', fields: ['Balance'], reason: reasonFor(newer) });
    const l = await letter({ clientId: c, disputeId: id });
    expect(l.body).toContain('As it appears on my Experian credit report dated October 1, 2026: date opened March 5, 2019; balance $640.00.');
    expect(l.body).not.toMatch(/differs between|\$700\.00/);
    expect(await asUser(owner.userId, (db) => letterBlockers(db, l.id, l.body))).toEqual([expect.stringMatching(/^Give a concrete reason in the letter/)]);

    // A second bureau that reports another balance: now two agencies do differ, and the newest Experian value is the one compared.
    await approve(c, 'equifax', '2026-10-03', [line({ creditor_name: 'ACME BANK', account_last4: '1234', balance_cents: 65000 })]);
    rows = await asUser(owner.userId, (db) => loadReportedRows(db, c));
    expect(shown(newer)).toEqual(['experian $640.00', 'equifax $650.00']);
    expect(reasonFor(newer)).toMatch(/^The balance reported for ACME BANK \(account ending 1234\) differs between the credit reporting agencies \(Experian reports \$640\.00; Equifax reports \$650\.00\)\./);
    expect(shown(older)).toEqual(['experian $700.00']); // a row from an older report is compared with nothing
    expect(reasonFor(older)).toBe(bare);
    // Another organization reads none of it.
    expect(await asUser(B.ownerId, (db) => loadReportedRows(db, c))).toEqual([]);
  });
});

describe('a collector notice belongs to one debt', () => {
  it('a validation letter never states the notice of another debt held by the same collector, and does use this debt’s notice from another bureau’s report', async () => {
    const c = await newClient('Maria Lopez');
    const exp = await approve(c, 'experian', '2026-10-01', [collection('MIDLAND CREDIT', '7788', 41250), collection('MIDLAND CREDIT', '9911', 20000)]);
    const eqf = await approve(c, 'equifax', '2026-10-02', [collection('MIDLAND CREDIT', '7788', 41250)]);
    const [debt, otherDebt, debtOnEquifax] = [await rowOn(exp, '7788'), await rowOn(exp, '9911'), await rowOn(eqf, '7788')];
    const id = await create({ clientId: c, tradelineId: debt, category: 'unverifiable_collection', recipientName: 'Midland Credit', reason: 'I do not recognize the amount of $412.50 or the creditor First Coast Bank.' });
    const brief = async () => (await asUser(owner.userId, (db) => loadBrief(db, c, id)))!;
    const [five, nine] = [daysAgo(5), daysAgo(9)]; // worked out once, so the test reads the same day throughout

    // The only notice on file is for the OTHER Midland debt, received five days ago: its 30 days are not this debt's.
    await asUser(owner.userId, (db) => recordCollectorNotice(db, owner, { clientId: c, tradelineId: otherDebt, kind: 'received', date: five }));
    expect((await brief()).circumstances.notice).toBeNull();
    expect(recommendLetter(await brief()).reason).toMatch(/No collector notice is recorded for this debt/);
    const none = await letter({ clientId: c, disputeId: id });
    expect(none.body).toContain('I am writing about the debt referenced above. I dispute this debt and ask that you provide validation of it, including:');
    expect(none.body).not.toMatch(/809\(b\)|1692g|which I received on|in response to your written notice|as the statute provides/);

    // This debt's own notice, recorded against the Equifax report's row for the same account: it is this debt's.
    await asUser(owner.userId, (db) => recordCollectorNotice(db, owner, { clientId: c, tradelineId: debtOnEquifax, kind: 'received', date: nine }));
    expect((await brief()).circumstances.notice).toMatchObject({ kind: 'received', date: nine, open: true });
    const own = await letter({ clientId: c, disputeId: id });
    expect(own.body).toMatch(/I am writing in response to your written notice about the debt referenced above, which I received on [A-Z][a-z]+ \d{1,2}, \d{4}\. Under Section 809\(b\)/);
    const said = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
    expect(own.body).toContain(`which I received on ${said(nine)}.`);
    expect(own.body).not.toContain(said(five));
  });
});

describe('the next round of a dispute about an account typed by staff', () => {
  it('keeps the account’s name and digits, for a bureau and for a creditor', async () => {
    const c = await newClient('Devon Hart');
    const first = await create({ clientId: c, category: 'incorrect_balance', bureau: 'equifax', fields: ['Balance'], itemLabel: 'Summit Finance ••4410', reason: 'Equifax reports a balance of $900.00. My statement of May 2, 2026 shows $400.00.' });
    await answer(first, 'verified');
    const second = await asUser(owner.userId, (db) => startNextRound(db, owner, first, { reason: 'Equifax still reports a balance of $900.00 for this loan.', newInformation: 'A payoff letter from the lender dated October 20, 2026 states the balance is $400.00.' }));
    expect(await dispute(second)).toMatchObject({ item_label: 'Summit Finance ••4410 (Equifax)', round: 2 });
    const l = await letter({ clientId: c, disputeId: second });
    expect(l.body).toContain('Re: Further dispute with new information — Summit Finance, account ending 4410 — request 2\n');
    expect(l.body).toContain('Item: Summit Finance, account ending 4410\n');
    expect(l.body).not.toMatch(/Item: Item|— Item —/);
    expect(await asUser(owner.userId, (db) => letterBlockers(db, l.id, l.body))).toEqual([]);

    const creditor = await create({ clientId: c, category: 'furnisher_direct', recipientName: 'Summit Finance', itemLabel: 'Summit Finance ••4410', reason: 'You report a balance of $900.00. My statement of May 2, 2026 shows $400.00.' });
    await answer(creditor, 'verified');
    const again = await asUser(owner.userId, (db) => startNextRound(db, owner, creditor, { reason: 'You still report a balance of $900.00.', newInformation: 'My payoff letter dated October 20, 2026 states the balance is $400.00.' }));
    expect((await dispute(again))!.item_label).toBe('Summit Finance ••4410');
    expect((await letter({ clientId: c, disputeId: again })).body).toContain('Account: Summit Finance, account ending 4410\n');

    // Personal information keeps its label too, and a dispute that named nothing is still just an item.
    const pi = await create({ clientId: c, category: 'personal_info', bureau: 'experian', itemLabel: 'Personal information', reason: '- Name shown as “DEVON HEART”: this entry is not correct.' });
    await answer(pi, 'unresolved');
    const pi2 = await asUser(owner.userId, (db) => startNextRound(db, owner, pi, { reason: '- Name shown as “DEVON HEART”: this entry is still listed.', newInformation: 'A copy of my driver’s license showing the correct spelling.' }));
    expect((await dispute(pi2))!.item_label).toBe('Personal information (Experian)');
    const bare = await create({ clientId: c, category: 'other', bureau: 'transunion', reason: 'TransUnion lists a balance of $20.00 that I paid on May 2, 2026.' });
    await answer(bare, 'no_response');
    const bare2 = await asUser(owner.userId, (db) => startNextRound(db, owner, bare, { reason: 'TransUnion still lists the balance of $20.00.', newInformation: 'The receipt dated May 2, 2026 is now enclosed.' }));
    expect((await dispute(bare2))!.item_label).toBe('Item (TransUnion)');
  });
});

describe('the last four digits of the SSN', () => {
  it('never go to a debt collector or on top of a specialty agency’s own identification lines, whatever the form ticked', async () => {
    const c = await newClient('Riley Park');
    const exp = await approve(c, 'experian', '2026-10-01', [collection('HARBOR RECOVERY', '5521', 31000), line({ creditor_name: 'ACME BANK', account_last4: '1234', balance_cents: 64000 })]);
    // The new-letter form posts includeSsnLast4 = true unless someone unticks the box.
    const standalone = await letter({ clientId: c, templateKey: 'validation_request_en', includeSsnLast4: true, recipientName: 'Harbor Recovery', reasonOverride: 'I do not recognize this debt.' });
    expect(standalone.body).not.toMatch(/SSN|Date of birth/);
    const col = await create({ clientId: c, tradelineId: await rowOn(exp, '5521'), category: 'unverifiable_collection', recipientName: 'Harbor Recovery', reason: 'I do not recognize this debt of $310.00.' });
    for (const templateKey of ['validation_request_en', 'collector_communication_en']) {
      const l = await letter({ clientId: c, disputeId: col, templateKey, includeSsnLast4: true });
      expect(l.body, templateKey).not.toMatch(/SSN|Date of birth|last 4/);
      expect(l.body, templateKey).toContain('Tampa, FL 33602\n\nHarbor Recovery\n');
    }
    // A specialty agency: the lines its own page asks for, and not the four digits above them.
    const chex = await asUser(owner.userId, (db) => createSpecialtyDispute(db, owner, { clientId: c, agency: 'chexsystems', item: { name: 'First Coast Bank', reference: 'xxxx8841', amount: '$412.50' }, reason: 'The disclosure shows an unpaid balance of $412.50. I paid this in full on April 2, 2025.' }));
    const specialty = await letter({ clientId: c, disputeId: chex, templateKey: 'specialty_bank_account_en', includeSsnLast4: true });
    expect(specialty.body).toContain('Tampa, FL 33602\nDate of birth: March 3, 1985\nSocial Security number: [SOCIAL SECURITY NUMBER NEEDED]\n\nChex Systems, Inc.\n');
    expect(specialty.body).not.toMatch(/SSN \(last 4\)/);
    expect(specialty.body).toContain('Re: Dispute of information in my file — First Coast Bank · xxxx8841\n'); // without "(ChexSystems)"
    // Its follow-up, once the period has ended with no response, carries the same identification lines.
    await withSystem((db) => db.run("update public.disputes set status = 'submitted', submitted_at = now() - interval '60 days', due_at = now() - interval '30 days' where id = $1", [chex]));
    const followUp = await letter({ clientId: c, disputeId: chex, templateKey: 'follow_up_en', includeSsnLast4: true });
    expect(followUp.body).toContain('Tampa, FL 33602\nDate of birth: March 3, 1985\nSocial Security number: [SOCIAL SECURITY NUMBER NEEDED]\n\nChex Systems, Inc.\n');
    expect(followUp.body).not.toMatch(/SSN \(last 4\)|credit report/);
    expect(followUp.body).toContain('along with an updated copy of my file if it changed.');
    expect(await asUser(owner.userId, (db) => letterBlockers(db, followUp.id, followUp.body))).toEqual(['Fill in or remove: [SOCIAL SECURITY NUMBER NEEDED]']);

    // Unchanged: a bureau letter states both, and a letter to the creditor states the digits when the person drafting asked.
    const bureau = await create({ clientId: c, tradelineId: await rowOn(exp, '1234'), category: 'incorrect_balance', fields: ['Balance'], reason: BALANCE });
    expect((await letter({ clientId: c, disputeId: bureau, includeSsnLast4: true })).body).toContain('Date of birth: March 3, 1985\nSSN (last 4): 4321\n');
    const goodwill = await create({ clientId: c, tradelineId: await rowOn(exp, '1234'), category: 'goodwill', reason: 'I was 30 days late in March 2019 while I was in hospital.' });
    expect((await letter({ clientId: c, disputeId: goodwill, includeSsnLast4: true })).body).toContain('\nSSN (last 4): 4321\n');
    expect((await letter({ clientId: c, disputeId: goodwill })).body).not.toMatch(/SSN/);
  });
});

describe('an agency’s own copy of a letter as it was worded before', () => {
  const copy = (baseKey: string, kind: string, name: string, text: string) => withSystem((db) => db.row<{ id: string }>(
    "insert into public.letter_templates (org_id, base_key, name, kind, language, body) values ($1, $2, $3, $4, 'en', $5) returning id", [A.orgId, baseKey, `${name} ${uniq()}`, kind, text])).then((r) => `org:${r!.id}`);
  const HEAD = '{{date}}\n\n{{client_name}}\n{{client_address}}\n{{ssn_last4_text}}\n{{recipient_name}}\n{{recipient_address}}\n\n';

  it('is not drafted from while it cites the creditor’s direct-dispute duty, or the 30-day validation right with no open notice on file', async () => {
    const c = await newClient('Quinn Vale');
    const exp = await approve(c, 'experian', '2026-10-01', [line({ creditor_name: 'ACME BANK', account_last4: '1234', balance_cents: 64000 }), collection('HARBOR RECOVERY', '5521', 31000)]);
    const oldCreditor = await copy('creditor_dispute_en', 'creditor_dispute', 'Our creditor letter',
      `${HEAD}Re: Direct dispute of information you furnished — {{item_label}}\n\nTo whom it may concern:\n\nUnder Section 623(a)(8) of the Fair Credit Reporting Act (15 U.S.C. § 1681s-2(a)(8)), I ask that you investigate the information below that you furnished to consumer reporting agencies.\n\n{{reason}}\n\nSincerely,\n\n{{client_name}}`);
    const fd = await create({ clientId: c, tradelineId: await rowOn(exp, '1234'), category: 'furnisher_direct', reason: 'You report a balance of $640.00. My statement dated September 2, 2026 shows $0.00.' });
    await expect(letter({ clientId: c, disputeId: fd, templateKey: oldCreditor })).rejects.toThrow(OLD_CREDITOR_WORDING);
    // The built-in letter, which cites nothing, drafts as usual.
    expect((await letter({ clientId: c, disputeId: fd })).body).not.toMatch(/623|1681s-2|investigat/i);

    const oldValidation = await copy('validation_request_en', 'validation_request', 'Our validation letter',
      `${HEAD}Re: Request for validation of debt — {{item_label}}\n\nTo whom it may concern:\n\nI am writing in response to your communication regarding the debt referenced above. Under Section 809(b) of the Fair Debt Collection Practices Act (15 U.S.C. § 1692g(b)), I dispute this debt and request validation.\n\n{{reason}}\n\nUntil you provide validation, I ask that you cease collection of it, as the statute provides.\n\nSincerely,\n\n{{client_name}}`);
    const row = await rowOn(exp, '5521');
    const col = await create({ clientId: c, tradelineId: row, category: 'unverifiable_collection', recipientName: 'Harbor Recovery', reason: 'I do not recognize this debt of $310.00.' });
    // No notice on file, then one whose 30 days ended long ago: the right is not claimed, so the copy is refused.
    await expect(letter({ clientId: c, disputeId: col, templateKey: oldValidation })).rejects.toThrow(OLD_VALIDATION_WORDING);
    await asUser(owner.userId, (db) => recordCollectorNotice(db, owner, { clientId: c, tradelineId: row, kind: 'received', date: daysAgo(100) }));
    await expect(letter({ clientId: c, disputeId: col, templateKey: oldValidation })).rejects.toThrow(OLD_VALIDATION_WORDING);
    // A notice received a week ago: the period is open, what the copy says is true, and it drafts.
    await asUser(owner.userId, (db) => recordCollectorNotice(db, owner, { clientId: c, tradelineId: row, kind: 'received', date: daysAgo(7) }));
    expect((await letter({ clientId: c, disputeId: col, templateKey: oldValidation })).body).toContain('Under Section 809(b) of the Fair Debt Collection Practices Act (15 U.S.C. § 1692g(b)), I dispute this debt and request validation.');
  });

  it('is not drafted from for an account that is only late while it calls the account an item past its reporting period', async () => {
    const c = await newClient('Rory Finch');
    const exp = await approve(c, 'experian', '2026-10-01', [
      // An open card that was 30 days late once, more than seven years ago: the late payment has aged, the account has not.
      line({ creditor_name: 'CITY CARD', account_last4: '5566', payment_status: '30 days late', balance_cents: 12000, date_opened: '2015-01-10', date_of_first_delinquency: '2019-03-10' }),
      line({ creditor_name: 'HARBOR RECOVERY', item_type: 'collection', account_last4: '5521', account_status: 'Collection', payment_status: null, balance_cents: 31000, date_of_first_delinquency: '2018-06-15' }),
    ]);
    const oldOutdated = await copy('outdated_item_en', 'bureau_dispute', 'Our outdated item letter',
      `${HEAD}Re: Item that appears to be past the reporting period — {{item_label}}\n\nTo whom it may concern:\n\nI am writing about an item in my credit file that appears to be past the period in which it may be reported (15 U.S.C. § 1681c).\n\n{{obsolete_text}}\n\n{{reason}}\n\nSincerely,\n\n{{client_name}}`);
    const late = await create({ clientId: c, tradelineId: await rowOn(exp, '5566'), category: 'obsolete', reason: 'My Experian credit report shows a date of first delinquency of March 10, 2019 for CITY CARD (account ending 5566). Please verify that date with the furnisher.' });
    await expect(letter({ clientId: c, disputeId: late, templateKey: oldOutdated })).rejects.toThrow(OLD_OUTDATED_WORDING);
    // The built-in letter is about the late payment information only, and drafts.
    const builtIn = (await letter({ clientId: c, disputeId: late, templateKey: 'outdated_item_en' })).body;
    expect(builtIn).toContain('Re: Late payment information that appears to be past its reporting period — CITY CARD, account ending 5566\n');
    expect(builtIn).not.toMatch(/Item that appears to be past|an item in my credit file/);
    // A collection ages off as a whole: what the copy says is true of it, and it drafts.
    const whole = await create({ clientId: c, tradelineId: await rowOn(exp, '5521'), category: 'obsolete', reason: 'My Experian credit report shows a date of first delinquency of June 15, 2018 for HARBOR RECOVERY (account ending 5521). Please verify that date with the furnisher.' });
    expect((await letter({ clientId: c, disputeId: whole, templateKey: oldOutdated })).body).toContain('Re: Item that appears to be past the reporting period — HARBOR RECOVERY, account ending 5521\n');
  });
});

describe('one first-round dispute of a kind per account and bureau', () => {
  let c = '';
  let acme = ''; // ACME BANK ••1234 on the Experian report
  let other = ''; // OTHER LENDER ••9999 on the Experian report
  let acmeEquifax = '';

  beforeAll(async () => {
    c = await newClient('Sam Reyes');
    const exp = await approve(c, 'experian', '2026-09-01', [line({ creditor_name: 'ACME BANK', account_last4: '1234', balance_cents: 64000 }), line({ creditor_name: 'OTHER LENDER', account_last4: '9999', balance_cents: 5000 }), line({ creditor_name: 'THIRD CO', account_last4: '3003', balance_cents: 700 })]);
    const eqf = await approve(c, 'equifax', '2026-09-02', [line({ creditor_name: 'ACME BANK', account_last4: '1234', balance_cents: 64000 })]);
    [acme, other, acmeEquifax] = [await rowOn(exp, '1234'), await rowOn(exp, '9999'), await rowOn(eqf, '1234')];
  });
  const balance = (tradelineId: string, reason = BALANCE) => create({ clientId: c, tradelineId, category: 'incorrect_balance', fields: ['Balance'], reason });

  it('refuses a second one beside a dispute that is still open, and points to the next round', async () => {
    const first = await balance(acme);
    await expect(balance(acme)).rejects.toThrow('A “Balance may be incorrect” dispute about this account with Experian is already open (round 1, draft). Continue with that one. Once it is resolved, the same thing is disputed again by starting the next round from it. A different issue with this account can be started as its own dispute.');
    await expect(balance(acme, 'Experian reports $640.00. I have never owed this amount; my last statement shows $0.00.')).rejects.toThrow(/already open/); // other words, same dispute
    // A different issue with the same account, the same issue with another bureau, and another account are all their own disputes.
    expect((await dispute(await create({ clientId: c, tradelineId: acme, category: 'incorrect_status', reason: 'Experian reports this account as open. I closed it on March 4, 2024.' })))!.status).toBe('draft');
    expect((await dispute(await balance(acmeEquifax, 'Equifax reports a balance of $640.00. My statement dated September 2, 2026 shows $0.00.')))!.item_label).toBe('ACME BANK ••1234 (Equifax)');
    expect((await dispute(await balance(other)))!.item_label).toBe('OTHER LENDER ••9999 (Experian)');

    // After a “verified” result the same dispute is not started afresh: that is what the next round is for.
    await answer(first, 'verified');
    await expect(balance(acme)).rejects.toThrow('A “Balance may be incorrect” dispute about this account with Experian has already been resolved (round 1). To dispute the same thing again, open that dispute and start the next round, which asks for what is new. A different issue with this account can be started as its own dispute.');
    // The same account on a newer report of that bureau is a new row, and still the same account.
    const oct = await approve(c, 'experian', '2026-10-01', [line({ creditor_name: 'ACME BANK', account_last4: '1234', balance_cents: 64000 })]);
    await expect(balance(await rowOn(oct, '1234'))).rejects.toThrow(/has already been resolved \(round 1\)/);
    // The next round itself is not refused, and once it exists it is the one named.
    const second = await asUser(owner.userId, (db) => startNextRound(db, owner, first, { reason: 'Experian still reports a balance of $640.00 for this account.', newInformation: 'A payoff letter from Acme Bank dated October 20, 2026 states the balance is $0.00.' }));
    expect(await dispute(second)).toMatchObject({ round: 2, status: 'draft' });
    await expect(balance(acme)).rejects.toThrow(/already open \(round 2, draft\)/);
    // A cancelled round does not count; the resolved round before it does.
    await withSystem((db) => db.run("update public.disputes set status = 'cancelled' where id = $1", [second]));
    await expect(balance(acme)).rejects.toThrow(/has already been resolved \(round 1\)/);
  });

  it('allows a new dispute after the item was deleted or corrected, or after the earlier one was cancelled', async () => {
    const third = await rowOn((await withSystem((db) => db.row<{ report_id: string }>('select report_id from public.tradelines where id = $1', [other])))!.report_id, '3003');
    // Deleted, then it shows up again (a reinsertion): that is a new matter, and nothing offers a next round for it.
    const gone = await balance(third, 'Experian reports a balance of $7.00. I never had an account with Third Co.');
    await answer(gone, 'deleted', 'response_received');
    const back = await balance(third, 'Experian reports a balance of $7.00 again after removing this account on October 1, 2026.');
    expect((await dispute(back))!.round).toBe(1);
    // Cancelled before it went anywhere: a fresh one is fine.
    await withSystem((db) => db.run("update public.disputes set status = 'cancelled' where id = $1", [back]));
    await answer(await balance(third, 'Experian reports a balance of $7.00 that I paid on May 2, 2026.'), 'updated');
    expect((await dispute(await balance(third, 'Experian reports a balance of $7.00 again. My receipt dated May 2, 2026 shows it paid.')))!.status).toBe('draft');
  });

  it('treats an account typed by staff the same way, and never an item that names no account', async () => {
    const typed = (itemLabel?: string, category = 'incorrect_balance') => create({ clientId: c, category, bureau: 'transunion', itemLabel, reason: 'TransUnion reports $900.00. My statement of May 2, 2026 shows $400.00.' });
    await typed('Summit Finance ••4410');
    await expect(typed('Summit Finance ••4410')).rejects.toThrow(/dispute about this account with TransUnion is already open/);
    await expect(typed('  summit finance ••4410 ')).rejects.toThrow(/already open/);
    expect((await dispute(await typed('Summit Finance ••4410', 'incorrect_status')))!.status).toBe('draft');
    expect((await dispute(await typed('Summit Finance ••8820')))!.status).toBe('draft');
    // No account named: nothing says the two are the same, so nothing is refused. Personal information is not an account.
    await typed();
    expect((await dispute(await typed()))!.item_label).toBe('Item (TransUnion)');
    for (let n = 0; n < 2; n++) expect((await dispute(await create({ clientId: c, category: 'personal_info', bureau: 'transunion', itemLabel: 'Personal information', reason: '- Address shown as “12 OAK ST”: this entry is not mine.' })))!.item_label).toBe('Personal information (TransUnion)');
    // A request to a creditor is not a dispute with a bureau and is not counted.
    for (let n = 0; n < 2; n++) expect((await dispute(await create({ clientId: c, tradelineId: other, category: 'goodwill', reason: 'I was 30 days late in March 2019 while I was in hospital.' })))!.status).toBe('draft');
  });

  it('does not start a fresh dispute about an item the client confirmed is reported accurately', async () => {
    const confirmed = await create({ clientId: c, tradelineId: other, category: 'incorrect_dates', fields: ['Dates'], reason: 'Experian reports this account as opened in March 2019. My records show it was opened on June 4, 2018.' });
    await answer(confirmed, 'verified');
    await asUser(owner.userId, (db) => setConfirmedAccurate(db, owner, confirmed, true));
    await expect(create({ clientId: c, tradelineId: other, category: 'incorrect_dates', fields: ['Dates'], reason: 'Experian reports this account as opened in March 2019. I believe it was 2018.' }))
      .rejects.toThrow('The client confirmed this item is reported accurately, so no further letter or round is offered for it.');
  });

  it('bulk drafting skips the second finding of a kind for one account and says why', async () => {
    const finding = (category: string, field: string) => withSystem(async (db) => (await db.row<{ id: string }>(
      `insert into public.findings (org_id, client_id, category, severity, title, explanation, evidence, basis, tradeline_ids, dedupe_key)
       values ($1, $2, $3, 'review', $4, 'Statuses differ between bureaus.', $5, 'potential_discrepancy', $6, $7) returning id`,
      [A.orgId, c, category, `${field} differs for ACME BANK`, JSON.stringify([{ bureau: 'experian', field, value: 'Open', source: 'reported' }, { bureau: 'equifax', field, value: 'Closed', source: 'reported' }]), [acmeEquifax], uniq()]))!.id);
    const [account, payment] = [await finding('status_mismatch', 'Account status'), await finding('status_mismatch', 'Payment status')];
    const r = await asUser(owner.userId, (db) => draftDisputesFromFindings(db, owner, c, [account, payment]));
    expect(r.created.map((x) => x.findingId)).toEqual([account]);
    expect(r.skipped.map((x) => [x.findingId, x.why])).toEqual([[payment, expect.stringMatching(/^A “Account or payment status” dispute about this account with Equifax is already open \(round 1, draft\)\./)]]);
  });
});
