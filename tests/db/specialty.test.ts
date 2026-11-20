import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { agencyByKey } from '@/lib/credit/agencies';
import { loadSpecialty, setBankingConcern, setSpecialtyReport } from '@/lib/credit/specialty-reports';
import { addEvidence, createDispute, createSpecialtyDispute, recordResponse, startNextRound, transitionDispute, type DActor } from '@/lib/disputes/service';
import { confirmIdentityDocs } from '@/lib/intake-load';
import { createLetter, currentBody, saveVersion, setLetterStatus } from '@/lib/letters/service';
import { buildPlan, loadPlanInput } from '@/lib/plan';
import { addClient, addMember, addPortalClient, asUser, closePool, makeOrg, withSystem, type TestOrg } from './helpers';
import { recordConsentRows } from './consents';

const ITEM = { name: 'First Coast Bank', reference: 'xxxx4321', date: '03/14/2024', amount: '$312.40' };
const REASON = 'The disclosure lists an unpaid balance of $312.40. My bank statement dated 04/02/2024 shows the account was paid in full and closed by me.';

let A: TestOrg;
let B: TestOrg;
let portal: { userId: string; clientId: string };
let clientId: string;
let specialist: DActor;
let manager: DActor;
let outsider: DActor;

beforeAll(async () => {
  A = await makeOrg('Chex');
  B = await makeOrg('Other');
  portal = await addPortalClient(A.orgId, 'Jordan Rivera');
  clientId = portal.clientId;
  await withSystem((db) => db.run(`update public.clients set address = '{"line1":"123 Main St","city":"Tampa","state":"FL","zip":"33602"}', preferred_language = 'en' where id = $1`, [clientId]));
  specialist = { orgId: A.orgId, userId: (await addMember(A.orgId, 'specialist')).id, role: 'specialist' };
  manager = { orgId: A.orgId, userId: (await addMember(A.orgId, 'manager')).id, role: 'manager' };
  outsider = { orgId: B.orgId, userId: B.ownerId, role: 'owner' };
});
afterAll(closePool);

describe('migration 0017: widened constraints, existing behaviour untouched', () => {
  it('still rejects a specialty agency in the three-bureau column, and an unknown agency key', async () => {
    const ins = (cols: string, vals: string) => withSystem((db) => db.run(
      `insert into public.disputes (org_id, client_id, item_label, recipient_name, category, reason, ${cols}) values ($1, $2, 'X', 'X', 'other', 'A long enough reason', ${vals})`, [A.orgId, clientId]));
    await expect(ins('bureau', "'chexsystems'")).rejects.toThrow(/disputes_bureau_check/);
    await expect(ins('target_type, agency', "'agency', 'not_an_agency'")).rejects.toThrow(/disputes_agency_check/);
    // The agency column and the target type always travel together.
    await expect(ins('target_type, agency', "'bureau', 'chexsystems'")).rejects.toThrow(/disputes_agency_target_check/);
    await expect(ins('target_type', "'agency'")).rejects.toThrow(/disputes_agency_target_check/);
  });

  it('gives every existing client the defaults and accepts the new document kind', async () => {
    const c = await withSystem((db) => db.row<{ banking_concern: boolean; specialty_reports: unknown }>('select banking_concern, specialty_reports from public.clients where id = $1', [clientId]));
    expect(c).toEqual({ banking_concern: false, specialty_reports: {} });
    const kinds = await withSystem((db) => db.rows<{ def: string }>(
      "select pg_get_constraintdef(oid) as def from pg_constraint where conname in ('documents_kind_check', 'document_requests_kind_check') order by conname"));
    for (const k of kinds) { expect(k.def).toContain("'specialty_report'"); expect(k.def).toContain("'proof_of_address'"); expect(k.def).toContain("'power_of_attorney'"); }
  });

  it('leaves a bureau dispute exactly as before', async () => {
    const id = await asUser(specialist.userId, (db) => createDispute(db, specialist, { clientId, category: 'other', bureau: 'experian', reason: 'Please verify this item with the furnisher.' }));
    const d = await withSystem((db) => db.row('select target_type, bureau, agency, agency_item, recipient_address, workflow, recipient_name from public.disputes where id = $1', [id]));
    expect(d).toEqual({ target_type: 'bureau', bureau: 'experian', agency: null, agency_item: null, recipient_address: null, workflow: 'standard', recipient_name: 'Experian' });
    // The specialty category cannot be used through the bureau path.
    await expect(asUser(specialist.userId, (db) => createDispute(db, specialist, { clientId, category: 'specialty_item', bureau: 'experian', reason: 'A long enough reason here' }))).rejects.toThrow(/own form/);
  });
});

