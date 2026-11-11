import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseReportText } from '@/lib/reports/parser';
import { decideReport, storeParsedReport } from '@/lib/reports/service';
import { addEvidence, createDispute, recordResponse, startNextRound, transitionDispute, type DActor } from '@/lib/disputes/service';
import { createLetter, currentBody, markSent, saveVersion, setLetterStatus, type LActor } from '@/lib/letters/service';
import { draftReason } from '@/lib/disputes/reasons';
import { addClient, addMember, asUser, closePool, makeOrg, withSystem, type TestOrg } from './helpers';
import { recordConsentRows } from './consents';

const EXPERIAN = `Experian Credit Report
Report Date: 01/15/2026

Accounts
Account Name: CAPITAL ONE BANK USA
Account Number: 517805551234
Account Status: Open
Balance: $1,200
Date Opened: 03/2018
Date Reported: 01/02/2026

Collections
Collection Agency: MIDLAND CREDIT
Original Creditor: CAPITAL ONE
Account Number: 00099887766
Balance: $980
Date of First Delinquency: 02/14/2016
`;
const EQUIFAX = EXPERIAN.replace('Experian', 'Equifax').replace('$1,200', '$900');

let org: TestOrg;
let clientId: string;
let specialist: DActor;
let manager: DActor;
let mgrL: LActor;
let specL: LActor;

beforeAll(async () => {
  org = await makeOrg('Flow');
  clientId = await addClient(org.orgId, 'Jordan Rivera');
  await withSystem((db) => db.run(`update public.clients set address = '{"line1":"123 Main St","city":"Tampa","state":"FL","zip":"33602"}', preferred_language='en' where id = $1`, [clientId]));
  const s = await addMember(org.orgId, 'specialist');
  const m = await addMember(org.orgId, 'manager');
  specialist = { orgId: org.orgId, userId: s.id, role: 'specialist' };
  manager = { orgId: org.orgId, userId: m.id, role: 'manager' };
  specL = specialist;
  mgrL = manager;
});
afterAll(closePool);

describe('report import → review → findings', () => {
  let expId = '';
  it('stores a parsed report as pending review and nothing is analysed until a person approves it', async () => {
    const [id] = await asUser(specialist.userId, (db) => storeParsedReport(db, specialist, { clientId, parsed: parseReportText(EXPERIAN), source: 'upload' }));
    expId = id!;
    const s = await withSystem((db) => db.row<{ status: string; n: number; f: number }>('select r.status, (select count(*)::int from public.tradelines where report_id = r.id) as n, (select count(*)::int from public.findings where client_id = r.client_id) as f from public.credit_reports r where r.id = $1', [expId]));
    expect(s).toEqual({ status: 'pending_review', n: 2, f: 0 });
  });
  it('never stores a full account number', async () => {
    const rows = await withSystem((db) => db.rows<{ account_last4: string; field_meta: unknown }>('select account_last4, field_meta from public.tradelines where report_id = $1', [expId]));
    expect(JSON.stringify(rows)).not.toContain('51780555');
    expect(rows.map((r) => r.account_last4).sort()).toEqual(['1234', '7766']);
  });
  it('approving builds cross-bureau findings from the latest approved report per bureau', async () => {
    await asUser(manager.userId, (db) => decideReport(db, manager, expId, 'approved'));
    const [eq] = await asUser(specialist.userId, (db) => storeParsedReport(db, specialist, { clientId, parsed: parseReportText(EQUIFAX), source: 'upload' }));
    await asUser(manager.userId, (db) => decideReport(db, manager, eq!, 'approved'));
    const f = await withSystem((db) => db.rows<{ category: string; basis: string; status: string }>('select category, basis, status from public.findings where client_id = $1 order by category', [clientId]));
    const cats = f.map((x) => x.category);
    expect(cats).toContain('balance_mismatch');
    expect(cats).toContain('obsolete_item');
    expect(cats).toContain('duplicate_account');
    expect(f.find((x) => x.category === 'balance_mismatch')).toMatchObject({ basis: 'potential_discrepancy', status: 'suggested' });
  });
  it('re-running never duplicates findings or resets reviewed ones', async () => {
    const before = await withSystem((db) => db.row<{ id: string }>("select id from public.findings where client_id = $1 and category = 'balance_mismatch'", [clientId]));
    await withSystem((db) => db.run("update public.findings set status = 'accepted' where id = $1", [before!.id]));
    const [again] = await asUser(specialist.userId, (db) => storeParsedReport(db, specialist, { clientId, parsed: parseReportText(EXPERIAN), source: 'upload' }));
    await asUser(manager.userId, (db) => decideReport(db, manager, again!, 'approved'));
    const rows = await withSystem((db) => db.rows<{ status: string }>("select status from public.findings where client_id = $1 and category = 'balance_mismatch'", [clientId]));
    expect(rows).toEqual([{ status: 'accepted' }]);
  });
  it('rejects double review', async () => {
    await expect(asUser(manager.userId, (db) => decideReport(db, manager, expId, 'approved'))).rejects.toThrow(/already been reviewed/);
  });
  it('requires a bureau when one cannot be detected', async () => {
    await expect(asUser(specialist.userId, (db) => storeParsedReport(db, specialist, { clientId, parsed: parseReportText('Accounts\nAccount Name: X\nBalance: 5'), source: 'upload' }))).rejects.toThrow(/Choose which bureau/);
  });
});

