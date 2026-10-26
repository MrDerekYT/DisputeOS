export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

export type Detected = {
  mime: 'application/pdf' | 'image/png' | 'image/jpeg' | 'text/plain' | 'text/html';
};

/** Detect type from file content (magic bytes) — never trust the client-supplied MIME type or extension. */
export function detectMime(bytes: Uint8Array): Detected['mime'] | null {
  const starts = (sig: number[]) => sig.every((b, i) => bytes[i] === b);
  if (starts([0x25, 0x50, 0x44, 0x46, 0x2d])) return 'application/pdf';
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (starts([0xff, 0xd8, 0xff])) return 'image/jpeg';
  const head = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, 2048));
  if (head.includes('\u0000') || head.includes('\uFFFD')) return null;
  return /^\s*(<!doctype html|<html|<head|<body)/i.test(head) ? 'text/html' : 'text/plain';
}

/** Safe object-name component: no path separators, control chars or leading dots; bounded length. */
export function sanitizeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? 'file';
  const cleaned = base
    .replace(/[^\w.\- ]+/g, '_')
    .replace(/^\.+/, '')
    .trim()
    .slice(-100);
  return cleaned || 'file';
}

/** Storage key: "<org>/<client>/<random>-<name>". Org prefix is what the storage RLS policy checks. */
export function storagePath(orgId: string, clientId: string, fileName: string): string {
  return `${orgId}/${clientId}/${crypto.randomUUID()}-${sanitizeFileName(fileName)}`;
}
