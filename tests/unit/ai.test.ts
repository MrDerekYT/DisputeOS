import { describe, expect, it, vi } from 'vitest';
import { anthropicProvider, openAiCompatibleProvider } from '@/lib/ai/provider';
import { classifyResponse, progressSummary } from '@/lib/ai/assistant';
import { assertNoBlockedClaims, findBlockedClaims } from '@/lib/compliance/claims';
import { consentStatus, businessDaysBetween } from '@/lib/compliance/disclosures';
import { canTransition, deadlineState, nextSteps, responseDueDate, TRANSITIONS, PIPELINE } from '@/lib/disputes/workflow';
import { mergeTemplate, unresolvedPlaceholders, buildValues } from '@/lib/letters/render';
import { TEMPLATES } from '@/lib/letters/templates';

describe('provider adapters (request shape verified against a mocked fetch only)', () => {
  it('anthropic: sends the documented Messages API request and parses text blocks', async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ content: [{ type: 'text', text: 'Hello' }] }), { status: 200 }));
    const out = await anthropicProvider('sk-test', 'claude-sonnet-5-5', f as unknown as typeof fetch).complete({ system: 'sys', user: 'hi' });
    expect(out).toBe('Hello');
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect((init.headers as Record<string, string>)['x-api-key']).toBe('sk-test');
    expect((init.headers as Record<string, string>)['anthropic-version']).toBe('2023-06-01');
    expect(JSON.parse(init.body as string)).toMatchObject({ model: 'claude-sonnet-5-5', system: 'sys', messages: [{ role: 'user', content: 'hi' }] });
  });
  it('openai-compatible: posts chat/completions with a bearer token', async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: ' Hi ' } }] }), { status: 200 }));
    expect(await openAiCompatibleProvider('https://api.example.com/v1/', 'k', 'm', f as unknown as typeof fetch).complete({ system: 's', user: 'u' })).toBe('Hi');
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.example.com/v1/chat/completions');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer k');
  });
  it('surfaces HTTP failures so callers can fall back', async () => {
    const f = (async () => new Response('no', { status: 429 })) as unknown as typeof fetch;
    await expect(anthropicProvider('k', 'm', f).complete({ system: 's', user: 'u' })).rejects.toThrow(/HTTP 429/);
  });
});

describe('reading bureau responses', () => {
  it.each([
    ['The item has been deleted from your credit file.', 'deleted'],
    ['We have verified that this information is being reported correctly.', 'verified'],
    ['The information was updated and the balance corrected.', 'updated'],
    ['The account was not deleted because it was verified.', 'verified'],
    ['La cuenta fue eliminada de su informe.', 'deleted'],
    ['La información fue verificada y se mantiene.', 'verified'],
    ['We could not locate the account; additional information is needed.', 'unresolved'],
  ])('%s → %s', (text, outcome) => {
    expect(classifyResponse(text).outcome).toBe(outcome);
  });
  it('always asks a person to confirm and admits when it cannot tell', () => {
    expect(classifyResponse('Thank you for writing to us today regarding your file.')).toMatchObject({ outcome: null, needsReview: true });
    expect(classifyResponse('Item deleted.').summary).toMatch(/Confirm/);
  });
});

describe('client progress note', () => {
  const base = { firstName: 'Jordan', total: 6, deleted: 2, updated: 1, verified: 1, waiting: 2, draft: 0 };
  it('is factual, bilingual, free of promises and never mentions scores', () => {
    for (const language of ['en', 'es'] as const) {
      const t = progressSummary({ ...base, language });
      expect(findBlockedClaims(t)).toEqual([]);
      expect(t).not.toMatch(/score|puntaje/i);
      expect(t).toContain('Jordan');
    }
    expect(progressSummary({ ...base, language: 'en' })).toMatch(/Of 6 disputed items, 3 changed \(2 removed, 1 corrected\)/);
    expect(progressSummary({ ...base, language: 'en' })).toMatch(/Results vary/);
  });
  it('handles a client with no disputes yet', () => {
    expect(progressSummary({ ...base, total: 0, deleted: 0, updated: 0, verified: 0, waiting: 0, language: 'en' })).toMatch(/have not sent any disputes yet/);
  });
});

describe('claims guard', () => {
  it.each([
    'We guarantee results', 'Your score will go up by 100 points in 30 days', 'We will remove all negative items', 'Get a CPN today',
    'We will delete this account', 'We can remove accurate information', 'Fix your credit in 30 days', '100% success rate',
  ])('blocks: %s', (t) => expect(findBlockedClaims(t).length, t).toBeGreaterThan(0));
  it.each([
    'Please verify the balance and correct it if it is not accurate.', 'Results vary and are decided by the bureaus.',
    'I request a reinvestigation under Section 611.', 'We will update you when a response arrives.',
  ])('allows: %s', (t) => expect(findBlockedClaims(t)).toEqual([]));
  it('assertNoBlockedClaims throws with the reasons', () => {
    expect(() => assertNoBlockedClaims('We guarantee it')).toThrow(/Results cannot be guaranteed/);
  });
  it('none of the shipped letter templates contain a prohibited claim or a threat', () => {
    for (const t of TEMPLATES) {
      expect(findBlockedClaims(t.body), t.key).toEqual([]);
      expect(t.body, t.key).not.toMatch(/\b(sue|lawsuit|legal action|penalt(y|ies)|damages)\b/i);
    }
  });
});

