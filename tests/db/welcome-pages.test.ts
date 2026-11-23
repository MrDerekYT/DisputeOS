import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Ctx } from '@/lib/auth/context';
import type { SessionInfo } from '@/lib/auth/service';
import { acceptInvite, createInviteToken } from '@/lib/auth/service';
import { loadClientAgreements, renderFor, signAgreement, type Signer } from '@/lib/agreements';
import { storedTerms, type AgreementTerms } from '@/lib/compliance/agreement-terms';
import { CROA_CANCEL_STATEMENT } from '@/lib/compliance/croa';
import type { ConsentKind, RenderedConsent } from '@/lib/compliance/disclosures';
import { can, type Role } from '@/lib/rbac';
import { addClient, addMember, asUser, closePool, makeOrg, PASSWORD, testIp, uniq, withSystem, type TestOrg } from './helpers';

/**
 * The new pages, rendered as the server renders them, with the real queries under row-level security: the invitation
 * page, each welcome step, the staff "Welcome link" card and Settings → Client agreement. Only the sign-in is stood in for.
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
vi.mock('next/navigation', async (original) => ({ ...(await original<typeof import('next/navigation')>()), redirect: (to: string) => { throw new Error(`REDIRECT ${to}`); } }));
vi.stubGlobal('React', React);

import InvitePage from '@/app/invite/[token]/page';
import WelcomePage from '@/app/portal/welcome/page';
import { WelcomeBlock } from '@/app/app/clients/[id]/welcome-block';
import { AgreementSection } from '@/app/app/settings/agreement';

const TERMS: AgreementTerms = {
  legalName: 'Bright Path Credit LLC', address: '500 Bayshore Blvd, Suite 210, Tampa, FL 33606',
  services: 'We review your three credit reports with you, prepare dispute letters for the items you choose, track each investigation and report every response to you in your portal.',
  paymentTerms: 'A monthly fee of $99.00, charged on the 1st of each month for the work fully performed in the month before.',
  totalCents: 59_400, duration: 'About 6 months from the date you sign.', additional: '', updatedAt: '2026-11-20T15:00:00.000Z', updatedBy: 'test',
};
let A: TestOrg;
let B: TestOrg;
const slug = async (orgId: string) => (await withSystem((db) => db.row<{ slug: string }>('select slug from public.organizations where id = $1', [orgId])))!.slug;
/** A client's invitation is made for the client's own email (src/lib/welcome-link.ts). */
const emailOf = async (clientId: string) => (await withSystem((db) => db.row<{ email: string }>('select email from public.clients where id = $1', [clientId])))!.email;

function asStaff(o: TestOrg, role: Role = 'owner'): Ctx {
  const session: SessionInfo = { sessionId: 's', userId: o.ownerId, orgId: o.orgId, role, email: o.ownerEmail, fullName: 'Owner', mfaVerified: true, totpEnabled: false, orgName: 'Bright Path', orgSlug: 'bright', orgMode: 'agency', orgPlan: 'trial' };
  const ctx: Ctx = { session, userId: o.ownerId, orgId: o.orgId, role, tx: (fn) => asUser(o.ownerId, fn), can: (p) => can(role, p), need: () => undefined, meta: { ip: '10.0.0.1', userAgent: 'vitest' } };
  signedIn.ctx = ctx;
  return ctx;
}
function asClient(o: TestOrg, userId: string, clientId: string) {
  const session: SessionInfo = { sessionId: 's', userId, orgId: o.orgId, role: 'client', email: 'c@x.test', fullName: 'Dana', mfaVerified: true, totpEnabled: false, orgName: 'Bright Path', orgSlug: 'bright', orgMode: 'agency', orgPlan: 'trial' };
  signedIn.ctx = { session, userId, orgId: o.orgId, role: 'client', tx: (fn: never) => asUser(userId, fn), can: () => false, need: () => undefined, meta: { ip: '10.0.0.2', userAgent: 'vitest' }, clientId };
}
async function portalClient(o: TestOrg, identity: boolean, lang: 'en' | 'es' = 'en') {
  const user = await addMember(o.orgId, 'client', 'portal');
  const clientId = await addClient(o.orgId, 'Dana Whitfield', { portalUserId: user.id, identity });
  await withSystem((db) => db.run(`update public.clients set preferred_language = $2, address = '{"line1":"9 Elm St","city":"Dayton","state":"OH","zip":"45402"}' where id = $1`, [clientId, lang]));
  const who: Signer = { orgId: o.orgId, clientId, userId: user.id, ip: '10.0.0.2', userAgent: 'vitest', by: 'client' };
  return { userId: user.id, clientId, who };
}
async function sign(o: TestOrg, c: Awaited<ReturnType<typeof portalClient>>, kinds: ConsentKind[]) {
  for (const kind of kinds) {
    const a = await asUser(c.userId, (db) => loadClientAgreements(db, o.orgId, c.clientId));
    const r = renderFor(a!, kind) as RenderedConsent;
    await asUser(c.userId, (db) => signAgreement(db, c.who, { kind, signedName: 'Dana Whitfield', shown: r.sha256, lang: 'en' }));
  }
}
const welcome = async (q: Record<string, string> = {}) => renderToStaticMarkup(await WelcomePage({ searchParams: Promise.resolve(q) }) as React.ReactElement);
const invite = async (token: string, q: Record<string, string> = {}) => renderToStaticMarkup(await InvitePage({ params: Promise.resolve({ token }), searchParams: Promise.resolve(q) }) as React.ReactElement);

