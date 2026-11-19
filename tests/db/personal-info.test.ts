import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadBankCases, removeBankCase, saveBankCase } from '@/lib/credit/bank-collections';
import { addMark, draftPersonalInfoLetter, loadMarks, loadReportedEntries, removeMark } from '@/lib/credit/personal-info';
import { createDispute, type DActor } from '@/lib/disputes/service';
import { createLetter, currentBody, letterBlockers, setLetterStatus } from '@/lib/letters/service';
import { decideReport, storeParsedReport } from '@/lib/reports/service';
import type { ParsedReport } from '@/lib/reports/types';
import { addClient, addPortalClient, asUser, closePool, makeOrg, withSystem, type TestOrg } from './helpers';

let A: TestOrg;
let B: TestOrg;
let owner: DActor;
let ownerB: DActor;
let client: string; // org A
let portalUser: string; // the client's own portal login
let otherPortal: { userId: string; clientId: string }; // another client of org A
let foreign: string; // org B

const staff = (o: TestOrg) => ({ orgId: o.orgId, userId: o.ownerId, source: 'staff' as const });
const letterRow = (id: string) => withSystem((db) => db.row<{ kind: string; template_key: string; language: string; status: string; dispute_id: string; org_id: string }>('select kind, template_key, language, status, dispute_id, org_id from public.letters where id = $1', [id]));
const body = async (id: string) => (await withSystem((db) => currentBody(db, id)))!.body;

beforeAll(async () => {
  A = await makeOrg('PersonalInfo');
  B = await makeOrg('Elsewhere');
  owner = { orgId: A.orgId, userId: A.ownerId, role: 'owner' };
  ownerB = { orgId: B.orgId, userId: B.ownerId, role: 'owner' };
  const p = await addPortalClient(A.orgId, 'Jordan Rivera');
  client = p.clientId; portalUser = p.userId;
  otherPortal = await addPortalClient(A.orgId, 'Sam Other');
  foreign = await addClient(B.orgId, 'Pat Elsewhere');
  // A Spanish-speaking client: the portal is in Spanish, the letter is still English.
  await withSystem((db) => db.run(`update public.clients set preferred_language = 'es', address = '{"line1":"123 Main St","city":"Tampa","state":"FL","zip":"33602"}' where id = $1`, [client]));
  const parsed: ParsedReport = {
    bureau: null, reportDate: '2026-10-01', tradelines: [], inquiries: [], publicRecords: [], warnings: [],
    identity: [{ bureau: null, kind: 'name', value: 'JORDON RIVERA' }, { bureau: null, kind: 'address', value: '12 OAK ST, MIAMI, FL 33101' }, { bureau: null, kind: 'employer', value: 'ACME FREIGHT' }],
  };
  const [rid] = await asUser(owner.userId, (db) => storeParsedReport(db, owner, { clientId: client, parsed, bureau: 'experian', source: 'manual' }));
  await asUser(owner.userId, (db) => decideReport(db, owner, rid!, 'approved'));
});
afterAll(closePool);

