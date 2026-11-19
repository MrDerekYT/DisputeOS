import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { transitionDispute, type DActor } from '@/lib/disputes/service';
import { intakeSummary } from '@/lib/intake';
import { confirmIdentityDocs, IdentityDocsNotConfirmed, loadIntake, loadIntakeDocs } from '@/lib/intake-load';
import { buildPlan, loadPlanInput } from '@/lib/plan';
import { addClient, addDispute, addPortalClient, asUser, closePool, makeOrg, withSystem, type TestOrg } from './helpers';
import { recordConsentRows } from './consents';

let org: TestOrg;
let owner: DActor;
beforeAll(async () => { org = await makeOrg('Intake'); owner = { orgId: org.orgId, userId: org.ownerId, role: 'owner' }; });
afterAll(closePool);

/** A document row only: these tests never read file bytes, so nothing is written to storage. */
const addDoc = (clientId: string, kind: string, status = 'pending_review', extra: { note?: string; docDate?: string; expiresOn?: string; orgId?: string } = {}) => withSystem(async (db) => (await db.row<{ id: string }>(
  `insert into public.documents (org_id, client_id, kind, file_name, mime_type, size_bytes, sha256, storage_key, source, review_status, review_note, doc_date, expires_on)
   values ($1, $2, $3, $4, 'image/png', 10, 'x', 'none', 'staff', $5, $6, $7, $8) returning id`,
  [extra.orgId ?? org.orgId, clientId, kind, `${kind}.png`, status, extra.note ?? null, extra.docDate ?? null, extra.expiresOn ?? null]))!.id);
const approvedLetter = (clientId: string, disputeId: string) => withSystem((db) => db.run(
  "insert into public.letters (org_id, client_id, dispute_id, kind, title, recipient_name, status, approved_by, approved_at) values ($1,$2,$3,'bureau_dispute','Synthetic letter','Experian','approved',$4, now())", [org.orgId, clientId, disputeId, org.ownerId]));
const notes = (disputeId: string) => withSystem((db) => db.rows<{ note: string }>("select note from public.dispute_events where dispute_id = $1 and kind = 'note'", [disputeId]));
const disputeStatus = (id: string) => withSystem(async (db) => (await db.row<{ status: string }>('select status from public.disputes where id = $1', [id]))!.status);

describe('intake documents', () => {
  it('status comes from the client’s real documents: missing, awaiting review, accepted, rejected with its reason, expired', async () => {
    const c = await addClient(org.orgId, 'Status Client');
    const read = async () => Object.fromEntries((await asUser(org.ownerId, (db) => loadIntake(db, c))).map((s) => [s.item.key, s]));
    expect(Object.values(await read()).map((s) => s.state)).toEqual(['missing', 'missing', 'missing']);
    await addDoc(c, 'id', 'accepted', { expiresOn: '2020-01-01' });
    await addDoc(c, 'proof_of_address', 'rejected', { note: 'The address is cut off' });
    await addDoc(c, 'ssn_proof');
    await addDoc(c, 'credit_report', 'accepted'); // not an identity document
    const s = await read();
    expect(s.id).toMatchObject({ state: 'stale', why: 'expired' });
    expect(s.proof_of_address).toMatchObject({ state: 'rejected', reason: 'The address is cut off' });
    expect(s.ssn_proof!.state).toBe('pending');
    const plan = await asUser(org.ownerId, (db) => loadPlanInput(db, c));
    expect(plan.missingIdentityDocs).toEqual(['Government-issued photo ID', 'Proof of current address', 'Proof of Social Security number']);
    expect(buildPlan({ ...plan, firstName: 'S' }).map((p) => p.key)).toContain('identity-docs');
  });

  it('stores the three "only if this applies" kinds and never counts them as required', async () => {
    const c = await addClient(org.orgId, 'Optional Client');
    for (const k of ['previous_address', 'name_change', 'power_of_attorney']) await addDoc(c, k, 'accepted');
    expect((await asUser(org.ownerId, (db) => loadIntakeDocs(db, c))).map((d) => d.kind).sort()).toEqual(['name_change', 'power_of_attorney', 'previous_address']);
    expect(intakeSummary(await asUser(org.ownerId, (db) => loadIntake(db, c)))).toMatchObject({ accepted: 0, total: 3 });
  });

  it('a portal client reads only their own identity documents, and cannot review them', async () => {
    const mine = await addPortalClient(org.orgId, 'Mine');
    const other = await addClient(org.orgId, 'Someone Else');
    const myDoc = await addDoc(mine.clientId, 'id', 'rejected', { note: 'Blurry' });
    await addDoc(other, 'ssn_proof', 'accepted');
    expect((await asUser(mine.userId, (db) => loadIntakeDocs(db, mine.clientId))).map((d) => d.id)).toEqual([myDoc]);
    expect(await asUser(mine.userId, (db) => loadIntakeDocs(db, other))).toEqual([]);
    // No update policy for clients: the row is not visible to an update, so nothing changes.
    await asUser(mine.userId, (db) => db.run("update public.documents set review_status = 'accepted', review_note = null where id = $1", [myDoc])).catch(() => undefined);
    expect(await withSystem((db) => db.row('select review_status, review_note from public.documents where id = $1', [myDoc]))).toEqual({ review_status: 'rejected', review_note: 'Blurry' });
  });

  it('a client’s own upload always starts unreviewed: the database refuses a self-accepted file', async () => {
    const mine = await addPortalClient(org.orgId, 'Uploader');
    const upload = (cols = '', vals = '') => asUser(mine.userId, (db) => db.row<{ id: string }>(
      `insert into public.documents (org_id, client_id, kind, file_name, mime_type, size_bytes, sha256, storage_key, source, uploaded_by${cols})
       values ($1, $2, 'id', 'id.png', 'image/png', 10, 'x', 'none', 'client', $3${vals}) returning id`, [org.orgId, mine.clientId, mine.userId]));
    for (const [cols, vals] of [[', review_status', ", 'accepted'"], [', review_status', ", 'rejected'"], [', review_note', ", 'Looks fine'"], [', doc_date', ", '2026-11-01'"], [', expires_on', ", '2031-01-01'"]]) {
      await expect(upload(cols, vals), cols).rejects.toThrow(/row-level security/);
    }
    const ok = (await upload())!.id;
    expect(await withSystem((db) => db.row('select review_status, review_note, doc_date, expires_on from public.documents where id = $1', [ok]))).toEqual({ review_status: 'pending_review', review_note: null, doc_date: null, expires_on: null });
    expect((await asUser(org.ownerId, (db) => loadIntake(db, mine.clientId))).find((s) => s.item.key === 'id')!.state).toBe('pending');
  });

  it('another business cannot read these documents', async () => {
    const c = await addClient(org.orgId, 'Tenant Client');
    await addDoc(c, 'ssn_proof', 'accepted');
    const stranger = await makeOrg('Stranger');
    expect(await asUser(stranger.ownerId, (db) => loadIntakeDocs(db, c))).toEqual([]);
  });
});

