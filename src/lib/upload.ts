import { getEnv, VERCEL_MAX_UPLOAD_MB } from './env';

/**
 * Largest accepted upload in MB: MAX_UPLOAD_MB when set, otherwise 10, or 4 on Vercel. Server-side only (it reads the
 * environment); pages pass the number to the browser-side checks and messages so everyone states the same limit.
 */
export function maxUploadMb(): number {
  return getEnv().MAX_UPLOAD_MB ?? (process.env.VERCEL ? VERCEL_MAX_UPLOAD_MB : 10);
}
export const maxUploadBytes = (): number => maxUploadMb() * 1024 * 1024;
/** The refusal for an oversized file. The same sentence is shown by the browser-side check before anything is sent. */
export const tooLargeMessage = (mb: number): string => `That file is larger than ${mb} MB.`;

export type DetectedMime = 'application/pdf' | 'image/png' | 'image/jpeg' | 'text/plain' | 'text/html' | 'text/csv';

/** Detect type from the file's own bytes (magic numbers) — never trust the browser-supplied MIME type or extension. */
export function detectMime(bytes: Uint8Array, fileName = ''): DetectedMime | null {
  const starts = (sig: number[]) => sig.every((b, i) => bytes[i] === b);
  if (starts([0x25, 0x50, 0x44, 0x46, 0x2d])) return 'application/pdf';
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (starts([0xff, 0xd8, 0xff])) return 'image/jpeg';
  const head = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, 4096));
  if (head.includes('\u0000') || head.includes('�')) return null; // binary of an unknown type
  if (/^\s*(<!doctype html|<html|<head|<body)/i.test(head)) return 'text/html';
  if (/\.csv$/i.test(fileName)) return 'text/csv';
  return 'text/plain';
}

/** Safe display/file-name component: no path separators, control chars or leading dots; bounded length. */
export function sanitizeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? 'file';
  const cleaned = base.replace(/[^\w.\- ]+/g, '_').replace(/^\.+/, '').trim().slice(-100);
  return cleaned || 'file';
}

export class UploadError extends Error {}

/** Validate an uploaded File and return its bytes + detected type. */
export async function readUpload(file: File | null, allowed: DetectedMime[]): Promise<{ bytes: Buffer; mime: DetectedMime; name: string }> {
  if (!file || typeof file === 'string' || file.size === 0) throw new UploadError('Choose a file to upload.');
  if (file.size > maxUploadBytes()) throw new UploadError(tooLargeMessage(maxUploadMb()));
  const bytes = Buffer.from(await file.arrayBuffer());
  const mime = detectMime(bytes, file.name);
  if (!mime || !allowed.includes(mime)) {
    throw new UploadError(`That file type is not accepted. Allowed: ${allowed.map((m) => m.split('/')[1]).join(', ')}.`);
  }
  return { bytes, mime, name: sanitizeFileName(file.name) };
}
