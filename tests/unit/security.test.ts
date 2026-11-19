import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { decryptBytes, decryptPII, encryptBytes, encryptPII, hashToken, maskLast4, safeEqual } from '@/lib/crypto';
import { hashPassword, passwordProblem, verifyPassword } from '@/lib/auth/password';
import { base32Decode, base32Encode, hotp, totpNow, verifyTotp } from '@/lib/auth/totp';
import { can, grantableRoles } from '@/lib/rbac';
import { getEnv, resetEnvCache } from '@/lib/env';
import { buildCsp } from '@/lib/csp';
import { clientIp } from '@/lib/client-ip';
import { secondFactorSatisfied } from '@/lib/auth/service';
import { businessToday, checkSentOn } from '@/lib/letters/service';
import { readBodyCapped } from '@/lib/api/route';

describe('TOTP (RFC 4226 / 6238)', () => {
  const secret = base32Encode(Buffer.from('12345678901234567890'));
  it('matches the RFC 4226 HOTP test vectors', () => {
    const expected = ['755224', '287082', '359152', '969429', '338314', '254676'];
    expected.forEach((code, i) => expect(hotp(secret, i)).toBe(code));
  });
  it('matches the RFC 6238 vector at T=59s (last 6 digits of 94287082)', () => {
    expect(totpNow(secret, 59_000)).toBe('287082');
  });
  it('round-trips base32', () => {
    const buf = Buffer.from('hello world');
    expect(base32Decode(base32Encode(buf)).equals(buf)).toBe(true);
  });
  it('accepts clock drift of one step but rejects replays and bad codes', () => {
    const now = 1_700_000_000_000;
    const step = Math.floor(now / 30000);
    const code = hotp(secret, step);
    expect(verifyTotp(secret, code, null, now)).toBe(step);
    expect(verifyTotp(secret, code, step, now)).toBeNull(); // replay
    expect(verifyTotp(secret, hotp(secret, step - 1), null, now)).toBe(step - 1);
    expect(verifyTotp(secret, hotp(secret, step + 5), null, now)).toBeNull();
    expect(verifyTotp(secret, 'abcdef', null, now)).toBeNull();
  });
});

describe('encryption', () => {
  it('round-trips PII and never repeats ciphertext', () => {
    const a = encryptPII('123-45-6789');
    const b = encryptPII('123-45-6789');
    expect(a).not.toBe(b);
    expect(a).not.toContain('6789');
    expect(decryptPII(a)).toBe('123-45-6789');
  });
  it('round-trips file bytes and detects tampering', () => {
    const data = Buffer.from('%PDF-1.7 secret report');
    const blob = encryptBytes(data);
    expect(blob.includes(Buffer.from('secret'))).toBe(false);
    expect(decryptBytes(blob).equals(data)).toBe(true);
    blob[blob.length - 1]! ^= 0xff;
    expect(() => decryptBytes(blob)).toThrow();
  });
  it('masks to last four', () => {
    expect(maskLast4('4111-1111-1111-1234')).toBe('••••1234');
    expect(maskLast4('12')).toBe('••••');
  });
  it('hashes tokens one-way and compares in constant time', () => {
    expect(hashToken('abc')).toHaveLength(64);
    expect(hashToken('abc')).not.toContain('abc');
    expect(safeEqual('a', 'a')).toBe(true);
    expect(safeEqual('a', 'b')).toBe(false);
  });
});

describe('passwords', () => {
  it('hashes with scrypt, verifies, and rejects wrong passwords', async () => {
    const h = await hashPassword('correct horse battery');
    expect(h.startsWith('scrypt$')).toBe(true);
    expect(await verifyPassword('correct horse battery', h)).toBe(true);
    expect(await verifyPassword('wrong horse battery', h)).toBe(false);
    expect(await hashPassword('correct horse battery')).not.toBe(h); // unique salt
  });
  it('enforces a sensible policy', () => {
    expect(passwordProblem('short')).toMatch(/10 characters/);
    expect(passwordProblem('password123')).toMatch(/common/);
    expect(passwordProblem('aaaaaaaaaaaa')).toBeTruthy();
    expect(passwordProblem('jordanrivera-2026!', 'jordanrivera@x.com')).toMatch(/email/);
    expect(passwordProblem('Tr0ub4dor&3-horse')).toBeNull();
  });
});

describe('rbac', () => {
  it('limits specialists and never lets clients act as staff', () => {
    expect(can('specialist', 'disputes:write')).toBe(true);
    expect(can('specialist', 'disputes:approve')).toBe(false);
    expect(can('specialist', 'billing:read')).toBe(false);
    expect(can('manager', 'letters:approve')).toBe(true);
    expect(can('manager', 'team:manage')).toBe(false);
    expect(can('admin', 'team:manage')).toBe(true);
    expect(can('client', 'clients:read')).toBe(false);
    expect(can(undefined, 'clients:read')).toBe(false);
  });
  it('prevents privilege escalation when granting roles', () => {
    expect(grantableRoles('owner')).not.toContain('owner');
    expect(grantableRoles('admin')).not.toContain('admin');
    expect(grantableRoles('manager')).toEqual([]);
    expect(grantableRoles('specialist')).toEqual([]);
  });
});

