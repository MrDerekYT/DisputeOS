import * as React from 'react';
import { prerenderToNodeStream } from 'react-dom/static';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Ctx } from '@/lib/auth/context';
import { signUp, type SessionInfo } from '@/lib/auth/service';
import { AgreementError, loadAgency, loadClientAgreements, renderFor, signAgreement, type Signer } from '@/lib/agreements';
import { storedTerms, type AgreementTerms } from '@/lib/compliance/agreement-terms';
import { signedCopyBlocks, type SignedConsent } from '@/lib/compliance/consent-pdf';
import { isRendered, signedPayment, type ConsentKind, type RenderedConsent } from '@/lib/compliance/disclosures';
import { tr } from '@/lib/portal-i18n';
import { can, type Role } from '@/lib/rbac';
import { dayInZone } from '@/lib/util';
import { addClient, addMember, asUser, closePool, makeOrg, PASSWORD, testIp, uniq, withSystem, type TestOrg } from './helpers';

/**
 * The agency's terms, a client's own payment terms and the copies, through the real actions, services and pages under
 * row-level security (only the sign-in is stood in for). Findings of the review: LEG-9 (one total for every client),
 * LEG-3 / SEC-3 (promises in the agency's terms), LEG-5 (payment asked for at signing), LEG-13 (characters the PDF
 * cannot print) and LEG-14 (the principal business address).
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
import { clearClientTermsAction, recordConsentAction, revokeConsentAction, saveClientTermsAction } from '@/app/app/clients/actions';
import { saveAgreementAction } from '@/app/app/settings/agreement-actions';
import SettingsPage from '@/app/app/settings/page';
import { portalSignConsentAction } from '@/app/portal/actions';
import { GET as consentPdf } from '@/app/api/consents/[id]/pdf/route';

const TERMS: AgreementTerms = {
  legalName: 'Bright Path Credit LLC', address: '500 Bayshore Blvd, Suite 210, Tampa, FL 33606',
  services: 'We review your three credit reports with you, prepare dispute letters for the items you choose, track each investigation and report every response to you in your portal.',
  paymentTerms: 'A monthly fee of $99.00, charged on the 1st of each month for the work fully performed in the month before.',
  totalCents: 59_400, duration: 'About 6 months from the date you sign.', additional: '', updatedAt: '2026-11-20T15:00:00.000Z', updatedBy: 'test',
};
const saveTerms = (orgId: string, t: AgreementTerms = TERMS) =>
  withSystem((db) => db.run("update public.organizations set settings = settings || jsonb_build_object('agreement', $2::jsonb) where id = $1", [orgId, JSON.stringify(storedTerms(t))]));
const PREMIUM = 'A monthly fee of $149.00, charged on the 1st of each month for the work fully performed in the month before.';
const form = (fields: Record<string, string>) => { const fd = new FormData(); for (const [k, v] of Object.entries(fields)) fd.set(k, v); return fd; };
async function html(el: React.ReactElement | Promise<React.ReactElement>): Promise<string> {
  const { prelude } = await prerenderToNodeStream(await el);
  let s = '';
  for await (const chunk of prelude) s += chunk;
  return s.replace(/<!-- -->/g, ''); // React's separators between adjacent pieces of text
}
const clientPage = (id: string) => html(ClientPage({ params: Promise.resolve({ id }), searchParams: Promise.resolve({}) }) as Promise<React.ReactElement>);
const today = () => dayInZone('America/New_York');

function asStaff(o: { orgId: string }, role: Role, userId: string, mode: 'agency' | 'personal' = 'agency'): Ctx {
  const session: SessionInfo = { sessionId: 's', userId, orgId: o.orgId, role, email: 'staff@test.dev', fullName: 'Staff Person', mfaVerified: true, totpEnabled: false, orgName: 'Terms Agency', orgSlug: 'terms', orgMode: mode, orgPlan: 'trial' };
  const ctx: Ctx = { session, userId, orgId: o.orgId, role, tx: (fn) => asUser(userId, fn), can: (p) => can(role, p), need: () => undefined, meta: { ip: '10.0.0.1', userAgent: 'vitest' } };
  signedIn.ctx = ctx;
  return ctx;
}
function asClient(o: { orgId: string }, userId: string, clientId: string) {
  const session: SessionInfo = { sessionId: 's', userId, orgId: o.orgId, role: 'client', email: 'c@x.test', fullName: 'Client', mfaVerified: true, totpEnabled: false, orgName: 'Terms Agency', orgSlug: 'terms', orgMode: 'agency', orgPlan: 'trial' };
  signedIn.ctx = { session, userId, orgId: o.orgId, role: 'client', tx: (fn: never) => asUser(userId, fn), can: () => false, need: () => undefined, meta: { ip: '10.0.0.2', userAgent: 'vitest' }, clientId };
}

async function portalClient(org: TestOrg, name: string) {
  const user = await addMember(org.orgId, 'client', 'portal');
  const clientId = await addClient(org.orgId, name, { portalUserId: user.id });
  const who: Signer = { orgId: org.orgId, clientId, userId: user.id, ip: '203.0.113.7', userAgent: 'vitest', by: 'client' };
  return { userId: user.id, clientId, who, name };
}
type PortalClient = Awaited<ReturnType<typeof portalClient>>;
/** The client's contract as their page shows it now. */
const contractFor = async (c: PortalClient) => {
  const a = await asUser(c.userId, (db) => loadClientAgreements(db, c.who.orgId, c.clientId));
  return renderFor(a!, 'croa_contract');
};
/** The client signs `kinds` in the portal, exactly as their page showed them. */
async function sign(c: PortalClient, kinds: ConsentKind[]) {
  for (const kind of kinds) {
    const a = await asUser(c.userId, (db) => loadClientAgreements(db, c.who.orgId, c.clientId));
    const r = renderFor(a!, kind);
    if (!isRendered(r)) throw new Error(`${kind} not ready`);
    await asUser(c.userId, (db) => signAgreement(db, c.who, { kind, signedName: c.name, shown: (r as RenderedConsent).sha256, lang: 'en' }));
  }
}
const ALL: ConsentKind[] = ['esign', 'croa_disclosure', 'croa_contract', 'fcra_authorization'];
const storedContract = (clientId: string) => withSystem((db) => db.row<SignedConsent & { id: string }>(
  "select id, kind, text_shown, text_sha256, signed_name, signed_at, ip, recorded_by, signed_on::text, revoked_at from public.client_consents where client_id = $1 and kind = 'croa_contract' order by signed_at desc limit 1", [clientId]));
