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
}

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
 */
export async function sendEmail(mail: Email): Promise<SendResult> {
  const env = getEnv();
  if (env.EMAIL_DRIVER === 'resend') {
    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({ from: fromHeader(env.EMAIL_FROM, mail.fromName), to: [mail.to], subject: mail.subject, text: mail.text, ...(mail.replyTo ? { reply_to: mail.replyTo } : {}) }),
        signal: AbortSignal.timeout(15_000),
      });
      const body = (await res.json().catch(() => ({}))) as { id?: string; message?: string };
      if (!res.ok) return { ok: false, provider: 'resend', error: body.message ?? `HTTP ${res.status}` };
      return { ok: true, provider: 'resend', providerRef: body.id };
    } catch (e) {
      return { ok: false, provider: 'resend', error: (e as Error).message };
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
