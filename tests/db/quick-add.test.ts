import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActionState } from '@/components/forms';
import type { Ctx } from '@/lib/auth/context';
import { acceptInvite, createInviteToken, getInvite, signUp, type SessionInfo } from '@/lib/auth/service';
import { storedTerms, type AgreementTerms } from '@/lib/compliance/agreement-terms';
import { getEnv, resetEnvCache } from '@/lib/env';
import { sentLog } from '@/lib/mailer';
import { can, type Permission, type Role } from '@/lib/rbac';
import { UNAPPROVED_EMAILS_PER_HOUR } from '@/lib/staff-email';
import { addClient, addMember, approveOutreach, asUser, closePool, makeOrg, PASSWORD, testIp, uniq, withSystem, type TestOrg } from './helpers';

/**
 * "Invite a client" on New client (quick add): a name and an email create the client, make the welcome link and send
 * the welcome email. Run as the server runs it, with the real queries under row-level security. Only the sign-in is
 * stood in for, and the email service's HTTP API: the real driver is used, and nothing leaves the machine.
 */
const signedIn = vi.hoisted(() => ({ ctx: null as unknown }));
vi.mock('@/lib/auth/context', () => ({
  requireStaff: async (perm?: string) => {
    const ctx = signedIn.ctx as { can(p: string): boolean };
    if (perm && !ctx.can(perm)) throw new Error('REDIRECT /app?denied=1');
    return ctx;
  },
}));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));
vi.stubGlobal('React', React);

import { quickAddClientAction } from '@/app/app/clients/quick-add-actions';
import { emailWelcomeLinkAction } from '@/app/app/clients/welcome-actions';
import NewClientPage from '@/app/app/clients/new/page';
import { QuickAddResult } from '@/app/app/clients/new/quick-add';

const saved = { ...process.env };
afterAll(async () => { process.env = { ...saved }; resetEnvCache(); await closePool(); });

/** What the stand-in for the email service answers, and every email handed to it, as it would leave. */
type Answer = { status: number; body: string } | 'dropped' | 'unreachable';
const TAKEN: Answer = { status: 200, body: JSON.stringify({ id: 're_quick_add' }) };
let answer: Answer = TAKEN;
let handed: { from: string; to: string; subject: string; text: string; replyTo?: string }[] = [];
/** Email is connected for this test: the real driver, with its HTTP request answered here. */
function connectEmail(a: Answer = TAKEN) {
  Object.assign(process.env, { EMAIL_DRIVER: 'resend', RESEND_API_KEY: 're_test_key_for_vitest' });
  resetEnvCache();
  answer = a;
  vi.stubGlobal('fetch', async (url: string | URL, init?: RequestInit) => {
    if (String(url) !== 'https://api.resend.com/emails') throw new Error(`unexpected request to ${String(url)}`);
    // No connection could be made (the name did not resolve): nothing reached the email service.
    if (answer === 'unreachable') throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } });
    const b = JSON.parse(String(init?.body ?? '{}')) as { from: string; to: string[]; subject: string; text: string; reply_to?: string };
    handed.push({ from: b.from, to: b.to[0]!, subject: b.subject, text: b.text, ...(b.reply_to ? { replyTo: b.reply_to } : {}) });
    if (answer === 'dropped') throw new TypeError('fetch failed'); // the connection was lost after the request went out
    return new Response(answer.body, { status: answer.status });
  });
}
beforeEach(() => { handed = []; answer = TAKEN; });
afterEach(() => { vi.unstubAllGlobals(); vi.stubGlobal('React', React); process.env = { ...saved }; resetEnvCache(); });

/** Signs a person in. `lacks` stands in for a role that does not have a permission. */
function signIn(o: TestOrg, opts: { role?: Role; userId?: string; orgName?: string; orgMode?: 'agency' | 'personal'; lacks?: Permission } = {}): void {
  const role = opts.role ?? 'owner';
  const userId = opts.userId ?? o.ownerId;
  const session: SessionInfo = { sessionId: 's', userId, orgId: o.orgId, role, email: o.ownerEmail, fullName: 'Avery Owner', mfaVerified: true, totpEnabled: false, orgName: opts.orgName ?? 'Bright Path Credit', orgSlug: 'bright-path', orgMode: opts.orgMode ?? 'agency', orgPlan: 'trial' };
  const ctx: Ctx = { session, userId, orgId: o.orgId, role, tx: (fn) => asUser(userId, fn), can: (p) => p !== opts.lacks && can(role, p), need: () => undefined, meta: { ip: '10.0.0.1', userAgent: 'vitest' } };
  signedIn.ctx = ctx;
}
const form = (fields: Record<string, string>) => { const fd = new FormData(); for (const [k, v] of Object.entries(fields)) fd.set(k, v); return fd; };
const freshEmail = (who = 'client') => `${who}-${uniq()}@example.test`;
const add = (fields: { firstName?: string; lastName?: string; email?: string; phone?: string; preferredLanguage?: string }) =>
  quickAddClientAction(undefined, form({ firstName: 'Dana', lastName: 'Whitfield', ...fields } as Record<string, string>));
const count = (sql: string, p: unknown[]) => withSystem((db) => db.row<{ n: number }>(sql, p as never[])).then((r) => r!.n);
const clientsWith = (orgId: string, email: string) => count('select count(*)::int as n from public.clients where org_id = $1 and email = $2', [orgId, email]);
const clientRow = (id: string) => withSystem((db) => db.row('select org_id, assigned_to, full_name, email, phone, preferred_language, status, stage, source, address, tags, portal_user_id from public.clients where id = $1', [id]));
const events = (id: string) => withSystem((db) => db.rows<{ kind: string; summary: string; meta: Record<string, unknown> }>('select kind, summary, meta from public.client_events where client_id = $1 order by created_at', [id]));
const audits = (id: string) => withSystem((db) => db.rows<{ action: string; metadata: Record<string, unknown> }>("select action, metadata from public.audit_logs where entity_id = $1 and action like 'client.%' order by id", [id]));
const invites = (id: string) => withSystem((db) => db.rows<{ email: string; live: boolean }>("select email, expires_at > now() as live from public.invites where client_id = $1 and role = 'client' order by created_at, expires_at", [id]));
const tokenOf = (text: string) => /\/invite\/([\w-]+)/.exec(text)![1]!;
/** The result panel of the page for what the action returned, as the server renders it. */
const shown = (state: ActionState) => renderToStaticMarkup(React.createElement(QuickAddResult, { state }));
const ONCE = 'It works once and expires in 7 days.';
const NO_ADDRESS = { line1: '', line2: '', city: '', state: '', zip: '' };
/** The next step when the email belongs to a different person (a couple who share one address). */
const SHARED = 'If this is someone else who shares the address, they need an email address of their own to use the portal. To add them without one, use “Enter everything yourself”.';
const hourlyHits = (orgId: string) => count('select coalesce(sum(hits), 0)::int as n from public.rate_limits where key = $1', [`staff-email:org:${orgId}`]);
const TERMS: AgreementTerms = {
  legalName: 'Bright Path Credit LLC', address: '500 Bayshore Blvd, Suite 210, Tampa, FL 33606',
  services: 'We review your three credit reports with you, prepare dispute letters for the items you choose, track each investigation and report every response to you in your portal.',
  paymentTerms: 'A monthly fee of $99.00, charged on the 1st of each month for the work fully performed in the month before.',
  totalCents: 59_400, duration: 'About 6 months from the date you sign.', additional: '', updatedAt: '2026-11-20T15:00:00.000Z', updatedBy: 'test',
};
const saveTerms = (orgId: string, t: AgreementTerms = TERMS) =>
  withSystem((db) => db.run("update public.organizations set settings = settings || jsonb_build_object('agreement', $2::jsonb) where id = $1", [orgId, JSON.stringify(storedTerms(t))]));