describe('dispute → letter → approval → submission → response → next round', () => {
  let tradelineId = '';
  let disputeId = '';
  let letterId = '';

  beforeAll(async () => {
    const t = await withSystem((db) => db.row<{ id: string }>("select id from public.tradelines where client_id = $1 and bureau = 'experian' and item_type = 'tradeline' limit 1", [clientId]));
    tradelineId = t!.id;
  });

  it('creates a draft with a deterministic, fact-based reason', async () => {
    const reason = draftReason({ category: 'incorrect_balance', creditor: 'CAPITAL ONE BANK USA', last4: '1234', bureau: 'experian', evidence: [
      { bureau: 'experian', field: 'Balance', value: '$1,200.00', source: 'reported' }, { bureau: 'equifax', field: 'Balance', value: '$900.00', source: 'reported' }] });
    expect(reason).toMatch(/Experian reports \$1,200\.00; Equifax reports \$900\.00/);
    expect(reason).toMatch(/verified/);
    disputeId = await asUser(specialist.userId, (db) => createDispute(db, specialist, { clientId, tradelineId, category: 'incorrect_balance', reason }));
    const d = await withSystem((db) => db.row<{ status: string; bureau: string; item_label: string; round: number }>('select status, bureau, item_label, round from public.disputes where id = $1', [disputeId]));
    expect(d).toMatchObject({ status: 'draft', bureau: 'experian', round: 1 });
    expect(d!.item_label).toContain('1234');
  });
  it('refuses vague reasons and cross-client accounts', async () => {
    await expect(asUser(specialist.userId, (db) => createDispute(db, specialist, { clientId, tradelineId, category: 'other', reason: 'bad' }))).rejects.toThrow(/at least a sentence/);
    const other = await addClient(org.orgId, 'Someone Else');
    await expect(asUser(specialist.userId, (db) => createDispute(db, specialist, { clientId: other, tradelineId, category: 'incorrect_balance', reason: 'A perfectly long reason here' }))).rejects.toThrow(/does not belong/);
  });
  it('needs a letter before review; the letter merges real client and account data', async () => {
    await expect(asUser(specialist.userId, (db) => transitionDispute(db, specialist, disputeId, 'ready_for_review'))).rejects.toThrow(/Create a letter/);
    letterId = await asUser(specialist.userId, (db) => createLetter(db, specialist, { clientId, disputeId }));
    const b = (await withSystem((db) => currentBody(db, letterId)))!;
    expect(b.version).toBe(1);
    expect(b.body).toContain('Jordan Rivera');
    expect(b.body).toContain('123 Main St');
    expect(b.body).toContain('Experian');
    expect(b.body).toContain('Section 611');
    expect(b.body).not.toMatch(/\{\{|NEEDED/);
    expect(b.body).not.toMatch(/guarantee/i);
  });
  it('lets a specialist send for review but not approve', async () => {
    await asUser(specialist.userId, (db) => transitionDispute(db, specialist, disputeId, 'ready_for_review'));
    await expect(asUser(specialist.userId, (db) => transitionDispute(db, specialist, disputeId, 'approved'))).rejects.toThrow(/Not permitted: disputes:approve/);
  });
  it('blocks illegal jumps', async () => {
    await expect(asUser(manager.userId, (db) => transitionDispute(db, manager, disputeId, 'resolved'))).rejects.toThrow(/cannot move/);
  });
  it('cannot submit before the letter is approved, even after the dispute is approved', async () => {
    await asUser(manager.userId, (db) => transitionDispute(db, manager, disputeId, 'approved'));
    await expect(asUser(manager.userId, (db) => transitionDispute(db, manager, disputeId, 'submitted'))).rejects.toThrow(/no approved letter/);
  });
  it('blocks letters with prohibited claims or unresolved fields from approval', async () => {
    await asUser(specialist.userId, (db) => saveVersion(db, specL, letterId, 'Dear Experian,\nWe guarantee this account will be deleted within 30 days.\n[RECIPIENT ADDRESS NEEDED]\nJordan Rivera'));
    await expect(asUser(specialist.userId, (db) => setLetterStatus(db, specL, letterId, 'pending_approval'))).rejects.toThrow(/Prohibited claim|Fill in/);
    // restore a clean version
    const clean = (await withSystem((db) => db.row<{ body: string }>('select body from public.letter_versions where letter_id = $1 and version = 1', [letterId])))!.body;
    const v = await asUser(specialist.userId, (db) => saveVersion(db, specL, letterId, clean, 'manual_edit', 'Restored'));
    expect(v).toBe(3);
  });
  it('requires a manager to approve, and any later edit voids the approval', async () => {
    await asUser(specialist.userId, (db) => setLetterStatus(db, specL, letterId, 'pending_approval'));
    await expect(asUser(specialist.userId, (db) => setLetterStatus(db, specL, letterId, 'approved'))).rejects.toThrow(/letters:approve/);
    await asUser(manager.userId, (db) => setLetterStatus(db, mgrL, letterId, 'approved'));
    await asUser(specialist.userId, (db) => saveVersion(db, specL, letterId, 'Dear Experian,\nA slightly edited letter body that is long enough.\nJordan Rivera', 'manual_edit'));
    const l = await withSystem((db) => db.row<{ status: string; approved_by: string | null }>('select status, approved_by from public.letters where id = $1', [letterId]));
    expect(l).toEqual({ status: 'draft', approved_by: null });
    // restore + re-approve the exact reviewed text
    const clean = (await withSystem((db) => db.row<{ body: string }>('select body from public.letter_versions where letter_id = $1 and version = 3', [letterId])))!.body;
    await asUser(specialist.userId, (db) => saveVersion(db, specL, letterId, clean));
    await asUser(specialist.userId, (db) => setLetterStatus(db, specL, letterId, 'pending_approval'));
    await asUser(manager.userId, (db) => setLetterStatus(db, mgrL, letterId, 'approved'));
  });
  it('blocks submission until the client’s required consents are on file', async () => {
    await expect(asUser(manager.userId, (db) => transitionDispute(db, manager, disputeId, 'submitted'))).rejects.toThrow(/Required consents are missing/);
    await recordConsentRows(org.orgId, clientId);
  });
  it('submits: sets the FCRA 30-day clock, marks the letter sent, advances the client', async () => {
    await asUser(manager.userId, (db) => transitionDispute(db, manager, disputeId, 'submitted', { receivedOn: '2026-03-02', sentMethod: 'certified_mail', tracking: '9400 1000' }));
    const d = await withSystem((db) => db.row<{ status: string; due_at: string; submitted_at: string }>('select status, due_at, submitted_at from public.disputes where id = $1', [disputeId]));
    expect(d!.status).toBe('submitted');
    expect(d!.due_at.slice(0, 10)).toBe('2026-04-01');
    const l = await withSystem((db) => db.row<{ status: string; tracking_number: string }>('select status, tracking_number from public.letters where id = $1', [letterId]));
    expect(l).toEqual({ status: 'sent', tracking_number: '9400 1000' });
    const c = await withSystem((db) => db.row<{ stage: string; status: string }>('select stage, status from public.clients where id = $1', [clientId]));
    expect(c).toEqual({ stage: 'disputing', status: 'active' });
    await expect(asUser(specialist.userId, (db) => saveVersion(db, specL, letterId, 'Trying to edit a sent letter after the fact.'))).rejects.toThrow(/cannot be edited/);
  });
  it('records an outcome, resolves, and keeps a complete audit trail', async () => {
    await asUser(specialist.userId, (db) => recordResponse(db, specialist, disputeId, { outcome: 'verified', notes: 'Bureau says verified', receivedOn: '2026-03-20' }));
    await asUser(manager.userId, (db) => transitionDispute(db, manager, disputeId, 'resolved'));
    const ev = await withSystem((db) => db.rows<{ kind: string; to_status: string | null }>('select kind, to_status from public.dispute_events where dispute_id = $1 order by created_at, id', [disputeId]));
    expect(ev.filter((e) => e.kind === 'status_changed').map((e) => e.to_status)).toEqual(['ready_for_review', 'approved', 'submitted', 'response_received', 'resolved']);
    expect(ev.some((e) => e.kind === 'outcome')).toBe(true);
    const audit = await withSystem((db) => db.rows<{ action: string }>("select action from public.audit_logs where entity_id = $1 order by id", [disputeId]));
    expect(audit.map((a) => a.action)).toEqual(expect.arrayContaining(['dispute.created', 'dispute.approved', 'dispute.submitted', 'dispute.outcome', 'dispute.resolved']));
  });
  it('allows another round only with genuinely new information', async () => {
    await expect(asUser(specialist.userId, (db) => startNextRound(db, specialist, disputeId, { reason: 'x'.repeat(20), newInformation: 'too short' }))).rejects.toThrow(/new information/);
    const same = (await withSystem((db) => db.row<{ reason: string }>('select reason from public.disputes where id = $1', [disputeId])))!.reason;
    await expect(asUser(specialist.userId, (db) => startNextRound(db, specialist, disputeId, { reason: same, newInformation: 'A new statement from the bank dated 3/1/2026' }))).rejects.toThrow(/identical/);
    const next = await asUser(specialist.userId, (db) => startNextRound(db, specialist, disputeId, { reason: 'Attached is the March statement showing a different balance.', newInformation: 'Bank statement dated 3/1/2026 showing the balance' }));
    const n = await withSystem((db) => db.row<{ round: number; parent_dispute_id: string; status: string; reason: string }>('select round, parent_dispute_id, status, reason from public.disputes where id = $1', [next]));
    expect(n).toMatchObject({ round: 2, parent_dispute_id: disputeId, status: 'draft' });
    expect(n!.reason).toContain('New information since my previous request');
  });
  it('validation requests are restricted to collection accounts', async () => {
    await expect(asUser(specialist.userId, (db) => createLetter(db, specialist, { clientId, disputeId, templateKey: 'validation_request_en' }))).rejects.toThrow(/collection accounts only/);
    const col = (await withSystem((db) => db.row<{ id: string }>("select id from public.tradelines where client_id = $1 and item_type = 'collection' limit 1", [clientId])))!.id;
    const d = await asUser(specialist.userId, (db) => createDispute(db, specialist, { clientId, tradelineId: col, category: 'unverifiable_collection', reason: 'Requesting validation of this collection debt.' }));
    const l = await asUser(specialist.userId, (db) => createLetter(db, specialist, { clientId, disputeId: d }));
    const body = (await withSystem((db) => currentBody(db, l)))!.body;
    expect(body).toContain('Section 809(b)');
    expect(body).toContain('MIDLAND CREDIT');
  });
  it('attaches evidence only from the same client', async () => {
    const mine = await withSystem((db) => db.row<{ id: string }>("insert into public.documents (org_id, client_id, kind, file_name, mime_type, size_bytes, sha256, storage_key) values ($1,$2,'evidence','s.pdf','application/pdf',1,'x','k') returning id", [org.orgId, clientId]));
    const other = await addClient(org.orgId, 'Other');
    const theirs = await withSystem((db) => db.row<{ id: string }>("insert into public.documents (org_id, client_id, kind, file_name, mime_type, size_bytes, sha256, storage_key) values ($1,$2,'evidence','s.pdf','application/pdf',1,'x','k2') returning id", [org.orgId, other]));
    await asUser(specialist.userId, (db) => addEvidence(db, specialist, disputeId, { documentId: mine!.id, label: 'March statement' }));
    await expect(asUser(specialist.userId, (db) => addEvidence(db, specialist, disputeId, { documentId: theirs!.id, label: 'Wrong client' }))).rejects.toThrow(/does not belong/);
  });
  it('only an approved letter can be marked sent', async () => {
    const l2 = await asUser(specialist.userId, (db) => createLetter(db, specialist, { clientId, kind: 'follow_up', reasonOverride: 'Please send an update.', recipientName: 'Experian', recipientAddress: 'PO Box 4500, Allen TX' }));
    await expect(asUser(specialist.userId, (db) => markSent(db, specialist, l2, 'manual'))).rejects.toThrow(/Only an approved letter/);
  });
});
