import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AI_ATTEMPT_TIMEOUT_MS, AI_CALL_DEADLINE_MS, AI_MAX_RETRIES, AiUnavailable, anthropicProvider, DEFAULT_ANTHROPIC_MODEL, DEFAULT_MAX_TOKENS, getProvider,
  openAiCompatibleProvider, providerStatus, REFUSAL_FALLBACK_BETA,
} from '@/lib/ai/provider';
import { resetEnvCache } from '@/lib/env';

/**
 * The Anthropic adapter, through the official SDK, against a mocked fetch. Nothing here reaches the network; the live
 * proof is tests/live/ai.live.test.ts (npm run ai:prove).
 */
const saved = { ...process.env };
afterEach(() => { process.env = { ...saved }; resetEnvCache(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const KEY = 'sk-ant-test-0000';
const SYSTEM = 'SYSTEM PROMPT TEXT';
const USER = 'USER PROMPT TEXT';
const API_SECRET_DETAIL = 'organization detail the API put in its error message';

type Reply = (init?: RequestInit) => Response | Promise<Response>;
interface Call { url: URL; headers: Headers; body: Record<string, unknown> }

function mockFetch(...replies: Reply[]) {
  const calls: Call[] = [];
  const f = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: new URL(String(input)), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    return replies[Math.min(calls.length, replies.length) - 1]!(init);
  });
  return { fetch: f as unknown as typeof fetch, calls };
}

const message = (over: Record<string, unknown> = {}) => ({
  id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-opus-5-5', container: null, context_management: null, diagnostics: null,
  content: [{ type: 'text', text: 'Polished wording.' }], stop_reason: 'end_turn', stop_sequence: null, stop_details: null,
  usage: { input_tokens: 812, output_tokens: 143, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, iterations: null },
  ...over,
});
const ok = (body: object, requestId = 'req_test_123'): Reply => () => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json', 'request-id': requestId } });
const apiError = (status: number, type: string, headers: Record<string, string> = {}, details?: Record<string, unknown>): Reply => () => new Response(
  JSON.stringify({ type: 'error', error: { type, message: API_SECRET_DETAIL, ...(details ? { details } : {}) }, request_id: 'req_err_456' }),
  { status, headers: { 'content-type': 'application/json', 'request-id': 'req_err_456', ...headers } });
/** The monthly spend cap of the account's usage tier, as the API reports it: a 429 with a structured code and no retry-after. */
const spendLimit = apiError(429, 'rate_limit_error', {}, { error_code: 'enforced_spend_limit_reached' });
const aborted = () => Object.assign(new Error('aborted'), { name: 'AbortError' });
/** Answers only when the request is aborted, as a stalled connection would. */
const stall: Reply = (init) => new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(aborted())));
/**
 * A valid reply that takes `ms` to arrive. A non-streaming reply's headers come only once the whole message is written,
 * so, as with a real fetch, nothing resolves before then, and an abort rejects at once.
 */
const slow = (ms: number, body: object = message()): Reply => (init) => new Promise<Response>((resolve, reject) => {
  const timer = setTimeout(() => resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json', 'request-id': 'req_slow' } })), ms);
  init?.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(aborted()); });
});

function provider(fetchImpl: typeof fetch, opts: { model?: string; effort?: 'low' | 'medium' | 'high'; deadlineMs?: number } = {}) {
  const lines: { line: string; level: string }[] = [];
  const p = anthropicProvider(KEY, opts.model ?? 'claude-opus-5-5', { fetch: fetchImpl, effort: opts.effort, deadlineMs: opts.deadlineMs, log: (line, level) => lines.push({ line, level }) });
  return { p, lines };
}
const fails = async (promise: Promise<unknown>): Promise<AiUnavailable> => {
  const e = await promise.then(() => null, (err: unknown) => err);
  expect(e).toBeInstanceOf(AiUnavailable);
  return e as AiUnavailable;
};

