import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { decryptBytes, encryptBytes } from './crypto';
import { withSystem } from './db';
import { getEnv } from './env';

/**
 * Document storage: bytes are AES-256-GCM encrypted by the app BEFORE they are stored, so a leaked volume, database or
 * backup reveals nothing without PII_ENCRYPTION_KEY. Two drivers, chosen by STORAGE_DRIVER:
 *   disk  files under STORAGE_DIR/vault (default; needs a persistent volume)
 *   db    rows in public.stored_objects (for hosts with no persistent disk, such as Vercel)
 * Both store the same encrypted bytes under the same key format. A key is only readable by the driver that wrote it:
 * switching drivers does not move existing files.
 * An S3-compatible backend is a documented roadmap item (docs/INTEGRATIONS.md) — it is not implemented.
 *
 * These functions do no access control of their own and, with the `db` driver, use the system connection (the table
 * has no tenant grants). Call them only from server code that has already checked, inside the requester's own
 * row-level-security transaction, that the document the key belongs to is theirs to read, add or delete.
 */
const KEY_RE = /^[0-9a-f-]{36}\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.bin$/;

const dbDriver = () => getEnv().STORAGE_DRIVER === 'db';
const checkKey = (key: string) => { if (!KEY_RE.test(key)) throw new Error('Invalid storage key'); };

const root = () => path.resolve(getEnv().STORAGE_DIR, 'vault');

function resolveKey(key: string): string {
  if (!KEY_RE.test(key)) throw new Error('Invalid storage key');
  const full = path.resolve(root(), key);
  if (!full.startsWith(root() + path.sep)) throw new Error('Invalid storage key');
  return full;
}

export async function putObject(orgId: string, clientId: string, bytes: Buffer): Promise<string> {
  const key = `${orgId}/${clientId}/${randomUUID()}.bin`;
  if (dbDriver()) {
    checkKey(key);
    const stored = encryptBytes(bytes);
    await withSystem((db) => db.run('insert into public.stored_objects (key, org_id, bytes, size) values ($1, $2, $3, $4)', [key, orgId, stored, stored.length]));
    return key;
  }
  const full = resolveKey(key);
  await mkdir(path.dirname(full), { recursive: true, mode: 0o700 });
  await writeFile(full, encryptBytes(bytes), { mode: 0o600 });
  return key;
}

export async function getObject(key: string): Promise<Buffer> {
  if (dbDriver()) {
    checkKey(key);
    const row = await withSystem((db) => db.row<{ bytes: Buffer }>('select bytes from public.stored_objects where key = $1', [key]));
    if (!row) throw new Error('Stored object not found');
    return decryptBytes(row.bytes);
  }
  return decryptBytes(await readFile(resolveKey(key)));
}

export async function deleteObject(key: string): Promise<void> {
  if (dbDriver()) {
    checkKey(key);
    await withSystem((db) => db.run('delete from public.stored_objects where key = $1', [key]));
    return;
  }
  await rm(resolveKey(key), { force: true });
}
