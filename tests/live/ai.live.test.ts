/**
 * The live proof: one real call per AI feature, against the provider configured in the environment, on the synthetic
 * client Jordan Rivera (tests/fixtures/jordan-rivera.ts). Skipped unless AI_LIVE=1. Run it with:
 *
 *   AI_PROVIDER=anthropic ANTHROPIC_API_KEY=<key> [AI_MODEL=claude-opus-5-5] [AI_EFFORT=low] npm run ai:prove
 *
 * (npm run ai:prove sets AI_LIVE=1.) It needs the test database for the Setup connection test, which records its result
 * and an audit entry (npm run env:setup, or DATABASE_URL_TEST). It costs a few cents: six short requests.
 *
 * For every call it prints the request sent (system and user text), the raw reply, and the adapter's log line (stop
 * reason, input and output tokens, time, request id; for a failed call the HTTP status, error type and error code),
 * then what the feature did with the reply. A failed call also prints the service's own explanation, which the app
 * never shows or logs. It asserts that every call was answered and finished (stop reason end_turn), that the
 * connection test passed, and that no personal data of the fixture (names, address, account and SSN digits, date of
 * birth, email) is in any request. A reply the safety checks discard is printed, not failed: that is the checks
 * working, and the rate at which it happens is worth knowing.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { polishedProgress } from '@/lib/ai/assistant';
import { AiUnavailable, getProvider, type AiProvider, type AiRequest } from '@/lib/ai/provider';
import { getEnv, resetEnvCache } from '@/lib/env';
import { buildGuideReply } from '@/lib/guide/ask';
import { clientIdentifiers } from '@/lib/guide/steps';
import { tailorSafely } from '@/lib/letters/tailor';
import { AI_TEST_KEY, AI_TEST_PROVIDER_KEY } from '@/lib/setup/snapshot';
import { testAiConnection } from '@/lib/setup/test-ai';
import type { TestActor } from '@/lib/setup/test-send';
import type { TestOrg } from '../db/helpers';
import { JORDAN_PII, JORDAN_QUESTION, JORDAN_RECORD, JORDAN_REDACT, JORDAN_STEPS, jordanLetter, jordanProgress, withoutCanary } from '../fixtures/jordan-rivera';

const LIVE = process.env.AI_LIVE === '1';
const PER_CALL_MS = 120_000;
/** What the guide's loaders (src/lib/guide/steps.ts) hold about Jordan besides the names, as production passes it. */
const JORDAN_IDENTIFIERS = clientIdentifiers({ address: JORDAN_RECORD.client.address, ssn_last4: JORDAN_RECORD.client.ssn_last4, dob: JORDAN_RECORD.client.dob });

interface Recorded { feature: string; req: AiRequest; reply?: string; error?: string; explanation?: string | null; ms: number; log: string[] }

