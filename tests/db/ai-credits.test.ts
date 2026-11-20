import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AI_COSTS, AI_OFF, AI_REFUND_PENDING, getBalance, PORTAL_GUIDE_DAILY_CAP, recentLedger, refund, refundUnsettled, spend, withAiCredits } from '@/lib/ai/credits';
import type { AiProvider } from '@/lib/ai/provider';
import { buildPaidGuideReply, buildPortalGuideReply } from '@/lib/guide/ask';
import { storedSuggestion, suggestForLetter, suggestLetterWording } from '@/lib/letters/suggest';
import { addClient, addMember, addPortalClient, asUser, closePool, makeOrg, withSystem, type TestOrg } from './helpers';

let org: TestOrg;
let other: TestOrg;

const grant = (orgId: string, amount: number) => withSystem((db) =>
  db.run("insert into public.ai_credit_ledger (org_id, delta, reason, note) values ($1, $2, 'grant', 'test grant')", [orgId, amount]));
const rowsOf = (orgId: string) => withSystem((db) =>
  db.rows<{ delta: number; reason: string; feature: string | null; actor_user_id: string | null }>(
    'select delta, reason, feature, actor_user_id from public.ai_credit_ledger where org_id = $1 order by id', [orgId]));
const fake = (fn: (masked: string) => string | Error) => {
  const calls: string[] = [];
  const provider: AiProvider = {
    name: 'fake',
    async complete(req) {
      calls.push(req.user);
      const out = fn(req.user.split('<source>\n')[1]?.split('\n</source>')[0] ?? req.user);
      if (out instanceof Error) throw out;
      return out;
    },
  };
  return { provider, calls };
};

const LETTER = [
  'Dear Experian,',
  '',
  'I am writing because I would really like to ask you for some help with my credit file today.',
  'The balance reported for Acme Bank account ending 1234 is $1,250, which differs from my statement.',
  'Thank you so much for taking the time to look into this matter for me.',
].join('\n');
const TERMS = ['Acme Bank', 'Experian'];
// A stand-in rewording as the tailoring checks allow one: the same sentences, in the line's own words or plain courtesy words.
const polish = (masked: string) => masked.replace('I would really like to ask you for some help', 'I would like to ask you for help').replace('Thank you so much', 'Thank you');

beforeAll(async () => {
  org = await makeOrg('Credits');
  other = await makeOrg('CreditsOther');
});
afterAll(closePool);