beforeAll(async () => {
  A = await makeOrg('Pages');
  B = await makeOrg('PagesNoTerms');
  await withSystem((db) => db.run("update public.organizations set settings = settings || jsonb_build_object('agreement', $2::jsonb) where id = $1", [A.orgId, JSON.stringify(storedTerms(TERMS))]));
});
afterAll(closePool);

describe('the invitation page', () => {
  it('greets the client by name, lists the four steps and the time it takes, asks for the password twice, and switches language', async () => {
    const c = await addClient(A.orgId, 'Lee Moreno', { status: 'lead' });
    const email = await emailOf(c);
    const token = await asUser(A.ownerId, (db) => createInviteToken(db, { orgId: A.orgId, email, role: 'client', clientId: c, invitedBy: A.ownerId }));
    const en = await invite(token);
    for (const s of ['Welcome, Lee!', 'has invited you to your secure client portal.', 'Your details', 'Your agreements', 'Your ID documents', 'about 10 minutes', 'photo ID and a recent bill', 'Confirm password', `/invite/${token}?lang=es`]) expect(en, s).toContain(s);
    const es = await invite(token, { lang: 'es' });
    for (const s of ['¡Le damos la bienvenida, Lee!', 'Confirme la contraseña', 'Sus documentos de identidad', 'name="lang" value="es"']) expect(es, s).toContain(s);
  });

  it('a used link gets a kind message in the client’s language and the agency’s own sign-in; a link never issued says nothing about anyone', async () => {
    const c = await addClient(A.orgId, 'Ana Ruiz', { status: 'lead' });
    await withSystem((db) => db.run("update public.clients set preferred_language = 'es' where id = $1", [c]));
    const email = await emailOf(c);
    const token = await asUser(A.ownerId, (db) => createInviteToken(db, { orgId: A.orgId, email, role: 'client', clientId: c, invitedBy: A.ownerId }));
    expect((await acceptInvite(token, { fullName: 'Ana Ruiz', password: PASSWORD }, { ip: testIp() })).ok).toBe(true);
    const used = await invite(token);
    expect(used).toContain('Este enlace ya no se puede usar');
    expect(used).toContain(`/portal/login?org=${await slug(A.orgId)}&amp;lang=es`);
    expect(used).not.toContain('href="/login"');
    const bad = await invite(`not-a-real-link-${uniq()}-${uniq()}`);
    expect(bad).toContain('This link doesn’t work');
    expect(bad).toContain('href="/portal/login"');
  });
});

