import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildPlan, loadPlanInput } from '@/lib/plan';
import { addClient, addDispute, asUser, closePool, makeOrg, withSystem, type TestOrg } from './helpers';

let org: TestOrg;
beforeAll(async () => { org = await makeOrg('Plan'); });
afterAll(closePool);

const addReport = (clientId: string, bureau: string, status: string, date: string) => withSystem(async (db) => (await db.row<{ id: string }>(
  'insert into public.credit_reports (org_id, client_id, bureau, status, report_date) values ($1, $2, $3, $4, $5) returning id', [org.orgId, clientId, bureau, status, date]))!.id);
const addCollection = (clientId: string, reportId: string, bureau: string, creditor: string, matchKey: string) => withSystem(async (db) => (await db.row<{ id: string }>(
  "insert into public.tradelines (org_id, client_id, report_id, bureau, item_type, creditor_name, match_key) values ($1, $2, $3, $4, 'collection', $5, $6) returning id",
  [org.orgId, clientId, reportId, bureau, creditor, matchKey]))!.id);
const load = (clientId: string) => asUser(org.ownerId, (db) => loadPlanInput(db, clientId));

describe('plan loader', () => {
  it('does not count rejected reports as reports on file', async () => {
    const c = await addClient(org.orgId, 'Rejected Only');
    await addReport(c, 'equifax', 'rejected', '2026-01-01');
    const x = await load(c);
    expect(x).toMatchObject({ reports: 0, reportsPendingReview: 0 });
    expect(buildPlan({ ...x, firstName: 'R' }).map((s) => s.key)).toContain('get-reports');
  });

  it('keeps a disputed collection off the list after the same account is imported again', async () => {
    const c = await addClient(org.orgId, 'Re-import');
    const older = await addReport(c, 'equifax', 'approved', '2026-01-01');
    const disputed = await addCollection(c, older, 'equifax', 'SAMPLE COLLECTIONS', 'sample|1234');
    const dispute = await addDispute(org.orgId, c, 'submitted');
    await withSystem((db) => db.run('update public.disputes set tradeline_id = $2 where id = $1', [dispute, disputed]));
    const newer = await addReport(c, 'equifax', 'approved', '2026-02-01');
    await addCollection(c, newer, 'equifax', 'SAMPLE COLLECTIONS', 'sample|1234'); // same account, new row
    await addCollection(c, newer, 'equifax', 'EXAMPLE RECOVERY', 'example|9999'); // no dispute yet
    expect((await load(c)).collections).toEqual(['EXAMPLE RECOVERY']);
  });

  it('names the bureau of the newest approved report so the what-if link opens the same one', async () => {
    const c = await addClient(org.orgId, 'Bureau Link');
    await addReport(c, 'equifax', 'approved', '2026-01-01');
    await addReport(c, 'transunion', 'approved', '2026-03-01');
    expect((await load(c)).accountsBureau).toBe('transunion');
  });
});
