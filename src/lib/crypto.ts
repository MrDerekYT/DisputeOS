import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";

const VERSION = "v1";

function keyFrom(b64: string | undefined): Buffer {
  const key = Buffer.from(b64 ?? "", "base64");
  if (key.length !== 32) throw new Error("FIELD_ENCRYPTION_KEY must be 32 bytes (base64)");
  return key;
}

/** AES-256-GCM. Output: v1:<iv>:<tag>:<ciphertext> (base64url parts). */
export function encryptField(plaintext: string, keyB64 = process.env.FIELD_ENCRYPTION_KEY): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyFrom(keyB64), iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [VERSION, iv, cipher.getAuthTag(), enc].map((p) => (typeof p === "string" ? p : p.toString("base64url"))).join(":");
}

export function decryptField(payload: string, keyB64 = process.env.FIELD_ENCRYPTION_KEY): string {
  const [version, iv, tag, data] = payload.split(":");
  if (version !== VERSION || !iv || !tag || !data) throw new Error("Unsupported ciphertext format");
  const decipher = createDecipheriv("aes-256-gcm", keyFrom(keyB64), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8");
}

/** Deterministic blind index so encrypted values can be matched without decrypting. */
export function blindIndex(value: string, keyB64 = process.env.FIELD_ENCRYPTION_KEY): string {
  return createHmac("sha256", keyFrom(keyB64)).update(value.trim().toLowerCase()).digest("hex");
}

export const last4 = (value: string): string => value.replace(/\D/g, "").slice(-4);
