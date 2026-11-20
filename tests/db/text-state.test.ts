import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import type { Ctx } from '@/lib/auth/context';
import type { SessionInfo } from '@/lib/auth/service';
import { grantSmsConsent } from '@/lib/client-updates/service';
import { TEXTS_NEED_APPROVAL } from '@/lib/client-updates/templates';
import { resetEnvCache } from '@/lib/env';
import { tr } from '@/lib/portal-i18n';
import { can, type Role } from '@/lib/rbac';
import { toUsE164 } from '@/lib/sms';
import { addClient, addMember, approveOutreach, asUser, closePool, makeOrg, withSystem, type TestOrg } from './helpers';

// Where staff see the state of a client's texts: the consent block on the client page and the test-text step of the
// "Get set up" page. Both are rendered here as the server renders them, with the real queries under row-level
// security. Only the sign-in step is stood in for.
const signedIn = vi.hoisted(() => ({ ctx: null as unknown }));
vi.mock('@/lib/auth/context', () => ({
  requireStaff: async (perm?: string) => {
    const ctx = signedIn.ctx as { can(p: string): boolean };
    if (perm && !ctx.can(perm)) throw new Error('REDIRECT /app?denied=1');
    return ctx;
  },
}));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));
// The test runner compiles JSX to React.createElement, so React has to be in scope when a component renders.
vi.stubGlobal('React', React);

import { SmsConsentBlock } from '@/app/app/clients/[id]/sms-consent-block';
import SetupPage from '@/app/app/setup/page';
import { SmsConsentCard } from '@/app/portal/(app)/profile/sms-consent';

const saved = { ...process.env };
function useEnv(env: Record<string, string>) { process.env = { ...saved, ...env }; resetEnvCache(); }
afterEach(() => { process.env = { ...saved }; resetEnvCache(); });
afterAll(async () => { await closePool(); });

const TWILIO = { SMS_DRIVER: 'twilio', TWILIO_ACCOUNT_SID: 'ACtest', TWILIO_AUTH_TOKEN: 'token-for-tests', TWILIO_FROM_NUMBER: '+12125550100' };

async function signIn(o: TestOrg, role: Role = 'owner'): Promise<Ctx> {
  const org = (await withSystem((db) => db.row<{ name: string; slug: string }>('select name, slug from public.organizations where id = $1', [o.orgId])))!;
  const session: SessionInfo = { sessionId: 's', userId: o.ownerId, orgId: o.orgId, role, email: o.ownerEmail, fullName: 'Test Person', mfaVerified: true, totpEnabled: false, orgName: org.name, orgSlug: org.slug, orgMode: 'agency', orgPlan: 'trial' };
  const ctx: Ctx = { session, userId: o.ownerId, orgId: o.orgId, role, tx: (fn) => asUser(o.ownerId, fn), can: (p) => can(role, p), need: () => undefined, meta: { ip: '10.0.0.1', userAgent: 'vitest' } };
  signedIn.ctx = ctx;
  return ctx;
}
/** What a person reads: the markup with tags dropped and entities decoded. */
const read = (el: React.ReactNode) => renderToStaticMarkup(el as React.ReactElement).replace(/<!-- -->/g, '')
  .replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ');
/** A US number nobody else in the (never truncated) test database has. */
const phone = (): string => { const n = `+1512${2 + Math.floor(Math.random() * 8)}${String(Math.floor(Math.random() * 100)).padStart(2, '0')}${String(Math.floor(Math.random() * 10_000)).padStart(4, '0')}`; return toUsE164(n) ? n : phone(); };
/** A client with a portal sign-in and a phone number; `consent` is their own agreement, given in the portal. */
async function client(o: TestOrg, number: string, consent: boolean) {
  const user = await addMember(o.orgId, 'client', 'portal');
  const clientId = await addClient(o.orgId, 'Jordan Rivera', { portalUserId: user.id });
  await withSystem((db) => db.run('update public.clients set phone = $2 where id = $1', [clientId, number]));
  if (consent) expect(await asUser(user.id, (db) => grantSmsConsent(db, { orgId: o.orgId, clientId, userId: user.id, source: 'portal' }))).toEqual({ ok: true, phone: number });
  return { clientId, userId: user.id };
}
const block = async (ctx: Ctx, clientId: string, number: string) => read(await SmsConsentBlock({ ctx, clientId, phone: number, lang: 'en' }));

