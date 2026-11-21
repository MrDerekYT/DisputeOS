import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadChargeCheck, loadEvidencePack, loadStatement, recordPayment, setSoldByPhone, type BActor, type NewPayment } from '@/lib/billing/records';
import { getEnv } from '@/lib/env';
import { businessToday } from '@/lib/letters/service';
import { addClient, addMember, addPortalClient, asUser, closePool, makeOrg, withSystem, type TestOrg } from './helpers';
import { recordConsentRows } from './consents';

const TZ = getEnv().APP_TIMEZONE;
const TODAY = businessToday();
const MONTH = TODAY.slice(0, 7);

let A: TestOrg;
let B: TestOrg;
let manager: BActor;
let specialist: BActor;
let outsider: BActor;
let clientId: string;
let portalUser: string;
let otherPortalUser: string;
let bareClient: string; // no agreement, no work

const payment = (o: Partial<NewPayment> = {}): NewPayment => ({ clientId, amountCents: 9900, method: 'card', month: MONTH, performed: true, holdAcknowledged: false, ...o });
const auditOf = (paymentId: string) => withSystem((db) => db.row<{ action: string; actor_id: string; metadata: Record<string, unknown> }>(
  "select action, actor_id, metadata from public.audit_logs where entity_type = 'payment' and entity_id = $1", [paymentId]));
const paymentCount = (id: string) => withSystem(async (db) => (await db.row<{ n: number }>('select count(*)::int as n from public.payments where client_id = $1', [id]))!.n);

beforeAll(async () => {
  A = await makeOrg('StatementA');
  B = await makeOrg('StatementB');
  const m = await addMember(A.orgId, 'manager');
  const s = await addMember(A.orgId, 'specialist');
  manager = { orgId: A.orgId, userId: m.id, role: 'manager' };
  specialist = { orgId: A.orgId, userId: s.id, role: 'specialist' };
  outsider = { orgId: B.orgId, userId: B.ownerId, role: 'owner' };
  const p = await addPortalClient(A.orgId, 'Jordan Rivera');
  clientId = p.clientId;
  portalUser = p.userId;
  otherPortalUser = (await addPortalClient(A.orgId, 'Other Client')).userId;
  bareClient = await addClient(A.orgId, 'No Agreement');
  await recordConsentRows(A.orgId, clientId); // signed long ago: outside the cancellation period
  await withSystem(async (db) => {
    await db.run(
      `insert into public.letters (org_id, client_id, kind, title, recipient_name, status, approved_at, sent_at, sent_on, sent_method, tracking_number)
       values ($1, $2, 'dispute', 'Dispute letter to Experian', 'Experian', 'sent', now(), now(), $3, 'certified_mail', '7016 0001')`, [A.orgId, clientId, TODAY]);
    await db.run("insert into public.letters (org_id, client_id, kind, title, recipient_name, status) values ($1, $2, 'dispute', 'Unsent draft', 'Equifax', 'draft')", [A.orgId, clientId]);
    await db.run("insert into public.communications (org_id, client_id, direction, channel, body, status) values ($1, $2, 'outbound', 'portal', 'Your letter was mailed today.', 'sent')", [A.orgId, clientId]);
    await db.run("insert into public.client_events (org_id, client_id, kind, summary) values ($1, $2, 'document_reviewed', 'Document accepted')", [A.orgId, clientId]);
    await db.run("insert into public.audit_logs (org_id, actor_id, action, entity_type, entity_id) values ($1, $2, 'auth.login', 'user', $2)", [A.orgId, portalUser]);
  });
});
afterAll(closePool);