describe('invite a client: the welcome email is sent', () => {
  it('creates the client as the full form does, makes the welcome link and hands the welcome email to the email service', async () => {
    const o = await makeOrg('QuickSent');
    await withSystem((db) => db.run("update public.organizations set settings = settings || jsonb_build_object('lead_reply_email', 'hello@brightpath.example') where id = $1", [o.orgId]));
    // An automation of this agency that runs when a client is created.
    const automation = (await asUser(o.ownerId, (db) => db.row<{ id: string }>(
      `insert into public.automations (org_id, name, trigger, conditions, actions, enabled, requires_approval, max_subjects_per_run, cooldown_days, created_by)
       values ($1, 'Call every new client', 'client_created', '{}', $2, true, false, 25, 0, $3) returning id`, [o.orgId, JSON.stringify([{ type: 'create_task', title: 'Call the new client' }]), o.ownerId])))!.id;
    signIn(o);
    connectEmail();
    const typed = `Dana.Whitfield-${uniq()}@Example.TEST`;
    const email = typed.toLowerCase();

    const r = await add({ firstName: '  Dana ', lastName: ' Whitfield', email: ` ${typed} `, phone: '(813) 555-0142' });
    expect(r).toEqual({ ok: `Dana was added. Welcome email sent to ${email}.`, data: { outcome: 'sent', clientId: expect.any(String), first: 'Dana' } });
    const id = r!.data!.clientId!;
    expect(await clientRow(id)).toEqual({
      org_id: o.orgId, assigned_to: o.ownerId, full_name: 'Dana Whitfield', email, phone: '(813) 555-0142', preferred_language: 'en',
      status: 'onboarding', stage: 'intake', source: null, address: NO_ADDRESS, tags: [], portal_user_id: null,
    });
    // The same timeline event, audit entry and automation trigger as the full form; "emailed" once the service took it.
    expect((await events(id)).map((e) => [e.kind, e.summary])).toEqual([
      ['client_created', 'Client created'],
      ['automation', 'Automation: Create a task for the team'],
      ['portal_invited', 'Welcome link emailed to the client'],
    ]);
    expect((await events(id)).at(-1)!.meta).toEqual({ via: 'email' });
    expect(await audits(id)).toEqual([
      { action: 'client.created', metadata: {} },
      { action: 'client.welcome_link', metadata: { via: 'email', delivery: 'sent', earlier_links_expired: 0 } },
    ]);
    expect(await count('select count(*)::int as n from public.automation_runs where automation_id = $1 and subject_id = $2', [automation, id])).toBe(1);
    expect(await count("select count(*)::int as n from public.tasks where client_id = $1 and title = 'Call the new client'", [id])).toBe(1);

    // One email: to the client, from the agency's name, replies to the agency, with the one link that works.
    expect(handed).toHaveLength(1);
    expect(handed[0]).toMatchObject({ to: email, subject: 'Bright Path Credit: welcome to your client portal', replyTo: 'hello@brightpath.example' });
    expect(handed[0]!.from).toMatch(/^"Bright Path Credit" <[^<>]+>$/);
    expect(handed[0]!.text.split('\n')[0]).toBe('Hello Dana,');
    expect(await getInvite(tokenOf(handed[0]!.text))).toMatchObject({ clientId: id, role: 'client', orgId: o.orgId, email });
    expect(await invites(id)).toEqual([{ email, live: true }]);

    // A Spanish-speaking client gets the Spanish email and a Spanish portal.
    const es = freshEmail('luz');
    const s = await add({ firstName: 'Luz', lastName: 'Marín Ortega', email: es, preferredLanguage: 'es' });
    expect(s).toMatchObject({ ok: `Luz was added. Welcome email sent to ${es}.`, data: { outcome: 'sent', first: 'Luz' } });
    expect(await clientRow(s!.data!.clientId!)).toMatchObject({ full_name: 'Luz Marín Ortega', preferred_language: 'es', phone: null });
    expect(handed[1]).toMatchObject({ to: es, subject: 'Bright Path Credit: le damos la bienvenida a su portal de cliente' });
    expect(handed[1]!.text).toContain('Hola Luz:');
    expect(handed[1]!.text).toContain('/portal/login?org=bright-path&lang=es');
  });

  it.each(['owner', 'admin', 'manager', 'specialist'] as const)('every staff role may invite a client: the client a %s invites is assigned to them', async (role) => {
    const o = await makeOrg('QuickRole');
    const who = role === 'owner' ? o.ownerId : (await addMember(o.orgId, role)).id;
    signIn(o, { role, userId: who });
    connectEmail();
    const email = freshEmail(role);
    const r = await add({ firstName: 'Noor', lastName: 'Haddad', email });
    expect(r).toMatchObject({ ok: `Noor was added. Welcome email sent to ${email}.`, data: { outcome: 'sent', first: 'Noor' } });
    expect(await clientRow(r!.data!.clientId!)).toMatchObject({ org_id: o.orgId, assigned_to: who, full_name: 'Noor Haddad' });
    expect(handed.map((m) => m.to)).toEqual([email]);
  });

  it('the database fails right after the email service took the email: the page still says it was sent, never "send it again"', async () => {
    const o = await makeOrg('QuickLateLog');
    signIn(o);
    connectEmail();
    const email = freshEmail('late');
    // The connection to the database is lost the moment the email has been handed over: the "emailed" entry cannot be written.
    const ctx = signedIn.ctx as Ctx;
    const tx = ctx.tx;
    ctx.tx = async (fn) => { if (handed.length) throw new Error('the connection to the database was lost'); return tx(fn); };
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const r = await add({ firstName: 'Bo', lastName: 'Kent', email });
      expect(r).toEqual({ ok: `Bo was added. Welcome email sent to ${email}.`, data: { outcome: 'sent', clientId: expect.any(String), first: 'Bo' } });
      const id = r!.data!.clientId!;
      // One email went out and its link works. The failure is printed for the operator, with the client it is about.
      expect(handed.map((m) => m.to)).toEqual([email]);
      expect(await getInvite(tokenOf(handed[0]!.text))).toMatchObject({ clientId: id });
      expect(await invites(id)).toEqual([{ email, live: true }]);
      expect(logged).toHaveBeenCalledWith('[welcome-send] the welcome email was handed over but could not be logged', id, expect.any(Error));
      expect(logged).toHaveBeenCalledTimes(1);
    } finally { logged.mockRestore(); ctx.tx = tx; }
  });

  it('the same when the email service did not answer: "may or may not have arrived", and "Email welcome link" on the client page answers the same way', async () => {
    const o = await makeOrg('QuickLateLogUnanswered');
    await approveOutreach(o.orgId);
    signIn(o);
    connectEmail('dropped');
    const ctx = signedIn.ctx as Ctx;
    const tx = ctx.tx;
    ctx.tx = async (fn) => { if (handed.length) throw new Error('the connection to the database was lost'); return tx(fn); };
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const r = await add({ firstName: 'Bo', lastName: 'Kent', email: freshEmail('late-unanswered') });
      expect(r!.ok).toBe('Bo was added. The email service did not answer, so the welcome email may or may not have arrived. Ask Bo before sending it again. You can send it again from Bo’s page.');
      expect(r!.data).toMatchObject({ outcome: 'unconfirmed' });
      expect(handed).toHaveLength(1);

      // The button on the client's page shares the function: an email the service took is "emailed", not "try again".
      ctx.tx = tx;
      const other = await addClient(o.orgId, 'Mia Mail', { status: 'lead' });
      const otherEmail = (await withSystem((db) => db.row<{ email: string }>('select email from public.clients where id = $1', [other])))!.email;
      handed = [];
      answer = TAKEN;
      ctx.tx = async (fn) => { if (handed.length) throw new Error('the connection to the database was lost'); return tx(fn); };
      expect(await emailWelcomeLinkAction(undefined, form({ clientId: other }))).toEqual({ ok: `Invitation emailed to ${otherEmail}.` });
      expect(handed.map((m) => m.to)).toEqual([otherEmail]);
      expect(logged).toHaveBeenCalledTimes(2);
    } finally { logged.mockRestore(); ctx.tx = tx; }
  });
});

