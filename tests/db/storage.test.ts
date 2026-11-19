import { randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resetEnvCache } from '@/lib/env';
import { deleteObject, getObject, putObject } from '@/lib/storage';
import { addClient, asUser, closePool, makeOrg, withSystem, type TestOrg } from './helpers';

/** Document storage in the database (STORAGE_DRIVER=db), and the disk driver it sits beside. */
describe('document storage drivers', () => {
  let org: TestOrg;
  let clientId: string;
  const saved = process.env.STORAGE_DRIVER;
  const use = (driver: 'db' | 'disk') => { process.env.STORAGE_DRIVER = driver; resetEnvCache(); };

  beforeAll(async () => {
    org = await makeOrg('Storage');
    clientId = await addClient(org.orgId);
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.STORAGE_DRIVER; else process.env.STORAGE_DRIVER = saved;
    resetEnvCache();
  });
  afterAll(async () => { await closePool(); });

  it('db driver: put, get and delete round-trip the exact bytes', async () => {
    use('db');
    // Every byte value, plus random data and an empty file: bytea must give back exactly what went in.
    for (const bytes of [Buffer.from(Array.from({ length: 256 }, (_, i) => i)), randomBytes(300_000), Buffer.alloc(0)]) {
      const key = await putObject(org.orgId, clientId, bytes);
      expect(key).toMatch(new RegExp(`^${org.orgId}/${clientId}/[0-9a-f-]{36}\\.bin$`));
      const back = await getObject(key);
      expect(back.equals(bytes)).toBe(true);
      await deleteObject(key);
      await expect(getObject(key)).rejects.toThrow('Stored object not found');
      expect(await withSystem((db) => db.row('select 1 from public.stored_objects where key = $1', [key]))).toBeNull();
      await deleteObject(key); // deleting something already gone is not an error (same as the disk driver)
    }
  });

  it('db driver: what is stored is the encrypted blob, never the plaintext', async () => {
    use('db');
    const secret = Buffer.from('SSN 123-45-6789 '.repeat(50));
    const key = await putObject(org.orgId, clientId, secret);
    const row = await withSystem((db) => db.row<{ bytes: Buffer; size: number; org_id: string }>('select bytes, size, org_id from public.stored_objects where key = $1', [key]));
    expect(row!.org_id).toBe(org.orgId);
    expect(row!.size).toBe(row!.bytes.length);
    expect(row!.bytes.subarray(0, 4).toString()).toBe('DOS1');
    expect(row!.bytes.includes(Buffer.from('123-45-6789'))).toBe(false);
    await deleteObject(key);
  });

  it('db driver: the tenant role cannot read, add, change or remove stored objects', async () => {
    use('db');
    const key = await putObject(org.orgId, clientId, Buffer.from('private'));
    const denied = /permission denied for table stored_objects/;
    await expect(asUser(org.ownerId, (db) => db.rows('select key from public.stored_objects'))).rejects.toThrow(denied);
    await expect(asUser(org.ownerId, (db) => db.rows('select bytes from public.stored_objects where key = $1', [key]))).rejects.toThrow(denied);
    await expect(asUser(org.ownerId, (db) => db.run('insert into public.stored_objects (key, org_id, bytes, size) values ($1, $2, $3, 1)', [key.replace(/.{5}\.bin$/, 'aaaaa.bin'), org.orgId, Buffer.from('x')]))).rejects.toThrow(denied);
    await expect(asUser(org.ownerId, (db) => db.run('update public.stored_objects set size = size'))).rejects.toThrow(denied);
    await expect(asUser(org.ownerId, (db) => db.run('delete from public.stored_objects where key = $1', [key]))).rejects.toThrow(denied);
    // Still there, untouched, for the system connection.
    expect((await getObject(key)).toString()).toBe('private');
    const rls = await withSystem((db) => db.row<{ relrowsecurity: boolean; policies: number }>(
      "select c.relrowsecurity, (select count(*)::int from pg_policies p where p.schemaname = 'public' and p.tablename = 'stored_objects') as policies from pg_class c where c.oid = 'public.stored_objects'::regclass"));
    expect(rls).toEqual({ relrowsecurity: true, policies: 0 });
    await deleteObject(key);
  });

  it('db driver: refuses a key that is not in the storage key format', async () => {
    use('db');
    for (const bad of ['../../etc/passwd', 'x', `${org.orgId}/${clientId}/../x.bin`]) {
      await expect(getObject(bad)).rejects.toThrow('Invalid storage key');
      await expect(deleteObject(bad)).rejects.toThrow('Invalid storage key');
    }
  });

  it('disk driver (the default) still round-trips, and each driver only sees its own keys', async () => {
    use('disk');
    const bytes = randomBytes(10_000);
    const diskKey = await putObject(org.orgId, clientId, bytes);
    expect((await getObject(diskKey)).equals(bytes)).toBe(true);
    expect(await withSystem((db) => db.row('select 1 from public.stored_objects where key = $1', [diskKey]))).toBeNull();
    use('db');
    await expect(getObject(diskKey)).rejects.toThrow('Stored object not found');
    use('disk');
    await deleteObject(diskKey);
    await expect(getObject(diskKey)).rejects.toThrow();
  });
});