describe('the consent block on a client’s page', () => {
  it('says why no text is going out while the workspace is not approved, and again after a rename', async () => {
    useEnv({ SMS_DRIVER: 'log' });
    const o = await makeOrg('TextStateFresh'); // as sign-up leaves it
    const number = phone();
    const c = await client(o, number, true);
    let page = await block(await signIn(o), c.clientId, number);
    expect(page).toContain('Paused');
    expect(page).toContain('Given by the client in the portal');
    expect(page).toContain(TEXTS_NEED_APPROVAL.not_approved);
    // A client with no consent yet: staff who are about to record one are told as well.
    const other = phone();
    const none = await client(o, other, false);
    expect(await block(await signIn(o), none.clientId, other)).toContain(TEXTS_NEED_APPROVAL.not_approved);

    // Approved by the platform operator: the consent reads "On" and nothing is said about approval.
    await approveOutreach(o.orgId);
    page = await block(await signIn(o), c.clientId, number);
    expect(page).toMatch(/ On /);
    expect(page).not.toContain('Paused');
    expect(page).not.toContain('No text is being sent from this workspace');

    // Renamed by its owner: the approval was for the old name.
    await asUser(o.ownerId, (db) => db.run("update public.organizations set name = 'Another Name Credit' where id = $1", [o.orgId]));
    page = await block(await signIn(o), c.clientId, number);
    expect(page).toContain('Paused');
    expect(page).toContain(TEXTS_NEED_APPROVAL.renamed);

    // With no text service connected at all, that is the reason nothing is texted, and the approval is not mentioned.
    useEnv({ SMS_DRIVER: 'disabled' });
    expect(await block(await signIn(o), c.clientId, number)).not.toContain('No text is being sent from this workspace');
  });

  it('offers to record a consent only for a US mobile number, and says so when a consent on file is for another number', async () => {
    useEnv({ SMS_DRIVER: 'log' });
    const o = await makeOrg('TextStateUs');
    await approveOutreach(o.orgId);
    const ctx = await signIn(o);
    const FORM = 'I read this wording to the client and they agreed';
    const NEEDS_US = 'Save a US mobile number with its area code on the client’s record first, for example (212) 555-0142. Texts are sent to US numbers only.';
    // A US number: the wording to read out, naming the number, and the form.
    const number = phone();
    const us = await client(o, number, false);
    let page = await block(ctx, us.clientId, number);
    expect(page).toContain(FORM);
    expect(page).toContain(`about my file at ${number}`);
    expect(page).not.toContain(NEEDS_US);
    // The UK, Jamaica, a premium line, and a number that cannot exist: no form, and the reason.
    for (const typed of ['+44 7911 123456', '+1 876 555 1234', '(900) 555-1234', '(212) 911-0134', '555-0134']) {
      const other = await client(o, typed, false);
      page = await block(ctx, other.clientId, typed);
      expect(page, typed).toContain(NEEDS_US);
      expect(page, typed).not.toContain(FORM);
    }
    // A consent recorded before this rule, for a number abroad: shown as paused, with the reason.
    const old = await client(o, '+447911123456', false);
    await withSystem((db) => db.run("insert into public.sms_consents (org_id, client_id, phone, consent_text, source, recorded_by) values ($1, $2, '+447911123456', repeat('y', 30), 'portal', $3)", [o.orgId, old.clientId, old.userId]));
    page = await block(ctx, old.clientId, '+447911123456');
    expect(page).toContain('Paused');
    expect(page).toContain('This is not a US mobile number. Texts are sent to US numbers only, so nothing is sent to it.');
  });
});

