import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { resetEnvCache } from '@/lib/env';
import { integrationStatus } from '@/lib/integrations';

const saved = { ...process.env };
afterEach(() => { process.env = { ...saved }; resetEnvCache(); });

const byKey = () => Object.fromEntries(integrationStatus().map((i) => [i.key, i]));
const PILOT_FIVE = ['reports', 'mail', 'payments', 'sms', 'esign'] as const;

function useEnv(env: Record<string, string>) {
  process.env = { ...saved, ...env };
  resetEnvCache();
}

describe('integration status reflects the configured environment', () => {
  it('in development, live credit pulls are a labelled test stand-in and the rest are manual', () => {
    useEnv({ APP_ENV: 'test' });
    const s = byKey();
    expect(s.reports!.status).toBe('dev_only');
    expect(s.reports!.detail).toMatch(/SYNTHETIC/);
    for (const k of ['mail', 'payments', 'sms', 'esign']) expect(s[k]!.status, k).toBe('manual');
  });

  it('in production, nothing is presented as connected: all five are manual, with a manual path and the exact dependency', () => {
    useEnv({ APP_ENV: 'production', APP_URL: 'https://app.example.test', DATABASE_URL: 'postgres://x', PII_ENCRYPTION_KEY: randomBytes(32).toString('base64'), REQUIRE_STAFF_MFA: 'true' });
    const s = byKey();
    for (const k of PILOT_FIVE) {
      expect(s[k]!.status, k).toBe('manual');
      expect(s[k]!.verified, k).toBe(false);
      expect(s[k]!.manualPath, k).toMatch(/\S{3}/);
      expect(s[k]!.needs, k).toMatch(/\S{3}/);
    }
    expect(s.reports!.detail).toMatch(/switched off/);
    expect(integrationStatus().filter((i) => i.status === 'active').map((i) => i.key).sort()).toEqual(['api', 'connect', 'db', 'storage']);
  });

  it('email is only "active" with the driver and a key; otherwise it says nothing is delivered', () => {
    useEnv({ APP_ENV: 'test' });
    expect(byKey().email!.status).toBe('dev_only');
    expect(byKey().email!.detail).toMatch(/nothing is delivered/i);
    useEnv({ APP_ENV: 'test', EMAIL_DRIVER: 'resend', RESEND_API_KEY: 're_test_key' });
    expect(byKey().email).toMatchObject({ status: 'active', verified: false });
  });
});
