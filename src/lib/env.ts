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
  PII_ENCRYPTION_KEY: base64Key,
  PII_ENCRYPTION_KEY_ID: z.string().regex(/^[\w-]{1,16}$/).default('1'),
  PII_ENCRYPTION_KEY_PREVIOUS: base64Key.optional(),
  PII_ENCRYPTION_KEY_PREVIOUS_ID: z.string().regex(/^[\w-]{1,16}$/).optional(),
  STORAGE_DIR: z.string().default('.storage'),
  REQUIRE_STAFF_MFA: z.enum(['true', 'false']).default('true'),
  STAFF_IDLE_MINUTES: z.coerce.number().int().min(5).max(1440).default(120),
  // Email
  EMAIL_DRIVER: z.enum(['log', 'resend']).default('log'),
  EMAIL_FROM: z.string().default(`${PRODUCT.name} <no-reply@localhost>`),
  RESEND_API_KEY: z.string().optional(),
  // AI
  AI_PROVIDER: z.enum(['rules', 'anthropic', 'openai']).default('rules'),
  AI_MODEL: z.string().optional(),
  AI_BASE_URL: z.string().url().optional(),
  AI_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  // Billing
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
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

let cached: Env | undefined;

export function getEnv(): Env {
  if (cached) return cached;
  const appEnv = detectAppEnv();
  const strict = appEnv === 'staging' || appEnv === 'production';
  const raw: Record<string, string | undefined> = { ...process.env, APP_ENV: appEnv };

  if (!strict) {
    raw.PII_ENCRYPTION_KEY ??= DEV_PII_KEY;
    raw.APP_URL ??= 'http://localhost:3000';
    if (appEnv === 'test') {
      raw.DATABASE_URL = process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL;
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
    if (env.REQUIRE_STAFF_MFA !== 'true') problems.push('REQUIRE_STAFF_MFA must be true in staging/production');
    if (env.EMAIL_DRIVER === 'resend' && !env.RESEND_API_KEY) problems.push('RESEND_API_KEY is required when EMAIL_DRIVER=resend');
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