describe('environment safety', () => {
  const saved = { ...process.env };
  beforeEach(() => resetEnvCache());
  afterEach(() => {
    process.env = { ...saved };
    resetEnvCache();
  });
  it('refuses the development key and http URLs in production', () => {
    process.env.APP_ENV = 'production';
    process.env.DATABASE_URL = 'postgres://x/y';
    process.env.APP_URL = 'http://example.com';
    process.env.PII_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
    expect(() => getEnv()).toThrow(/Unsafe production/);
  });
  it('requires explicit secrets in staging', () => {
    process.env.APP_ENV = 'staging';
    delete process.env.PII_ENCRYPTION_KEY;
    expect(() => getEnv()).toThrow(/PII_ENCRYPTION_KEY/);
  });
  it('accepts a proper production configuration', () => {
    process.env.APP_ENV = 'production';
    process.env.DATABASE_URL = 'postgres://x/y';
    process.env.APP_URL = 'https://app.example.com';
    process.env.PII_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64');
    process.env.EMAIL_DRIVER = 'resend';
    process.env.RESEND_API_KEY = 're_test_key';
    expect(getEnv().APP_ENV).toBe('production');
  });
  it('refuses the log email driver in staging/production (it delivers nothing and writes reset links to disk)', () => {
    Object.assign(process.env, { APP_ENV: 'production', DATABASE_URL: 'postgres://x/y', APP_URL: 'https://app.example.com', PII_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64'), EMAIL_DRIVER: 'log' });
    expect(() => getEnv()).toThrow(/EMAIL_DRIVER must be resend/);
    delete process.env.EMAIL_DRIVER; // unset falls back to the log default: still refused
    resetEnvCache();
    expect(() => getEnv()).toThrow(/EMAIL_DRIVER must be resend/);
  });
  it('treats the blank lines of .env.example as "not set", so the quick start boots', () => {
    const example = readFileSync(path.resolve(__dirname, '../../.env.example'), 'utf8');
    const pairs = [...example.matchAll(/^([A-Z][A-Z0-9_]*)=(.*)$/gm)].map((m) => [m[1]!, m[2]!.replace(/\s+#.*$/, '').trim().replace(/^"(.*)"$/, '$1')] as const);
    const blanks = pairs.filter(([, v]) => v === '').map(([k]) => k);
    expect(blanks).toEqual(expect.arrayContaining(['PII_ENCRYPTION_KEY', 'PII_ENCRYPTION_KEY_PREVIOUS', 'AI_BASE_URL', 'CRON_SECRET']));
    expect(example).not.toMatch(/STRIPE/);
    for (const k of Object.keys(process.env)) if (/^(PII_|AI_|CRON_|RESEND_|ANTHROPIC_|EMAIL_|APP_|DATABASE_URL|STORAGE_DIR|TRUSTED_|STAFF_|REQUIRE_)/.test(k)) delete process.env[k];
    for (const [k, v] of pairs) process.env[k] = v;
    const env = getEnv();
    expect(env).toMatchObject({ APP_ENV: 'development', EMAIL_DRIVER: 'log', TRUSTED_PROXY_HOPS: 1, APP_TIMEZONE: 'America/New_York' });
    expect(env.CRON_SECRET).toBeUndefined();
    expect(Buffer.from(env.PII_ENCRYPTION_KEY, 'base64')).toHaveLength(32);
  });
  it('still rejects a blank required secret in production', () => {
    Object.assign(process.env, { APP_ENV: 'production', DATABASE_URL: 'postgres://x/y', APP_URL: 'https://app.example.com', PII_ENCRYPTION_KEY: '  ', EMAIL_DRIVER: 'resend', RESEND_API_KEY: 're_test_key' });
    expect(() => getEnv()).toThrow(/PII_ENCRYPTION_KEY/);
  });
});

describe('two-step verification applies to route handlers as well as pages', () => {
  const saved = { ...process.env };
  afterEach(() => { process.env = { ...saved }; resetEnvCache(); });
  const set = (v: 'true' | 'false') => { process.env.APP_ENV = 'test'; process.env.REQUIRE_STAFF_MFA = v; resetEnvCache(); };
  it('a password-only session of an enrolled user is not enough, for staff or clients', () => {
    set('false');
    expect(secondFactorSatisfied({ role: 'owner', totpEnabled: true, mfaVerified: false })).toBe(false);
    expect(secondFactorSatisfied({ role: 'client', totpEnabled: true, mfaVerified: false })).toBe(false);
    expect(secondFactorSatisfied({ role: 'specialist', totpEnabled: true, mfaVerified: true })).toBe(true);
  });
  it('unenrolled staff get nothing while REQUIRE_STAFF_MFA is on; clients may stay unenrolled', () => {
    set('true');
    expect(secondFactorSatisfied({ role: 'admin', totpEnabled: false, mfaVerified: false })).toBe(false);
    expect(secondFactorSatisfied({ role: 'client', totpEnabled: false, mfaVerified: false })).toBe(true);
    set('false');
    expect(secondFactorSatisfied({ role: 'admin', totpEnabled: false, mfaVerified: false })).toBe(true);
  });
});

describe('client IP behind a proxy', () => {
  const h = (o: Record<string, string>) => new Headers(o);
  it('believes the entry the proxy appended, never the leftmost one a caller can forge', () => {
    expect(clientIp(h({ 'x-forwarded-for': '1.2.3.4, 203.0.113.9' }), 1)).toBe('203.0.113.9');
    expect(clientIp(h({ 'x-forwarded-for': '203.0.113.9' }), 1)).toBe('203.0.113.9');
    expect(clientIp(h({ 'x-forwarded-for': '6.6.6.6, 203.0.113.9, 10.0.0.1' }), 2)).toBe('203.0.113.9');
  });
  it('a forged x-real-ip does not override the proxy chain; it is only a fallback', () => {
    expect(clientIp(h({ 'x-forwarded-for': '1.2.3.4, 203.0.113.9', 'x-real-ip': '6.6.6.6' }), 1)).toBe('203.0.113.9');
    expect(clientIp(h({ 'x-real-ip': '203.0.113.9' }), 1)).toBe('203.0.113.9');
    expect(clientIp(h({}), 1)).toBeNull();
  });
  it('a chain shorter than the configured hops falls back to its first entry', () => {
    expect(clientIp(h({ 'x-forwarded-for': '203.0.113.9' }), 3)).toBe('203.0.113.9');
  });
});

describe('sent-on date uses the agency calendar date', () => {
  const evening = new Date('2026-03-10T23:30:00Z'); // 7:30 pm on 10 March in New York, still 10 March in UTC
  const lateEvening = new Date('2026-03-11T01:30:00Z'); // 9:30 pm on 10 March in New York, 11 March in UTC
  it('defaults a blank date to today where the agency is, not the UTC date', () => {
    expect(businessToday(lateEvening, 'America/New_York')).toBe('2026-03-10');
    expect(businessToday(lateEvening, 'UTC')).toBe('2026-03-11');
    expect(checkSentOn(null, lateEvening)).toBe('2026-03-10');
    expect(checkSentOn('', evening)).toBe('2026-03-10');
  });
  it('accepts today on either side of the date line, refuses real future dates', () => {
    expect(checkSentOn('2026-03-10', lateEvening)).toBe('2026-03-10');
    expect(checkSentOn('2026-03-11', lateEvening)).toBe('2026-03-11');
    expect(() => checkSentOn('2026-03-12', lateEvening)).toThrow(/future/);
  });
});

describe('public API body limit', () => {
  const stream = (chunks: number, size: number, onPull?: () => void) => new ReadableStream<Uint8Array>({
    pull(c) { onPull?.(); if (chunks-- > 0) c.enqueue(new Uint8Array(size).fill(97)); else c.close(); },
  });
  const post = (body: BodyInit, headers: Record<string, string> = {}) => new Request('http://x/api', { method: 'POST', body, headers, duplex: 'half' } as RequestInit);
  it('reads a small body', async () => {
    expect(await readBodyCapped(post('{"a":"é"}'), 100)).toBe('{"a":"é"}');
  });
  it('stops reading as soon as the cap is passed instead of buffering everything', async () => {
    let pulls = 0;
    await expect(readBodyCapped(post(stream(1000, 1024, () => pulls++)), 10 * 1024)).rejects.toThrow(/too large/);
    expect(pulls).toBeLessThan(50);
  });
  it('counts bytes, not characters', async () => {
    await expect(readBodyCapped(post('ééééé'), 9)).rejects.toThrow(/too large/); // 5 characters, 10 bytes
  });
});

describe('csp', () => {
  it('uses a nonce, forbids framing and objects, and only allows eval in dev', () => {
    const prod = buildCsp('abc', false);
    expect(prod).toContain("'nonce-abc'");
    expect(prod).toContain("frame-ancestors 'none'");
    expect(prod).toContain("object-src 'none'");
    expect(prod).not.toContain('unsafe-eval');
    expect(buildCsp('abc', true)).toContain('unsafe-eval');
  });
});
