import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

function key(): Buffer {
  const k = Buffer.from(process.env.PII_ENCRYPTION_KEY ?? '', 'base64');
  if (k.length !== 32) throw new Error('PII_ENCRYPTION_KEY must be 32 bytes (base64)');
  return k;
}

/** AES-256-GCM; output is base64(iv|tag|ciphertext). */
export function encryptPII(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64');
}

export function decryptPII(payload: string): string {
  const b = Buffer.from(payload, 'base64');
  const d = createDecipheriv('aes-256-gcm', key(), b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
}
