import { createHmac } from 'node:crypto';
import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { safeEqual } from './crypto';
import { getEnv } from './env';

export interface Sms {
  /** E.164, e.g. +15551234567. Anything else is refused before the provider is called. */
  to: string;
  body: string;
}

export interface SmsResult {
  ok: boolean;
  provider: 'twilio' | 'log' | 'disabled';
  providerRef?: string;
  error?: string;
}

export const SMS_NOT_CONNECTED = 'Text messaging is not connected';

/** In-process record of what the `log` driver "sent", so tests can assert on texts without a provider. */
export const smsLog: Sms[] = [];

// ---------------------------------------------------------------- phone numbers
const E164 = /^\+[1-9]\d{7,14}$/;
export const isE164 = (v: unknown): v is string => typeof v === 'string' && E164.test(v);

/**
 * A phone number as people type it, in E.164, or null when it cannot be read as one with confidence.
 * Ten digits (or eleven starting with 1) are read as a US/Canada number; a number in any other country must be typed
 * with its "+" and country code. Extensions and letters are refused rather than guessed at.
 */
export function toE164(raw: string | null | undefined): string | null {
  const v = (raw ?? '').trim();
  if (!v || /[a-z]/i.test(v)) return null;
  const digits = v.replace(/\D/g, '');
  if (v.startsWith('+')) return isE164(`+${digits}`) ? `+${digits}` : null;
  // North American Numbering Plan: area code and exchange both start with 2-9.
  const nanp = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
  return /^[2-9]\d{2}[2-9]\d{6}$/.test(nanp) ? `+1${nanp}` : null;
}

// ---------------------------------------------------------------- configuration
export type SmsState = 'connected' | 'needs_credentials' | 'test_only' | 'disabled';
export interface SmsStatus { state: SmsState; missing: string[] }

/** What the configuration says, without calling the provider. `missing` names the exact variables still to set. */
export function smsStatus(): SmsStatus {
  const env = getEnv();
  if (env.SMS_DRIVER === 'log') return { state: 'test_only', missing: [] };
  if (env.SMS_DRIVER !== 'twilio') return { state: 'disabled', missing: ['SMS_DRIVER=twilio', 'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_MESSAGING_SERVICE_SID or TWILIO_FROM_NUMBER'] };
  const missing: string[] = [];
  if (!env.TWILIO_ACCOUNT_SID) missing.push('TWILIO_ACCOUNT_SID');
  if (!env.TWILIO_AUTH_TOKEN) missing.push('TWILIO_AUTH_TOKEN');
  if (!env.TWILIO_MESSAGING_SERVICE_SID && !env.TWILIO_FROM_NUMBER) missing.push('TWILIO_MESSAGING_SERVICE_SID or TWILIO_FROM_NUMBER');
  else if (!env.TWILIO_MESSAGING_SERVICE_SID && !isE164(env.TWILIO_FROM_NUMBER)) missing.push('TWILIO_FROM_NUMBER in E.164 form (for example +15551234567)');
  return { state: missing.length ? 'needs_credentials' : 'connected', missing };
}
/** True when a text really leaves the building. The `log` driver writes to a file and delivers nothing. */
export const smsIsLive = () => smsStatus().state === 'connected';
/** True when a send can be attempted here: connected, or the development stand-in. */
export const smsUsable = () => ['connected', 'test_only'].includes(smsStatus().state);

/** Where Twilio is told to POST inbound texts and delivery reports. The signature is computed over exactly this URL. */
export const twilioWebhookUrl = () => `${getEnv().APP_URL.replace(/\/+$/, '')}/api/webhooks/twilio`;

// ---------------------------------------------------------------- sending
/**
 * Text messages behind one function. It never throws: the caller gets ok/failed and records it.
 *  - `disabled` (default): nothing is sent, nothing is written anywhere.
 *  - `twilio`: POST https://api.twilio.com/2010-04-01/Accounts/{AccountSid}/Messages.json, form-encoded, HTTP Basic
 *    auth (Account SID : Auth Token), with To, Body and either MessagingServiceSid or From, plus StatusCallback so
 *    delivery reports come back to the webhook. Implemented to the documented API
 *    (https://www.twilio.com/docs/messaging/api/message-resource); not exercised against the live service from here.
 *  - `log`: appended to .storage/outbox/sms.jsonl. Nothing leaves the machine. Development and test only; the
 *    environment check refuses it in staging and production (src/lib/env.ts).
 * Sending to US numbers from a ten-digit number also needs an approved A2P 10DLC registration at the provider; an
 * unregistered sender is rejected by the carriers (Twilio error 30034), which arrives here as a failed delivery report.
 */