describe('the welcome steps', () => {
  it('details: name and email read-only, date of birth and SSN asked once and never shown back', async () => {
    const c = await portalClient(A, false);
    asClient(A, c.userId, c.clientId);
    const html = await welcome();
    for (const s of ['Welcome, Dana', 'Your details', 'Not right? Tell us', 'name="dob"', 'name="ssn"', 'readOnly=""', 'Save and continue']) expect(html, s).toContain(s);
    await withSystem((db) => db.run("update public.clients set dob_encrypted = 'v1.x', ssn_last4 = '4321', ssn_encrypted = 'v1.y' where id = $1", [c.clientId]));
    const later = await welcome({ step: 'details' });
    expect(later).not.toContain('name="ssn"');
    expect(later).not.toContain('4321');
    expect(later.match(/On file/g)).toHaveLength(2);
  });

  it('agreements: one at a time in order, the full text shown, its hash in the form; the E-SIGN consent asks to open the PDF first', async () => {
    const c = await portalClient(A, true);
    asClient(A, c.userId, c.clientId);
    const html = await welcome();
    const a = await asUser(c.userId, (db) => loadClientAgreements(db, A.orgId, c.clientId));
    const esign = renderFor(a!, 'esign') as RenderedConsent;
    for (const s of ['Document 1 of 4', 'Consent to electronic records and signatures', 'Paper copies are free', `name="shown" value="${esign.sha256}"`, 'href="/api/consents/preview/esign"', 'I can read this page, and I opened the PDF copy', 'name="from" value="welcome"']) expect(html, s).toContain(s);
    expect(html).not.toContain('<details'); // never folded away
  });

  it('the contract: the bold statement right above the signature, the Notice of Cancellation attached below it', async () => {
    const c = await portalClient(A, true);
    await sign(A, c, ['esign', 'croa_disclosure']);
    asClient(A, c.userId, c.clientId);
    const html = await welcome({ step: 'agreements' });
    expect(html).toContain('Document 3 of 4');
    const statement = html.indexOf(`<p class="whitespace-pre-wrap [overflow-wrap:anywhere] font-bold">${CROA_CANCEL_STATEMENT}</p>`);
    const form = html.indexOf('<form', statement);
    const notice = html.indexOf('>Notice of Cancellation</p>');
    expect(statement).toBeGreaterThan(0);
    expect(form).toBeGreaterThan(statement);
    expect(notice).toBeGreaterThan(form);
    expect(html).toContain('to Bright Path Credit LLC at 500 Bayshore Blvd, Suite 210, Tampa, FL 33606 before midnight on');
  });

  it('a Spanish client is told the agreement is in English and invited to ask before signing; the agreement itself stays English', async () => {
    const c = await portalClient(A, true, 'es');
    asClient(A, c.userId, c.clientId);
    const html = await welcome({ step: 'agreements' });
    expect(html).toContain('El texto del acuerdo está en inglés. Si necesita ayuda para entenderlo, escriba a su especialista antes de firmar.');
    expect(html).toContain('<div lang="en">');
    expect(html).toContain('Paper copies are free');
  });

  it('while the agency has saved no terms, the client is told it is finishing its agreement and can go on to the documents', async () => {
    const c = await portalClient(B, true);
    await sign(B, c, ['esign', 'croa_disclosure']);
    asClient(B, c.userId, c.clientId);
    const html = await welcome({ step: 'agreements' });
    expect(html).toContain('is still finishing its service agreement, so it cannot be signed yet.');
    expect(html).toContain('Meanwhile you can upload your ID documents.');
    expect(html).not.toContain('let you know'); // no promise of a message the app does not send
    expect(html).toContain('href="/portal/welcome?step=documents"');
    expect(html).not.toContain('name="shown"');
  });

  it('documents: one upload per required item that comes back to the welcome, and “I’ll do this later”', async () => {
    const c = await portalClient(A, true);
    await sign(A, c, ['esign', 'croa_disclosure', 'croa_contract', 'fcra_authorization']);
    asClient(A, c.userId, c.clientId);
    const html = await welcome();
    expect(html.match(/name="returnTo" value="welcome"/g)).toHaveLength(3);
    for (const k of ['id', 'proof_of_address', 'ssn_proof']) expect(html).toContain(`name="kind" value="${k}"`);
    expect(html).toContain('I’ll do this later');
    expect(html).toContain('href="/portal/welcome?step=done"');
  });

  it('done: welcome to the family, the last day before anything goes to the bureaus, copies, and cancelling while the period runs', async () => {
    const c = await portalClient(A, true);
    await sign(A, c, ['esign', 'croa_disclosure', 'croa_contract', 'fcra_authorization']);
    asClient(A, c.userId, c.clientId);
    const html = await welcome({ step: 'done' });
    for (const s of ['Welcome to the family, Dana!', 'You can cancel your service agreement until midnight at the end of', 'We won’t send anything to the credit bureaus before then.', 'Copies of what you signed', 'Cancel my agreement', 'I want to cancel my service agreement']) expect(html, s).toContain(s);
    expect(html.match(/href="\/api\/consents\/[0-9a-f-]{36}\/pdf"/g)).toHaveLength(4);
    // After the period, only a message to the specialist. The days stored with the agreement move back with it: the last
    // day fixed at signing is never shortened by a recount, so moving only signed_at would keep the period open.
    await withSystem((db) => db.run("update public.client_consents set signed_at = now() - interval '10 days', signed_on = signed_on - 10, cancellation_ends_on = cancellation_ends_on - 10 where client_id = $1", [c.clientId]));
    const after = await welcome({ step: 'done' });
    expect(after).not.toContain('I want to cancel my service agreement');
    expect(after).toContain('The cancellation period ended on');
  });
});