describe('work statement: built from records, under row-level security', () => {
  it('staff of the organization get the statement', async () => {
    const s = (await asUser(manager.userId, (db) => loadStatement(db, clientId, MONTH, TZ)))!;
    expect(s.lettersSent).toHaveLength(1);
    expect(s.lettersSent[0]).toMatchObject({ title: 'Dispute letter to Experian', recipient: 'Experian', on: TODAY, method: 'certified_mail', tracking: '7016 0001', delivery: 'staff_recorded' });
    expect(s.documentsReviewed).toBe(1);
    expect(s.messages).toEqual({ sent: 1, received: 0 });
    expect(s.empty).toBe(false);
    const viaSpecialist = (await asUser(specialist.userId, (db) => loadStatement(db, clientId, MONTH, TZ)))!;
    expect(viaSpecialist.lettersSent).toHaveLength(1);
  });

  it('another organization gets nothing', async () => {
    expect(await asUser(outsider.userId, (db) => loadStatement(db, clientId, MONTH, TZ))).toBeNull();
    expect(await asUser(outsider.userId, (db) => loadEvidencePack(db, clientId))).toBeNull();
    expect(await asUser(outsider.userId, (db) => loadChargeCheck(db, clientId, MONTH, TZ))).toBeNull();
    expect(await asUser(outsider.userId, (db) => db.rows('select * from app.client_document_reviews($1)', [clientId]))).toEqual([]);
    expect(await asUser(outsider.userId, (db) => db.rows('select * from app.client_portal_signins($1)', [clientId]))).toEqual([]);
  });

  it('the client sees their own statement and nobody else’s', async () => {
    const own = (await asUser(portalUser, (db) => loadStatement(db, clientId, MONTH, TZ)))!;
    expect(own.lettersSent.map((l) => l.title)).toEqual(['Dispute letter to Experian']);
    expect(own.documentsReviewed).toBe(1);
    expect(own.messages.sent).toBe(1);
    expect(await asUser(otherPortalUser, (db) => loadStatement(db, clientId, MONTH, TZ))).toBeNull();
    expect(await asUser(otherPortalUser, (db) => db.rows('select * from app.client_document_reviews($1)', [clientId]))).toEqual([]);
  });

  it('a month with no records is empty', async () => {
    const s = (await asUser(manager.userId, (db) => loadStatement(db, clientId, '2020-01', TZ)))!;
    expect(s).toMatchObject({ empty: true, lettersSent: [], documentsReviewed: 0 });
  });
});

describe('evidence pack', () => {
  it('lists signed agreements with the typed signature, letters sent, messages and portal sign-ins', async () => {
    const p = (await asUser(manager.userId, (db) => loadEvidencePack(db, clientId)))!;
    // The fixture records the client's four required agreements (the consent to electronic records is one of them).
    expect(p.consents.map((c) => c.kind).sort()).toEqual(['croa_contract', 'croa_disclosure', 'esign', 'fcra_authorization']);
    expect(p.consents.every((c) => c.signed_name === 'Jordan Rivera' && !!c.signed_at)).toBe(true);
    expect(p.lettersSent.map((l) => l.title)).toEqual(['Dispute letter to Experian']); // the draft is not evidence of anything sent
    expect(p.communicationsTotal).toBe(1);
    expect(p.signIns).toHaveLength(1);
  });

  it('sign-in dates are for billing roles only: not specialists, not the client', async () => {
    expect(await asUser(specialist.userId, (db) => db.rows('select * from app.client_portal_signins($1)', [clientId]))).toEqual([]);
    expect(await asUser(portalUser, (db) => db.rows('select * from app.client_portal_signins($1)', [clientId]))).toEqual([]);
  });
});