describe('invite a client: email is not connected', () => {
  it('the client is created and a one-time link comes back to pass on by hand; nothing is emailed or said to be', async () => {
    const o = await makeOrg('QuickNoEmail');
    signIn(o);
    const logged = sentLog.length;
    const email = freshEmail('rae');
    const r = await add({ firstName: 'Rae', lastName: 'Okafor', email, phone: '813-555-0142' });
    expect(r!.ok).toBe(`Rae was added. Email is not connected, so no email was sent. Send Rae this link yourself. ${ONCE}`);
    const { clientId, link, sms } = r!.data as { clientId: string; link: string; sms: string };
    expect(r!.data).toEqual({ outcome: 'link', clientId, first: 'Rae', link, sms });
    expect(link.startsWith(`${getEnv().APP_URL}/invite/`)).toBe(true);
    expect(await getInvite(tokenOf(link))).toMatchObject({ clientId, role: 'client', orgId: o.orgId, email });
    // The text link carries the number and the link, for the staff member's own phone, and says which business it is from.
    expect(sms).toBe(`sms:+18135550142?body=${encodeURIComponent(`Hello Rae, this is Bright Path Credit. Here is your link to set up your client portal. ${ONCE.replace('.', '')}: ${link}`)}`);
    expect(sentLog.length).toBe(logged); // not even written to the development log
    // On the page: the link to copy, the text link (with what it needs), the client's page and the place to enter their details by hand.
    const panel = shown(r);
    for (const part of [`<code class="block break-all text-xs">${link}</code>`, 'Copy link', `href="${sms}"`, 'Text it from your phone',
      '“Text it from your phone” opens your texting app, so use it with this page open on your phone. On a computer, copy the link.',
      `href="/app/clients/${clientId}"`, 'Open Rae’s page', `href="/app/clients/${clientId}/edit"`, 'Enter Rae’s details yourself']) expect(panel, part).toContain(part);
    expect(await clientRow(clientId)).toMatchObject({ full_name: 'Rae Okafor', email, phone: '813-555-0142', status: 'onboarding', assigned_to: o.ownerId });
    expect(await events(clientId)).toEqual([
      { kind: 'client_created', summary: 'Client created', meta: {} },
      { kind: 'portal_invited', summary: 'Welcome link created to share with the client', meta: { via: 'copy' } },
    ]);
    expect(await audits(clientId)).toEqual([
      { action: 'client.created', metadata: {} },
      { action: 'client.welcome_link', metadata: { via: 'copy', earlier_links_expired: 0 } },
    ]);

    // No phone number: the link, no text link, and not a word about texting. In Spanish for a Spanish client.
    const none = await add({ firstName: 'Luz', lastName: 'Marín', email: freshEmail('luz'), preferredLanguage: 'es' });
    expect(none!.ok).toBe(`Luz was added. Email is not connected, so no email was sent. Send Luz this link yourself. ${ONCE}`);
    expect(none!.data).toEqual({ outcome: 'link', clientId: expect.any(String), first: 'Luz', link: expect.stringContaining('/invite/') });
    expect(shown(none)).not.toContain('texting app');
    // A number that was typed but cannot be read as a full number: the client is added with it as typed, there is no
    // text link, and the page says why instead of dropping it without a word.
    for (const phone of ['office, ext 204', '555-0142', '813-555-0142 ext 204']) {
      const odd = await add({ firstName: 'Kim', lastName: 'Bell', email: freshEmail('kim'), phone });
      expect(odd!.ok, phone).toBe(`Kim was added. Email is not connected, so no email was sent. Send Kim this link yourself. ${ONCE} The phone number could not be read as a full number, so there is no button to text the link.`);
      expect(odd!.data, phone).not.toHaveProperty('sms');
      expect(odd!.data, phone).toMatchObject({ outcome: 'link', link: expect.stringContaining('/invite/') });
      expect(await clientRow(odd!.data!.clientId!), phone).toMatchObject({ phone });
    }
    const es = await add({ firstName: 'Ana', lastName: 'Ruiz', email: freshEmail('ana'), phone: '+1 (212) 555-0199', preferredLanguage: 'es' });
    expect(decodeURIComponent(es!.data!.sms!)).toBe(`sms:+12125550199?body=Hola Ana: le escribe Bright Path Credit. Este es su enlace para configurar su portal de cliente. Funciona una sola vez y vence en 7 días: ${es!.data!.link}`);

    // Nothing leaves while email is not connected, so the workspace's hourly email limit does not hold a client back.
    await withSystem((db) => db.run('insert into public.rate_limits (key, window_start, hits) values ($1, $2, $3) on conflict (key, window_start) do update set hits = excluded.hits',
      [`staff-email:org:${o.orgId}`, new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000), UNAPPROVED_EMAILS_PER_HOUR]));
    expect(await add({ firstName: 'Sol', lastName: 'Reyes', email: freshEmail('sol') })).toMatchObject({ data: { outcome: 'link' } });
  });
});

