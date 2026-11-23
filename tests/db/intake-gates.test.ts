import * as React from 'react';
import { prerenderToNodeStream } from 'react-dom/static';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Ctx } from '@/lib/auth/context';
import { getInvite, signUp, type SessionInfo } from '@/lib/auth/service';
import {
  cancelAgreement, cancellationBlock, deletionBlock, loadClientAgreements, loadServiceStatus, notReadyMessage, renderFor, signAgreement, type Signer,
} from '@/lib/agreements';
import { addDays, cancellationEndsOn, sayDay } from '@/lib/business-days';
import { storedTerms, type AgreementTerms } from '@/lib/compliance/agreement-terms';
import { longDay } from '@/lib/compliance/croa';
import { isRendered, type ConsentKind, type RenderedConsent } from '@/lib/compliance/disclosures';
import { encryptPII } from '@/lib/crypto';
import { transitionDispute, type DActor } from '@/lib/disputes/service';
import { loadBriefRecord } from '@/lib/letters/brief-load';
import { markSent } from '@/lib/letters/service';
import { loadOnboarding } from '@/lib/onboarding';
import { tr } from '@/lib/portal-i18n';
import { can, type Role } from '@/lib/rbac';
import { dayInZone } from '@/lib/util';
import { issueWelcomeLink, welcomeClient } from '@/lib/welcome-link';
import { recordConsentRows } from './consents';
import { addClient, addDispute, addMember, asUser, closePool, makeOrg, PASSWORD, testIp, uniq, withSystem, type TestOrg } from './helpers';

/**
 * The gates in front of the service, signature records and personal workspaces, through the real services, actions
 * and pages under row-level security (only the sign-in is stood in for). Findings of the review: LEG-1/SEC-2 (no
 * letter recorded as sent without an agreement in force), LEG-2 (sent dates), LEG-4/EXP-1 (personal workspaces),
 * LEG-6 (agreements signed on the 2026-01 drafts), LEG-7/SEC-4 (paper signatures), LEG-8 (the last day fixed at
 * signing), LEG-10 (the client cancels), LEG-11 (E-SIGN consent by staff), LEG-12 (the agency's zone), EXP-6, EXP-8,
 * SEC-1 (the email changes) and SEC-5 (impossible dates of birth).
 */
const signedIn = vi.hoisted(() => ({ ctx: null as unknown }));
vi.mock('@/lib/auth/context', () => ({
  requireStaff: async (perm?: string) => {
    const ctx = signedIn.ctx as { can(p: string): boolean };
    if (perm && !ctx.can(perm)) throw new Error('REDIRECT /app?denied=1');
    return ctx;
  },
  requireClient: async () => signedIn.ctx,
}));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));
vi.stubGlobal('React', React);

import ClientPage from '@/app/app/clients/[id]/page';
import EvidencePackPage from '@/app/app/clients/[id]/evidence/page';
import { ChargeBlock } from '@/app/app/clients/[id]/charge-block';
import { WelcomeBlock } from '@/app/app/clients/[id]/welcome-block';
import { createClientAction, recordConsentAction, revokeConsentAction, updateClientAction } from '@/app/app/clients/actions';
import { recordPaymentAction } from '@/app/app/billing/actions';
import SettingsPage from '@/app/app/settings/page';
import { portalSaveDetailsAction } from '@/app/portal/actions';

const TERMS: AgreementTerms = {
  legalName: 'Bright Path Credit LLC', address: '500 Bayshore Blvd, Suite 210, Tampa, FL 33606',
  services: 'We review your three credit reports with you, prepare dispute letters for the items you choose, track each investigation and report every response to you in your portal.',
  paymentTerms: 'A monthly fee of $99.00, charged on the 1st of each month for the work fully performed in the month before.',
  totalCents: 59_400, duration: 'About 6 months from the date you sign.', additional: '', updatedAt: '2026-11-20T15:00:00.000Z', updatedBy: 'test',
};
const saveTerms = (orgId: string) =>
  withSystem((db) => db.run("update public.organizations set settings = settings || jsonb_build_object('agreement', $2::jsonb) where id = $1", [orgId, JSON.stringify(storedTerms(TERMS))]));
const setZone = (orgId: string, tz: string) => withSystem((db) => db.run("update public.organizations set settings = settings || jsonb_build_object('timezone', $2::text) where id = $1", [orgId, tz]));
const NY = 'America/New_York';
const today = () => dayInZone(NY);
const form = (fields: Record<string, string>) => { const fd = new FormData(); for (const [k, v] of Object.entries(fields)) fd.set(k, v); return fd; };
async function html(el: React.ReactElement | Promise<React.ReactElement>): Promise<string> {
  const { prelude } = await prerenderToNodeStream(await el);
  let s = '';
  for await (const chunk of prelude) s += chunk;
  return s.replace(/<!-- -->/g, ''); // React's separators between adjacent pieces of text
}
const clientPage = (id: string) => html(ClientPage({ params: Promise.resolve({ id }), searchParams: Promise.resolve({}) }) as Promise<React.ReactElement>);

