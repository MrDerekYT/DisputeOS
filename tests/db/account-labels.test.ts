import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AiProvider, AiRequest } from '@/lib/ai/provider';
import type { Ctx } from '@/lib/auth/context';
import type { SessionInfo } from '@/lib/auth/service';
import { accountLabel } from '@/lib/credit/account-kind';
import { AI_LABEL_LIMIT, labelAccountsWithAi, setAccountKind, type LActor } from '@/lib/credit/account-labels';
import { loadBankruptcyOnReports, loadCaseLines, loadCollectorNotices, recordCollectorNotice, setMedicalFlags } from '@/lib/credit/case-tools';
import { loadAnalysisInput as loadInput } from '@/lib/reports/service';
import { can, type Permission, type Role } from '@/lib/rbac';
import { decideReport, loadAnalysisInput, storeParsedReport } from '@/lib/reports/service';
import type { ParsedPublicRecord, ParsedReport, ParsedTradeline } from '@/lib/reports/types';
import type { Bureau } from '@/lib/util';
import { addClient, addMember, asUser, closePool, makeOrg, withSystem, type TestOrg } from './helpers';

/**
 * What each account is (src/lib/credit/account-kind.ts) and what is kept on file about it (src/lib/credit/account-labels.ts):
 * a person's label, carried to the same account on a later report; AI suggestions, checked against the account's own
 * words and paid for only when kept; and the case tools that fill themselves in from the labels and the reports.
 * Through the real services and actions under row-level security; only the sign-in and the AI are stood in for.
 */
const signedIn = vi.hoisted(() => ({ ctx: null as unknown }));
vi.mock('@/lib/auth/context', () => ({
  requireStaff: async (perm?: string) => {
    const ctx = signedIn.ctx as { can(p: string): boolean };
    if (perm && !ctx.can(perm)) throw new Error('REDIRECT /app?denied=1');
    return ctx;
  },
}));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));

import { setAccountKindAction } from '@/app/app/clients/account-label-actions';

let A: TestOrg;
let B: TestOrg;
let owner: LActor;
let ownerB: LActor;
let client: string;
let other: string; // org B

const line = (creditor: string, last4: string | null, o: Partial<ParsedTradeline> = {}): ParsedTradeline => ({
  bureau: null, item_type: 'tradeline', creditor_name: creditor, original_creditor: null, account_last4: last4, account_type: 'Credit card', account_status: 'Open', payment_status: 'Current',
  balance_cents: 50000, credit_limit_cents: 200000, high_balance_cents: null, date_opened: '2019-05-01', date_reported: null, date_of_first_delinquency: null, payment_history: null, remarks: null,
  confidence: 1, field_meta: {}, ...o,
});
/** An account whose words say nothing about what it is. */
const bare = (creditor: string, last4: string, o: Partial<ParsedTradeline> = {}) => line(creditor, last4, { account_type: null, account_status: null, payment_status: null, ...o });
const parsed = (reportDate: string, tradelines: ParsedTradeline[], publicRecords: ParsedPublicRecord[] = []): ParsedReport =>
  ({ bureau: null, reportDate, tradelines, inquiries: [], publicRecords, identity: [], warnings: [] });

async function approve(actor: LActor, clientId: string, bureau: Bureau, p: ParsedReport): Promise<string> {
  const [id] = await asUser(actor.userId, (db) => storeParsedReport(db, actor, { clientId, parsed: p, bureau, source: 'manual' }));
  await asUser(actor.userId, (db) => decideReport(db, actor, id!, 'approved'));
  return id!;
}
const lineOf = (reportId: string, last4: string) => withSystem(async (db) => (await db.row<{ id: string }>('select id from public.tradelines where report_id = $1 and account_last4 = $2', [reportId, last4]))!.id);
const stored = (id: string) => withSystem(async (db) => (await db.row<{ kind_label: Record<string, unknown> | null }>('select kind_label from public.tradelines where id = $1', [id]))!.kind_label);
const grant = (orgId: string, amount: number) => withSystem((db) => db.run("insert into public.ai_credit_ledger (org_id, delta, reason, note) values ($1, $2, 'grant', 'test grant')", [orgId, amount]));
const balance = (orgId: string) => withSystem(async (db) => (await db.row<{ n: number }>('select coalesce(sum(delta), 0)::int as n from public.ai_credit_ledger where org_id = $1', [orgId]))!.n);
const who = (a: LActor) => ({ orgId: a.orgId, userId: a.userId, role: a.role, tx: ((fn) => asUser(a.userId, fn)) as Ctx['tx'] });

