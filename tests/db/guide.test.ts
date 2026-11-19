import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGuideReply } from '@/lib/guide/ask';
import { loadPortalSteps, loadStaffSteps } from '@/lib/guide/steps';
import { addClient, addDispute, addMember, addPortalClient, asUser, closePool, makeOrg, withSystem, type TestOrg } from './helpers';
import { recordConsentRows } from './consents';

let org: TestOrg;
let other: TestOrg;
let ana: { userId: string; clientId: string };
let ben: { userId: string; clientId: string };
let outsider: string;

beforeAll(async () => {
  org = await makeOrg('Guide');
  other = await makeOrg('GuideOther');
  ana = await addPortalClient(org.orgId, 'Ana Rivera');
  ben = await addPortalClient(org.orgId, 'Ben Okafor');
  outsider = await addClient(other.orgId, 'Outside Person');
  // Ana: agreements signed, one investigation under way. Ben: nothing signed, one document requested, one reply in review.
  await recordConsentRows(org.orgId, ana.clientId);
  const sent = await addDispute(org.orgId, ana.clientId, 'submitted');
  await withSystem(async (db) => {
    await db.run("update public.disputes set due_at = '2031-05-20', submitted_at = now() where id = $1", [sent]);
    await db.run("insert into public.document_requests (org_id, client_id, kind, created_by) values ($1, $2, 'id', $3)", [org.orgId, ben.clientId, org.ownerId]);
  });
  await addDispute(org.orgId, ben.clientId, 'response_received');
});
afterAll(closePool);

describe('credit guide: "for you" steps', () => {
  it('come only from the portal user’s own client record', async () => {
    const mine = await asUser(ana.userId, (db) => loadPortalSteps(db, ana.clientId, 'en'));
    expect(mine.steps.map((s) => s.key)).toEqual(['wait']);
    expect(mine.steps[0]!.detail).toContain('May 20, 2031');
    expect(mine.redact).toEqual(['Ana', 'Rivera']);

    const bens = await asUser(ben.userId, (db) => loadPortalSteps(db, ben.clientId, 'es'));
    expect(bens.steps.map((s) => s.key)).toEqual(['sign', 'upload', 'review']);
    expect(bens.steps[0]!.title).toBe('Revise y firme su acuerdo');
    expect(JSON.stringify(bens)).not.toContain('2031');
  });

  it('give a portal user nothing for another client, in their own organization or any other', async () => {
    for (const id of [ben.clientId, outsider]) {
      expect(await asUser(ana.userId, (db) => loadPortalSteps(db, id, 'en'))).toEqual({ steps: [], redact: [] });
      expect(await asUser(ana.userId, (db) => loadStaffSteps(db, id, false))).toEqual({ steps: [], redact: [] });
    }
  });

  it('builds the whole reply from that client’s data and nobody else’s', async () => {
    const personal = await asUser(ana.userId, (db) => loadPortalSteps(db, ana.clientId, 'en'));
    const r = await buildGuideReply({ question: 'How long does a dispute investigation take?', lang: 'en', audience: 'portal', personal }, null);
    expect(r.mode).toBe('knowledge');
    expect(r.steps).toEqual(personal.steps);
    expect(r.steps.every((s) => s.href?.startsWith('/portal'))).toBe(true);
    expect(JSON.stringify(r)).not.toMatch(/Ben|Okafor|Outside/);
  });

  it('give staff the plan of a client they can see, and nothing across organizations', async () => {
    const seen = await asUser(org.ownerId, (db) => loadStaffSteps(db, ben.clientId, false));
    expect(seen.steps.length).toBeGreaterThan(0);
    expect(seen.steps.length).toBeLessThanOrEqual(3);
    expect(seen.steps.map((s) => s.key)).toContain('get-reports');
    expect(seen.redact).toEqual(expect.arrayContaining(['Ben', 'Okafor']));
    expect(await asUser(org.ownerId, (db) => loadStaffSteps(db, outsider, false))).toEqual({ steps: [], redact: [] });
    const stranger = await addMember(other.orgId, 'specialist');
    expect(await asUser(stranger.id, (db) => loadStaffSteps(db, ben.clientId, false))).toEqual({ steps: [], redact: [] });
  });
});
