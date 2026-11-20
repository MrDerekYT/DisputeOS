import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays, procedureDescriptionDue, toDay } from '@/lib/disputes/clock';
import { recordFrivolousNotice, recordMoreInformation, recordProcedureDates, requestProcedureDescription, setConfirmedAccurate } from '@/lib/disputes/escalation';
import { escalationSteps } from '@/lib/disputes/next-steps';
import { createDispute, recordResponse, startNextRound, transitionDispute, type DActor } from '@/lib/disputes/service';
import { businessToday, createLetter, currentBody, letterBlockers, markSent, saveVersion, setLetterStatus } from '@/lib/letters/service';
import { addClient, addMember, addPortalClient, asUser, closePool, makeOrg, withSystem, type TestOrg } from './helpers';
import { recordConsentRows } from './consents';

const REASON = 'Experian reports a balance of $1,200.00. My January statement shows a balance of $900.00.';
const RECEIVED = addDays(businessToday(), -40); // the agency received the dispute 40 days ago

let A: TestOrg;
let B: TestOrg;
let clientId: string;
let portalUser: string;
let specialist: DActor;
let manager: DActor;
let outsider: DActor;

const dispute = (id: string) => withSystem((db) => db.row<Record<string, unknown>>(
  `select status, outcome, deadline_extended, more_info_on, investigation_completed_on, frivolous_missing, client_confirmed_accurate, to_char(due_at at time zone 'UTC', 'YYYY-MM-DD') as due from public.disputes where id = $1`, [id]));
const letter = (id: string) => withSystem((db) => db.row<{ kind: string; status: string; template_key: string; sent_on: string | null; received_on: string | null; reply_due_on: string | null; reply_received_on: string | null; language: string }>(
  'select kind, status, template_key, sent_on, received_on, reply_due_on, reply_received_on, language from public.letters where id = $1', [id]));

/** A bureau dispute taken through the real gates to "submitted", received on RECEIVED. */
async function submitted(reason = REASON, category = 'incorrect_balance', received = RECEIVED): Promise<{ disputeId: string; letterId: string }> {
  const disputeId = await asUser(specialist.userId, (db) => createDispute(db, specialist, { clientId, category, bureau: 'experian', reason, fields: ['Balance'] }));
  const letterId = await asUser(specialist.userId, (db) => createLetter(db, specialist, { clientId, disputeId }));
  const body = (await withSystem((db) => currentBody(db, letterId)))!.body;
  await asUser(specialist.userId, (db) => saveVersion(db, specialist, letterId, body.replace('Item: Item\n', 'Item: Acme Bank, account ending 1234\n')));
  await asUser(specialist.userId, (db) => setLetterStatus(db, specialist, letterId, 'pending_approval'));
  await asUser(manager.userId, (db) => setLetterStatus(db, manager, letterId, 'approved'));
  await asUser(specialist.userId, (db) => transitionDispute(db, specialist, disputeId, 'ready_for_review'));
  await asUser(manager.userId, (db) => transitionDispute(db, manager, disputeId, 'approved'));
  await asUser(specialist.userId, (db) => transitionDispute(db, specialist, disputeId, 'submitted', { sentOn: addDays(received, -3), receivedOn: received, sentMethod: 'certified_mail' }));
  return { disputeId, letterId };
}

beforeAll(async () => {
  A = await makeOrg('Clock');
  B = await makeOrg('Other');
  const portal = await addPortalClient(A.orgId, 'Jordan Rivera');
  clientId = portal.clientId;
  portalUser = portal.userId;
  await withSystem((db) => db.run(`update public.clients set address = '{"line1":"123 Main St","city":"Tampa","state":"FL","zip":"33602"}', preferred_language = 'en' where id = $1`, [clientId]));
  await recordConsentRows(A.orgId, clientId);
  specialist = { orgId: A.orgId, userId: (await addMember(A.orgId, 'specialist')).id, role: 'specialist' };
  manager = { orgId: A.orgId, userId: (await addMember(A.orgId, 'manager')).id, role: 'manager' };
  outsider = { orgId: B.orgId, userId: B.ownerId, role: 'owner' };
});
afterAll(closePool);

