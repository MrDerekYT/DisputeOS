import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AiUnavailable, anthropicProvider, SPEND_LIMIT_REASON, type AiProvider, type AiRequest } from '@/lib/ai/provider';
import { resetEnvCache } from '@/lib/env';
import { PermissionError, type Role } from '@/lib/rbac';
import { buildSetupChecklist } from '@/lib/setup/checklist';
import { AI_TEST_KEY, AI_TEST_PROVIDER_KEY, loadSetupSnapshot } from '@/lib/setup/snapshot';
import { AI_TEST_REQUEST, TEST_AI_ALL_LIMIT, TEST_AI_LIMIT, TEST_AI_ORG_LIMIT, testAiConnection } from '@/lib/setup/test-ai';
import type { TestActor } from '@/lib/setup/test-send';
import { addClient, addMember, asUser, closePool, makeOrg, withSystem, type TestOrg } from './helpers';

const saved = { ...process.env };
function useEnv(env: Record<string, string>) { process.env = { ...saved, ...env }; resetEnvCache(); }
afterEach(() => { process.env = { ...saved }; resetEnvCache(); });
// The deployment-wide counter is shared by every test (and every run on the same day): start each test from zero.
const ALL_AI = 'setup-test-ai:all';
beforeEach(() => withSystem((db) => db.run('delete from public.rate_limits where key = $1', [ALL_AI])));
afterAll(async () => { await closePool(); });

const NAME = 'anthropic:claude-opus-5-5';
const ANTHROPIC = { AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'sk-ant-key-for-setup-tests' };

/** A stand-in provider: records each request and answers `answer`, or throws it. */
function fakeAi(answer: string | AiUnavailable, name = NAME) {
  const seen: AiRequest[] = [];
  const provider: AiProvider = { name, async complete(r) { seen.push(r); if (answer instanceof AiUnavailable) throw answer; return answer; } };
  return { seen, provider };
}
/** The real Claude adapter, answering every call with this API error (through a mocked fetch: nothing leaves the machine). */
function claudeFailing(status: number, error: Record<string, unknown>, model = 'claude-opus-5-5', effort: 'low' | 'medium' | 'high' = 'low') {
  const reply = async () => new Response(JSON.stringify({ type: 'error', error, request_id: 'req_setup' }), { status, headers: { 'content-type': 'application/json', 'request-id': 'req_setup' } });
  return anthropicProvider('sk-ant-key-for-setup-tests', model, { effort, fetch: reply as unknown as typeof fetch, log: () => {} });
}
const actor = (o: TestOrg, userId = o.ownerId, role: Role = 'owner', email = o.ownerEmail): TestActor =>
  ({ userId, orgId: o.orgId, role, email, orgName: 'Setup Agency', tx: (fn) => asUser(userId, fn) });
const settings = async (o: TestOrg) => (await withSystem((db) => db.row<{ settings: Record<string, unknown> }>('select settings from public.organizations where id = $1', [o.orgId])))!.settings;
const audits = (o: TestOrg) => withSystem((db) => db.rows<{ metadata: Record<string, unknown> }>("select metadata from public.audit_logs where org_id = $1 and action = 'setup.test_ai' order by created_at, id", [o.orgId]));