describe('AI credit ledger', () => {
  it('a new workspace starts with no credits, so its first spend is refused and leaves no row', async () => {
    expect(await getBalance(org.orgId)).toBe(0);
    expect(await spend(org.orgId, 'guide_answer', org.ownerId)).toEqual({ ok: false, reason: 'insufficient' });
    expect(await rowsOf(org.orgId)).toEqual([]);
  });

  it('a spend reduces the balance by the listed cost and records who used it', async () => {
    const o = await makeOrg('Spend');
    await grant(o.orgId, 10);
    expect(await spend(o.orgId, 'letter_suggestion', o.ownerId)).toEqual({ ok: true, cost: AI_COSTS.letter_suggestion, id: expect.any(Number) });
    expect(await getBalance(o.orgId)).toBe(10 - AI_COSTS.letter_suggestion);
    expect((await rowsOf(o.orgId)).at(-1)).toEqual({ delta: -AI_COSTS.letter_suggestion, reason: 'use', feature: 'letter_suggestion', actor_user_id: o.ownerId });
  });

  it('refuses a spend larger than the balance and leaves no row', async () => {
    const o = await makeOrg('Short');
    await grant(o.orgId, AI_COSTS.letter_suggestion - 1);
    expect(await spend(o.orgId, 'letter_suggestion', o.ownerId)).toEqual({ ok: false, reason: 'insufficient' });
    expect(await getBalance(o.orgId)).toBe(AI_COSTS.letter_suggestion - 1);
    expect(await rowsOf(o.orgId)).toHaveLength(1);
  });

  it('concurrent spends cannot overdraw: with credits for exactly three, eight at once give three successes', async () => {
    const o = await makeOrg('Race');
    await grant(o.orgId, AI_COSTS.letter_suggestion * 3);
    const results = await Promise.all(Array.from({ length: 8 }, () => spend(o.orgId, 'letter_suggestion', o.ownerId)));
    expect(results.filter((r) => r.ok)).toHaveLength(3);
    expect(await getBalance(o.orgId)).toBe(0);
    expect((await rowsOf(o.orgId)).filter((r) => r.reason === 'use')).toHaveLength(3);
  });

  it('a refund gives back exactly what was spent (net zero)', async () => {
    const o = await makeOrg('Refund');
    await grant(o.orgId, 7);
    await spend(o.orgId, 'progress_note', o.ownerId);
    await refund(o.orgId, 'progress_note', o.ownerId);
    expect(await getBalance(o.orgId)).toBe(7);
    expect((await rowsOf(o.orgId)).map((r) => [r.reason, r.delta])).toEqual([['grant', 7], ['use', -AI_COSTS.progress_note], ['refund', AI_COSTS.progress_note]]);
  });

  it('is append-only, even for the system connection', async () => {
    const o = await makeOrg('Append');
    await grant(o.orgId, 5);
    await expect(withSystem((db) => db.run('update public.ai_credit_ledger set delta = 500 where org_id = $1', [o.orgId]))).rejects.toThrow(/append-only/);
    await expect(withSystem((db) => db.run('delete from public.ai_credit_ledger where org_id = $1', [o.orgId]))).rejects.toThrow(/append-only/);
    await expect(withSystem((db) => db.run("insert into public.ai_credit_ledger (org_id, delta, reason) values ($1, 5, 'use')", [o.orgId]))).rejects.toThrow(/ai_credit_ledger_sign/);
    expect(await getBalance(o.orgId)).toBe(5);
  });
});

describe('AI credit ledger: row-level security', () => {
  it('staff read their own workspace’s ledger and balance; staff of another workspace see nothing', async () => {
    const o = await makeOrg('Read');
    await grant(o.orgId, 12);
    const specialist = await addMember(o.orgId, 'specialist');
    expect(await asUser(specialist.id, (db) => getBalance(o.orgId, db))).toBe(12);
    expect(await asUser(specialist.id, (db) => recentLedger(db, o.orgId))).toHaveLength(1);
    const stranger = await addMember(other.orgId, 'admin');
    expect(await asUser(stranger.id, (db) => getBalance(o.orgId, db))).toBe(0);
    expect(await asUser(stranger.id, (db) => recentLedger(db, o.orgId))).toEqual([]);
    expect(await asUser(stranger.id, (db) => db.rows('select id from public.ai_credit_ledger'))).toEqual([]);
  });

  it('a portal client cannot read the ledger', async () => {
    const o = await makeOrg('Portal');
    await grant(o.orgId, 3);
    const client = await addPortalClient(o.orgId);
    expect(await asUser(client.userId, (db) => db.rows('select id from public.ai_credit_ledger'))).toEqual([]);
  });

  it('nobody can grant, change or erase credits through the tenant connection — not even the owner', async () => {
    const o = await makeOrg('Self');
    await grant(o.orgId, 4);
    for (const sql of [
      "insert into public.ai_credit_ledger (org_id, delta, reason) values ($1, 1000, 'grant')",
      "insert into public.ai_credit_ledger (org_id, delta, reason) values ($1, 1000, 'purchase')",
      'update public.ai_credit_ledger set delta = 1000 where org_id = $1',
      'delete from public.ai_credit_ledger where org_id = $1',
    ]) {
      await expect(asUser(o.ownerId, (db) => db.run(sql, [o.orgId])), sql).rejects.toMatchObject({ code: '42501' });
    }
    expect(await getBalance(o.orgId)).toBe(4);
  });
});

