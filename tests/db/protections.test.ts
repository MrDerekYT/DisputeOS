import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { protectionTicks, setProtectionTick } from '@/lib/credit/protections';
import { addMember, addPortalClient, asUser, closePool, makeOrg, withSystem, type TestOrg } from './helpers';

const TODAY = '2026-11-19';
let A: TestOrg;
let B: TestOrg;
let mine: { userId: string; clientId: string };
let other: { userId: string; clientId: string };
let foreign: { userId: string; clientId: string };
let staffId: string;

const stored = async (clientId: string) =>
  (await withSystem((db) => db.row<{ file_protections: unknown }>('select file_protections from public.clients where id = $1', [clientId])))!.file_protections;

beforeAll(async () => {
  A = await makeOrg('Protect');
  B = await makeOrg('Elsewhere');
  mine = await addPortalClient(A.orgId, 'Jordan Rivera');
  other = await addPortalClient(A.orgId, 'Sam Other');
  foreign = await addPortalClient(B.orgId, 'Pat Foreign');
  staffId = (await addMember(A.orgId, 'specialist')).id;
});
afterAll(closePool);

describe('migration 0022: the client’s own “Protect your file” ticks', () => {
  it('gives every existing client an empty list', async () => {
    expect(await stored(mine.clientId)).toEqual({});
  });

  it('lets a portal client tick and clear on their own record', async () => {
    await asUser(mine.userId, (db) => setProtectionTick(db, mine.clientId, 'experian_freeze', '2026-11-18', TODAY));
    await asUser(mine.userId, (db) => setProtectionTick(db, mine.clientId, 'optoutprescreen', TODAY, TODAY));
    expect(protectionTicks(await stored(mine.clientId))).toEqual({ experian_freeze: '2026-11-18', optoutprescreen: TODAY });
    // The client reads their own ticks back under row-level security.
    const seen = await asUser(mine.userId, (db) => db.row<{ file_protections: unknown }>('select file_protections from public.clients where id = $1', [mine.clientId]));
    expect(protectionTicks(seen!.file_protections)).toHaveProperty('experian_freeze', '2026-11-18');
    await asUser(mine.userId, (db) => setProtectionTick(db, mine.clientId, 'optoutprescreen', null, TODAY));
    expect(await stored(mine.clientId)).toEqual({ experian_freeze: '2026-11-18' });
  });

  it('does not let a portal client tick anyone else’s record, in their organization or another', async () => {
    for (const target of [other.clientId, foreign.clientId]) {
      // Row-level security hides the row, so the update touches nothing.
      await asUser(mine.userId, (db) => setProtectionTick(db, target, 'experian_freeze', TODAY, TODAY));
      expect(await stored(target)).toEqual({});
      expect(await asUser(mine.userId, (db) => db.row('select id from public.clients where id = $1', [target]))).toBeFalsy();
    }
  });

  it('does not let staff tick for a client, while staff can read the ticks and still edit the rest of the record', async () => {
    await expect(asUser(staffId, (db) => setProtectionTick(db, mine.clientId, 'equifax_freeze', TODAY, TODAY))).rejects.toThrow(/only the client/);
    await expect(asUser(staffId, (db) => setProtectionTick(db, mine.clientId, 'experian_freeze', null, TODAY))).rejects.toThrow(/only the client/);
    const read = await asUser(staffId, (db) => db.row<{ file_protections: unknown }>('select file_protections from public.clients where id = $1', [mine.clientId]));
    expect(protectionTicks(read!.file_protections)).toEqual({ experian_freeze: '2026-11-18' });
    await asUser(staffId, (db) => db.run("update public.clients set phone = '555-0100' where id = $1", [mine.clientId]));
    expect(await stored(mine.clientId)).toEqual({ experian_freeze: '2026-11-18' });
  });

  it('refuses anything that is not option -> day, even from the client', async () => {
    const write = (json: string) => asUser(mine.userId, (db) => db.run('update public.clients set file_protections = $2::jsonb where id = $1', [mine.clientId, json]));
    await expect(write('[]')).rejects.toThrow(/must map an option to a day/);
    await expect(write('{"experian_freeze": {"password": "hunter2"}}')).rejects.toThrow(/must map an option to a day/);
    await expect(write('{"experian_freeze": "my PIN is 1234"}')).rejects.toThrow(/must map an option to a day/);
    await expect(write('{"Not A Key!": "2026-11-19"}')).rejects.toThrow(/must map an option to a day/);
    expect(await stored(mine.clientId)).toEqual({ experian_freeze: '2026-11-18' });
  });

  it('still keeps the portal client away from the staff-only columns', async () => {
    await expect(asUser(mine.userId, (db) => db.run("update public.clients set specialty_reports = '{\"chexsystems\":{\"status\":\"received\"}}' where id = $1", [mine.clientId]))).rejects.toThrow(/portal users may only update/);
  });
});
