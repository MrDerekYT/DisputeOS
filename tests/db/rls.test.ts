import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addClient, addDispute, addMember, addPortalClient, asUser, closePool, makeOrg, withSystem, type TestOrg } from './helpers';

let A: TestOrg;
let B: TestOrg;
let aClient: string;
let bClient: string;
let aSpecialist: string;
let aManager: string;
let portal: { userId: string; clientId: string };
let otherPortal: { userId: string; clientId: string };

beforeAll(async () => {
  A = await makeOrg('Alpha');
  B = await makeOrg('Bravo');
  aClient = await addClient(A.orgId, 'Alpha Client');
  bClient = await addClient(B.orgId, 'Bravo Client');
  aSpecialist = (await addMember(A.orgId, 'specialist')).id;
  aManager = (await addMember(A.orgId, 'manager')).id;
  portal = await addPortalClient(A.orgId, 'Portal Person');
  otherPortal = await addPortalClient(A.orgId, 'Other Portal Person');
});
afterAll(closePool);

describe('tenant isolation', () => {
  it('staff only see their own organization', async () => {
    const mine = await asUser(A.ownerId, (db) => db.rows<{ org_id: string }>('select org_id from public.clients'));
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((r) => r.org_id === A.orgId)).toBe(true);
    const theirs = await asUser(B.ownerId, (db) => db.rows<{ id: string }>('select id from public.clients where id = $1', [aClient]));
    expect(theirs).toHaveLength(0);
  });

  it('cannot insert into another tenant', async () => {
    await expect(
      asUser(A.ownerId, (db) => db.run("insert into public.clients (org_id, full_name) values ($1, 'Injected')", [B.orgId])),
    ).rejects.toThrow(/row-level security/);
  });

  it('cannot update or delete another tenant’s rows (silently matches nothing)', async () => {
    const upd = await asUser(A.ownerId, (db) => db.run("update public.clients set full_name = 'Pwned' where id = $1", [bClient]));
    const del = await asUser(A.ownerId, (db) => db.run('delete from public.clients where id = $1', [bClient]));
    expect(upd).toBe(0);
    expect(del).toBe(0);
    const still = await withSystem((db) => db.row<{ full_name: string }>('select full_name from public.clients where id = $1', [bClient]));
    expect(still?.full_name).toBe('Bravo Client');
  });

  it('cannot reassign a row to another tenant', async () => {
    await expect(
      asUser(A.ownerId, (db) => db.run('update public.clients set org_id = $2 where id = $1', [aClient, B.orgId])),
    ).rejects.toThrow(/row-level security/);
  });

  it('a user with no memberships sees nothing', async () => {
    const lone = await withSystem((db) =>
      db.row<{ id: string }>("insert into public.users (email, password_hash) values ($1, 'x') returning id", [`lone-${Date.now()}@test.dev`]));
    const rows = await asUser(lone!.id, (db) => db.rows('select id from public.clients'));
    expect(rows).toHaveLength(0);
  });

  it('every public table has row-level security enabled', async () => {
    const off = await withSystem((db) => db.rows<{ tablename: string }>("select tablename from pg_tables where schemaname = 'public' and not rowsecurity"));
    expect(off).toEqual([]);
  });
});

describe('secrets are not reachable from tenant queries', () => {
  it('password hashes and TOTP secrets are not selectable', async () => {
    await expect(asUser(A.ownerId, (db) => db.rows('select password_hash from public.users'))).rejects.toThrow(/permission denied/);
    await expect(asUser(A.ownerId, (db) => db.rows('select totp_secret_encrypted from public.users'))).rejects.toThrow(/permission denied/);
  });
  it('sessions, resets and rate limits are invisible to tenants', async () => {
    for (const t of ['sessions', 'password_resets', 'rate_limits', 'webhook_events'])
      await expect(asUser(A.ownerId, (db) => db.rows(`select * from public.${t}`))).rejects.toThrow(/permission denied/);
  });
  it('tenants cannot change their plan', async () => {
    await expect(asUser(A.ownerId, (db) => db.run("update public.organizations set plan = 'scale' where id = $1", [A.orgId]))).rejects.toThrow(/permission denied/);
  });
});

