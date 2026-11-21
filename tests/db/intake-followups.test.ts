import * as React from 'react';
import { prerenderToNodeStream } from 'react-dom/static';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Ctx } from '@/lib/auth/context';
import { signUp, type SessionInfo } from '@/lib/auth/service';
import { cancelAgreement, loadClientAgreements, loadServiceStatus, renderFor, signAgreement, type Signer } from '@/lib/agreements';
import { addDays, cancellationEndsOn, sayDay } from '@/lib/business-days';
import { storedTerms, type AgreementTerms } from '@/lib/compliance/agreement-terms';
import { longDay } from '@/lib/compliance/croa';
import { isRendered, type ConsentKind, type RenderedConsent } from '@/lib/compliance/disclosures';
import { transitionDispute, type DActor } from '@/lib/disputes/service';
import { markSent } from '@/lib/letters/service';
import { can, type Role } from '@/lib/rbac';
import { dayInZone } from '@/lib/util';
import { addClient, addDispute, addMember, asUser, closePool, makeOrg, PASSWORD, testIp, uniq, withSystem, type TestOrg } from './helpers';

/**
 * The intake's second round of fixes, through the real services, actions and pages under row-level security (only the
 * sign-in is stood in for):
 *  - a paper agreement's cancellation period runs from the date written on the paper, however late staff record it;
 *  - a client who cancelled and signs a new agreement is active again, and the agency is told;
 *  - a personal workspace is asked for no CROA document anywhere, and the person gives their own authorization;
 *  - the portal calls the PDF of a paper agreement the app's text recorded on its day, never a copy of what was signed;
 *  - the Welcome link card names why the service agreement cannot be signed yet.
 */
const signedIn = vi.hoisted(() => ({ ctx: null as unknown }));
vi.mock('@/lib/auth/context', () => ({
  requireStaff: async (perm?: string) => {
    const ctx = signedIn.ctx as { can(p: string): boolean };
    if (perm && !ctx.can(perm)) throw new Error('REDIRECT /app?denied=1');
    return ctx;
  },
  requireClient: async () => signedIn.ctx,
  apiSession: async () => (signedIn.ctx as { session: SessionInfo } | null)?.session ?? null,
}));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));
vi.stubGlobal('React', React);

import ClientPage from '@/app/app/clients/[id]/page';
import EvidencePackPage from '@/app/app/clients/[id]/evidence/page';
import { WelcomeBlock } from '@/app/app/clients/[id]/welcome-block';
import { recordConsentAction, revokeConsentAction } from '@/app/app/clients/actions';
import NewDisputePage from '@/app/app/disputes/new/page';
import { GET as consentPdf } from '@/app/api/consents/[id]/pdf/route';
import PortalProfile from '@/app/portal/(app)/profile/page';
import WelcomePage from '@/app/portal/welcome/page';
import { portalLongDay } from '@/app/portal/cancel-agreement';

const TERMS: AgreementTerms = {
  legalName: 'Bright Path Credit LLC', address: '500 Bayshore Blvd, Suite 210, Tampa, FL 33606',
  services: 'We review your three credit reports with you, prepare dispute letters for the items you choose, track each investigation and report every response to you in your portal.',
  paymentTerms: 'A monthly fee of $99.00, charged on the 1st of each month for the work fully performed in the month before.',
  totalCents: 59_400, duration: 'About 6 months from the date you sign.', additional: '', updatedAt: '2026-11-20T15:00:00.000Z', updatedBy: 'test',
};
const saveTerms = (orgId: string, t: AgreementTerms = TERMS) =>
  withSystem((db) => db.run("update public.organizations set settings = settings || jsonb_build_object('agreement', $2::jsonb) where id = $1", [orgId, JSON.stringify(storedTerms(t))]));
const NY = 'America/New_York';
const today = () => dayInZone(NY);
const ALL: ConsentKind[] = ['esign', 'croa_disclosure', 'croa_contract', 'fcra_authorization'];
const PAPER: ConsentKind[] = ['croa_disclosure', 'croa_contract', 'fcra_authorization'];
const form = (fields: Record<string, string>) => { const fd = new FormData(); for (const [k, v] of Object.entries(fields)) fd.set(k, v); return fd; };
async function html(el: React.ReactElement | Promise<React.ReactElement>): Promise<string> {
  const { prelude } = await prerenderToNodeStream(await el);
  let s = '';
  for await (const chunk of prelude) s += chunk;
  return s.replace(/<!-- -->/g, ''); // React's separators between adjacent pieces of text
}
const clientPage = (id: string) => html(ClientPage({ params: Promise.resolve({ id }), searchParams: Promise.resolve({}) }) as Promise<React.ReactElement>);
const evidencePack = (id: string) => html(EvidencePackPage({ params: Promise.resolve({ id }) }) as Promise<React.ReactElement>);

