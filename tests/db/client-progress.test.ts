import { afterAll, describe, expect, it } from 'vitest';
import { syncClientProgress } from '@/lib/client-progress';
import { addClient, asUser, closePool, makeOrg, withSystem } from './helpers';

afterAll(closePool);

const row = (id: string) => withSystem((db) => db.row<{ status: string; stage: string }>('select status, stage from public.clients where id = $1', [id]));

describe('the client page keeps status and stage up to date from the file', () => {
  it('moves the client forward as reports and disputes arrive, logs it, and never moves back', async () => {
    const o = await makeOrg('Progress');
    const c = await addClient(o.orgId, 'Pat Progress', { status: 'onboarding' });
    const sync = () => asUser(o.ownerId, (db) => syncClientProgress(db, { orgId: o.orgId, userId: o.ownerId }, c));

    expect(await sync()).toEqual({ status: null, stage: null });
    await withSystem((db) => db.run("insert into public.credit_reports (org_id, client_id, bureau, status) values ($1,$2,'experian','approved')", [o.orgId, c]));
    expect(await sync()).toEqual({ status: null, stage: 'analysis' });
    await withSystem((db) => db.run(`insert into public.disputes (org_id, client_id, item_label, recipient_name, category, reason, status) values ($1,$2,'X','Experian','other','Reason long enough','submitted')`, [o.orgId, c]));
    expect(await sync()).toEqual({ status: null, stage: 'disputing' });
    expect(await row(c)).toEqual({ status: 'onboarding', stage: 'disputing' });
    const auto = await withSystem((db) => db.rows<{ summary: string }>("select summary from public.client_events where client_id = $1 and kind = 'stage_changed' order by created_at", [c]));
    expect(auto.map((e) => e.summary)).toEqual(['Stage updated from the client’s file: Intake → Analysis', 'Stage updated from the client’s file: Analysis → Disputing']);
  });

  it('leaves alone a choice a person made after the latest change in the file', async () => {
    const o = await makeOrg('ProgressManual');
    const c = await addClient(o.orgId, 'Morgan Manual', { status: 'onboarding' });
    await withSystem((db) => db.run("insert into public.credit_reports (org_id, client_id, bureau, status, created_at) values ($1,$2,'experian','approved', now() - interval '1 hour')", [o.orgId, c]));
    // A person chose Intake after the report came in.
    await withSystem((db) => db.run("insert into public.client_events (org_id, client_id, actor_id, kind, summary) values ($1,$2,$3,'stage_changed','Stage changed: analysis → intake')", [o.orgId, c, o.ownerId]));
    expect(await asUser(o.ownerId, (db) => syncClientProgress(db, { orgId: o.orgId, userId: o.ownerId }, c))).toEqual({ status: null, stage: null });
    expect((await row(c))!.stage).toBe('intake');
  });
});