/** A stand-in AI: records what it was sent and answers with the given text. */
function fakeAi(answer: string | ((req: AiRequest) => string)) {
  const sent: AiRequest[] = [];
  const provider: AiProvider = { name: 'fake', async complete(req) { sent.push(req); return typeof answer === 'string' ? answer : answer(req); } };
  return { provider, sent };
}

function signIn(role: Role = 'owner', without?: Permission): void {
  const session: SessionInfo = { sessionId: 's', userId: A.ownerId, orgId: A.orgId, role, email: A.ownerEmail, fullName: 'Test Person', mfaVerified: true, totpEnabled: false, orgName: 'Labels', orgSlug: 'labels', orgMode: 'agency', orgPlan: 'trial' };
  const ctx: Ctx = { session, userId: A.ownerId, orgId: A.orgId, role, tx: (fn) => asUser(A.ownerId, fn), can: (p) => p !== without && can(role, p), need: () => undefined, meta: { ip: '10.0.0.1', userAgent: 'vitest' } };
  signedIn.ctx = ctx;
}

let report: string;

beforeAll(async () => {
  A = await makeOrg('Labels');
  B = await makeOrg('Elsewhere');
  owner = { orgId: A.orgId, userId: A.ownerId, role: 'owner' };
  ownerB = { orgId: B.orgId, userId: B.ownerId, role: 'owner' };
  client = await addClient(A.orgId, 'Robin Example');
  other = await addClient(B.orgId, 'Pat Elsewhere');
  report = await approve(owner, client, 'experian', parsed('2026-09-01', [
    bare('MIDLAND CREDIT MANAGEMENT', '1111'), // nothing but the company's name
    bare('ODD WORDING BANK', '2222', { remarks: 'Rating: Unrated' }), // words the rules do not read
    line('GOOD STANDING CU', '3333'),
    line('LISTED AS ONE', '4444', { payment_status: 'Collection' }), // a creditor's own account in collection: no collector
    bare('NOBODY ASKED', '5555'),
    line('VALLEY RADIOLOGY', '7070', { item_type: 'collection', account_type: 'Collection', account_status: null, payment_status: null, balance_cents: 30000, date_of_first_delinquency: '2026-06-01' }),
  ], [{ bureau: null, kind: 'Chapter 7 Bankruptcy', court: 'US Bankruptcy Court', amount_cents: null, filed_date: '2019-03-02', status: 'Discharged' }]));
  await approve(ownerB, other, 'experian', parsed('2026-09-01', [bare('MIDLAND CREDIT MANAGEMENT', '1111')]));
});
afterAll(closePool);

describe('a person’s label', () => {
  it('is saved on the account, wins over the report’s words, and is kept for the same account on a later report', async () => {
    const id = await lineOf(report, '5555');
    signIn();
    const fd = new FormData();
    fd.set('clientId', client); fd.append('ids', id); fd.set('kind', 'charge_off');
    expect(await setAccountKindAction({}, fd)).toEqual({ ok: 'Label saved.' });
    expect(await stored(id)).toMatchObject({ kind: 'charge_off', by: 'staff', user: A.ownerId });

    // A newer Experian report of the same account: the label comes with it, marked as carried.
    const newer = await approve(owner, client, 'experian', parsed('2026-10-01', [bare('NOBODY ASKED', '5555'), line('GOOD STANDING CU', '3333')]));
    const input = await asUser(owner.userId, (db) => loadAnalysisInput(db, client));
    const carried = input.tradelines.find((t) => t.account_last4 === '5555')!;
    expect(accountLabel(carried)).toMatchObject({ kind: 'charge_off', by: 'staff', carried: true });
    expect(await stored(await lineOf(newer, '5555'))).toBeNull(); // read through, not copied

    // Clearing it on the new report clears it on the earlier one too, so it does not come back.
    const fd2 = new FormData();
    fd2.set('clientId', client); fd2.append('ids', await lineOf(newer, '5555')); fd2.set('kind', '');
    expect(await setAccountKindAction({}, fd2)).toEqual({ ok: 'Label cleared: the report’s words decide again.' });
    expect(await stored(id)).toBeNull();
    const again = (await asUser(owner.userId, (db) => loadAnalysisInput(db, client))).tradelines.find((t) => t.account_last4 === '5555')!;
    expect(accountLabel(again).kind).toBe('unknown');
    // Back to the September report as the newest, for the tests below.
    await withSystem((db) => db.run("update public.credit_reports set status = 'rejected' where id = $1", [newer]));
  });

  it('refuses another client’s account, a label that is not one, and another workspace', async () => {
    const theirs = await withSystem(async (db) => (await db.row<{ id: string }>("select id from public.tradelines where client_id = $1 and account_last4 = '1111'", [other]))!.id);
    await expect(asUser(owner.userId, (db) => setAccountKind(db, owner, client, [theirs], 'collection'))).rejects.toThrow('That account does not belong to this client.');
    const mine = await lineOf(report, '5555');
    await expect(asUser(owner.userId, (db) => setAccountKind(db, owner, client, [mine], 'great' as never))).rejects.toThrow('Choose a label.');
    await expect(asUser(ownerB.userId, (db) => setAccountKind(db, ownerB, client, [mine], 'collection'))).rejects.toThrow('That account does not belong to this client.');
    expect(await stored(await lineOf(report, '5555'))).toBeNull();
  });

  it('asks for the permission to edit reports', async () => {
    signIn('owner', 'reports:write');
    const fd = new FormData();
    fd.set('clientId', client); fd.append('ids', await lineOf(report, '5555')); fd.set('kind', 'good');
    await expect(setAccountKindAction({}, fd)).rejects.toThrow('REDIRECT /app?denied=1');
  });
});