function asStaff(o: { orgId: string; ownerId: string }, role: Role = 'owner', userId = o.ownerId, mode: 'agency' | 'personal' = 'agency'): Ctx {
  const session: SessionInfo = { sessionId: 's', userId, orgId: o.orgId, role, email: 'staff@test.dev', fullName: 'Staff Person', mfaVerified: true, totpEnabled: false, orgName: 'Bright Path', orgSlug: 'bright', orgMode: mode, orgPlan: 'trial' };
  const ctx: Ctx = { session, userId, orgId: o.orgId, role, tx: (fn) => asUser(userId, fn), can: (p) => can(role, p), need: () => undefined, meta: { ip: '10.0.0.1', userAgent: 'vitest' } };
  signedIn.ctx = ctx;
  return ctx;
}

interface PortalClient { userId: string; clientId: string; who: Signer; name: string; org: TestOrg }
/** A portal client with their details on file (address, date of birth, SSN), in `lang`. */
async function portalClient(org: TestOrg, name: string, lang: 'en' | 'es' = 'en'): Promise<PortalClient> {
  const user = await addMember(org.orgId, 'client', 'portal');
  const clientId = await addClient(org.orgId, name, { portalUserId: user.id });
  await withSystem((db) => db.run(`update public.clients set preferred_language = $2, address = '{"line1":"9 Elm St","city":"Dayton","state":"OH","zip":"45402"}' where id = $1`, [clientId, lang]));
  return { userId: user.id, clientId, who: { orgId: org.orgId, clientId, userId: user.id, ip: '203.0.113.7', userAgent: 'vitest', by: 'client' }, name, org };
}
function asClient(c: PortalClient) {
  const session: SessionInfo = { sessionId: 's', userId: c.userId, orgId: c.org.orgId, role: 'client', email: 'c@x.test', fullName: c.name, mfaVerified: true, totpEnabled: false, orgName: 'Bright Path', orgSlug: 'bright', orgMode: 'agency', orgPlan: 'trial' };
  signedIn.ctx = { session, userId: c.userId, orgId: c.org.orgId, role: 'client', tx: (fn: never) => asUser(c.userId, fn), can: () => false, need: () => undefined, meta: { ip: '10.0.0.2', userAgent: 'vitest' }, clientId: c.clientId };
}
/** The client signs `kinds` in the portal, exactly as their page showed them. */
async function sign(c: PortalClient, kinds: ConsentKind[]) {
  for (const kind of kinds) {
    const a = await asUser(c.userId, (db) => loadClientAgreements(db, c.org.orgId, c.clientId));
    const r = renderFor(a!, kind);
    if (!isRendered(r)) throw new Error(`${kind} not ready`);
    await asUser(c.userId, (db) => signAgreement(db, c.who, { kind, signedName: c.name, shown: (r as RenderedConsent).sha256, lang: 'en' }));
  }
}
const staffSigner = (org: { orgId: string; ownerId: string }, clientId: string): Signer => ({ orgId: org.orgId, clientId, userId: org.ownerId, ip: '10.0.0.1', userAgent: 'vitest', by: 'staff' });
/** Staff record `kinds` from a paper signed on `paperDay`. */
const onPaper = (org: { orgId: string; ownerId: string }, clientId: string, name: string, paperDay: string, kinds: ConsentKind[] = PAPER) =>
  asUser(org.ownerId, async (db) => { for (const kind of kinds) await signAgreement(db, staffSigner(org, clientId), { kind, signedName: name, lang: 'en', paperSignedOn: paperDay }); });
const approvedLetter = (orgId: string, clientId: string, disputeId: string | null = null) =>
  withSystem((db) => db.row<{ id: string }>("insert into public.letters (org_id, client_id, dispute_id, kind, title, recipient_name, status) values ($1, $2, $3, 'dispute', 'A letter', 'Experian', 'approved') returning id",
    [orgId, clientId, disputeId])).then((r) => r!.id);
