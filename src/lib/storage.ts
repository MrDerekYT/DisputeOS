import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { decryptBytes, encryptBytes } from './crypto';
import { getEnv } from './env';

/**
 * Document storage: bytes are AES-256-GCM encrypted by the app BEFORE they touch disk, so a leaked volume or backup
 * reveals nothing without PII_ENCRYPTION_KEY. Only the `fs` backend exists today (use an encrypted persistent volume).
 * An S3-compatible backend is a documented roadmap item (docs/INTEGRATIONS.md) — it is not implemented.
 */
const KEY_RE = /^[0-9a-f-]{36}\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.bin$/;

const root = () => path.resolve(getEnv().STORAGE_DIR, 'vault');

function resolveKey(key: string): string {
  if (!KEY_RE.test(key)) throw new Error('Invalid storage key');
  const full = path.resolve(root(), key);
  if (!full.startsWith(root() + path.sep)) throw new Error('Invalid storage key');
  return full;
}

export async function putObject(orgId: string, clientId: string, bytes: Buffer): Promise<string> {
  const key = `${orgId}/${clientId}/${randomUUID()}.bin`;
  const full = resolveKey(key);
  await mkdir(path.dirname(full), { recursive: true, mode: 0o700 });
  await writeFile(full, encryptBytes(bytes), { mode: 0o600 });
  return key;
}

export async function getObject(key: string): Promise<Buffer> {
  return decryptBytes(await readFile(resolveKey(key)));
}

export async function deleteObject(key: string): Promise<void> {
  await rm(resolveKey(key), { force: true });
}