describe('specialty dispute lifecycle (ChexSystems)', () => {
  let disputeId = '';
  let letterId = '';

  it('creates a draft from what a person typed, addressed from the registry', async () => {
    await expect(asUser(specialist.userId, (db) => createSpecialtyDispute(db, specialist, { clientId, agency: 'experian', item: ITEM, reason: REASON }))).rejects.toThrow(/Choose the reporting agency/);
    await expect(asUser(specialist.userId, (db) => createSpecialtyDispute(db, specialist, { clientId, agency: 'chexsystems', item: { name: ' ' }, reason: REASON }))).rejects.toThrow(/company or account name/);
    await expect(asUser(specialist.userId, (db) => createSpecialtyDispute(db, specialist, { clientId, agency: 'chexsystems', item: ITEM, reason: 'wrong' }))).rejects.toThrow(/inaccurate, incomplete or unverifiable/);
    disputeId = await asUser(specialist.userId, (db) => createSpecialtyDispute(db, specialist, { clientId, agency: 'chexsystems', item: ITEM, reason: REASON, recipientAddress: 'Somewhere Else' }));
    const d = await withSystem((db) => db.row('select status, target_type, bureau, agency, agency_item, recipient_name, recipient_address, category, workflow, item_label, round, tradeline_id from public.disputes where id = $1', [disputeId]));
    expect(d).toEqual({
      status: 'draft', target_type: 'agency', bureau: null, agency: 'chexsystems', agency_item: { ...ITEM, consumerId: null }, recipient_name: 'Chex Systems, Inc.', recipient_address: null,
      category: 'specialty_item', workflow: 'specialty', item_label: 'First Coast Bank · xxxx4321 (ChexSystems)', round: 1, tradeline_id: null,
    });
  });

  it('drafts the specialty letter with only the entered facts and the verified address', async () => {
    await asUser(specialist.userId, (db) => addEvidence(db, specialist, disputeId, { label: 'Bank statement dated 04/02/2024' }));
    letterId = await asUser(specialist.userId, (db) => createLetter(db, specialist, { clientId, disputeId }));
    const l = await withSystem((db) => db.row<{ kind: string; template_key: string; recipient_name: string; recipient_address: string; title: string }>('select kind, template_key, recipient_name, recipient_address, title from public.letters where id = $1', [letterId]));
    expect(l).toMatchObject({ kind: 'specialty_dispute', template_key: 'specialty_bank_account_en', recipient_name: 'Chex Systems, Inc.', recipient_address: 'Attn: Consumer Relations\nPO Box 583399\nMinneapolis, MN 55458' });
    expect(l!.recipient_address).toBe(agencyByKey('chexsystems')!.disputeAddress!.lines.join('\n'));
    const body = (await withSystem((db) => currentBody(db, letterId)))!.body;
    for (const fact of ['First Coast Bank', 'xxxx4321', '03/14/2024', '$312.40', REASON, 'Bank statement dated 04/02/2024', 'Jordan Rivera', '123 Main St']) expect(body).toContain(fact);
    expect(body).toMatch(/Fair Credit Reporting Act gives me the right to dispute/);
    expect(body).not.toMatch(/delete|remove|§/i);
    // ChexSystems says the letter must state these. The date of birth is on the client's record, so it is stated. The
    // Social Security number is never filled in by the app: it is marked for a person.
    expect(body).toContain('Date of birth: March 3, 1985\nSocial Security number: [SOCIAL SECURITY NUMBER NEEDED]\n');
    expect(body.match(/\[[A-Z ]+NEEDED\]/g)).toEqual(['[SOCIAL SECURITY NUMBER NEEDED]']);
    // With no date of birth on the record, that line is marked too: nothing is guessed.
    const bare = await addClient(A.orgId, 'Casey Doe', { identity: false });
    const bareDispute = await asUser(specialist.userId, (db) => createSpecialtyDispute(db, specialist, { clientId: bare, agency: 'chexsystems', item: ITEM, reason: REASON }));
    const bareLetter = await asUser(specialist.userId, (db) => createLetter(db, specialist, { clientId: bare, disputeId: bareDispute }));
    expect((await withSystem((db) => currentBody(db, bareLetter)))!.body.match(/\[[A-Z ]+NEEDED\]/g)).toEqual(expect.arrayContaining(['[DATE OF BIRTH NEEDED]', '[SOCIAL SECURITY NUMBER NEEDED]']));
    // Choosing the picker's general bureau letter for a specialty dispute still gives the specialty letter. The Spanish templates are gone.
    await expect(asUser(specialist.userId, (db) => createLetter(db, specialist, { clientId, disputeId, templateKey: 'bureau_dispute_es' }))).rejects.toThrow(/Template not found/);
    const es = await asUser(specialist.userId, (db) => createLetter(db, specialist, { clientId, disputeId, templateKey: 'bureau_dispute_en' }));
    expect(await withSystem((db) => db.row('select template_key, language from public.letters where id = $1', [es]))).toEqual({ template_key: 'specialty_bank_account_en', language: 'en' });
    await asUser(specialist.userId, (db) => setLetterStatus(db, specialist, es, 'void'));
  });

  it('goes through the same review, approval and submission gates as any dispute', async () => {
    await asUser(specialist.userId, (db) => transitionDispute(db, specialist, disputeId, 'ready_for_review'));
    await expect(asUser(specialist.userId, (db) => transitionDispute(db, specialist, disputeId, 'approved'))).rejects.toThrow(/Not permitted: disputes:approve/);
    await asUser(manager.userId, (db) => transitionDispute(db, manager, disputeId, 'approved'));
    await expect(asUser(manager.userId, (db) => transitionDispute(db, manager, disputeId, 'submitted'))).rejects.toThrow(/no approved letter/);
    // The lines ChexSystems requires must be completed by a person before the letter can move on. Synthetic values.
    await expect(asUser(specialist.userId, (db) => setLetterStatus(db, specialist, letterId, 'pending_approval'))).rejects.toThrow(/Fill in or remove: \[SOCIAL SECURITY NUMBER NEEDED\]/);
    const draft = (await withSystem((db) => currentBody(db, letterId)))!.body;
    await asUser(specialist.userId, (db) => saveVersion(db, specialist, letterId, draft.replace('[SOCIAL SECURITY NUMBER NEEDED]', '000-00-6789')));
    await asUser(specialist.userId, (db) => setLetterStatus(db, specialist, letterId, 'pending_approval'));
    await asUser(manager.userId, (db) => setLetterStatus(db, manager, letterId, 'approved'));
    await expect(asUser(manager.userId, (db) => transitionDispute(db, manager, disputeId, 'submitted'))).rejects.toThrow(/Required consents are missing/);
    // The identity-document warning now covers specialty agencies too: it needs an explicit yes, then leaves a note.
    await expect(asUser(manager.userId, (db) => confirmIdentityDocs(db, manager, disputeId, false))).rejects.toThrow(/The agency may ask for them/);
    await recordConsentRows(A.orgId, clientId);
    await asUser(specialist.userId, (db) => transitionDispute(db, specialist, disputeId, 'submitted', { sentMethod: 'certified_mail', tracking: '7019 0000 0000 0000 0001' }));
    const d = await withSystem((db) => db.row<{ status: string; days: number; extended: boolean }>(
      "select status, round(extract(epoch from (due_at - submitted_at)) / 86400)::int as days, deadline_extended as extended from public.disputes where id = $1", [disputeId]));
    expect(d).toEqual({ status: 'submitted', days: 30, extended: false });
    expect(await withSystem((db) => db.row('select status, sent_method from public.letters where id = $1', [letterId]))).toEqual({ status: 'sent', sent_method: 'certified_mail' });
  });

  it('shows the client the item with the same statuses and window, and nothing from another tenant', async () => {
    const mine = await asUser(portal.userId, (db) => db.rows<{ id: string; agency: string | null; status: string; due_at: string | null; item_label: string }>('select id, agency, status, due_at, item_label from public.disputes'));
    const row = mine.find((r) => r.id === disputeId)!;
    expect(row).toMatchObject({ agency: 'chexsystems', status: 'submitted', item_label: 'First Coast Bank · xxxx4321 (ChexSystems)' });
    expect(row.due_at).not.toBeNull();
    // Drafts (the bureau dispute created above) stay invisible to the client.
    expect(mine.every((r) => r.status !== 'draft')).toBe(true);

    expect(await asUser(B.ownerId, (db) => db.rows('select id from public.disputes where id = $1', [disputeId]))).toEqual([]);
    expect(await asUser(B.ownerId, (db) => db.rows('select id from public.letters where id = $1', [letterId]))).toEqual([]);
    await expect(asUser(B.ownerId, (db) => createSpecialtyDispute(db, outsider, { clientId, agency: 'chexsystems', item: ITEM, reason: REASON }))).rejects.toThrow(/Client not found/);
    await expect(asUser(B.ownerId, (db) => recordResponse(db, outsider, disputeId, { outcome: 'updated' }))).rejects.toThrow(/Dispute not found/);
    await expect(asUser(B.ownerId, (db) => setSpecialtyReport(db, outsider, clientId, 'chexsystems', { status: 'requested' }))).rejects.toThrow(/Client not found/);
    // A member of this workspace cannot write a row into another one either.
    await expect(asUser(specialist.userId, (db) => db.run(
      `insert into public.disputes (org_id, client_id, item_label, target_type, agency, recipient_name, category, reason) values ($1, $2, 'X', 'agency', 'chexsystems', 'X', 'specialty_item', 'A long enough reason')`, [B.orgId, clientId]))).rejects.toThrow(/row-level security/);
  });

  it('records the response and outcome, and a next round stays a specialty dispute', async () => {
    await asUser(specialist.userId, (db) => recordResponse(db, specialist, disputeId, { outcome: 'verified', notes: 'Reply says the bank confirmed the record.' }));
    await asUser(specialist.userId, (db) => transitionDispute(db, specialist, disputeId, 'resolved'));
    expect(await withSystem((db) => db.row('select status, outcome from public.disputes where id = $1', [disputeId]))).toEqual({ status: 'resolved', outcome: 'verified' });
    const events = await withSystem((db) => db.rows<{ to_status: string | null }>("select to_status from public.dispute_events where dispute_id = $1 and kind = 'status_changed' order by created_at", [disputeId]));
    expect(events.map((e) => e.to_status)).toEqual(['ready_for_review', 'approved', 'submitted', 'response_received', 'resolved']);

    const next = await asUser(specialist.userId, (db) => startNextRound(db, specialist, disputeId, { reason: 'The bank has since sent me a letter confirming the account was closed with a zero balance.', newInformation: 'Closure letter from the bank dated 05/20/2024.' }));
    expect(await withSystem((db) => db.row('select agency, agency_item, target_type, workflow, round, parent_dispute_id, status from public.disputes where id = $1', [next])))
      .toEqual({ agency: 'chexsystems', agency_item: { ...ITEM, consumerId: null }, target_type: 'agency', workflow: 'specialty', round: 2, parent_dispute_id: disputeId, status: 'draft' });
  });
});