describe('paying for AI results', () => {
  it('letter suggestion: charges once when a safe rewrite is returned', async () => {
    const o = await makeOrg('Letter');
    await grant(o.orgId, 20);
    const ai = fake(polish);
    const r = await suggestLetterWording({ orgId: o.orgId, userId: o.ownerId, body: LETTER, protectedTerms: TERMS }, ai.provider);
    expect(r).toMatchObject({ ok: true, cost: AI_COSTS.letter_suggestion });
    expect(r.ok && r.text).toContain('I would like to ask you for help');
    expect(r.ok && r.text).toContain('$1,250');
    expect(ai.calls).toHaveLength(1);
    expect(await getBalance(o.orgId)).toBe(20 - AI_COSTS.letter_suggestion);
    expect((await rowsOf(o.orgId)).filter((x) => x.reason === 'use')).toHaveLength(1);
  });

  it('letter suggestion: costs nothing when the rewrite is discarded by the safety checks', async () => {
    const o = await makeOrg('Discard');
    await grant(o.orgId, 20);
    const ai = fake((m) => `${polish(m)}\nWe guarantee this account will be deleted within 30 days.`);
    const r = await suggestLetterWording({ orgId: o.orgId, userId: o.ownerId, body: LETTER, protectedTerms: TERMS }, ai.provider);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.ai.status).toBe('refunded');
    expect(!r.ok && r.message).toMatch(/No AI credits were used/);
    expect(ai.calls).toHaveLength(1);
    expect(await getBalance(o.orgId)).toBe(20);
    expect((await rowsOf(o.orgId)).map((x) => x.reason)).toEqual(['grant', 'use', 'refund']);
  });

  it('letter suggestion: costs nothing when the provider fails', async () => {
    const o = await makeOrg('Fail');
    await grant(o.orgId, 20);
    const r = await suggestLetterWording({ orgId: o.orgId, userId: o.ownerId, body: LETTER, protectedTerms: TERMS }, fake(() => new Error('HTTP 500')).provider);
    expect(r.ok).toBe(false);
    expect(await getBalance(o.orgId)).toBe(20);
  });

  it('with no credits the provider is never called, nothing is written, and staff are told why', async () => {
    const o = await makeOrg('Empty');
    const ai = fake(polish);
    const r = await suggestLetterWording({ orgId: o.orgId, userId: o.ownerId, body: LETTER, protectedTerms: TERMS }, ai.provider);
    expect(r).toMatchObject({ ok: false, ai: { status: 'no_credits' } });
    expect(!r.ok && r.message).toContain(AI_OFF.no_credits);
    expect(ai.calls).toEqual([]);
    expect(await rowsOf(o.orgId)).toEqual([]);
  });

  it('with no provider nothing is charged and staff are told why', async () => {
    const o = await makeOrg('NoProvider');
    await grant(o.orgId, 20);
    const r = await suggestLetterWording({ orgId: o.orgId, userId: o.ownerId, body: LETTER, protectedTerms: TERMS }, null);
    expect(r).toMatchObject({ ok: false, ai: { status: 'no_provider' } });
    expect(!r.ok && r.message).toContain(AI_OFF.no_provider);
    expect(await getBalance(o.orgId)).toBe(20);
  });

  it('refunds when the work throws after the model was called', async () => {
    const o = await makeOrg('Throw');
    await grant(o.orgId, 5);
    await expect(withAiCredits({ orgId: o.orgId, feature: 'progress_note', actorUserId: o.ownerId }, async (p) => {
      await p!.complete({ system: 's', user: 'u' });
      throw new Error('later failure');
    }, fake(() => 'ok').provider)).rejects.toThrow('later failure');
    expect(await getBalance(o.orgId)).toBe(5);
  });

  it('two requests racing for the last credits: one gets AI wording, the other the standard path', async () => {
    const o = await makeOrg('LastCredits');
    await grant(o.orgId, AI_COSTS.letter_suggestion);
    const ai = fake(polish);
    const both = await Promise.all([1, 2].map(() => suggestLetterWording({ orgId: o.orgId, userId: o.ownerId, body: LETTER, protectedTerms: TERMS }, ai.provider)));
    expect(both.filter((r) => r.ok)).toHaveLength(1);
    expect(ai.calls).toHaveLength(1);
    expect(await getBalance(o.orgId)).toBe(0);
  });
});

