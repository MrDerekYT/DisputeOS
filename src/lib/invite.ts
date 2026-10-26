import { createHmac, timingSafeEqual } from "node:crypto";

export interface InvitePayload {
  /** Agency (tenant) that owns the invite. */
  org: string;
  /** Optional pre-filled client name shown on the form. */
  name?: string;
  /** Expiry, unix seconds. */
  exp: number;
}

const b64 = (b: Buffer) => b.toString("base64url");

function secret(env: Record<string, string | undefined>): string {
  const s = env.INVITE_SECRET;
  if (s) return s;
  if (env.NODE_ENV === "production") throw new Error("INVITE_SECRET must be set in production");
  return "dev-only-invite-secret";
}

export function signInvite(p: InvitePayload, env: Record<string, string | undefined> = process.env): string {
  const body = b64(Buffer.from(JSON.stringify(p)));
  const sig = b64(createHmac("sha256", secret(env)).update(body).digest());
  return `${body}.${sig}`;
}

export function verifyInvite(
  token: string,
  env: Record<string, string | undefined> = process.env,
  nowSec = Math.floor(Date.now() / 1000),
): InvitePayload | null {
  const [body, sig, extra] = token.split(".");
  if (!body || !sig || extra !== undefined) return null;
  const expected = createHmac("sha256", secret(env)).update(body).digest();
  const given = Buffer.from(sig, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString()) as InvitePayload;
    if (typeof p.org !== "string" || typeof p.exp !== "number" || p.exp < nowSec) return null;
    return p;
  } catch {
    return null;
  }
}

export const inviteFor = (org: string, name?: string, days = 14): InvitePayload => ({
  org,
  name,
  exp: Math.floor(Date.now() / 1000) + days * 86_400,
});

export interface IntakeInput {
  name: string;
  email: string;
  phone: string;
  address: string;
  consentCroa: boolean;
  consentReports: boolean;
}

export function validateIntake(f: Record<string, FormDataEntryValue | null>): { ok: true; data: IntakeInput } | { ok: false; errors: Record<string, string> } {
  const s = (k: string) => String(f[k] ?? "").trim();
  const errors: Record<string, string> = {};
  const data: IntakeInput = {
    name: s("name"),
    email: s("email").toLowerCase(),
    phone: s("phone").replace(/\D/g, "").replace(/^1(?=\d{10}$)/, ""),
    address: s("address"),
    consentCroa: f.consentCroa === "on",
    consentReports: f.consentReports === "on",
  };
  if (data.name.length < 2) errors.name = "name";
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(data.email)) errors.email = "email";
  if (data.phone.length !== 10) errors.phone = "phone";
  if (data.address.length < 8) errors.address = "address";
  if (!data.consentCroa) errors.consentCroa = "consent";
  if (!data.consentReports) errors.consentReports = "consent";
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, data };
}