describe('invite a client: the email did not go out', () => {
  it('held back by the claims check: the client exists, nothing is handed to the email service, and a fresh link is shown instead', async () => {
    const o = await makeOrg('QuickClaims');
    signIn(o, { orgName: 'Guaranteed Credit Results' });
    connectEmail();
    const email = freshEmail('sam');
    const r = await add({ firstName: 'Sam', lastName: 'Carter', email, phone: '(813) 555-0142' });
    expect(handed).toEqual([]);
    // The wording is in the business name, which every welcome email carries: said so, with what ends it.
    expect(r!.ok).toBe(`Sam was added, but the welcome email was not sent. The email carries your business name, and the name has wording an email may not use: “Guaranteed”. Results cannot be guaranteed. Welcome emails are held back until the name is changed in Settings. Send Sam this link yourself. ${ONCE}`);
    const { clientId, link } = r!.data as { clientId: string; link: string };
    expect(r!.data).toEqual({ outcome: 'email_failed', clientId, first: 'Sam', link, sms: expect.stringMatching(/^sms:\+18135550142\?body=Hello%20Sam%2C/) });
    // The text to send by hand leaves that business name out, for the same reason the email was held back.
    expect(decodeURIComponent(r!.data!.sms!)).toBe(`sms:+18135550142?body=Hello Sam, here is your link to set up your client portal. It works once and expires in 7 days: ${link}`);
    expect(await clientsWith(o.orgId, email)).toBe(1);
    // The link made for the email was ended with it; the one shown is new and works.
    expect(await invites(clientId)).toEqual([{ email, live: false }, { email, live: true }]);
    expect(await getInvite(tokenOf(link))).toMatchObject({ clientId });
    expect((await events(clientId)).map((e) => [e.kind, e.meta])).toEqual([
      ['client_created', {}], ['portal_invite_ended', { via: 'email', failed: true }], ['portal_invited', { via: 'copy' }],
    ]);
    expect(await audits(clientId)).toEqual([
      { action: 'client.created', metadata: {} },
      { action: 'client.welcome_link_failed', metadata: { channel: 'email', delivery: 'failed', reason: 'claims check: Results cannot be guaranteed. (“Guaranteed”)', earlier_links_expired: 0 } },
      { action: 'client.welcome_link', metadata: { via: 'copy', earlier_links_expired: 0 } },
    ]);

    // Wording that is not in the business name (here, a first name that reads as a promise): the business name is not blamed.
    signIn(o);
    const other = await add({ firstName: 'Guarantee', lastName: 'Carter', email: freshEmail('odd-name') });
    expect(handed).toEqual([]);
    expect(other!.ok).toBe(`Guarantee was added, but the welcome email was not sent: Results cannot be guaranteed (“Guarantee”). Send Guarantee this link yourself. ${ONCE}`);
    expect(other!.data).toMatchObject({ outcome: 'email_failed', link: expect.stringContaining('/invite/') });
  });

  it('refused by the email service: the client exists, the reason is given, the emailed link is ended and a fresh one is shown', async () => {
    const o = await makeOrg('QuickRefused');
    signIn(o);
    connectEmail({ status: 422, body: JSON.stringify({ message: 'The to address is invalid.' }) });
    const email = freshEmail('typo');
    const r = await add({ firstName: 'Mia', lastName: 'Stone', email });
    // In the app's own words first; what the email service said is quoted after them, not run into the sentence.
    expect(r!.ok).toBe(`Mia was added, but the welcome email to ${email} was not sent: the email service did not accept it. Send Mia this link yourself. ${ONCE} If the address has a typo, correct it on Mia’s page and make a new link there. The email service said: “The to address is invalid”.`);
    const { clientId, link } = r!.data as { clientId: string; link: string };
    expect(r!.data).toEqual({ outcome: 'email_failed', clientId, first: 'Mia', link });
    expect(handed).toHaveLength(1);
    const emailed = tokenOf(handed[0]!.text);
    expect(tokenOf(link)).not.toBe(emailed);
    expect(await getInvite(emailed)).toBeNull();
    expect(await getInvite(tokenOf(link))).toMatchObject({ clientId, email });
    expect((await events(clientId)).map((e) => e.summary)).toEqual(['Client created', 'Welcome email could not be sent, so its link was ended', 'Welcome link created to share with the client']);
    expect((await audits(clientId))[1]).toEqual({ action: 'client.welcome_link_failed', metadata: { channel: 'email', delivery: 'failed', reason: 'The to address is invalid', earlier_links_expired: 0 } });

    // The email service could not be reached at all, or refused without a reason: said in plain words, with a link.
    answer = 'unreachable';
    const raviEmail = freshEmail('ravi');
    const down = await add({ firstName: 'Ravi', lastName: 'Patel', email: raviEmail });
    expect(down!.ok).toMatch(/^Ravi was added, but the welcome email to ravi-\w+@example\.test was not sent: the email service could not be reached\. Send Ravi this link yourself\. /);
    // Nothing is quoted, and the address is not put in doubt: it never reached the email service.
    expect(down!.ok).toBe(`Ravi was added, but the welcome email to ${raviEmail} was not sent: the email service could not be reached. Send Ravi this link yourself. ${ONCE}`);
    expect(down!.data).toMatchObject({ outcome: 'email_failed', link: expect.stringContaining('/invite/') });
    expect(handed).toHaveLength(1); // only Mia's: nothing left for Ravi
    answer = { status: 403, body: '' };
    const tessEmail = freshEmail('tess');
    const bare = await add({ firstName: 'Tess', lastName: 'Wynn', email: tessEmail });
    // No status code in a sentence for the agency: it stays in the audit entry, for whoever looks into it.
    expect(bare!.ok).toBe(`Tess was added, but the welcome email to ${tessEmail} was not sent: the email service did not accept it. Send Tess this link yourself. ${ONCE} If the address has a typo, correct it on Tess’s page and make a new link there.`);
    expect(bare!.ok).not.toMatch(/HTTP|403/);
    expect((await audits(bare!.data!.clientId!))[1]).toMatchObject({ action: 'client.welcome_link_failed', metadata: { reason: 'HTTP 403' } });
    expect(await getInvite(tokenOf(bare!.data!.link!))).toMatchObject({ clientId: bare!.data!.clientId });

    // What real answers of the email service look like while email is being set up: each is quoted whole, after the
    // app's own sentence, and a phone number that cannot be read is still mentioned.
    answer = { status: 403, body: JSON.stringify({ message: 'You can only send testing emails to your own email address (owner@example.com). To send emails to other recipients, please verify a domain at resend.com/domains, and change the `from` address to an email using this domain.' }) };
    const setupEmail = freshEmail('setup');
    const setup = await add({ firstName: 'Ana', lastName: 'Ruiz', email: setupEmail, phone: '555-0142' });
    expect(setup!.ok).toBe(`Ana was added, but the welcome email to ${setupEmail} was not sent: the email service did not accept it. Send Ana this link yourself. ${ONCE} The phone number could not be read as a full number, so there is no button to text the link. If the address has a typo, correct it on Ana’s page and make a new link there. The email service said: “You can only send testing emails to your own email address (owner@example.com). To send emails to other recipients, please verify a domain at resend.com/domains, and change the \`from\` address to an email using this domain”.`);
    expect(setup!.data).not.toHaveProperty('sms');
  });

  it.each([
    ['answered with a server error', { status: 504, body: 'gateway timeout' } as Answer],
    ['dropped the connection', 'dropped' as Answer],
  ])('the email service %s: the client exists, it may or may not have arrived, and no second link is handed out', async (_what, a) => {
    const o = await makeOrg('QuickUnanswered');
    signIn(o);
    connectEmail(a);
    const email = freshEmail('una');
    const r = await add({ firstName: 'Una', lastName: 'Price', email, phone: '(813) 555-0142' });
    expect(r).toEqual({
      ok: 'Una was added. The email service did not answer, so the welcome email may or may not have arrived. Ask Una before sending it again. You can send it again from Una’s page.',
      data: { outcome: 'unconfirmed', clientId: expect.any(String), first: 'Una' },
    });
    const id = r!.data!.clientId!;
    // The one link is the emailed one, and it still works: it may be in the client's inbox.
    expect(handed).toHaveLength(1);
    expect(await invites(id)).toEqual([{ email, live: true }]);
    expect(await getInvite(tokenOf(handed[0]!.text))).toMatchObject({ clientId: id });
    expect((await events(id)).at(-1)).toEqual({ kind: 'portal_invited', summary: 'Welcome link emailed to the client; the email service did not answer, so it may not have arrived', meta: { via: 'email', unconfirmed: true } });
    expect((await audits(id)).at(-1)).toEqual({ action: 'client.welcome_link', metadata: { via: 'email', delivery: 'unconfirmed', earlier_links_expired: 0 } });
  });
});

describe('invite a client: something breaks after the client was created', () => {
  it('says the client was added and where to look, never "try again": a second submission would only be refused', async () => {
    const o = await makeOrg('QuickBroken');
    signIn(o);
    connectEmail();
    const email = freshEmail('broken');
    // The database stops answering the moment the client exists: the welcome link cannot be made or logged.
    const ctx = signedIn.ctx as Ctx;
    const tx = ctx.tx;
    ctx.tx = async (fn) => { if (await clientsWith(o.orgId, email)) throw new Error('the connection to the database was lost'); return tx(fn); };
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const r = await add({ firstName: 'Bo', lastName: 'Kent', email });
      expect(r).toEqual({ ok: 'Bo was added, but something went wrong with the welcome link. Open Bo’s page to check it and send it again.', data: { outcome: 'added', clientId: expect.any(String), first: 'Bo' } });
      expect(logged).toHaveBeenCalledWith('[quick-add] welcome link', r!.data!.clientId, expect.any(Error));
      expect(await clientRow(r!.data!.clientId!)).toMatchObject({ full_name: 'Bo Kent', email, status: 'onboarding' });
      expect(handed).toEqual([]);
      expect(await invites(r!.data!.clientId!)).toEqual([]);
      // The page shows it as a warning with the way to the client's page (straight to its Welcome link card, where
      // the buttons are), and nothing to copy.
      const panel = shown(r);
      for (const part of ['bg-warn-soft', 'Open Bo’s page', `href="/app/clients/${r!.data!.clientId}#welcome"`]) expect(panel, part).toContain(part);
      expect(panel).not.toContain('Copy link');
    } finally { logged.mockRestore(); }
  });
});

