import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { getEnv } from './env';

export interface Email {
  to: string;
  subject: string;
  text: string;
}

export interface SendResult {
  ok: boolean;
  provider: 'log' | 'resend';
  providerRef?: string;
  error?: string;
}

/** In-process record of what the `log` driver "sent" — lets tests assert on emails without a mail server. */
export const sentLog: Email[] = [];

/**
 * Email delivery behind one function.
 *  - `log` (default): writes to .storage/outbox/emails.jsonl. Nothing leaves the machine. Development/test only.
 *  - `resend`: POSTs to the Resend REST API (needs RESEND_API_KEY and a verified sending domain).
 *    NOTE: the Resend driver is implemented to the documented API but has not been exercised against the live service.
 */
export async function sendEmail(mail: Email): Promise<SendResult> {
  const env = getEnv();
  if (env.EMAIL_DRIVER === 'resend') {
    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({ from: env.EMAIL_FROM, to: [mail.to], subject: mail.subject, text: mail.text }),
        signal: AbortSignal.timeout(15_000),
      });
      const body = (await res.json().catch(() => ({}))) as { id?: string; message?: string };
      if (!res.ok) return { ok: false, provider: 'resend', error: body.message ?? `HTTP ${res.status}` };
      return { ok: true, provider: 'resend', providerRef: body.id };
    } catch (e) {
      return { ok: false, provider: 'resend', error: (e as Error).message };
    }
  }
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
