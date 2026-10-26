import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Field-level encryption (AES-256-GCM) for SSN, DOB and account numbers.
 * Ciphertext format: "v<keyId>.<base64(iv|tag|ciphertext)>". The key id enables rotation:
 * PII_ENCRYPTION_KEY is the current key (id from PII_ENCRYPTION_KEY_ID, default 1);
 * PII_ENCRYPTION_KEY_PREVIOUS / PII_ENCRYPTION_KEY_PREVIOUS_ID decrypt older rows.
 * Keys are stored in Supabase Vault and injected as environment secrets; never commit them.
 */
function parseKey(b64: string | undefined): Buffer {
  const k = Buffer.from(b64 ?? '', 'base64');
  if (k.length !== 32) throw new Error('PII encryption key must be 32 bytes (base64)');
  return k;
}

function keyFor(id: string): Buffer {
  const currentId = process.env.PII_ENCRYPTION_KEY_ID ?? '1';
  if (id === currentId) return parseKey(process.env.PII_ENCRYPTION_KEY);
  if (id === process.env.PII_ENCRYPTION_KEY_PREVIOUS_ID)
    return parseKey(process.env.PII_ENCRYPTION_KEY_PREVIOUS);
  throw new Error(`Unknown PII key id: ${id}`);
}

export function encryptPII(plain: string): string {
  const id = process.env.PII_ENCRYPTION_KEY_ID ?? '1';
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', keyFor(id), iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return `v${id}.${Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64')}`;
}

export function decryptPII(payload: string): string {
  const m = /^v([\w-]+)\.(.+)$/.exec(payload);
  if (!m) throw new Error('Malformed ciphertext');
  const b = Buffer.from(m[2], 'base64');
  const d = createDecipheriv('aes-256-gcm', keyFor(m[1]), b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
}

/** Display helper: only the last 4 characters are ever shown. */
export function maskLast4(value: string): string {
  const v = value.replace(/[^0-9A-Za-z]/g, '');
  return v.length <= 4 ? '••••' : `••••${v.slice(-4)}`;
}