describe('invite a client: nothing is created twice', () => {
  it('an email a client of this workspace already has is refused, whatever its case; another workspace’s clients are not seen', async () => {
    const o = await makeOrg('QuickDup');
    const other = await makeOrg('QuickDupOther');
    const existing = await addClient(o.orgId, 'Pat Quinn', { status: 'lead' });
    const email = (await withSystem((db) => db.row<{ email: string }>('select email from public.clients where id = $1', [existing])))!.email;
    await withSystem((db) => db.run("update public.clients set created_at = now() - interval '2 days' where id = $1", [existing]));
    signIn(o);
    connectEmail();
    const before = await count('select count(*)::int as n from public.clients where org_id = $1', [o.orgId]);

    // The answer is about the client who is already here, and says what to do when it is someone else who shares the address.
    expect(await add({ firstName: 'Patricia', lastName: 'Quinn', email: `  ${email.toUpperCase()} ` })).toEqual({
      error: `A client with this email is already in your workspace: Pat Quinn. Nothing was added and no email was sent. You can send the welcome link from Pat’s page. ${SHARED}`,
      data: { outcome: 'duplicate', clientId: existing, first: 'Pat' },
    });
    // A client who already signs in to the portal is not offered a welcome link.
    const portalUser = await addMember(o.orgId, 'client', 'portal');
    await withSystem((db) => db.run('update public.clients set portal_user_id = $2 where id = $1', [existing, portalUser.id]));
    expect((await add({ email }))!.error).toBe(`A client with this email is already in your workspace: Pat Quinn. Nothing was added and no email was sent. Pat already has portal access. ${SHARED}`);
    expect(await count('select count(*)::int as n from public.clients where org_id = $1', [o.orgId])).toBe(before);
    expect(await count('select count(*)::int as n from public.invites where org_id = $1', [o.orgId])).toBe(0);
    expect(handed).toEqual([]);

    // The same address on a client of another agency is that agency's business: here it is a new client.
    const theirs = freshEmail('shared');
    const theirClient = await addClient(other.orgId, 'Kim Elsewhere');
    await withSystem((db) => db.run('update public.clients set email = $2 where id = $1', [theirClient, theirs]));
    const mine = await add({ firstName: 'Kim', lastName: 'Here', email: theirs });
    expect(mine).toMatchObject({ ok: `Kim was added. Welcome email sent to ${theirs}.`, data: { outcome: 'sent' } });
    expect(mine!.data!.clientId).not.toBe(theirClient);
    expect(await clientsWith(o.orgId, theirs)).toBe(1);
    expect(await clientsWith(other.orgId, theirs)).toBe(1);
  });

  it('pressing the button again after it worked adds nothing and sends no second email', async () => {
    const o = await makeOrg('QuickRetry');
    signIn(o);
    connectEmail();
    const email = freshEmail('again');
    const first = await add({ firstName: 'Drew', lastName: 'Lane', email });
    expect(first).toMatchObject({ data: { outcome: 'sent' } });
    // The answer speaks only of this press: it neither says nor denies that an email went out the first time.
    const RECENT = (name: string, firstName: string) => `${name} was already added with this email in the last few minutes. This time nothing was added and no email was sent. You can send the welcome link from ${firstName}’s page. ${SHARED}`;
    expect(await add({ firstName: 'Drew', lastName: 'Lane', email })).toEqual({ error: RECENT('Drew Lane', 'Drew'), data: { outcome: 'duplicate', clientId: first!.data!.clientId, first: 'Drew' } });
    expect(await clientsWith(o.orgId, email)).toBe(1);
    expect(handed).toHaveLength(1);
    expect(await invites(first!.data!.clientId!)).toEqual([{ email, live: true }]);

    // The same sentence must be true when no email was ever sent: a lead who came in a minute ago and was never
    // invited, and a client whose welcome email was refused.
    const lead = await addClient(o.orgId, 'Lena Lead', { status: 'lead' });
    const leadEmail = (await withSystem((db) => db.row<{ email: string }>('select email from public.clients where id = $1', [lead])))!.email;
    const again = await add({ firstName: 'Lena', lastName: 'Lead', email: leadEmail });
    expect(again).toEqual({ error: RECENT('Lena Lead', 'Lena'), data: { outcome: 'duplicate', clientId: lead, first: 'Lena' } });
    expect(again!.error).not.toMatch(/sent again|or sent/);
    answer = { status: 403, body: '' };
    const refusedEmail = freshEmail('refused');
    expect(await add({ firstName: 'Ana', lastName: 'Fold', email: refusedEmail })).toMatchObject({ data: { outcome: 'email_failed' } });
    expect((await add({ firstName: 'Ana', lastName: 'Fold', email: refusedEmail }))!.error).toBe(RECENT('Ana Fold', 'Ana'));
    expect(handed).toHaveLength(2); // Drew's, and the one that was refused for Ana: nothing went out for the repeats
  });

  it('staff in two workspaces: the other workspace’s client with this email is not a duplicate here, and is never named', async () => {
    const a = await makeOrg('QuickTwoA');
    const b = await makeOrg('QuickTwoB');
    // The owner of A is also a specialist in B (accepting an invitation with an existing account adds a membership).
    await withSystem((db) => db.run("insert into public.memberships (org_id, user_id, role) values ($1, $2, 'specialist')", [b.orgId, a.ownerId]));
    const email = freshEmail('shared');
    const theirs = await addClient(b.orgId, 'Kim Elsewhere');
    await withSystem((db) => db.run('update public.clients set email = $2 where id = $1', [theirs, email]));
    // Row-level security alone does show this person B's client: it is the workspace in the lookup that keeps it out.
    expect(await asUser(a.ownerId, (db) => db.row<{ n: number }>('select count(*)::int as n from public.clients where email = $1', [email])).then((r) => r!.n)).toBe(1);
    signIn(a);
    const r = await add({ firstName: 'Kim', lastName: 'Here', email });
    expect(JSON.stringify(r)).not.toContain('Kim Elsewhere');
    expect(r).toMatchObject({ ok: expect.stringContaining('Kim was added.'), data: { outcome: 'link' } });
    expect(r!.data!.clientId).not.toBe(theirs);
    expect(await clientsWith(a.orgId, email)).toBe(1);
    expect(await clientsWith(b.orgId, email)).toBe(1);
    // An email that signs in to the OTHER workspace only is no reason to refuse it here either.
    expect(await add({ firstName: 'Olive', lastName: 'Owner', email: b.ownerEmail })).toMatchObject({ data: { outcome: 'link' } });
  });

  it('repeat presses do not use up the workspace’s hourly emails, and at the limit a repeat is still answered as "already added"', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Math.floor(Date.now() / 3_600_000) * 3_600_000 + 60_000);
    try {
      const o = await makeOrg('QuickRepeatLimit'); // as sign-up leaves it: not approved, so its emails are counted
      signIn(o);
      connectEmail();
      const email = freshEmail('again');
      expect(await add({ email })).toMatchObject({ data: { outcome: 'sent' } });
      expect(await hourlyHits(o.orgId)).toBe(1);
      for (let i = 0; i < 3; i++) expect(await add({ email })).toMatchObject({ data: { outcome: 'duplicate' } });
      expect(await hourlyHits(o.orgId)).toBe(1);
      await withSystem((db) => db.run('update public.rate_limits set hits = $2 where key = $1', [`staff-email:org:${o.orgId}`, UNAPPROVED_EMAILS_PER_HOUR]));
      expect(await add({ email })).toMatchObject({ data: { outcome: 'duplicate' } });
      expect(handed.map((m) => m.to)).toEqual([email]);
    } finally { vi.useRealTimers(); }
  });

  it('submissions that arrive at the same moment for one email create one client and send one email', async () => {
    const o = await makeOrg('QuickRace');
    await approveOutreach(o.orgId);
    signIn(o);
    connectEmail();
    for (let round = 0; round < 3; round++) {
      const email = freshEmail(`race${round}`);
      const results = await Promise.all(Array.from({ length: 4 }, () => add({ firstName: 'Robin', lastName: 'Race', email })));
      const sent = results.filter((r) => r?.data?.outcome === 'sent');
      expect(sent, `round ${round}`).toHaveLength(1);
      expect(results.filter((r) => r?.data?.outcome === 'duplicate' && r.error), `round ${round}`).toHaveLength(3);
      // Every refusal names the client the first submission made.
      expect(new Set(results.map((r) => r?.data?.clientId)).size).toBe(1);
      expect(await clientsWith(o.orgId, email)).toBe(1);
      expect(handed.filter((m) => m.to === email)).toHaveLength(1);
      expect(await invites(sent[0]!.data!.clientId!)).toEqual([{ email, live: true }]);
    }
  });
});

