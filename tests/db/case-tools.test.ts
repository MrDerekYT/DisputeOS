import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CASE_TOOLS_GENERATED_BY, loadCollectorNotices, openValidationWindows, recordCollectorNotice, removeCollectorNotice, setBankruptcy, setMedicalFlags, syncCaseFindings, type CActor } from '@/lib/credit/case-tools';
import { createDispute } from '@/lib/disputes/service';
import { createLetter } from '@/lib/letters/service';
import { decideReport, regenerateFindings, storeParsedReport } from '@/lib/reports/service';
import type { ParsedReport, ParsedTradeline } from '@/lib/reports/types';
import type { Bureau } from '@/lib/util';
import { addClient, addPortalClient, asUser, closePool, makeOrg, withSystem, type TestOrg } from './helpers';

let A: TestOrg;
let B: TestOrg;
let owner: CActor;
let ownerB: CActor;
let client: string; // org A
let portalUser: string; // org A: the client's own portal login
let foreign: string; // org B: a client reporting the very same accounts
let report: string;

const line = (creditor: string, last4: string | null, o: Partial<ParsedTradeline> = {}): ParsedTradeline => ({
  bureau: null, item_type: 'tradeline', creditor_name: creditor, original_creditor: null, account_last4: last4, account_type: 'Credit card', account_status: 'Open', payment_status: 'Current',
  balance_cents: 50000, credit_limit_cents: 200000, high_balance_cents: null, date_opened: '2019-05-01', date_reported: null, date_of_first_delinquency: null, payment_history: null, remarks: null,
  confidence: 1, field_meta: {}, ...o,
});
const collection = (creditor: string, last4: string, o: Partial<ParsedTradeline> = {}) =>
  line(creditor, last4, { item_type: 'collection', account_type: 'Collection', account_status: 'Open', payment_status: 'Collection', credit_limit_cents: null, date_opened: '2022-03-01', date_of_first_delinquency: '2021-09-01', ...o });
const LINES = [
  collection('MEDCOLLECT', '1111', { remarks: 'Medical', balance_cents: 30000 }), // the report says medical, under $500
  collection('PLAIN COLLECTIONS', '2222', { balance_cents: 20000 }), // under $500, nothing says medical
  line('OLD CARD BANK', '3333', { account_status: 'Closed', payment_status: 'Charge-off', balance_cents: 250000, date_opened: '2018-01-01', date_of_first_delinquency: '2022-10-01' }),
  line('GOOD STANDING CU', '4444'),
];
const parsed = (reportDate: string, tradelines: ParsedTradeline[]): ParsedReport => ({ bureau: null, reportDate, tradelines, inquiries: [], publicRecords: [], identity: [], warnings: [] });

async function approve(actor: CActor, clientId: string, bureau: Bureau, p: ParsedReport): Promise<string> {
  const [id] = await asUser(actor.userId, (db) => storeParsedReport(db, actor, { clientId, parsed: p, bureau, source: 'manual' }));
  await asUser(actor.userId, (db) => decideReport(db, actor, id!, 'approved'));
  return id!;
}
const tl = (reportId: string, last4: string) => withSystem(async (db) => (await db.row<{ id: string }>('select id from public.tradelines where report_id = $1 and account_last4 = $2', [reportId, last4]))!.id);
const toolFindings = (clientId: string) => withSystem((db) => db.rows<{ id: string; category: string; dedupe_key: string; org_id: string; status: string; generated_by: string; title: string }>(
  "select id, category, dedupe_key, org_id, status, generated_by, title from public.findings where client_id = $1 and category in ('medical_collection', 'bankruptcy_reporting', 'collector_notice') order by dedupe_key", [clientId]));
const keys = async (clientId: string) => (await toolFindings(clientId)).map((f) => f.dedupe_key);

beforeAll(async () => {
  A = await makeOrg('CaseTools');
  B = await makeOrg('Elsewhere');
  owner = { orgId: A.orgId, userId: A.ownerId, role: 'owner' };
  ownerB = { orgId: B.orgId, userId: B.ownerId, role: 'owner' };
  const p = await addPortalClient(A.orgId, 'Jordan Rivera');
  client = p.clientId; portalUser = p.userId;
  foreign = await addClient(B.orgId, 'Pat Elsewhere');
  report = await approve(owner, client, 'experian', parsed('2026-10-01', LINES));
  await approve(ownerB, foreign, 'experian', parsed('2026-10-01', LINES));
});
afterAll(closePool);

