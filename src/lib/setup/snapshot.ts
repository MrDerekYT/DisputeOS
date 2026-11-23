import { aiConfig } from '../ai/provider';
import { parseTerms } from '../compliance/agreement-terms';
import type { Ctx } from '../auth/context';
import { US_ZONES } from '../client-updates/templates';
import { withSystem } from '../db';
import { getEnv } from '../env';
import { outreachSettings } from '../lead-outreach';
import { smsStatus, twilioWebhookUrl } from '../sms';
import type { SetupSnapshot } from './checklist';

/** organizations.settings keys written when a provider accepts a test sent from the setup page (src/lib/setup/test-send.ts). */
export const EMAIL_TEST_KEY = 'setup_email_test_at';
export const SMS_TEST_KEY = 'setup_sms_test_at';
/** Written when the AI connection test passes (src/lib/setup/test-ai.ts): when, and the provider and model it passed with. */
export const AI_TEST_KEY = 'setup_ai_test_at';
export const AI_TEST_PROVIDER_KEY = 'setup_ai_test_provider';

const isoOrNull = (v: unknown): string | null => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? v : null);

/**
 * What is really configured, for the setup checklist. Reads names and present/missing only: no secret and no
 * environment value leaves this function, except the webhook address built from APP_URL and the AI provider and model
 * name (for example anthropic:claude-opus-5-5), which is not a secret and is shown on the AI assistant page too.
 */
export async function loadSetupSnapshot(ctx: Pick<Ctx, 'tx' | 'orgId'>): Promise<SetupSnapshot> {
  const env = getEnv();
  const sms = smsStatus();
  const { org, job } = await ctx.tx(async (db) => ({
    org: await db.row<{ settings: Record<string, unknown>; mode: string }>('select settings, mode from public.organizations where id = $1', [ctx.orgId]),
    job: await db.row<{ started_at: string; status: string }>('select started_at, status from public.job_runs where org_id = $1 order by started_at desc limit 1', [ctx.orgId]),
  }));
  // One Twilio account serves the whole deployment, so "has Twilio ever reached the webhook" is a deployment-wide
  // fact. Only a timestamp is read: an inbound text that was stored, or failing that a text marked delivered (which
  // only a delivery report does).
  const seen = sms.state !== 'connected' ? null : await withSystem(async (db) =>
    (await db.row<{ at: string | null }>('select max(created_at) as at from public.sms_inbound'))?.at
    ?? (await db.row<{ at: string }>("select created_at as at from public.communications where channel = 'sms' and direction = 'outbound' and status = 'delivered' limit 1"))?.at
    ?? null);
  const settings = org?.settings ?? {};
  const outreach = outreachSettings(settings);
  const aiTestedWith = settings[AI_TEST_PROVIDER_KEY];
  return {
    email: { driver: env.EMAIL_DRIVER, hasApiKey: !!env.RESEND_API_KEY, fromSet: !/@localhost>?\s*$/i.test(env.EMAIL_FROM), testAcceptedAt: isoOrNull(settings[EMAIL_TEST_KEY]) },
    sms: { state: sms.state, missing: sms.missing, webhookUrl: twilioWebhookUrl(), webhookReachable: /^https:\/\/(?!localhost|127\.)/i.test(env.APP_URL),
      webhookSeenAt: seen ? new Date(seen).toISOString() : null, testAcceptedAt: isoOrNull(settings[SMS_TEST_KEY]) },
    agency: { isAgency: org?.mode === 'agency', mailingAddress: !!outreach.address, replyEmail: !!outreach.replyTo, timezoneChosen: US_ZONES.some((z) => z.value === settings.timezone), agreementTerms: !!parseTerms(settings) },
    jobs: { cronSecretSet: !!env.CRON_SECRET, lastRunAt: job ? new Date(job.started_at).toISOString() : null, lastRunOk: job?.status === 'ok' },
    ai: { ...aiConfig(), testPassedAt: isoOrNull(settings[AI_TEST_KEY]), testProvider: typeof aiTestedWith === 'string' ? aiTestedWith.slice(0, 120) : null },
    now: new Date().toISOString(),
  };
}
