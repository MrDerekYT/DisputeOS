import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decideRun, fireTrigger, runSweeps, validateActions, type ActionDef } from '@/lib/automation/engine';
import { addClient, addMember, asUser, closePool, makeOrg, withSystem, type TestOrg } from './helpers';

let org: TestOrg;
let specialistId: string;

const create = (name: string, trigger: string, actions: ActionDef[], o: { enabled?: boolean; requires_approval?: boolean; cap?: number; cooldown?: number; conditions?: object } = {}) =>
  asUser(org.ownerId, async (db) => {
    const r = await db.row<{ id: string }>(
      `insert into public.automations (org_id, name, trigger, conditions, actions, enabled, requires_approval, max_subjects_per_run, cooldown_days, created_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id`,
      [org.orgId, name, trigger, JSON.stringify(o.conditions ?? {}), JSON.stringify(actions), o.enabled ?? true, o.requires_approval ?? true, o.cap ?? 25, o.cooldown ?? 7, org.ownerId]);
    return r!.id;
  });

const count = (sql: string, p: unknown[]) => withSystem((db) => db.row<{ n: number }>(sql, p as never[])).then((r) => r!.n);
const actor = () => ({ orgId: org.orgId, userId: org.ownerId });

beforeAll(async () => {
  org = await makeOrg('Auto');
  specialistId = (await addMember(org.orgId, 'specialist')).id;
});
afterAll(closePool);

describe('event triggers and the approval gate', () => {
  it('does nothing while an automation is disabled', async () => {
    await create('Off', 'client_created', [{ type: 'create_task', title: 'Should not exist' }], { enabled: false });
    const c = await addClient(org.orgId, 'Quiet Client');
    await asUser(org.ownerId, (db) => fireTrigger(db, actor(), 'client_created', { type: 'client', id: c }));
    expect(await count("select count(*)::int as n from public.tasks where title = 'Should not exist'", [])).toBe(0);
  });

  it('runs internal actions now but holds client-facing ones for approval', async () => {
    const a = await create('Welcome', 'client_created', [
      { type: 'create_task', title: 'Call {{client_first_name}} to welcome them', dueInDays: 1 },
      { type: 'portal_message', title: 'Welcome', body: 'Hi {{client_first_name}}, welcome aboard. We will keep you updated on every step.' },
    ]);
    const c = await addClient(org.orgId, 'Casey Quinn');
    const out = await asUser(org.ownerId, async (db) => { await fireTrigger(db, actor(), 'client_created', { type: 'client', id: c }); });
    void out;
    expect(await count("select count(*)::int as n from public.tasks where client_id = $1 and title = 'Call Casey to welcome them' and source = 'automation'", [c])).toBe(1);
    expect(await count("select count(*)::int as n from public.communications where client_id = $1", [c])).toBe(0); // not sent yet
    const run = await withSystem((db) => db.row<{ id: string; status: string; result: { planned: { body: string }[] } }>("select id, status, result from public.automation_runs where automation_id = $1 and subject_id = $2", [a, c]));
    expect(run!.status).toBe('pending_approval');
    expect(run!.result.planned[0]!.body).toBe('Hi Casey, welcome aboard. We will keep you updated on every step.'); // exactly what the reviewer sees

    expect(await asUser(org.ownerId, (db) => decideRun(db, actor(), run!.id, 'approve'))).toBe(true);
    const msgs = await withSystem((db) => db.rows<{ body: string; approved_by: string }>('select body, approved_by from public.communications where client_id = $1', [c]));
    expect(msgs).toEqual([{ body: 'Hi Casey, welcome aboard. We will keep you updated on every step.', approved_by: org.ownerId }]);
    expect(await asUser(org.ownerId, (db) => decideRun(db, actor(), run!.id, 'approve'))).toBe(false); // cannot approve twice → no duplicate message
    expect(await count('select count(*)::int as n from public.communications where client_id = $1', [c])).toBe(1);
  });

  it('is idempotent: firing the same trigger twice produces a single run', async () => {
    const a = await create('Once', 'client_created', [{ type: 'create_task', title: 'Single task' }]);
    const c = await addClient(org.orgId, 'Repeat Client');
    for (let i = 0; i < 3; i++) await asUser(org.ownerId, (db) => fireTrigger(db, actor(), 'client_created', { type: 'client', id: c }));
    expect(await count('select count(*)::int as n from public.automation_runs where automation_id = $1 and subject_id = $2', [a, c])).toBe(1);
    expect(await count("select count(*)::int as n from public.tasks where client_id = $1 and title = 'Single task'", [c])).toBe(1);
  });

  it('cancelling a pending run sends nothing', async () => {
    await create('Cancelable', 'report_uploaded', [{ type: 'portal_message', body: 'Your report was received and is being reviewed.' }]);
    const c = await addClient(org.orgId, 'Cancel Client');
    await asUser(org.ownerId, (db) => fireTrigger(db, actor(), 'report_uploaded', { type: 'client', id: c }));
    const run = await withSystem((db) => db.row<{ id: string }>("select id from public.automation_runs where subject_id = $1 and status = 'pending_approval'", [c]));
    await asUser(org.ownerId, (db) => decideRun(db, actor(), run!.id, 'cancel'));
    expect(await count('select count(*)::int as n from public.communications where client_id = $1', [c])).toBe(0);
  });

  it('only fires status automations for the configured status', async () => {
    const a = await create('On submit', 'dispute_status_changed', [{ type: 'notify_staff', title: 'Dispute submitted' }], { conditions: { toStatus: 'submitted' } });
    const c = await addClient(org.orgId, 'Status Client');
    const d = await withSystem((db) => db.row<{ id: string }>(`insert into public.disputes (org_id, client_id, item_label, recipient_name, category, reason) values ($1,$2,'X','Experian','other','Reason long enough') returning id`, [org.orgId, c]));
    await asUser(org.ownerId, (db) => fireTrigger(db, actor(), 'dispute_status_changed', { type: 'dispute', id: d!.id }, { toStatus: 'approved' }));
    expect(await count('select count(*)::int as n from public.automation_runs where automation_id = $1', [a])).toBe(0);
    await asUser(org.ownerId, (db) => fireTrigger(db, actor(), 'dispute_status_changed', { type: 'dispute', id: d!.id }, { toStatus: 'submitted' }));
    expect(await count('select count(*)::int as n from public.automation_runs where automation_id = $1', [a])).toBe(1);
  });
});

