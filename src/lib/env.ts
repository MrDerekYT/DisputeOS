import { z } from 'zod';
import { PRODUCT } from './product';

/**
 * Environment configuration, validated lazily (never at import time, so `next build` works without secrets).
 *
 *   development  local work; insecure-but-convenient defaults are allowed and logged
 *   test         automated tests; fixed throwaway keys
 *   staging      production-like; every secret required, dev defaults rejected
 *   production   same as staging
 *
 * See docs/ENVIRONMENTS.md for the full variable reference.
 */
export type AppEnv = 'development' | 'test' | 'staging' | 'production';

const DEV_PII_KEY = Buffer.alloc(32, 7).toString('base64'); // throwaway, never valid outside dev/test

const base64Key = z
  .string()
  .refine((v) => Buffer.from(v, 'base64').length === 32, 'must be 32 random bytes, base64 encoded (openssl rand -base64 32)');

const schema = z.object({
  APP_ENV: z.enum(['development', 'test', 'staging', 'production']),
  APP_URL: z.string().url(),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  // PEM text of the CA that signed the database's TLS certificate, when it is not a public CA (Supabase). See scripts/pg-config.mjs.
  DATABASE_CA_CERT: z.string().optional(),
  // Connections one server process may hold. Default: 10, or 3 on Vercel (scripts/pg-config.mjs).
  DB_POOL_MAX: z.coerce.number().int().min(1).max(50).optional(),
  PII_ENCRYPTION_KEY: base64Key,
  PII_ENCRYPTION_KEY_ID: z.string().regex(/^[\w-]{1,16}$/).default('1'),
  PII_ENCRYPTION_KEY_PREVIOUS: base64Key.optional(),
  PII_ENCRYPTION_KEY_PREVIOUS_ID: z.string().regex(/^[\w-]{1,16}$/).optional(),
  // Where uploaded documents live: `disk` (STORAGE_DIR, needs a persistent volume) or `db` (the database; for hosts
  // without a persistent disk, such as Vercel). Files are encrypted by the app either way (src/lib/storage.ts).
  STORAGE_DRIVER: z.enum(['disk', 'db']).default('disk'),
  STORAGE_DIR: z.string().default('.storage'),
  // Largest accepted upload, in MB. Default: 10, or 4 on Vercel, whose functions refuse request bodies over 4.5 MB (src/lib/upload.ts).
  MAX_UPLOAD_MB: z.coerce.number().int().min(1).max(10).optional(),
  // Off by default: two-step verification is offered to every user (Settings / profile) but not forced.
  // Set to 'true' to make it mandatory for staff.
  REQUIRE_STAFF_MFA: z.enum(['true', 'false']).default('false'),
  STAFF_IDLE_MINUTES: z.coerce.number().int().min(5).max(1440).default(120),
  // How many reverse proxies sit in front of the app; decides which x-forwarded-for entry is believed (src/lib/client-ip.ts).
  TRUSTED_PROXY_HOPS: z.coerce.number().int().min(1).max(5).default(1),
  // IANA timezone the agency works in; decides what "today" means for a sent-on date left blank.
  APP_TIMEZONE: z.string().refine((tz) => { try { new Intl.DateTimeFormat('en-CA', { timeZone: tz }); return true; } catch { return false; } }, 'must be an IANA timezone such as America/New_York').default('America/New_York'),
  // Email
  // log: written to a local file, nothing is delivered (development/test only) · resend: delivered through Resend ·
  // disabled: nothing is sent and the app says so wherever email would be used (src/lib/mailer.ts).
  EMAIL_DRIVER: z.enum(['log', 'resend', 'disabled']).default('log'),
  EMAIL_FROM: z.string().default(`${PRODUCT.name} <no-reply@localhost>`),
  RESEND_API_KEY: z.string().optional(),
  // Text messages (src/lib/sms.ts)
  // disabled (default): no text is ever sent · twilio: sent through Twilio · log: written to a local file, nothing is
  // delivered (development/test only). Without the Twilio values below, twilio reads as "not connected" in Settings.
  SMS_DRIVER: z.enum(['disabled', 'twilio', 'log']).default('disabled'),
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_MESSAGING_SERVICE_SID: z.string().optional(),
  TWILIO_FROM_NUMBER: z.string().optional(),
  // AI
  AI_PROVIDER: z.enum(['rules', 'anthropic', 'openai']).default('rules'),
  AI_MODEL: z.string().optional(),
  AI_BASE_URL: z.string().url().optional(),
  AI_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  // Scheduled jobs (automation runner endpoint)
  CRON_SECRET: z.string().min(24).optional(),
});