describe('the staff side', () => {
  it('the Welcome link card: no email, not invited, a link made, then progress once the client joined', async () => {
    const ctx = asStaff(A);
    const card = async (clientId: string) => {
      const c = (await withSystem((db) => db.row<{ email: string | null; portal_user_id: string | null }>('select email, portal_user_id from public.clients where id = $1', [clientId])))!;
      return renderToStaticMarkup(await WelcomeBlock({ ctx, clientId, first: 'Dana', email: c.email, portalUserId: c.portal_user_id }));
    };
    const noEmail = await addClient(A.orgId, 'No Email');
    await withSystem((db) => db.run('update public.clients set email = null where id = $1', [noEmail]));
    expect(await card(noEmail)).toContain('Add the client’s email first');
    const lead = await addClient(A.orgId, 'Lead Person', { status: 'lead' });
    const fresh = await card(lead);
    expect(fresh).toContain('Not invited yet.');
    expect(fresh).toContain('Copy welcome link');
    expect(fresh).not.toContain('Email welcome link'); // email does not deliver in tests (log driver)
    expect(fresh).not.toContain('Service agreement not ready'); // this agency saved its terms
    const joined = await portalClient(A, true);
    await sign(A, joined, ['esign']);
    const progress = await card(joined.clientId);
    for (const s of ['Joined', 'Details done', 'Agreements: 1 of 4', 'ID documents: 0 of 3']) expect(progress, s).toContain(s);
    // Without saved terms, staff see why the client cannot sign the agreement.
    const ctxB = asStaff(B);
    const other = await addClient(B.orgId, 'Other Client', { status: 'lead' });
    expect(renderToStaticMarkup(await WelcomeBlock({ ctx: ctxB, clientId: other, first: 'Other', email: 'o@x.test', portalUserId: null }))).toContain('cannot sign the service agreement until your client agreement terms are saved');
  });

  it('Settings → Client agreement: says when nothing is saved, and once saved shows the agreement as a client sees it', async () => {
    const none = renderToStaticMarkup(await AgreementSection({ ctx: asStaff(B) }));
    expect(none).toContain('Not saved yet: no client can sign the service agreement');
    expect(none).toContain('A starting point, not legal advice');
    const saved = renderToStaticMarkup(await AgreementSection({ ctx: asStaff(A) }));
    expect(saved).toContain('Clients can sign the service agreement.');
    expect(saved).toContain(`font-bold">${CROA_CANCEL_STATEMENT}</p>`);
    expect(saved).toContain('Sample Client');
    expect(saved).toContain('value="594.00"');
  });
});
