import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Ctx } from '@/lib/auth/context';
import type { SessionInfo } from '@/lib/auth/service';
import { resetEnvCache } from '@/lib/env';
import { can, type Role } from '@/lib/rbac';
import { addClient, approveOutreach, asUser, closePool, makeOrg, uniq, withSystem, type TestOrg } from './helpers';

// The three things staff do that email an address on a client or lead record, run as the server runs them, with the
// real queries under row-level security. Only the sign-in step is stood in for, and the email service's HTTP API: the
// real driver is used, and nothing leaves the machine.
const signedIn = vi.hoisted(() => ({ ctx: null as unknown }));
vi.mock('@/lib/auth/context', () => ({
  requireStaff: async (perm?: string) => {
    const ctx = signedIn.ctx as { can(p: string): boolean };
    if (perm && !ctx.can(perm)) throw new Error('REDIRECT /app?denied=1');
    return ctx;
  },
}));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));

import { createClientAction, invitePortalAction, sendMessageAction } from '@/app/app/clients/actions';

const saved = { ...process.env };
afterAll(async () => { process.env = { ...saved }; resetEnvCache(); await closePool(); });

const REFUSED = 'This workspace can send 50 emails an hour until the platform operator has approved it. Try again later.';
/** Every email handed to the stand-in for the email service's API, as it would leave. */
let handed: { to: string; subject: string; text: string }[] = [];
beforeEach(() => {
  Object.assign(process.env, { EMAIL_DRIVER: 'resend', RESEND_API_KEY: 're_test_key_for_vitest' });
  resetEnvCache();
  handed = [];
  vi.stubGlobal('fetch', async (url: string | URL, init?: RequestInit) => {
    if (String(url) !== 'https://api.resend.com/emails') throw new Error(`unexpected request to ${String(url)}`);
    const b = JSON.parse(String(init?.body ?? '{}')) as { to: string[]; subject: string; text: string };
    handed.push({ to: b.to[0]!, subject: b.subject, text: b.text });
    return new Response(JSON.stringify({ id: `re_${uniq()}` }), { status: 200 });
  });
});
afterEach(() => { vi.unstubAllGlobals(); process.env = { ...saved }; resetEnvCache(); });

function signIn(o: TestOrg, role: Role = 'owner'): void {
  const session: SessionInfo = { sessionId: 's', userId: o.ownerId, orgId: o.orgId, role, email: o.ownerEmail, fullName: 'Test Person', mfaVerified: true, totpEnabled: false, orgName: 'Staff Email Test', orgSlug: 'staff-email-test', orgMode: 'agency', orgPlan: 'trial' };
  const ctx: Ctx = { session, userId: o.ownerId, orgId: o.orgId, role, tx: (fn) => asUser(o.ownerId, fn), can: (p) => can(role, p), need: () => undefined, meta: { ip: '10.0.0.1', userAgent: 'vitest' } };
  signedIn.ctx = ctx;
}
const form = (fields: Record<string, string>) => { const fd = new FormData(); for (const [k, v] of Object.entries(fields)) fd.set(k, v); return fd; };
const message = (clientId: string, body = 'Hello from the team.') => sendMessageAction({}, form({ clientId, channel: 'email', subject: 'A message', body }));
const invite = (clientId: string) => invitePortalAction({}, form({ clientId }));
const newClient = (email: string) => createClientAction({}, form({ fullName: 'Nora Vance', email, preferredLanguage: 'en', status: 'lead', invite: 'on' }));
const count = (sql: string, p: unknown[]) => withSystem((db) => db.row<{ n: number }>(sql, p as never[])).then((r) => r!.n);

describe('staff email to clients and leads, before the platform operator has approved the workspace', () => {
  it('the invitation, a message and a new client with an invitation share one limit of 50 an hour; after that each is refused and nothing is sent or created', async () => {
    // The limit counts per clock hour. The clock stands still for this test, a minute into the current hour, so the
    // hour cannot turn while it runs.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Math.floor(Date.now() / 3_600_000) * 3_600_000 + 60_000);
    try { await limitHolds(); } finally { vi.useRealTimers(); }
  });
  async function limitHolds() {
    const o = await makeOrg('StaffEmailLimit'); // as sign-up leaves it: not approved
    signIn(o);
    const lead = await addClient(o.orgId, 'Pat Lead', { status: 'lead' });
    const other = await addClient(o.orgId, 'Sam Other', { status: 'lead' });
    for (let i = 0; i < 48; i++) expect(await message(lead), `message ${i + 1}`).toEqual({ ok: 'Email sent.' });
    expect(await invite(lead)).toMatchObject({ ok: expect.stringMatching(/^Invitation emailed to /) });
    // The new client is created and the invitation sent; the action then opens the client's page.
    await expect(newClient(`nora-${uniq()}@example.test`)).rejects.toMatchObject({ digest: expect.stringMatching(/^NEXT_REDIRECT;.*\/app\/clients\//) });
    expect(handed).toHaveLength(50);

    // The 51st, whichever action it is: refused in plain words, nothing handed to the email service, nothing created.
    const before = { comms: await count('select count(*)::int as n from public.communications where org_id = $1', [o.orgId]), clients: await count('select count(*)::int as n from public.clients where org_id = $1', [o.orgId]), invites: await count('select count(*)::int as n from public.invites where org_id = $1', [o.orgId]) };
    expect(await message(lead)).toEqual({ error: REFUSED });
    expect(await invite(other)).toEqual({ error: REFUSED });
    expect(await newClient(`late-${uniq()}@example.test`)).toEqual({ error: REFUSED });
    expect(handed).toHaveLength(50);
    expect({ comms: await count('select count(*)::int as n from public.communications where org_id = $1', [o.orgId]), clients: await count('select count(*)::int as n from public.clients where org_id = $1', [o.orgId]), invites: await count('select count(*)::int as n from public.invites where org_id = $1', [o.orgId]) }).toEqual(before);
    // What does not email anyone is not held back: a note of a call is still logged.
    expect(await sendMessageAction({}, form({ clientId: lead, channel: 'note_call', body: 'Called them back.' }))).toMatchObject({ ok: expect.stringMatching(/^Logged/) });

    // Once the operator has approved the workspace, staff email works as it did before: no hourly limit.
    await approveOutreach(o.orgId);
    for (let i = 0; i < 3; i++) expect(await message(lead)).toEqual({ ok: 'Email sent.' });
    expect(await invite(other)).toMatchObject({ ok: expect.stringMatching(/^Invitation emailed to /) });
    expect(handed).toHaveLength(54);
  }

  it('the invitation greets the client by a first name only when it reads as one', async () => {
    const o = await makeOrg('StaffEmailGreeting');
    await approveOutreach(o.orgId);
    signIn(o);
    const dana = await addClient(o.orgId, 'Dana Whitfield', { status: 'lead' });
    const odd = await addClient(o.orgId, 'www.claim-your-refund.example Team', { status: 'lead' });
    for (const id of [dana, odd]) expect(await invite(id)).toMatchObject({ ok: expect.stringMatching(/^Invitation emailed to /) });
    expect(handed.map((m) => m.text.split('\n')[0])).toEqual(['Hello Dana,', 'Hello,']);
    await expect(newClient(`nora-${uniq()}@example.test`)).rejects.toMatchObject({ digest: expect.stringMatching(/^NEXT_REDIRECT/) });
    expect(handed.at(-1)!.text.split('\n')[0]).toBe('Hello Nora,');
  });
});