describe.skipIf(!LIVE)('live AI proof (AI_LIVE=1: real calls to the configured provider)', () => {
  const calls: Recorded[] = [];
  const logLines: string[] = [];
  let feature = '';
  let live: AiProvider;

  beforeAll(() => {
    resetEnvCache();
    const env = getEnv();
    if (env.AI_PROVIDER !== 'anthropic' || !env.ANTHROPIC_API_KEY) {
      throw new Error('The live proof needs AI_PROVIDER=anthropic and ANTHROPIC_API_KEY set in the environment of this command (never in a file). Nothing was sent.');
    }
    const real = getProvider()!;
    // The adapter writes one line per call to the console; keep a copy to print beside the request it belongs to.
    for (const level of ['info', 'warn'] as const) {
      const original = console[level].bind(console);
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { const line = args.map(String).join(' '); if (line.startsWith('[ai] ')) logLines.push(line); original(...args); });
    }
    live = {
      name: real.name,
      async complete(req) {
        const started = Date.now();
        const from = logLines.length;
        try {
          const reply = await real.complete(req);
          calls.push({ feature, req, reply, ms: Date.now() - started, log: logLines.slice(from) });
          return reply;
        } catch (e) {
          const explanation = e instanceof AiUnavailable ? e.apiMessage : null;
          calls.push({ feature, req, error: (e as Error).message, explanation, ms: Date.now() - started, log: logLines.slice(from) });
          throw e;
        }
      },
    };
    console.log(`\nLive AI proof against ${real.name} (effort ${env.AI_EFFORT ?? 'low'}), ${new Date().toISOString()}\n`);
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    console.log(`\n════ Summary ════${calls.length ? '' : '\n(no calls were made)'}`);
    for (const c of calls) {
      console.log(`${c.feature.padEnd(34)} ${String(c.ms).padStart(6)} ms  ${c.error ? `FAILED: ${c.error}` : 'answered'}  ${c.log.join(' | ')}`);
      if (c.explanation) console.log(`${''.padEnd(34)} the service said: ${c.explanation}`);
    }
    try { const { closePool } = await import('../db/helpers'); await closePool(); } catch { /* the database was never opened */ }
  });

  /** Prints the call(s) a feature made, and checks each was answered and finished. */
  function report(name: string, outcome: Record<string, unknown>) {
    const mine = calls.filter((c) => c.feature === name);
    for (const c of mine) {
      console.log(`\n════ ${name} ════\n---- request: system ----\n${c.req.system}\n---- request: user ----\n${c.req.user}\n---- request: max tokens ----\n${c.req.maxTokens ?? '(default)'}`);
      console.log(`---- raw reply (${c.ms} ms) ----\n${c.error ? `ERROR: ${c.error}${c.explanation ? `\nThe service said: ${c.explanation}` : ''}` : c.reply}\n---- adapter log ----\n${c.log.join('\n') || '(none)'}`);
    }
    console.log(`---- what the feature did ----\n${JSON.stringify(outcome, null, 2)}`);
    expect(mine.length, `${name} made no call`).toBeGreaterThan(0);
    for (const c of mine) {
      expect(c.error, `${name}: the provider failed`).toBeUndefined();
      expect(c.log.join(' '), `${name}: the reply did not finish`).toMatch(/stop=end_turn/);
      expect(c.log.join(' ')).toMatch(/request=req_/);
    }
  }
  const run = async <T>(name: string, fn: () => Promise<T>): Promise<T> => { feature = name; try { return await fn(); } finally { feature = ''; } };

  it('letter wording suggestion (tailorSafely on the letter drafted for Jordan Rivera)', async () => {
    const letter = jordanLetter();
    const r = await run('Letter wording suggestion', () => tailorSafely(letter.body, letter.input, live));
    report('Letter wording suggestion', { usedAi: r.usedAi, note: r.note ?? null, changedLines: r.usedAi ? r.text.split('\n').filter((l) => !letter.body.split('\n').includes(l)) : [] });
  }, PER_CALL_MS);

  it('client progress note polish, English', async () => {
    const r = await run('Progress note (English)', () => polishedProgress(jordanProgress('en'), live));
    report('Progress note (English)', { usedAi: r.usedAi, note: r.note ?? null, text: r.text });
  }, PER_CALL_MS);

  it('client progress note polish, Spanish', async () => {
    const r = await run('Progress note (Spanish)', () => polishedProgress(jordanProgress('es'), live));
    report('Progress note (Spanish)', { usedAi: r.usedAi, note: r.note ?? null, text: r.text });
  }, PER_CALL_MS);

  it('credit guide answer, staff (asked from the client’s page)', async () => {
    const r = await run('Credit guide (staff)', () => buildGuideReply({ question: JORDAN_QUESTION, lang: 'en', audience: 'app', personal: { steps: JORDAN_STEPS, redact: JORDAN_REDACT.staff, identifiers: JORDAN_IDENTIFIERS } }, live));
    report('Credit guide (staff)', { mode: r.mode, note: r.note ?? null, answer: r.answer });
  }, PER_CALL_MS);

  it('credit guide answer, client portal', async () => {
    const r = await run('Credit guide (portal)', () => buildGuideReply({ question: JORDAN_QUESTION, lang: 'en', audience: 'portal', personal: { steps: JORDAN_STEPS, redact: JORDAN_REDACT.portal, identifiers: JORDAN_IDENTIFIERS } }, live));
    report('Credit guide (portal)', { mode: r.mode, note: r.note ?? null, answer: r.answer });
  }, PER_CALL_MS);

  it('the Setup page’s “Test the AI connection” passes, and records its time, model and audit entry', async () => {
    const helpers = await import('../db/helpers');
    let o: TestOrg;
    try {
      o = await helpers.makeOrg('LiveAiProof');
    } catch (e) {
      throw new Error(`The Setup connection test records its result and an audit entry in the test database, which could not be used (${(e as Error).message}). Start it with npm run env:setup, or set DATABASE_URL_TEST.`);
    }
    const actor: TestActor = { userId: o.ownerId, orgId: o.orgId, role: 'owner', email: o.ownerEmail, orgName: 'Live proof', tx: (fn) => helpers.asUser(o.ownerId, fn) };
    const r = await run('Setup: test the AI connection', () => testAiConnection(actor, { provider: live }));
    const settings = (await helpers.withSystem((db) => db.row<{ settings: Record<string, unknown> }>('select settings from public.organizations where id = $1', [o.orgId])))!.settings;
    const audit = await helpers.withSystem((db) => db.rows<{ metadata: Record<string, unknown> }>("select metadata from public.audit_logs where org_id = $1 and action = 'setup.test_ai'", [o.orgId]));
    report('Setup: test the AI connection', { result: r, recorded: { at: settings[AI_TEST_KEY] ?? null, with: settings[AI_TEST_PROVIDER_KEY] ?? null }, audit: audit.map((a) => a.metadata) });
    expect(r.ok, r.message).toBe(true);
    expect(settings[AI_TEST_PROVIDER_KEY]).toBe(live.name);
    expect(audit.map((a) => a.metadata)).toEqual([{ provider: live.name, passed: true, failure: null }]);
  }, PER_CALL_MS);

  it('no personal data of the fixture is in any request that was sent', () => {
    expect(calls.length).toBeGreaterThanOrEqual(6);
    for (const c of calls) {
      const sent = withoutCanary(`${c.req.system}\n${c.req.user}`).toLowerCase();
      const found = JORDAN_PII.filter((p) => sent.includes(p.toLowerCase()));
      expect(found, `${c.feature} sent: ${found.join(', ')}`).toEqual([]);
    }
    console.log(`\nChecked ${calls.length} requests for ${JORDAN_PII.length} pieces of the fixture's personal data: none was sent.`);
  });
});

describe.skipIf(LIVE)('live AI proof', () => {
  it.skip('skipped: set AI_LIVE=1 (npm run ai:prove) with AI_PROVIDER=anthropic and ANTHROPIC_API_KEY to make real calls', () => {});
});