describe('letter rendering', () => {
  const ctx = { client: { full_name: 'Jordan Rivera', address: { line1: '123 Main St', city: 'Tampa', state: 'FL', zip: '33602' } }, language: 'en' as const, now: new Date('2026-03-01T12:00:00Z') };
  it('merges known fields and leaves unknown ones visible', () => {
    const out = mergeTemplate('Dear {{recipient_name}}, {{mystery}}', { recipient_name: 'Experian' });
    expect(out).toContain('Dear Experian');
    expect(unresolvedPlaceholders(out)).toEqual(['{{mystery}}']);
  });
  it('flags missing required data rather than inventing it', () => {
    const v = buildValues({ client: { full_name: 'X', address: {} }, language: 'en' });
    expect(unresolvedPlaceholders(`${v.client_address} ${v.item_label} ${v.reason}`).length).toBe(3);
  });
  it('only includes the SSN last four when explicitly asked', () => {
    const c = { ...ctx, client: { ...ctx.client, ssn_last4: '4321' } };
    expect(buildValues(c).ssn_last4_text).toBe('');
    expect(buildValues({ ...c, includeSsnLast4: true }).ssn_last4_text).toContain('4321');
  });
  it('formats dates in the letter language', () => {
    expect(buildValues(ctx).date).toBe('March 1, 2026');
    expect(buildValues({ ...ctx, language: 'es' }).date).toBe('1 de marzo de 2026');
  });
  it('every template merges completely when given a full context', () => {
    const v = buildValues({ ...ctx, dispute: { item_label: 'Acme ••1234 (Experian)', bureau: 'experian', recipient_name: 'Experian', reason: 'Please verify.', fields: ['Balance'], round: 2, tradeline: { creditor_name: 'Acme', account_last4: '1234' }, prior_submitted_at: '2026-01-05T00:00:00Z' }, enclosures: ['Statement'] });
    for (const t of TEMPLATES) expect(unresolvedPlaceholders(mergeTemplate(t.body, v)), t.key).toEqual([]);
  });
});

describe('dispute workflow rules', () => {
  it('walks the documented pipeline in order and ends at resolved', () => {
    for (let i = 0; i < PIPELINE.length - 1; i++) {
      const from = PIPELINE[i]!, to = PIPELINE[i + 1]!;
      // submitted → under_investigation → response_received → resolved are all reachable in sequence
      expect(canTransition(from, to) || (from === 'submitted' && to === 'under_investigation'), `${from}→${to}`).toBe(true);
    }
    expect(TRANSITIONS.resolved).toEqual([]);
  });
  it('cannot skip approval', () => {
    expect(canTransition('draft', 'submitted')).toBe(false);
    expect(canTransition('ready_for_review', 'submitted')).toBe(false);
  });
  it('computes the FCRA 30/45-day windows', () => {
    expect(responseDueDate(new Date('2026-03-02T00:00:00Z')).toISOString().slice(0, 10)).toBe('2026-04-01');
    expect(responseDueDate(new Date('2026-03-02T00:00:00Z'), true).toISOString().slice(0, 10)).toBe('2026-04-16');
  });
  it('classifies deadline urgency', () => {
    const now = new Date('2026-03-10T00:00:00Z');
    expect(deadlineState('2026-03-05T00:00:00Z', now)).toBe('overdue');
    expect(deadlineState('2026-03-13T00:00:00Z', now)).toBe('soon');
    expect(deadlineState('2026-04-01T00:00:00Z', now)).toBe('ok');
    expect(deadlineState(null, now)).toBe('none');
  });
  it('warns against repeating a dispute without new information, and never promises legal consequences', () => {
    const resolvedVerified = nextSteps({ status: 'resolved', round: 1, due_at: null, outcome: 'verified', hasApprovedLetter: true, evidenceCount: 0 }).join(' ');
    expect(resolvedVerified).toMatch(/NEW information/);
    const overdue = nextSteps({ status: 'submitted', round: 1, due_at: '2026-01-01T00:00:00Z', outcome: null, hasApprovedLetter: true, evidenceCount: 0 }, new Date('2026-03-01T00:00:00Z')).join(' ');
    expect(overdue).toMatch(/talk to counsel/);
    expect(findBlockedClaims(resolvedVerified + overdue)).toEqual([]);
  });
});

describe('consent rules (CROA)', () => {
  it('requires disclosure, contract and authorization before submission', () => {
    expect(consentStatus([]).missing).toEqual(['croa_disclosure', 'croa_contract', 'fcra_authorization']);
    const ok = ['croa_disclosure', 'croa_contract', 'fcra_authorization'].map((kind) => ({ kind, signed_at: '2026-01-02T00:00:00Z', revoked_at: null }));
    expect(consentStatus(ok, new Date('2026-02-01T00:00:00Z')).missing).toEqual([]);
  });
  it('treats a revoked consent as missing', () => {
    const rows = [{ kind: 'croa_disclosure', signed_at: '2026-01-02T00:00:00Z', revoked_at: '2026-01-03T00:00:00Z' }];
    expect(consentStatus(rows).missing).toContain('croa_disclosure');
  });
  it('flags the 3-business-day cancellation window after the contract is signed', () => {
    const rows = ['croa_disclosure', 'croa_contract', 'fcra_authorization'].map((kind) => ({ kind, signed_at: '2026-03-02T15:00:00Z', revoked_at: null })); // Monday
    expect(consentStatus(rows, new Date('2026-03-04T12:00:00Z')).inCancellationWindow).toBe(true); // Wed: 2 business days
    expect(consentStatus(rows, new Date('2026-03-06T12:00:00Z')).inCancellationWindow).toBe(false); // Fri: 4
    expect(businessDaysBetween(new Date('2026-03-06T00:00:00Z'), new Date('2026-03-09T00:00:00Z'))).toBe(1); // Fri → Mon skips the weekend
  });
});
