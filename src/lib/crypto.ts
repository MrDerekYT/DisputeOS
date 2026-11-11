import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { getEnv } from './env';

/**
 * Field- and file-level encryption (AES-256-GCM).
 * Ciphertext carries a key id so keys can be rotated: PII_ENCRYPTION_KEY is current;
 * PII_ENCRYPTION_KEY_PREVIOUS(+_ID) still decrypts older rows. Keys come from the environment / a secret manager only.
 */
function keyFor(id: string): Buffer {
  const env = getEnv();
  if (id === env.PII_ENCRYPTION_KEY_ID) return Buffer.from(env.PII_ENCRYPTION_KEY, 'base64');
  if (env.PII_ENCRYPTION_KEY_PREVIOUS && id === env.PII_ENCRYPTION_KEY_PREVIOUS_ID)
    return Buffer.from(env.PII_ENCRYPTION_KEY_PREVIOUS, 'base64');
  throw new Error(`Unknown encryption key id: ${id}`);
}

/** Encrypt a short string (SSN, DOB, TOTP secret). Format: "v<keyId>.<base64(iv|tag|ciphertext)>". */
export function encryptPII(plain: string): string {
  const id = getEnv().PII_ENCRYPTION_KEY_ID;
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', keyFor(id), iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return `v${id}.${Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64')}`;
}

export function decryptPII(payload: string): string {
  const m = /^v([\w-]+)\.(.+)$/.exec(payload);
  if (!m) throw new Error('Malformed ciphertext');
  const b = Buffer.from(m[2]!, 'base64');
  const d = createDecipheriv('aes-256-gcm', keyFor(m[1]!), b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
}

const MAGIC = Buffer.from('DOS1');

/** Encrypt file bytes. Layout: MAGIC | idLen(1) | keyId | iv(12) | tag(16) | ciphertext. */
export function encryptBytes(plain: Buffer): Buffer {
  const id = getEnv().PII_ENCRYPTION_KEY_ID;
  const idBuf = Buffer.from(id);
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', keyFor(id), iv);
  const enc = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([MAGIC, Buffer.from([idBuf.length]), idBuf, iv, c.getAuthTag(), enc]);
}

export function decryptBytes(blob: Buffer): Buffer {
  if (!blob.subarray(0, 4).equals(MAGIC)) throw new Error('Not an encrypted storage blob');
  const idLen = blob[4]!;
  const id = blob.subarray(5, 5 + idLen).toString();
  let o = 5 + idLen;
  const iv = blob.subarray(o, (o += 12));
  const tag = blob.subarray(o, (o += 16));
  const d = createDecipheriv('aes-256-gcm', keyFor(id), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(blob.subarray(o)), d.final()]);
}

export const sha256Hex = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');

/** URL-safe random token (session ids, reset links, invites). Only its hash is ever stored. */
export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');
export const hashToken = (token: string) => sha256Hex(`dos-token:${token}`);

export function safeEqual(a: string, b: string): boolean {
  const x = createHash('sha256').update(a).digest();
  const y = createHash('sha256').update(b).digest();
  return timingSafeEqual(x, y);
}

/** Display helper: only the last 4 characters are ever shown. */
export function maskLast4(value: string): string {
  const v = value.replace(/[^0-9A-Za-z]/g, '');
  return v.length <= 4 ? '••••' : `••••${v.slice(-4)}`;
}
