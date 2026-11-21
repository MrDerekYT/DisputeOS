import * as React from 'react';
import { prerenderToNodeStream } from 'react-dom/static';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Ctx } from '@/lib/auth/context';
import { acceptInvite, createInviteToken, getInvite, type SessionInfo } from '@/lib/auth/service';
import { loadClientAgreements, renderFor, signAgreement, type Signer } from '@/lib/agreements';
import { sayDay } from '@/lib/business-days';
import { storedTerms, type AgreementTerms } from '@/lib/compliance/agreement-terms';
import { isRendered, type ConsentKind, type RenderedConsent } from '@/lib/compliance/disclosures';
import { resetEnvCache } from '@/lib/env';
import { portalMessage } from '@/lib/portal-i18n';
import { can, type Role } from '@/lib/rbac';
import { dayInZone } from '@/lib/util';
import { issueWelcomeLink, welcomeClient } from '@/lib/welcome-link';
import { addClient, addDispute, addMember, approveOutreach, asUser, closePool, makeOrg, PASSWORD, testIp, uniq, withSystem, type TestOrg } from './helpers';

/**
 * The client's screens and the welcome link after the review (fixer 2), through the real pages, actions and services
 * under row-level security; only the sign-in is stood in for. LEG-10/EXP-3 (after "Cancel my agreement"), LEG-6/EXP-2
 * (existing clients), EXP-4 (a text that changed while it was open), EXP-5 (before the agency saves its terms), EXP-7
 * (the welcome email's log), EXP-9 (an email with a portal at another agency) and SEC-1 (an invitation is good only for
 * the client's email as it is now).
 */
const signedIn = vi.hoisted(() => ({ ctx: null as unknown, revalidated: [] as string[] }));
vi.mock('@/lib/auth/context', () => ({
  requireStaff: async (perm?: string) => {
    const ctx = signedIn.ctx as { can(p: string): boolean };
    if (perm && !ctx.can(perm)) throw new Error('REDIRECT /app?denied=1');
    return ctx;
  },
  requireClient: async () => signedIn.ctx,
}));
vi.mock('next/cache', () => ({ revalidatePath: (p: string) => { signedIn.revalidated.push(p); } }));
vi.stubGlobal('React', React);

import PortalHome from '@/app/portal/(app)/page';
import PortalProfile from '@/app/portal/(app)/profile/page';
import WelcomePage from '@/app/portal/welcome/page';
import InvitePage from '@/app/invite/[token]/page';
import { WelcomeBlock } from '@/app/app/clients/[id]/welcome-block';
import { emailWelcomeLinkAction } from '@/app/app/clients/welcome-actions';
import { portalCancelAgreementAction, portalSignConsentAction } from '@/app/portal/actions';
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
const ALL: ConsentKind[] = ['esign', 'croa_disclosure', 'croa_contract', 'fcra_authorization'];
const form = (fields: Record<string, string>) => { const fd = new FormData(); for (const [k, v] of Object.entries(fields)) fd.set(k, v); return fd; };
const orgName = async (orgId: string) => (await withSystem((db) => db.row<{ name: string }>('select name from public.organizations where id = $1', [orgId])))!.name;

/** Renders a page as the server does, nested async components included. */
async function html(el: React.ReactElement | Promise<React.ReactElement>): Promise<string> {
  const { prelude } = await prerenderToNodeStream(await el);
  let s = '';
  for await (const chunk of prelude) s += chunk;
  return s.replace(/<!-- -->/g, ''); // React's separators between adjacent pieces of text
}
const home = () => html(PortalHome() as Promise<React.ReactElement>);
const welcome = (q: Record<string, string> = {}) => html(WelcomePage({ searchParams: Promise.resolve(q) }) as Promise<React.ReactElement>);
const profile = (q: Record<string, string> = {}) => html(PortalProfile({ searchParams: Promise.resolve(q) }) as Promise<React.ReactElement>);
const invitePage = (token: string) => html(InvitePage({ params: Promise.resolve({ token }), searchParams: Promise.resolve({}) }) as Promise<React.ReactElement>);
/** Where a server action redirected to (the real next/navigation redirect), or null when it returned instead. */
async function redirectsTo(p: Promise<unknown>): Promise<string | null> {
  try { await p; } catch (e) {
    const digest = (e as { digest?: string }).digest;
    if (digest?.startsWith('NEXT_REDIRECT;')) return digest.split(';')[2] ?? null;
    throw e;
  }
  return null;
}