describe('invite a client: an email that already signs in to this workspace', () => {
  // One person has one place in a workspace, so such an email could never accept a client's welcome link: the link
  // would end in "You are already a member of this organization". It is refused before anything is created.
  const SELF = 'That is the email you sign in with, so it cannot also be a client’s: one email is one sign-in. Nothing was added. To add yourself as a client, use another email address of yours (for example a second Gmail address).';
  const SELF_TEST = `${SELF} To check that email works, use “Send a test email to me” on Get set up.`;
  const TEAM = 'This email belongs to someone on your team, so it cannot also be a client’s. Nothing was added. Use the client’s own email address.';
  const state = async (orgId: string) => ({
    clients: await count('select count(*)::int as n from public.clients where org_id = $1', [orgId]),
    invites: await count('select count(*)::int as n from public.invites where org_id = $1', [orgId]),
    hits: await hourlyHits(orgId),
  });

  it('your own sign-in email and a colleague’s are refused: nothing is created, sent or counted', async () => {
    const o = await makeOrg('QuickSelf'); // as sign-up leaves it: not approved, so an email that went out would be counted
    // A colleague who joined through a real invitation, with a password of their own.
    const mateEmail = `mate-${uniq()}@example.test`;
    const mateToken = await withSystem((db) => createInviteToken(db, { orgId: o.orgId, email: mateEmail, role: 'specialist', invitedBy: o.ownerId }));
    const mate = await acceptInvite(mateToken, { fullName: 'Morgan Mate', password: 'Mate-Own-Password-5512' }, { ip: testIp() });
    expect(mate.ok).toBe(true);
    signIn(o);
    connectEmail();
    const before = await state(o.orgId);

    // The owner tries the welcome email on themselves, the likeliest first test. Case and spaces do not matter.
    expect(await add({ firstName: 'Avery', lastName: 'Owner', email: `  ${o.ownerEmail.toUpperCase()} ` })).toEqual({ error: SELF_TEST });
    expect(await add({ firstName: 'Morgan', lastName: 'Mate', email: mateEmail })).toEqual({ error: TEAM });
    expect(await state(o.orgId)).toEqual(before);
    expect(handed).toEqual([]);
    // Shown as a refusal with nothing to open: there is no client page to go to.
    const panel = shown({ error: SELF_TEST });
    expect(panel).toContain('role="alert"');
    expect(panel).not.toContain('<a ');

    // With no email service the same holds, in the words that fit: there is no welcome email to see.
    process.env = { ...saved }; resetEnvCache();
    expect(await add({ firstName: 'Avery', lastName: 'Owner', email: o.ownerEmail })).toEqual({ error: SELF });
    expect(await state(o.orgId)).toEqual(before);
  });

  it('every role is told: row-level security lets a specialist see who signs in here, and nothing of another workspace', async () => {
    const o = await makeOrg('QuickSelfSpecialist');
    const specialist = await addMember(o.orgId, 'specialist');
    signIn(o, { role: 'specialist', userId: specialist.id });
    connectEmail();
    // A specialist cannot open Get set up, so is not sent there.
    expect(await add({ email: specialist.email })).toEqual({ error: SELF });
    expect(await add({ email: o.ownerEmail })).toEqual({ error: TEAM });
    expect(await count('select count(*)::int as n from public.clients where org_id = $1', [o.orgId])).toBe(0);
    expect(handed).toEqual([]);
  });

  it('the portal sign-in of a client whose email on file has changed: refused, with the way to that client', async () => {
    const o = await makeOrg('QuickPortalEmail');
    signIn(o);
    // Jordan joined the portal with one address; staff later changed the email on file to another.
    const joined = freshEmail('jordan-old');
    const first = await add({ firstName: 'Jordan', lastName: 'Rivera', email: joined });
    expect((await acceptInvite(tokenOf(first!.data!.link!), { fullName: 'Jordan Rivera', password: 'Jordan-Own-Password-7781' }, { ip: testIp() })).ok).toBe(true);
    const id = first!.data!.clientId!;
    await withSystem((db) => db.run('update public.clients set email = $2 where id = $1', [id, freshEmail('jordan-new')]));
    const before = await state(o.orgId);
    // No client record carries the old address any more, yet a link for it could never be accepted.
    const r = await add({ firstName: 'Jody', lastName: 'Rivera', email: joined });
    expect(r).toEqual({
      error: `This email is the portal sign-in of Jordan Rivera, a client who is already in your workspace. Nothing was added and no email was sent. ${SHARED}`,
      data: { outcome: 'duplicate', clientId: id, first: 'Jordan' },
    });
    expect(await state(o.orgId)).toEqual(before);
    expect(shown(r)).toContain(`href="/app/clients/${id}#welcome"`);

    // A portal sign-in with no client record behind it is still refused, in words that fit.
    const stray = await addMember(o.orgId, 'client', 'portal');
    expect(await add({ firstName: 'Pia', lastName: 'Portal', email: stray.email })).toEqual({
      error: 'This email already has a client portal sign-in in your workspace, so it cannot be used for a new client. Nothing was added. Use a different email address.',
    });
    expect(await state(o.orgId)).toEqual(before);
  });

  it('someone who signs in only elsewhere is still invited, and joins with the password they already have', async () => {
    const o = await makeOrg('QuickHere');
    const elsewhere = await makeOrg('QuickElsewhere');
    signIn(o);
    const r = await add({ firstName: 'Olive', lastName: 'Elsewhere', email: elsewhere.ownerEmail });
    expect(r).toMatchObject({ data: { outcome: 'link' } });
    expect(await acceptInvite(tokenOf(r!.data!.link!), { fullName: 'Olive Elsewhere', password: PASSWORD }, { ip: testIp() })).toMatchObject({ ok: true, role: 'client' });
    // Now Olive is a client here with portal access: the same email again is answered as the client it is.
    expect((await add({ firstName: 'Olive', lastName: 'Elsewhere', email: elsewhere.ownerEmail }))!.error).toContain('Olive already has portal access.');
  });
});