describe('personal information on reports', () => {
  it('offers staff the names, addresses and employers the imported report shows; nothing else is provided by the parser', async () => {
    const shown = await asUser(owner.userId, (db) => loadReportedEntries(db, client));
    expect(shown.map((e) => `${e.bureau}|${e.kind}|${e.value}`)).toEqual(['experian|address|12 OAK ST, MIAMI, FL 33101', 'experian|employer|ACME FREIGHT', 'experian|name|JORDON RIVERA']);
    // The portal does not read report data: a client gets no reported entries and types what they see.
    expect(await asUser(portalUser, (db) => loadReportedEntries(db, client))).toEqual([]);
  });

  it('staff and the client each mark entries; the client can add and remove only their own', async () => {
    await asUser(owner.userId, (db) => addMark(db, staff(A), client, { bureau: 'experian', kind: 'address', value: '12 OAK ST, MIAMI, FL 33101', issue: 'not_mine' }));
    await asUser(owner.userId, (db) => addMark(db, staff(A), client, { bureau: 'experian', kind: 'name', value: 'JORDON RIVERA', issue: 'incorrect', correctValue: 'Jordan Rivera' }));
    await asUser(portalUser, (db) => addMark(db, { orgId: A.orgId, userId: portalUser, source: 'client' }, client, { bureau: 'experian', kind: 'phone', value: '(305) 555-0199', issue: 'not_mine' }));
    await asUser(portalUser, (db) => addMark(db, { orgId: A.orgId, userId: portalUser, source: 'client' }, client, { bureau: 'equifax', kind: 'date_of_birth', value: '01/02/1991', issue: 'not_mine', correctValue: '01/02/1990' }));
    const marks = await asUser(portalUser, (db) => loadMarks(db, client));
    expect(marks.map((m) => [m.bureau, m.kind, m.issue, m.source])).toEqual([
      ['equifax', 'date_of_birth', 'incorrect', 'client'], // a date of birth is never "not mine"
      ['experian', 'address', 'not_mine', 'staff'], ['experian', 'name', 'incorrect', 'staff'], ['experian', 'phone', 'not_mine', 'client'],
    ]);
    // Marking the same entry again replaces the answer instead of listing it twice.
    await asUser(owner.userId, (db) => addMark(db, staff(A), client, { bureau: 'experian', kind: 'address', value: '  12 oak st, miami, fl 33101 ', issue: 'not_mine' }));
    expect((await asUser(owner.userId, (db) => loadMarks(db, client))).filter((m) => m.kind === 'address').map((m) => m.value)).toEqual(['12 OAK ST, MIAMI, FL 33101']);

    // The client listing an entry staff already marked changes nothing and is not an error.
    await asUser(portalUser, (db) => addMark(db, { orgId: A.orgId, userId: portalUser, source: 'client' }, client, { bureau: 'experian', kind: 'address', value: '12 Oak St, Miami, FL 33101', issue: 'incorrect', correctValue: 'x' }));
    expect((await asUser(owner.userId, (db) => loadMarks(db, client))).filter((m) => m.kind === 'address').map((m) => [m.value, m.issue, m.source])).toEqual([['12 OAK ST, MIAMI, FL 33101', 'not_mine', 'staff']]);

    // A client cannot pass their entry off as staff's, cannot remove what staff marked, and cannot write to another client's file.
    await expect(asUser(portalUser, (db) => addMark(db, { orgId: A.orgId, userId: portalUser, source: 'staff' }, client, { bureau: 'experian', kind: 'employer', value: 'ACME FREIGHT', issue: 'not_mine' }))).rejects.toThrow(/row-level security/);
    const staffMark = (await asUser(owner.userId, (db) => loadMarks(db, client))).find((m) => m.source === 'staff')!;
    await asUser(portalUser, (db) => removeMark(db, client, staffMark.id));
    expect((await asUser(owner.userId, (db) => loadMarks(db, client))).some((m) => m.id === staffMark.id)).toBe(true);
    await expect(asUser(otherPortal.userId, (db) => addMark(db, { orgId: A.orgId, userId: otherPortal.userId, source: 'client' }, client, { bureau: 'experian', kind: 'employer', value: 'ACME FREIGHT', issue: 'not_mine' }))).rejects.toThrow(/row-level security/);
    expect(await asUser(otherPortal.userId, (db) => loadMarks(db, client))).toEqual([]);
    // The client removes their own.
    const own = marks.find((m) => m.bureau === 'equifax')!;
    await asUser(portalUser, (db) => removeMark(db, client, own.id));
    expect((await asUser(owner.userId, (db) => loadMarks(db, client))).some((m) => m.id === own.id)).toBe(false);
    await expect(asUser(owner.userId, (db) => addMark(db, staff(A), client, { bureau: 'experian', kind: 'address', value: '  ', issue: 'not_mine' }))).rejects.toThrow(/as the report shows it/);
  });

  it('is invisible to, and cannot be written by, another organisation', async () => {
    expect(await asUser(ownerB.userId, (db) => loadMarks(db, client))).toEqual([]);
    expect(await asUser(ownerB.userId, (db) => loadReportedEntries(db, client))).toEqual([]);
    await expect(asUser(ownerB.userId, (db) => addMark(db, staff(B), client, { bureau: 'experian', kind: 'name', value: 'X Y', issue: 'not_mine' }))).rejects.toThrow(/row-level security/);
    await expect(asUser(ownerB.userId, (db) => addMark(db, { ...staff(B), orgId: A.orgId }, client, { bureau: 'experian', kind: 'name', value: 'X Y', issue: 'not_mine' }))).rejects.toThrow(/row-level security/);
    await expect(asUser(ownerB.userId, (db) => draftPersonalInfoLetter(db, ownerB, client, 'experian'))).rejects.toThrow(/Nothing is marked/);
    const before = (await asUser(owner.userId, (db) => loadMarks(db, client))).length;
    for (const m of await asUser(owner.userId, (db) => loadMarks(db, client))) await asUser(ownerB.userId, (db) => removeMark(db, client, m.id));
    expect((await asUser(owner.userId, (db) => loadMarks(db, client))).length).toBe(before);
  });

  it('one click drafts the correction for one bureau through the normal pipeline, in English, with the identity enclosures line', async () => {
    await expect(asUser(owner.userId, (db) => draftPersonalInfoLetter(db, owner, client, 'transunion'))).rejects.toThrow(/Nothing is marked as wrong on the TransUnion report/);
    const out = await asUser(owner.userId, (db) => draftPersonalInfoLetter(db, owner, client, 'experian', 'PersonalInfo Co'));
    const d = await withSystem((db) => db.row<{ category: string; workflow: string; target_type: string; bureau: string; status: string; item_label: string; org_id: string; fields: string[] }>(
      'select category, workflow, target_type, bureau, status, item_label, org_id, fields from public.disputes where id = $1', [out.disputeId]));
    expect(d).toEqual({ category: 'personal_info', workflow: 'personal_info', target_type: 'bureau', bureau: 'experian', status: 'draft', item_label: 'Personal information (Experian)', org_id: A.orgId, fields: ['Personal information'] });
    expect(await letterRow(out.letterId)).toEqual({ kind: 'personal_info_correction', template_key: 'personal_info_correction_en', language: 'en', status: 'draft', dispute_id: out.disputeId, org_id: A.orgId });
    const text = await body(out.letterId);
    expect(text).toContain('Experian\nP.O. Box 4500, Allen, TX 75013');
    expect(text).toContain('Re: Request to correct personal information in my file');
    expect(text).toContain('- Address shown as “12 OAK ST, MIAMI, FL 33101”: this entry is not mine.');
    expect(text).toContain('- Name shown as “JORDON RIVERA”: this entry is not correct. The correct name is “Jordan Rivera”.');
    expect(text).toContain('- Phone number shown as “(305) 555-0199”: this entry is not mine.');
    expect(text).toContain('My correct current details:\n  Name: Jordan Rivera\n  Address: 123 Main St, Tampa, FL 33602');
    expect(text).toContain('Enclosures: none'); // no identity document is accepted on file yet, and the letter says so
    expect(text).not.toMatch(/ACME FREIGHT|Equifax|01\/02\/199/); // only what is marked for this bureau
    expect(text).not.toMatch(/A quien corresponda|Atentamente|Anexos/);
    expect(await asUser(owner.userId, (db) => letterBlockers(db, out.letterId, text))).toEqual([]);

    // It is an ordinary draft: sent for approval and approved by people like any other letter.
    await asUser(owner.userId, (db) => setLetterStatus(db, owner, out.letterId, 'pending_approval'));
    await asUser(owner.userId, (db) => setLetterStatus(db, owner, out.letterId, 'approved'));
    expect((await letterRow(out.letterId))!.status).toBe('approved');
    // One correction per bureau at a time.
    await expect(asUser(owner.userId, (db) => draftPersonalInfoLetter(db, owner, client, 'experian'))).rejects.toThrow(/already in progress/);
    // The identity enclosures list applies: once a photo ID is accepted on file, the next correction letter lists it.
    await withSystem((db) => db.run(
      "insert into public.documents (org_id, client_id, kind, file_name, storage_key, mime_type, size_bytes, sha256, review_status) values ($1, $2, 'id', 'id.pdf', 'k-id', 'application/pdf', 10, 'x', 'accepted')", [A.orgId, client]));
    await asUser(owner.userId, (db) => addMark(db, staff(A), client, { bureau: 'equifax', kind: 'employer', value: 'ACME FREIGHT', issue: 'not_mine' }));
    const eq = await asUser(owner.userId, (db) => draftPersonalInfoLetter(db, owner, client, 'equifax'));
    const eqText = await body(eq.letterId);
    expect(eqText).toContain('Equifax Information Services LLC\nP.O. Box 740256, Atlanta, GA 30374');
    expect(eqText).toContain('- Employer shown as “ACME FREIGHT”: this entry is not mine.');
    expect(eqText).toContain('Enclosures:\n  - Copy: Government-issued photo ID');
    expect(eqText).not.toMatch(/JORDON RIVERA|12 OAK ST/); // Experian's entries stay in Experian's letter
    // Another organisation sees neither the dispute nor the letter.
    expect(await asUser(ownerB.userId, (db) => db.rows('select id from public.disputes where id = $1', [out.disputeId]))).toEqual([]);
    expect(await asUser(ownerB.userId, (db) => currentBody(db, out.letterId))).toBeNull();
  });
});