describe('role tiers inside an organization', () => {
  it('specialists cannot read or write payments; managers can', async () => {
    await withSystem((db) => db.run("insert into public.payments (org_id, client_id, amount_cents) values ($1, $2, 5000)", [A.orgId, aClient]));
    expect(await asUser(aSpecialist, (db) => db.rows('select id from public.payments'))).toHaveLength(0);
    await expect(asUser(aSpecialist, (db) => db.run('insert into public.payments (org_id, client_id, amount_cents) values ($1, $2, 100)', [A.orgId, aClient]))).rejects.toThrow(/row-level security/);
    expect((await asUser(aManager, (db) => db.rows('select id from public.payments'))).length).toBe(1);
  });
  it('only admins configure automations; managers may read', async () => {
    await expect(
      asUser(aManager, (db) => db.run(`insert into public.automations (org_id, name, trigger) values ($1, 'x', 'client_created')`, [A.orgId])),
    ).rejects.toThrow(/row-level security/);
    await asUser(A.ownerId, (db) => db.run(`insert into public.automations (org_id, name, trigger) values ($1, 'ok', 'client_created')`, [A.orgId]));
    expect((await asUser(aManager, (db) => db.rows('select id from public.automations'))).length).toBeGreaterThan(0);
  });
  it('only owners/admins can read the audit log', async () => {
    await asUser(A.ownerId, (db) => db.run("insert into public.audit_logs (org_id, actor_id, action) values ($1, $2, 'test.event')", [A.orgId, A.ownerId]));
    expect((await asUser(A.ownerId, (db) => db.rows('select id from public.audit_logs'))).length).toBeGreaterThan(0);
    expect(await asUser(aSpecialist, (db) => db.rows('select id from public.audit_logs'))).toHaveLength(0);
  });
  it('audit entries cannot be forged for someone else', async () => {
    await expect(
      asUser(aSpecialist, (db) => db.run("insert into public.audit_logs (org_id, actor_id, action) values ($1, $2, 'x')", [A.orgId, A.ownerId])),
    ).rejects.toThrow(/row-level security/);
  });
  it('the audit log is append-only, even for the privileged connection', async () => {
    await expect(withSystem((db) => db.run("update public.audit_logs set action = 'tampered'"))).rejects.toThrow(/append-only/);
    await expect(withSystem((db) => db.run('delete from public.audit_logs'))).rejects.toThrow(/append-only/);
  });
});

describe('client portal isolation', () => {
  let visible: string;
  let hidden: string;
  beforeAll(async () => {
    visible = await addDispute(A.orgId, portal.clientId, 'submitted');
    hidden = await addDispute(A.orgId, portal.clientId, 'draft');
    await addDispute(A.orgId, otherPortal.clientId, 'submitted');
    await withSystem(async (db) => {
      await db.run("insert into public.client_notes (org_id, client_id, body) values ($1, $2, 'internal only')", [A.orgId, portal.clientId]);
      await db.run("insert into public.tasks (org_id, client_id, title) values ($1, $2, 'internal task')", [A.orgId, portal.clientId]);
      await db.run("insert into public.communications (org_id, client_id, direction, channel, body, status) values ($1, $2, 'outbound', 'portal', 'Hello from us', 'sent')", [A.orgId, portal.clientId]);
      await db.run("insert into public.communications (org_id, client_id, direction, channel, body, status) values ($1, $2, 'internal', 'portal', 'staff-only chatter', 'sent')", [A.orgId, portal.clientId]);
    });
  });

  it('sees only their own client record', async () => {
    const rows = await asUser(portal.userId, (db) => db.rows<{ id: string }>('select id from public.clients'));
    expect(rows.map((r) => r.id)).toEqual([portal.clientId]);
  });
  it('sees only their own, non-draft disputes', async () => {
    const rows = await asUser(portal.userId, (db) => db.rows<{ id: string }>('select id from public.disputes'));
    expect(rows.map((r) => r.id)).toEqual([visible]);
    expect(rows.map((r) => r.id)).not.toContain(hidden);
  });
  it('cannot read staff-only data', async () => {
    for (const t of ['client_notes', 'tasks', 'tradelines', 'credit_reports', 'findings', 'client_events', 'automations', 'audit_logs'])
      expect(await asUser(portal.userId, (db) => db.rows(`select * from public.${t}`)), t).toHaveLength(0);
  });
  it('sees portal messages but never internal ones', async () => {
    const rows = await asUser(portal.userId, (db) => db.rows<{ body: string }>('select body from public.communications'));
    expect(rows.map((r) => r.body)).toEqual(['Hello from us']);
  });
  it('can message their rep, but only as themselves and only to their own record', async () => {
    await asUser(portal.userId, (db) =>
      db.run(`insert into public.communications (org_id, client_id, direction, channel, body, status, author_id) values ($1, $2, 'inbound', 'portal', 'Question', 'received', $3)`, [A.orgId, portal.clientId, portal.userId]));
    await expect(
      asUser(portal.userId, (db) => db.run(`insert into public.communications (org_id, client_id, direction, channel, body, status, author_id) values ($1, $2, 'inbound', 'portal', 'Spoof', 'received', $3)`, [A.orgId, otherPortal.clientId, portal.userId])),
    ).rejects.toThrow(/row-level security/);
    await expect(
      asUser(portal.userId, (db) => db.run(`insert into public.communications (org_id, client_id, direction, channel, body, status, author_id) values ($1, $2, 'outbound', 'portal', 'Fake staff reply', 'sent', $3)`, [A.orgId, portal.clientId, portal.userId])),
    ).rejects.toThrow(/row-level security/);
  });
  it('can update contact details but not status, assignment or identity', async () => {
    await asUser(portal.userId, (db) => db.run("update public.clients set phone = '555-0100' where id = $1", [portal.clientId]));
    for (const col of ["status = 'completed'", "full_name = 'Renamed'", "tags = array['vip']", "stage = 'graduated'"])
      await expect(asUser(portal.userId, (db) => db.run(`update public.clients set ${col} where id = $1`, [portal.clientId]))).rejects.toThrow(/portal users may only update/);
  });
  it('cannot touch another client’s record', async () => {
    const n = await asUser(portal.userId, (db) => db.run("update public.clients set phone = '000' where id = $1", [otherPortal.clientId]));
    expect(n).toBe(0);
  });
  it('cannot approve letters or write disputes', async () => {
    await expect(asUser(portal.userId, (db) => db.run("update public.disputes set status = 'resolved' where id = $1", [visible]))).resolves.toBe(0);
    await expect(
      asUser(portal.userId, (db) => db.run(`insert into public.disputes (org_id, client_id, item_label, recipient_name, category, reason) values ($1, $2, 'x', 'y', 'z', 'a long enough reason')`, [A.orgId, portal.clientId])),
    ).rejects.toThrow(/row-level security/);
  });
});

