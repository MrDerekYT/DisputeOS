import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findBlockedClaims } from '@/lib/compliance/claims';
import { loadAgingOff } from '@/lib/credit/aging-off-load';
import { createDispute, type DActor } from '@/lib/disputes/service';
import { REINSERTION_CATEGORY, REINSERTION_GENERATED_BY } from '@/lib/disputes/reinsertion';
import { decideReport, regenerateFindings, storeParsedReport } from '@/lib/reports/service';
import type { ParsedReport, ParsedTradeline } from '@/lib/reports/types';
import type { Bureau } from '@/lib/util';
import { addClient, asUser, closePool, makeOrg, withSystem, type TestOrg } from './helpers';

let A: TestOrg;
let B: TestOrg;
let client: string; // org A: the client whose dispute was recorded as deleted
let sibling: string; // org A: another client reporting the very same account
let foreign: string; // org B: another organisation's client reporting the very same account
let owner: DActor;
let ownerB: DActor;

const line = (creditor: string, last4: string | null, o: Partial<ParsedTradeline> = {}): ParsedTradeline => ({
  bureau: null, item_type: 'tradeline', creditor_name: creditor, original_creditor: null, account_last4: last4, account_type: 'Credit card', account_status: 'Open', payment_status: 'Current',
  balance_cents: 50000, credit_limit_cents: 200000, high_balance_cents: null, date_opened: '2019-05-01', date_reported: null, date_of_first_delinquency: null, payment_history: null, remarks: null,
  confidence: 1, field_meta: {}, ...o,
});
const parsed = (reportDate: string, tradelines: ParsedTradeline[], publicRecords: ParsedReport['publicRecords'] = []): ParsedReport =>
  ({ bureau: null, reportDate, tradelines, inquiries: [], publicRecords, identity: [], warnings: [] });

/** Imports a report and approves it through the real service, as a signed-in member (row-level security applies). */
async function approve(actor: DActor, clientId: string, bureau: Bureau, p: ParsedReport): Promise<string> {
  const [id] = await asUser(actor.userId, (db) => storeParsedReport(db, actor, { clientId, parsed: p, bureau, source: 'manual' }));
  await asUser(actor.userId, (db) => decideReport(db, actor, id!, 'approved'));
  return id!;
}
const tradelineId = (reportId: string, last4: string | null) => withSystem(async (db) =>
  (await db.row<{ id: string }>('select id from public.tradelines where report_id = $1 and account_last4 is not distinct from $2', [reportId, last4]))!.id);
/** A bureau dispute on that account with a response recorded on `on`. The outcome is written directly: the gates to "submitted" are covered elsewhere. */
async function disputeWithOutcome(tlId: string, outcome: string, on: string): Promise<string> {
  const id = await asUser(owner.userId, (db) => createDispute(db, owner, { clientId: client, tradelineId: tlId, category: 'not_mine', reason: 'I do not recognise this account. Please verify it.' }));
  await withSystem((db) => db.run(`update public.disputes set status = 'response_received', outcome = $2, response_at = $3 where id = $1`, [id, outcome, `${on}T12:00:00Z`]));
  return id;
}
const reinsertions = (clientId: string) => withSystem((db) => db.rows<{ id: string; title: string; explanation: string; dedupe_key: string; tradeline_ids: string[]; generated_by: string; status: string; severity: string; org_id: string; evidence: { source: string; value: string }[] }>(
  'select id, title, explanation, dedupe_key, tradeline_ids, generated_by, status, severity, org_id, evidence from public.findings where client_id = $1 and category = $2 order by created_at', [clientId, REINSERTION_CATEGORY]));

let deletedDispute: string;
let first: string;

beforeAll(async () => {
  A = await makeOrg('Reinsert');
  B = await makeOrg('Elsewhere');
  owner = { orgId: A.orgId, userId: A.ownerId, role: 'owner' };
  ownerB = { orgId: B.orgId, userId: B.ownerId, role: 'owner' };
  client = await addClient(A.orgId, 'Jordan Rivera');
  sibling = await addClient(A.orgId, 'Sam Other');
  foreign = await addClient(B.orgId, 'Pat Elsewhere');

  // January: the Experian report the disputes were raised on.
  first = await approve(owner, client, 'experian', parsed('2026-01-10', [line('ACME BANK', '1234'), line('OTHER LENDER', '9999'), line('NO NUMBER CO', null)]));
  deletedDispute = await disputeWithOutcome(await tradelineId(first, '1234'), 'deleted', '2026-02-15');
  await disputeWithOutcome(await tradelineId(first, '9999'), 'verified', '2026-02-15'); // not a deletion
  await disputeWithOutcome(await tradelineId(first, null), 'deleted', '2026-02-15'); // deleted, but no account number to match on
});
afterAll(closePool);