describe('Anthropic adapter: the request it sends', () => {
  it('sends model, effort, max_tokens, the fallback beta and fallbacks, and no sampling or thinking parameters', async () => {
    const m = mockFetch(ok(message()));
    const { p } = provider(m.fetch);
    expect(p.name).toBe('anthropic:claude-opus-5-5');
    expect(await p.complete({ system: SYSTEM, user: USER })).toBe('Polished wording.');
    expect(m.calls).toHaveLength(1);
    const c = m.calls[0]!;
    expect(`${c.url.origin}${c.url.pathname}`).toBe('https://api.anthropic.com/v1/messages');
    // The whole body, so nothing else (temperature, top_p, top_k, thinking, a prefill, betas) can slip in.
    expect(c.body).toEqual({
      model: 'claude-opus-5-5', max_tokens: DEFAULT_MAX_TOKENS, system: SYSTEM, messages: [{ role: 'user', content: USER }],
      output_config: { effort: 'low' }, fallbacks: 'default',
    });
    expect(DEFAULT_MAX_TOKENS).toBe(16_000);
    expect(c.headers.get('anthropic-beta')).toBe(REFUSAL_FALLBACK_BETA);
    expect(REFUSAL_FALLBACK_BETA).toBe('server-side-fallback-2026-07-01');
    // SDK 1.x sends the key as a bearer token and pins the API version.
    expect(c.headers.get('authorization')).toBe(`Bearer ${KEY}`);
    expect(c.headers.get('anthropic-version')).toBe('2026-10-21');
  });

  it('takes the effort and model it is given, and a caller’s smaller cap', async () => {
    const m = mockFetch(ok(message({ model: 'claude-sonnet-5-5' })));
    const { p } = provider(m.fetch, { model: 'claude-sonnet-5-5', effort: 'high' });
    await p.complete({ system: SYSTEM, user: USER, maxTokens: 4000 });
    expect(m.calls[0]!.body).toMatchObject({ model: 'claude-sonnet-5-5', max_tokens: 4000, output_config: { effort: 'high' } });
  });

  it('is configured from the environment: Claude Opus 5.5 at low effort by default, AI_MODEL and AI_EFFORT override, one client per configuration', async () => {
    const m = mockFetch(ok(message()));
    vi.stubGlobal('fetch', m.fetch);
    process.env = { ...saved, AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: KEY, AI_MODEL: '', AI_EFFORT: '' };
    resetEnvCache();
    const p = getProvider()!;
    expect(p.name).toBe(`anthropic:${DEFAULT_ANTHROPIC_MODEL}`);
    expect(DEFAULT_ANTHROPIC_MODEL).toBe('claude-opus-5-5');
    expect(getProvider()).toBe(p);
    await p.complete({ system: SYSTEM, user: USER });
    expect(m.calls[0]!.body).toMatchObject({ model: 'claude-opus-5-5', output_config: { effort: 'low' } });

    process.env = { ...saved, AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: KEY, AI_MODEL: 'claude-haiku-5-5', AI_EFFORT: 'medium' };
    resetEnvCache();
    const q = getProvider()!;
    expect(q).not.toBe(p);
    expect(q.name).toBe('anthropic:claude-haiku-5-5');
    await q.complete({ system: SYSTEM, user: USER });
    expect(m.calls[1]!.body).toMatchObject({ model: 'claude-haiku-5-5', output_config: { effort: 'medium' } });

    process.env = { ...saved, AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: KEY, AI_EFFORT: 'max' };
    resetEnvCache();
    expect(() => getProvider()).toThrow(/AI_EFFORT/);
  });

  it('a chosen provider without its key makes no call and says what is missing', () => {
    process.env = { ...saved, AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: '' };
    resetEnvCache();
    expect(getProvider()).toBeNull();
    expect(providerStatus()).toMatchObject({ provider: 'anthropic', active: false });
    expect(providerStatus().note).toMatch(/missing credentials \(ANTHROPIC_API_KEY\)/);
  });

  it('keeps the whole call under the 60 s function limit, and lets one attempt use all of it', async () => {
    expect(AI_MAX_RETRIES).toBe(1);
    expect(AI_CALL_DEADLINE_MS).toBeLessThanOrEqual(50_000); // the deadline bounds the call, retries and waits included
    // A non-streaming reply arrives only once it is complete, so a shorter limit per attempt would throw away a slow but
    // valid reply (and start a second generation with less time than the first).
    expect(AI_ATTEMPT_TIMEOUT_MS).toBe(AI_CALL_DEADLINE_MS);
    // The SDK states each attempt's limit in a header: the whole deadline, for the first attempt and for the retry.
    const m = mockFetch(apiError(529, 'overloaded_error', { 'retry-after-ms': '1' }), ok(message()));
    expect(await provider(m.fetch).p.complete({ system: SYSTEM, user: USER })).toBe('Polished wording.');
    expect(m.calls.map((c) => c.headers.get('x-stainless-timeout'))).toEqual(['45', '45']);
  });

  it('uses a slow but valid reply that arrives before the deadline, in one attempt', async () => {
    const m = mockFetch(slow(1_200));
    const { p, lines } = provider(m.fetch, { deadlineMs: 2_000 });
    expect(await p.complete({ system: SYSTEM, user: USER })).toBe('Polished wording.');
    expect(m.calls).toHaveLength(1);
    expect(lines[0]!.line).toMatch(/stop=end_turn .*request=req_slow$/);
  });
});