export async function sendSms(msg: Sms): Promise<SmsResult> {
  const env = getEnv();
  const provider = env.SMS_DRIVER;
  try {
    if (provider === 'disabled') return { ok: false, provider, error: SMS_NOT_CONNECTED };
    if (!isE164(msg.to)) return { ok: false, provider, error: 'The phone number is not a valid international (E.164) number.' };
    const body = msg.body.trim();
    if (!body || body.length > 1600) return { ok: false, provider, error: 'The message is empty or too long.' };

    if (provider === 'log') {
      smsLog.push({ to: msg.to, body });
      if (smsLog.length > 200) smsLog.shift();
      try {
        const dir = path.resolve(env.STORAGE_DIR, 'outbox');
        await mkdir(dir, { recursive: true });
        await appendFile(path.join(dir, 'sms.jsonl'), JSON.stringify({ at: new Date().toISOString(), to: msg.to, body }) + '\n');
      } catch {
        /* the log driver is best-effort */
      }
      return { ok: true, provider };
    }

    const status = smsStatus();
    if (status.state !== 'connected') return { ok: false, provider, error: `${SMS_NOT_CONNECTED}: missing ${status.missing.join(', ')}` };
    const form = new URLSearchParams({ To: msg.to, Body: body, StatusCallback: twilioWebhookUrl() });
    if (env.TWILIO_MESSAGING_SERVICE_SID) form.set('MessagingServiceSid', env.TWILIO_MESSAGING_SERVICE_SID);
    else form.set('From', env.TWILIO_FROM_NUMBER!);
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(env.TWILIO_ACCOUNT_SID!)}/Messages.json`, {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`).toString('base64')}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: form.toString(),
      signal: AbortSignal.timeout(15_000),
    });
    const out = (await res.json().catch(() => ({}))) as { sid?: string; message?: string; code?: number; error_code?: number | null; error_message?: string | null };
    if (!res.ok) return { ok: false, provider, error: `${out.message ?? `HTTP ${res.status}`}${out.code ? ` (Twilio error ${out.code})` : ''}`.slice(0, 300) };
    if (out.error_code) return { ok: false, provider, providerRef: out.sid, error: `${out.error_message ?? 'The provider refused the message'} (Twilio error ${out.error_code})`.slice(0, 300) };
    return { ok: true, provider, providerRef: out.sid };
  } catch (e) {
    return { ok: false, provider, error: String((e as Error).message ?? e).slice(0, 300) };
  }
}

// ---------------------------------------------------------------- webhook signature
/**
 * The signature Twilio puts in X-Twilio-Signature, as documented at https://www.twilio.com/docs/usage/security
 * ("Explore the algorithm yourself"): take the full URL Twilio was configured to call (query string included), append
 * every POST parameter as name immediately followed by value, with the parameters sorted by name (case-sensitive),
 * sign the result with HMAC-SHA1 using the account's Auth Token as the key, and Base64-encode it.
 * All received parameters are used, whatever they are: Twilio adds new ones without notice.
 */
export function twilioSignature(authToken: string, url: string, params: Record<string, string>): string {
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join('');
  return createHmac('sha1', authToken).update(Buffer.from(data, 'utf8')).digest('base64');
}

export function verifyTwilioSignature(authToken: string | undefined, url: string, params: Record<string, string>, given: string | null | undefined): boolean {
  if (!authToken || !given) return false;
  return safeEqual(given.trim(), twilioSignature(authToken, url, params));
}

// ---------------------------------------------------------------- keywords
/**
 * What a reply means.
 *
 * 47 CFR § 64.1200(a)(10) (https://www.law.cornell.edu/cfr/text/47/64.1200): a called party may revoke consent "in
 * any reasonable manner", and using the words "stop," "quit," "end," "revoke," "opt out," "cancel," or "unsubscribe"
 * in a reply to a text is "per se" a reasonable means. So a reply that contains any of those words or the phrase
 * "opt out", anywhere, is a stop: "please stop", "cancel please", "opt-out". This deliberately errs towards
 * stopping: "see you at the end of the week" switches texts off too, and the client can switch them back on in the
 * portal. A short list of plain refusals in English and Spanish ("no more texts", "do not text me", "no más
 * mensajes") is treated the same way. Any other free-text reply is a 'message': texts to that client pause until a
 * staff member has read it (see recordInboundSms).
 *
 * Twilio's own default handling only acts on a single-word STOP, STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT, REVOKE or
 * OPTOUT, lifts its block after START, YES or UNSTOP, and answers HELP or INFO itself
 * (https://help.twilio.com/articles/223134027). The consent record here is stricter than Twilio's block.
 */
const STOP_ANYWHERE = /\b(STOP|STOPALL|QUIT|END|REVOKE|CANCEL|UNSUBSCRIBE|OPTOUT|OPT OUT)\b/;
const REFUSAL = /\b(NO MORE (TEXTS?|MESSAGES?|SMS)|DO NOT (TEXT|MESSAGE|CONTACT)|DONT (TEXT|MESSAGE|CONTACT)|REMOVE ME|TAKE ME OFF|LEAVE ME ALONE|WRONG NUMBER|NO MAS (MENSAJES?|TEXTOS?|SMS)|NO ME (ESCRIBA|ESCRIBAN|ENVIE|ENVIEN|MANDE|MANDEN)|DE BAJA|PAREN|DETENGAN|CANCELAR|CANCELEN)\b/;
/** Spanish stop words that are also ordinary words: a stop only when they are the whole reply. */
const STOP_ALONE = ['ALTO', 'PARAR', 'DETENER', 'BAJA'];
const START_WORDS = ['START', 'YES', 'UNSTOP'];
const HELP_WORDS = ['HELP', 'INFO'];
export type InboundKind = 'stop' | 'start' | 'help' | 'message';
export function classifyInbound(body: string, optOutType?: string | null): InboundKind {
  // Sent by Twilio when Advanced Opt-Out is on for the Messaging Service; it reflects custom keywords too.
  const hint = (optOutType ?? '').trim().toUpperCase();
  if (hint === 'STOP') return 'stop';
  if (hint === 'START') return 'start';
  if (hint === 'HELP') return 'help';
  // Upper case, accents and apostrophes dropped ("don't" -> DONT, "más" -> MAS), everything else that is not a letter becomes a space ("opt-out" -> OPT OUT).
  const text = body.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/['’]/g, '').replace(/[^A-Z\s]/g, ' ').replace(/\s+/g, ' ').trim();
  if (STOP_ANYWHERE.test(text) || REFUSAL.test(text) || STOP_ALONE.includes(text)) return 'stop';
  if (START_WORDS.includes(text)) return 'start';
  if (HELP_WORDS.includes(text)) return 'help';
  return 'message';
}
