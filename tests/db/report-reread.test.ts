import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Ctx } from '@/lib/auth/context';
import { signUp, type SessionInfo } from '@/lib/auth/service';
import { STAFF_REPORT_AUTHORIZATION_NEEDED } from '@/lib/credit/authorization';
import { recordCollectorNotice } from '@/lib/credit/case-tools';
import { sha256Hex } from '@/lib/crypto';
import type { Db } from '@/lib/db';
import { createDispute, type DActor } from '@/lib/disputes/service';
import { can, type Permission, type Role } from '@/lib/rbac';
import { TRANSUNION_CHECK_WARNING } from '@/lib/reports/bureau-layouts';
import { ReportReadError, type ReadResult } from '@/lib/reports/read-file';
import { REREAD_DOCUMENT_REJECTED, REREAD_IN_USE, REREAD_NO_FILE, REREAD_NOT_PENDING, REREAD_NOTHING, REREAD_UNLABELLED, rereadNotInFile, rereadReport } from '@/lib/reports/reread';
import { decideReport, readingMark, REPORT_CHANGED, storeParsedReport } from '@/lib/reports/service';
import type { ParsedReport, ParsedTradeline } from '@/lib/reports/types';
import { putObject } from '@/lib/storage';
import type { Bureau } from '@/lib/util';
import { recordConsentRows } from './consents';
import { addClient, addMember, asUser, closePool, makeOrg, PASSWORD, testIp, uniq, withSystem, type TestOrg } from './helpers';

/**
 * "Read the file again" (src/lib/reports/reread.ts): the stored file of a report that is still waiting for review is
 * read once more and what the fresh reading holds for that report takes the place of what it held. Only that one
 * report changes, approved and rejected reports never do, and Approve decides the reading that was on screen.
 * Through the real services and actions under row-level security; only the sign-in is stood in for.
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
vi.mock('next/navigation', async (original) => ({ ...(await original<typeof import('next/navigation')>()), redirect: (to: string) => { throw new Error(`REDIRECT ${to}`); } }));

import { decideReportAction, deleteTradelineAction, rereadReportAction, updateTradelineAction } from '@/app/app/reports/actions';

let A: TestOrg;
let B: TestOrg;
let owner: DActor;
let ownerB: DActor;
let client: string; // org A, with the written authorization on file

const tx: Ctx['tx'] = (fn) => asUser(owner.userId, fn);
const TU_PDF = () => readFileSync('tests/fixtures/errata/tu_planted.pdf'); // a generated TransUnion report, an invented person

/** Signs the owner in for the actions. `without` takes one permission away, to see which one an action asks for. */
function signIn(role: Role = 'owner', without?: Permission): void {
  const session: SessionInfo = { sessionId: 's', userId: A.ownerId, orgId: A.orgId, role, email: A.ownerEmail, fullName: 'Test Person', mfaVerified: true, totpEnabled: false, orgName: 'Reread', orgSlug: 'reread', orgMode: 'agency', orgPlan: 'trial' };
  const ctx: Ctx = { session, userId: A.ownerId, orgId: A.orgId, role, tx, can: (p) => p !== without && can(role, p), need: () => undefined, meta: { ip: '10.0.0.1', userAgent: 'vitest' } };
  signedIn.ctx = ctx;
}
const form = (fields: Record<string, string>) => { const fd = new FormData(); for (const [k, v] of Object.entries(fields)) fd.set(k, v); return fd; };

const line = (creditor: string, last4: string | null, o: Partial<ParsedTradeline> = {}): ParsedTradeline => ({
  bureau: null, item_type: 'tradeline', creditor_name: creditor, original_creditor: null, account_last4: last4, account_type: 'Credit card', account_status: 'Open', payment_status: 'Current',
  balance_cents: 50000, credit_limit_cents: 200000, high_balance_cents: null, date_opened: '2019-05-01', date_reported: null, date_of_first_delinquency: null, payment_history: null, remarks: null,
  confidence: 1, field_meta: {}, ...o,
});
const parsed = (tradelines: ParsedTradeline[], o: Partial<ParsedReport> = {}): ParsedReport =>
  ({ bureau: null, reportDate: '2026-03-01', tradelines, inquiries: [], publicRecords: [], identity: [], warnings: [], ...o });
/** A reader that names its bureau on every row, as the real readers do once they have detected one. */
const stamped = (bureau: Bureau, tradelines: ParsedTradeline[], o: Partial<ParsedReport> = {}) => parsed(tradelines.map((t) => ({ ...t, bureau })), { bureau, ...o });
/** Stands in for the file reader, and counts how often the file was read (an AI read is paid for each time). */
function reads(p: ParsedReport, via: ReadResult['via'] = 'rules') {
  const deps = { calls: 0, read: async () => { deps.calls++; return { parsed: p, via }; } };
  return deps;
}
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** A transaction that is held open until `release()`: `started` resolves once `work` has run inside it. */
function held<T>(userId: string, work: (db: Db) => Promise<T>) {
  let release!: () => void; const gate = new Promise<void>((r) => { release = r; });
  let ready!: () => void; const started = new Promise<void>((r) => { ready = r; });
  const done = asUser(userId, async (db) => { const out = await work(db); ready(); await gate; return out; });
  return { started, release, done };
}