describe('Anthropic adapter: reading the reply by its stop reason', () => {
  it('end_turn: returns the text blocks and ignores thinking blocks', async () => {
    const m = mockFetch(ok(message({ content: [{ type: 'thinking', thinking: '', signature: 'sig' }, { type: 'text', text: 'First part. ' }, { type: 'text', text: 'Second part.' }] })));
    expect(await provider(m.fetch).p.complete({ system: SYSTEM, user: USER })).toBe('First part. Second part.');
  });

  it('max_tokens: the reply was cut off, so nothing is returned, whether or not some text came back', async () => {
    for (const content of [[{ type: 'text', text: 'A credit bureau generally has 30 days to investigate. That can extend to 45 days in some' }], [{ type: 'thinking', thinking: '', signature: 'sig' }]]) {
      const { p, lines } = provider(mockFetch(ok(message({ content, stop_reason: 'max_tokens' }))).fetch);
      const e = await fails(p.complete({ system: SYSTEM, user: USER }));
      expect(e).toMatchObject({ kind: 'cut_off', message: 'the AI reply was cut off before it finished', retryable: false });
      expect(lines[0]).toMatchObject({ level: 'warn' });
      expect(lines[0]!.line).toContain('stop=max_tokens');
    }
  });

  it('refusal (after the fallbacks also declined): nothing is returned, and the category is logged', async () => {
    const m = mockFetch(ok(message({ content: [], stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'general_harms', explanation: 'An explanation that is not shown.' } })));
    const { p, lines } = provider(m.fetch);
    const e = await fails(p.complete({ system: SYSTEM, user: USER }));
    expect(e).toMatchObject({ kind: 'refused', message: 'the AI model declined to answer' });
    expect(lines[0]!.line).toMatch(/stop=refusal refusal=general_harms/);
    expect(lines[0]!.line).not.toContain('explanation');
  });

  it('fallback: when the requested model declined and the fallback model answered, the fallback model’s text is returned', async () => {
    const m = mockFetch(ok(message({
      model: 'claude-opus-5',
      content: [
        { type: 'fallback', from: { model: 'claude-opus-5-5' }, to: { model: 'claude-opus-5' }, trigger: { type: 'refusal', category: 'cyber' } },
        { type: 'thinking', thinking: '', signature: 'sig' },
        { type: 'text', text: 'Wording from the fallback model.' },
      ],
      usage: { input_tokens: 800, output_tokens: 90, cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
        iterations: [{ type: 'message', input_tokens: 800, output_tokens: 0 }, { type: 'fallback_message', model: 'claude-opus-5', input_tokens: 800, output_tokens: 90 }] },
    })));
    const { p, lines } = provider(m.fetch);
    expect(await p.complete({ system: SYSTEM, user: USER })).toBe('Wording from the fallback model.');
    expect(lines[0]!.line).toMatch(/served=claude-opus-5 fallback=yes/);
  });

  it('text from before the last fallback block came from a model that declined, and is never used', async () => {
    const m = mockFetch(ok(message({ content: [
      { type: 'text', text: 'Partial text from the model that declined' },
      { type: 'fallback', from: { model: 'claude-opus-5-5' }, to: { model: 'claude-opus-5' }, trigger: { type: 'refusal', category: null } },
      { type: 'text', text: 'Complete answer.' },
    ] })));
    expect(await provider(m.fetch).p.complete({ system: SYSTEM, user: USER })).toBe('Complete answer.');
  });

  it('an empty reply, or one that stopped for another reason, is not used', async () => {
    const empty = await fails(provider(mockFetch(ok(message({ content: [{ type: 'thinking', thinking: '', signature: 'sig' }] }))).fetch).p.complete({ system: SYSTEM, user: USER }));
    expect(empty.kind).toBe('empty');
    const paused = await fails(provider(mockFetch(ok(message({ stop_reason: 'pause_turn' }))).fetch).p.complete({ system: SYSTEM, user: USER }));
    expect(paused).toMatchObject({ kind: 'unfinished', message: 'the AI reply did not finish (pause_turn)' });
  });
});

