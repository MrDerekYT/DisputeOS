import { aiConfig, AiUnavailable, getProvider, type AiFailure, type AiProvider } from '../ai/provider';
import { audit } from '../audit';
import { rateLimit } from '../auth/rate-limit';
import { UserError } from '../errors';
import { can, PermissionError } from '../rbac';
import { AI_TEST_KEY, AI_TEST_PROVIDER_KEY } from './snapshot';
import type { TestActor, TestSendResult } from './test-send';

/**
 * "Test the AI connection" on the setup page. It:
 *  - needs settings:manage (checked here, so the rule holds wherever it is called from);
 *  - makes one fixed, tiny request with no client data, no workspace data and nothing anyone typed (AI_TEST_REQUEST);
 *  - is free (no AI credits) and rate limited per person, per workspace and for the whole deployment, because the key
 *    and its bill belong to the deployment; the limits are spent only when a request is really made;
 *  - records, when it passes, the time and the provider and model it passed with, which ticks the AI step on the
 *    checklist; a failure that will not pass on its own (the key, the model or effort, a rejected request, the
 *    account's monthly spending limit, a refusal, a wrong answer) withdraws that record, one the service causes for a
 *    moment (busy, failing, slow, unreachable) leaves it as it was;
 *  - writes an audit entry with the provider name and the outcome only;
 *  - reports what really happened. Nothing is reworded into a pass.
 */
export const TEST_AI_LIMIT = { max: 5, windowSec: 3600 };
export const TEST_AI_ORG_LIMIT = { max: 10, windowSec: 3600 };
export const TEST_AI_ALL_LIMIT = { max: 100, windowSec: 86_400 };

/** The word the test asks for. */
export const AI_TEST_WORD = 'CONNECTED';
/** The whole request. A one-word reply needs little room, and 4,000 tokens still leaves the model room to think. */
export const AI_TEST_REQUEST = {
  system: 'You are answering an automated connection check for a business application. Follow the instruction exactly.',
  user: `Reply with the single word ${AI_TEST_WORD} and nothing else.`,
  maxTokens: 4000,
} as const;