describe('situation letters through the pipeline', () => {
  const reason = 'I have never had an account with Acme Bank and did not open this one.';
  it('a dispute gets the letter written for its situation, and a general one when that letter’s facts are not on file', async () => {
    const notMine = await asUser(owner.userId, (db) => createDispute(db, owner, { clientId: client, category: 'not_mine', bureau: 'equifax', reason }));
    const l = await asUser(owner.userId, (db) => createLetter(db, owner, { clientId: client, disputeId: notMine }));
    expect((await letterRow(l))!.template_key).toBe('not_my_account_en');
    expect(await body(l)).toMatch(/an account in my credit file that I do not recognize as mine/);
    // "Obsolete" with no account and so no reported date: the outdated letter cannot state a date, so the general one is used.
    const old = await asUser(owner.userId, (db) => createDispute(db, owner, { clientId: client, category: 'obsolete', bureau: 'equifax', reason: 'The collection is shown with a first delinquency date in 2015.' }));
    const g = await asUser(owner.userId, (db) => createLetter(db, owner, { clientId: client, disputeId: old }));
    expect((await letterRow(g))!.template_key).toBe('bureau_dispute_en');
    // Asked for by name, it is refused instead.
    await expect(asUser(owner.userId, (db) => createLetter(db, owner, { clientId: client, disputeId: old, templateKey: 'outdated_item_en' }))).rejects.toThrow(/no reporting period to state/);
  });

  it('refuses an identity theft block until an identity theft report is on file, then encloses it', async () => {
    const id = await asUser(owner.userId, (db) => createDispute(db, owner, { clientId: client, category: 'identity_theft', bureau: 'transunion', reason }));
    await expect(asUser(owner.userId, (db) => createLetter(db, owner, { clientId: client, disputeId: id }))).rejects.toThrow(/needs an identity theft report/);
    await expect(asUser(owner.userId, (db) => createLetter(db, owner, { clientId: client, disputeId: id, templateKey: 'identity_theft_block_en' }))).rejects.toThrow(/needs an identity theft report/);
    // A report in another client's vault does not count.
    const doc = (clientId: string, orgId: string) => withSystem((db) => db.run(
      "insert into public.documents (org_id, client_id, kind, file_name, storage_key, mime_type, size_bytes, sha256) values ($1, $2, 'ftc_report', 'ftc.pdf', $3, 'application/pdf', 10, 'x')", [orgId, clientId, `k-${clientId}`]));
    await doc(otherPortal.clientId, A.orgId);
    await expect(asUser(owner.userId, (db) => createLetter(db, owner, { clientId: client, disputeId: id }))).rejects.toThrow(/needs an identity theft report/);
    await doc(client, A.orgId);
    const l = await asUser(owner.userId, (db) => createLetter(db, owner, { clientId: client, disputeId: id }));
    expect((await letterRow(l))!.template_key).toBe('identity_theft_block_en');
    const text = await body(l);
    expect(text).toContain('15 U.S.C. § 1681c-2');
    expect(text).toContain('  - Copy: FTC identity theft report');
  });

  it('refuses a re-dispute with nothing new and a bankruptcy letter with no bankruptcy recorded', async () => {
    const id = await asUser(owner.userId, (db) => createDispute(db, owner, { clientId: client, category: 'incorrect_balance', bureau: 'experian', reason: 'Experian reports $1,200.00. My statement shows $900.00.' }));
    await expect(asUser(owner.userId, (db) => createLetter(db, owner, { clientId: client, disputeId: id, templateKey: 'redispute_new_information_en' }))).rejects.toThrow(/follows an earlier dispute[\s\S]*Nothing new is on file/);
    await expect(asUser(owner.userId, (db) => createLetter(db, owner, { clientId: client, disputeId: id, templateKey: 'follow_up_en' }))).rejects.toThrow(/not been recorded as sent/);
    const bk = await asUser(owner.userId, (db) => createDispute(db, owner, { clientId: client, category: 'bankruptcy_included', bureau: 'experian', reason: 'This account was included in my bankruptcy and still shows a balance of $2,500.00.' }));
    await expect(asUser(owner.userId, (db) => createLetter(db, owner, { clientId: client, disputeId: bk }))).rejects.toThrow(/No bankruptcy is recorded/);
    await withSystem((db) => db.run("update public.clients set bankruptcy_chapter = '7', bankruptcy_filed_on = '2024-02-01', bankruptcy_discharged_on = '2024-06-03' where id = $1", [client]));
    const l = await asUser(owner.userId, (db) => createLetter(db, owner, { clientId: client, disputeId: bk }));
    expect(await body(l)).toContain('I filed a Chapter 7 bankruptcy case on February 1, 2024, and a discharge was entered on June 3, 2024.');
  });
});

