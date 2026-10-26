import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { redirect } from "@/i18n/routing";
import { supabaseServer } from "@/lib/supabase-server";
import { SITE_URL } from "@/lib/site";

const COOKIE = "dos_admin";
const ADMIN_TTL_SEC = 8 * 3600;

function key(): string {
  const s = process.env.SESSION_SECRET ?? process.env.INVITE_SECRET;
  if (s) return s;
  if (process.env.NODE_ENV === "production") throw new Error("SESSION_SECRET or INVITE_SECRET must be set in production");
  return "dev-only-session-secret";
}

const mac = (v: string) => createHmac("sha256", key()).update(v).digest("base64url");

function safeEq(a: string, b: string): boolean {
  const x = createHmac("sha256", "cmp").update(a).digest();
  const y = createHmac("sha256", "cmp").update(b).digest();
  return timingSafeEqual(x, y);
}

/** Client portal links are signed so a client can only open their own page; ids alone grant nothing. */
export const signPortal = (id: string) => `${id}.${mac(`portal:${id}`)}`;
export const portalHref = (id: string) => `/portal/${signPortal(id)}`;

export function verifyPortal(token: string): string | null {
  const i = token.lastIndexOf(".");
  if (i < 1) return null;
  const id = token.slice(0, i);
  return safeEq(token.slice(i + 1), mac(`portal:${id}`)) ? id : null;
}

/** Preview login is only active when both env vars are set; otherwise Supabase auth is used. */
export const previewAuthEnabled = () => Boolean(process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD);

export function credentialsMatch(email: string, password: string): boolean {
  if (!previewAuthEnabled()) return false;
  const a = safeEq(email.trim().toLowerCase(), process.env.ADMIN_EMAIL!.trim().toLowerCase());
  const b = safeEq(password, process.env.ADMIN_PASSWORD!);
  return a && b;
}

export async function startAdminSession() {
  const exp = Math.floor(Date.now() / 1000) + ADMIN_TTL_SEC;
  const v = `admin:${exp}`;
  (await cookies()).set(COOKIE, `${v}.${mac(v)}`, {
    httpOnly: true,
    sameSite: "lax",
    secure: SITE_URL.startsWith("https://"),
    path: "/",
    maxAge: ADMIN_TTL_SEC,
  });
}

export async function endAdminSession() {
  (await cookies()).delete(COOKIE);
}

export async function isAdmin(): Promise<boolean> {
  if (previewAuthEnabled()) {
    const raw = (await cookies()).get(COOKIE)?.value;
    if (!raw) return false;
    const i = raw.lastIndexOf(".");
    const v = raw.slice(0, i);
    const exp = Number(v.split(":")[1]);
    return i > 0 && v.startsWith("admin:") && safeEq(raw.slice(i + 1), mac(v)) && exp > Date.now() / 1000;
  }
  try {
    const sb = await supabaseServer();
    const { data } = await sb.auth.getUser();
    return Boolean(data.user);
  } catch {
    return false;
  }
}

export async function requireAdmin(locale: string) {
  if (!(await isAdmin())) redirect({ href: "/login", locale });
}