describe('Anthropic adapter: errors, by the SDK’s typed classes', () => {
  it.each([
    [401, 'authentication_error', 'auth', 'the AI key was refused', 1],
    [403, 'permission_error', 'forbidden', 'the AI key is not allowed to make this request', 1],
    [404, 'not_found_error', 'model', 'the AI model “claude-opus-5-5” was not found', 1],
    [400, 'invalid_request_error', 'request', 'the AI service rejected the request (HTTP 400)', 1],
    [413, 'request_too_large', 'other', 'HTTP 413', 1],
    [429, 'rate_limit_error', 'busy', 'the AI service is busy, try again in a minute', 2],
    [529, 'overloaded_error', 'busy', 'the AI service is busy, try again in a minute', 2],
    [500, 'api_error', 'server', 'the AI service had a problem (HTTP 500)', 2],
  ] as const)('HTTP %i %s → %s, “%s” (%i attempt(s))', async (status, type, kind, text, attempts) => {
    const m = mockFetch(apiError(status, type, { 'retry-after-ms': '1' }));
    const { p, lines } = provider(m.fetch);
    const e = await fails(p.complete({ system: SYSTEM, user: USER }));
    expect(e).toMatchObject({ kind, message: text });
    expect(e.retryable).toBe(kind === 'busy' || kind === 'server');
    expect(m.calls).toHaveLength(attempts); // the SDK retries 429, 529 and 5xx once (maxRetries: 1), never a 4xx
    expect(e.message).not.toContain(API_SECRET_DETAIL);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.line).toContain(`error=${kind} status=${status} type=${type}`);
    expect(lines[0]!.line).toContain('request=req_err_456');
    expect(lines[0]!.line).not.toContain(API_SECRET_DETAIL);
  });

  it('the monthly spend limit (429 enforced_spend_limit_reached) is not “busy”: it says what it is, is not retryable, and logs its code', async () => {
    const m = mockFetch(spendLimit);
    const { p, lines } = provider(m.fetch);
    const e = await fails(p.complete({ system: SYSTEM, user: USER }));
    expect(e).toMatchObject({
      kind: 'spend_limit', retryable: false, code: 'enforced_spend_limit_reached',
      message: 'the AI account has reached its monthly spending limit; it resumes when the limit resets or is raised in the Anthropic Console',
    });
    expect(lines).toEqual([{ level: 'warn', line: expect.stringContaining('error=spend_limit status=429 type=rate_limit_error code=enforced_spend_limit_reached ms=') }]);
    expect(lines[0]!.line).toContain('request=req_err_456');
    for (const text of [e.message, lines[0]!.line]) expect(text).not.toContain(API_SECRET_DETAIL);
    // A per-minute rate limit is still “busy”, with no code to log.
    const busy = provider(mockFetch(apiError(429, 'rate_limit_error', { 'retry-after-ms': '1' })).fetch);
    expect(await fails(busy.p.complete({ system: SYSTEM, user: USER }))).toMatchObject({ kind: 'busy', retryable: true, code: null });
    expect(busy.lines[0]!.line).not.toContain('code=');
  });

  it('a 400 is put down to AI_MODEL or AI_EFFORT only when one of them is not the default and the service gave no error code', async () => {
    const kindOf = async (opts: { model?: string; effort?: 'low' | 'medium' | 'high' }, details?: Record<string, unknown>) => {
      const { p, lines } = provider(mockFetch(apiError(400, 'invalid_request_error', {}, details)).fetch, opts);
      const e = await fails(p.complete({ system: SYSTEM, user: USER }));
      expect(e.message).toBe('the AI service rejected the request (HTTP 400)');
      expect(e.retryable).toBe(false);
      return { kind: e.kind, line: lines[0]!.line };
    };
    // The default model and effort: the request is the one this adapter is built for, so the reason lies elsewhere
    // (a beta header the organization lacks, the organization itself, …).
    expect((await kindOf({})).kind).toBe('request');
    expect((await kindOf({ model: DEFAULT_ANTHROPIC_MODEL, effort: 'low' })).kind).toBe('request');
    // A model or an effort the deployment chose.
    expect((await kindOf({ model: 'claude-haiku-4-5' })).kind).toBe('settings');
    expect((await kindOf({ effort: 'high' })).kind).toBe('settings');
    // A structured error code names the cause, and it is not the model: the organization is on hold.
    const onHold = await kindOf({ model: 'claude-sonnet-5-5' }, { error_code: 'organization_on_hold' });
    expect(onHold.kind).toBe('request');
    expect(onHold.line).toContain('code=organization_on_hold');
  });

  it('keeps the service’s own wording of an error for the live proof only: never in the message people see, nor in the log line', async () => {
    const { p, lines } = provider(mockFetch(apiError(400, 'invalid_request_error')).fetch);
    const e = await fails(p.complete({ system: SYSTEM, user: USER }));
    expect(e.apiMessage).toBe(API_SECRET_DETAIL);
    expect(`${e.message} ${lines[0]!.line}`).not.toContain(API_SECRET_DETAIL);
    expect(new AiUnavailable('x', 'busy')).toMatchObject({ code: null, apiMessage: null });
  });

  it('a retry that then succeeds is one call with one log line', async () => {
    const m = mockFetch(apiError(529, 'overloaded_error', { 'retry-after-ms': '1' }), ok(message()));
    const { p, lines } = provider(m.fetch);
    expect(await p.complete({ system: SYSTEM, user: USER })).toBe('Polished wording.');
    expect(m.calls).toHaveLength(2);
    expect(lines).toHaveLength(1);
  });

  it('an unreachable service is retried once, then reported as unreachable', async () => {
    const m = mockFetch(() => { throw new TypeError('fetch failed'); });
    const e = await fails(provider(m.fetch).p.complete({ system: SYSTEM, user: USER }));
    expect(e).toMatchObject({ kind: 'network', message: 'the AI service could not be reached', retryable: true });
    expect(m.calls).toHaveLength(2);
  });

  it('the overall deadline stops a stalled call', async () => {
    const m = mockFetch(stall);
    const started = Date.now();
    const e = await fails(provider(m.fetch, { deadlineMs: 60 }).p.complete({ system: SYSTEM, user: USER }));
    expect(e).toMatchObject({ kind: 'timeout', message: 'the AI service took too long to answer', retryable: true });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('the overall deadline also cuts short a long retry-after wait, which the SDK would otherwise honour in full', async () => {
    const m = mockFetch(apiError(429, 'rate_limit_error', { 'retry-after': '120' }), ok(message()));
    const started = Date.now();
    const e = await fails(provider(m.fetch, { deadlineMs: 150 }).p.complete({ system: SYSTEM, user: USER }));
    expect(e.kind).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(m.calls).toHaveLength(1);
  });
});

describe('Anthropic adapter: the log line', () => {
  it('one line per call with model, stop reason, tokens, time and request id, and never the prompt or the reply', async () => {
    const m = mockFetch(ok(message()));
    const { p, lines } = provider(m.fetch);
    await p.complete({ system: SYSTEM, user: USER });
    expect(lines).toHaveLength(1);
    const { line, level } = lines[0]!;
    expect(level).toBe('info');
    expect(line).toMatch(/^\[ai\] anthropic model=claude-opus-5-5 effort=low stop=end_turn in=812 out=143 ms=\d+ served=claude-opus-5-5 fallback=no request=req_test_123$/);
    for (const text of [SYSTEM, USER, 'Polished wording.', KEY]) expect(line).not.toContain(text);
  });

  it('by default it goes to the console, and the SDK prints no request body even with ANTHROPIC_LOG=debug', async () => {
    process.env.ANTHROPIC_LOG = 'debug';
    const printed: string[] = [];
    for (const level of ['log', 'debug', 'info', 'warn', 'error'] as const) vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { printed.push(args.map(String).join(' ')); });
    const p = anthropicProvider(KEY, 'claude-opus-5-5', { fetch: mockFetch(ok(message())).fetch });
    await p.complete({ system: SYSTEM, user: USER });
    await p.complete({ system: SYSTEM, user: USER }).catch(() => null);
    expect(printed.filter((l) => l.startsWith('[ai] '))).toHaveLength(2);
    for (const text of [SYSTEM, USER, 'Polished wording.', KEY]) expect(printed.join('\n')).not.toContain(text);
  });
});