describe('an agency with no verified address', () => {
  it('refuses to create the dispute until staff type the address, and never fills one in', async () => {
    expect(agencyByKey('telecheck')!.disputeAddress).toBeNull();
    await expect(asUser(specialist.userId, (db) => createSpecialtyDispute(db, specialist, { clientId, agency: 'telecheck', item: ITEM, reason: REASON }))).rejects.toThrow(/no verified address on file/);
    const id = await asUser(specialist.userId, (db) => createSpecialtyDispute(db, specialist, { clientId, agency: 'telecheck', item: { name: 'Corner Market' }, reason: REASON, recipientAddress: ' PO Box 1 \r\n\r\nAnytown, ST 00000 ' }));
    expect(await withSystem((db) => db.row('select recipient_address, item_label from public.disputes where id = $1', [id]))).toEqual({ recipient_address: 'PO Box 1\nAnytown, ST 00000', item_label: 'Corner Market (TeleCheck)' });
    const letterId = await asUser(specialist.userId, (db) => createLetter(db, specialist, { clientId, disputeId: id }));
    const l = await withSystem((db) => db.row('select template_key, recipient_name, recipient_address from public.letters where id = $1', [letterId]));
    expect(l).toEqual({ template_key: 'specialty_check_verification_en', recipient_name: 'TeleCheck Services, Inc.', recipient_address: 'PO Box 1\nAnytown, ST 00000' });
    const body = (await withSystem((db) => currentBody(db, letterId)))!.body;
    expect(body).toContain('Company or account name: Corner Market');
    expect(body).not.toMatch(/Reference or masked number|Amount shown|NEEDED\]/);
  });
});