function asStaff(o: { orgId: string; ownerId: string }, role: Role = 'owner', userId = o.ownerId, mode: 'agency' | 'personal' = 'agency'): Ctx {
  const session: SessionInfo = { sessionId: 's', userId, orgId: o.orgId, role, email: 'staff@test.dev', fullName: 'Staff Person', mfaVerified: true, totpEnabled: false, orgName: 'Gate Agency', orgSlug: 'gate', orgMode: mode, orgPlan: 'trial' };
  const ctx: Ctx = { session, userId, orgId: o.orgId, role, tx: (fn) => asUser(userId, fn), can: (p) => can(role, p), need: () => undefined, meta: { ip: '10.0.0.1', userAgent: 'vitest' } };
  signedIn.ctx = ctx;
  return ctx;
}
function asClient(o: { orgId: string }, userId: string, clientId: string) {
  const session: SessionInfo = { sessionId: 's', userId, orgId: o.orgId, role: 'client', email: 'c@x.test', fullName: 'Client', mfaVerified: true, totpEnabled: false, orgName: 'Gate Agency', orgSlug: 'gate', orgMode: 'agency', orgPlan: 'trial' };
  signedIn.ctx = { session, userId, orgId: o.orgId, role: 'client', tx: (fn: never) => asUser(userId, fn), can: () => false, need: () => undefined, meta: { ip: '10.0.0.2', userAgent: 'vitest' }, clientId };
}

async function portalClient(org: TestOrg, name: string) {
  const user = await addMember(org.orgId, 'client', 'portal');
  const clientId = await addClient(org.orgId, name, { portalUserId: user.id });
  const who: Signer = { orgId: org.orgId, clientId, userId: user.id, ip: '203.0.113.7', userAgent: 'vitest', by: 'client' };
  return { userId: user.id, clientId, who, name };
}
type PortalClient = Awaited<ReturnType<typeof portalClient>>;
/** The client signs `kinds` in the portal, exactly as their page showed them, at `now`. */
async function sign(c: PortalClient, kinds: ConsentKind[], now = new Date()) {
  for (const kind of kinds) {
    const a = await asUser(c.userId, (db) => loadClientAgreements(db, c.who.orgId, c.clientId, now));
    const r = renderFor(a!, kind);
    if (!isRendered(r)) throw new Error(`${kind} not ready`);
    await asUser(c.userId, (db) => signAgreement(db, c.who, { kind, signedName: c.name, shown: (r as RenderedConsent).sha256, lang: 'en' }, now));
  }
}
const ALL: ConsentKind[] = ['esign', 'croa_disclosure', 'croa_contract', 'fcra_authorization'];
const staffSigner = (org: { orgId: string; ownerId: string }, clientId: string): Signer => ({ orgId: org.orgId, clientId, userId: org.ownerId, ip: '10.0.0.1', userAgent: 'vitest', by: 'staff' });
const approvedLetter = (orgId: string, clientId: string, o: { disputeId?: string | null; kind?: string } = {}) =>
  withSystem((db) => db.row<{ id: string }>("insert into public.letters (org_id, client_id, dispute_id, kind, title, recipient_name, status) values ($1, $2, $3, $4, 'A letter', 'Experian', 'approved') returning id",
    [orgId, clientId, o.disputeId ?? null, o.kind ?? 'dispute'])).then((r) => r!.id);
const letterStatus = (id: string) => withSystem((db) => db.row<{ status: string; sent_on: string | null }>('select status, sent_on::text from public.letters where id = $1', [id]));
const contractRow = (clientId: string) => withSystem((db) => db.row<{ signed_on: string | null; cancellation_ends_on: string | null; revoked_reason: string | null; revoked_at: string | null; recorded_by: string | null; text_shown: string | null }>(
  "select signed_on::text, cancellation_ends_on::text, revoked_reason, revoked_at, recorded_by, text_shown from public.client_consents where client_id = $1 and kind = 'croa_contract' order by signed_at desc limit 1", [clientId]));

let A: TestOrg;
let owner: DActor;
beforeAll(async () => {
  A = await makeOrg('Gates');
  await saveTerms(A.orgId);
  owner = { orgId: A.orgId, userId: A.ownerId, role: 'owner' };
});
afterAll(closePool);