describe('a charge with no AI result is always given back', () => {
  const openUse = (orgId: string) => withSystem((db) => db.row<{ id: number }>("select id from public.ai_credit_ledger where org_id = $1 and reason = 'use' order by id desc limit 1", [orgId]));
  /** Makes the refund withAiCredits is about to write fail, the way a database error would: the charge already has one. */
  const breakRefund = async (orgId: string) => {
    const use = await openUse(orgId);
    await withSystem((db) => db.run("insert into public.ai_credit_ledger (org_id, delta, reason, feature, ref_id) values ($1, 1, 'refund', 'progress_note', $2)", [orgId, use!.id]));
  };

  it('a request killed between the charge and the result is refunded by the sweep, once', async () => {
    const o = await makeOrg('Killed');
    await grant(o.orgId, 5);
    const charged = await spend(o.orgId, 'progress_note', o.ownerId); // the process dies here: no settle, no refund
    expect(await getBalance(o.orgId)).toBe(5 - AI_COSTS.progress_note);
    expect(await refundUnsettled(10, o.orgId)).toBe(0); // still young enough to be a call in flight
    expect(await refundUnsettled(0, o.orgId)).toBe(1);
    expect(await getBalance(o.orgId)).toBe(5);
    expect(await refundUnsettled(0, o.orgId)).toBe(0);
    expect(await getBalance(o.orgId)).toBe(5);
    const row = await withSystem((db) => db.row<{ ref_id: number; delta: number; actor_user_id: string }>("select ref_id, delta, actor_user_id from public.ai_credit_ledger where org_id = $1 and reason = 'refund'", [o.orgId]));
    expect(row).toEqual({ ref_id: charged.ok && charged.id, delta: AI_COSTS.progress_note, actor_user_id: o.ownerId });
  });

  it('the sweep leaves a paid result charged and never refunds a refunded charge twice', async () => {
    const o = await makeOrg('Settled');
    await grant(o.orgId, 10);
    const paid = await withAiCredits({ orgId: o.orgId, feature: 'progress_note', actorUserId: o.ownerId },
      async (p) => { await p!.complete({ system: 's', user: 'u' }); return { usedAi: true }; }, fake(() => 'ok').provider);
    expect(paid.ai).toEqual({ status: 'charged', cost: AI_COSTS.progress_note });
    const discarded = await withAiCredits({ orgId: o.orgId, feature: 'progress_note', actorUserId: o.ownerId },
      async (p) => { await p!.complete({ system: 's', user: 'u' }); return { usedAi: false }; }, fake(() => 'ok').provider);
    expect(discarded.ai.status).toBe('refunded');
    expect(await refundUnsettled(0, o.orgId)).toBe(0);
    expect(await getBalance(o.orgId)).toBe(10 - AI_COSTS.progress_note);
  });

  it('the database allows one refund per charge', async () => {
    const o = await makeOrg('OneRefund');
    await grant(o.orgId, 5);
    const c = await spend(o.orgId, 'progress_note', o.ownerId);
    const id = c.ok ? c.id : 0;
    await refund(o.orgId, 'progress_note', o.ownerId, 'first', id);
    await expect(refund(o.orgId, 'progress_note', o.ownerId, 'second', id)).rejects.toThrow(/ai_credit_ledger_one_refund/);
    expect(await getBalance(o.orgId)).toBe(5);
  });

  it('a refund that cannot be written does not replace the work’s own error', async () => {
    const o = await makeOrg('RefundFailsThrow');
    await grant(o.orgId, 5);
    await expect(withAiCredits({ orgId: o.orgId, feature: 'progress_note', actorUserId: o.ownerId }, async (p) => {
      await p!.complete({ system: 's', user: 'u' });
      await breakRefund(o.orgId);
      throw new Error('later failure');
    }, fake(() => 'ok').provider)).rejects.toThrow('later failure');
  });

  it('a refund that cannot be written still returns the result, and staff are not told "no credits were used"', async () => {
    const o = await makeOrg('RefundFailsDiscard');
    await grant(o.orgId, 20);
    const ai: AiProvider = { name: 'fake', async complete() { await breakRefund(o.orgId); throw new Error('HTTP 500'); } };
    const r = await suggestLetterWording({ orgId: o.orgId, userId: o.ownerId, body: LETTER, protectedTerms: TERMS }, ai);
    expect(r).toMatchObject({ ok: false, ai: { status: 'refund_pending', cost: AI_COSTS.letter_suggestion } });
    expect(!r.ok && r.message).toContain(AI_REFUND_PENDING);
    expect(!r.ok && r.message).not.toMatch(/No AI credits were used/);
  });

  it('settling is the only change the ledger accepts, and only once', async () => {
    const o = await makeOrg('SettleOnly');
    await grant(o.orgId, 5);
    const c = await spend(o.orgId, 'progress_note', o.ownerId);
    const id = c.ok ? c.id : 0;
    await expect(withSystem((db) => db.run('update public.ai_credit_ledger set settled_at = now(), delta = -1 where id = $1', [id]))).rejects.toThrow(/append-only/);
    expect(await withSystem((db) => db.run('update public.ai_credit_ledger set settled_at = now() where id = $1', [id]))).toBe(1);
    await expect(withSystem((db) => db.run('update public.ai_credit_ledger set settled_at = null where id = $1', [id]))).rejects.toThrow(/append-only/);
    await expect(withSystem((db) => db.run("update public.ai_credit_ledger set settled_at = now() where org_id = $1 and reason = 'grant'", [o.orgId]))).rejects.toThrow(/append-only/);
  });
});