describe('reinsertion watch', () => {
  it('recording the deletion alone creates nothing', async () => {
    await asUser(owner.userId, (db) => regenerateFindings(db, owner, client, 'Jordan Rivera', ''));
    expect(await reinsertions(client)).toEqual([]);
  });

  it('a report dated before the response was recorded is not a reinsertion', async () => {
    await approve(owner, client, 'experian', parsed('2026-02-01', [line('ACME BANK', '1234')]));
    expect(await reinsertions(client)).toEqual([]);
  });

  it('the same account on another bureau is not a reinsertion', async () => {
    await approve(owner, client, 'equifax', parsed('2026-03-05', [line('ACME BANK', '1234')]));
    expect(await reinsertions(client)).toEqual([]);
  });

  it('never crosses clients or organisations', async () => {
    await approve(owner, sibling, 'experian', parsed('2026-03-10', [line('ACME BANK', '1234')]));
    await approve(ownerB, foreign, 'experian', parsed('2026-03-10', [line('ACME BANK', '1234')]));
    expect(await reinsertions(sibling)).toEqual([]);
    expect(await reinsertions(foreign)).toEqual([]);
    expect(await reinsertions(client)).toEqual([]);
  });

  it('approving a newer report that shows the deleted account creates exactly one finding', async () => {
    const newer = await approve(owner, client, 'experian', parsed('2026-03-20', [line('ACME BANK', '1234'), line('OTHER LENDER', '9999'), line('NO NUMBER CO', null)]));
    const found = await reinsertions(client);
    expect(found).toHaveLength(1); // not the verified dispute, not the account without a number
    const f = found[0]!;
    expect(f).toMatchObject({ dedupe_key: `reinsertion:${deletedDispute}`, generated_by: REINSERTION_GENERATED_BY, status: 'suggested', severity: 'review', org_id: A.orgId });
    expect(f.tradeline_ids).toEqual([await tradelineId(newer, '1234')]);
    expect(f.title).toBe('ACME BANK (ending 1234) appears on Experian again after a recorded deletion');
    expect(f.explanation).toMatch(/response recorded on 2026-02-15/);
    expect(f.explanation).toMatch(/Experian report dated 2026-03-20/);
    expect(f.explanation).toMatch(/15 U\.S\.C\. § 1681i\(a\)\(5\)\(B\)/);
    expect(f.explanation).not.toMatch(/violat|illegal|unlawful/i);
    expect(findBlockedClaims(`${f.title} ${f.explanation}`)).toEqual([]);
    expect(f.evidence.map((e) => e.source)).toEqual(['record', 'reported', 'record']);
    // Still nothing for anyone else.
    expect(await reinsertions(sibling)).toEqual([]);
    expect(await reinsertions(foreign)).toEqual([]);
  });

  it('is idempotent: re-running the analysis or approving a later report that still shows it adds nothing', async () => {
    await asUser(owner.userId, (db) => regenerateFindings(db, owner, client, 'Jordan Rivera', ''));
    await asUser(owner.userId, (db) => regenerateFindings(db, owner, client, 'Jordan Rivera', ''));
    expect(await reinsertions(client)).toHaveLength(1);
    await approve(owner, client, 'experian', parsed('2026-04-20', [line('ACME BANK', '1234')]));
    expect((await reinsertions(client)).map((f) => f.dedupe_key)).toEqual([`reinsertion:${deletedDispute}`]);
  });

  it('another organisation cannot read the finding', async () => {
    const [f] = await reinsertions(client);
    expect(await asUser(B.ownerId, (db) => db.rows('select id from public.findings where id = $1', [f!.id]))).toEqual([]);
    expect(await asUser(A.ownerId, (db) => db.rows('select id from public.findings where id = $1', [f!.id]))).toHaveLength(1);
  });

  it('a dismissed finding stays dismissed', async () => {
    const [f] = await reinsertions(client);
    await withSystem((db) => db.run("update public.findings set status = 'dismissed' where id = $1", [f!.id]));
    await asUser(owner.userId, (db) => regenerateFindings(db, owner, client, 'Jordan Rivera', ''));
    expect((await reinsertions(client)).map((x) => x.status)).toEqual(['dismissed']);
    await withSystem((db) => db.run("update public.findings set status = 'suggested' where id = $1", [f!.id]));
  });

  it('staff can open a normal dispute from it', async () => {
    const [f] = await reinsertions(client);
    const id = await asUser(owner.userId, (db) => createDispute(db, owner, { clientId: client, tradelineId: f!.tradeline_ids[0], findingId: f!.id, category: 'other', reason: 'This account appears on my report again. Please verify it with the furnisher.' }));
    const d = await withSystem((db) => db.row<{ finding_id: string; status: string; bureau: string }>('select finding_id, status, bureau from public.disputes where id = $1', [id]));
    expect(d).toEqual({ finding_id: f!.id, status: 'draft', bureau: 'experian' });
    expect((await reinsertions(client))[0]!.status).toBe('disputed');
  });
});

describe('aging off within 12 months (client record)', () => {
  it('lists dated negative items from the latest approved reports only, for this client only', async () => {
    const c = await addClient(A.orgId, 'Aging Client');
    await approve(owner, c, 'experian', parsed('2026-10-01', [
      line('MIDLAND FUNDING', '7766', { item_type: 'collection', payment_status: 'Collection', date_of_first_delinquency: '2020-01-01' }), // generally until 2027-06-29
      line('LATE CARD', '2222', { payment_status: 'Late 30', date_of_first_delinquency: '2025-01-01' }), // 2032: outside the window
      line('NO DATE COLLECTIONS', '3333', { item_type: 'collection', payment_status: 'Collection' }), // no date: left out, never estimated
      line('CLEAN CARD', '4444', { date_of_first_delinquency: '2020-01-01' }), // nothing negative
    ], [{ bureau: null, kind: 'Chapter 7 Bankruptcy', court: null, amount_cents: null, filed_date: '2017-03-01', status: null }]));
    const list = await asUser(owner.userId, (db) => loadAgingOff(db, c, '2026-11-19'));
    expect(list).toEqual([
      { label: 'Chapter 7 Bankruptcy', date: '2027-03-01', rule: 'bankruptcy_ten_years', from: '2017-03-01', bureaus: ['Experian'] },
      { label: 'MIDLAND FUNDING ••7766', date: '2027-06-29', rule: 'seven_years_plus_180_days', from: '2020-01-01', bureaus: ['Experian'] },
    ]);
    expect(await asUser(B.ownerId, (db) => loadAgingOff(db, c, '2026-11-19'))).toEqual([]);
  });
});