describe('medical collection screen', () => {
  it('approving a report creates one finding for the collection the report calls medical, in the client’s organisation', async () => {
    const f = await toolFindings(client);
    expect(f.map((x) => x.dedupe_key)).toEqual(['medical:experian:medcollect|1111']);
    expect(f[0]).toMatchObject({ org_id: A.orgId, status: 'suggested', generated_by: CASE_TOOLS_GENERATED_BY, category: 'medical_collection' });
  });

  it('running the analysis again creates nothing new', async () => {
    const again = await asUser(owner.userId, (db) => syncCaseFindings(db, owner, client));
    expect(again).toBe(0);
    await asUser(owner.userId, (db) => regenerateFindings(db, owner, client, 'Jordan Rivera', ''));
    expect(await keys(client)).toEqual(['medical:experian:medcollect|1111']);
  });

  it('staff can mark a collection as medical, and unmark the one the report flagged', async () => {
    const [med, plain] = [await tl(report, '1111'), await tl(report, '2222')];
    await asUser(owner.userId, (db) => setMedicalFlags(db, owner, client, [med, plain], [med, plain]));
    expect(await keys(client)).toEqual(['medical:experian:medcollect|1111', 'medical:experian:plain collections|2222']);
    await asUser(owner.userId, (db) => setMedicalFlags(db, owner, client, [med, plain], [med])); // plain is not medical after all
    expect(await keys(client)).toEqual(['medical:experian:medcollect|1111']);
  });

  it('refuses an account that is not this client’s collection, and another organisation’s staff', async () => {
    const card = await tl(report, '3333');
    await expect(asUser(owner.userId, (db) => setMedicalFlags(db, owner, client, [card], [card]))).rejects.toThrow(/does not belong/);
    const med = await tl(report, '1111');
    await expect(asUser(ownerB.userId, (db) => setMedicalFlags(db, ownerB, client, [med], []))).rejects.toThrow(/does not belong/); // row-level security hides the row
    expect(await keys(client)).toEqual(['medical:experian:medcollect|1111']);
  });

  it('a finding a person dismissed is not created again, and a newer report of the same account does not repeat it', async () => {
    const [f] = await toolFindings(client);
    await withSystem((db) => db.run("update public.findings set status = 'dismissed' where id = $1", [f!.id]));
    await approve(owner, client, 'experian', parsed('2026-11-01', LINES));
    const after = await toolFindings(client);
    expect(after.map((x) => [x.dedupe_key, x.status])).toEqual([['medical:experian:medcollect|1111', 'dismissed']]);
  });
});

describe('bankruptcy discharge audit', () => {
  it('nothing is created until a discharge date is entered', async () => {
    await asUser(owner.userId, (db) => setBankruptcy(db, owner, client, { chapter: '7', filedOn: '2023-06-01' }));
    expect((await keys(client)).filter((k) => k.startsWith('bankruptcy:'))).toEqual([]);
  });

  it('with a discharge date, each negative account that predates the filing gets one finding; the account in good standing gets none', async () => {
    await asUser(owner.userId, (db) => setBankruptcy(db, owner, client, { chapter: '7', filedOn: '2023-06-01', dischargedOn: '2023-09-15' }));
    await asUser(owner.userId, (db) => setBankruptcy(db, owner, client, { chapter: '7', filedOn: '2023-06-01', dischargedOn: '2023-09-15' })); // saved twice
    const f = (await toolFindings(client)).filter((x) => x.category === 'bankruptcy_reporting');
    // Both collections went delinquent before the filing and still show a balance; so does the charged-off card.
    expect(f.map((x) => x.dedupe_key)).toEqual(['bankruptcy:experian:medcollect|1111', 'bankruptcy:experian:old|3333', 'bankruptcy:experian:plain collections|2222']);
    expect(f.every((x) => x.org_id === A.orgId && x.generated_by === CASE_TOOLS_GENERATED_BY)).toBe(true);
  });

  it('validates the dates and is closed to another organisation', async () => {
    await expect(asUser(owner.userId, (db) => setBankruptcy(db, owner, client, { chapter: '7', filedOn: '2023-06-01', dischargedOn: '2023-01-01' }))).rejects.toThrow(/on or after the filing date/);
    await expect(asUser(owner.userId, (db) => setBankruptcy(db, owner, client, { chapter: '11', filedOn: '2023-06-01' }))).rejects.toThrow(/Chapter 7 or Chapter 13/);
    await expect(asUser(ownerB.userId, (db) => setBankruptcy(db, ownerB, client, { chapter: '7', filedOn: '2023-06-01' }))).rejects.toThrow(/Client not found/);
  });

  it('clearing the bankruptcy retires its suggestions', async () => {
    await asUser(owner.userId, (db) => setBankruptcy(db, owner, client, { chapter: null }));
    expect((await keys(client)).filter((k) => k.startsWith('bankruptcy:'))).toEqual([]);
  });

  it('the other organisation’s client, with the same accounts, has only its own findings', async () => {
    const f = await toolFindings(foreign);
    expect(f.map((x) => x.dedupe_key)).toEqual(['medical:experian:medcollect|1111']);
    expect(f.every((x) => x.org_id === B.orgId)).toBe(true);
  });
});

