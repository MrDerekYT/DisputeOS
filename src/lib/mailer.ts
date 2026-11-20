import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { getEnv } from './env';

export interface Email {
  to: string;
  subject: string;
  text: string;
  /** Where a reply should go (the agency), when the sending address is a no-reply one. */
  replyTo?: string;
  /** Display name for the From line (the agency that is writing). The sending address stays the platform's. */
  fromName?: string;
  /** Extra headers, for example List-Unsubscribe on an email a recipient must be able to stop with one click. */
  headers?: Record<string, string>;
  /**
   * 'outreach': unsolicited business email (the partner sequence). It leaves through OUTREACH_EMAIL_FROM and
   * OUTREACH_RESEND_API_KEY when those are set, so its reputation is kept apart from the address that carries password
   * resets, invitations and client updates.
   */
  stream?: 'outreach';
}

/**
 * `"Agency name" <platform address>`: the From line names the business the message is from, while the address stays the
 * verified sending address. Quotes, angle brackets, backslashes and control characters are removed from the name.
 */
export function fromHeader(platformFrom: string, name?: string): string {
  const clean = (name ?? '').replace(/[\u0000-\u001f\u007f"<>\\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100);
  if (!clean) return platformFrom;
  const address = (/<([^<>\s]+)>\s*$/.exec(platformFrom)?.[1] ?? platformFrom).trim();
  return `"${clean}" <${address}>`;
}

export interface SendResult {
  ok: boolean;
  provider: 'log' | 'resend' | 'disabled';
  providerRef?: string;
  error?: string;
  /**
   * The email service gave no answer (a timeout, a connection that dropped), so it is not known whether it accepted
   * the email. A sender that must never write to someone twice treats this as "outcome unknown", not as a refusal.
   */
  unconfirmed?: boolean;
}

/**
 * Failures that can only happen before a connection exists (the name did not resolve, the connection was refused or
 * never completed), so no part of the request can have reached the email service. Anything else counts as unknown.
 */
const NEVER_CONNECTED = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'UND_ERR_CONNECT_TIMEOUT']);

/** In-process record of what the `log` driver "sent" — lets tests assert on emails without a mail server. */
export const sentLog: Email[] = [];

export const EMAIL_NOT_CONNECTED = 'Email is not connected';
/** True when this result came from a driver that can actually deliver mail. */
export const delivers = (r: SendResult): boolean => r.provider === 'resend';
/** True when the operator has explicitly chosen to run without email (EMAIL_DRIVER=disabled). */
export const emailDisabled = (): boolean => getEnv().EMAIL_DRIVER === 'disabled';


/**
 * Email delivery behind one function.
 *  - `log` (default): writes to .storage/outbox/emails.jsonl. Nothing leaves the machine. Development/test only.
 *  - `resend`: POSTs to the Resend REST API (needs RESEND_API_KEY and a verified sending domain).
 *    NOTE: the Resend driver is implemented to the documented API but has not been exercised against the live service.
 *  - `disabled`: an explicit "no email provider". Nothing is sent and nothing is written anywhere; the result says so,
 *    and callers show the person what to do instead (for example, hand over an invitation link themselves).
 * Only `resend` delivers. Callers must treat any other provider as "not delivered": see `delivers()`.
 * A result with `unconfirmed` means the service did not answer: the email may or may not have gone out.
 */
export async function sendEmail(mail: Email): Promise<SendResult> {
  const env = getEnv();
  if (env.EMAIL_DRIVER === 'resend') {
    try {
      const outreach = mail.stream === 'outreach';
      const key = (outreach && env.OUTREACH_RESEND_API_KEY) || env.RESEND_API_KEY;
      const from = (outreach && env.OUTREACH_EMAIL_FROM) || env.EMAIL_FROM;
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ from: fromHeader(from, mail.fromName), to: [mail.to], subject: mail.subject, text: mail.text, ...(mail.replyTo ? { reply_to: mail.replyTo } : {}), ...(mail.headers ? { headers: mail.headers } : {}) }),
        signal: AbortSignal.timeout(15_000),
      });
      const body = (await res.json().catch(() => ({}))) as { id?: string; message?: string };
      if (!res.ok) return { ok: false, provider: 'resend', error: body.message ?? `HTTP ${res.status}` };
      return { ok: true, provider: 'resend', providerRef: body.id };
    } catch (e) {
      // No answer arrived. Unless no connection was ever made, the service may still have accepted the email.
      const code = (e as { cause?: { code?: unknown } }).cause?.code;
      const neverConnected = typeof code === 'string' && NEVER_CONNECTED.has(code);
      return { ok: false, provider: 'resend', error: (e as Error).message, ...(neverConnected ? {} : { unconfirmed: true }) };
    }
  }
  if (env.EMAIL_DRIVER === 'disabled') return { ok: false, provider: 'disabled', error: EMAIL_NOT_CONNECTED };
  sentLog.push(mail);
  if (sentLog.length > 200) sentLog.shift();
  try {
    const dir = path.resolve(env.STORAGE_DIR, 'outbox');
    await mkdir(dir, { recursive: true });
    await appendFile(path.join(dir, 'emails.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...mail }) + '\n');
  } catch {
    /* log driver is best-effort */
  }
  return { ok: true, provider: 'log' };
}