describe('LEG-1 / SEC-2: no letter is recorded as sent without a service agreement in force', () => {
  it('refused while the client can cancel, still refused once they cancelled (and says so), as a submission is', async () => {
    const c = await portalClient(A, 'Pat Lee');
    await sign(c, ALL);
    const loose = await approvedLetter(A.orgId, c.clientId, { kind: 'goodwill' });
    const send = () => asUser(A.ownerId, (db) => markSent(db, owner, loose, 'certified_mail'));
    await expect(send()).rejects.toThrow(/^Pat Lee can still cancel their service agreement/);
    await asUser(c.userId, (db) => cancelAgreement(db, c.who, 'Pat Lee'));
    const cancelled = new RegExp(`^Pat Lee cancelled their service agreement on ${sayDay(today())}, so no service may be provided under it\\. Required consents are missing for this client: croa contract\\. Record them before recording a letter as sent\\.$`);
    await expect(send()).rejects.toThrow(cancelled);
    const dispute = await addDispute(A.orgId, c.clientId, 'approved');
    await approvedLetter(A.orgId, c.clientId, { disputeId: dispute });
    await expect(asUser(A.ownerId, (db) => transitionDispute(db, owner, dispute, 'submitted', { sentMethod: 'certified_mail' }))).rejects.toThrow(/^Pat Lee cancelled their service agreement on .*Record them before submitting\.$/);
    expect(await letterStatus(loose)).toMatchObject({ status: 'approved' });
  });

  it('refused for a client with no agreement on file at all', async () => {
    const c = await addClient(A.orgId, 'No Papers');
    const l = await approvedLetter(A.orgId, c);
    await expect(asUser(A.ownerId, (db) => markSent(db, owner, l, 'first_class_mail'))).rejects.toThrow('Required consents are missing for this client: croa disclosure, croa contract, fcra authorization. Record them before recording a letter as sent.');
    expect(await letterStatus(l)).toMatchObject({ status: 'approved' });
  });

  it('a follow-up and a method-of-verification letter on a submitted dispute: recorded while the agreement is in force, refused once it is revoked', async () => {
    const c = await addClient(A.orgId, 'Follow Up');
    await recordConsentRows(A.orgId, c);
    const dispute = await addDispute(A.orgId, c, 'submitted');
    await withSystem((db) => db.run("update public.disputes set submitted_at = now() - interval '40 days', due_at = now() - interval '10 days' where id = $1", [dispute]));
    const followUp = await approvedLetter(A.orgId, c, { disputeId: dispute, kind: 'follow_up' });
    await asUser(A.ownerId, (db) => markSent(db, owner, followUp, 'certified_mail'));
    expect(await letterStatus(followUp)).toMatchObject({ status: 'sent', sent_on: today() });
    // Staff revoke the agreement (the client asked them to stop): nothing more is recorded as sent for this client.
    await withSystem((db) => db.run("update public.client_consents set revoked_at = now(), revoked_reason = 'staff' where client_id = $1 and kind = 'croa_contract'", [c]));
    const mov = await approvedLetter(A.orgId, c, { disputeId: dispute, kind: 'method_of_verification' });
    await expect(asUser(A.ownerId, (db) => markSent(db, owner, mov, 'certified_mail'))).rejects.toThrow('Required consents are missing for this client: croa contract. Record them before recording a letter as sent.');
  });
});

describe('LEG-2: a sent date before the agreement or inside its cancellation period is refused', () => {
  it('names the days and asks for the real date; the day after the period is accepted, for letters and submissions alike', async () => {
    const c = await addClient(A.orgId, 'Morgan Day');
    // Signed on paper 40 days ago and recorded that day.
    const then = new Date(Date.now() - 40 * 86_400_000);
    const signedOn = dayInZone(NY, then);
    for (const kind of ['croa_disclosure', 'croa_contract', 'fcra_authorization'] as const) {
      await asUser(A.ownerId, (db) => signAgreement(db, staffSigner(A, c), { kind, signedName: 'Morgan Day', lang: 'en', paperSignedOn: signedOn }, then));
    }
    const ends = cancellationEndsOn(signedOn);
    const send = async (sentOn: string) => { const l = await approvedLetter(A.orgId, c); await asUser(A.ownerId, (db) => markSent(db, owner, l, 'certified_mail', undefined, sentOn)); return l; };
    await expect(send(addDays(signedOn, -1))).rejects.toThrow(`The date sent, ${sayDay(addDays(signedOn, -1))}, is before Morgan Day signed the service agreement in force (${sayDay(signedOn)}). No service may be provided before the agreement is signed (15 U.S.C. § 1679d(a)(1)), so this letter cannot be recorded as sent on that day. Record the date it was really sent.`);
    for (const day of [signedOn, ends]) {
      await expect(send(day)).rejects.toThrow(`The date sent, ${sayDay(day)}, is within the cancellation period of the service agreement Morgan Day signed on ${sayDay(signedOn)}, which ran through ${sayDay(ends)}. No service may be provided before that period ends (15 U.S.C. § 1679d(a)(2)), so this letter cannot be recorded as sent on that day. Record the date it was really sent.`);
    }
    const ok = await send(addDays(ends, 1));
    expect(await letterStatus(ok)).toMatchObject({ status: 'sent', sent_on: addDays(ends, 1) });

    const dispute = await addDispute(A.orgId, c, 'approved', 'Lakeside ••0001 (Experian)');
    await approvedLetter(A.orgId, c, { disputeId: dispute });
    const submit = (sentOn: string) => asUser(A.ownerId, (db) => transitionDispute(db, owner, dispute, 'submitted', { sentMethod: 'certified_mail', sentOn }));
    await expect(submit(ends)).rejects.toThrow(/so this dispute cannot be recorded as submitted on that day\. Record the date it was really sent\.$/);
    await submit(addDays(ends, 1));
    expect((await withSystem((db) => db.row<{ status: string }>('select status from public.disputes where id = $1', [dispute])))!.status).toBe('submitted');
  });
});