describe('scheduled sweeps', () => {
  it('caps how many subjects one run may touch and tells admins', async () => {
    const o = await makeOrg('Cap');
    const orgBefore = org;
    org = o;
    await create('Inactive', 'client_inactive', [{ type: 'notify_staff', title: 'Inactive client' }], { cap: 2, conditions: { days: 30 } });
    for (let i = 0; i < 5; i++) {
      const c = await addClient(o.orgId, `Idle ${i}`);
      await withSystem((db) => db.run("update public.clients set last_activity_at = now() - interval '60 days' where id = $1", [c]));
    }
    const sum = await withSystem((db) => runSweeps(db, { orgId: o.orgId, userId: null }));
    expect(sum[0]).toMatchObject({ matched: 3, executed: 2, capped: true }); // limit + 1 fetched, only `cap` processed
    expect(await count("select count(*)::int as n from public.notifications where org_id = $1 and title like 'Automation capped%'", [o.orgId])).toBeGreaterThan(0);
    org = orgBefore;
  });

  it('does not repeat work inside the cooldown window', async () => {
    const o = await makeOrg('Cool');
    const prev = org;
    org = o;
    await create('Inactive', 'client_inactive', [{ type: 'create_task', title: 'Re-engage' }], { cooldown: 7, conditions: { days: 30 } });
    const c = await addClient(o.orgId, 'Sleepy');
    await withSystem((db) => db.run("update public.clients set last_activity_at = now() - interval '45 days' where id = $1", [c]));
    const now = new Date('2026-06-10T10:00:00Z');
    const first = await withSystem((db) => runSweeps(db, { orgId: o.orgId, userId: null }, now));
    const second = await withSystem((db) => runSweeps(db, { orgId: o.orgId, userId: null }, new Date(now.getTime() + 86_400_000)));
    expect(first[0]!.executed).toBe(1);
    expect(second[0]!.executed).toBe(0);
    expect(second[0]!.skipped).toBe(1);
    expect(await count("select count(*)::int as n from public.tasks where client_id = $1", [c])).toBe(1);
    org = prev;
  });

  it('turns missing-document reminders into a message that waits for approval', async () => {
    const o = await makeOrg('Docs');
    const prev = org;
    org = o;
    await create('Docs reminder', 'missing_documents', [{ type: 'portal_message', body: 'A friendly reminder: we still need your photo ID to continue.' }], { conditions: { afterDays: 3 } });
    const c = await addClient(o.orgId, 'Forgetful');
    await withSystem((db) => db.run("insert into public.document_requests (org_id, client_id, kind, created_at) values ($1,$2,'id', now() - interval '5 days')", [o.orgId, c]));
    const sum = await withSystem((db) => runSweeps(db, { orgId: o.orgId, userId: null }));
    expect(sum[0]).toMatchObject({ executed: 0, pending: 1 });
    expect(await count('select count(*)::int as n from public.communications where client_id = $1', [c])).toBe(0);
    org = prev;
  });

  it('dispute-deadline sweeps assign a follow-up task to the specialist', async () => {
    const o = await makeOrg('Deadline');
    const prev = org;
    org = o;
    const sp = (await addMember(o.orgId, 'specialist')).id;
    await create('Deadline', 'dispute_deadline', [{ type: 'create_task', title: 'Follow up: {{item}} due {{due_date}}' }], { conditions: { withinDays: 5 } });
    const c = await addClient(o.orgId, 'Deadline Client');
    await withSystem((db) => db.run('update public.clients set assigned_to = $2 where id = $1', [c, sp]));
    await withSystem((db) => db.run(`insert into public.disputes (org_id, client_id, item_label, recipient_name, category, reason, status, due_at, assigned_to) values ($1,$2,'Acme ••1234 (Experian)','Experian','other','Reason long enough','submitted', now() + interval '2 days', $3)`, [o.orgId, c, sp]));
    await withSystem((db) => runSweeps(db, { orgId: o.orgId, userId: null }));
    const t = await withSystem((db) => db.row<{ title: string; assignee_id: string }>("select title, assignee_id from public.tasks where client_id = $1", [c]));
    expect(t!.assignee_id).toBe(sp);
    expect(t!.title).toMatch(/^Follow up: Acme ••1234 \(Experian\) due \d{4}-\d{2}-\d{2}$/);
    org = prev;
    void specialistId;
  });
});