describe('specialty reports on the client record', () => {
  it('tracks not requested → requested → received with the file attached', async () => {
    expect((await asUser(specialist.userId, (db) => loadSpecialty(db, clientId)))!.states.chexsystems).toEqual({ status: 'not_requested', on: null, documentId: null });
    await expect(asUser(specialist.userId, (db) => setSpecialtyReport(db, specialist, clientId, 'experian', { status: 'requested' }))).rejects.toThrow(/Choose the reporting agency/);
    await expect(asUser(specialist.userId, (db) => setSpecialtyReport(db, specialist, clientId, 'chexsystems', { status: 'requested', on: '2999-01-01' }))).rejects.toThrow(/future/);
    await asUser(specialist.userId, (db) => setSpecialtyReport(db, specialist, clientId, 'chexsystems', { status: 'requested', on: '2026-10-01' }));
    expect((await asUser(specialist.userId, (db) => loadSpecialty(db, clientId)))!.states.chexsystems).toEqual({ status: 'requested', on: '2026-10-01', documentId: null });

    const doc = (kind: string, client = clientId, org = A.orgId) => withSystem(async (db) => (await db.row<{ id: string }>(
      `insert into public.documents (org_id, client_id, kind, file_name, mime_type, size_bytes, sha256, storage_key, source) values ($1, $2, $3, 'chex.pdf', 'application/pdf', 10, 'x', $4, 'staff') returning id`,
      [org, client, kind, `k-${Math.random()}`]))!.id);
    const report = await doc('specialty_report');
    await expect(asUser(specialist.userId, async (db) => setSpecialtyReport(db, specialist, clientId, 'chexsystems', { status: 'received', on: '2026-10-20', documentId: await doc('id') }))).rejects.toThrow(/Specialty report/);
    const foreign = await doc('specialty_report', await addClient(B.orgId, 'Elsewhere'), B.orgId);
    await expect(asUser(specialist.userId, (db) => setSpecialtyReport(db, specialist, clientId, 'chexsystems', { status: 'received', on: '2026-10-20', documentId: foreign }))).rejects.toThrow(/does not belong/);
    await asUser(specialist.userId, (db) => setSpecialtyReport(db, specialist, clientId, 'chexsystems', { status: 'received', on: '2026-10-20', documentId: report }));
    const s = (await asUser(specialist.userId, (db) => loadSpecialty(db, clientId)))!;
    expect(s.states.chexsystems).toEqual({ status: 'received', on: '2026-10-20', documentId: report });
    expect(s.states.lexisnexis!.status).toBe('not_requested');
    await asUser(specialist.userId, (db) => setSpecialtyReport(db, specialist, clientId, 'nctue', { status: 'requested' }));
    await asUser(specialist.userId, (db) => setSpecialtyReport(db, specialist, clientId, 'nctue', { status: 'not_requested' }));
    expect(await withSystem((db) => db.row<{ k: string[] }>('select array(select jsonb_object_keys(specialty_reports)) as k from public.clients where id = $1', [clientId]))).toEqual({ k: ['chexsystems'] });
  });

  it('a portal client cannot change the banking concern or the report tracking on their own record, but can still update contact details', async () => {
    const before = await withSystem((db) => db.row<{ banking_concern: boolean; specialty_reports: unknown }>('select banking_concern, specialty_reports from public.clients where id = $1', [clientId]));
    await expect(asUser(portal.userId, (db) => db.run('update public.clients set banking_concern = not banking_concern where id = $1', [clientId]))).rejects.toThrow(/portal users may only update/);
    await expect(asUser(portal.userId, (db) => db.run(`update public.clients set specialty_reports = '{"chexsystems": {"status": "received", "on": "2026-01-01", "document_id": null}}'::jsonb where id = $1`, [clientId]))).rejects.toThrow(/portal users may only update/);
    expect(await withSystem((db) => db.row('select banking_concern, specialty_reports from public.clients where id = $1', [clientId]))).toEqual(before);
    expect(await asUser(portal.userId, (db) => db.run("update public.clients set phone = '813-555-0100' where id = $1", [clientId]))).toBe(1);
  });

  it('adds the plan step only when staff ticked the concern, and only for reports not yet requested', async () => {
    const step = async () => buildPlan({ ...(await asUser(specialist.userId, (db) => loadPlanInput(db, clientId))), firstName: 'Jordan' }).find((s) => s.key === 'specialty-reports');
    expect(await step()).toBeUndefined();
    await asUser(specialist.userId, (db) => setBankingConcern(db, specialist, clientId, true));
    // ChexSystems was already received above, so only LexisNexis is left to ask for.
    expect((await step())!.title).toBe('Request the LexisNexis report');
    await asUser(specialist.userId, (db) => setSpecialtyReport(db, specialist, clientId, 'lexisnexis', { status: 'requested' }));
    expect(await step()).toBeUndefined();
    await asUser(specialist.userId, (db) => setSpecialtyReport(db, specialist, clientId, 'lexisnexis', { status: 'not_requested' }));
    await asUser(specialist.userId, (db) => setBankingConcern(db, specialist, clientId, false));
    expect(await step()).toBeUndefined();
  });
});