describe('AiUnavailable', () => {
  it('says which failures may pass on their own', () => {
    for (const kind of ['busy', 'server', 'timeout', 'network'] as const) expect(new AiUnavailable('x', kind).retryable, kind).toBe(true);
    for (const kind of ['auth', 'forbidden', 'model', 'settings', 'request', 'spend_limit', 'refused', 'cut_off', 'empty', 'unfinished', 'other'] as const) expect(new AiUnavailable('x', kind).retryable, kind).toBe(false);
    expect(new AiUnavailable('x')).toMatchObject({ kind: 'other', name: 'AiUnavailable' });
  });
});

describe('OpenAI-compatible adapter (mocked fetch only)', () => {
  it('posts chat/completions with a bearer token', async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: ' Hi ' } }] }), { status: 200 }));
    expect(await openAiCompatibleProvider('https://api.example.com/v1/', 'k', 'm', f as unknown as typeof fetch).complete({ system: 's', user: 'u' })).toBe('Hi');
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.example.com/v1/chat/completions');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer k');
    expect(JSON.parse(init.body as string)).toMatchObject({ model: 'm', max_tokens: 800 });
  });
  it('surfaces HTTP failures, with a kind, so callers can fall back', async () => {
    const f = (async () => new Response('no', { status: 429 })) as unknown as typeof fetch;
    const e = await fails(openAiCompatibleProvider('https://api.example.com/v1', 'k', 'm', f).complete({ system: 's', user: 'u' }));
    expect(e).toMatchObject({ kind: 'busy', message: 'AI endpoint returned HTTP 429' });
  });
});
