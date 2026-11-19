import { NextResponse } from 'next/server';
import { rateLimit } from '@/lib/auth/rate-limit';
import { clientIp } from '@/lib/client-ip';
import { recordInboundSms, recordSmsStatus } from '@/lib/client-updates/service';
import { safeEqual } from '@/lib/crypto';
import { getEnv } from '@/lib/env';
import { twilioWebhookUrl, verifyTwilioSignature } from '@/lib/sms';

export const dynamic = 'force-dynamic';

/** Twilio expects TwiML back. An empty response sends no reply; Twilio answers STOP, START and HELP itself. */
const twiml = (status = 200) => new NextResponse('<?xml version="1.0" encoding="UTF-8"?><Response></Response>', { status, headers: { 'content-type': 'text/xml; charset=utf-8', 'cache-control': 'no-store' } });

/**
 * POST /api/webhooks/twilio — inbound texts and delivery reports from Twilio. No session: the request is trusted only
 * when its X-Twilio-Signature matches (HMAC-SHA1 of this exact URL plus every form parameter, keyed with the account's
 * Auth Token; see twilioSignature in src/lib/sms.ts) and it names our own account. The URL is rebuilt from APP_URL,
 * never from request headers, so a proxy or a forged Host header cannot change what is verified. Rate limited per
 * address before anything is read. Answers 404 while Twilio is not configured.
 *
 * Paste the URL (shown in Settings → Client updates) into the Twilio number's or Messaging Service's
 * "A message comes in" webhook, method POST. Delivery reports come to the same URL: each text is sent with it as StatusCallback.
 */
export async function POST(req: Request) {
  const env = getEnv();
  if (env.SMS_DRIVER !== 'twilio' || !env.TWILIO_AUTH_TOKEN) return new NextResponse('Not found', { status: 404 });
  const limit = await rateLimit(`twilio-webhook:ip:${clientIp(req.headers) ?? 'unknown'}`, 300, 60);
  if (!limit.allowed) return new NextResponse('Too many requests', { status: 429, headers: { 'retry-after': String(limit.retryAfterSec) } });

  let params: Record<string, string>;
  try {
    const raw = await req.text();
    if (raw.length > 64_000) return new NextResponse('Payload too large', { status: 413 });
    params = Object.fromEntries(new URLSearchParams(raw));
  } catch {
    return new NextResponse('Bad request', { status: 400 });
  }
  const url = twilioWebhookUrl() + new URL(req.url).search;
  if (!verifyTwilioSignature(env.TWILIO_AUTH_TOKEN, url, params, req.headers.get('x-twilio-signature'))) return new NextResponse('Forbidden', { status: 403 });
  if (env.TWILIO_ACCOUNT_SID && !safeEqual(params.AccountSid ?? '', env.TWILIO_ACCOUNT_SID)) return new NextResponse('Forbidden', { status: 403 });

  const sid = params.MessageSid ?? params.SmsSid ?? '';
  if (!sid) return twiml();
  // A delivery report carries MessageStatus; an inbound text carries Body and From (SmsStatus "received").
  if (params.MessageStatus && params.Body === undefined) await recordSmsStatus(sid, params.MessageStatus, params.ErrorCode);
  else if (params.From) await recordInboundSms({ sid, from: params.From, to: params.To, body: params.Body ?? '', optOutType: params.OptOutType });
  return twiml();
}
