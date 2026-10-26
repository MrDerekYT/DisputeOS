const SSN = /\b\d{3}-?\d{2}-?\d{4}\b/g;
const LONG_DIGITS = /\b\d{9,}\b/g;
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const SENSITIVE_KEY =
  /ssn|dob|birth|password|token|secret|authorization|cookie|account|address|phone|email|full_?name|api[-_]?key|encrypted/i;

export const REDACTED = '[redacted]';

export function scrubString(s: string): string {
  return s.replace(EMAIL, REDACTED).replace(SSN, REDACTED).replace(LONG_DIGITS, REDACTED);
}

/** Deep-scrub arbitrary data (Sentry events, log metadata, analytics props). Never mutates input. */
export function scrub<T>(value: T, depth = 0): T {
  if (depth > 8) return REDACTED as unknown as T;
  if (typeof value === 'string') return scrubString(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => scrub(v, depth + 1)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SENSITIVE_KEY.test(k) ? REDACTED : scrub(v, depth + 1);
    }
    return out as T;
  }
  return value;
}