const letterStatus = (id: string) => withSystem((db) => db.row<{ status: string; sent_on: string | null }>('select status, sent_on::text from public.letters where id = $1', [id]));
const clientStatus = async (id: string) => (await withSystem((db) => db.row<{ status: string }>('select status from public.clients where id = $1', [id])))!.status;
const contractRow = (clientId: string) => withSystem((db) => db.row<{ signed_on: string | null; cancellation_ends_on: string | null; text_shown: string | null }>(
  "select signed_on::text, cancellation_ends_on::text, text_shown from public.client_consents where client_id = $1 and kind = 'croa_contract' order by signed_at desc limit 1", [clientId]));
const toldOfSigning = (orgId: string) => withSystem((db) => db.rows<{ user_id: string; body: string; href: string }>(
  "select user_id, body, href from public.notifications where org_id = $1 and title = 'A client signed a new service agreement'", [orgId]));
const statusEvents = (clientId: string) => withSystem((db) => db.rows<{ summary: string; actor_id: string | null }>(
  "select summary, actor_id from public.client_events where client_id = $1 and kind = 'status_changed' order by created_at", [clientId]));

let A: TestOrg;
let owner: DActor;
beforeAll(async () => {
  A = await makeOrg('Follow-ups');
  await saveTerms(A.orgId);
  owner = { orgId: A.orgId, userId: A.ownerId, role: 'owner' };
});
afterAll(closePool);

describe('a paper agreement’s cancellation period runs from the date written on the paper', () => {
  it('recorded two weeks late: the text is dated with the paper, a letter really sent after the paper’s 3 business days is recorded, one inside them is refused', async () => {
    const c = await addClient(A.orgId, 'Lee Late');
    const paperDay = addDays(today(), -14);
    const ends = cancellationEndsOn(paperDay);
    await onPaper(A, c, 'Lee Late', paperDay);
    const row = (await contractRow(c))!;
    expect(row).toMatchObject({ signed_on: paperDay, cancellation_ends_on: ends });
    expect(row.text_shown).toContain(`Date: ${longDay(paperDay)}`);
    expect(row.text_shown).toContain(`before midnight on ${longDay(ends)}`);
    expect(ends < today()).toBe(true);
    expect(await asUser(A.ownerId, (db) => loadServiceStatus(db, c))).toMatchObject({ missing: [], contractSignedOn: paperDay, cancellationEndsOn: ends, inCancellationWindow: false });

    // Inside the paper's own period: refused, naming those days. The day after it: recorded, though staff recorded the
    // paper only later (the earlier rule counted from the recording day and refused this true date).
    const inside = await approvedLetter(A.orgId, c);
    await expect(asUser(A.ownerId, (db) => markSent(db, owner, inside, 'certified_mail', undefined, ends)))
      .rejects.toThrow(`is within the cancellation period of the service agreement Lee Late signed on ${sayDay(paperDay)}, which ran through ${sayDay(ends)}.`);
    const after = await approvedLetter(A.orgId, c);
    await asUser(A.ownerId, (db) => markSent(db, owner, after, 'certified_mail', undefined, addDays(ends, 1)));
    expect(await letterStatus(after)).toMatchObject({ status: 'sent', sent_on: addDays(ends, 1) });

    // Staff are not told the client can still cancel.
    asStaff(A);
    expect(await clientPage(c)).not.toContain('can cancel without penalty');
  });

  it('an existing client’s agreement signed on paper months before it was recorded: no cancellation period now, and the real submission date is recorded', async () => {
    const c = await addClient(A.orgId, 'Mia Moved');
    const paperDay = addDays(today(), -170);
    const ends = cancellationEndsOn(paperDay);
    await onPaper(A, c, 'Mia Moved', paperDay);
    expect(await asUser(A.ownerId, (db) => loadServiceStatus(db, c))).toMatchObject({ contractSignedOn: paperDay, cancellationEndsOn: ends, inCancellationWindow: false });
    const dispute = await addDispute(A.orgId, c, 'approved');
    await approvedLetter(A.orgId, c, dispute);
    const sentOn = addDays(paperDay, 44);
    await asUser(A.ownerId, (db) => transitionDispute(db, owner, dispute, 'submitted', { sentMethod: 'certified_mail', sentOn }));
    expect((await withSystem((db) => db.row<{ status: string }>('select status from public.disputes where id = $1', [dispute])))!.status).toBe('submitted');
    asStaff(A);
    const pack = await evidencePack(c);
    expect(pack).toContain(`The service agreement in force was signed on paper on ${sayDay(paperDay)} and recorded on ${sayDay(today())}. Counting 3 business days from the date on the paper (weekends and federal holidays skipped), the cancellation period ran through ${sayDay(ends)}.`);
    expect(pack).toContain('dated with the date written on the paper');
  });
});