describe('a paid letter suggestion is kept on the server', () => {
  const addLetter = (orgId: string, clientId: string, ownerId: string) => withSystem(async (db) => {
    const l = await db.row<{ id: string }>("insert into public.letters (org_id, client_id, kind, title, recipient_name) values ($1, $2, 'bureau_dispute', 'Synthetic', 'Experian') returning id", [orgId, clientId]);
    await db.run('insert into public.letter_versions (org_id, letter_id, version, body, author_id) values ($1, $2, 1, $3, $4)', [orgId, l!.id, LETTER, ownerId]);
    return l!.id;
  });

  it('asking again for the same version (lost response, reload) returns the stored text and does not charge again', async () => {
    const o = await makeOrg('Kept');
    await grant(o.orgId, 20);
    const letterId = await addLetter(o.orgId, await addClient(o.orgId), o.ownerId);
    const ai = fake(polish);
    const tx = <T>(fn: Parameters<typeof asUser<T>>[1]) => asUser(o.ownerId, fn);
    const ask = () => suggestForLetter({ orgId: o.orgId, userId: o.ownerId, letterId, version: 1, body: LETTER, protectedTerms: TERMS }, tx, ai.provider);

    const first = await ask();
    expect(first).toMatchObject({ ok: true, cost: AI_COSTS.letter_suggestion });
    expect(await asUser(o.ownerId, (db) => storedSuggestion(db, letterId, 1))).toEqual({ body: first.ok && first.text, provider: 'fake' });

    const again = await ask();
    expect(again).toEqual({ ok: true, text: first.ok && first.text, provider: 'fake', cost: 0 });
    expect(ai.calls).toHaveLength(1);
    expect(await getBalance(o.orgId)).toBe(20 - AI_COSTS.letter_suggestion);
    expect((await rowsOf(o.orgId)).filter((x) => x.reason === 'use')).toHaveLength(1);

    // Another workspace's staff cannot read it, and a version without a suggestion has none.
    const stranger = await addMember(other.orgId, 'admin');
    expect(await asUser(stranger.id, (db) => storedSuggestion(db, letterId, 1))).toBeNull();
    expect(await asUser(o.ownerId, (db) => storedSuggestion(db, letterId, 2))).toBeNull();
  });

  it('a discarded suggestion is not stored and not charged', async () => {
    const o = await makeOrg('NotKept');
    await grant(o.orgId, 20);
    const letterId = await addLetter(o.orgId, await addClient(o.orgId), o.ownerId);
    const tx = <T>(fn: Parameters<typeof asUser<T>>[1]) => asUser(o.ownerId, fn);
    const r = await suggestForLetter({ orgId: o.orgId, userId: o.ownerId, letterId, version: 1, body: LETTER, protectedTerms: TERMS }, tx, fake(() => new Error('HTTP 500')).provider);
    expect(r.ok).toBe(false);
    expect(await asUser(o.ownerId, (db) => storedSuggestion(db, letterId, 1))).toBeNull();
    expect(await getBalance(o.orgId)).toBe(20);
  });
});