describe('configuration safeguards', () => {
  it('rejects automation text containing prohibited claims', () => {
    expect(validateActions([{ type: 'portal_message', body: 'We guarantee your score will increase by 100 points.' }])).toMatch(/prohibited/);
    expect(validateActions([{ type: 'portal_message', body: 'We will delete all negative items from your report.' }])).toMatch(/prohibited/);
    expect(validateActions([{ type: 'portal_message', body: 'Your dispute was submitted today. We will update you when a response arrives.' }])).toBeNull();
  });
  it('requires well-formed actions', () => {
    expect(validateActions([])).toMatch(/at least one/);
    expect(validateActions([{ type: 'create_task' }])).toMatch(/title/);
    expect(validateActions([{ type: 'request_document' }])).toMatch(/Choose/);
  });
  it('only admins can create automations (database-enforced)', async () => {
    await expect(asUser(specialistId, (db) => db.run(`insert into public.automations (org_id, name, trigger) values ($1, 'x', 'client_created')`, [org.orgId]))).rejects.toThrow(/row-level security/);
  });
  it('another tenant’s automations never run for this tenant', async () => {
    const other = await makeOrg('Other');
    await asUser(other.ownerId, (db) => db.run(`insert into public.automations (org_id, name, trigger, actions, enabled) values ($1,'Theirs','client_created','[{"type":"create_task","title":"Leak"}]', true)`, [other.orgId]));
    const c = await addClient(org.orgId, 'Mine');
    await asUser(org.ownerId, (db) => fireTrigger(db, actor(), 'client_created', { type: 'client', id: c }));
    expect(await count("select count(*)::int as n from public.tasks where title = 'Leak'", [])).toBe(0);
  });
});