describe('migration 0019', () => {
  it('gives existing rows the defaults and accepts the new outcome', async () => {
    const id = await asUser(specialist.userId, (db) => createDispute(db, specialist, { clientId, category: 'other', bureau: 'experian', reason: 'Please verify this item with the furnisher.' }));
    expect(await dispute(id)).toEqual({ status: 'draft', outcome: null, deadline_extended: false, more_info_on: null, investigation_completed_on: null, frivolous_missing: null, client_confirmed_accurate: false, due: null });
    const def = (await withSystem((db) => db.row<{ def: string }>("select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'disputes_outcome_check'")))!.def;
    for (const o of ['deleted', 'updated', 'verified', 'unresolved', 'no_response', 'frivolous']) expect(def).toContain(`'${o}'`);
    await expect(withSystem((db) => db.run("update public.disputes set outcome = 'made_up' where id = $1", [id]))).rejects.toThrow(/disputes_outcome_check/);
    await expect(withSystem((db) => db.run('update public.disputes set frivolous_missing = $2 where id = $1', [id, 'x'.repeat(1001)]))).rejects.toThrow(/disputes_frivolous_missing_check/);
  });
});

describe('specificity check before a dispute letter can be sent for approval', () => {
  it('blocks with the list of what is missing, and passes once staff fix the letter', async () => {
    const disputeId = await asUser(specialist.userId, (db) => createDispute(db, specialist, { clientId, category: 'other', bureau: 'experian', reason: 'Please verify this item with the furnisher.' }));
    const letterId = await asUser(specialist.userId, (db) => createLetter(db, specialist, { clientId, disputeId }));
    const body = (await withSystem((db) => currentBody(db, letterId)))!.body;
    // The drafted letter always says what is in the envelope; with nothing on file that is an explicit "none".
    expect(body).toContain('Enclosures: none');
    const blockers = await asUser(specialist.userId, (db) => letterBlockers(db, letterId, body));
    expect(blockers).toHaveLength(3);
    expect(blockers.join('\n')).toMatch(/Identify the account[\s\S]*State the specific information disputed[\s\S]*Give a concrete reason/);
    await expect(asUser(specialist.userId, (db) => setLetterStatus(db, specialist, letterId, 'pending_approval'))).rejects.toThrow(/Identify the account.* · State the specific information disputed.* · Give a concrete reason/);
    expect((await letter(letterId))!.status).toBe('draft');

    const fixed = body.replace('Item: Item\n', 'Item: Acme Bank, account ending 1234\n').replace('Please verify this item with the furnisher.', REASON);
    await asUser(specialist.userId, (db) => saveVersion(db, specialist, letterId, fixed));
    // Taking the enclosures line out is caught too, including at the approval step itself.
    await asUser(specialist.userId, (db) => saveVersion(db, specialist, letterId, fixed.replace('Enclosures: none\n', '')));
    await expect(asUser(specialist.userId, (db) => setLetterStatus(db, specialist, letterId, 'pending_approval'))).rejects.toThrow(/List what is enclosed/);
    await asUser(specialist.userId, (db) => saveVersion(db, specialist, letterId, fixed));
    await asUser(specialist.userId, (db) => setLetterStatus(db, specialist, letterId, 'pending_approval'));
    await asUser(manager.userId, (db) => setLetterStatus(db, manager, letterId, 'approved'));
    expect((await letter(letterId))!.status).toBe('approved');
  });

  it('lists accepted identity documents as enclosures, and leaves other letters alone', async () => {
    const c2 = await addClient(A.orgId, 'Second Client');
    await withSystem((db) => db.run(
      `insert into public.documents (org_id, client_id, kind, file_name, mime_type, size_bytes, sha256, storage_key, source, review_status) values ($1, $2, 'id', 'id.pdf', 'application/pdf', 10, 'x', $3, 'staff', 'accepted')`,
      [A.orgId, c2, `k-${Math.random()}`]));
    const disputeId = await asUser(specialist.userId, (db) => createDispute(db, specialist, { clientId: c2, category: 'incorrect_balance', bureau: 'equifax', reason: REASON }));
    const body = (await withSystem(async (db) => currentBody(db, await asUser(specialist.userId, (d) => createLetter(d, specialist, { clientId: c2, disputeId })))))!.body;
    expect(body).toMatch(/Enclosures:\n {2}- Copy: Government-issued photo ID\n/);
    expect(body).not.toContain('Enclosures: none');
    // A letter that is not a bureau or specialty dispute is not checked and gets no "none" line.
    const followUp = await asUser(specialist.userId, (db) => createLetter(db, specialist, { clientId: c2, kind: 'follow_up', reasonOverride: 'Please send an update.', recipientName: 'Experian', recipientAddress: 'PO Box 4500, Allen TX' }));
    const g = (await withSystem((db) => currentBody(db, followUp)))!.body;
    expect(g).not.toMatch(/Enclosures/);
    const other = await asUser(specialist.userId, (db) => letterBlockers(db, followUp, g));
    expect(other).toHaveLength(1);
    expect(other[0]).toMatch(/^Fill in or remove: /); // only the ordinary placeholder check
  });

  it('holds a letter drafted before the check existed only to the checks it was written under', async () => {
    const disputeId = await asUser(specialist.userId, (db) => createDispute(db, specialist, { clientId, category: 'other', bureau: 'experian', reason: 'Please verify this item with the furnisher.' }));
    const letterId = await asUser(specialist.userId, (db) => createLetter(db, specialist, { clientId, disputeId }));
    expect((await withSystem((db) => db.row<{ v: number }>('select checks_version as v from public.letters where id = $1', [letterId])))!.v).toBe(1);
    // As such a letter was generated before this release: no enclosures line at all, no account number.
    const body = (await withSystem((db) => currentBody(db, letterId)))!.body.replace('Enclosures: none\n', '');
    await asUser(specialist.userId, (db) => saveVersion(db, specialist, letterId, body));
    await expect(asUser(specialist.userId, (db) => setLetterStatus(db, specialist, letterId, 'pending_approval'))).rejects.toThrow(/List what is enclosed/);
    // A letter that already existed has no stamp (the column is new and has no default).
    await withSystem((db) => db.run('update public.letters set checks_version = null where id = $1', [letterId]));
    expect(await asUser(specialist.userId, (db) => letterBlockers(db, letterId, body))).toEqual([]);
    await asUser(specialist.userId, (db) => setLetterStatus(db, specialist, letterId, 'pending_approval'));
    await asUser(manager.userId, (db) => setLetterStatus(db, manager, letterId, 'approved'));
    expect((await letter(letterId))!.status).toBe('approved');
    // The ordinary checks still apply to it.
    expect(await asUser(specialist.userId, (db) => letterBlockers(db, letterId, `${body}\nWe guarantee this will be deleted. {{reason}}`))).not.toEqual([]);
  });

  it('adds the enclosures section itself when an agency’s own template has no {{enclosures}} field', async () => {
    const tpl = await withSystem((db) => db.row<{ id: string }>(
      `insert into public.letter_templates (org_id, name, kind, language, body) values ($1, 'House bureau letter', 'bureau_dispute', 'en', $2) returning id`,
      [A.orgId, '{{date}}\n\n{{recipient_name}}\n{{recipient_address}}\n\nRe: {{item_label}}\n\nReason for my request:\n{{reason}}\n\nSincerely,\n{{client_name}}\n']));
    const disputeId = await asUser(specialist.userId, (db) => createDispute(db, specialist, { clientId, category: 'incorrect_balance', bureau: 'experian', reason: REASON }));
    const letterId = await asUser(specialist.userId, (db) => createLetter(db, specialist, { clientId, disputeId, templateKey: `org:${tpl!.id}` }));
    const body = (await withSystem((db) => currentBody(db, letterId)))!.body;
    expect(body).toMatch(/Sincerely,\nJordan Rivera\n\nEnclosures: none\n$/);
    expect((await asUser(specialist.userId, (db) => letterBlockers(db, letterId, body))).join(' ')).not.toMatch(/List what is enclosed/);
  });
});