describe('AI suggestions', () => {
  it('asks only about accounts the rules could not label, sends their own words only, and keeps what rests on them', async () => {
    await grant(A.orgId, 10);
    const before = await balance(A.orgId);
    const ai = fakeAi((req) => {
      const refs = [...req.user.matchAll(/^(A\d+)$/gm)].map((m) => m[1]);
      return refs.map((r, i) => (i === 0 ? `${r}|collection|MIDLAND CREDIT MANAGEMENT` : i === 1 ? `${r}|good|Unrated` : `${r}|unknown|`)).join('\n');
    });
    const r = await labelAccountsWithAi(who(owner), client, ai.provider);
    expect(r).toMatchObject({ asked: 3, labelled: 1, unknown: 2, ai: { status: 'charged', cost: 2 } });
    expect(await balance(A.orgId)).toBe(before - 2);

    // Sent: the three accounts the rules could not label, with their own words; never the client, an amount or an account number.
    const sent = ai.sent[0]!.user;
    expect(sent).toContain('company: MIDLAND CREDIT MANAGEMENT');
    expect(sent).toContain('remarks: Rating: Unrated');
    expect(sent).toContain('company: NOBODY ASKED');
    expect(sent).not.toMatch(/GOOD STANDING|LISTED AS ONE|Robin|Example|1111|2222|500\.00|50000/);

    expect(await stored(await lineOf(report, '1111'))).toMatchObject({ kind: 'collection', by: 'ai', words: 'MIDLAND CREDIT MANAGEMENT', field: 'creditor_name' });
    // "good" may not rest on remarks: kept as asked-and-unknown, so it is not sent (or paid for) again.
    expect(await stored(await lineOf(report, '2222'))).toMatchObject({ kind: 'unknown', by: 'ai' });
    const lines = await asUser(owner.userId, (db) => loadCaseLines(db, client));
    expect(accountLabel(lines.find((t) => t.account_last4 === '1111')!)).toMatchObject({ kind: 'collection', by: 'ai' });
    expect(accountLabel(lines.find((t) => t.account_last4 === '2222')!)).toMatchObject({ kind: 'unknown', aiTried: true });

    // Nothing left to ask: no call, no charge.
    const again = fakeAi('A1|collection|x');
    expect(await labelAccountsWithAi(who(owner), client, again.provider)).toMatchObject({ asked: 0, ai: { status: 'not_called' } });
    expect(again.sent).toHaveLength(0);
    expect(await balance(A.orgId)).toBe(before - 2);
  });

  it('drops words that are not in the account, and gives the credits back when nothing is kept', async () => {
    const c = await addClient(A.orgId, 'Second Example');
    const rep = await approve(owner, c, 'equifax', parsed('2026-09-01', [bare('PLAIN NAME LLC', '7777'), bare('ANOTHER LLC', '8888')]));
    const before = await balance(A.orgId);
    const ai = fakeAi('A1|charge_off|Charged off as bad debt\nA2|good|PLAIN NAME LLC'); // invented words; a name never shows "good"
    const r = await labelAccountsWithAi(who(owner), c, ai.provider);
    expect(r).toMatchObject({ asked: 2, labelled: 0, ai: { status: 'refunded', cost: 0 } });
    expect(await balance(A.orgId)).toBe(before);
    expect(await stored(await lineOf(rep, '7777'))).toMatchObject({ kind: 'unknown', by: 'ai' });
  });

  it('never writes over a person’s label, and asks nothing with no AI connected', async () => {
    const c = await addClient(A.orgId, 'Third Example');
    const rep = await approve(owner, c, 'transunion', parsed('2026-09-01', [bare('STAFF KNOWS LLC', '6666')]));
    await asUser(owner.userId, async (db) => setAccountKind(db, owner, c, [await lineOf(rep, '6666')], 'good'));
    const ai = fakeAi('A1|collection|STAFF KNOWS LLC');
    expect(await labelAccountsWithAi(who(owner), c, ai.provider)).toMatchObject({ asked: 0 });
    expect(ai.sent).toHaveLength(0);
    expect(await stored(await lineOf(rep, '6666'))).toMatchObject({ kind: 'good', by: 'staff' });

    await withSystem((db) => db.run('update public.tradelines set kind_label = null where report_id = $1', [rep]));
    expect(await labelAccountsWithAi(who(owner), c, null)).toMatchObject({ asked: 0, ai: { status: 'no_provider' } });
    expect(await stored(await lineOf(rep, '6666'))).toBeNull();
  });

  it('asks at most AI_LABEL_LIMIT accounts at a time, and only in the caller’s workspace', async () => {
    const c = await addClient(A.orgId, 'Many Accounts');
    await approve(owner, c, 'experian', parsed('2026-09-01', Array.from({ length: AI_LABEL_LIMIT + 3 }, (_, i) => bare(`CREDITOR ${i}`, String(1000 + i)))));
    const ai = fakeAi('');
    await labelAccountsWithAi(who(owner), c, ai.provider);
    expect([...ai.sent[0]!.user.matchAll(/^A\d+$/gm)]).toHaveLength(AI_LABEL_LIMIT);
    await expect(labelAccountsWithAi(who(ownerB), c, fakeAi('').provider)).rejects.toThrow('Client not found.');
    await expect(labelAccountsWithAi({ ...who(owner), role: 'client' }, c, fakeAi('').provider)).rejects.toThrow();
  });
});