describe('credit guide on AI credits', () => {
  const QUESTION = 'How long does a dispute investigation take?';
  // Echoes the first vetted entry back, which passes validation, so the reply counts as AI-worded.
  const echo = () => fake((user) => user.split('\n')[2] ?? '');

  it('a portal client’s AI-worded answer is paid by the agency; without credits they get the vetted answer and no mention of credits', async () => {
    const o = await makeOrg('GuidePortal');
    const client = await addPortalClient(o.orgId);
    await grant(o.orgId, AI_COSTS.guide_answer);
    const first = await buildPaidGuideReply({ question: QUESTION, lang: 'en', audience: 'portal' }, { orgId: o.orgId, userId: client.userId }, echo().provider);
    expect(first.mode).toBe('ai');
    expect(await getBalance(o.orgId)).toBe(0);
    expect((await rowsOf(o.orgId)).at(-1)).toMatchObject({ reason: 'use', feature: 'guide_answer', actor_user_id: client.userId });

    const ai = echo();
    const second = await buildPaidGuideReply({ question: QUESTION, lang: 'en', audience: 'portal' }, { orgId: o.orgId, userId: client.userId }, ai.provider);
    expect(second.mode).toBe('knowledge');
    expect(second.answer.length).toBeGreaterThan(20);
    expect(ai.calls).toEqual([]);
    expect(JSON.stringify(second)).not.toMatch(/credit(s)? left|AI wording|AI credit/i);
  });

  it('staff without credits get the vetted answer and a line saying why; a question with no matching topic never costs anything', async () => {
    const o = await makeOrg('GuideStaff');
    const none = await buildPaidGuideReply({ question: QUESTION, lang: 'en', audience: 'app' }, { orgId: o.orgId, userId: o.ownerId }, echo().provider);
    expect(none).toMatchObject({ mode: 'knowledge', note: AI_OFF.no_credits });
    expect(await buildPaidGuideReply({ question: QUESTION, lang: 'en', audience: 'app' }, { orgId: o.orgId, userId: o.ownerId }, null)).toMatchObject({ mode: 'knowledge', note: AI_OFF.no_provider });

    await grant(o.orgId, 3);
    const ai = echo();
    const unsure = await buildPaidGuideReply({ question: 'zzqx vblorp', lang: 'en', audience: 'app' }, { orgId: o.orgId, userId: o.ownerId }, ai.provider);
    expect(unsure.mode).toBe('unsure');
    expect(ai.calls).toEqual([]);
    expect(await rowsOf(o.orgId)).toHaveLength(1);
  });
});