describe('the 45-day extension', () => {
  let disputeId = '';

  it('starts at 30 days from receipt', async () => {
    ({ disputeId } = await submitted());
    expect(await dispute(disputeId)).toMatchObject({ status: 'submitted', deadline_extended: false, more_info_on: null, due: addDays(RECEIVED, 30) });
  });

  it('“client sent more information on <date>” extends it to 45 days, only for a date inside the first 30', async () => {
    await expect(asUser(specialist.userId, (db) => recordMoreInformation(db, specialist, disputeId, addDays(RECEIVED, 31)))).rejects.toThrow(/Only information sent during the 30 days/);
    await expect(asUser(specialist.userId, (db) => recordMoreInformation(db, specialist, disputeId, addDays(RECEIVED, -1)))).rejects.toThrow(/Only information sent during the 30 days/);
    await expect(asUser(specialist.userId, (db) => recordMoreInformation(db, specialist, disputeId, '2999-01-01'))).rejects.toThrow(/future/);
    await expect(asUser(B.ownerId, (db) => recordMoreInformation(db, outsider, disputeId, addDays(RECEIVED, 10)))).rejects.toThrow(/Dispute not found/);
    const info = addDays(RECEIVED, 10);
    await asUser(specialist.userId, (db) => recordMoreInformation(db, specialist, disputeId, info));
    expect(await dispute(disputeId)).toMatchObject({ deadline_extended: true, more_info_on: info, due: addDays(RECEIVED, 45) });
    const note = await withSystem((db) => db.row<{ note: string; client_visible: boolean }>("select note, client_visible from public.dispute_events where dispute_id = $1 and kind = 'deadline_extended'", [disputeId]));
    expect(note!.note).toMatch(/Client sent more information on .*up to 45 days from receipt/);
    // Recording it twice never pushes the deadline past 45 days.
    await asUser(specialist.userId, (db) => recordMoreInformation(db, specialist, disputeId, addDays(RECEIVED, 12)));
    expect((await dispute(disputeId))!.due).toBe(addDays(RECEIVED, 45));
  });

  it('is refused before submission and for a dispute that is not with a reporting agency', async () => {
    const draft = await asUser(specialist.userId, (db) => createDispute(db, specialist, { clientId, category: 'other', bureau: 'experian', reason: REASON }));
    await expect(asUser(specialist.userId, (db) => recordMoreInformation(db, specialist, draft, RECEIVED))).rejects.toThrow(/while a submitted dispute is waiting/);
    const goodwill = await asUser(specialist.userId, (db) => createDispute(db, specialist, { clientId, category: 'goodwill', recipientName: 'Acme Bank', reason: 'I was late once in March during a hospital stay.' }));
    await expect(asUser(specialist.userId, (db) => recordMoreInformation(db, specialist, goodwill, RECEIVED))).rejects.toThrow(/credit bureau or a specialty agency/);
  });
});