describe('collector notices', () => {
  let notice: string;
  let latest: string;

  it('records a notice against a collection account with one finding, in the client’s organisation', async () => {
    latest = await withSystem(async (db) => (await db.row<{ id: string }>("select id from public.credit_reports where client_id = $1 and status = 'approved' order by report_date desc limit 1", [client]))!.id);
    const account = await tl(latest, '2222');
    notice = await asUser(owner.userId, (db) => recordCollectorNotice(db, owner, { clientId: client, tradelineId: account, kind: 'sent', date: '2026-11-02' }));
    const f = (await toolFindings(client)).filter((x) => x.category === 'collector_notice');
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ dedupe_key: `collector-notice:${notice}`, org_id: A.orgId, status: 'suggested' });
    expect(f[0]!.title).toBe('Collector notice from PLAIN COLLECTIONS: validation period generally ends 2026-12-09');
    const [n] = await asUser(owner.userId, (db) => loadCollectorNotices(db, client, '2026-11-19'));
    expect(n).toMatchObject({ collectorName: 'PLAIN COLLECTIONS', isCollection: true, period: { receivedOn: '2026-11-09', presumed: true, endsOn: '2026-12-09', daysLeft: 20, open: true } });
    expect(await asUser(owner.userId, (db) => openValidationWindows(db, client, '2026-11-19'))).toEqual([{ collector: 'PLAIN COLLECTIONS', endsOn: '2026-12-09', daysLeft: 20 }]);
    expect(await asUser(owner.userId, (db) => openValidationWindows(db, client, '2026-12-10'))).toEqual([]);
  });

  it('never touches a credit-report dispute: recording a notice creates no dispute and no letter', async () => {
    const n = await withSystem((db) => db.row<{ d: number; l: number }>('select (select count(*)::int from public.disputes where client_id = $1) as d, (select count(*)::int from public.letters where client_id = $1) as l', [client]));
    expect(n).toEqual({ d: 0, l: 0 });
  });

  it('the validation request goes through the ordinary dispute and letter pipeline, addressed to the collector, as a draft', async () => {
    const actor = { ...owner };
    const account = await tl(latest, '2222');
    const dispute = await asUser(owner.userId, (db) => createDispute(db, actor, { clientId: client, tradelineId: account, category: 'unverifiable_collection', reason: 'I am requesting validation of this debt: the amount and the name of the original creditor.' }));
    const letter = await asUser(owner.userId, (db) => createLetter(db, actor, { clientId: client, disputeId: dispute }));
    const row = await withSystem((db) => db.row<{ kind: string; status: string; recipient_name: string; target_type: string; bureau: string | null }>(
      'select l.kind, l.status, l.recipient_name, d.target_type, d.bureau from public.letters l join public.disputes d on d.id = l.dispute_id where l.id = $1', [letter]));
    expect(row).toEqual({ kind: 'validation_request', status: 'draft', recipient_name: 'PLAIN COLLECTIONS', target_type: 'collector', bureau: null });
  });

  it('the client can read their own notice; another organisation cannot read or write it', async () => {
    expect((await asUser(portalUser, (db) => loadCollectorNotices(db, client, '2026-11-19'))).map((n) => n.id)).toEqual([notice]);
    expect(await asUser(ownerB.userId, (db) => loadCollectorNotices(db, client, '2026-11-19'))).toEqual([]);
    await expect(asUser(ownerB.userId, (db) => recordCollectorNotice(db, ownerB, { clientId: client, collectorName: 'X Collections', kind: 'received', date: '2026-11-02' }))).rejects.toThrow(/Client not found/);
    await expect(asUser(ownerB.userId, (db) => removeCollectorNotice(db, ownerB, client, notice))).rejects.toThrow(/Notice not found/);
    await expect(asUser(portalUser, (db) => db.run('delete from public.collector_notices where id = $1', [notice]))).resolves.toBe(0); // a client cannot delete it
  });

  it('needs a collector name or a collection account, and a date that is not in the future', async () => {
    await expect(asUser(owner.userId, (db) => recordCollectorNotice(db, owner, { clientId: client, kind: 'received', date: '2026-11-02' }))).rejects.toThrow(/collector’s name/);
    await expect(asUser(owner.userId, (db) => recordCollectorNotice(db, owner, { clientId: client, collectorName: 'X', kind: 'received', date: '2999-01-01' }))).rejects.toThrow(/on or before today/);
    const card = await tl(latest, '4444');
    await expect(asUser(owner.userId, (db) => recordCollectorNotice(db, owner, { clientId: client, tradelineId: card, kind: 'received', date: '2026-11-02' }))).rejects.toThrow(/collection account/);
  });

  it('removing the notice retires its suggestion', async () => {
    await asUser(owner.userId, (db) => removeCollectorNotice(db, owner, client, notice));
    expect((await toolFindings(client)).filter((x) => x.category === 'collector_notice')).toEqual([]);
  });
});
