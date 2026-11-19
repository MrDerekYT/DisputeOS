/**
 * Runs once when the server starts. Validates configuration immediately so a misconfigured staging/production
 * deployment fails at boot with a precise message, instead of failing on the first request.
 * (Skipped during `next build`, which has no runtime secrets.)
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs' || process.env.NEXT_PHASE === 'phase-production-build') return;
  const { getEnv } = await import('./lib/env');
  const env = getEnv();
  console.info(`[disputeos] environment: ${env.APP_ENV} · ai: ${env.AI_PROVIDER} · email: ${env.EMAIL_DRIVER} · staff MFA: ${env.REQUIRE_STAFF_MFA}`);
}