describe('the “Get set up” page, next to the test text', () => {
  it('says the test goes to US numbers only, and that nothing is texted until the workspace is approved', async () => {
    useEnv(TWILIO);
    const o = await makeOrg('TextStateSetup');
    await signIn(o);
    let page = read(await SetupPage());
    expect(page).toContain('Up to 3 a day, to US mobile numbers only. The number is not saved.');
    expect(page).toContain(`${TEXTS_NEED_APPROVAL.not_approved} The test text is refused until then too.`);
    expect(page).not.toMatch(/Canadian/);
    await approveOutreach(o.orgId);
    await signIn(o);
    page = read(await SetupPage());
    expect(page).toContain('Up to 3 a day, to US mobile numbers only. The number is not saved.');
    expect(page).not.toContain('No text is being sent from this workspace');
    // Not connected: the page says that, and does not bring up the approval.
    useEnv({ SMS_DRIVER: 'disabled' });
    await withSystem((db) => db.run('update public.organizations set outreach_approved_at = null, outreach_approved_name = null where id = $1', [o.orgId]));
    await signIn(o);
    page = read(await SetupPage());
    expect(page).toContain('Text messaging is not connected yet, so this will say so.');
    expect(page).not.toContain('No text is being sent from this workspace');
  });
});

describe('the text-message card in the client’s own portal', () => {
  /** The client's own view: the same tenant connection, signed in as the portal user. */
  const card = async (o: TestOrg, c: { clientId: string; userId: string }, number: string, lang: 'en' | 'es' = 'en') => {
    const ctx = { ...(await signIn(o)), userId: c.userId, role: 'client' as Role, tx: <T,>(fn: Parameters<Ctx['tx']>[0]) => asUser(c.userId, fn) as Promise<T> } as unknown as Ctx;
    const el = await SmsConsentCard({ ctx, clientId: c.clientId, phone: number, lang, t: tr(lang) });
    return el ? read(el) : '';
  };

  it('never says "On" while no text can leave: not approved, renamed since, or no text service', async () => {
    const o = await makeOrg('TextStatePortal');
    const number = phone();
    const c = await client(o, number, true);
    const paused = (page: string, label: string) => {
      expect(page, label).toContain('Paused');
      expect(page).toContain('Text updates are paused at the moment, so no text is sent. Your agreement stays on file, and you can withdraw it here.');
      expect(page).toContain('Turn off text updates');
      expect(page).not.toMatch(/\bOn since\b/);
      expect(page).not.toContain('Turn on text updates');
    };
    useEnv(TWILIO); // connected, not approved
    paused(await card(o, c, number), 'twilio');
    useEnv({ SMS_DRIVER: 'disabled' }); // no text service
    paused(await card(o, c, number), 'disabled');
    // In Spanish too.
    useEnv(TWILIO);
    expect(await card(o, c, number, 'es')).toContain('Los avisos por texto están en pausa por ahora');
    // Approved under its current name, with a text service: "On", with the date and the number.
    await approveOutreach(o.orgId);
    const on = await card(o, c, number);
    expect(on).toContain('Text message updates On ');
    expect(on).toMatch(/On since .+ for \+1\d{10}\./);
    expect(on).not.toContain('Paused');
    // Renamed since the approval: paused again.
    await withSystem((db) => db.run("update public.organizations set name = name || ' Renamed' where id = $1", [o.orgId]));
    expect(await card(o, c, number)).toContain('Paused');
  });

  it('offers nothing when there is no consent and no text could follow', async () => {
    useEnv(TWILIO);
    const o = await makeOrg('TextStatePortalNone');
    const number = phone();
    const c = await client(o, number, false);
    expect(await card(o, c, number)).toBe('');
    await approveOutreach(o.orgId);
    const page = await card(o, c, number);
    expect(page).toContain('Off');
    expect(page).toContain('Turn on text updates');
  });
});