describe('LEG-4 / EXP-1: a personal workspace makes no agreement with itself', () => {
  it('its own dispute and letters are recorded the same day with no agreement on file; no contract is recorded; no deletion block; no agency cards', async () => {
    const r = await signUp({ email: `self-${uniq()}@test.dev`, password: PASSWORD, fullName: 'Robin Self', orgName: 'Robin', mode: 'personal' }, { ip: testIp() });
    if (!r.ok) throw new Error(r.error);
    const P = { orgId: r.orgId, ownerId: r.userId };
    const self = (await withSystem((db) => db.row<{ id: string }>('select id from public.clients where org_id = $1', [P.orgId])))!.id;
    const me: DActor = { orgId: P.orgId, userId: P.ownerId, role: 'owner' };
    expect(await asUser(P.ownerId, (db) => loadServiceStatus(db, self))).toMatchObject({ personal: true, missing: [], inCancellationWindow: false, cancellationEndsOn: null });

    const dispute = await addDispute(P.orgId, self, 'approved');
    await approvedLetter(P.orgId, self, { disputeId: dispute });
    await asUser(P.ownerId, (db) => transitionDispute(db, me, dispute, 'submitted', { sentMethod: 'certified_mail' }));
    const loose = await approvedLetter(P.orgId, self, { kind: 'goodwill' });
    await asUser(P.ownerId, (db) => markSent(db, me, loose, 'first_class_mail'));
    expect(await letterStatus(loose)).toMatchObject({ status: 'sent' });
    expect(await asUser(P.ownerId, (db) => cancellationBlock(db, self, 'send'))).toBeNull();

    // No contract with oneself, and no terms needed for anything else: the authorization (for report imports) is recorded.
    const rec = (kind: ConsentKind) => asUser(P.ownerId, (db) => signAgreement(db, staffSigner(P, self), { kind, signedName: 'Robin Self', lang: 'en', paperSignedOn: today() }));
    await expect(rec('croa_contract')).rejects.toMatchObject({ code: 'personal' });
    await expect(rec('croa_disclosure')).rejects.toMatchObject({ code: 'personal' });
    await rec('fcra_authorization');

    // The pages ask for nothing of the kind: no Welcome link card, no CROA documents, no Client agreement card.
    asStaff(P, 'owner', P.ownerId, 'personal');
    const page = await clientPage(self);
    expect(page).toContain('Compliance record');
    for (const s of ['id="welcome"', 'Missing consents', 'Not on file — required', 'required consent', '<option value="croa_contract"', '<option value="esign"']) expect(page, s).not.toContain(s);
    expect(page).toContain('<option value="fcra_authorization"');
    const settings = await html(SettingsPage() as Promise<React.ReactElement>);
    expect(settings).not.toContain('id="agreement"');
    expect(settings).not.toContain('Client agreement');
    expect(settings).toContain('No credit repair agreement, Consumer Credit File Rights statement or cancellation period applies to your own file');

    // A statement on file from before this change does not keep the person's own record for 2 years.
    await withSystem((db) => db.run("insert into public.client_consents (org_id, client_id, kind, version, signed_name) values ($1, $2, 'croa_disclosure', '2026-01-draft:000000000000', 'Robin Self')", [P.orgId, self]));
    expect(await asUser(P.ownerId, (db) => deletionBlock(db, self))).toBeNull();
    expect(await asUser(P.ownerId, (db) => db.run('delete from public.clients where id = $1', [self]))).toBe(1);
  });

  it('an agency still has all of it', async () => {
    asStaff(A);
    const settings = await html(SettingsPage() as Promise<React.ReactElement>);
    expect(settings).toContain('id="agreement"');
    const c = await addClient(A.orgId, 'Agency Client');
    const page = await clientPage(c);
    for (const s of ['id="welcome"', 'Missing consents', 'Not on file — required', '<option value="croa_contract"']) expect(page, s).toContain(s);
  });
});