/** A file in the vault, filed as a credit report. */
async function fileDoc(clientId: string, o: { bytes?: Buffer; mime?: string; source?: 'staff' | 'client'; org?: TestOrg } = {}): Promise<string> {
  const org = o.org ?? A;
  const bytes = o.bytes ?? Buffer.from('a report');
  const key = await putObject(org.orgId, clientId, bytes);
  return withSystem(async (db) => (await db.row<{ id: string }>(
    `insert into public.documents (org_id, client_id, kind, file_name, mime_type, size_bytes, sha256, storage_key, uploaded_by, source, review_status)
     values ($1,$2,'credit_report','report.pdf',$3,$4,$5,$6,$7,$8,'accepted') returning id`,
    [org.orgId, clientId, o.mime ?? 'text/plain', bytes.length, sha256Hex(bytes), key, org.ownerId, o.source ?? 'staff']))!.id);
}
/** The earlier reading of that file, stored the way an upload stores it. */
const firstReading = (clientId: string, documentId: string | null, p: ParsedReport, bureau: Bureau | null = 'experian', actor: DActor = owner) =>
  asUser(actor.userId, (db) => storeParsedReport(db, actor, { clientId, parsed: p, bureau, documentId, source: documentId ? 'upload' : 'manual' }));

const report = (id: string) => withSystem((db) => db.row<{ id: string; status: string; bureau: Bureau; report_date: string | null; warnings: string[]; created_at: string; document_id: string | null; org_id: string }>(
  'select id, status, bureau, report_date::text, warnings, created_at::text, document_id, org_id from public.credit_reports where id = $1', [id]));
const accounts = (reportId: string) => withSystem((db) => db.rows<{ id: string; creditor_name: string; account_last4: string | null; item_type: string; bureau: Bureau; balance_cents: number | null; user_provided: Record<string, unknown>; org_id: string }>(
  'select id, creditor_name, account_last4, item_type, bureau, balance_cents, user_provided, org_id from public.tradelines where report_id = $1 order by creditor_name, id', [reportId]));
const names = async (reportId: string) => (await accounts(reportId)).map((t) => t.creditor_name);
const readingsOf = (documentId: string) => withSystem((db) => db.rows<{ id: string; bureau: Bureau; status: string }>(
  'select id, bureau, status from public.credit_reports where document_id = $1 order by bureau', [documentId]));
const count = (sql: string, p: unknown[]) => withSystem((db) => db.row<{ n: number }>(sql, p as never[])).then((r) => r!.n);
const mark = (id: string) => asUser(owner.userId, (db) => readingMark(db, id));

beforeAll(async () => {
  A = await makeOrg('Reread');
  B = await makeOrg('Elsewhere');
  owner = { orgId: A.orgId, userId: A.ownerId, role: 'owner' };
  ownerB = { orgId: B.orgId, userId: B.ownerId, role: 'owner' };
  client = await addClient(A.orgId, 'Jordan Rivera');
  await recordConsentRows(A.orgId, client);
});
afterAll(closePool);