describe('a client who cancelled and signs a new service agreement is active again', () => {
  it('in the portal: Active, a line on the timeline, and the owners, admins and assigned specialist are told', async () => {
    const C = await makeOrg('Signs Again');
    await saveTerms(C.orgId);
    const admin = await addMember(C.orgId, 'admin');
    const spec = await addMember(C.orgId, 'specialist');
    await addMember(C.orgId, 'manager');
    const c = await portalClient(C, 'Rae Again');
    await withSystem((db) => db.run('update public.clients set assigned_to = $2 where id = $1', [c.clientId, spec.id]));
    await sign(c, ALL);
    await asUser(c.userId, (db) => cancelAgreement(db, c.who, 'Rae Again'));
    expect(await clientStatus(c.clientId)).toBe('cancelled');

    await sign(c, ['croa_contract']); // Profile → "Sign a new service agreement"
    expect(await clientStatus(c.clientId)).toBe('active');
    expect(await statusEvents(c.clientId)).toEqual([{ summary: 'New service agreement signed after the client cancelled the last one in the client portal. Status set from Cancelled to Active.', actor_id: c.userId }]);
    const told = await toldOfSigning(C.orgId);
    expect(told.map((n) => n.user_id).sort()).toEqual([C.ownerId, admin.id, spec.id].sort()); // not the manager
    expect(told[0]).toMatchObject({ href: `/app/clients/${c.clientId}`, body: 'Rae Again signed a new service agreement after cancelling the last one in the client portal. Their status is Active again. No service may be provided before its cancellation period ends.' });
    // The gate is now the new agreement's own period, not the cancellation.
    expect(await asUser(C.ownerId, (db) => loadServiceStatus(db, c.clientId))).toMatchObject({ missing: [], clientCancelledOn: null, inCancellationWindow: true });
  });

  it('on paper, recorded by staff: the same, without telling the staff member who recorded it; a status staff set since is kept; a staff revocation restores nothing', async () => {
    const D = await makeOrg('Paper Again');
    await saveTerms(D.orgId);
    const admin = await addMember(D.orgId, 'admin');
    const c = await portalClient(D, 'Sol Paper');
    await sign(c, ALL);
    await asUser(c.userId, (db) => cancelAgreement(db, c.who, 'Sol Paper'));
    await onPaper(D, c.clientId, 'Sol Paper', today(), ['croa_contract']);
    expect(await clientStatus(c.clientId)).toBe('active');
    expect(await statusEvents(c.clientId)).toEqual([expect.objectContaining({ actor_id: D.ownerId, summary: expect.stringMatching(/Status set from Cancelled to Active\.$/) })]);
    expect((await toldOfSigning(D.orgId)).map((n) => n.user_id)).toEqual([admin.id]);

    // Staff had set another status after the cancellation: it is kept, and the agency is still told of the signature.
    const p = await portalClient(D, 'Pat Paused');
    await sign(p, ALL);
    await asUser(p.userId, (db) => cancelAgreement(db, p.who, 'Pat Paused'));
    await withSystem((db) => db.run("update public.clients set status = 'paused' where id = $1", [p.clientId]));
    await sign(p, ['croa_contract']);
    expect(await clientStatus(p.clientId)).toBe('paused');
    expect(await statusEvents(p.clientId)).toEqual([expect.objectContaining({ summary: expect.stringMatching(/Status left as it was\.$/) })]);
    expect((await toldOfSigning(D.orgId)).filter((n) => n.href.endsWith(p.clientId))[0]?.body).toBe('Pat Paused signed a new service agreement after cancelling the last one in the client portal. No service may be provided before its cancellation period ends.');

    // Staff revoked the agreement (not a cancellation by the client): a new one changes no status and tells nobody.
    const r = await portalClient(D, 'Ray Revoked');
    await sign(r, ALL);
    const contract = (await withSystem((db) => db.row<{ id: string }>("select id from public.client_consents where client_id = $1 and kind = 'croa_contract'", [r.clientId])))!.id;
    asStaff(D);
    await revokeConsentAction(form({ id: contract, clientId: r.clientId }));
    await withSystem((db) => db.run("update public.clients set status = 'cancelled' where id = $1", [r.clientId]));
    await sign(r, ['croa_contract']);
    expect(await clientStatus(r.clientId)).toBe('cancelled');
    expect(await statusEvents(r.clientId)).toEqual([]);
    expect((await toldOfSigning(D.orgId)).some((n) => n.href.endsWith(r.clientId))).toBe(false);
  });
});