describe('LEG-7 / SEC-4: a paper signature records the date on the paper and is never called a signed copy', () => {
  it('the date is required, real, not in the future and not over a year back; the text is dated with it and the period runs from it', async () => {
    const p = await addClient(A.orgId, 'Sam Paper');
    const rec = (kind: ConsentKind, paperSignedOn?: string) => asUser(A.ownerId, (db) => signAgreement(db, staffSigner(A, p), { kind, signedName: 'Sam Paper', lang: 'en', paperSignedOn }));
    await expect(rec('croa_disclosure')).rejects.toMatchObject({ code: 'paper_date', message: 'Enter the date written on the signed paper.' });
    await expect(rec('croa_disclosure', '2026-02-30')).rejects.toThrow('Enter the date written on the signed paper as a real date.');
    await expect(rec('croa_disclosure', addDays(today(), 2))).rejects.toThrow('The date written on the signed paper cannot be in the future.');
    await expect(rec('croa_disclosure', addDays(today(), -400))).rejects.toThrow(/more than a year ago/);
    const paperDay = addDays(today(), -3);
    await rec('croa_disclosure', paperDay);
    await rec('croa_contract', paperDay);
    const row = (await contractRow(p))!;
    // The paper's date is kept. The stored text is the app's text today, dated with the paper's date, and its Notice of
    // Cancellation gives the last day counted from that date, the day the period runs through (15 U.S.C. § 1679e(a)).
    const ends = cancellationEndsOn(paperDay);
    expect(row).toMatchObject({ signed_on: paperDay, cancellation_ends_on: ends, recorded_by: A.ownerId });
    expect(row.text_shown).toContain(`Date: ${longDay(paperDay)}`);
    expect(row.text_shown).toContain(`before midnight on ${longDay(ends)}`);
    expect(await asUser(A.ownerId, (db) => loadServiceStatus(db, p))).toMatchObject({ contractSignedOn: paperDay, cancellationEndsOn: ends, inCancellationWindow: ends >= today() });

    // Through the form: the date is required there too.
    asStaff(A);
    expect(await recordConsentAction(undefined, form({ clientId: p, kind: 'fcra_authorization', signedName: 'Sam Paper' }))).toEqual({ error: 'Enter the date written on the signed paper.' });
    expect(await recordConsentAction(undefined, form({ clientId: p, kind: 'fcra_authorization', signedName: 'Sam Paper', paperSignedOn: paperDay }))).toEqual({ ok: 'Consent recorded.' });
    expect(await createClientAction(undefined, form({ fullName: `Paper ${uniq()}`, consentDisclosure: 'on', signedName: 'Paper Person' }))).toEqual({ error: 'Enter the date written on the signed paper to record consents.' });

    // The client page and the evidence pack say what the stored text is.
    const page = await clientPage(p);
    expect(page).toContain(`Signed on paper on ${sayDay(paperDay)} as “Sam Paper” · recorded by staff on ${sayDay(today())}`);
    expect(page).toContain('App’s text when recorded (PDF)');
    expect(page).toContain('Date written on the signed paper');
    const pack = await html(EvidencePackPage({ params: Promise.resolve({ id: p }) }) as Promise<React.ReactElement>);
    expect(pack).toContain('app’s text when recorded (not a copy of the signed paper)');
    expect(pack).toContain(`On paper dated ${sayDay(paperDay)}; recorded`);
    expect(pack).toContain('It is not a copy of the paper the client signed');
    expect(pack).toContain(`signed on paper on ${sayDay(paperDay)} and recorded on ${sayDay(today())}. Counting 3 business days from the date on the paper (weekends and federal holidays skipped), the cancellation period ${ends >= today() ? 'runs' : 'ran'} through ${sayDay(ends)}.`);
    expect(pack).not.toContain('copy of the signed text');
  });
});

describe('LEG-8: the last day of the period is fixed when the agreement is signed', () => {
  it('a later change of the agency’s time zone does not end the period before the day the client’s Notice states', async () => {
    const Z = await makeOrg('Zones');
    await saveTerms(Z.orgId);
    const z = await portalClient(Z, 'Zoe Night');
    // 00:30 on Monday 16 November 2026 in New York (still Sunday in Los Angeles).
    await sign(z, ALL, new Date('2026-11-16T05:30:00Z'));
    const row = (await contractRow(z.clientId))!;
    expect(row).toMatchObject({ signed_on: '2026-11-16', cancellation_ends_on: '2026-11-19' });
    expect(row.text_shown).toContain('before midnight on November 19, 2026');
    await setZone(Z.orgId, 'America/Los_Angeles');
    const thursday = new Date('2026-11-19T20:00:00Z'); // noon Thursday in Los Angeles
    expect(await asUser(Z.ownerId, (db) => cancellationBlock(db, z.clientId, 'send', thursday))).toMatch(/runs through Nov 19, 2026/);
    expect((await asUser(z.userId, (db) => loadClientAgreements(db, Z.orgId, z.clientId, thursday)))!.status).toMatchObject({ inCancellationWindow: true, cancellationEndsOn: '2026-11-19' });
    expect(await asUser(Z.ownerId, (db) => cancellationBlock(db, z.clientId, 'send', new Date('2026-11-20T20:00:00Z')))).toBeNull();
  });
});

