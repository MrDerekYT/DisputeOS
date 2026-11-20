import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AI_COSTS, getBalance } from '@/lib/ai/credits';
import type { AiProvider } from '@/lib/ai/provider';
import { createLetter, type LActor } from '@/lib/letters/service';
import { storedSuggestion, suggestForLetter } from '@/lib/letters/suggest';
import { loadTailorSubject } from '@/lib/letters/tailor-load';
import { addClient, asUser, closePool, makeOrg, withSystem, type TestOrg } from './helpers';

// Only the refund that suggestForLetter writes for a request that lost the race is made to fail here, the way a
// database error would. Charging, settling and the refunds inside withAiCredits are the real ones.
vi.mock('@/lib/ai/credits', async (original) => {
  const real = await original<typeof import('@/lib/ai/credits')>();
  return { ...real, refund: vi.fn(async () => { throw new Error('ledger unavailable'); }) };
});

let A: TestOrg;
let owner: LActor;
afterAll(closePool);
beforeAll(async () => {
  A = await makeOrg('SuggestRefund');
  owner = { orgId: A.orgId, userId: A.ownerId, role: 'owner' };
  await withSystem((db) => db.run("insert into public.ai_credit_ledger (org_id, delta, reason, note) values ($1, 20, 'grant', 'test grant')", [A.orgId]));
});

describe('two overlapping requests for one letter version, when the refund cannot be written', () => {
  it('still shows both the suggestion that was kept, and does not tell the second person that no credits were used', async () => {
    const client = await addClient(A.orgId, 'Robin Hale');
    const letter = await asUser(owner.userId, (db) => createLetter(db, owner, { clientId: client, templateKey: 'bureau_dispute_en', reasonOverride: 'The balance shown is not what my statement shows.', recipientName: 'Experian' }));
    // Neither request has a result before both have reached the model.
    let waiting = 0;
    let release = () => {};
    const bothWaiting = new Promise<void>((resolve) => { release = resolve; });
    const slow: AiProvider = {
      name: 'fake',
      async complete(req) {
        const signOff = ['Respectfully,', 'Cordially,'][waiting]!;
        if (++waiting === 2) release();
        await bothWaiting;
        return /<source>\n([\s\S]*)\n<\/source>/.exec(req.user)![1]!.replace('Sincerely,', signOff);
      },
    };
    const ask = async () => {
      const s = (await asUser(owner.userId, (db) => loadTailorSubject(db, letter)))!;
      return suggestForLetter({ orgId: A.orgId, userId: owner.userId, letterId: letter, version: s.version, body: s.body, protectedTerms: s.protectedTerms, seed: s.seed, specificity: s.specificity }, (fn) => asUser(owner.userId, fn), slow);
    };
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const [a, b] = await Promise.all([ask(), ask()]);
    const errors = logged.mock.calls.map((c) => String(c[0]));
    logged.mockRestore();

    const kept = (await asUser(owner.userId, (db) => storedSuggestion(db, letter, 1)))!;
    for (const r of [a, b]) expect(r).toMatchObject({ ok: true, text: kept.body, cost: AI_COSTS.letter_suggestion });
    // Both charges stand until someone corrects the ledger, and that is what each person was told.
    expect(await getBalance(A.orgId)).toBe(20 - 2 * AI_COSTS.letter_suggestion);
    expect(errors.filter((e) => e.startsWith('[ai-credits] REFUND FAILED'))).toEqual([
      expect.stringContaining(`(attempt 1) org=${A.orgId} letter=${letter} version=1`), expect.stringContaining(`(attempt 2) org=${A.orgId} letter=${letter} version=1`),
    ]);
  });
});