describe('sending a bureau dispute without accepted identity documents', () => {
  it('needs an explicit "send anyway", records that it was sent without them, and does not block', async () => {
    const c = await addClient(org.orgId, 'No Docs');
    await recordConsentRows(org.orgId, c);
    const d = await addDispute(org.orgId, c, 'approved');
    await approvedLetter(c, d);
    const attempt = (sendAnyway: boolean) => asUser(org.ownerId, async (db) => {
      const missing = await confirmIdentityDocs(db, owner, d, sendAnyway);
      await transitionDispute(db, owner, d, 'submitted');
      return missing;
    });
    await expect(attempt(false)).rejects.toThrow(IdentityDocsNotConfirmed);
    await expect(attempt(false)).rejects.toThrow(/Government-issued photo ID, Proof of current address, Proof of Social Security number/);
    expect(await disputeStatus(d)).toBe('approved'); // nothing was recorded
    expect(await notes(d)).toEqual([]);
    expect(await attempt(true)).toHaveLength(3);
    expect(await disputeStatus(d)).toBe('submitted');
    expect((await notes(d)).map((n) => n.note)).toEqual(['Sent without accepted identity documents: Government-issued photo ID, Proof of current address, Proof of Social Security number.']);
  });

  it('asks nothing once all three are accepted, and names only what is still not accepted', async () => {
    const c = await addClient(org.orgId, 'Has Docs');
    const d = await addDispute(org.orgId, c, 'approved');
    await addDoc(c, 'id', 'accepted'); await addDoc(c, 'proof_of_address', 'accepted'); await addDoc(c, 'ssn_proof'); // SSN proof still awaiting review
    await expect(asUser(org.ownerId, (db) => confirmIdentityDocs(db, owner, d, false))).rejects.toThrow(/not accepted yet: Proof of Social Security number\./);
    await withSystem((db) => db.run("update public.documents set review_status = 'accepted' where client_id = $1", [c]));
    expect(await asUser(org.ownerId, (db) => confirmIdentityDocs(db, owner, d, false))).toEqual([]);
    expect(await notes(d)).toEqual([]);
  });

  it('does not ask for a letter that goes to a creditor or collector', async () => {
    const c = await addClient(org.orgId, 'Furnisher');
    const d = await addDispute(org.orgId, c, 'approved');
    await withSystem((db) => db.run("update public.disputes set target_type = 'furnisher', bureau = null where id = $1", [d]));
    expect(await asUser(org.ownerId, (db) => confirmIdentityDocs(db, owner, d, false))).toEqual([]);
  });

  it('leaves the existing gates as they were: "send anyway" does not get past missing consents or a missing approved letter', async () => {
    const c = await addClient(org.orgId, 'Gates');
    const d = await addDispute(org.orgId, c, 'approved');
    const go = () => asUser(org.ownerId, async (db) => { await confirmIdentityDocs(db, owner, d, true); await transitionDispute(db, owner, d, 'submitted'); });
    await expect(go()).rejects.toThrow(/no approved letter/);
    await approvedLetter(c, d);
    await expect(go()).rejects.toThrow(/Required consents are missing/);
    expect(await disputeStatus(d)).toBe('approved');
    expect(await notes(d)).toEqual([]); // the note is rolled back with the refused submission
  });
});