describe('a personal workspace is asked for no CROA document, and the person gives their own authorization', () => {
  async function personal(name: string) {
    const r = await signUp({ email: `self-${uniq()}@test.dev`, password: PASSWORD, fullName: name, orgName: `${name} ${uniq()}`, mode: 'personal' }, { ip: testIp() });
    if (!r.ok) throw new Error(r.error);
    const self = (await withSystem((db) => db.row<{ id: string }>('select id from public.clients where org_id = $1', [r.orgId])))!.id;
    return { orgId: r.orgId, ownerId: r.userId, self };
  }

  it('New dispute names no missing consent; a workspace that recorded the 2026-01 drafts sees no flag and no instruction it cannot follow', async () => {
    const P = await personal('Nell New');
    asStaff(P, 'owner', P.ownerId, 'personal');
    const nd = await html(NewDisputePage({ searchParams: Promise.resolve({ clientId: P.self, category: 'incorrect_balance' }) }) as Promise<React.ReactElement>);
    expect(nd).toContain('Step 3 of 3');
    expect(nd).not.toContain('Consents missing');
    expect(nd).not.toContain('submission is blocked');

    // The rows a personal workspace recorded before (the 2026-01 drafts): the statement and agreement are not needed here.
    for (const kind of PAPER) await withSystem((db) => db.run("insert into public.client_consents (org_id, client_id, kind, version, signed_name, signed_at) values ($1, $2, $3, '2026-01-draft:000000000000', 'Nell New', now() - interval '90 days')", [P.orgId, P.self, kind]));
    const page = await clientPage(P.self);
    for (const s of ['Signed before the current', 'welcome link', 'record a new paper signature', 'Not on file — required', 'Missing consents']) expect(page, s).not.toContain(s);
    // Revoked, they are shown as not needed here, never as missing.
    await withSystem((db) => db.run("update public.client_consents set revoked_at = now(), revoked_reason = 'staff' where client_id = $1 and kind in ('croa_disclosure', 'croa_contract')", [P.self]));
    const after = await clientPage(P.self);
    expect(after).toContain('Not needed in a personal workspace.');
    expect(after.match(/>Missing</g) ?? []).toEqual([]);
  });

  it('records the authorization with no paper date, labelled as given by the account holder: the record, the timeline, the PDF and the evidence pack', async () => {
    const P = await personal('Robin Own');
    asStaff(P, 'owner', P.ownerId, 'personal');
    const before = await clientPage(P.self);
    expect(before).toContain('Your full legal name');
    expect(before).not.toContain('Date written on the signed paper');
    expect(before).not.toContain('signed this document on paper');

    expect(await recordConsentAction(undefined, form({ clientId: P.self, kind: 'fcra_authorization', signedName: 'Robin Own' }))).toEqual({ ok: 'Consent recorded.' });
    const row = (await withSystem((db) => db.row<{ id: string; signed_on: string; recorded_by: string | null; ip: string | null }>(
      "select id, signed_on::text, recorded_by, ip from public.client_consents where client_id = $1 and kind = 'fcra_authorization'", [P.self])))!;
    expect(row).toMatchObject({ signed_on: today(), recorded_by: P.ownerId, ip: '10.0.0.1' });
    const events = await withSystem((db) => db.rows<{ summary: string }>("select summary from public.client_events where client_id = $1 and kind = 'consent'", [P.self]));
    expect(events.map((e) => e.summary)).toEqual(['Authorization to review credit reports and dispute on my behalf given by the account holder']);

    const page = await clientPage(P.self);
    expect(page).toContain(`Given by the account holder on ${sayDay(today())} as “Robin Own”`);
    for (const s of ['Signed on paper', 'recorded by staff', 'App’s text when recorded']) expect(page, s).not.toContain(s);

    const res = await consentPdf(new Request('http://x/api/consents/x/pdf'), { params: Promise.resolve({ id: row.id }) });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toBe(`attachment; filename="fcra-authorization-given-${new Date().toISOString().slice(0, 10)}.pdf"`);
    const pdf = Buffer.from(await res.arrayBuffer()).toString('latin1');
    expect(pdf).toContain('(Given by the account holder, in their own workspace, by typing the name: Robin Own)');
    expect(pdf).not.toMatch(/paper|staff recorded|signed copy/i);

    const pack = await evidencePack(P.self);
    expect(pack).toContain('copy of the text given');
    expect(pack).toContain('given by the account holder in');
    expect(pack).toContain('A personal workspace makes no service agreement, so no notice of cancellation applies.');
    for (const s of ['signed on paper', 'On paper', 'staff member’s']) expect(pack, s).not.toContain(s);
  });
});