describe('dispute audit trail', () => {
  it('writes every status change automatically, visible to the client only for external milestones', async () => {
    const id = await addDispute(A.orgId, portal.clientId, 'draft');
    await asUser(aManager, async (db) => {
      await db.run("update public.disputes set status = 'ready_for_review' where id = $1", [id]);
      await db.run("update public.disputes set status = 'approved' where id = $1", [id]);
      await db.run("update public.disputes set status = 'submitted' where id = $1", [id]);
    });
    const staffView = await asUser(aManager, (db) => db.rows<{ to_status: string; client_visible: boolean; actor_id: string | null }>('select to_status, client_visible, actor_id from public.dispute_events where dispute_id = $1 order by created_at, id', [id]));
    expect(staffView.map((e) => e.to_status)).toEqual(['draft', 'ready_for_review', 'approved', 'submitted']);
    expect(staffView.slice(1).every((e) => e.actor_id === aManager)).toBe(true);
    const clientView = await asUser(portal.userId, (db) => db.rows<{ to_status: string }>('select to_status from public.dispute_events where dispute_id = $1', [id]));
    expect(clientView.map((e) => e.to_status)).toEqual(['submitted']);
  });
});

describe('offboarding', () => {
  it('deleting a user or a whole organization is never blocked by the append-only audit log, which keeps its history', async () => {
    const o = await makeOrg('Offboard');
    const member = await addMember(o.orgId, 'specialist');
    await asUser(member.id, (db) => db.run("insert into public.audit_logs (org_id, actor_id, action) values ($1, $2, 'test.offboard')", [o.orgId, member.id]));
    await withSystem((db) => db.run('delete from public.users where id = $1', [member.id]));
    expect(await withSystem((db) => db.row<{ n: number }>("select count(*)::int as n from public.audit_logs where actor_id = $1 and action = 'test.offboard'", [member.id]))).toEqual({ n: 1 });
    await withSystem((db) => db.run('delete from public.organizations where id = $1', [o.orgId]));
    expect(await withSystem((db) => db.row<{ n: number }>("select count(*)::int as n from public.audit_logs where org_id = $1", [o.orgId]))).toMatchObject({ n: expect.any(Number) });
    await expect(withSystem((db) => db.run("update public.audit_logs set action = 'x' where org_id = $1", [o.orgId]))).rejects.toThrow(/append-only/);
  });
});