describe('LEG-10: when the client cancels, the database records why, marks them cancelled and tells the agency', () => {
  it('revoked_reason, the client’s status, a timeline line, and a notification to the owners, the admins and the specialist', async () => {
    const C = await makeOrg('Cancels');
    await saveTerms(C.orgId);
    const admin = await addMember(C.orgId, 'admin');
    const spec = await addMember(C.orgId, 'specialist');
    const manager = await addMember(C.orgId, 'manager');
    const c = await portalClient(C, 'Lee Cancel');
    await withSystem((db) => db.run('update public.clients set assigned_to = $2 where id = $1', [c.clientId, spec.id]));
    await sign(c, ALL);
    await asUser(c.userId, (db) => cancelAgreement(db, c.who, 'Lee Cancel'));
    expect(await contractRow(c.clientId)).toMatchObject({ revoked_reason: 'client_cancelled' });
    expect((await withSystem((db) => db.row<{ status: string }>('select status from public.clients where id = $1', [c.clientId])))!.status).toBe('cancelled');
    const told = await withSystem((db) => db.rows<{ user_id: string; href: string; body: string }>("select user_id, href, body from public.notifications where org_id = $1 and title = 'A client cancelled their service agreement'", [C.orgId]));
    expect(told.map((n) => n.user_id).sort()).toEqual([C.ownerId, admin.id, spec.id].sort());
    expect(told.map((n) => n.user_id)).not.toContain(manager.id);
    expect(told[0]!.href).toBe(`/app/clients/${c.clientId}`);
    expect(told[0]!.body).toMatch(/^Lee Cancel used “Cancel my agreement” in the client portal/);
    expect((await withSystem((db) => db.row<{ n: number }>("select count(*)::int as n from public.client_events where client_id = $1 and kind = 'consent_revoked' and summary like 'Client cancelled the service agreement%'", [c.clientId])))!.n).toBe(1);
    expect(await asUser(C.ownerId, (db) => loadServiceStatus(db, c.clientId))).toMatchObject({ clientCancelledOn: today(), missing: ['croa_contract'] });

    // A staff revocation records 'staff'.
    const d = await addClient(C.orgId, 'Staff Revoke');
    await recordConsentRows(C.orgId, d);
    const id = (await withSystem((db) => db.row<{ id: string }>("select id from public.client_consents where client_id = $1 and kind = 'croa_contract'", [d])))!.id;
    asStaff(C);
    await revokeConsentAction(form({ id, clientId: d }));
    expect(await contractRow(d)).toMatchObject({ revoked_reason: 'staff' });
    expect(await asUser(C.ownerId, (db) => loadServiceStatus(db, d))).toMatchObject({ clientCancelledOn: null });
  });
});

describe('LEG-11: staff never record the consent to electronic records', () => {
  it('refused by the app and by the database, and not offered on the client page', async () => {
    const p = await addClient(A.orgId, 'Ezra Paper');
    await expect(asUser(A.ownerId, (db) => signAgreement(db, staffSigner(A, p), { kind: 'esign', signedName: 'Ezra Paper', lang: 'en', paperSignedOn: today() }))).rejects.toMatchObject({ code: 'portal_only' });
    asStaff(A);
    expect(await recordConsentAction(undefined, form({ clientId: p, kind: 'esign', signedName: 'Ezra Paper', paperSignedOn: today() }))).toEqual({ error: 'The consent to electronic records is given by the client in their portal, never recorded by staff. A client who signs on paper does not need it.' });
    await expect(withSystem((db) => db.run("insert into public.client_consents (org_id, client_id, kind, version, signed_name, recorded_by) values ($1, $2, 'esign', 'x', 'Ezra', $3)", [A.orgId, p, A.ownerId]))).rejects.toThrow(/client_consents_esign_by_client/);
    const page = await clientPage(p);
    expect(page).not.toContain('<option value="esign"');
    expect(page).toContain('<option value="croa_disclosure"');
  });
});

