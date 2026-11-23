import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cancelAgreement, loadClientAgreements, renderFor, signAgreement } from '@/lib/agreements';
import { signUp } from '@/lib/auth/service';
import { storedTerms, type AgreementTerms } from '@/lib/compliance/agreement-terms';
import { isRendered, type ConsentKind } from '@/lib/compliance/disclosures';
import { buildGuideReply } from '@/lib/guide/ask';
import { loadPortalSteps, loadStaffSteps } from '@/lib/guide/steps';
import { loadPlanInput } from '@/lib/plan';
import { tr } from '@/lib/portal-i18n';
import { addClient, addDispute, addMember, addPortalClient, asUser, closePool, makeOrg, PASSWORD, testIp, uniq, withSystem, type TestOrg } from './helpers';
import { recordConsentRows } from './consents';

const TERMS: AgreementTerms = {
  legalName: 'Bright Path Credit LLC', address: '500 Bayshore Blvd, Suite 210, Tampa, FL 33606',
  services: 'We review your three credit reports with you, prepare dispute letters for the items you choose, track each investigation and report every response to you in your portal.',
  paymentTerms: 'A monthly fee of $99.00, charged on the 1st of each month for the work fully performed in the month before.',
  totalCents: 59_400, duration: 'About 6 months from the date you sign.', additional: '', updatedAt: '2026-11-20T15:00:00.000Z', updatedBy: 'test',
};
const saveTerms = (orgId: string) =>
  withSystem((db) => db.run("update public.organizations set settings = settings || jsonb_build_object('agreement', $2::jsonb) where id = $1", [orgId, JSON.stringify(storedTerms(TERMS))]));
const ADDRESS = { line1: '42 Oak Street', line2: 'Apt 4C', city: 'Dayton', state: 'OH', zip: '45402-1234' };
const giveAddress = (clientId: string) => withSystem((db) => db.run('update public.clients set address = $2::jsonb where id = $1', [clientId, JSON.stringify(ADDRESS)]));

/** A portal client of `org` with their details on file, signing in the portal as the welcome steps ask. */
async function portalClient(org: TestOrg, name: string) {
  const c = await addPortalClient(org.orgId, name);
  await giveAddress(c.clientId);
  const sign = async (kinds: ConsentKind[]) => {
    for (const kind of kinds) {
      const r = renderFor((await asUser(c.userId, (db) => loadClientAgreements(db, org.orgId, c.clientId)))!, kind);
      if (!isRendered(r)) throw new Error(`${kind} cannot be signed yet`);
      await asUser(c.userId, (db) => signAgreement(db, { orgId: org.orgId, clientId: c.clientId, userId: c.userId, by: 'client' }, { kind, signedName: name, shown: r.sha256, lang: 'en' }));
    }
  };
  return { ...c, sign };
}
const idDocuments = (orgId: string, clientId: string) => withSystem(async (db) => {
  for (const kind of ['id', 'proof_of_address', 'ssn_proof'])
    await db.run("insert into public.documents (org_id, client_id, kind, file_name, mime_type, size_bytes, sha256, storage_key, source, review_status) values ($1, $2, $3, $4, 'image/png', 10, 'x', 'none', 'staff', 'accepted')", [orgId, clientId, kind, `${kind}.png`]);
});
const SIGN_LINK = '/portal/welcome?step=agreements';

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
  for (const c of [ana, ben]) await giveAddress(c.clientId);
  // Ana: the agreements signed before the current documents (no stored text), one investigation under way.
  // Ben: nothing signed, one document requested, one reply in review.
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
    expect(mine.steps.map((s) => s.key)).toEqual(['esign', 'wait']);
    expect(mine.steps[1]!.detail).toContain('May 20, 2031');
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
    expect(seen.steps.map((s) => s.key)).toEqual(expect.arrayContaining(['get-reports', 'consents']));
    expect(seen.steps.find((s) => s.key === 'consents')!.detail).toContain('A dispute cannot be submitted until these are signed.');
    expect(seen.redact).toEqual(expect.arrayContaining(['Ben', 'Okafor']));
    expect(await asUser(org.ownerId, (db) => loadStaffSteps(db, outsider, false))).toEqual({ steps: [], redact: [] });
    const stranger = await addMember(other.orgId, 'specialist');
    expect(await asUser(stranger.id, (db) => loadStaffSteps(db, ben.clientId, false))).toEqual({ steps: [], redact: [] });
  });

  it('carry what the app holds about the client, from the database, for masking a typed question (and never in the steps)', async () => {
    const expected = ['ADDRESS:42 Oak Street', 'ADDRESS:Apt 4C', 'ADDRESS:Dayton', 'ADDRESS:45402-1234', 'ADDRESS:45402', 'SSN:4321', 'DATE:1985-03-03', 'DATE:03/03/1985', 'DATE:3/3/85', 'DATE:March 3, 1985', 'DATE:3 de marzo de 1985'];
    const portal = await asUser(ana.userId, (db) => loadPortalSteps(db, ana.clientId, 'en'));
    const staff = await asUser(org.ownerId, (db) => loadStaffSteps(db, ana.clientId, false));
    for (const p of [portal, staff]) {
      expect(p.identifiers!.map((i) => `${i.as}:${i.text}`)).toEqual(expect.arrayContaining(expected));
      // The state on its own identifies nobody and its code is a common word, so it is not among them.
      expect(p.identifiers!.some((i) => i.text === 'OH')).toBe(false);
      expect(JSON.stringify(p.steps)).not.toMatch(/Oak Street|Dayton|45402|4321|1985/);
    }
    // A client with nothing on file but a name has no identifiers, and the loaders still work.
    const bare = await addPortalClient(org.orgId, 'Nadia Nobody');
    await withSystem((db) => db.run("update public.clients set address = '{}'::jsonb, ssn_last4 = null, dob_encrypted = null where id = $1", [bare.clientId]));
    expect((await asUser(bare.userId, (db) => loadPortalSteps(db, bare.clientId, 'en'))).identifiers).toEqual([]);
  });
});