describe('invite a client: refused before anything is created', () => {
  const REFUSED = 'This workspace can send 50 emails an hour until the platform operator has approved it. Try again later. To add the client now without sending an email, use “Add and get the link”.';
  it('the workspace’s hourly email limit: no client, no link and no email', async () => {
    // The limit counts per clock hour. The clock stands still for this test, a minute into the current hour.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Math.floor(Date.now() / 3_600_000) * 3_600_000 + 60_000);
    try {
      const o = await makeOrg('QuickLimit'); // as sign-up leaves it: not approved
      signIn(o);
      connectEmail();
      // The workspace has sent its 50 emails for this hour.
      await withSystem((db) => db.run('insert into public.rate_limits (key, window_start, hits) values ($1, $2, $3)', [`staff-email:org:${o.orgId}`, new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000), UNAPPROVED_EMAILS_PER_HOUR]));
      const email = freshEmail('late');
      expect(await add({ firstName: 'Lee', lastName: 'Moreno', email })).toEqual({ error: REFUSED });
      expect(await clientsWith(o.orgId, email)).toBe(0);
      expect(await count('select count(*)::int as n from public.clients where org_id = $1', [o.orgId])).toBe(0);
      expect(await count('select count(*)::int as n from public.invites where org_id = $1', [o.orgId])).toBe(0);
      expect(handed).toEqual([]);
      // Once the operator has approved the workspace there is no hourly limit.
      await approveOutreach(o.orgId);
      expect(await add({ firstName: 'Lee', lastName: 'Moreno', email })).toMatchObject({ ok: `Lee was added. Welcome email sent to ${email}.` });
      expect(handed.map((m) => m.to)).toEqual([email]);
    } finally { vi.useRealTimers(); }
  });

  it('a personal workspace has no client to invite', async () => {
    const r = await signUp({ email: `self-${uniq()}@test.dev`, password: PASSWORD, fullName: 'Robin Self', orgName: `Robin ${uniq()}`, mode: 'personal' }, { ip: testIp() });
    if (!r.ok) throw new Error(r.error);
    const me: TestOrg = { orgId: r.orgId, ownerId: r.userId, ownerEmail: 'self@test.dev' };
    const before = await count('select count(*)::int as n from public.clients where org_id = $1', [me.orgId]);
    signIn(me, { orgMode: 'personal' });
    connectEmail();
    const email = freshEmail('nobody');
    expect(await add({ email })).toEqual({ error: 'A personal workspace has no clients to invite.' });
    expect(await count('select count(*)::int as n from public.clients where org_id = $1', [me.orgId])).toBe(before);
    expect(await clientsWith(me.orgId, email)).toBe(0);
    expect(handed).toEqual([]);
  });

  it('a role without the permission to add clients is turned away', async () => {
    const o = await makeOrg('QuickDenied');
    connectEmail();
    const email = freshEmail('denied');
    // No staff role lacks it today (src/lib/rbac.ts), so one is stood in for; the client role never has it.
    signIn(o, { role: 'specialist', lacks: 'clients:write' });
    await expect(add({ email })).rejects.toThrow('REDIRECT /app?denied=1');
    const portalUser = await addMember(o.orgId, 'client', 'portal');
    signIn(o, { role: 'client', userId: portalUser.id });
    await expect(add({ email })).rejects.toThrow('REDIRECT /app?denied=1');
    expect(await clientsWith(o.orgId, email)).toBe(0);
    expect(handed).toEqual([]);
  });

  it('a missing name or an email that is not one is refused in plain words', async () => {
    const o = await makeOrg('QuickInput');
    signIn(o);
    connectEmail();
    expect(await add({ lastName: '   ' })).toEqual({ error: 'Enter the client’s first name and last name.' });
    expect(await add({ firstName: '' })).toEqual({ error: 'Enter the client’s first name and last name.' });
    expect(await add({ email: '' })).toEqual({ error: 'Enter the client’s email address. The welcome email goes to it.' });
    expect(await quickAddClientAction(undefined, form({ firstName: 'Dana', lastName: 'Whitfield' }))).toEqual({ error: 'Enter the client’s email address. The welcome email goes to it.' });
    expect(await add({ email: 'dana at example dot test' })).toEqual({ error: 'That email address does not look right. Check it and try again.' });
    // A name nobody can see is not a name: characters that take no space on the page.
    for (const invisible of ['​', '​​ ⁠', '﻿', '‍', '­‎']) {
      expect(await add({ firstName: invisible }), JSON.stringify(invisible)).toEqual({ error: 'Enter the client’s first name and last name.' });
      expect(await add({ lastName: invisible }), JSON.stringify(invisible)).toEqual({ error: 'Enter the client’s first name and last name.' });
    }
    // More than a field holds (the page's own limits stop this; a request that bypasses them is answered in a sentence too).
    expect(await add({ firstName: 'D'.repeat(80) })).toEqual({ error: 'That name is too long. Use up to 79 characters for the first name and for the last name.' });
    expect(await add({ lastName: 'W'.repeat(80) })).toEqual({ error: 'That name is too long. Use up to 79 characters for the first name and for the last name.' });
    expect(await add({ email: `${'d'.repeat(250)}@example.test` })).toEqual({ error: 'That email address does not look right. Check it and try again.' });
    expect(await add({ email: freshEmail('long-phone'), phone: '8'.repeat(31) })).toEqual({ error: 'That phone number is too long. Use up to 30 characters.' });
    expect(await count('select count(*)::int as n from public.clients where org_id = $1', [o.orgId])).toBe(0);
    expect(handed).toEqual([]);
    // The longest names that fit are accepted, and the full name fits the record.
    const longest = await add({ firstName: 'D'.repeat(79), lastName: 'W'.repeat(79), email: freshEmail('longest') });
    expect(longest).toMatchObject({ data: { outcome: 'sent' } });
    expect(await clientRow(longest!.data!.clientId!)).toMatchObject({ full_name: `${'D'.repeat(79)} ${'W'.repeat(79)}` });

    // With no email service, a missing email is asked for without a word about a welcome email.
    process.env = { ...saved }; resetEnvCache();
    expect(await add({ email: '' })).toEqual({ error: 'Enter the client’s email address. Their portal account is made for it.' });
  });
});

describe('what the page shows for each outcome', () => {
  const id = '6b0f6f0e-3c1d-4a52-9d57-0f1a2b3c4d5e';
  const link = 'https://app.example.com/invite/abc_DEF-123';
  const who = { clientId: id, first: 'Dana' };

  it('nothing before the button is pressed', () => {
    expect(shown(undefined)).toBe('');
  });

  it('sent: green, with the client’s page; there is no link to copy and nothing to enter by hand', () => {
    const h = shown({ ok: 'Dana was added. Welcome email sent to dana@example.test.', data: { outcome: 'sent', ...who } });
    for (const part of ['bg-ok-soft', 'Dana was added. Welcome email sent to dana@example.test.', `href="/app/clients/${id}"`, 'Open Dana’s page']) expect(h, part).toContain(part);
    for (const part of ['Copy link', 'Text it from your phone', '/edit', 'role="alert"']) expect(h, part).not.toContain(part);
  });

  it('a link to pass on by hand: the link, Copy, the text link only with a phone number, both ways on', () => {
    const noPhone = shown({ ok: 'Dana was added.', data: { outcome: 'link', ...who, link } });
    for (const part of ['bg-info-soft', link, 'Copy link', 'Open Dana’s page', `href="/app/clients/${id}/edit"`, 'Enter Dana’s details yourself']) expect(noPhone, part).toContain(part);
    expect(noPhone).not.toContain('Text it from your phone');
    const failed = shown({ ok: 'Dana was added, but the welcome email was not sent.', data: { outcome: 'email_failed', ...who, link, sms: 'sms:+18135550142?body=Hello%20Dana' } });
    for (const part of ['bg-warn-soft', link, 'Copy link', 'href="sms:+18135550142?body=Hello%20Dana"', 'Text it from your phone', 'Enter Dana’s details yourself']) expect(failed, part).toContain(part);
    expect(failed).not.toContain('bg-ok-soft');
  });

  it('the email service did not answer: a warning with the client’s page, and no link', () => {
    const h = shown({ ok: 'Dana was added. The email service did not answer.', data: { outcome: 'unconfirmed', ...who } });
    for (const part of ['bg-warn-soft', 'Open Dana’s page']) expect(h, part).toContain(part);
    for (const part of ['Copy link', 'Text it from your phone', '/edit', 'bg-ok-soft']) expect(h, part).not.toContain(part);
  });

  it('"Open …’s page" goes straight to the Welcome link card when the message sends the person there, and to the top of the page otherwise', () => {
    const href = (state: ActionState) => /href="(\/app\/clients\/[0-9a-f-]{36}[^"/]*)"/.exec(shown(state))![1];
    // The buttons to send the link (again) are on that card: no answer, a link that could not be made, a client who is already here.
    for (const outcome of ['unconfirmed', 'added']) expect(href({ ok: 'Dana was added.', data: { outcome, ...who } }), outcome).toBe(`/app/clients/${id}#welcome`);
    expect(href({ error: 'A client with this email is already in your workspace: Pat Quinn.', data: { outcome: 'duplicate', clientId: id, first: 'Pat' } })).toBe(`/app/clients/${id}#welcome`);
    // Sent, or a link that is already on this page to pass on: the client's page opens as usual.
    expect(href({ ok: 'Dana was added.', data: { outcome: 'sent', ...who } })).toBe(`/app/clients/${id}`);
    for (const outcome of ['link', 'email_failed']) expect(href({ ok: 'Dana was added.', data: { outcome, ...who, link } }), outcome).toBe(`/app/clients/${id}`);
  });

  it('the text link says what it needs, and only when there is one', () => {
    const NEEDS = '“Text it from your phone” opens your texting app, so use it with this page open on your phone. On a computer, copy the link.';
    expect(shown({ ok: 'Dana was added.', data: { outcome: 'link', ...who, link, sms: 'sms:+18135550142?body=Hello%20Dana' } })).toContain(NEEDS);
    expect(shown({ ok: 'Dana was added.', data: { outcome: 'link', ...who, link } })).not.toContain('texting app');
    expect(shown({ ok: 'Dana was added.', data: { outcome: 'sent', ...who } })).not.toContain('texting app');
  });

  it('nothing was added: an alert, with the page of the client who is already there when there is one', () => {
    const dup = shown({ error: 'A client with this email is already in your workspace: Pat Quinn.', data: { outcome: 'duplicate', clientId: id, first: 'Pat' } });
    for (const part of ['role="alert"', 'bg-bad-soft', 'already in your workspace: Pat Quinn.', `href="/app/clients/${id}#welcome"`, 'Open Pat’s page']) expect(dup, part).toContain(part);
    expect(dup).not.toContain('/edit');
    const plain = shown({ error: 'Enter the client’s first name and last name.' });
    expect(plain).toContain('role="alert"');
    expect(plain).not.toContain('<a ');
  });
});