describe('LEG-6: agreements signed on the 2026-01 drafts', () => {
  it('staff are told what to do; the portal asks for the current statement before the new agreement', async () => {
    const c = await portalClient(A, 'Rita Draft');
    await withSystem(async (db) => {
      for (const kind of ['croa_disclosure', 'croa_contract', 'fcra_authorization'])
        await db.run("insert into public.client_consents (org_id, client_id, kind, version, signed_name, signed_at) values ($1, $2, $3, '2026-01-draft:abcdef012345', 'Rita Draft', now() - interval '60 days')", [A.orgId, c.clientId, kind]);
    });
    const ctx = asStaff(A);
    const card = await html(WelcomeBlock({ ctx, clientId: c.clientId, first: 'Rita', email: 'r@x.test', portalUserId: c.userId }));
    expect(card).toContain('Signed before the current agreement');
    expect(card).toContain('Rita’s service agreement was signed before the current agreement: it has no terms or notice of cancellation.');
    expect(card).toContain('ask Rita to sign in: the portal asks for the current ones, the statement before the agreement.');
    const page = await clientPage(c.clientId);
    expect(page).toContain('Signed before the current agreement: it has no terms or notice of cancellation.');
    expect(page).toContain('Signed before the current statement: it is not the full Consumer Credit File Rights statement.');

    // The portal: the old agreement and authorization count, the old statement does not.
    expect(await asUser(c.userId, (db) => loadOnboarding(db, c.clientId))).toMatchObject({ agreements: { signed: 2, next: 'esign' } });
    await sign(c, ['esign']);
    expect((await asUser(c.userId, (db) => loadOnboarding(db, c.clientId)))!.agreements.next).toBe('croa_disclosure');
    // A new agreement waits until the old one is revoked, and then until the current statement is signed.
    await expect(sign(c, ['croa_contract'])).rejects.toMatchObject({ code: 'already' });
    await withSystem((db) => db.run("update public.client_consents set revoked_at = now(), revoked_reason = 'staff' where client_id = $1 and kind = 'croa_contract'", [c.clientId]));
    await expect(sign(c, ['croa_contract'])).rejects.toMatchObject({ code: 'order', before: 'croa_disclosure' });
    await sign(c, ['croa_disclosure', 'croa_contract']);
    expect(await asUser(c.userId, (db) => loadOnboarding(db, c.clientId))).toMatchObject({ agreements: { signed: 4, next: null, done: true } });
    // On paper the same order holds: staff recording a new agreement for a client whose statement is the old one are told why.
    const paper = await addClient(A.orgId, 'Old Paper');
    await withSystem((db) => db.run("insert into public.client_consents (org_id, client_id, kind, version, signed_name) values ($1, $2, 'croa_disclosure', '2026-01-draft:abcdef012345', 'Old Paper')", [A.orgId, paper]));
    await expect(asUser(A.ownerId, (db) => signAgreement(db, staffSigner(A, paper), { kind: 'croa_contract', signedName: 'Old Paper', lang: 'en', paperSignedOn: today() })))
      .rejects.toThrow(/The Consumer Credit File Rights statement on file was signed on an earlier version and does not count: record the current one first\.$/);
  });
});

describe('LEG-12: the evidence pack and the charge check count days where the agency works', () => {
  it('an agency in Puerto Rico: the signing day and the last day of the period are its own, not New York’s', async () => {
    const PR = await makeOrg('Atlantic');
    await setZone(PR.orgId, 'America/Puerto_Rico');
    const c = await addClient(PR.orgId, 'Ana Rivera');
    // 00:30 on Monday 8 December 2025 in Puerto Rico is 23:30 on Sunday in New York, the deployment's zone.
    await recordConsentRows(PR.orgId, c, new Date('2025-12-08T04:30:00Z'));
    await withSystem((db) => db.run("insert into public.letters (org_id, client_id, kind, title, recipient_name, status, sent_on, sent_at) values ($1, $2, 'dispute', 'Sent letter', 'Experian', 'sent', $3, now())", [PR.orgId, c, dayInZone('America/Puerto_Rico')]));
    const ctx = asStaff(PR);
    const pack = await html(EvidencePackPage({ params: Promise.resolve({ id: c }) }) as Promise<React.ReactElement>);
    expect(pack).toContain('The service agreement in force was signed on Dec 8, 2025. Counting 3 business days after signing (weekends and federal holidays skipped), the cancellation period ran through Dec 11, 2025.');
    expect(pack).toContain('(America/Puerto_Rico)');
    const block = await html(ChargeBlock({ id: c, ctx }) as Promise<React.ReactElement>);
    expect(block).toContain('the cancellation period ran through Dec 11, 2025');
    expect(block).not.toContain('Dec 10, 2025');
    // Recording the payment runs the same check, on the same day.
    expect(await recordPaymentAction(undefined, form({ clientId: c, amount: '99', method: 'card', performed: 'on', period: dayInZone('America/Puerto_Rico').slice(0, 7) }))).toEqual({ ok: 'Payment recorded.' });
  });
});