function asStaff(o: TestOrg, role: Role = 'owner'): Ctx {
  const session: SessionInfo = { sessionId: 's', userId: o.ownerId, orgId: o.orgId, role, email: o.ownerEmail, fullName: 'Owner', mfaVerified: true, totpEnabled: false, orgName: 'Bright Path', orgSlug: 'bright', orgMode: 'agency', orgPlan: 'trial' };
  const ctx: Ctx = { session, userId: o.ownerId, orgId: o.orgId, role, tx: (fn) => asUser(o.ownerId, fn), can: (p) => can(role, p), need: () => undefined, meta: { ip: '10.0.0.1', userAgent: 'vitest' } };
  signedIn.ctx = ctx;
  return ctx;
}
const card = async (o: TestOrg, clientId: string) => {
  const ctx = asStaff(o);
  const c = (await withSystem((db) => db.row<{ email: string | null; portal_user_id: string | null; full_name: string }>('select email, portal_user_id, full_name from public.clients where id = $1', [clientId])))!;
  return html(WelcomeBlock({ ctx, clientId, first: c.full_name.split(' ')[0]!, email: c.email, portalUserId: c.portal_user_id }));
};

interface PortalClient { userId: string; clientId: string; who: Signer; name: string; org: TestOrg }
/** A portal client with their details on file (address, date of birth, SSN), in `lang`. */
async function portalClient(org: TestOrg, name: string, lang: 'en' | 'es' = 'en'): Promise<PortalClient> {
  const user = await addMember(org.orgId, 'client', 'portal');
  const clientId = await addClient(org.orgId, name, { portalUserId: user.id });
  await withSystem((db) => db.run(`update public.clients set preferred_language = $2, assigned_to = $3, address = '{"line1":"9 Elm St","city":"Dayton","state":"OH","zip":"45402"}' where id = $1`, [clientId, lang, org.ownerId]));
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
/** The three identity documents, uploaded (waiting for review unless `status` says otherwise). */
const idDocs = (c: PortalClient, status = 'pending_review') => withSystem(async (db) => {
  for (const kind of ['id', 'proof_of_address', 'ssn_proof'])
    await db.run(`insert into public.documents (org_id, client_id, kind, file_name, mime_type, size_bytes, sha256, storage_key, source, review_status)
                  values ($1, $2, $3, $4, 'image/png', 10, 'x', 'none', 'staff', $5)`, [c.org.orgId, c.clientId, kind, `${kind}.png`, status]);
});
/** A dispute with a bureau, answer due in 20 days. */
async function underInvestigation(c: PortalClient) {
  const id = await addDispute(c.org.orgId, c.clientId, 'under_investigation');
  await withSystem((db) => db.run("update public.disputes set submitted_at = now() - interval '10 days', due_at = now() + interval '20 days' where id = $1", [id]));
}
const contractId = (clientId: string) => withSystem((db) => db.row<{ id: string }>("select id from public.client_consents where client_id = $1 and kind = 'croa_contract' order by signed_at desc limit 1", [clientId])).then((r) => r!.id);

let A: TestOrg;
beforeAll(async () => {
  A = await makeOrg('PortalFix');
  await saveTerms(A.orgId);
});
afterAll(closePool);

describe('LEG-10 / EXP-3: after "Cancel my agreement"', () => {
  it('the client is taken to a lasting cancelled state, never asked to sign again as a next step; signing a new one stays possible', async () => {
    const c = await portalClient(A, 'Lee Cancel');
    await sign(c, ALL);
    asClient(c);
    expect(await welcome({ step: 'done' })).toContain('I want to cancel my service agreement');
    signedIn.revalidated = [];
    expect(await redirectsTo(portalCancelAgreementAction(undefined, form({ signedName: 'Lee Cancel', confirm: 'on' })))).toBe('/portal');
    expect(signedIn.revalidated).toContain('/portal');
    const day = dayInZone(NY);
    const copy = `href="/api/consents/${await contractId(c.clientId)}/pdf"`;

    const h = await home();
    for (const s of ['Agreement cancelled', 'Your service agreement is cancelled', `You cancelled your service agreement on ${portalLongDay(day, 'en')}. Your notice was sent to Bright Path Credit LLC.`, 'Copy of the cancelled agreement', copy, 'Nothing needed right now'])
      expect(h, s).toContain(s);
    for (const s of ['Review and sign', 'We can’t start work', 'href="/portal/welcome?step=agreements"', 'Finish setting up your file']) expect(h, s).not.toContain(s);

    // The welcome page, opened plainly or at "Done", shows the same state; the agreements step, asked for by name, lets
    // the client sign a new agreement, saying so.
    for (const q of [{}, { step: 'done' }] as Record<string, string>[]) {
      const w = await welcome(q);
      expect(w).toContain('Your service agreement is cancelled');
      expect(w).toContain(copy);
      expect(w).not.toContain('name="shown"');
    }
    const again = await welcome({ step: 'agreements' });
    expect(again).toContain('If you want Bright Path Credit LLC to work for you again, you can read and sign a new service agreement below.');
    expect(again).toContain('Document 3 of 4');

    const p = await profile();
    for (const s of ['Your service agreement is cancelled', `Cancelled ${portalLongDay(day, 'en')}`, 'Sign a new service agreement', copy]) expect(p, s).toContain(s);
    expect(p).not.toContain('Finish setting up your file');

    // Staff see it on the Welcome link card too.
    expect(await card(A, c.clientId)).toContain(`Lee cancelled the service agreement in the portal on ${sayDay(day)}.`);

    // Signing a new agreement ends the cancelled state.
    asClient(c);
    await sign(c, ['croa_contract']);
    const after = await home();
    expect(after).not.toContain('Your service agreement is cancelled');
  });

  it('in Spanish', async () => {
    const c = await portalClient(A, 'Ana Cancela', 'es');
    await sign(c, ALL);
    asClient(c);
    expect(await redirectsTo(portalCancelAgreementAction(undefined, form({ signedName: 'Ana Cancela', confirm: 'on' })))).toBe('/portal');
    const h = await home();
    for (const s of ['Contrato cancelado', 'Su contrato de servicios está cancelado', `Usted canceló su contrato de servicios el ${portalLongDay(dayInZone(NY), 'es')}. Su aviso se envió a Bright Path Credit LLC.`, 'Copia del contrato cancelado'])
      expect(h, s).toContain(s);
    // A refusal still comes back as an error, in Spanish, without leaving the page.
    const d = await portalClient(A, 'Ana Firma', 'es');
    await sign(d, ALL);
    asClient(d);
    expect(await portalCancelAgreementAction(undefined, form({ signedName: 'Otra Persona', confirm: 'on' }))).toEqual({ error: 'Escriba su nombre legal completo tal como aparece en su cuenta.' });
  });
});

describe('LEG-6 / EXP-2: clients whose work is under way', () => {
  /** A client from before migration 0031: the 2026-01 statement, agreement and authorization, 60 days ago. */
  async function draftClient(name: string) {
    const c = await portalClient(A, name);
    await withSystem(async (db) => {
      for (const kind of ['croa_disclosure', 'croa_contract', 'fcra_authorization'])
        await db.run("insert into public.client_consents (org_id, client_id, kind, version, signed_name, signed_at) values ($1, $2, $3, '2026-01-draft:abcdef012345', $4, now() - interval '60 days')", [A.orgId, c.clientId, kind, name]);
    });
    await idDocs(c, 'accepted');
    return c;
  }

  it('an investigation keeps the hero; what is asked is listed below it, never as "we can’t start work"', async () => {
    const c = await draftClient('Rita Draft');
    await underInvestigation(c);
    asClient(c);
    const h = await home();
    expect(h).toContain('The investigation is under way');
    expect(h).toContain('Consent to electronic records and signatures');
    expect(h).not.toContain('We can’t start work');
    expect(h).not.toContain('Review and sign your agreement');
  });

  it('without one, the E-SIGN consent and then the current statement are asked gently; the old statement is not shown as signed', async () => {
    const c = await draftClient('Rosa Draft');
    asClient(c);
    let h = await home();
    expect(h).toContain('Please confirm how we send you documents');
    expect(h).toContain('This does not pause the work on your file.');
    expect(h).not.toContain('We can’t start work');
    await sign(c, ['esign']);
    h = await home();
    expect(h).toContain('Please read the current statement of your rights');
    expect(h).not.toContain('We can’t start work');
    // The welcome page asks for the current statement: in its list the old one is not ticked, and Profile says it was an earlier version.
    const w = await welcome();
    expect(w).toContain('Document 2 of 4');
    expect(w).toMatch(/>2<\/span><span class="min-w-0 flex-1"><span class="font-semibold">Consumer Credit File Rights Under State and Federal Law<\/span>/);
    const p = await profile();
    expect(p).toContain('Earlier version signed');
    await sign(c, ['croa_disclosure']);
    h = await home();
    expect(h).not.toContain('Please read the current statement of your rights');
    expect(h).toContain('Nothing needed right now');
  });

  it('once staff revoke the old agreement, the client is asked for the current statement and then the agreement, as needed', async () => {
    const c = await draftClient('Remy Draft');
    await withSystem((db) => db.run("update public.client_consents set revoked_at = now(), revoked_reason = 'staff' where client_id = $1 and kind = 'croa_contract'", [c.clientId]));
    asClient(c);
    await sign(c, ['esign']);
    const h = await home();
    expect(h).toContain('Review and sign your agreement');
    expect(h).toContain('We can’t start work until your agreements are signed.');
    expect(await welcome()).toContain('Document 2 of 4');
    await sign(c, ['croa_disclosure', 'croa_contract']);
    expect(await home()).toContain('Nothing needed right now');
  });

  it('a consent to electronic records the client withdrew is not asked for again while the service goes on', async () => {
    const c = await portalClient(A, 'Wes Withdraw');
    await sign(c, ALL);
    await idDocs(c, 'accepted');
    await withSystem((db) => db.run("update public.client_consents set revoked_at = now(), revoked_reason = 'staff' where client_id = $1 and kind = 'esign'", [c.clientId]));
    asClient(c);
    const h = await home();
    expect(h).not.toContain('Please confirm how we send you documents');
    expect(h).toContain('Nothing needed right now');
    expect(await profile()).toContain('Withdrawn');
  });
});

describe('EXP-4: an agreement that changed while it was open', () => {
  it('the page is shown again with the new text, its hash and a note; the new text signs', async () => {
    const S = await makeOrg('Stale');
    await saveTerms(S.orgId);
    const c = await portalClient(S, 'Sam Stale');
    await sign(c, ['esign', 'croa_disclosure']);
    asClient(c);
    const hashOf = (page: string) => /name="shown" value="([0-9a-f]{64})"/.exec(page)![1]!;
    const opened = hashOf(await welcome({ step: 'agreements' }));
    await saveTerms(S.orgId, { ...TERMS, duration: 'About 4 months from the date you sign.' });
    const post = (shown: string, from = 'welcome', signedName = 'Sam Stale') => portalSignConsentAction(undefined, form({ kind: 'croa_contract', signedName, agree: 'on', shown, from }));
    signedIn.revalidated = [];
    expect(await redirectsTo(post(opened))).toBe('/portal/welcome?step=agreements&notice=changed');
    expect(signedIn.revalidated).toContain('/portal');
    const again = await welcome({ step: 'agreements', notice: 'changed' });
    expect(again).toContain('The text below was updated since you opened it. Please read it again before you sign.');
    expect(again).toContain('About 4 months from the date you sign.');
    const fresh = hashOf(again);
    expect(fresh).not.toBe(opened);
    // A wrong name is still an error on the same page.
    expect(await post(fresh, 'welcome', 'Someone Else')).toEqual({ error: 'Please type your full legal name as it appears on your account.' });
    expect(await redirectsTo(post(fresh))).toMatch(/^\/portal\/welcome\?step=agreements&signed=[0-9a-f-]{36}$/);
    // Signed meanwhile in another tab: the page moves on, saying so. From Profile, the same, on Profile.
    expect(await redirectsTo(post(fresh))).toBe('/portal/welcome?step=agreements&notice=already');
    expect(await welcome({ step: 'agreements', notice: 'already' })).toContain('You have already signed this.');
    expect(await redirectsTo(post(fresh, 'profile'))).toBe('/portal/profile?notice=already#agreements');
    expect(await profile({ notice: 'changed' })).toContain('The text below was updated since you opened it.');
    // Only known notices are shown (not even what every object has, such as "constructor").
    for (const notice of ['constructor', '__proto__', 'toString', '<b>x</b>']) {
      expect(await welcome({ step: 'agreements', notice }), notice).not.toContain('bg-warn-soft" role="note"');
      expect(await profile({ notice }), notice).not.toContain('bg-warn-soft" role="note"');
    }
  });
});

describe('EXP-5: before the agency saves its terms', () => {
  it('no loop: the client does what they can, then waits for the agency, which the portal says is the agency’s to do', async () => {
    const N = await makeOrg('NoTermsYet');
    const name = await orgName(N.orgId);
    const c = await portalClient(N, 'Ada Wait');
    await sign(c, ['esign', 'croa_disclosure']);
    asClient(c);
    const ag = await welcome({ step: 'agreements' });
    expect(ag).toContain(`${name} is still finishing its service agreement, so it cannot be signed yet.`);
    expect(ag).toContain('Meanwhile you can upload your ID documents.');
    expect(ag).toContain('href="/portal/welcome?step=documents"');
    expect(await welcome()).toContain('id="documents-title"'); // opens at what the client can do now
    let h = await home();
    expect(h).toContain('Upload your identity documents');
    expect(h).toContain(`Being prepared by ${name}`);
    expect(h).not.toContain('Review and sign');
    expect(h).not.toContain('href="/portal/welcome?step=agreements"');

    await idDocs(c);
    const docs = await welcome({ step: 'documents' });
    expect(docs).toContain('<a class="btn-primary btn-lg" href="/portal">Go to your portal');
    expect(docs).not.toContain('btn-primary btn-lg" href="/portal/welcome?step=done"');
    const waiting = await welcome({ step: 'agreements' });
    expect(waiting).not.toContain('Next: your ID documents');
    expect(waiting).toContain('href="/portal"');
    h = await home();
    for (const s of ['Your service agreement is being prepared', 'On our side', `${name} is still finishing its service agreement.`]) expect(h, s).toContain(s);
    expect(h).not.toContain('Review and sign');
    const p = await profile();
    expect(p).toContain(`Being prepared by ${name}`);
    expect(p).not.toContain('Finish setting up your file');

    // Terms saved: the agreement is the client's to sign.
    await saveTerms(N.orgId);
    h = await home();
    expect(h).toContain('Review and sign your agreement');
    expect(h).toContain('href="/portal/welcome?step=agreements"');
  });
});

describe('EXP-7: the welcome email’s log', () => {
  it('"emailed" only once the email service took it; a refused email ends its link and says so; no double full stop', async () => {
    const saved = { ...process.env };
    Object.assign(process.env, { EMAIL_DRIVER: 'resend', RESEND_API_KEY: 're_test_key_for_vitest' });
    resetEnvCache();
    let answer: { status: number; body: string } = { status: 422, body: JSON.stringify({ message: 'The to address is invalid.' }) };
    vi.stubGlobal('fetch', async (url: string | URL) => {
      if (String(url) !== 'https://api.resend.com/emails') throw new Error(`unexpected request to ${String(url)}`);
      return new Response(answer.body, { status: answer.status });
    });
    try {
      const M = await makeOrg('Mailer');
      await approveOutreach(M.orgId);
      const clientId = await addClient(M.orgId, 'Mia Mail', { status: 'lead' });
      const email = (await withSystem((db) => db.row<{ email: string }>('select email from public.clients where id = $1', [clientId])))!.email;
      const events = () => withSystem((db) => db.rows<{ kind: string; summary: string; meta: Record<string, unknown> }>("select kind, summary, meta from public.client_events where client_id = $1 and kind like 'portal_%' order by created_at", [clientId]));
      const audits = () => withSystem((db) => db.rows<{ action: string; metadata: Record<string, unknown> }>("select action, metadata from public.audit_logs where entity_id = $1 and action like 'client.welcome_link%' order by id", [clientId]));
      asStaff(M);
      expect(await emailWelcomeLinkAction(undefined, form({ clientId }))).toEqual({ error: 'Could not send the email: The to address is invalid. Nothing was sent; use “Copy welcome link” instead.' });
      expect(await events()).toEqual([{ kind: 'portal_invite_ended', summary: 'Welcome email could not be sent, so its link was ended', meta: { via: 'email', failed: true } }]);
      expect(await audits()).toEqual([{ action: 'client.welcome_link_failed', metadata: { channel: 'email', delivery: 'failed', reason: 'The to address is invalid', earlier_links_expired: 0 } }]);
      expect(await card(M, clientId)).toContain('The last link ended on');

      answer = { status: 200, body: JSON.stringify({ id: `re_${uniq()}` }) };
      asStaff(M);
      expect(await emailWelcomeLinkAction(undefined, form({ clientId }))).toEqual({ ok: `Invitation emailed to ${email}.` });
      expect((await events()).at(-1)).toEqual({ kind: 'portal_invited', summary: 'Welcome link emailed to the client', meta: { via: 'email' } });
      expect((await audits()).at(-1)).toEqual({ action: 'client.welcome_link', metadata: { via: 'email', delivery: 'sent', earlier_links_expired: 0 } });
      expect(await card(M, clientId)).toContain(`Link emailed for <span class="text-ink [overflow-wrap:anywhere]">${email}</span> on`);

      answer = { status: 504, body: 'gateway timeout' };
      asStaff(M);
      expect(await emailWelcomeLinkAction(undefined, form({ clientId }))).toEqual({ error: 'The email service did not answer, so it may or may not have arrived. Ask the client before sending the welcome link again.' });
      expect((await events()).at(-1)).toEqual({ kind: 'portal_invited', summary: 'Welcome link emailed to the client; the email service did not answer, so it may not have arrived', meta: { via: 'email', unconfirmed: true } });
      expect((await audits()).at(-1)).toEqual({ action: 'client.welcome_link', metadata: { via: 'email', delivery: 'unconfirmed', earlier_links_expired: 1 } });
      expect(await card(M, clientId)).toContain('The email service did not answer, so it may not have arrived.');
      expect((await events()).some((e) => e.summary === 'Welcome link emailed to the client' && (e.meta as { failed?: boolean }).failed)).toBe(false);
    } finally {
      vi.unstubAllGlobals();
      vi.stubGlobal('React', React);
      process.env = { ...saved };
      resetEnvCache();
    }
  });
});

describe('EXP-9: an email that already has a client portal at another agency', () => {
  it('gets a known message, translated, naming the agency that invited them; nothing is changed', async () => {
    const X = await makeOrg('FirstAgency');
    const Y = await makeOrg('SecondAgency');
    const email = `both-${uniq()}@client.dev`;
    const invited = async (o: TestOrg) => {
      const clientId = await addClient(o.orgId, 'Kim Both', { status: 'lead' });
      await withSystem((db) => db.run('update public.clients set email = $2 where id = $1', [clientId, email]));
      return { clientId, token: await asUser(o.ownerId, (db) => createInviteToken(db, { orgId: o.orgId, email, role: 'client', clientId, invitedBy: o.ownerId })) };
    };
    const x = await invited(X);
    expect((await acceptInvite(x.token, { fullName: 'Kim Both', password: PASSWORD }, { ip: testIp() })).ok).toBe(true);
    const y = await invited(Y);
    // Without the password nothing is said about any other agency.
    expect(await acceptInvite(y.token, { fullName: 'Kim Both', password: 'Not-The-Password-42' }, { ip: testIp() })).toEqual({ ok: false, error: 'An account with this email exists; enter its current password to join.' });
    const yName = await orgName(Y.orgId);
    const r = await acceptInvite(y.token, { fullName: 'Kim Both', password: PASSWORD }, { ip: testIp() });
    expect(r).toEqual({ ok: false, error: `This email already has a client portal with another company. Ask ${yName} to use a different email.` });
    expect(portalMessage('es', (r as { error: string }).error)).toBe(`Este correo ya tiene un portal de cliente con otra empresa. Pida a ${yName} que use otro correo.`);
    const state = await withSystem((db) => db.row<{ linked: string | null; members: number }>(
      "select (select portal_user_id from public.clients where id = $1) as linked, (select count(*)::int from public.memberships m join public.users u on u.id = m.user_id where m.org_id = $2 and u.email = $3) as members", [y.clientId, Y.orgId, email]));
    expect(state).toEqual({ linked: null, members: 0 });
    expect(await getInvite(y.token)).toMatchObject({ clientId: y.clientId });

    // Should the database refuse the link anyway (two acceptances at once), the answer is still a known message and
    // the transaction leaves nothing behind. Stood in for here by a portal account already linked inside Y.
    const z = await invited(Y);
    const userId = (await withSystem((db) => db.row<{ id: string }>('select id from public.users where email = $1', [email])))!.id;
    await withSystem((db) => db.run('update public.clients set portal_user_id = null where id = $1', [x.clientId]));
    await withSystem((db) => db.run('update public.clients set portal_user_id = $2 where id = $1', [y.clientId, userId]));
    const raced = await acceptInvite(z.token, { fullName: 'Kim Both', password: PASSWORD }, { ip: testIp() });
    expect(raced).toEqual({ ok: false, error: `This email already has a client portal with another company. Ask ${yName} to use a different email.` });
    expect((await withSystem((db) => db.row<{ n: number }>('select count(*)::int as n from public.memberships where org_id = $1 and user_id = $2', [Y.orgId, userId])))!.n).toBe(0);
  });
});

describe('SEC-1: a client invitation is good only for the client’s email as it is now', () => {
  it('a link made for an address that changed cannot be used; the card shows the portal account’s email once joined', async () => {
    const c = await addClient(A.orgId, 'Pat Typo', { status: 'lead' });
    const typo = `pat-${uniq()}@gmial.test`;
    const right = typo.replace('@gmial.', '@gmail.');
    const setEmail = (email: string) => withSystem((db) => db.run('update public.clients set email = $2 where id = $1', [c, email]));
    await setEmail(typo);
    const token = (await asUser(A.ownerId, async (db) => issueWelcomeLink(db, { orgId: A.orgId, userId: A.ownerId }, (await welcomeClient(db, c))!, 'copy'))).link.split('/invite/')[1]!;
    expect(await card(A, c)).toContain(`Link made for <span class="text-ink [overflow-wrap:anywhere]">${typo}</span> on`);
    // The email is corrected by any path that does not end the link itself.
    await setEmail(right);
    expect(await getInvite(token)).toBeNull();
    const page = await invitePage(token);
    expect(page).toContain('This link can’t be used anymore');
    expect(page).toContain('It was already used or is no longer valid.');
    expect(await acceptInvite(token, { fullName: 'Pat Typo', password: PASSWORD }, { ip: testIp() })).toEqual({ ok: false, error: 'This invitation is invalid or has expired.' });
    expect((await withSystem((db) => db.row<{ p: string | null }>('select portal_user_id as p from public.clients where id = $1', [c])))!.p).toBeNull();
    // Back to the address it was made for (compared without case or surrounding spaces), it works again.
    await setEmail(`${typo} `);
    expect(await getInvite(token)).toMatchObject({ clientId: c });
    expect((await acceptInvite(token, { fullName: 'Pat Typo', password: PASSWORD }, { ip: testIp() })).ok).toBe(true);
    const joined = await card(A, c);
    expect(joined).toContain(`Portal account: <span class="text-ink [overflow-wrap:anywhere]">${typo}</span>`);
    expect(joined).not.toContain('Not the email on file');
    await setEmail(right);
    expect(await card(A, c)).toContain('Not the email on file');
  });
});