describe('reading a stored report file again', () => {
  it('a poor earlier reading of a TransUnion PDF is replaced by today’s reader, and the report keeps its id', async () => {
    const doc = await fileDoc(client, { bytes: TU_PDF(), mime: 'application/pdf' });
    // What an older reader made of it: one row that is really a label, and a line of the page taken for an inquiry.
    const [id] = await firstReading(client, doc, parsed([line('Account Number', null, { confidence: 0.2 })], { inquiries: [{ bureau: null, name: 'Location Requested On', inquiry_date: null }], reportDate: null }), 'transunion');
    const was = (await report(id!))!;
    expect(await accounts(id!)).toHaveLength(1);

    const r = await rereadReport(tx, owner, id!);
    expect(r).toEqual({ clientId: client, reportId: id, bureau: 'transunion', movedFrom: null, accounts: 12, collections: 3, inquiries: 3, publicRecords: 0, alsoHolds: [], via: 'layout', pages: 6 });

    const now = (await report(id!))!;
    expect(now).toMatchObject({ status: 'pending_review', bureau: 'transunion', document_id: doc });
    expect(now.created_at).toBe(was.created_at);
    expect(now.report_date).not.toBeNull();
    expect(now.warnings).toContain(TRANSUNION_CHECK_WARNING);
    const rows = await accounts(id!);
    expect(rows).toHaveLength(15);
    expect(rows.filter((t) => t.item_type === 'collection')).toHaveLength(3);
    expect(rows.some((t) => t.creditor_name === 'Account Number')).toBe(false);
    expect(await count('select count(*)::int as n from public.inquiries where report_id = $1', [id])).toBe(3);
    expect(await count("select count(*)::int as n from public.inquiries where report_id = $1 and name = 'Location Requested On'", [id])).toBe(0);
    expect(await readingsOf(doc)).toHaveLength(1);

    // On the record: the timeline says it was read again, and the audit trail has who did it.
    expect(await count("select count(*)::int as n from public.client_events where client_id = $1 and summary = 'Transunion report read again (15 accounts) — awaiting review'", [client])).toBe(1);
    const audit = await withSystem((db) => db.row<{ actor_id: string; meta: { accounts: number; via: string } }>("select actor_id, metadata as meta from public.audit_logs where action = 'report.reread' and entity_id = $1", [id]));
    expect(audit).toMatchObject({ actor_id: owner.userId, meta: { accounts: 15, via: 'layout', bureau: 'transunion' } });
  });

  it('corrections and the client’s statements typed into the earlier reading go with it; the fresh reading is what the file says', async () => {
    const doc = await fileDoc(client);
    const [id] = await firstReading(client, doc, parsed([line('ACME BANK', '1234'), line('MISREAD ROW', null)]));
    await withSystem((db) => db.run(`update public.tradelines set balance_cents = 1, confidence = 1, user_provided = '{"not_mine":true}' where report_id = $1 and creditor_name = 'ACME BANK'`, [id]));
    const before = await accounts(id!);

    const r = await rereadReport(tx, owner, id!, reads(parsed([line('ACME BANK', '1234', { balance_cents: 77700 }), line('SECOND LENDER', '9999')], { reportDate: '2026-04-02', warnings: ['Check the dates.'] })));
    expect(r).toMatchObject({ reportId: id, bureau: 'experian', movedFrom: null, accounts: 2, collections: 0, alsoHolds: [] });
    const after = await accounts(id!);
    expect(after.map((t) => [t.creditor_name, t.account_last4, Number(t.balance_cents), t.user_provided])).toEqual([['ACME BANK', '1234', 77700, {}], ['SECOND LENDER', '9999', 50000, {}]]);
    expect(after.some((t) => before.some((b) => b.id === t.id))).toBe(false); // new rows, not edits of the old ones
    expect(await report(id!)).toMatchObject({ report_date: '2026-04-02', warnings: ['Check the dates.'], status: 'pending_review' });
  });

  it('an approved or rejected report is refused before the file is read, and nothing about it changes', async () => {
    for (const decision of ['approved', 'rejected'] as const) {
      const doc = await fileDoc(client);
      const [id] = await firstReading(client, doc, parsed([line(`DECIDED ${decision}`, '1111')]), 'equifax');
      await asUser(owner.userId, (db) => decideReport(db, owner, id!, decision));
      const before = await accounts(id!);
      const reader = reads(parsed([line('SOMETHING ELSE', '2222')]));
      await expect(rereadReport(tx, owner, id!, reader)).rejects.toThrow(REREAD_NOT_PENDING);
      expect(reader.calls).toBe(0);
      expect(await accounts(id!)).toEqual(before);
      expect(await report(id!)).toMatchObject({ status: decision });
      expect(await readingsOf(doc)).toHaveLength(1);
    }
  });

  it('a report approved while the file was being read is left alone', async () => {
    const doc = await fileDoc(client);
    const [id] = await firstReading(client, doc, parsed([line('RACE BANK', '3333')]), 'equifax');
    const before = await accounts(id!);
    const approvingMeanwhile = { read: async () => { await asUser(owner.userId, (db) => decideReport(db, owner, id!, 'approved')); return { parsed: parsed([line('SOMETHING ELSE', '2222')]), via: 'rules' as const }; } };
    await expect(rereadReport(tx, owner, id!, approvingMeanwhile)).rejects.toThrow(REREAD_NOT_PENDING);
    expect(await accounts(id!)).toEqual(before);
    expect(await report(id!)).toMatchObject({ status: 'approved' });
  });

  it('a swap that meets an approval still in progress waits for it, then leaves the approved report alone', async () => {
    const doc = await fileDoc(client);
    const [id] = await firstReading(client, doc, parsed([line('LOCKED BANK', '4141')]), 'equifax');
    const before = await accounts(id!);
    // The approval holds the report row and has not committed: the re-read still sees a pending report, reads the
    // file, and then has to wait at the same row.
    const approving = held(owner.userId, (db) => decideReport(db, owner, id!, 'approved'));
    await approving.started;
    let settled = false;
    const rereading = rereadReport(tx, owner, id!, reads(parsed([line('SOMETHING ELSE', '2222')]))).finally(() => { settled = true; });
    rereading.catch(() => undefined);
    await pause(400);
    expect(settled).toBe(false);
    approving.release();
    await approving.done;
    await expect(rereading).rejects.toThrow(REREAD_NOT_PENDING);
    expect(await accounts(id!)).toEqual(before);
    expect(await report(id!)).toMatchObject({ status: 'approved' });
  });

  it('two people reading the same file again at once end with one whole reading, never a mix', async () => {
    const doc = await fileDoc(client);
    const [id] = await firstReading(client, doc, parsed([line('BEFORE', '0000')]));
    const both = await Promise.allSettled([
      rereadReport(tx, owner, id!, reads(parsed([line('FROM A 1', '0001'), line('FROM A 2', '0002')]))),
      rereadReport(tx, owner, id!, reads(parsed([line('FROM B 1', '0003')]))),
    ]);
    expect(both.map((x) => x.status)).toEqual(['fulfilled', 'fulfilled']);
    const end = await names(id!);
    expect([['FROM A 1', 'FROM A 2'], ['FROM B 1']]).toContainEqual(end);
    expect(await readingsOf(doc)).toHaveLength(1);
  });

  it('a report with no stored file, or whose document was rejected, cannot be read again', async () => {
    const [manual] = await firstReading(client, null, parsed([line('TYPED IN', '4444')]));
    await expect(rereadReport(tx, owner, manual!, reads(parsed([line('X', '1')])))).rejects.toThrow(REREAD_NO_FILE);

    const gone = await fileDoc(client);
    const [orphan] = await firstReading(client, gone, parsed([line('FILE DELETED', '5555')]));
    await withSystem((db) => db.run('delete from public.documents where id = $1', [gone]));
    await expect(rereadReport(tx, owner, orphan!, reads(parsed([line('X', '1')])))).rejects.toThrow(REREAD_NO_FILE);

    const refused = await fileDoc(client);
    const [id] = await firstReading(client, refused, parsed([line('DOC REJECTED', '6666')]));
    await withSystem((db) => db.run("update public.documents set review_status = 'rejected' where id = $1", [refused]));
    await expect(rereadReport(tx, owner, id!, reads(parsed([line('X', '1')])))).rejects.toThrow(REREAD_DOCUMENT_REJECTED);
    expect(await names(id!)).toEqual(['DOC REJECTED']);
  });

  it('a file that cannot be read now, or in which nothing is recognised, leaves the earlier reading as it was', async () => {
    const doc = await fileDoc(client);
    const [id] = await firstReading(client, doc, parsed([line('KEPT BANK', '7777')]));
    const before = await accounts(id!);
    const seen = await mark(id!);
    await expect(rereadReport(tx, owner, id!, { read: async () => { throw new ReportReadError('The accounts in this report could not be recognised.'); } })).rejects.toThrow('The accounts in this report could not be recognised.');
    await expect(rereadReport(tx, owner, id!, reads(parsed([])))).rejects.toThrow(REREAD_NOTHING);
    await expect(rereadReport(tx, owner, id!, reads(parsed([], { warnings: ['This looks like a scanned PDF.'] })))).rejects.toThrow('This looks like a scanned PDF.');
    // Something that is not about the file (the vault, the database) is not shown as if it were.
    await expect(rereadReport(tx, owner, id!, { load: async () => { throw new Error('Stored object not found'); } })).rejects.toThrow('Stored object not found');
    expect(await accounts(id!)).toEqual(before);
    expect(await mark(id!)).toBe(seen);
    expect(await count("select count(*)::int as n from public.audit_logs where action = 'report.reread' and entity_id = $1", [id])).toBe(0);
  });

  it('a file staff added needs the client’s authorization on file; one the client uploaded, or in a personal workspace, does not', async () => {
    const c = await addClient(A.orgId, 'No Authorization Yet');
    const staffDoc = await fileDoc(c);
    const [staffId] = await firstReading(c, staffDoc, parsed([line('STAFF FILE', '8888')]));
    const unread = reads(parsed([line('X', '1')]));
    await expect(rereadReport(tx, owner, staffId!, unread)).rejects.toThrow(STAFF_REPORT_AUTHORIZATION_NEEDED);
    expect(unread.calls).toBe(0);
    expect(await names(staffId!)).toEqual(['STAFF FILE']);

    const clientDoc = await fileDoc(c, { source: 'client' });
    const [clientId] = await firstReading(c, clientDoc, parsed([line('CLIENT FILE', '8889')]));
    await rereadReport(tx, owner, clientId!, reads(parsed([line('CLIENT FILE READ AGAIN', '8889')])));
    expect(await names(clientId!)).toEqual(['CLIENT FILE READ AGAIN']);

    // Authorization on file: allowed. Revoked while the file is being read: refused at the write.
    await recordConsentRows(A.orgId, c);
    await rereadReport(tx, owner, staffId!, reads(parsed([line('STAFF FILE READ AGAIN', '8888')])));
    const revokingMeanwhile = { read: async () => { await withSystem((db) => db.run("update public.client_consents set revoked_at = now() where client_id = $1 and kind = 'fcra_authorization'", [c])); return { parsed: parsed([line('X', '1')]), via: 'rules' as const }; } };
    await expect(rereadReport(tx, owner, staffId!, revokingMeanwhile)).rejects.toThrow(STAFF_REPORT_AUTHORIZATION_NEEDED);
    expect(await names(staffId!)).toEqual(['STAFF FILE READ AGAIN']);

    const me = await signUp({ email: `own-${uniq()}@test.dev`, password: PASSWORD, fullName: 'Robin Own', orgName: `Own ${uniq()}`, mode: 'personal' }, { ip: testIp() });
    if (!me.ok) throw new Error(me.error);
    const P: TestOrg = { orgId: me.orgId, ownerId: me.userId, ownerEmail: '' };
    const self = await addClient(P.orgId, 'Robin Own');
    const actor: DActor = { orgId: P.orgId, userId: P.ownerId, role: 'owner' };
    const ownDoc = await fileDoc(self, { org: P });
    const [ownId] = await firstReading(self, ownDoc, parsed([line('MY OWN FILE', '8890')]), 'experian', actor);
    await rereadReport((fn) => asUser(P.ownerId, fn), actor, ownId!, reads(parsed([line('MY OWN FILE READ AGAIN', '8890')])));
    expect(await names(ownId!)).toEqual(['MY OWN FILE READ AGAIN']);
  });

  it('a reading with a dispute or a collector notice on one of its accounts is refused before the file is read', async () => {
    const doc = await fileDoc(client);
    const [id] = await firstReading(client, doc, parsed([line('DISPUTED BANK', '1212')]));
    const [t] = await accounts(id!);
    const dispute = await asUser(owner.userId, (db) => createDispute(db, owner, { clientId: client, tradelineId: t!.id, category: 'not_mine', reason: 'I do not recognise this account. Please verify it.' }));
    const reader = reads(parsed([line('X', '1')]));
    await expect(rereadReport(tx, owner, id!, reader)).rejects.toThrow(REREAD_IN_USE);
    expect(reader.calls).toBe(0); // an AI read would have been paid for and then thrown away
    expect(await accounts(id!)).toEqual([t]);
    expect(await withSystem((db) => db.row<{ tradeline_id: string }>('select tradeline_id from public.disputes where id = $1', [dispute]))).toEqual({ tradeline_id: t!.id });

    const doc2 = await fileDoc(client);
    const [id2] = await firstReading(client, doc2, parsed([line('SOME COLLECTOR', '3434', { item_type: 'collection' })]));
    const [c2] = await accounts(id2!);
    await asUser(owner.userId, (db) => recordCollectorNotice(db, owner, { clientId: client, tradelineId: c2!.id, kind: 'received', date: '2026-01-15' }));
    await expect(rereadReport(tx, owner, id2!, reads(parsed([line('X', '1')])))).rejects.toThrow(REREAD_IN_USE);
    expect(await accounts(id2!)).toEqual([c2]);
  });

  it('a dispute attached while the file was being read, or being attached as the swap starts, is seen and never detached', async () => {
    // Attached and committed during the read: the check under the lock sees it.
    const doc = await fileDoc(client);
    const [id] = await firstReading(client, doc, parsed([line('LATE DISPUTE BANK', '1313')]));
    const [t] = await accounts(id!);
    const attachingMeanwhile = { read: async () => { await asUser(owner.userId, (db) => createDispute(db, owner, { clientId: client, tradelineId: t!.id, category: 'not_mine', reason: 'I do not recognise this account. Please verify it.' })); return { parsed: parsed([line('X', '1')]), via: 'rules' as const }; } };
    await expect(rereadReport(tx, owner, id!, attachingMeanwhile)).rejects.toThrow(REREAD_IN_USE);
    expect(await accounts(id!)).toEqual([t]);

    // Still being attached (its transaction is open) when the swap reaches the accounts: the swap waits, then sees it.
    const doc2 = await fileDoc(client);
    const [id2] = await firstReading(client, doc2, parsed([line('OPEN DISPUTE BANK', '1414')]));
    const [t2] = await accounts(id2!);
    const attaching = held(owner.userId, (db) => createDispute(db, owner, { clientId: client, tradelineId: t2!.id, category: 'not_mine', reason: 'I do not recognise this account. Please verify it.' }));
    await attaching.started;
    let settled = false;
    const rereading = rereadReport(tx, owner, id2!, reads(parsed([line('X', '1')]))).finally(() => { settled = true; });
    rereading.catch(() => undefined);
    await pause(400);
    expect(settled).toBe(false);
    attaching.release();
    const dispute = await attaching.done;
    await expect(rereading).rejects.toThrow(REREAD_IN_USE);
    expect(await accounts(id2!)).toEqual([t2]);
    expect(await withSystem((db) => db.row<{ tradeline_id: string }>('select tradeline_id from public.disputes where id = $1', [dispute]))).toEqual({ tradeline_id: t2!.id });
  });

  it('a file with several bureaus: only the report the button is on changes', async () => {
    const doc = await fileDoc(client);
    const three = parsed([line('EXP BANK', '0001', { bureau: 'experian' }), line('EQF BANK', '0002', { bureau: 'equifax' }), line('TU BANK', '0003', { bureau: 'transunion' })]);
    expect(await firstReading(client, doc, three, null)).toHaveLength(3);
    const by = Object.fromEntries((await readingsOf(doc)).map((x) => [x.bureau, x.id])) as Record<Bureau, string>;
    await asUser(owner.userId, (db) => decideReport(db, owner, by.transunion, 'approved'));
    const equifaxRows = await accounts(by.equifax);
    const approvedRows = await accounts(by.transunion);

    // Read again from the Experian report. The file gives rows for all three bureaus, changed.
    const fresh = parsed([line('EXP BANK', '0001', { bureau: 'experian', balance_cents: 12300 }), line('EXP SECOND', '0004', { bureau: 'experian' }),
      line('EQF BANK CHANGED', '0002', { bureau: 'equifax' }), line('TU BANK CHANGED', '0003', { bureau: 'transunion' })]);
    const r = await rereadReport(tx, owner, by.experian, reads(fresh));
    expect(r).toMatchObject({ reportId: by.experian, bureau: 'experian', movedFrom: null, accounts: 2, alsoHolds: ['equifax', 'transunion'] });
    expect(await names(by.experian)).toEqual(['EXP BANK', 'EXP SECOND']);
    expect(await accounts(by.equifax)).toEqual(equifaxRows); // still waiting for review, and not touched: same rows, same ids
    expect(await accounts(by.transunion)).toEqual(approvedRows); // approved: same rows, same ids
    expect(await readingsOf(doc)).toEqual([{ id: by.equifax, bureau: 'equifax', status: 'pending_review' }, { id: by.experian, bureau: 'experian', status: 'pending_review' }, { id: by.transunion, bureau: 'transunion', status: 'approved' }]);

    // The file, read again, holds nothing for the Equifax report: it is kept as it was, and so is everything else.
    const kept = await accounts(by.experian);
    await expect(rereadReport(tx, owner, by.equifax, reads(parsed([line('EXP ONLY', '0009', { bureau: 'experian' }), line('TU ONLY', '0008', { bureau: 'transunion' })]))))
      .rejects.toThrow(rereadNotInFile('equifax', ['experian', 'transunion']));
    expect(rereadNotInFile('equifax', ['experian', 'transunion'])).toBe('Read again, this file holds nothing for Equifax: what was read belongs to Experian and TransUnion. The earlier reading was kept.');
    expect(await accounts(by.equifax)).toEqual(equifaxRows);
    expect(await accounts(by.experian)).toEqual(kept);
    expect(await accounts(by.transunion)).toEqual(approvedRows);
    expect(await readingsOf(doc)).toHaveLength(3);
  });

  it('in a file with several reports, rows that name no bureau are not guessed at', async () => {
    // No bureau found for the file; the person who added it chose Equifax; one account says "Bureau: Experian". The
    // first reading made an Experian report (the labelled row) and an Equifax report (the rest).
    const doc = await fileDoc(client);
    const first = parsed([line('LABELLED BANK', '2101', { bureau: 'experian' }), line('UNLABELLED BANK', '2102'), line('UNLABELLED LENDER', '2103')]);
    expect(await firstReading(client, doc, first, 'equifax')).toHaveLength(2);
    const by = Object.fromEntries((await readingsOf(doc)).map((x) => [x.bureau, x.id])) as Record<Bureau, string>;
    expect(await names(by.experian)).toEqual(['LABELLED BANK']);
    expect(await names(by.equifax)).toEqual(['UNLABELLED BANK', 'UNLABELLED LENDER']);
    const [experianRows, equifaxRows] = [await accounts(by.experian), await accounts(by.equifax)];

    // Read again from either report: nothing records which report took the unlabelled rows, so neither is changed.
    for (const id of [by.experian, by.equifax]) await expect(rereadReport(tx, owner, id, reads(first))).rejects.toThrow(REREAD_UNLABELLED);
    expect(await accounts(by.experian)).toEqual(experianRows); // not handed the Equifax report's rows as well
    expect(await accounts(by.equifax)).toEqual(equifaxRows);
  });

  it('a one-bureau file stays under its bureau when the reader names none, and moves when the reader names another on every row', async () => {
    const doc = await fileDoc(client);
    const [id] = await firstReading(client, doc, parsed([line('CHOSEN BUREAU BANK', '5656')]), 'equifax');
    // No bureau detected in the text: the bureau the person chose at upload still stands.
    const same = await rereadReport(tx, owner, id!, reads(parsed([line('CHOSEN BUREAU BANK', '5656'), line('NEW ROW', '5757')])));
    expect(same).toMatchObject({ reportId: id, bureau: 'equifax', movedFrom: null, accounts: 2 });
    expect(await readingsOf(doc)).toEqual([{ id, bureau: 'equifax', status: 'pending_review' }]);
    expect((await accounts(id!)).map((t) => t.bureau)).toEqual(['equifax', 'equifax']);

    // Today's reader recognises the file as TransUnion's own layout and says so on every row, as a first reading would
    // have: the same report, at the same address, is now the TransUnion report.
    const moved = await rereadReport(tx, owner, id!, reads(stamped('transunion', [line('LAYOUT BANK', '5656')]), 'layout'));
    expect(moved).toMatchObject({ reportId: id, bureau: 'transunion', movedFrom: 'equifax', accounts: 1, alsoHolds: [] });
    expect(await readingsOf(doc)).toEqual([{ id, bureau: 'transunion', status: 'pending_review' }]);
    expect((await accounts(id!)).map((t) => [t.creditor_name, t.bureau])).toEqual([['LAYOUT BANK', 'transunion']]);
    expect(await withSystem((db) => db.row<{ meta: { moved_from: string } }>("select metadata as meta from public.audit_logs where action = 'report.reread' and entity_id = $1 order by created_at desc limit 1", [id]))).toMatchObject({ meta: { moved_from: 'equifax', bureau: 'transunion' } });
  });

  it('another workspace cannot read this one’s report again, and neither can someone signed in to another of their workspaces', async () => {
    const doc = await fileDoc(client);
    const [id] = await firstReading(client, doc, parsed([line('PRIVATE BANK', '9090')]));
    await expect(rereadReport((fn) => asUser(ownerB.userId, fn), ownerB, id!, reads(parsed([line('X', '1')])))).rejects.toThrow('Report not found.');

    // Staff in both workspaces, working in B: row-level security lets them see A's report, but the rows a reading
    // writes carry the workspace of the session, so the re-read is for the session's workspace only.
    const both = await addMember(A.orgId, 'manager', 'both');
    await withSystem((db) => db.run("insert into public.memberships (org_id, user_id, role) values ($1, $2, 'manager')", [B.orgId, both.id]));
    const inB: DActor = { orgId: B.orgId, userId: both.id, role: 'manager' };
    expect(await asUser(both.id, (db) => db.row('select 1 as ok from public.credit_reports where id = $1', [id]))).toEqual({ ok: 1 });
    await expect(rereadReport((fn) => asUser(both.id, fn), inB, id!, reads(parsed([line('X', '1')])))).rejects.toThrow('Report not found.');
    expect(await names(id!)).toEqual(['PRIVATE BANK']);
    expect((await accounts(id!)).every((t) => t.org_id === A.orgId)).toBe(true);
  });
});