describe('the New client page', () => {
  const page = async (q: { manual?: string } = {}) => renderToStaticMarkup(await NewClientPage({ searchParams: Promise.resolve(q) }) as React.ReactElement);

  it('an agency lands on "Invite a client"; the page says before the click when email is not connected, and the button says what it does', async () => {
    const o = await makeOrg('QuickPage');
    signIn(o);
    const off = await page();
    for (const s of ['Invite a client', 'First name', 'Last name', 'Email is not connected yet.', 'No welcome email will be sent.', 'Add client and get the link', 'href="/app/setup"', 'href="/app/clients/new?manual=1"', 'Enter everything yourself']) expect(off, s).toContain(s);
    for (const s of ['Send welcome email', 'Full legal name', 'Create client']) expect(off, s).not.toContain(s);
    // Whoever cannot open Get set up is not sent there, and is told who can connect email.
    const specialist = await addMember(o.orgId, 'specialist');
    signIn(o, { role: 'specialist', userId: specialist.id });
    const asSpecialist = await page();
    expect(asSpecialist).not.toContain('href="/app/setup"');
    expect(asSpecialist).toContain('An owner or admin can connect it from Get set up.');
    expect(off).not.toContain('An owner or admin can connect it');

    signIn(o);
    connectEmail();
    const on = await page();
    for (const s of ['Invite a client', 'Send welcome email', 'Add and get the link', 'Email them a welcome link, or get the link']) expect(on, s).toContain(s);
    for (const s of ['Email is not connected', 'Add client and get the link', 'Full legal name']) expect(on, s).not.toContain(s);
  });

  it('the way to the full form is in the page header, where it is on screen when the page opens, and is one link only', async () => {
    const o = await makeOrg('QuickHeader');
    signIn(o);
    const h = await page();
    // In the header (before the card); the line under the card says when to use it without a second link.
    const header = h.slice(0, h.indexOf('<h2'));
    expect(header).toContain('</header>');
    expect(header).toMatch(/<a [^>]*href="\/app\/clients\/new\?manual=1"[^>]*>Enter everything yourself<\/a>[^]*<\/header>/);
    expect(h.split('href="/app/clients/new?manual=1"')).toHaveLength(2);
    expect(h).toContain('No email address, or signed papers in front of you? Use “Enter everything yourself” at the top of this page.');
  });

  it('says before the click when clients cannot sign the service agreement yet, and where to change that', async () => {
    const o = await makeOrg('QuickTerms'); // a new workspace: no client agreement terms saved
    signIn(o);
    const owner = await page();
    for (const s of ['Your client agreement terms are not saved yet.', 'A client you invite now can fill in their details and upload their ID, but cannot sign the service agreement until the terms are saved.',
      'href="/app/settings#agreement"', 'Open Settings → Client agreement']) expect(owner, s).toContain(s);
    // Whoever cannot open Settings is told who can.
    const specialist = await addMember(o.orgId, 'specialist');
    signIn(o, { role: 'specialist', userId: specialist.id });
    const sp = await page();
    for (const s of ['Your client agreement terms are not saved yet.', 'Ask an owner or admin to save them in Settings → Client agreement.']) expect(sp, s).toContain(s);
    expect(sp).not.toContain('href="/app/settings#agreement"');

    // Terms that were saved but no longer pass today's checks: a different sentence, the same way out.
    await saveTerms(o.orgId, { ...TERMS, paymentTerms: 'We guarantee to remove every negative item. $99 due today before any work.' });
    signIn(o);
    const stale = await page();
    for (const s of ['Your client agreement terms need a change.', 'cannot sign the service agreement until the terms are changed', 'href="/app/settings#agreement"']) expect(stale, s).toContain(s);
    expect(stale).not.toContain('are not saved yet');
    signIn(o, { role: 'specialist', userId: specialist.id });
    expect(await page()).toContain('Ask an owner or admin to change them in Settings → Client agreement.');

    // Saved terms that pass: nothing is said.
    await saveTerms(o.orgId);
    signIn(o);
    const ready = await page();
    for (const s of ['client agreement terms', 'cannot sign the service agreement', '/app/settings#agreement']) expect(ready, s).not.toContain(s);
    expect(ready).toContain('Invite a client');
    // The full form is not the quick invite: it has its own refusal when consents are recorded without terms.
    await withSystem((db) => db.run("update public.organizations set settings = settings - 'agreement' where id = $1", [o.orgId]));
    expect(await page({ manual: '1' })).not.toContain('Your client agreement terms are not saved yet.');
  });

  it('"Enter everything yourself" is the full form at the same address, with the way back', async () => {
    const o = await makeOrg('QuickManual');
    signIn(o);
    const h = await page({ manual: '1' });
    for (const s of ['Full legal name', 'Mailing address', 'Consents &amp; portal', 'Create client', 'href="/app/clients/new"', 'Invite a client instead']) expect(h, s).toContain(s);
    for (const s of ['Add client and get the link', 'Send welcome email', 'First name']) expect(h, s).not.toContain(s);
  });

  it('a personal workspace only ever sees the full form, as before', async () => {
    const r = await signUp({ email: `self-${uniq()}@test.dev`, password: PASSWORD, fullName: 'Sam Self', orgName: `Sam ${uniq()}`, mode: 'personal' }, { ip: testIp() });
    if (!r.ok) throw new Error(r.error);
    signIn({ orgId: r.orgId, ownerId: r.userId, ownerEmail: 'self@test.dev' }, { orgMode: 'personal' });
    for (const q of [{}, { manual: '1' }]) {
      const h = await page(q);
      for (const s of ['Full legal name', 'Create client', 'href="/app/clients"']) expect(h, s).toContain(s);
      for (const s of ['Invite a client', 'Enter everything yourself', 'Consents &amp; portal', 'Add client and get the link']) expect(h, s).not.toContain(s);
    }
  });
});

describe('invite a client: get the link instead of emailing it', () => {
  it('with email connected, “Add and get the link” adds the client and returns a working link; nothing is emailed or counted', async () => {
    const o = await makeOrg('QuickLinkOnly');
    signIn(o);
    connectEmail();
    const email = freshEmail();
    const before = await hourlyHits(o.orgId);
    const r = await quickAddClientAction(undefined, form({ firstName: 'Dana', lastName: 'Whitfield', email, via: 'link' }));
    expect(r?.error).toBeUndefined();
    expect(r?.ok).toBe('Dana was added. No email was sent. Send Dana this link yourself. It works once and expires in 7 days.');
    const data = r!.data as { outcome: string; clientId: string; link: string };
    expect(data.outcome).toBe('link');
    expect(handed).toEqual([]);
    expect(await hourlyHits(o.orgId)).toBe(before);
    expect(await invites(data.clientId)).toEqual([{ email, live: true }]);
    // The link works: the client sets a password and is linked to their record.
    const ok = await acceptInvite(tokenOf(data.link), { fullName: 'Dana Whitfield', password: 'Dana-Own-Password-8841' }, { ip: testIp() });
    expect(ok.ok).toBe(true);
    expect((await clientRow(data.clientId) as { portal_user_id: string | null }).portal_user_id).not.toBeNull();
  });
});

describe('welcome link for a client whose email is a team sign-in', () => {
  it('is refused with what to do, instead of making a link that could never be accepted', async () => {
    const o = await makeOrg('QuickTeamEmail');
    signIn(o);
    connectEmail();
    // Added before this check existed, or edited later to the owner's own sign-in email.
    const c = await addClient(o.orgId, 'Avery Owner');
    await withSystem((db) => db.run('update public.clients set email = $2 where id = $1', [c, o.ownerEmail]));
    const r = await emailWelcomeLinkAction(undefined, form({ clientId: c }));
    expect(r?.error).toContain('This email is a sign-in for your team');
    expect(handed).toEqual([]);
    expect(await invites(c)).toEqual([]);
  });
});