describe('case tools that fill themselves in', () => {
  it('a collector’s account takes a notice; a creditor’s own account in collection, or an AI suggestion, does not until a person says so', async () => {
    // Listed under collections: a collector's account.
    const collector = await lineOf(report, '7070');
    await asUser(owner.userId, (db) => recordCollectorNotice(db, owner, { clientId: client, tradelineId: collector, kind: 'received', date: '2026-10-01' }));
    const notices = await asUser(owner.userId, (db) => loadCollectorNotices(db, client, '2026-10-05'));
    expect(notices[0]).toMatchObject({ tradelineId: collector, collectorName: 'VALLEY RADIOLOGY', isCollection: true, account: { creditor: 'VALLEY RADIOLOGY', last4: '7070' } });
    // In collection, but the creditor's own account: there is no collector to write to.
    await expect(asUser(owner.userId, async (db) => recordCollectorNotice(db, owner, { clientId: client, tradelineId: await lineOf(report, '4444'), kind: 'received', date: '2026-10-01' })))
      .rejects.toThrow('Choose a collection account.');
    // MIDLAND carries an AI suggestion of "collection" from the test above: shown, but nothing is done with it...
    const byAi = await lineOf(report, '1111');
    await expect(asUser(owner.userId, (db) => recordCollectorNotice(db, owner, { clientId: client, tradelineId: byAi, kind: 'received', date: '2026-10-01' }))).rejects.toThrow('Choose a collection account.');
    await expect(asUser(owner.userId, (db) => setMedicalFlags(db, owner, client, [byAi], [byAi]))).rejects.toThrow('That account does not belong to this client.');
    // ...until a person confirms it.
    await asUser(owner.userId, (db) => setAccountKind(db, owner, client, [byAi], 'collection'));
    await asUser(owner.userId, (db) => recordCollectorNotice(db, owner, { clientId: client, tradelineId: byAi, kind: 'received', date: '2026-10-02' }));
    await asUser(owner.userId, (db) => setMedicalFlags(db, owner, client, [byAi], []));
    // A card in good standing is not a collection.
    await expect(asUser(owner.userId, async (db) => setMedicalFlags(db, owner, client, [await lineOf(report, '3333')], [])))
      .rejects.toThrow('That account does not belong to this client.');
  });

  it('a collector’s name that sounds medical makes no finding by itself', async () => {
    // VALLEY RADIOLOGY: a collection under $500, and only its name says medical.
    const findings = await withSystem((db) => db.rows<{ dedupe_key: string }>("select dedupe_key from public.findings where client_id = $1 and category = 'medical_collection'", [client]));
    expect(findings).toEqual([]);
  });

  it('reads a bankruptcy off the reports for the form, and saves nothing', async () => {
    const on = await asUser(owner.userId, (db) => loadBankruptcyOnReports(db, client));
    expect(on.record).toMatchObject({ bureau: 'experian', kind: 'Chapter 7 Bankruptcy', chapter: '7', filedOn: '2019-03-02', status: 'Discharged' });
    expect(await withSystem(async (db) => (await db.row<{ c: string | null }>('select bankruptcy_chapter as c from public.clients where id = $1', [client]))!.c)).toBeNull();
    // Another workspace sees nothing of it.
    expect((await asUser(ownerB.userId, (db) => loadBankruptcyOnReports(db, client))).record).toBeNull();
  });
});