describe('portal clients spending the agency’s credits', () => {
  const QUESTION = 'How long does a dispute investigation take?';
  const echo = () => fake((user) => user.split('\n')[2] ?? '');
  const switchOn = (orgId: string) => withSystem((db) => db.run("update public.organizations set settings = settings || jsonb_build_object('portal_ai_guide', true) where id = $1", [orgId]));
  const ask = (orgId: string, userId: string, provider: AiProvider) => buildPortalGuideReply({ question: QUESTION, lang: 'en' }, { orgId, userId }, provider);

  it('is off by default: the client gets the vetted answer, the model is not called and nothing is charged', async () => {
    const o = await makeOrg('PortalOff');
    const client = await addPortalClient(o.orgId);
    await grant(o.orgId, 50);
    const ai = echo();
    const r = await ask(o.orgId, client.userId, ai.provider);
    expect(r.mode).toBe('knowledge');
    expect(r.answer.length).toBeGreaterThan(20);
    expect(JSON.stringify(r)).not.toMatch(/credit(s)? left|AI wording|AI credit/i);
    expect(ai.calls).toEqual([]);
    expect(await getBalance(o.orgId)).toBe(50);
  });

  it('once the agency turns it on, one client cannot spend more than the daily cap; another client is unaffected', async () => {
    const o = await makeOrg('PortalCap');
    const client = await addPortalClient(o.orgId);
    const second = await addPortalClient(o.orgId, 'Second Client');
    await grant(o.orgId, 50);
    await switchOn(o.orgId);
    const ai = echo();
    for (let i = 0; i < PORTAL_GUIDE_DAILY_CAP; i++) expect((await ask(o.orgId, client.userId, ai.provider)).mode).toBe('ai');
    const spent = PORTAL_GUIDE_DAILY_CAP * AI_COSTS.guide_answer;
    expect(await getBalance(o.orgId)).toBe(50 - spent);

    for (let i = 0; i < 3; i++) {
      const over = await ask(o.orgId, client.userId, ai.provider);
      expect(over.mode).toBe('knowledge');
      expect(JSON.stringify(over)).not.toMatch(/credit(s)? left|AI wording|AI credit/i);
    }
    expect(ai.calls).toHaveLength(PORTAL_GUIDE_DAILY_CAP);
    expect(await getBalance(o.orgId)).toBe(50 - spent);

    expect((await ask(o.orgId, second.userId, ai.provider)).mode).toBe('ai');
    expect(await getBalance(o.orgId)).toBe(50 - spent - AI_COSTS.guide_answer);
  });
});

describe('npm run credits:grant', () => {
  const runGrant = (...args: string[]) => execFileSync('node', ['scripts/grant-credits.mjs', ...args], {
    env: { ...process.env, APP_ENV: 'test' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });

  it('adds a grant row, prints the new balance and writes an audit entry', async () => {
    const o = await makeOrg('Operator');
    const slug = (await withSystem((db) => db.row<{ slug: string }>('select slug from public.organizations where id = $1', [o.orgId])))!.slug;
    expect(runGrant(slug, '250', 'invoice', '1042')).toMatch(/Granted 250 AI credits .* New balance: 250\./);
    expect(await getBalance(o.orgId)).toBe(250);
    const audit = await withSystem((db) => db.row<{ metadata: { amount: number; balance_after: number } }>(
      "select metadata from public.audit_logs where org_id = $1 and action = 'ai_credits.granted'", [o.orgId]));
    expect(audit?.metadata).toMatchObject({ amount: 250, balance_after: 250 });
    expect((await asUser(o.ownerId, (db) => recentLedger(db, o.orgId)))[0]).toMatchObject({ delta: 250, reason: 'grant', note: 'invoice 1042' });
  });

  it('rejects bad amounts and unknown workspaces without changing anything', async () => {
    const o = await makeOrg('OperatorBad');
    const slug = (await withSystem((db) => db.row<{ slug: string }>('select slug from public.organizations where id = $1', [o.orgId])))!.slug;
    for (const bad of ['0', '-5', '1.5', '100001', 'ten', '1e3']) expect(() => runGrant(slug, bad), bad).toThrow();
    expect(() => runGrant(`no-such-${slug}`, '5')).toThrow(/No workspace/);
    expect(await getBalance(o.orgId)).toBe(0);
  });
});