describe('approving the reading that was on screen', () => {
  it('the mark of a reading changes when the file is read again or a row is removed, not when a value is corrected', async () => {
    const doc = await fileDoc(client);
    const [id] = await firstReading(client, doc, parsed([line('MARK BANK', '6161'), line('MARK LENDER', '6262')]), 'equifax');
    const first = await mark(id!);
    expect(first).toMatch(/^[0-9a-f]{32}$/);
    await withSystem((db) => db.run("update public.tradelines set balance_cents = 99 where report_id = $1 and creditor_name = 'MARK BANK'", [id]));
    expect(await mark(id!)).toBe(first);

    await rereadReport(tx, owner, id!, reads(parsed([line('MARK BANK', '6161'), line('MARK LENDER', '6262')])));
    const second = await mark(id!);
    expect(second).not.toBe(first); // the same values, but not the rows that were on screen
    await expect(asUser(owner.userId, (db) => decideReport(db, owner, id!, 'approved', first))).rejects.toThrow(REPORT_CHANGED);
    await expect(asUser(owner.userId, (db) => decideReport(db, owner, id!, 'rejected', first))).rejects.toThrow(REPORT_CHANGED);
    expect(await report(id!)).toMatchObject({ status: 'pending_review' });

    await withSystem((db) => db.run("delete from public.tradelines where report_id = $1 and creditor_name = 'MARK LENDER'", [id]));
    const third = await mark(id!);
    expect(third).not.toBe(second);
    await expect(asUser(owner.userId, (db) => decideReport(db, owner, id!, 'approved', second))).rejects.toThrow(REPORT_CHANGED);

    await asUser(owner.userId, (db) => decideReport(db, owner, id!, 'approved', third));
    expect(await report(id!)).toMatchObject({ status: 'approved' });
  });
});