describe('the same account on reports that print no account number', () => {
  it('a person’s label is carried by creditor and open date, and a notice is found again on the newer report', async () => {
    const c = await addClient(A.orgId, 'No Numbers Example');
    const noNum = (o: Partial<ParsedTradeline> = {}) => bare('SAMPLE RECOVERY LLC', null as unknown as string, { item_type: 'collection', account_type: 'Collection', date_opened: '2023-02-01', original_creditor: 'ACME BANK', ...o });
    const first = await approve(owner, c, 'transunion', parsed('2026-08-01', [noNum()]));
    const firstLine = await withSystem(async (db) => (await db.row<{ id: string }>('select id from public.tradelines where report_id = $1', [first]))!.id);
    await asUser(owner.userId, (db) => setAccountKind(db, owner, c, [firstLine], 'collection'));
    await asUser(owner.userId, (db) => recordCollectorNotice(db, owner, { clientId: c, tradelineId: firstLine, kind: 'received', date: '2026-08-05' }));
    // The next TransUnion report: a new row for the same account, still with no number.
    const second = await approve(owner, c, 'transunion', parsed('2026-10-01', [noNum({ balance_cents: 51000 })]));
    const input = await asUser(owner.userId, (db) => loadInput(db, c));
    expect(input.tradelines.map((t) => accountLabel(t))).toMatchObject([{ kind: 'collection', by: 'staff', carried: true }]);
    const lines = await asUser(owner.userId, (db) => loadCaseLines(db, c));
    const notices = await asUser(owner.userId, (db) => loadCollectorNotices(db, c, '2026-10-05'));
    const { noticeIsFor } = await import('@/lib/credit/case-tools');
    const secondLine = await withSystem(async (db) => (await db.row<{ id: string }>('select id from public.tradelines where report_id = $1', [second]))!.id);
    expect(lines.map((t) => t.id)).toEqual([secondLine]); // the newer report's row, a different row from the one the notice was recorded on
    expect(noticeIsFor(notices[0]!, lines)).toBe(true);
  });
});

describe('someone who is staff in two workspaces', () => {
  it('cannot label, record a notice on or mark medical another workspace’s client from the one they work in', async () => {
    const both = await addMember(A.orgId, 'manager', 'both');
    await withSystem((db) => db.run("insert into public.memberships (org_id, user_id, role) values ($1, $2, 'manager')", [B.orgId, both.id]));
    const inA: LActor = { orgId: A.orgId, userId: both.id, role: 'manager' };
    const theirs = await withSystem(async (db) => (await db.row<{ id: string }>("select id from public.tradelines where client_id = $1 and account_last4 = '1111'", [other]))!.id);
    // Row-level security lets them see B's account...
    expect(await asUser(both.id, (db) => db.row('select 1 as ok from public.tradelines where id = $1', [theirs]))).toEqual({ ok: 1 });
    // ...but nothing is written to it from workspace A.
    await expect(asUser(both.id, (db) => setAccountKind(db, inA, other, [theirs], 'collection'))).rejects.toThrow('That account does not belong to this client.');
    await expect(asUser(both.id, (db) => recordCollectorNotice(db, inA, { clientId: other, collectorName: 'MIDLAND', kind: 'received', date: '2026-10-01' }))).rejects.toThrow('Client not found.');
    await expect(asUser(both.id, (db) => setMedicalFlags(db, inA, other, [theirs], []))).rejects.toThrow('Client not found.');
    expect(await stored(theirs)).toBeNull();
    expect(await withSystem(async (db) => (await db.row<{ n: number }>('select count(*)::int as n from public.collector_notices where client_id = $1', [other]))!.n)).toBe(0);
  });
});
