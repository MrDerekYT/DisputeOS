import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getEnv, resetEnvCache } from '@/lib/env';
import { sendEmail, sentLog } from '@/lib/mailer';
import { fill, portalMessage, tr } from '@/lib/portal-i18n';
import { maxUploadBytes, maxUploadMb, readUpload, tooLargeMessage, UploadError } from '@/lib/upload';
import { explainPgError, pgConnectionConfig, pgPoolMax } from '../../scripts/pg-config.mjs';

const root = path.resolve(__dirname, '../..');
const CA = '-----BEGIN CERTIFICATE-----\nMIIBfake\n-----END CERTIFICATE-----';
const PROD = { APP_ENV: 'production', DATABASE_URL: 'postgres://x/y', APP_URL: 'https://app.example.com', PII_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64'), EMAIL_DRIVER: 'resend', RESEND_API_KEY: 're_test_key' };

const saved = { ...process.env };
beforeEach(() => resetEnvCache());
afterEach(() => { process.env = { ...saved }; resetEnvCache(); vi.restoreAllMocks(); });

describe('database connection settings (scripts/pg-config.mjs)', () => {
  it('reaches a remote database over TLS with the certificate verified, and never switches verification off', () => {
    const pooler = 'postgres://postgres.abcdefghijklmnopqrst:pw@aws-0-us-east-1.pooler.supabase.com:6543/postgres';
    expect(pgConnectionConfig(pooler, {})).toEqual({ connectionString: pooler, ssl: { rejectUnauthorized: true } });
    expect(pgConnectionConfig(pooler, { DATABASE_CA_CERT: CA })).toEqual({ connectionString: pooler, ssl: { rejectUnauthorized: true, ca: CA } });
    // A one-line value with literal \n (how some dashboards store multi-line secrets) is the same certificate.
    expect(pgConnectionConfig(pooler, { DATABASE_CA_CERT: CA.replace(/\n/g, '\\n') }).ssl).toEqual({ rejectUnauthorized: true, ca: CA });
    for (const mode of ['require', 'prefer', 'no-verify', 'verify-ca', 'verify-full']) {
      const c = pgConnectionConfig(`${pooler}?sslmode=${mode}`, {});
      expect(c.ssl, mode).toEqual({ rejectUnauthorized: true });
      expect(c.connectionString, mode).toBe(pooler); // pg would let an sslmode in the URL replace the ssl settings
    }
    expect(() => pgConnectionConfig(pooler, { DATABASE_CA_CERT: 'not a certificate' })).toThrow(/PEM/);
  });

  it('uses no TLS for a database on this machine or with an explicit sslmode=disable, and nothing else', () => {
    for (const local of ['postgres://u:p@localhost:5432/db', 'postgres://u:p@127.0.0.1/db', 'postgres://u@/db?host=/var/run/postgresql', 'postgres://u:p@[::1]:5432/db']) {
      expect(pgConnectionConfig(local, {}), local).toEqual({ connectionString: local, ssl: false });
    }
    expect(pgConnectionConfig('postgres://u:p@db:5432/x?sslmode=disable', {})).toEqual({ connectionString: 'postgres://u:p@db:5432/x', ssl: false });
    expect(pgConnectionConfig('postgres://u:p@db:5432/x', {}).ssl).toEqual({ rejectUnauthorized: true });
    expect(pgConnectionConfig('postgres://u:p@localhost/db?sslmode=require', {}).ssl).toEqual({ rejectUnauthorized: true });
    expect(() => pgConnectionConfig('not a url', {})).toThrow(/not a valid postgres/);
  });

  it('decides local or remote from the host pg will really connect to', () => {
    delete process.env.PGHOST;
    const verified = { rejectUnauthorized: true };
    // The form scripts/setup-local-db.sh writes: a percent-encoded socket directory as the host.
    expect(pgConnectionConfig('postgres://u@%2Fvar%2Frun%2Fpostgresql/db', {}).ssl).toBe(false);
    expect(pgConnectionConfig('postgres://u@/db', {}).ssl).toBe(false);
    // A host= parameter replaces the host in the URL, whatever that was.
    for (const remote of ['postgres://u:p@/db?host=evil.example.com', 'postgres://u@%2Fvar%2Frun%2Fpostgresql/db?host=evil.example.com', 'postgres://u@localhost/db?host=evil.example.com', 'postgres://u@/db?host=/tmp&host=evil.example.com']) {
      expect(pgConnectionConfig(remote, {}).ssl, remote).toEqual(verified);
    }
    // With no host anywhere pg uses PGHOST.
    process.env.PGHOST = 'db.example.com';
    expect(pgConnectionConfig('postgres://u@/db', {}).ssl).toEqual(verified);
    expect(pgConnectionConfig('postgres://u@/db?host=/var/run/postgresql', {}).ssl).toBe(false);
  });

  it('refuses sslmode=disable on Vercel', () => {
    expect(() => pgConnectionConfig('postgres://u:p@db.example.com/db?sslmode=disable', { VERCEL: '1' })).toThrow(/sslmode=disable/);
    expect(pgConnectionConfig('postgres://u:p@db.example.com/db?sslmode=require', { VERCEL: '1' }).ssl).toEqual({ rejectUnauthorized: true });
  });

  it('keeps the pool small on Vercel and lets DB_POOL_MAX override it', () => {
    expect(pgPoolMax({})).toBe(10);
    expect(pgPoolMax({ VERCEL: '1' })).toBe(3);
    expect(pgPoolMax({ VERCEL: '1', DB_POOL_MAX: '5' })).toBe(5);
    expect(pgPoolMax({ DB_POOL_MAX: 'lots' })).toBe(10);
  });

  it('explains a certificate failure in terms of DATABASE_CA_CERT', () => {
    expect(explainPgError(Object.assign(new Error('self-signed certificate in certificate chain'), { code: 'SELF_SIGNED_CERT_IN_CHAIN' }))).toMatch(/DATABASE_CA_CERT/);
    expect(explainPgError(new Error('password authentication failed'))).toBe('password authentication failed');
  });
});

describe('production rules for Vercel', () => {
  const vercel = (extra: Record<string, string> = {}) => { Object.assign(process.env, PROD, { VERCEL: '1', STORAGE_DRIVER: 'db', CRON_SECRET: 'c'.repeat(48) }, extra); resetEnvCache(); };

  it('accepts a complete configuration', () => {
    vercel();
    expect(getEnv()).toMatchObject({ APP_ENV: 'production', STORAGE_DRIVER: 'db' });
  });
  it('refuses disk storage, a missing cron secret and an upload limit above what the platform accepts', () => {
    vercel({ STORAGE_DRIVER: 'disk' });
    expect(() => getEnv()).toThrow(/STORAGE_DRIVER must be db on Vercel/);
    vercel(); delete process.env.STORAGE_DRIVER; resetEnvCache();
    expect(() => getEnv()).toThrow(/STORAGE_DRIVER must be db on Vercel/);
    vercel(); delete process.env.CRON_SECRET; resetEnvCache();
    expect(() => getEnv()).toThrow(/CRON_SECRET is required on Vercel/);
    vercel({ MAX_UPLOAD_MB: '5' });
    expect(() => getEnv()).toThrow(/MAX_UPLOAD_MB cannot be more than 4 on Vercel/);
    vercel({ MAX_UPLOAD_MB: '3' });
    expect(maxUploadMb()).toBe(3);
  });
  it('does not apply the Vercel rules to other production hosts', () => {
    Object.assign(process.env, PROD); delete process.env.VERCEL; delete process.env.STORAGE_DRIVER; delete process.env.CRON_SECRET; resetEnvCache();
    expect(getEnv()).toMatchObject({ STORAGE_DRIVER: 'disk' });
  });
});

describe('running without an email provider (EMAIL_DRIVER=disabled)', () => {
  it('is accepted in production, unlike the log driver', () => {
    Object.assign(process.env, PROD, { EMAIL_DRIVER: 'disabled' }); delete process.env.RESEND_API_KEY; delete process.env.VERCEL; resetEnvCache();
    expect(getEnv().EMAIL_DRIVER).toBe('disabled');
  });
  it('sends nothing, records nothing and never reports success', async () => {
    process.env.EMAIL_DRIVER = 'disabled'; resetEnvCache();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const before = sentLog.length;
    const r = await sendEmail({ to: 'someone@example.com', subject: 'Reset', text: 'https://app.example.com/reset-password?token=secret' });
    expect(r).toEqual({ ok: false, provider: 'disabled', error: 'Email is not connected' });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(sentLog.length).toBe(before);
    expect(existsSync(path.join(getEnv().STORAGE_DIR, 'outbox', 'emails.jsonl'))).toBe(false);
  });
});

describe('upload size limit', () => {
  const tooBig = async (bytes: number) => {
    try { await readUpload({ size: bytes, name: 'big.pdf' } as File, ['application/pdf']); } catch (e) { if (e instanceof UploadError) return e.message; throw e; }
    return null;
  };
  it('is 10 MB by default, 4 MB on Vercel, and MAX_UPLOAD_MB overrides both', async () => {
    delete process.env.VERCEL; delete process.env.MAX_UPLOAD_MB; resetEnvCache();
    expect(maxUploadMb()).toBe(10);
    expect(await tooBig(10 * 1024 * 1024 + 1)).toBe('That file is larger than 10 MB.');
    process.env.VERCEL = '1'; resetEnvCache();
    expect(maxUploadMb()).toBe(4);
    expect(maxUploadBytes()).toBeLessThan(4.5 * 1024 * 1024);
    expect(await tooBig(4 * 1024 * 1024 + 1)).toBe('That file is larger than 4 MB.');
    delete process.env.VERCEL; process.env.MAX_UPLOAD_MB = '2'; resetEnvCache();
    expect(await tooBig(2 * 1024 * 1024 + 1)).toBe('That file is larger than 2 MB.');
    process.env.MAX_UPLOAD_MB = '50'; resetEnvCache();
    expect(() => maxUploadMb()).toThrow(/MAX_UPLOAD_MB/);
  });
  it('states the same limit in the server message, the browser message and the help text, in English and Spanish', () => {
    process.env.VERCEL = '1'; delete process.env.MAX_UPLOAD_MB; resetEnvCache();
    const mb = maxUploadMb();
    const server = tooLargeMessage(mb);
    expect(portalMessage('en', server)).toBe(server);
    expect(fill(tr('en')('e_fileTooLarge'), { max: mb })).toBe(server);
    expect(portalMessage('es', server)).toBe('Ese archivo pesa más de 4 MB.');
    expect(fill(tr('es')('e_fileTooLarge'), { max: mb })).toBe('Ese archivo pesa más de 4 MB.');
    expect(fill(tr('en')('uploadHelp'), { max: mb })).toContain('up to 4 MB');
    expect(fill(tr('es')('uploadHelp'), { max: mb })).toContain('hasta 4 MB');
  });
  it('has no hard-coded size left in source or copy', () => {
    for (const f of ['src/lib/portal-i18n.ts', 'src/lib/guide/knowledge.ts', 'src/lib/upload.ts', 'src/app/app/clients/[id]/page.tsx', 'src/app/portal/(app)/documents/page.tsx', 'src/app/(marketing)/security/page.tsx']) {
      expect(readFileSync(path.join(root, f), 'utf8'), f).not.toMatch(/\b10 ?MB\b/);
    }
  });
});

describe('Vercel project files', () => {
  it('schedules the jobs route, which answers GET (what Vercel Cron sends) and refuses a request without the secret', async () => {
    const cfg = JSON.parse(readFileSync(path.join(root, 'vercel.json'), 'utf8')) as { crons: { path: string; schedule: string }[] };
    expect(cfg.crons).toEqual([{ path: '/api/jobs/run', schedule: expect.stringMatching(/^\S+ \S+ \S+ \S+ \S+$/) }]);
    const route = await import('@/app/api/jobs/run/route');
    expect(route.maxDuration).toBeGreaterThan(0);
    const call = (method: 'GET' | 'POST', auth?: string) => route[method](new Request('http://localhost/api/jobs/run', { method, headers: auth ? { authorization: auth } : {} }));
    delete process.env.CRON_SECRET; resetEnvCache();
    expect((await call('GET')).status).toBe(404);
    process.env.CRON_SECRET = 's'.repeat(32); resetEnvCache();
    for (const m of ['GET', 'POST'] as const) {
      expect((await call(m)).status).toBe(401);
      expect((await call(m, 'Bearer wrong')).status).toBe(401);
      expect((await call(m, `Basic ${'s'.repeat(32)}`)).status).toBe(401);
    }
  });
  it('builds on Vercel by migrating first, and leaves the plain build alone', () => {
    const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    expect(pkg.scripts.build).toBe('next build');
    expect(pkg.scripts['vercel-build']).toBe('node scripts/migrate.mjs && next build');
  });
  it('does not touch the database on a Preview build', () => {
    // Port 1 refuses connections, so anything other than a skip fails.
    const run = (VERCEL_ENV: string) => spawnSync(process.execPath, ['scripts/migrate.mjs'], { cwd: root, encoding: 'utf8', env: { PATH: process.env.PATH, NODE_ENV: 'development', VERCEL_ENV, DATABASE_URL: 'postgres://u:p@127.0.0.1:1/db' } });
    const preview = run('preview');
    expect(preview.status).toBe(0);
    expect(preview.stdout).toMatch(/Preview build: migrations are not applied/);
    const production = run('production');
    expect(production.status).toBe(1);
    expect(production.stderr).toMatch(/Could not connect to the database/);
  });
});
