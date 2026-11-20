import { createHmac } from 'node:crypto';
import { safeEqual } from './crypto';

/**
 * Checks the signature on a Resend webhook. Resend signs with Svix (https://resend.com/docs/dashboard/webhooks/verify-webhooks-requests,
 * https://docs.svix.com/receiving/verifying-payloads/how-manual): the signed text is
 *   `${svix-id}.${svix-timestamp}.${raw body}`
 * signed with HMAC-SHA256, keyed with the bytes that follow "whsec_" in the signing secret (base64), and Base64-encoded.
 * The svix-signature header lists one or more "v1,<signature>" entries separated by spaces; any one may match. A
 * timestamp more than five minutes from now is refused, so a captured request cannot be replayed later.
 *
 * Written to that documentation and tested against signatures computed the same way; it has not been exercised against
 * a live Resend webhook from this environment.
 */
export const WEBHOOK_TOLERANCE_SEC = 300;

export function resendSignature(secret: string, id: string, timestamp: string, body: string): string {
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  return createHmac('sha256', key).update(`${id}.${timestamp}.${body}`, 'utf8').digest('base64');
}

export function verifyResendWebhook(secret: string | undefined, h: { id: string | null; timestamp: string | null; signature: string | null }, body: string, nowMs: number = Date.now()): boolean {
  if (!secret || !h.id || !h.timestamp || !h.signature) return false;
  const ts = Number(h.timestamp);
  if (!Number.isFinite(ts) || Math.abs(nowMs / 1000 - ts) > WEBHOOK_TOLERANCE_SEC) return false;
  const expected = resendSignature(secret, h.id, h.timestamp, body);
  return h.signature.split(' ').some((part) => { const [version, sig] = part.split(','); return version === 'v1' && !!sig && safeEqual(sig, expected); });
}

/** What a webhook body says happened, when it is one of the two events this app acts on. */
export function resendEvent(body: string): { kind: 'bounced' | 'complained'; emailId: string } | null {
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch { return null; }
  const o = parsed as { type?: unknown; data?: { email_id?: unknown } };
  const kind = o?.type === 'email.bounced' ? 'bounced' : o?.type === 'email.complained' ? 'complained' : null;
  const emailId = typeof o?.data?.email_id === 'string' ? o.data.email_id : '';
  return kind && emailId ? { kind, emailId } : null;
}