describe('the buttons on the review page', () => {
  it('“Read the file again” answers with what this report now holds, and with the reason when it refuses', async () => {
    signIn();
    const doc = await fileDoc(client, { bytes: TU_PDF(), mime: 'application/pdf' });
    const [id] = await firstReading(client, doc, parsed([line('Account Number', null)]), 'transunion');
    expect(await rereadReportAction(undefined, form({ id: id! }))).toEqual({ ok: 'Read again. TransUnion: 12 accounts, 3 collections, 3 inquiries, all 6 pages read.' });
    expect(await accounts(id!)).toHaveLength(15);

    await asUser(owner.userId, (db) => decideReport(db, owner, id!, 'approved'));
    expect(await rereadReportAction(undefined, form({ id: id! }))).toEqual({ error: REREAD_NOT_PENDING });
    expect(await accounts(id!)).toHaveLength(15);
  });

  it('“Read the file again” is closed to anyone who may not change reports, and asks for no other permission', async () => {
    const doc = await fileDoc(client, { bytes: Buffer.from('ROLE BANK,7171'), mime: 'text/plain' });
    const [id] = await firstReading(client, doc, parsed([line('ROLE BANK', '7171')]));
    signIn('owner', 'reports:write');
    await expect(rereadReportAction(undefined, form({ id: id! }))).rejects.toThrow('REDIRECT /app?denied=1');
    signIn('client');
    await expect(rereadReportAction(undefined, form({ id: id! }))).rejects.toThrow('REDIRECT /app?denied=1');
    expect(await names(id!)).toEqual(['ROLE BANK']);
    // With every other permission taken away in turn it still gets as far as reading the file (which holds no report).
    for (const other of ['clients:write', 'clients:delete', 'disputes:write', 'letters:write'] as const) {
      signIn('owner', other);
      expect(await rereadReportAction(undefined, form({ id: id! }))).toHaveProperty('error');
    }
    expect(await names(id!)).toEqual(['ROLE BANK']);
  });

  it('Approve pressed on a page loaded before the file was read again decides nothing and sends the person back to look', async () => {
    signIn();
    const doc = await fileDoc(client);
    const [id] = await firstReading(client, doc, parsed([line('STALE PAGE BANK', '8181')]), 'equifax');
    const onScreen = await mark(id!);
    await rereadReport(tx, owner, id!, reads(parsed([line('UNSEEN BANK', '8282')])));

    await expect(decideReportAction(form({ id: id!, decision: 'approved', mark: onScreen }))).rejects.toThrow(`REDIRECT /app/reports/${id}?changed=1`);
    await expect(decideReportAction(form({ id: id!, decision: 'rejected', mark: onScreen }))).rejects.toThrow(`REDIRECT /app/reports/${id}?changed=1`);
    expect(await report(id!)).toMatchObject({ status: 'pending_review' });
    // A decision that does not say which reading it is about is not accepted at all.
    await expect(decideReportAction(form({ id: id!, decision: 'approved' }))).rejects.toThrow(/mark/);
    expect(await report(id!)).toMatchObject({ status: 'pending_review' });

    await expect(decideReportAction(form({ id: id!, decision: 'approved', mark: await mark(id!) }))).rejects.toThrow(`REDIRECT /app/clients/${client}/compare`);
    expect(await report(id!)).toMatchObject({ status: 'approved' });
  });

  it('a correction typed into a row that is gone is refused, not reported as saved', async () => {
    signIn();
    const doc = await fileDoc(client);
    const [id] = await firstReading(client, doc, parsed([line('EDITED BANK', '9191')]));
    const [old] = await accounts(id!);
    const edit = () => updateTradelineAction(undefined, form({ id: old!.id, reportId: id!, creditor: 'EDITED BANK', last4: '9191', balance: '1.00' }));

    // The row is being removed at this moment (as a re-read removes it): the edit finds it, waits for it, and then
    // has nothing left to change. It used to answer "Account updated".
    const removing = held(owner.userId, (db) => db.run('delete from public.tradelines where id = $1', [old!.id]));
    await removing.started;
    const editing = edit();
    await pause(400);
    removing.release();
    await removing.done;
    expect(await editing).toEqual({ error: 'This account is no longer on the report: the file was read again or the row was removed. Reload the page.' });

    // Already gone when the edit arrives.
    expect(await edit()).toEqual({ error: 'Account not found.' });
    expect(await accounts(id!)).toEqual([]);
  });

  it('“Remove (misread row)” never takes a row out of a report that is approved, or being approved at that moment', async () => {
    signIn();
    const doc = await fileDoc(client);
    const [id] = await firstReading(client, doc, parsed([line('REMOVED BANK', '9292'), line('STAYING BANK', '9393')]), 'equifax');
    const rows = await accounts(id!);
    const remove = (t: { id: string }) => deleteTradelineAction(form({ id: t.id, reportId: id! }));

    // Waiting for review: the row goes, and the mark of the reading changes with it.
    const before = await mark(id!);
    await remove(rows[0]!);
    expect(await names(id!)).toEqual(['STAYING BANK']);
    expect(await mark(id!)).not.toBe(before);

    // An approval is in progress (not committed yet): the removal waits for it and then leaves the row where it is.
    const approving = held(owner.userId, (db) => decideReport(db, owner, id!, 'approved', undefined));
    await approving.started;
    const removing = remove(rows[1]!);
    await pause(400);
    approving.release();
    await approving.done;
    await removing;
    expect(await names(id!)).toEqual(['STAYING BANK']);
    expect(await report(id!)).toMatchObject({ status: 'approved' });

    // Approved: nothing is removed.
    await remove(rows[1]!);
    expect(await names(id!)).toEqual(['STAYING BANK']);
  });
});
