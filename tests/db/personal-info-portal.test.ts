import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Ctx } from '@/lib/auth/context';
import type { SessionInfo } from '@/lib/auth/service';
import { addMark, loadMarks } from '@/lib/credit/personal-info';
import { addPortalClient, asUser, closePool, makeOrg, withSystem, type TestOrg } from './helpers';

// The portal action runs here as it does on the server, with the real queries under row-level security. Only the
// sign-in step is stood in for: `requireClient` returns a context for a real portal user of a real test workspace.
const signedIn = vi.hoisted(() => ({ ctx: null as unknown }));
vi.mock('@/lib/auth/context', () => ({ requireClient: async () => signedIn.ctx }));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));

import { portalAddPersonalInfoAction } from '@/app/portal/personal-info-actions';

let A: TestOrg;
let client: string;
let portalUser: string;
const staff = () => ({ orgId: A.orgId, userId: A.ownerId, source: 'staff' as const });
const self = () => ({ orgId: A.orgId, userId: portalUser, source: 'client' as const });
const marks = async () => (await asUser(A.ownerId, (db) => loadMarks(db, client))).map((m) => [m.bureau, m.kind, m.value, m.issue, m.correctValue, m.source]);
const form = (fields: Record<string, string>) => { const fd = new FormData(); for (const [k, v] of Object.entries(fields)) fd.set(k, v); return fd; };

beforeAll(async () => {
  A = await makeOrg('MarkOrg');
  const p = await addPortalClient(A.orgId, 'Mark Client');
  client = p.clientId; portalUser = p.userId;
  const session: SessionInfo = { sessionId: 's', userId: portalUser, orgId: A.orgId, role: 'client', email: 'c@client.dev', fullName: 'Mark Client', mfaVerified: true, totpEnabled: false, orgName: 'MarkOrg', orgSlug: 'markorg', orgMode: 'agency', orgPlan: 'trial' };
  const ctx: Ctx & { clientId: string } = { session, userId: portalUser, orgId: A.orgId, role: 'client', tx: (fn) => asUser(portalUser, fn), can: () => false, need: () => undefined, meta: { ip: '10.0.0.1', userAgent: 'vitest' }, clientId: client };
  signedIn.ctx = ctx;
});
afterAll(closePool);

const STAFF_ENTRY = ['experian', 'address', '12 Oak St, Austin TX', 'not_mine', null, 'staff'];
const CLIENT_ANSWER = { bureau: 'experian', kind: 'address', value: ' 12 oak st, austin tx ', issue: 'incorrect', correctValue: '12 Oak Street, Apt 4, Austin TX' };

describe('a client lists an entry their team already marked', () => {
  it('addMark tells its caller whether anything was written', async () => {
    expect(await asUser(A.ownerId, (db) => addMark(db, staff(), client, { bureau: 'experian', kind: 'address', value: '12 Oak St, Austin TX', issue: 'not_mine' }))).toBe(true);
    // The client's answer about the same entry, however it is typed, is not written: a client cannot replace what staff said.
    expect(await asUser(portalUser, (db) => addMark(db, self(), client, CLIENT_ANSWER))).toBe(false);
    expect(await marks()).toEqual([STAFF_ENTRY]);
    // An entry of their own is written, and written again when they change their answer.
    expect(await asUser(portalUser, (db) => addMark(db, self(), client, { bureau: 'experian', kind: 'phone', value: '(512) 555-0199', issue: 'not_mine' }))).toBe(true);
    expect(await asUser(portalUser, (db) => addMark(db, self(), client, { bureau: 'experian', kind: 'phone', value: '(512) 555-0199', issue: 'incorrect', correctValue: '(512) 555-0100' }))).toBe(true);
    expect(await marks()).toEqual([STAFF_ENTRY, ['experian', 'phone', '(512) 555-0199', 'incorrect', '(512) 555-0100', 'client']]);
    // Staff replace an answer the client gave.
    expect(await asUser(A.ownerId, (db) => addMark(db, staff(), client, { bureau: 'experian', kind: 'phone', value: '(512) 555-0199', issue: 'not_mine' }))).toBe(true);
    expect(await marks()).toEqual([STAFF_ENTRY, ['experian', 'phone', '(512) 555-0199', 'not_mine', null, 'staff']]);
  });

  it('the portal does not answer "Saved" when nothing was saved: it says the team already listed the entry, in the client’s language', async () => {
    const before = await marks();
    expect(await portalAddPersonalInfoAction(undefined, form(CLIENT_ANSWER))).toEqual({ error: 'Your team already listed this entry. Send them a message if it should say something else.' });
    await withSystem((db) => db.run("update public.clients set preferred_language = 'es' where id = $1", [client]));
    expect(await portalAddPersonalInfoAction(undefined, form(CLIENT_ANSWER))).toEqual({ error: 'Su equipo ya anotó este dato. Envíele un mensaje si debería decir otra cosa.' });
    expect(await marks()).toEqual(before);
    // An entry that is saved still says so.
    expect(await portalAddPersonalInfoAction(undefined, form({ bureau: 'equifax', kind: 'employer', value: 'ACME FREIGHT', issue: 'not_mine' }))).toEqual({ ok: 'Guardado.' });
    expect(await marks()).toEqual([['equifax', 'employer', 'ACME FREIGHT', 'not_mine', null, 'client'], ...before]);
  });
});