describe('EXP-6: the "terms not saved" message fits who reads it', () => {
  it('a specialist is told to ask an owner or admin; on New client, how to create the client now; nothing half-made', async () => {
    const B = await makeOrg('NoTerms');
    const spec = await addMember(B.orgId, 'specialist');
    const x = await addClient(B.orgId, 'Nia Paper');
    asStaff(B, 'specialist', spec.id);
    expect(await recordConsentAction(undefined, form({ clientId: x, kind: 'croa_disclosure', signedName: 'Nia Paper', paperSignedOn: today() }))).toEqual({ ok: 'Consent recorded.' });
    expect(await recordConsentAction(undefined, form({ clientId: x, kind: 'croa_contract', signedName: 'Nia Paper', paperSignedOn: today() }))).toEqual({ error: notReadyMessage(false) });
    asStaff(B);
    expect(await recordConsentAction(undefined, form({ clientId: x, kind: 'croa_contract', signedName: 'Nia Paper', paperSignedOn: today() }))).toEqual({ error: notReadyMessage(true) });

    asStaff(B, 'specialist', spec.id);
    const name = `Paper Person ${uniq()}`;
    const r = await createClientAction(undefined, form({ fullName: name, consentDisclosure: 'on', consentContract: 'on', consentAuthorization: 'on', signedName: name, paperSignedOn: today() }));
    expect(r).toEqual({ error: notReadyMessage(false, true) });
    expect(r?.error).toContain('Ask an owner or admin to save them in Settings → Client agreement. Or untick the service agreement and the authorization to create the client now');
    const made = () => withSystem((db) => db.row<{ n: number }>('select count(*)::int as n from public.clients where org_id = $1 and full_name = $2', [B.orgId, name])).then((x) => x!.n);
    expect(await made()).toBe(0);
    // Unticking them creates the client, with the statement recorded (the redirect to the new client page).
    await expect(createClientAction(undefined, form({ fullName: name, consentDisclosure: 'on', signedName: name, paperSignedOn: today() }))).rejects.toMatchObject({ digest: expect.stringContaining('/app/clients/') });
    expect(await made()).toBe(1);
  });
});

describe('EXP-8 (c): a paper client needs no E-SIGN consent', () => {
  it('without a portal account it is shown as not needed; with one, as missing', async () => {
    asStaff(A);
    const paper = await addClient(A.orgId, 'Paper Only');
    const page = await clientPage(paper);
    expect(page).toContain('Not needed for paper signatures. If the client joins the portal, they give it there first.');
    expect(page).toContain('>Not needed</span>');
    const c = await portalClient(A, 'Portal Person');
    const portal = await clientPage(c.clientId);
    expect(portal).toContain('Not on file — the client gives it first, in the portal');
    expect(portal).not.toContain('Not needed for paper signatures');
  });
});

describe('SEC-1: changing a client’s email ends their unused welcome link', () => {
  it('a corrected or cleared email ends it in the same save; a save that keeps the email does not', async () => {
    const c = await addClient(A.orgId, 'Typo Person');
    await withSystem((db) => db.run("update public.clients set email = 'typo@gmial.test' where id = $1", [c]));
    const issue = async () => (await asUser(A.ownerId, async (db) => issueWelcomeLink(db, { orgId: A.orgId, userId: A.ownerId }, (await welcomeClient(db, c))!, 'copy'))).link.split('/invite/')[1]!;
    const token = await issue();
    asStaff(A);
    const fields = { id: c, fullName: 'Typo Person', status: 'active', stage: 'intake', preferredLanguage: 'en' };
    // Typed again with capitals and a space: the same address, so the link stays.
    expect(await updateClientAction(undefined, form({ ...fields, email: ' Typo@Gmial.test ' }))).toEqual({ ok: 'Client updated.' });
    expect(await getInvite(token)).toMatchObject({ clientId: c });
    expect(await updateClientAction(undefined, form({ ...fields, email: 'typo@gmail.test' }))).toEqual({ ok: 'Client updated. The welcome link sent to the old email no longer works: send a new one from the client page.' });
    expect(await getInvite(token)).toBeNull();
    expect((await withSystem((db) => db.row<{ n: number }>("select count(*)::int as n from public.client_events where client_id = $1 and kind = 'portal_invite_ended'", [c])))!.n).toBe(1);
    const second = await issue();
    await updateClientAction(undefined, form({ ...fields, email: '' }));
    expect(await getInvite(second)).toBeNull();
  });
});

describe('SEC-5: an impossible date of birth is refused, and never printed as another date', () => {
  it('the staff form and the portal refuse 2000-02-31; a stored one reads as not on file', async () => {
    const c = await portalClient(A, 'Dob Person');
    asStaff(A);
    expect(await updateClientAction(undefined, form({ id: c.clientId, fullName: 'Dob Person', status: 'active', stage: 'intake', dob: '2000-02-31' }))).toEqual({ error: 'dob: Enter a real date of birth' });
    await withSystem((db) => db.run('update public.clients set dob_encrypted = null, ssn_last4 = null, ssn_encrypted = null where id = $1', [c.clientId]));
    asClient(A, c.userId, c.clientId);
    const r = await portalSaveDetailsAction(undefined, form({ language: 'en', line1: '9 Elm St', city: 'Dayton', state: 'OH', zip: '45402', dob: '2000-02-31', ssn: '123-45-6789' }));
    expect(r).toEqual({ error: tr('en')('e_dob') });
    expect((await withSystem((db) => db.row<{ dob: string | null }>('select dob_encrypted as dob from public.clients where id = $1', [c.clientId])))!.dob).toBeNull();
    await withSystem((db) => db.run('update public.clients set dob_encrypted = $2 where id = $1', [c.clientId, encryptPII('2000-02-31')]));
    expect((await asUser(A.ownerId, (db) => loadBriefRecord(db, c.clientId, null)))!.client.dob).toBeNull();
  });
});