const LOCKED = 'This client has a service agreement in force, signed with the payment terms and total shown. They cannot be changed while it is in force: revoke it first, then the client signs a new one with the new figures.';

let A: TestOrg;
let manager: { id: string };
let specialist: { id: string };
beforeAll(async () => {
  A = await makeOrg('Terms');
  await saveTerms(A.orgId);
  manager = await addMember(A.orgId, 'manager');
  specialist = await addMember(A.orgId, 'specialist');
});
afterAll(closePool);

describe('LEG-9: a client’s own payment terms and total', () => {
  it('set before signing, they are what the client reads, signs and gets a copy of; the client page says which figures apply, then locks them', async () => {
    const c = await portalClient(A, 'Rosa Premium');
    // Before anything is set the client sees the agency's figures, and staff are shown them.
    asStaff(A, 'manager', manager.id);
    let page = await clientPage(c.clientId);
    expect(page).toContain('Agreement payment terms');
    expect(page).toContain('Your agency’s terms');
    expect(page).toContain('Rosa will sign the service agreement with:');
    expect(page).toContain('$594.00');
    expect(page).toContain('Set Rosa’s own payment terms');

    expect(await saveClientTermsAction(undefined, form({ clientId: c.clientId, paymentTerms: PREMIUM, total: '894.00' })))
      .toEqual({ ok: 'Saved. This client’s service agreement will state these payment terms and a total of all payments of $894.00.' });
    page = await clientPage(c.clientId);
    expect(page).toContain('Rosa’s own terms');
    expect(page).toContain(PREMIUM);
    expect(page).toContain('$894.00');
    expect(page).toContain('Use your agency’s terms instead');

    // The client's own page builds the agreement with them, under the client's own row-level security.
    const shown = await contractFor(c);
    expect(isRendered(shown)).toBe(true);
    expect((shown as RenderedConsent).text).toContain(`3. Payment\n${PREMIUM}\nTotal of all payments you will make under this agreement, to us or to any other person: $894.00.`);
    expect((shown as RenderedConsent).text).not.toContain('$594.00');

    await sign(c, ALL);
    const row = (await storedContract(c.clientId))!;
    expect(signedPayment(row.text_shown)).toEqual({ paymentTerms: PREMIUM, total: '$894.00' });
    expect(signedCopyBlocks(row, 'America/New_York', TERMS.legalName).map((b) => b.text).join('\n')).toContain('to us or to any other person: $894.00.');

    // Signed: the page shows the figures the agreement was signed with, and they are locked, by the app and the database.
    page = await clientPage(c.clientId);
    expect(page).toContain('The agreement in force, signed');
    expect(page).toContain('These cannot be changed while the agreement is in force.');
    expect(page).not.toContain('Set Rosa’s own payment terms');
    expect(await saveClientTermsAction(undefined, form({ clientId: c.clientId, paymentTerms: TERMS.paymentTerms, total: '594.00' }))).toEqual({ error: LOCKED });
    expect(await clearClientTermsAction(undefined, form({ clientId: c.clientId }))).toEqual({ error: LOCKED });
    await expect(asUser(A.ownerId, (db) => db.run('update public.clients set agreement_total_cents = 100 where id = $1', [c.clientId])))
      .rejects.toThrow('This client has a service agreement in force: its payment terms and total cannot be changed.');
    // The client can never change them, whatever their state.
    await expect(asUser(c.userId, (db) => db.run('update public.clients set agreement_payment_terms = null, agreement_total_cents = null where id = $1', [c.clientId])))
      .rejects.toThrow('portal users may not change the payment terms of their service agreement');

    // Once staff revoke the agreement, the figures can change for the next one.
    const contractId = row.id;
    asStaff(A, 'owner', A.ownerId);
    await revokeConsentAction(form({ id: contractId, clientId: c.clientId }));
    expect(await clearClientTermsAction(undefined, form({ clientId: c.clientId })))
      .toEqual({ ok: 'This client’s service agreement will use your agency’s payment terms and total (Settings → Client agreement).' });
    expect((await contractFor(c) as RenderedConsent).text).toContain('to us or to any other person: $594.00.');
    const events = await withSystem((db) => db.rows<{ summary: string }>("select summary from public.client_events where client_id = $1 and kind = 'agreement_terms' order by created_at", [c.clientId]));
    expect(events.map((e) => e.summary)).toEqual([
      'Own payment terms set for the service agreement (total of all payments $894.00)',
      'Own payment terms removed: the service agreement uses the agency’s terms',
    ]);
  });

  it('a paper agreement recorded by staff states the client’s own figures too', async () => {
    const id = await addClient(A.orgId, 'Paul Paper');
    asStaff(A, 'owner', A.ownerId);
    expect(await saveClientTermsAction(undefined, form({ clientId: id, paymentTerms: PREMIUM, total: '$1,043.00' }))).toMatchObject({ ok: expect.stringContaining('$1,043.00') });
    for (const kind of ['croa_disclosure', 'croa_contract'] as const) expect(await recordConsentAction(undefined, form({ clientId: id, kind, signedName: 'Paul Paper', paperSignedOn: today() }))).toEqual({ ok: 'Consent recorded.' });
    expect(signedPayment((await storedContract(id))!.text_shown)).toEqual({ paymentTerms: PREMIUM, total: '$1,043.00' });
  });

  it('checked as the agency’s payment terms are, set only by owners, admins and managers, and stored together or not at all', async () => {
    const id = await addClient(A.orgId, 'Check Terms');
    asStaff(A, 'manager', manager.id);
    expect(await saveClientTermsAction(undefined, form({ clientId: id, paymentTerms: 'A $50 deposit is due at enrollment, then $99 a month.', total: '644.00' })))
      .toEqual({ error: 'Payment terms: “deposit” asks for payment before the work it pays for is done. Federal law (15 U.S.C. § 1679b(b)) does not allow charging for a service before it is fully performed. Say when each payment is charged, after the work it pays for.' });
    expect(await saveClientTermsAction(undefined, form({ clientId: id, paymentTerms: 'A fee of $99 a month until your bad credit is erased.', total: '594.00' })))
      .toMatchObject({ error: expect.stringMatching(/^Payment terms: Do not promise that an item will be removed\./) });
    expect(await saveClientTermsAction(undefined, form({ clientId: id, paymentTerms: PREMIUM, total: 'about 900' })))
      .toEqual({ error: 'Total of all payments: enter the amount in dollars, for example 594.00.' });
    expect(await saveClientTermsAction(undefined, form({ clientId: id, paymentTerms: 'Monthly', total: '594.00' }))).toEqual({ error: 'Payment terms: required.' });
    expect(await withSystem((db) => db.row('select agreement_payment_terms, agreement_total_cents from public.clients where id = $1', [id]))).toEqual({ agreement_payment_terms: null, agreement_total_cents: null });
    asStaff(A, 'specialist', specialist.id);
    await expect(saveClientTermsAction(undefined, form({ clientId: id, paymentTerms: PREMIUM, total: '894.00' }))).rejects.toThrow('REDIRECT');
    expect(await clientPage(id)).toContain('An owner, admin or manager can set this client’s own payment terms before they sign.');
    await expect(withSystem((db) => db.run('update public.clients set agreement_total_cents = 89400 where id = $1', [id]))).rejects.toThrow(/clients_agreement_terms/);
  });

  it('own terms that no longer pass the checks build no agreement: staff are told why, the client that it is not ready', async () => {
    const c = await portalClient(A, 'Old Terms');
    // Saved before a check existed (written directly, as an older version could have).
    await withSystem((db) => db.run('update public.clients set agreement_payment_terms = $2, agreement_total_cents = 64400 where id = $1', [c.clientId, 'A $50 deposit is due at enrollment, then $99 a month.']));
    const a = await asUser(A.ownerId, (db) => loadClientAgreements(db, A.orgId, c.clientId));
    expect(a!.ownTermsIssue).toMatch(/^Payment terms: “deposit” asks for payment/);
    expect(isRendered(renderFor(a!, 'croa_contract'))).toBe(false);
    asStaff(A, 'owner', A.ownerId);
    expect(await clientPage(c.clientId)).toContain('These terms cannot be used');
    expect(await recordConsentAction(undefined, form({ clientId: c.clientId, kind: 'croa_disclosure', signedName: 'Old Terms', paperSignedOn: today() }))).toEqual({ ok: 'Consent recorded.' });
    expect(await recordConsentAction(undefined, form({ clientId: c.clientId, kind: 'croa_contract', signedName: 'Old Terms', paperSignedOn: today() })))
      .toEqual({ error: expect.stringMatching(/^This client’s own payment terms cannot be used in the service agreement: Payment terms: “deposit” asks for payment .* Change them on the client page \(Agreement payment terms\) first\.$/) });
    // In the portal (the client gives the E-SIGN consent; the statement is on paper) the agreement is simply not ready yet.
    await sign(c, ['esign']);
    const refusal = asUser(c.userId, (db) => signAgreement(db, c.who, { kind: 'croa_contract', signedName: 'Old Terms', shown: 'x', lang: 'en' }));
    await expect(refusal).rejects.toBeInstanceOf(AgreementError);
    await expect(refusal).rejects.toMatchObject({ code: 'client_terms' });
    asClient(A, c.userId, c.clientId);
    // The client's page is out of date: it is shown again from the records (EXP-4), saying the agreement is not ready.
    await expect(portalSignConsentAction(undefined, form({ kind: 'croa_contract', signedName: 'Old Terms', agree: 'on', shown: 'a'.repeat(64) })))
      .rejects.toMatchObject({ digest: expect.stringContaining('/portal/profile?notice=notReady#agreements') });
    expect(tr('en')('a_notReady')).toBe('This agreement is not ready to sign yet.');
  });
});