export type Env = z.infer<typeof schema>;

function detectAppEnv(): AppEnv {
  const explicit = process.env.APP_ENV;
  if (explicit === 'development' || explicit === 'test' || explicit === 'staging' || explicit === 'production') return explicit;
  if (process.env.NODE_ENV === 'production') return 'production';
  if (process.env.NODE_ENV === 'test') return 'test';
  return 'development';
}

/** Upload ceiling on Vercel: its functions refuse request bodies over 4.5 MB, and a form adds a little to the file. */
export const VERCEL_MAX_UPLOAD_MB = 4;

let cached: Env | undefined;

export function getEnv(): Env {
  if (cached) return cached;
  const appEnv = detectAppEnv();
  const strict = appEnv === 'staging' || appEnv === 'production';
  const raw: Record<string, string | undefined> = { ...process.env, APP_ENV: appEnv };
  // A blank line in an env file (`CRON_SECRET=`) means "not set", not "set to the empty string".
  for (const k of Object.keys(raw)) if (raw[k]?.trim() === '') delete raw[k];

  if (!strict) {
    raw.PII_ENCRYPTION_KEY ??= DEV_PII_KEY;
    raw.APP_URL ??= 'http://localhost:3000';
    if (appEnv === 'test') {
      raw.DATABASE_URL = raw.DATABASE_URL_TEST ?? raw.DATABASE_URL;
      raw.REQUIRE_STAFF_MFA ??= 'true';
    }
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration (${appEnv}):\n${issues}`);
  }
  const env = parsed.data;
  if (strict) {
    const problems: string[] = [];
    if (env.PII_ENCRYPTION_KEY === DEV_PII_KEY) problems.push('PII_ENCRYPTION_KEY must not be the development key');
    if (!env.APP_URL.startsWith('https://')) problems.push('APP_URL must be https in staging/production');
    // The log driver delivers nothing and writes reset/invitation links in plaintext to disk: development and test only.
    if (env.EMAIL_DRIVER === 'log') problems.push('EMAIL_DRIVER must be resend in staging/production, or disabled to run without email (the log driver delivers nothing)');
    if (env.EMAIL_DRIVER === 'resend' && !env.RESEND_API_KEY) problems.push('RESEND_API_KEY is required when EMAIL_DRIVER=resend');
    if (env.SMS_DRIVER === 'log') problems.push('SMS_DRIVER must be twilio in staging/production, or disabled to run without text messages (the log driver delivers nothing)');
    // Vercel: the filesystem is read-only and not shared between instances, request bodies stop at 4.5 MB, and
    // vercel.json schedules /api/jobs/run, which answers 404 until CRON_SECRET is set.
    if (process.env.VERCEL) {
      if (env.STORAGE_DRIVER !== 'db') problems.push('STORAGE_DRIVER must be db on Vercel (files written to its disk are lost)');
      if ((env.MAX_UPLOAD_MB ?? 0) > VERCEL_MAX_UPLOAD_MB) problems.push(`MAX_UPLOAD_MB cannot be more than ${VERCEL_MAX_UPLOAD_MB} on Vercel (the platform refuses request bodies over 4.5 MB)`);
      if (!env.CRON_SECRET) problems.push('CRON_SECRET is required on Vercel (the scheduled jobs in vercel.json are refused without it)');
    }
    if (problems.length) throw new Error(`Unsafe ${appEnv} configuration:\n  ${problems.join('\n  ')}`);
  }
  cached = env;
  return env;
}

/** Test helper: drop the memoised config after changing process.env. */
export function resetEnvCache() {
  cached = undefined;
}

export const isProd = () => ['staging', 'production'].includes(getEnv().APP_ENV);
export const cookieSecure = () => getEnv().APP_URL.startsWith('https://');
