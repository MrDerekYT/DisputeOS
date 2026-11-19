import { NextResponse } from 'next/server';
import { rateLimit } from '@/lib/auth/rate-limit';
import { clientIp } from '@/lib/client-ip';
import { getEnv } from '@/lib/env';
import { recordPartnerDeliveryEvent } from '@/lib/partner-outreach';
import { resendEvent, verifyResendWebhook } from '@/lib/resend-webhook';

export const dynamic = 'force-dynamic';

/**
 * POST /api/webhooks/resend — bounce and spam-complaint reports from Resend for the partner email sequence.
 * No session: a request is trusted only when its Svix signature verifies against RESEND_WEBHOOK_SECRET
 * (src/lib/resend-webhook.ts). Answers 404 while no secret is configured. Rate limited per address before the body is read.
 *
 *   email.bounced     the partner is marked "Bounced" and gets no further email (as the button does)
 *   email.complained  the recipient marked an email as spam: that address is opted out for good
 * Every other event is acknowledged and ignored. An id that is not one of this sequence's emails changes nothing.
 *
 * In Resend: Webhooks → add this URL, select "email.bounced" and "email.complained", and put the signing secret in
 * RESEND_WEBHOOK_SECRET. Until then bounces are recorded by hand ("Bounced" on the partner).
 */
export async function POST(req: Request) {
  const secret = getEnv().RESEND_WEBHOOK_SECRET;
  if (!secret) return new NextResponse('Not found', { status: 404 });
  const limit = await rateLimit(`resend-webhook:ip:${clientIp(req.headers) ?? 'unknown'}`, 300, 60);
  if (!limit.allowed) return new NextResponse('Too many requests', { status: 429, headers: { 'retry-after': String(limit.retryAfterSec) } });
  const body = await req.text();
  if (body.length > 256_000) return new NextResponse('Payload too large', { status: 413 });
  const ok = verifyResendWebhook(secret, { id: req.headers.get('svix-id'), timestamp: req.headers.get('svix-timestamp'), signature: req.headers.get('svix-signature') }, body);
  if (!ok) return new NextResponse('Forbidden', { status: 403 });
  const event = resendEvent(body);
  const matched = event ? await recordPartnerDeliveryEvent(event.emailId, event.kind) : false;
  return NextResponse.json({ ok: true, matched }, { headers: { 'cache-control': 'no-store' } });
}