describe('setup: test the AI connection', () => {
  it('needs settings:manage: a manager, a specialist and a client are refused before any call', async () => {
    const o = await makeOrg('SetupAiPerm');
    for (const role of ['manager', 'specialist', 'client'] as Role[]) {
      const m = await addMember(o.orgId, role);
      const ai = fakeAi('CONNECTED');
      await expect(testAiConnection(actor(o, m.id, role, m.email), { provider: ai.provider })).rejects.toBeInstanceOf(PermissionError);
      expect(ai.seen).toHaveLength(0);
    }
    const admin = await addMember(o.orgId, 'admin');
    expect((await testAiConnection(actor(o, admin.id, 'admin', admin.email), { provider: fakeAi('CONNECTED').provider })).ok).toBe(true);
  });

  it('passes: one fixed request with no client or workspace data, free, recorded with its time and model, and audited', async () => {
    const o = await makeOrg('SetupAiPass');
    await addClient(o.orgId, 'Jordan Rivera');
    const ai = fakeAi('CONNECTED');
    const before = Date.now();
    const r = await testAiConnection(actor(o), { provider: ai.provider });
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/^Passed: anthropic:claude-opus-5-5 answered in \d+\.\d s\. Nothing about your clients or your workspace was sent/);
    expect(r.message).toMatch(/no AI credits were used/);
    expect(ai.seen).toEqual([{ ...AI_TEST_REQUEST }]);
    for (const secret of ['Jordan', 'Rivera', 'SetupAiPass', 'Setup Agency', o.ownerEmail, o.orgId]) expect(JSON.stringify(ai.seen), secret).not.toContain(secret);
    const s = await settings(o);
    expect(Date.parse(String(s[AI_TEST_KEY]))).toBeGreaterThanOrEqual(before - 1000);
    expect(s[AI_TEST_PROVIDER_KEY]).toBe(NAME);
    expect((await audits(o)).map((a) => a.metadata)).toEqual([{ provider: NAME, passed: true, failure: null }]);
    const ledger = await withSystem((db) => db.row<{ n: number }>('select count(*)::int as n from public.ai_credit_ledger where org_id = $1', [o.orgId]));
    expect(ledger!.n).toBe(0);
    // A reply with a full stop or in lower case is still the word.
    expect((await testAiConnection(actor(o), { provider: fakeAi(' connected. ').provider })).ok).toBe(true);
  });

  it('a failure a setting causes withdraws the record; a busy, failing or slow service leaves it as it was', async () => {
    const o = await makeOrg('SetupAiFail');
    expect((await testAiConnection(actor(o), { provider: fakeAi('CONNECTED').provider })).ok).toBe(true);
    const proof = (await settings(o))[AI_TEST_KEY];

    const busy = await testAiConnection(actor(o), { provider: fakeAi(new AiUnavailable('the AI service is busy, try again in a minute', 'busy')).provider });
    expect(busy).toEqual({ ok: false, message: 'Did not pass (anthropic:claude-opus-5-5): the AI service is busy, try again in a minute. The AI service did not answer properly this time. Try again in a minute; the step keeps its last result.' });
    expect((await settings(o))[AI_TEST_KEY]).toBe(proof);

    const refusedKey = await testAiConnection(actor(o), { provider: fakeAi(new AiUnavailable('the AI key was refused', 'auth')).provider });
    expect(refusedKey.ok).toBe(false);
    expect(refusedKey.message).toMatch(/^Did not pass \(anthropic:claude-opus-5-5\): the AI key was refused\. Check ANTHROPIC_API_KEY where the app is hosted/);
    expect((await settings(o))[AI_TEST_KEY]).toBeUndefined();
    expect((await settings(o))[AI_TEST_PROVIDER_KEY]).toBeUndefined();

    expect((await testAiConnection(actor(o), { provider: fakeAi('CONNECTED').provider })).ok).toBe(true);
    const chatty = await testAiConnection(actor(o), { provider: fakeAi('Sure! I am connected and ready to help.').provider });
    expect(chatty.ok).toBe(false);
    expect(chatty.message).toMatch(/not with the word CONNECTED it was asked for/);
    expect(chatty.message).not.toContain('ready to help'); // the reply itself is not shown
    expect((await settings(o))[AI_TEST_KEY]).toBeUndefined();

    // The owner has used the five tests an hour a person gets; another admin tries a model that does not exist.
    const admin = await addMember(o.orgId, 'admin');
    const model = await testAiConnection(actor(o, admin.id, 'admin', admin.email), { provider: fakeAi(new AiUnavailable('the AI model “claude-opus-9” was not found', 'model'), 'anthropic:claude-opus-9').provider });
    expect(model.message).toMatch(/Check AI_MODEL and AI_EFFORT/);
    expect((await audits(o)).map((a) => a.metadata)).toEqual([
      { provider: NAME, passed: true, failure: null }, { provider: NAME, passed: false, failure: 'busy' }, { provider: NAME, passed: false, failure: 'auth' },
      { provider: NAME, passed: true, failure: null }, { provider: NAME, passed: false, failure: 'wrong_answer' }, { provider: 'anthropic:claude-opus-9', passed: false, failure: 'model' },
    ]);
  });

  it('the monthly spending limit says what it is, withdraws the record and leaves the AI step to do', async () => {
    const o = await makeOrg('SetupAiSpend');
    useEnv(ANTHROPIC);
    const ctx = { orgId: o.orgId, tx: actor(o).tx };
    const step = async () => buildSetupChecklist(await loadSetupSnapshot(ctx)).groups.flatMap((g) => g.steps).find((s) => s.key === 'ai')!;
    expect((await testAiConnection(actor(o), { provider: fakeAi('CONNECTED').provider })).ok).toBe(true);
    expect((await step()).status).toBe('done');

    // Through the real adapter: the API's 429 with the enforced_spend_limit_reached code.
    const capped = await testAiConnection(actor(o), { provider: claudeFailing(429, { type: 'rate_limit_error', message: 'Monthly usage limit reached.', details: { error_code: 'enforced_spend_limit_reached' } }) });
    expect(capped).toEqual({ ok: false, message: `Did not pass (anthropic:claude-opus-5-5): ${SPEND_LIMIT_REASON}. Until then every AI feature keeps its standard wording and gives the credits back. Test again once the limit has reset or been raised.` });
    expect(capped.message).not.toMatch(/busy|in a minute|Monthly usage limit reached/);
    expect((await settings(o))[AI_TEST_KEY]).toBeUndefined();
    expect((await settings(o))[AI_TEST_PROVIDER_KEY]).toBeUndefined();
    expect((await step()).status).toBe('todo');
    expect((await audits(o)).map((a) => a.metadata)).toEqual([{ provider: NAME, passed: true, failure: null }, { provider: NAME, passed: false, failure: 'spend_limit' }]);
  });

  it('a rejected request (HTTP 400) points to AI_MODEL and AI_EFFORT only when it is about them', async () => {
    const o = await makeOrg('SetupAi400');
    const beta = { type: 'invalid_request_error', message: 'Unexpected value(s) `server-side-fallback-2026-07-01` for the `anthropic-beta` header.' };
    // The default model and effort: the cause is elsewhere (here, a beta the organization is not enabled for).
    const defaults = await testAiConnection(actor(o), { provider: claudeFailing(400, beta) });
    expect(defaults.message).toBe('Did not pass (anthropic:claude-opus-5-5): the AI service rejected the request (HTTP 400). AI_MODEL and AI_EFFORT are at the defaults this app is built for, so the cause is elsewhere, such as a feature the Anthropic organization is not enabled for. The server log line that starts with [ai] has the request id, and npm run ai:prove prints the service’s own explanation.');
    // A structured error code names the cause, even with a model of the deployment's choosing.
    const onHold = await testAiConnection(actor(o), { provider: claudeFailing(400, { ...beta, details: { error_code: 'organization_on_hold' } }, 'claude-sonnet-5-5') });
    expect(onHold.message).toMatch(/^Did not pass \(anthropic:claude-sonnet-5-5\): the AI service rejected the request \(HTTP 400\)\. The service gave the reason as organization_on_hold: check the organization in the Anthropic Console\./);
    for (const r of [defaults, onHold]) expect(r.message).not.toMatch(/Check AI_MODEL|AI_EFFORT low/);
    // A model or effort the deployment chose: the hint is about them.
    const chosen = await testAiConnection(actor(o), { provider: claudeFailing(400, beta, 'claude-haiku-4-5') });
    expect(chosen.message).toMatch(/^Did not pass \(anthropic:claude-haiku-4-5\): the AI service rejected the request \(HTTP 400\)\. Check AI_MODEL and AI_EFFORT where the app is hosted\./);
    const effort = await testAiConnection(actor(o), { provider: claudeFailing(400, beta, 'claude-opus-5-5', 'high') });
    expect(effort.message).toMatch(/Check AI_MODEL and AI_EFFORT/);
    for (const r of [defaults, onHold, chosen, effort]) expect(r.message).not.toContain(beta.message);
    expect((await audits(o)).map((a) => a.metadata.failure)).toEqual(['request', 'request', 'settings', 'settings']);
  });

  it('says so, spends no allowance and records nothing when no provider is connected', async () => {
    const o = await makeOrg('SetupAiOff');
    useEnv({ AI_PROVIDER: 'rules' });
    expect(await testAiConnection(actor(o))).toEqual({ ok: false, message: 'Not tested: no AI provider is connected (AI_PROVIDER=rules), so the built-in wording is used and there is nothing to test.' });
    useEnv({ AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: '' });
    for (let i = 0; i < TEST_AI_LIMIT.max + 2; i++) {
      expect(await testAiConnection(actor(o))).toEqual({ ok: false, message: 'Not tested: an AI provider is chosen (anthropic) but not connected. Still to set: ANTHROPIC_API_KEY.' });
    }
    expect(await audits(o)).toEqual([]);
    expect((await settings(o))[AI_TEST_KEY]).toBeUndefined();
    // The allowance is untouched: a real test still goes through.
    expect((await testAiConnection(actor(o), { provider: fakeAi('CONNECTED').provider })).ok).toBe(true);
  });

  it('is rate limited per person, per workspace and for the whole deployment', async () => {
    const o = await makeOrg('SetupAiLimit');
    const ai = fakeAi('CONNECTED');
    for (let i = 0; i < TEST_AI_LIMIT.max; i++) expect((await testAiConnection(actor(o), { provider: ai.provider })).ok).toBe(true);
    await expect(testAiConnection(actor(o), { provider: ai.provider })).rejects.toThrow(/You have tested the AI connection 5 times in the last hour/);
    expect(ai.seen).toHaveLength(TEST_AI_LIMIT.max);

    // Another admin of the same workspace shares the workspace's allowance.
    const admin = await addMember(o.orgId, 'admin');
    for (let i = TEST_AI_LIMIT.max; i < TEST_AI_ORG_LIMIT.max; i++) expect((await testAiConnection(actor(o, admin.id, 'admin', admin.email), { provider: ai.provider })).ok).toBe(true);
    const third = await addMember(o.orgId, 'admin', 'admin2');
    await expect(testAiConnection(actor(o, third.id, 'admin', third.email), { provider: ai.provider })).rejects.toThrow(/Your workspace has tested the AI connection 10 times in the last hour/);
    expect(ai.seen).toHaveLength(TEST_AI_ORG_LIMIT.max);

    // The key and its bill belong to the deployment: once its daily allowance is used, every workspace waits.
    const windowStart = new Date(Math.floor(Date.now() / 1000 / TEST_AI_ALL_LIMIT.windowSec) * TEST_AI_ALL_LIMIT.windowSec * 1000);
    await withSystem((db) => db.run('insert into public.rate_limits (key, window_start, hits) values ($1, $2, $3) on conflict (key, window_start) do update set hits = excluded.hits', [ALL_AI, windowStart, TEST_AI_ALL_LIMIT.max]));
    const fresh = await makeOrg('SetupAiAll');
    await expect(testAiConnection(actor(fresh), { provider: ai.provider })).rejects.toThrow(/AI connection tests are paused for today across the platform/);
    expect(ai.seen).toHaveLength(TEST_AI_ORG_LIMIT.max);
  });

  it('the checklist ticks the AI step only after a pass with the provider and model in use, and the snapshot holds no key', async () => {
    const o = await makeOrg('SetupAiSnap');
    const ctx = { orgId: o.orgId, tx: actor(o).tx };
    useEnv(ANTHROPIC);
    let snap = await loadSetupSnapshot(ctx);
    expect(snap.ai).toEqual({ state: 'connected', provider: NAME, missing: [], testPassedAt: null, testProvider: null });
    const step = () => buildSetupChecklist(snap).groups.flatMap((g) => g.steps).find((s) => s.key === 'ai')!;
    expect(step().status).toBe('todo');

    expect((await testAiConnection(actor(o), { provider: fakeAi('CONNECTED').provider })).ok).toBe(true);
    snap = await loadSetupSnapshot(ctx);
    expect(snap.ai).toMatchObject({ state: 'connected', provider: NAME, testProvider: NAME });
    expect(step()).toMatchObject({ status: 'done' });
    expect(step().detail).toMatch(/^The connection test passed on .+ with anthropic:claude-opus-5-5\./);

    useEnv({ ...ANTHROPIC, AI_MODEL: 'claude-sonnet-5-5' });
    snap = await loadSetupSnapshot(ctx);
    expect(step()).toMatchObject({ status: 'todo' });
    expect(step().detail).toMatch(/anthropic:claude-sonnet-5-5 is configured now, but the last test passed with anthropic:claude-opus-5-5/);

    useEnv({ AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: '' });
    snap = await loadSetupSnapshot(ctx);
    expect(snap.ai).toMatchObject({ state: 'needs_credentials', provider: 'anthropic', missing: ['ANTHROPIC_API_KEY'] });
    expect(step()).toMatchObject({ status: 'todo', missing: ['ANTHROPIC_API_KEY'] });
    useEnv(ANTHROPIC);
    expect(JSON.stringify([await loadSetupSnapshot(ctx), buildSetupChecklist(await loadSetupSnapshot(ctx))])).not.toContain(ANTHROPIC.ANTHROPIC_API_KEY);
  });
});