describe('credit guide: the portal steps follow the welcome steps, as the portal home does', () => {
  it('a client whose service documents are in force is asked gently, never told that work cannot start (EXP-2)', async () => {
    for (const lang of ['en', 'es'] as const) {
      const g = await asUser(ana.userId, (db) => loadPortalSteps(db, ana.clientId, lang));
      expect(g.steps.map((s) => s.key)).toEqual(['esign', 'wait']);
      expect(g.steps[0]!.title).toBe(tr(lang)('ns_esign_t'));
      expect(JSON.stringify(g)).not.toContain(tr(lang)('ns_sign_b'));
    }
  });

  it('a client who cancelled their service agreement is shown that, and is not asked to sign it again (LEG-10)', async () => {
    const terms = await makeOrg('GuideCancel');
    await saveTerms(terms.orgId);
    const c = await portalClient(terms, 'Carla Cancel');
    await c.sign(['esign', 'croa_disclosure', 'croa_contract', 'fcra_authorization']);
    const before = await asUser(c.userId, (db) => loadPortalSteps(db, c.clientId, 'en'));
    expect(before.steps.some((s) => s.key === 'cancelled')).toBe(false);
    await asUser(c.userId, (db) => cancelAgreement(db, { orgId: terms.orgId, clientId: c.clientId, userId: c.userId }, 'Carla Cancel'));
    for (const lang of ['en', 'es'] as const) {
      const g = await asUser(c.userId, (db) => loadPortalSteps(db, c.clientId, lang));
      expect(g.steps[0]).toMatchObject({ key: 'cancelled', title: tr(lang)('cx_done_t'), href: '/portal/profile#agreements' });
      expect(g.steps[0]!.detail).toContain('Bright Path Credit LLC');
      expect(g.steps.map((s) => s.key)).toEqual(['cancelled']);
      expect(g.steps.some((s) => s.href === SIGN_LINK)).toBe(false);
      expect(JSON.stringify(g)).not.toContain(tr(lang)('ns_sign_b'));
    }
  });

  it('a client waiting for the agency’s terms is not asked to sign what cannot be signed yet (EXP-5)', async () => {
    const noTerms = await makeOrg('GuideWaiting');
    const c = await portalClient(noTerms, 'Nora Wait');
    await c.sign(['esign', 'croa_disclosure']);
    // Their identity documents are what they can do meanwhile.
    let g = await asUser(c.userId, (db) => loadPortalSteps(db, c.clientId, 'en'));
    expect(g.steps.map((s) => s.key)).toEqual(['intake']);
    await idDocuments(noTerms.orgId, c.clientId);
    g = await asUser(c.userId, (db) => loadPortalSteps(db, c.clientId, 'en'));
    expect(g.steps).toHaveLength(1);
    expect(g.steps[0]).toMatchObject({ key: 'prepAg', title: 'Your service agreement is being prepared' });
    expect(g.steps[0]!.href).toBeUndefined();
    expect(g.steps[0]!.detail).toMatch(/^GuideWaiting .* is still finishing its service agreement\./);
    expect(JSON.stringify(g)).not.toContain(tr('en')('ns_sign_b'));
    // Once the agency saves its terms, the service agreement is asked for: no document the service needs is in force yet.
    await saveTerms(noTerms.orgId);
    g = await asUser(c.userId, (db) => loadPortalSteps(db, c.clientId, 'en'));
    expect(g.steps[0]).toMatchObject({ key: 'sign', href: SIGN_LINK, detail: tr('en')('ns_sign_b') });
  });
});

describe('credit guide: a personal workspace', () => {
  it('never asks the owner to collect the consents of a credit repair agreement', async () => {
    const r = await signUp({ email: `self-${uniq()}@test.dev`, password: PASSWORD, fullName: 'Sam Self', orgName: `Sam ${uniq()}`, mode: 'personal' }, { ip: testIp() });
    if (!r.ok) throw new Error(r.error);
    const self = (await withSystem((db) => db.row<{ id: string }>('select id from public.clients where org_id = $1', [r.orgId])))!.id;
    expect((await asUser(r.userId, (db) => loadPlanInput(db, self))).missingConsents).toEqual([]);
    const g = await asUser(r.userId, (db) => loadStaffSteps(db, self, true));
    expect(g.steps.length).toBeGreaterThan(0);
    expect(g.steps.map((s) => s.key)).not.toContain('consents');
    expect(JSON.stringify(g.steps)).not.toMatch(/consent/i);
  });
});