describe('LEG-9 in a personal workspace', () => {
  it('has no agreement, so no payment terms card and no own terms', async () => {
    const r = await signUp({ email: `self-${uniq()}@test.dev`, password: PASSWORD, fullName: 'Robin Self', orgName: 'Robin', mode: 'personal' }, { ip: testIp() });
    if (!r.ok) throw new Error(r.error);
    const self = (await withSystem((db) => db.row<{ id: string }>('select id from public.clients where org_id = $1', [r.orgId])))!.id;
    asStaff({ orgId: r.orgId }, 'owner', r.userId, 'personal');
    expect(await clientPage(self)).not.toContain('Agreement payment terms');
    expect(await saveClientTermsAction(undefined, form({ clientId: self, paymentTerms: PREMIUM, total: '894.00' }))).toEqual({ error: 'A personal workspace has no service agreement.' });
  });
});

describe('LEG-3, SEC-3, LEG-5, LEG-14: the agency’s terms in Settings', () => {
  const fields = { legalName: TERMS.legalName, address: TERMS.address, services: TERMS.services, paymentTerms: TERMS.paymentTerms, total: '594.00', duration: TERMS.duration, additional: '' };

  it('refuses a promise of a result and payment at signing on save; honest terms save', async () => {
    const B = await makeOrg('Save Terms');
    asStaff(B, 'owner', B.ownerId);
    expect(await saveAgreementAction(undefined, form({ ...fields, services: `${TERMS.services} We remove late payments and collections from your reports.` })))
      .toEqual({ error: 'Services: Do not promise that an item will be removed. (“remove late payments and collections”). Describe what you will do, not a result.' });
    expect(await saveAgreementAction(undefined, form({ ...fields, services: `${TERMS.services} Most clients see 5 to 10 items removed in the first round.` })))
      .toMatchObject({ error: expect.stringMatching(/^Services: Do not state how many items are removed\./) });
    expect(await saveAgreementAction(undefined, form({ ...fields, paymentTerms: 'The first month ($99) is charged today, at signing.' })))
      .toMatchObject({ error: expect.stringMatching(/^Payment terms: “today” asks for payment before the work it pays for is done\. Federal law \(15 U\.S\.C\. § 1679b\(b\)\)/) });
    // The wording the verification of LEG-5 saved, and billing at the start of a month for that month's work.
    expect(await saveAgreementAction(undefined, form({ ...fields, paymentTerms: 'Your first payment of $99 is due on the day you sign, then $99 a month.' })))
      .toMatchObject({ error: expect.stringMatching(/^Payment terms: “on the day you sign” asks for payment before the work it pays for is done\./) });
    expect(await saveAgreementAction(undefined, form({ ...fields, paymentTerms: 'We charge $99 at the beginning of each month for that month’s work.' })))
      .toMatchObject({ error: expect.stringMatching(/^Payment terms: “at the beginning of each month for that month” asks for payment/) });
    expect(await saveAgreementAction(undefined, form({ ...fields, additional: 'We cannot guarantee that any negative item will be deleted. There is no charge for paper copies.' })))
      .toMatchObject({ ok: expect.stringMatching(/^Client agreement saved/) });
    expect((await asUser(B.ownerId, (db) => loadAgency(db, B.orgId))).terms?.additional).toBe('We cannot guarantee that any negative item will be deleted. There is no charge for paper copies.');
    // How the agency deletes its own records is a data practice, not a promise of a result, and saves.
    const retention = 'When you close your account, we delete your documents within 30 days. When this agreement ends, we delete your account and your documents within 30 days of your request.';
    expect(await saveAgreementAction(undefined, form({ ...fields, paymentTerms: 'Charged at the end of each month for the work fully performed that month.', additional: retention })))
      .toMatchObject({ ok: expect.stringMatching(/^Client agreement saved/) });
    expect((await asUser(B.ownerId, (db) => loadAgency(db, B.orgId))).terms).toMatchObject({ additional: retention, paymentTerms: 'Charged at the end of each month for the work fully performed that month.' });
  });

  it('terms saved before these checks no longer build an agreement, and Settings says why instead of "not saved yet"', async () => {
    const C = await makeOrg('Stale Terms');
    await saveTerms(C.orgId, { ...TERMS, services: `${TERMS.services} We remove late payments and collections from your reports.` });
    expect((await asUser(C.ownerId, (db) => loadAgency(db, C.orgId))).terms).toBeNull();
    asStaff(C, 'owner', C.ownerId);
    const settings = await html(SettingsPage() as Promise<React.ReactElement>);
    expect(settings).toContain('Your saved terms no longer pass the checks, so no client can sign the service agreement until you change them. Services: Do not promise that an item will be removed.');
    expect(settings).not.toContain('Not saved yet');
  });

  it('the hints say what the checks do and what the address must be', async () => {
    asStaff(A, 'owner', A.ownerId);
    const settings = await html(SettingsPage() as Promise<React.ReactElement>);
    expect(settings).toContain('The street address of your main place of business, through state and ZIP.');
    expect(settings).toContain('A PO Box is accepted, but some states expect a physical address: have your attorney confirm your state’s rules.');
    expect(settings).not.toContain('Street or PO Box');
    expect(settings).toContain('The check is a list of rules, not a legal review');
    expect(settings).toContain('removing or deleting items on a credit report');
    expect(settings).not.toContain('no promise of removals or a score change can be saved');
    expect(settings).toContain('a fee at signing or on the day you sign, within days of signing or of the effective date, today, up front or in advance, before the work starts, at the start of a month for that month’s work, a deposit or a setup or enrollment fee is refused');
    expect(settings).toContain('A client on another plan can have their own payment terms and total, set on their client page before they sign.');
  });
});

describe('LEG-13: a signed copy whose name the PDF cannot print says so', () => {
  it('the copy from the PDF route carries the note and labels the fingerprint as that of the stored text', async () => {
    const D = await makeOrg(`Copy ${uniq()}`);
    await saveTerms(D.orgId);
    const c = await portalClient(D, 'Nguyễn Thị Hương');
    await sign(c, ['esign', 'croa_disclosure', 'croa_contract']);
    const row = (await storedContract(c.clientId))!;
    expect(row.text_shown).toContain('and Nguyễn Thị Hương (“you”)');
    asClient(D, c.userId, c.clientId);
    const res = await consentPdf(new Request('http://x/api/consents/x/pdf'), { params: Promise.resolve({ id: row.id }) });
    expect(res.status).toBe(200);
    const pdf = Buffer.from(await res.arrayBuffer()).toString('latin1');
    expect(pdf).toContain('(Some characters in this document could not be printed in this PDF and appear');
    expect(pdf).toContain('Nguy?n Th? H??ng');
    expect(pdf).toContain('(Fingerprint of the stored text \\(SHA-256\\):');
    expect(pdf).not.toContain('text above \\(SHA-256\\)');
  });
});