describe('method-of-verification letter and its 15-day clock', () => {
  let disputeId = '';
  let disputeLetter = '';
  let movId = '';
  const today = businessToday();
  const responded = addDays(today, -6);

  it('is not offered before a result of “verified as reported” is recorded', async () => {
    ({ disputeId, letterId: disputeLetter } = await submitted());
    await expect(asUser(specialist.userId, (db) => requestProcedureDescription(db, specialist, disputeId))).rejects.toThrow(/follows a recorded result of “verified as reported”/);
    await expect(asUser(specialist.userId, (db) => recordResponse(db, specialist, disputeId, { outcome: 'verified', receivedOn: responded, completedOn: addDays(responded, 1) }))).rejects.toThrow(/cannot have been completed after the response was received/);
    await asUser(specialist.userId, (db) => recordResponse(db, specialist, disputeId, { outcome: 'updated', receivedOn: responded }));
    await expect(asUser(specialist.userId, (db) => requestProcedureDescription(db, specialist, disputeId))).rejects.toThrow(/verified as reported/);
    await asUser(specialist.userId, (db) => recordResponse(db, specialist, disputeId, { outcome: 'verified', receivedOn: responded, completedOn: addDays(responded, -4) }));
    expect(await dispute(disputeId)).toMatchObject({ status: 'response_received', outcome: 'verified', investigation_completed_on: addDays(responded, -4) });
  });

  it('is not offered once the client has confirmed the item is accurate', async () => {
    await asUser(specialist.userId, (db) => setConfirmedAccurate(db, specialist, disputeId, true));
    expect((await dispute(disputeId))!.client_confirmed_accurate).toBe(true);
    await expect(asUser(specialist.userId, (db) => requestProcedureDescription(db, specialist, disputeId))).rejects.toThrow(/confirmed this item is reported accurately/);
    const row = (await withSystem((db) => db.row<{ due_at: string; status: string; outcome: string; category: string; target_type: string }>('select due_at, status, outcome, category, target_type from public.disputes where id = $1', [disputeId])))!;
    const input = { targetType: row.target_type, category: row.category, status: row.status, outcome: row.outcome, dueAt: row.due_at, hasTradeline: false };
    expect(escalationSteps({ ...input, confirmedAccurate: true }, today)).toBeNull();
    await expect(asUser(B.ownerId, (db) => setConfirmedAccurate(db, outsider, disputeId, false))).rejects.toThrow(/Dispute not found/);
    await asUser(specialist.userId, (db) => setConfirmedAccurate(db, specialist, disputeId, false));
    // This dispute names no account from a report, so a direct dispute with a furnisher is not among the steps.
    expect(escalationSteps({ ...input, confirmedAccurate: false }, today)!.steps.map((s) => s.key)).toEqual(['procedure_request', 'consumer_statement', 'cfpb_complaint']);
    expect(escalationSteps({ ...input, hasTradeline: true, confirmedAccurate: false }, today)!.steps.map((s) => s.key)).toEqual(['procedure_request', 'consumer_statement', 'furnisher_dispute', 'cfpb_complaint']);
  });

  it('closes a dispute the client confirmed as accurate to another round and to any new letter', async () => {
    // 15 U.S.C. § 1679b(a)(1): the app must not record "accurate" and then offer to dispute the item again.
    const { disputeId: d2 } = await submitted();
    await asUser(specialist.userId, (db) => recordResponse(db, specialist, d2, { outcome: 'verified', receivedOn: responded }));
    await asUser(specialist.userId, (db) => setConfirmedAccurate(db, specialist, d2, true));
    const note = await withSystem((db) => db.row<{ note: string }>("select note from public.dispute_events where dispute_id = $1 and kind = 'note' order by created_at desc limit 1", [d2]));
    expect(note!.note).toBe('Client confirmed the item is reported accurately. No further step, letter or round is offered for it.');
    await asUser(specialist.userId, (db) => transitionDispute(db, specialist, d2, 'resolved'));
    const round = { reason: 'Experian reports a balance of $1,200.00; my March statement for account ending 1234 shows $850.00.', newInformation: 'March statement showing the balance of $850.00.' };
    await expect(asUser(specialist.userId, (db) => startNextRound(db, specialist, d2, round))).rejects.toThrow(/confirmed this item is reported accurately, so no further letter or round/);
    await expect(asUser(specialist.userId, (db) => createLetter(db, specialist, { clientId, disputeId: d2, templateKey: 'follow_up_en' }))).rejects.toThrow(/confirmed this item is reported accurately/);
    await expect(asUser(specialist.userId, (db) => createLetter(db, specialist, { clientId, disputeId: d2 }))).rejects.toThrow(/confirmed this item is reported accurately/);
    expect(await withSystem((db) => db.rows('select id from public.disputes where parent_dispute_id = $1', [d2]))).toEqual([]);
    // Undone (the tick was a mistake), both are available again.
    await asUser(specialist.userId, (db) => setConfirmedAccurate(db, specialist, d2, false));
    const next = await asUser(specialist.userId, (db) => startNextRound(db, specialist, d2, round));
    expect(await withSystem((db) => db.row('select round, status from public.disputes where id = $1', [next]))).toEqual({ round: 2, status: 'draft' });
  });

  it('drafts an ordinary letter that asks for the description and nothing else', async () => {
    await expect(asUser(B.ownerId, (db) => requestProcedureDescription(db, outsider, disputeId))).rejects.toThrow(/Dispute not found/);
    movId = await asUser(specialist.userId, (db) => requestProcedureDescription(db, specialist, disputeId, 'Clock Agency'));
    expect(await letter(movId)).toEqual({ kind: 'method_of_verification', status: 'draft', template_key: 'method_of_verification_en', sent_on: null, received_on: null, reply_due_on: null, reply_received_on: null, language: 'en' });
    const body = (await withSystem((db) => currentBody(db, movId)))!.body;
    expect(body).toContain('15 U.S.C. § 1681i(a)(7)');
    expect(body).toContain('Experian\nP.O. Box 4500, Allen, TX 75013');
    expect(body).toContain('This letter is a request for that description. It is not a new dispute.');
    expect(body).not.toMatch(/NEEDED\]|\{\{|delet|remov|Clock Agency/i); // both dates come from the record; the agency is not named: it is the client's letter
    expect(body).not.toContain(REASON);
    // One at a time.
    await expect(asUser(specialist.userId, (db) => requestProcedureDescription(db, specialist, disputeId))).rejects.toThrow(/already exists/);
  });

  it('goes through the normal approval pipeline, and no clock runs until it is recorded as sent', async () => {
    await expect(asUser(manager.userId, (db) => setLetterStatus(db, manager, movId, 'approved'))).rejects.toThrow(/Send the letter for approval first/);
    await expect(asUser(specialist.userId, (db) => markSent(db, specialist, movId, 'certified_mail'))).rejects.toThrow(/Only an approved letter/);
    await asUser(specialist.userId, (db) => setLetterStatus(db, specialist, movId, 'pending_approval'));
    await expect(asUser(specialist.userId, (db) => setLetterStatus(db, specialist, movId, 'approved'))).rejects.toThrow(/Not permitted: letters:approve/);
    await asUser(manager.userId, (db) => setLetterStatus(db, manager, movId, 'approved'));
    expect(await letter(movId)).toMatchObject({ status: 'approved', reply_due_on: null });
    await expect(asUser(specialist.userId, (db) => recordProcedureDates(db, specialist, movId, { replyOn: today }))).rejects.toThrow(/Record the request as sent first/);
  });

  it('starts the 15-day clock when it is recorded as sent, and recounts from the receipt date', async () => {
    const sentOn = addDays(today, -5);
    await asUser(specialist.userId, (db) => markSent(db, specialist, movId, 'certified_mail', '7019 0002', sentOn));
    expect(await letter(movId)).toMatchObject({ status: 'sent', sent_on: sentOn, received_on: null, reply_due_on: addDays(sentOn, 15), reply_received_on: null });
    expect(addDays(sentOn, 15)).toBe(procedureDescriptionDue(sentOn));
    // The dispute's own delivery record and status are untouched by this second letter.
    expect((await letter(disputeLetter))!.status).toBe('sent');
    expect((await dispute(disputeId))!.status).toBe('response_received');

    await expect(asUser(specialist.userId, (db) => recordProcedureDates(db, specialist, movId, { receivedOn: addDays(sentOn, -1) }))).rejects.toThrow(/before it was sent/);
    await expect(asUser(specialist.userId, (db) => recordProcedureDates(db, specialist, movId, { receivedOn: '2999-01-01' }))).rejects.toThrow(/future/);
    await expect(asUser(specialist.userId, (db) => recordProcedureDates(db, specialist, disputeLetter, { receivedOn: today }))).rejects.toThrow(/Letter not found/);
    await expect(asUser(B.ownerId, (db) => recordProcedureDates(db, outsider, movId, { receivedOn: today }))).rejects.toThrow(/Letter not found/);
    const receivedOn = addDays(sentOn, 3);
    await asUser(specialist.userId, (db) => recordProcedureDates(db, specialist, movId, { receivedOn }));
    expect(await letter(movId)).toMatchObject({ received_on: receivedOn, reply_due_on: addDays(receivedOn, 15), reply_received_on: null });
  });

  it('stops when the description is recorded as received, and the client can see the dates but nobody else can', async () => {
    await asUser(specialist.userId, (db) => recordProcedureDates(db, specialist, movId, { replyOn: today }));
    expect((await letter(movId))!.reply_received_on).toBe(today);
    const notes = await withSystem((db) => db.rows<{ note: string }>("select note from public.dispute_events where dispute_id = $1 and kind = 'note' order by created_at", [disputeId]));
    expect(notes.map((n) => n.note).join('\n')).toMatch(/Request for the description of the reinvestigation procedure drafted[\s\S]*agency received the request[\s\S]*description of its reinvestigation procedure arrived/);
    expect(await asUser(B.ownerId, (db) => db.rows('select id from public.letters where id = $1', [movId]))).toEqual([]);
    // The request never counts as the dispute's own approved letter.
    const again = await asUser(specialist.userId, (db) => createDispute(db, specialist, { clientId, category: 'incorrect_balance', bureau: 'experian', reason: REASON }));
    await withSystem((db) => db.run("update public.letters set dispute_id = $2, status = 'approved' where id = $1", [movId, again]));
    await asUser(specialist.userId, (db) => createLetter(db, specialist, { clientId, disputeId: again }));
    await asUser(specialist.userId, (db) => transitionDispute(db, specialist, again, 'ready_for_review'));
    await asUser(manager.userId, (db) => transitionDispute(db, manager, again, 'approved'));
    await expect(asUser(specialist.userId, (db) => transitionDispute(db, specialist, again, 'submitted'))).rejects.toThrow(/no approved letter/);
  });

  it('a Spanish-speaking client still gets the request in English: letters are English only', async () => {
    const es = await addClient(A.orgId, 'Cliente Dos');
    await withSystem((db) => db.run(`update public.clients set preferred_language = 'es', address = '{"line1":"1 Calle Sol","city":"Miami","state":"FL","zip":"33101"}' where id = $1`, [es]));
    const id = await withSystem(async (db) => (await db.row<{ id: string }>(
      `insert into public.disputes (org_id, client_id, item_label, bureau, recipient_name, category, reason, status, outcome, submitted_at, due_at, response_at)
       values ($1, $2, 'Acme Bank ••1234 (Experian)', 'experian', 'Experian', 'incorrect_balance', $3, 'resolved', 'verified', now() - interval '40 days', now() - interval '10 days', now() - interval '12 days') returning id`, [A.orgId, es, REASON]))!.id);
    const l = await asUser(specialist.userId, (db) => requestProcedureDescription(db, specialist, id));
    expect(await letter(l)).toMatchObject({ kind: 'method_of_verification', template_key: 'method_of_verification_en', language: 'en' });
    expect((await withSystem((db) => currentBody(db, l)))!.body).toMatch(/This letter is a request for that description\. It is not a new dispute\./);
  });
});

describe('“frivolous or irrelevant” notice', () => {
  let disputeId = '';
  const missing = 'A copy of a government-issued ID and the account number as it appears on the report';

  it('needs what the agency said was missing, and refuses invented promises', async () => {
    ({ disputeId } = await submitted());
    await expect(asUser(specialist.userId, (db) => recordFrivolousNotice(db, specialist, disputeId, { missing: '  ' }))).rejects.toThrow(/what the agency’s notice said was missing/);
    await expect(asUser(specialist.userId, (db) => recordFrivolousNotice(db, specialist, disputeId, { missing: 'Send ID and it will be deleted' }))).rejects.toThrow(/claim we cannot allow/);
    await expect(asUser(B.ownerId, (db) => recordFrivolousNotice(db, outsider, disputeId, { missing }))).rejects.toThrow(/Dispute not found/);
    expect((await dispute(disputeId))!.outcome).toBeNull();
  });

  it('records the outcome and creates one task and one client request for exactly that', async () => {
    const on = addDays(toDay(new Date()), -1);
    await asUser(specialist.userId, (db) => recordFrivolousNotice(db, specialist, disputeId, { missing, receivedOn: on }));
    expect(await dispute(disputeId)).toMatchObject({ status: 'response_received', outcome: 'frivolous', frivolous_missing: missing });
    const tasks = await withSystem((db) => db.rows<{ title: string; detail: string; kind: string; status: string; client_id: string }>('select title, detail, kind, status, client_id from public.tasks where dispute_id = $1', [disputeId]));
    expect(tasks).toEqual([{ title: `Client to provide: ${missing}`, detail: `Experian said it needs this to investigate the dispute about “Item (Experian)”: ${missing}`, kind: 'document', status: 'open', client_id: clientId }]);
    // The client sees the request in the portal; other tenants see nothing.
    const mine = await asUser(portalUser, (db) => db.rows<{ kind: string; note: string }>('select kind, note from public.document_requests where fulfilled_document_id is null'));
    expect(mine).toEqual([{ kind: 'evidence', note: `Experian asked for this to investigate your dispute about Item (Experian): ${missing}` }]);
    expect(await asUser(B.ownerId, (db) => db.rows('select id from public.tasks where dispute_id = $1', [disputeId]))).toEqual([]);
    const seen = await asUser(portalUser, (db) => db.rows<{ note: string }>("select note from public.dispute_events where dispute_id = $1 and kind = 'outcome'", [disputeId]));
    expect(seen).toEqual([{ note: 'Experian asked for more information before it investigates.' }]);

    // Recording it again (a corrected reading of the notice) updates the one open task instead of adding another.
    await asUser(specialist.userId, (db) => recordFrivolousNotice(db, specialist, disputeId, { missing: `${missing}, and a recent utility bill` }));
    expect(await withSystem((db) => db.rows('select title from public.tasks where dispute_id = $1', [disputeId]))).toEqual([{ title: `Client to provide: ${missing}, and a recent utility bill` }]);
  });

  it('offers no escalation step, and the next round has to bring something new', async () => {
    const row = (await withSystem((db) => db.row<{ due_at: string }>('select due_at from public.disputes where id = $1', [disputeId])))!;
    expect(escalationSteps({ targetType: 'bureau', category: 'incorrect_balance', status: 'response_received', outcome: 'frivolous', dueAt: row.due_at, confirmedAccurate: false, hasTradeline: false }, businessToday())).toBeNull();
    await expect(asUser(specialist.userId, (db) => requestProcedureDescription(db, specialist, disputeId))).rejects.toThrow(/verified as reported/);
    await asUser(specialist.userId, (db) => transitionDispute(db, specialist, disputeId, 'resolved'));
    await expect(asUser(specialist.userId, (db) => startNextRound(db, specialist, disputeId, { reason: REASON, newInformation: 'Copy of my driver’s license and the account number' }))).rejects.toThrow(/identical/);
    const next = await asUser(specialist.userId, (db) => startNextRound(db, specialist, disputeId, { reason: 'Experian reports a balance of $1,200.00; my statement for account ending 1234 shows $900.00.', newInformation: 'Copy of my driver’s license and the account number, as the notice asked.' }));
    expect(await withSystem((db) => db.row('select round, status from public.disputes where id = $1', [next]))).toEqual({ round: 2, status: 'draft' });
  });
});

describe('no response recorded by the deadline', () => {
  it('offers the optional steps without recording or changing anything', async () => {
    // Ten days past the 30 is not yet "no response": the agency generally has 5 business days after completing its
    // reinvestigation to send results (15 U.S.C. § 1681i(a)(6)(A)), and the mail takes time.
    const { disputeId: recent } = await submitted();
    const soon = (await withSystem((db) => db.row<{ due_at: string }>('select due_at from public.disputes where id = $1', [recent])))!;
    expect(escalationSteps({ targetType: 'bureau', category: 'incorrect_balance', status: 'submitted', outcome: null, dueAt: soon.due_at, confirmedAccurate: false, hasTradeline: true }, businessToday())).toBeNull();

    const received = addDays(businessToday(), -60);
    const { disputeId } = await submitted(REASON, 'incorrect_balance', received);
    const before = await dispute(disputeId);
    expect(before).toMatchObject({ status: 'submitted', outcome: null, due: addDays(received, 30) }); // thirty days past the 30
    const row = (await withSystem((db) => db.row<{ due_at: string }>('select due_at from public.disputes where id = $1', [disputeId])))!;
    const next = escalationSteps({ targetType: 'bureau', category: 'incorrect_balance', status: 'submitted', outcome: null, dueAt: row.due_at, confirmedAccurate: false, hasTradeline: true }, businessToday())!;
    expect(next.basis).toBe('no_response');
    expect(next.steps.map((s) => s.key)).toEqual(['results_request', 'furnisher_dispute', 'cfpb_complaint']);
    // A request for the procedure needs a recorded result, so it cannot be drafted here.
    await expect(asUser(specialist.userId, (db) => requestProcedureDescription(db, specialist, disputeId))).rejects.toThrow(/verified as reported/);
    expect(await dispute(disputeId)).toEqual(before);
    expect(await withSystem((db) => db.rows("select id from public.letters where dispute_id = $1 and kind = 'method_of_verification'", [disputeId]))).toEqual([]);
  });
});