describe('bank account sent to collections', () => {
  it('keeps the recorded answers inside the organisation, and drops details when the client says the record is accurate', async () => {
    const id = await asUser(owner.userId, (db) => saveBankCase(db, owner, client, { bankName: ' First Coast  Bank ', chargeAccurate: 'yes', inaccurateDetails: ['amount', 'bogus'], paid: 'yes', onCreditReports: 'unsure' }));
    await asUser(owner.userId, (db) => saveBankCase(db, owner, client, { bankName: 'Harbor CU', chargeAccurate: 'no', inaccurateDetails: ['amount', 'bogus'], paid: 'no', onCreditReports: 'yes' }));
    const cases = await asUser(owner.userId, (db) => loadBankCases(db, client));
    expect(cases.map((c) => [c.bankName, c.chargeAccurate, c.inaccurateDetails, c.paid, c.onCreditReports]).sort()).toEqual([
      ['First Coast Bank', 'yes', [], 'yes', 'unsure'], ['Harbor CU', 'no', ['amount'], 'no', 'yes'],
    ]);
    expect(await asUser(ownerB.userId, (db) => loadBankCases(db, client))).toEqual([]);
    expect(await asUser(portalUser, (db) => loadBankCases(db, client))).toEqual([]); // staff only
    await expect(asUser(ownerB.userId, (db) => saveBankCase(db, ownerB, client, { bankName: 'X Bank', chargeAccurate: 'no', inaccurateDetails: [], paid: 'no', onCreditReports: 'no' }))).rejects.toThrow(/Client not found/);
    await asUser(ownerB.userId, (db) => removeBankCase(db, ownerB, client, id));
    expect(await asUser(owner.userId, (db) => loadBankCases(db, client))).toHaveLength(2);
    await asUser(owner.userId, (db) => removeBankCase(db, owner, client, id));
    expect(await asUser(owner.userId, (db) => loadBankCases(db, client))).toHaveLength(1);
    void foreign;
  });
});