describe('the portal calls a paper agreement’s PDF the app’s text recorded on its day, not a copy of what the client signed', () => {
  it('the welcome Done step lists them apart, and Profile says when they were signed on paper; in English and Spanish', async () => {
    const c = await portalClient(A, 'Paula Paper');
    const paperDay = addDays(today(), -2);
    await onPaper(A, c.clientId, 'Paula Paper', paperDay);
    await sign(c, ['esign']); // the one the client gives in the portal
    asClient(c);
    const done = await html(WelcomePage({ searchParams: Promise.resolve({ step: 'done' }) }) as Promise<React.ReactElement>);
    const label = `The app’s text of your paper agreement, recorded ${portalLongDay(today(), 'en')} (not a copy of the paper)`;
    const [copies, paper] = done.split('Signed on paper</h3>');
    expect(paper, 'a "Signed on paper" list').toBeDefined();
    expect(copies).toContain('Copies of what you signed');
    expect(copies!.slice(copies!.indexOf('Copies of what you signed'))).toContain('Consent to electronic records and signatures');
    for (const title of ['Consumer Credit File Rights Under State and Federal Law', 'Service agreement', 'Authorization to review credit reports and dispute on my behalf']) {
      expect(copies!.slice(copies!.indexOf('Copies of what you signed')), title).not.toContain(title);
      expect(paper, title).toContain(title);
    }
    expect(paper!.split(label).length - 1).toBe(3);

    const prof = await html(PortalProfile({ searchParams: Promise.resolve({}) }) as Promise<React.ReactElement>);
    expect(prof.split(label).length - 1).toBe(3);
    expect(prof.split(`Signed on paper ${new Date(`${paperDay}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })}`).length - 1).toBe(3);
    expect(prof.split('Download a copy').length - 1).toBe(1); // the E-SIGN consent the client gave in the portal

    await withSystem((db) => db.run("update public.clients set preferred_language = 'es' where id = $1", [c.clientId]));
    const es = await html(WelcomePage({ searchParams: Promise.resolve({ step: 'done' }) }) as Promise<React.ReactElement>);
    expect(es).toContain('Firmados en papel');
    expect(es.split(`El texto de la aplicación de su acuerdo en papel, registrado el ${portalLongDay(today(), 'es')} (no es una copia del papel)`).length - 1).toBe(3);
  });
});

describe('the Welcome link card names why the service agreement cannot be signed yet', () => {
  const card = async (o: TestOrg, clientId: string) => {
    const ctx = asStaff(o);
    const c = (await withSystem((db) => db.row<{ email: string | null; portal_user_id: string | null; full_name: string }>('select email, portal_user_id, full_name from public.clients where id = $1', [clientId])))!;
    return html(WelcomeBlock({ ctx, clientId, first: c.full_name.split(' ')[0]!, email: c.email, portalUserId: c.portal_user_id }));
  };

  it('terms not saved, saved terms that no longer pass the checks, and the client’s own terms that no longer pass', async () => {
    const N = await makeOrg('No Terms Yet');
    const n = await addClient(N.orgId, 'Ned Waiting');
    expect(await card(N, n)).toContain('Ned cannot sign the service agreement until your client agreement terms are saved.');

    const S = await makeOrg('Stale Terms');
    await saveTerms(S.orgId, { ...TERMS, services: `${TERMS.services} We remove late payments and collections from your reports.` });
    const s = await addClient(S.orgId, 'Sid Stale');
    const stale = await card(S, s);
    expect(stale).toContain('Sid cannot sign the service agreement: your saved client agreement terms no longer pass the checks. Services: Do not promise that an item will be removed.');
    expect(stale).not.toContain('until your client agreement terms are saved');

    const o = await addClient(A.orgId, 'Ola Own');
    await withSystem((db) => db.run('update public.clients set agreement_payment_terms = $2, agreement_total_cents = 59400 where id = $1', [o, 'A $99 deposit is collected at enrollment, then $99 a month.']));
    const own = await card(A, o);
    expect(own).toContain('Ola’s own payment terms cannot be used in the service agreement: Payment terms: “deposit” asks for payment before the work it pays for is done.');
    expect(own).not.toContain('until your client agreement terms are saved');
  });
});
