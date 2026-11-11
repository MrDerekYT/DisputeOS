import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { decryptBytes, decryptPII, encryptBytes, encryptPII, hashToken, maskLast4, safeEqual } from '@/lib/crypto';
import { hashPassword, passwordProblem, verifyPassword } from '@/lib/auth/password';
import { base32Decode, base32Encode, hotp, totpNow, verifyTotp } from '@/lib/auth/totp';
import { can, grantableRoles } from '@/lib/rbac';
import { getEnv, resetEnvCache } from '@/lib/env';
import { buildCsp } from '@/lib/csp';

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
    expect(getEnv().APP_ENV).toBe('production');
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