describe('charge check and the acknowledged hold', () => {
  it('eligible: the payment is recorded and the audit entry says so', async () => {
    const check = (await asUser(manager.userId, (db) => loadChargeCheck(db, clientId, MONTH, TZ)))!;
    expect(check).toMatchObject({ status: 'eligible', reasons: [], workCount: 1 });
    const r = await asUser(manager.userId, (db) => recordPayment(db, manager, payment(), TZ));
    const a = (await auditOf(r.id))!;
    expect(a).toMatchObject({ action: 'payment.recorded', actor_id: manager.userId });
    expect(a.metadata).toMatchObject({ amount_cents: 9900, services_performed_confirmed: true, period: MONTH, charge_check: 'eligible', hold_acknowledged: false, hold_reasons: null });
  });

  it('on hold: refused without the acknowledgement, and nothing is written', async () => {
    const check = (await asUser(manager.userId, (db) => loadChargeCheck(db, bareClient, MONTH, TZ)))!;
    expect(check.status).toBe('hold');
    expect(check.reasons.map((r) => r.code)).toEqual(['no_contract', 'no_completed_work']);
    await expect(asUser(manager.userId, (db) => recordPayment(db, manager, payment({ clientId: bareClient }), TZ))).rejects.toThrow(/on hold/);
    expect(await paymentCount(bareClient)).toBe(0);
  });

  it('on hold and acknowledged: recorded, with the acknowledgement and the reasons in the audit log', async () => {
    const r = await asUser(manager.userId, (db) => recordPayment(db, manager, payment({ clientId: bareClient, holdAcknowledged: true }), TZ));
    expect(await paymentCount(bareClient)).toBe(1);
    const a = (await auditOf(r.id))!;
    expect(a.actor_id).toBe(manager.userId);
    expect(a.metadata).toMatchObject({ charge_check: 'hold', hold_acknowledged: true, hold_reasons: 'no_contract,no_completed_work', period: MONTH });
  });

  it('a month with no letter sent is a hold even for a client in good standing', async () => {
    const check = (await asUser(manager.userId, (db) => loadChargeCheck(db, clientId, '2020-01', TZ)))!;
    expect(check.reasons.map((r) => r.code)).toEqual(['no_completed_work']);
  });

  it('sold by phone: staff with billing rights set it, it is audited, and it puts the charge on hold', async () => {
    // Nobody has answered yet: the column is null, and the check says the phone-sale rule was not considered.
    expect((await withSystem((db) => db.row<{ sold_by_phone: boolean | null }>('select sold_by_phone from public.clients where id = $1', [clientId])))!.sold_by_phone).toBeNull();
    expect((await asUser(manager.userId, (db) => loadChargeCheck(db, clientId, MONTH, TZ)))!).toMatchObject({ phoneSale: 'not_answered', soldByPhone: null });
    await expect(asUser(specialist.userId, (db) => setSoldByPhone(db, specialist, clientId, true))).rejects.toThrow(/Not permitted/);
    await asUser(manager.userId, (db) => setSoldByPhone(db, manager, clientId, true));
    const logged = await withSystem((db) => db.rows<{ metadata: Record<string, unknown> }>("select metadata from public.audit_logs where action = 'client.sold_by_phone' and entity_id = $1", [clientId]));
    expect(logged.map((l) => l.metadata)).toEqual([{ sold_by_phone: true }]);
    const check = (await asUser(manager.userId, (db) => loadChargeCheck(db, clientId, MONTH, TZ)))!;
    expect(check.reasons.map((r) => r.code)).toEqual(['sold_by_phone']);
    await expect(asUser(manager.userId, (db) => recordPayment(db, manager, payment(), TZ))).rejects.toThrow(/16 CFR 310\.4\(a\)\(2\)/);
    const r = await asUser(manager.userId, (db) => recordPayment(db, manager, payment({ holdAcknowledged: true }), TZ));
    expect((await auditOf(r.id))!.metadata).toMatchObject({ hold_acknowledged: true, hold_reasons: 'sold_by_phone' });
  });

  it('the client cannot change how they were sold, but can still edit their phone', async () => {
    await expect(asUser(portalUser, (db) => db.run('update public.clients set sold_by_phone = false where id = $1', [clientId]))).rejects.toThrow(/portal users may not change/);
    expect(await asUser(portalUser, (db) => db.run("update public.clients set phone = '555-0100' where id = $1", [clientId]))).toBe(1);
    expect((await withSystem((db) => db.row<{ sold_by_phone: boolean }>('select sold_by_phone from public.clients where id = $1', [clientId])))!.sold_by_phone).toBe(true);
  });

  it('needs the "already performed" confirmation and billing rights, hold or not', async () => {
    await expect(asUser(manager.userId, (db) => recordPayment(db, manager, payment({ performed: false, holdAcknowledged: true }), TZ))).rejects.toThrow(/already performed/);
    await expect(asUser(specialist.userId, (db) => recordPayment(db, specialist, payment({ holdAcknowledged: true }), TZ))).rejects.toThrow(/Not permitted/);
    await expect(asUser(outsider.userId, (db) => recordPayment(db, outsider, payment({ holdAcknowledged: true }), TZ))).rejects.toThrow(/Client not found/);
  });

  it('a cancelled client is a hold', async () => {
    await withSystem((db) => db.run("update public.clients set status = 'cancelled', sold_by_phone = false where id = $1", [clientId]));
    const check = (await asUser(manager.userId, (db) => loadChargeCheck(db, clientId, MONTH, TZ)))!;
    expect(check.reasons.map((r) => r.code)).toEqual(['client_cancelled']);
  });
});
