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
    expect(s.connect).toMatchObject({ status: 'dev_only', verified: false });
  });

  it('in production, nothing is presented as connected: all five are manual, with a manual path and the exact dependency', () => {
    useEnv({ APP_ENV: 'production', APP_URL: 'https://app.example.test', DATABASE_URL: 'postgres://x', PII_ENCRYPTION_KEY: randomBytes(32).toString('base64'), REQUIRE_STAFF_MFA: 'true', EMAIL_DRIVER: 'resend', RESEND_API_KEY: 're_test_key' });
    const s = byKey();
    for (const k of PILOT_FIVE) {
      expect(s[k]!.status, k).toBe('manual');
      expect(s[k]!.verified, k).toBe(false);
      expect(s[k]!.manualPath, k).toMatch(/\S{3}/);
      expect(s[k]!.needs, k).toMatch(/\S{3}/);
    }
    expect(s.reports!.detail).toMatch(/switched off/);
    // Credit Connect has no live provider: it must not read as active or verified anywhere.
    expect(s.connect).toMatchObject({ status: 'manual', verified: false });
    expect(s.connect!.manualPath).toMatch(/\S{3}/);
    expect(integrationStatus().filter((i) => i.status === 'active').map((i) => i.key).sort()).toEqual(['api', 'db', 'email', 'storage']);
  });

  it('email is only "active" with the driver and a key; otherwise it says nothing is delivered', () => {
    useEnv({ APP_ENV: 'test' });
    expect(byKey().email!.status).toBe('dev_only');
    expect(byKey().email!.detail).toMatch(/nothing is delivered/i);
    useEnv({ APP_ENV: 'test', EMAIL_DRIVER: 'resend', RESEND_API_KEY: 're_test_key' });
    expect(byKey().email).toMatchObject({ status: 'active', verified: false });
  });

  it('AI: "needs credentials" when a provider is chosen without its key, and never "verified" once one is chosen', () => {
    useEnv({ APP_ENV: 'test', AI_PROVIDER: 'rules' });
    expect(byKey().ai).toMatchObject({ name: 'AI assistant (rules)', status: 'dev_only' });
    useEnv({ APP_ENV: 'test', AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: '' });
    expect(byKey().ai).toMatchObject({ name: 'AI assistant (anthropic)', status: 'needs_credentials', verified: false });
    expect(byKey().ai!.detail).toMatch(/ANTHROPIC_API_KEY still to set\. No AI call is made/);
    useEnv({ APP_ENV: 'test', AI_PROVIDER: 'openai', AI_BASE_URL: 'https://api.example.test/v1', AI_MODEL: 'm' });
    expect(byKey().ai).toMatchObject({ status: 'needs_credentials' });
    expect(byKey().ai!.detail).toMatch(/AI_API_KEY still to set/);
    useEnv({ APP_ENV: 'test', AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'sk-ant-integrations-test' });
    expect(byKey().ai).toMatchObject({ name: 'AI assistant (anthropic:claude-opus-5-5)', status: 'active', verified: false });
    expect(byKey().ai!.detail).toMatch(/proven live only once npm run ai:prove has passed with a real key/);
    expect(JSON.stringify(integrationStatus())).not.toContain('sk-ant-integrations-test');
  });
});