const waitText = (sec: number) => (sec >= 5400 ? `${Math.ceil(sec / 3600)} hours` : `${Math.max(1, Math.ceil(sec / 60))} minutes`);
const said = (reply: string) => reply.trim().replace(/^["'“”‘’`*\s]+|["'“”‘’`*.!\s]+$/g, '').toUpperCase();

/** Where the cause of a refused Claude request can be read: the [ai] log line has no message text, the live proof does. */
const DIAGNOSE = 'The server log line that starts with [ai] has the request id, and npm run ai:prove prints the service’s own explanation.';

/** What to do next. Only a 404, or a 400 the adapter puts down to a chosen model or effort ('settings'), names AI_MODEL and AI_EFFORT. */
function hint(kind: AiFailure | 'wrong_answer', provider: string, code: string | null): string {
  const openai = provider.startsWith('openai:');
  const key = openai ? 'AI_API_KEY' : 'ANTHROPIC_API_KEY';
  if (openai && (kind === 'model' || kind === 'settings' || kind === 'request')) return 'Check AI_MODEL and AI_BASE_URL where the app is hosted: the OpenAI-compatible endpoint did not accept the model or the request.';
  switch (kind) {
    case 'auth': case 'forbidden': return `Check ${key} where the app is hosted (on Vercel: Project → Settings → Environment Variables), then redeploy.`;
    case 'model': return 'Check AI_MODEL and AI_EFFORT where the app is hosted. This app is built for current Claude models: claude-opus-5-5, claude-sonnet-5-5 or claude-haiku-5-5, with AI_EFFORT low, medium or high.';
    case 'settings': return `Check AI_MODEL and AI_EFFORT where the app is hosted. This app is built for current Claude models: claude-opus-5-5, claude-sonnet-5-5 or claude-haiku-5-5, with AI_EFFORT low, medium or high. ${DIAGNOSE}`;
    case 'request': return code
      ? `The service gave the reason as ${code}: check the organization in the Anthropic Console. ${DIAGNOSE}`
      : `AI_MODEL and AI_EFFORT are at the defaults this app is built for, so the cause is elsewhere, such as a feature the Anthropic organization is not enabled for. ${DIAGNOSE}`;
    case 'spend_limit': return 'Until then every AI feature keeps its standard wording and gives the credits back. Test again once the limit has reset or been raised.';
    case 'busy': case 'server': case 'timeout': case 'network': return 'The AI service did not answer properly this time. Try again in a minute; the step keeps its last result.';
    case 'refused': return 'The model declined the fixed test request. Try again; if it happens again, contact the AI provider.';
    case 'wrong_answer': return `It answered, but not with the word ${AI_TEST_WORD} it was asked for, so this does not count as a pass. Try again; if it happens again, check AI_MODEL.`;
    default: return 'Try again. If it happens again, check the server log (for Claude, the line that starts with [ai]).';
  }
}

/** Runs the test. `opts.provider` is for tests; by default the configured provider is used. */
export async function testAiConnection(a: TestActor, opts: { provider?: AiProvider | null } = {}): Promise<TestSendResult> {
  if (!can(a.role, 'settings:manage')) throw new PermissionError('settings:manage');
  const provider = opts.provider === undefined ? getProvider() : opts.provider;
  if (!provider) {
    const c = aiConfig();
    return { ok: false, message: c.state === 'needs_credentials'
      ? `Not tested: an AI provider is chosen (${c.provider}) but not connected. Still to set: ${c.missing.join(', ')}.`
      : 'Not tested: no AI provider is connected (AI_PROVIDER=rules), so the built-in wording is used and there is nothing to test.' };
  }
  const limit = await rateLimit(`setup-test-ai:user:${a.userId}`, TEST_AI_LIMIT.max, TEST_AI_LIMIT.windowSec);
  if (!limit.allowed) throw new UserError(`You have tested the AI connection ${TEST_AI_LIMIT.max} times in the last hour. Try again in ${waitText(limit.retryAfterSec)}.`);
  const orgLimit = await rateLimit(`setup-test-ai:org:${a.orgId}`, TEST_AI_ORG_LIMIT.max, TEST_AI_ORG_LIMIT.windowSec);
  if (!orgLimit.allowed) throw new UserError(`Your workspace has tested the AI connection ${TEST_AI_ORG_LIMIT.max} times in the last hour. Try again in ${waitText(orgLimit.retryAfterSec)}.`);
  const allLimit = await rateLimit('setup-test-ai:all', TEST_AI_ALL_LIMIT.max, TEST_AI_ALL_LIMIT.windowSec);
  if (!allLimit.allowed) throw new UserError(`AI connection tests are paused for today across the platform. Try again in ${waitText(allLimit.retryAfterSec)}.`);

  const started = Date.now();
  let failure: AiUnavailable | null = null;
  let reply = '';
  try {
    reply = await provider.complete({ ...AI_TEST_REQUEST });
  } catch (e) {
    failure = e instanceof AiUnavailable ? e : new AiUnavailable((e as Error).message || 'the AI provider failed');
  }
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  const outcome: AiFailure | 'wrong_answer' | null = failure ? failure.kind : said(reply) === AI_TEST_WORD ? null : 'wrong_answer';
  const passed = outcome === null;
  const withdraw = !passed && !failure?.retryable;

  await a.tx(async (db) => {
    if (passed) {
      await db.run('update public.organizations set settings = settings || jsonb_build_object($2::text, $3::text, $4::text, $5::text) where id = $1',
        [a.orgId, AI_TEST_KEY, new Date().toISOString(), AI_TEST_PROVIDER_KEY, provider.name]);
    } else if (withdraw) {
      await db.run('update public.organizations set settings = settings - $2::text - $3::text where id = $1', [a.orgId, AI_TEST_KEY, AI_TEST_PROVIDER_KEY]);
    }
    await audit(db, { orgId: a.orgId, actorId: a.userId, action: 'setup.test_ai', entityType: 'organization', entityId: a.orgId, ip: a.ip ?? null, meta: { provider: provider.name, passed, failure: outcome } });
  });

  if (passed) return { ok: true, message: `Passed: ${provider.name} answered in ${seconds} s. Nothing about your clients or your workspace was sent: the test asks for one fixed word, and no AI credits were used.` };
  const why = failure ? failure.message : 'the reply was not the word it was asked for';
  return { ok: false, message: `Did not pass (${provider.name}): ${why}. ${hint(outcome!, provider.name, failure?.code ?? null)}` };
}
