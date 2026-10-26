import { scrub, scrubString } from '@/lib/observability/scrub';
import { encryptPII, decryptPII, maskLast4 } from '@/lib/crypto';
import { buildCsp } from '@/lib/csp';
import { signUpSchema } from '@/lib/validation';
import en from '@/messages/en.json';
import es from '@/messages/es.json';

const keys = (o: Record<string, unknown>, p = ''): string[] =>
  Object.entries(o).flatMap(([k, v]) =>
    v && typeof v === 'object' ? keys(v as Record<string, unknown>, `${p}${k}.`) : [`${p}${k}`],
  );

test('EN and ES catalogs have identical keys', () => {
  expect(keys(es).sort()).toEqual(keys(en).sort());
});

test('scrub removes SSNs, emails, long digit runs and sensitive keys', () => {
  expect(scrubString('ssn 123-45-6789 mail a@b.com acct 123456789012')).not.toMatch(
    /6789|a@b|1234567/,
  );
  const out = scrub({ ssn: '1', nested: { Password: 'x', note: 'ok' }, list: ['a@b.com'] });
  expect(out).toEqual({
    ssn: '[redacted]',
    nested: { Password: '[redacted]', note: 'ok' },
    list: ['[redacted]'],
  });
});

test('key rotation: old ciphertext decrypts with previous key; unknown id fails', () => {
  const old = Buffer.alloc(32, 1).toString('base64');
  const next = Buffer.alloc(32, 2).toString('base64');
  Object.assign(process.env, { PII_ENCRYPTION_KEY: old, PII_ENCRYPTION_KEY_ID: '1' });
  const c1 = encryptPII('078-05-1120');
  expect(c1.startsWith('v1.')).toBe(true);
  Object.assign(process.env, {
    PII_ENCRYPTION_KEY: next,
    PII_ENCRYPTION_KEY_ID: '2',
    PII_ENCRYPTION_KEY_PREVIOUS: old,
    PII_ENCRYPTION_KEY_PREVIOUS_ID: '1',
  });
  expect(decryptPII(c1)).toBe('078-05-1120');
  expect(encryptPII('x').startsWith('v2.')).toBe(true);
  expect(() => decryptPII('v9.AAAA')).toThrow();
  expect(() => decryptPII('garbage')).toThrow();
});

test('maskLast4 never reveals more than 4 chars', () => {
  expect(maskLast4('1234-5678-9012')).toBe('••••9012');
  expect(maskLast4('12')).toBe('••••');
});

test('CSP is nonce-based with no unsafe-inline scripts and denies framing', () => {
  const csp = buildCsp('abc');
  expect(csp).toContain("'nonce-abc'");
  expect(csp).toMatch(/script-src[^;]*/);
  expect(csp.match(/script-src[^;]*/)![0]).not.toContain('unsafe-inline');
  expect(csp).toContain("frame-ancestors 'none'");
  expect(buildCsp('abc')).not.toContain('unsafe-eval');
});

test('signup enforces 10+ char password and a valid mode', () => {
  const ok = { email: 'a@b.co', password: 'longenough1', fullName: 'A', mode: 'agency' };
  expect(signUpSchema.safeParse(ok).success).toBe(true);
  expect(signUpSchema.safeParse({ ...ok, password: 'short' }).success).toBe(false);
  expect(signUpSchema.safeParse({ ...ok, mode: 'admin' }).success).toBe(false);
});
