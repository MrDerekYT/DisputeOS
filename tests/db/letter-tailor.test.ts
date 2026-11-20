import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AI_COSTS, getBalance } from '@/lib/ai/credits';
import type { AiProvider } from '@/lib/ai/provider';
import { addEvidence, createDispute, recordResponse, startNextRound, transitionDispute, type DActor } from '@/lib/disputes/service';
import { recommendLetter, styleSeed, VOICE_LINES, voiceFor } from '@/lib/letters/brief';
import { loadBrief } from '@/lib/letters/brief-load';
import { editableWording, OVERLAP_HIGH, OVERLAP_MEDIUM, wordingOverlap } from '@/lib/letters/overlap';
import { createLetter, currentBody, saveVersion, setLetterStatus } from '@/lib/letters/service';
import { storedSuggestion, suggestForLetter } from '@/lib/letters/suggest';
import { tailorGoal } from '@/lib/letters/tailor';
import { autoTailorDraft, autoTailorOn, letterOverlap, loadTailorSubject, recentOtherWording, setAutoTailor } from '@/lib/letters/tailor-load';
import { decideReport, storeParsedReport } from '@/lib/reports/service';
import type { ParsedReport, ParsedTradeline } from '@/lib/reports/types';
import { recordConsentRows } from './consents';
import { addClient, addMember, asUser, closePool, makeOrg, withSystem, type TestOrg } from './helpers';

let A: TestOrg;
let B: TestOrg;
let owner: DActor;
let specialist: DActor;
let jordan = '';
let maria = '';
let jordanAccount = '';
let jordanDispute = '';
let jordanLetter = '';

const grant = (orgId: string, amount: number) => withSystem((db) => db.run("insert into public.ai_credit_ledger (org_id, delta, reason, note) values ($1, $2, 'grant', 'test grant')", [orgId, amount]));
const ledger = (orgId: string) => withSystem((db) => db.rows<{ reason: string; delta: number; feature: string | null }>('select reason, delta, feature from public.ai_credit_ledger where org_id = $1 order by id', [orgId]));
const body = async (id: string) => (await withSystem((db) => currentBody(db, id)))!.body;
const tx = (userId: string) => <T>(fn: Parameters<typeof asUser<T>>[1]) => asUser(userId, fn);

const line = (over: Partial<ParsedTradeline>): ParsedTradeline => ({
  bureau: null, item_type: 'tradeline', creditor_name: 'ACME BANK', original_creditor: null, account_last4: '1234', account_type: 'Revolving', account_status: 'Open', payment_status: 'Current',
  balance_cents: 120000, credit_limit_cents: 500000, high_balance_cents: null, date_opened: '2019-03-03', date_reported: '2026-10-28', date_of_first_delinquency: null, payment_history: 'CCCCCC', remarks: null,
  confidence: 0.95, field_meta: {}, ...over,
});
const report = (tradelines: ParsedTradeline[], reportDate: string | null): ParsedReport => ({ bureau: null, reportDate, tradelines, inquiries: [], publicRecords: [], identity: [], warnings: [] });

/** One approved report with one account, and that account's id. */
async function account(clientId: string, bureau: 'experian' | 'equifax', t: Partial<ParsedTradeline>, reportDate: string | null) {
  const [rid] = await asUser(owner.userId, (db) => storeParsedReport(db, owner, { clientId, parsed: report([line(t)], reportDate), bureau, source: 'manual' }));
  await asUser(owner.userId, (db) => decideReport(db, owner, rid!, 'approved'));
  return (await withSystem((db) => db.row<{ id: string }>('select id from public.tradelines where report_id = $1', [rid!])))!.id;
}
const idDoc = (orgId: string, clientId: string, kind: string) => withSystem((db) => db.run(
  "insert into public.documents (org_id, client_id, kind, file_name, storage_key, mime_type, size_bytes, sha256, review_status) values ($1, $2, $3, $4, $5, 'application/pdf', 10, 'x', 'accepted')", [orgId, clientId, kind, `${kind}.pdf`, `k-${clientId}-${kind}`]));

/** A stand-in for the model: it rewords the connective wording it is shown and leaves every marker where it is. */
const fake = (fn: (masked: string) => string | Error = (m) => m) => {
  const calls: { system: string; user: string }[] = [];
  const provider: AiProvider = {
    name: 'fake',
    async complete(req) { calls.push(req); const out = fn(/<source>\n([\s\S]*)\n<\/source>/.exec(req.user)![1]!); if (out instanceof Error) throw out; return out; },
  };
  return { provider, calls };
};
const LEAD_INS = VOICE_LINES.filter((l) => /details|specifics/.test(l));
const CONTACTS = VOICE_LINES.filter((l) => /address above/.test(l));
const THANKS = VOICE_LINES.filter((l) => /^(Thank you|I appreciate)/.test(l));
const [NEW_LEAD_IN, NEW_CONTACT, NEW_THANKS] = ['The particulars follow.', 'You can write to me at the address above.', 'Many thanks for reading this.'];
/** Like for like, as the checks require: each sentence it is shown becomes one other sentence of plain courtesy, on the same line. */
const reword = (m: string) => [...LEAD_INS.map((l) => [l, NEW_LEAD_IN] as const), ...CONTACTS.map((l) => [l, NEW_CONTACT] as const), ...THANKS.map((l) => [l, NEW_THANKS] as const)]
  .reduce((t, [from, to]) => t.replace(from, to), m).replace('To whom it may concern:', 'Dear Sir or Madam:').replace('Sincerely,', 'Respectfully,');
/** The closing line the stand-in leaves for one client: their voice decides whether there is a contact sentence before the thanks. */
const rewordedCourtesy = (clientId: string) => [voiceFor(styleSeed(clientId)).contact && NEW_CONTACT, NEW_THANKS].filter(Boolean).join(' ');

beforeAll(async () => {
  A = await makeOrg('Tailor');
  B = await makeOrg('TailorOther');
  owner = { orgId: A.orgId, userId: A.ownerId, role: 'owner' };
  const s = await addMember(A.orgId, 'specialist');
  specialist = { orgId: A.orgId, userId: s.id, role: 'specialist' };
  jordan = await addClient(A.orgId, 'Jordan Rivera');
  maria = await addClient(A.orgId, 'Maria Chen');
  await withSystem(async (db) => {
    await db.run(`update public.clients set address = '{"line1":"123 Main St","city":"Tampa","state":"FL","zip":"33602"}' where id = $1`, [jordan]);
    await db.run(`update public.clients set address = '{"line1":"9 Pine Ave","line2":"Apt 4","city":"Seattle","state":"WA","zip":"98101"}' where id = $1`, [maria]);
  });
});
afterAll(closePool);

const REASON = 'Experian reports a balance of $1,200.00. My January 2026 statement shows a balance of $900.00. I closed this card when I moved.';

describe('the letter brief, from real rows', () => {

  it('a first-round letter states the account as that bureau reports it and the documents actually on file', async () => {
    jordanAccount = await account(jordan, 'experian', {}, '2026-10-30');
    await idDoc(A.orgId, jordan, 'id');
    await idDoc(A.orgId, jordan, 'proof_of_address');
    jordanDispute = await asUser(owner.userId, (db) => createDispute(db, owner, { clientId: jordan, tradelineId: jordanAccount, category: 'incorrect_balance', reason: REASON, fields: ['Balance'] }));
    await asUser(owner.userId, (db) => addEvidence(db, owner, jordanDispute, { label: 'January 2026 statement' }));

    const brief = (await asUser(owner.userId, (db) => loadBrief(db, jordan, jordanDispute)))!;
    expect(brief.account).toMatchObject({ creditor: 'ACME BANK', last4: '1234', bureauLabel: 'Experian', reportDate: '2026-10-30', reported: [{ key: 'opened', text: 'date opened March 3, 2019' }, { key: 'balance', text: 'balance $1,200.00' }] });
    expect(brief.enclosures).toEqual({ evidence: ['January 2026 statement'], identity: [{ key: 'id', label: 'Government-issued photo ID' }, { key: 'proof_of_address', label: 'Proof of current address' }] });
    expect(recommendLetter(brief)).toEqual({ templateKey: 'inaccurate_balance_en', name: 'Inaccurate balance', reason: 'The dispute is about the balance Experian reports ($1,200.00).', missing: [], exists: false });

    jordanLetter = await asUser(owner.userId, (db) => createLetter(db, owner, { clientId: jordan, disputeId: jordanDispute }));
    const text = await body(jordanLetter);
    expect(text).toContain('Re: Dispute of a reported balance — ACME BANK, account ending 1234\n');
    expect(text).toContain('Item: ACME BANK, account ending 1234\nAs it appears on my Experian credit report dated October 30, 2026: date opened March 3, 2019; balance $1,200.00.\nSpecific information I am asking you to review: Balance.');
    expect(text).not.toMatch(/••|\(Experian\)/); // the on-screen label is not what a letter prints
    expect(text).toContain('I have enclosed the following document: January 2026 statement. To confirm my identity, I have also enclosed a copy of my government-issued photo ID and proof of my current address.');
    expect(text).toContain('Enclosures:\n  - January 2026 statement\n  - Copy: Government-issued photo ID\n  - Copy: Proof of current address\n');
    expect(text).not.toMatch(/disputed this item on/); // no earlier round, so no paragraph about one
    const v = voiceFor(brief.seed);
    expect(text).toContain([v.contact, v.thanks].filter(Boolean).join(' '));
    // Once the letter is on the dispute it is no longer recommended again.
    expect(recommendLetter((await asUser(owner.userId, (db) => loadBrief(db, jordan, jordanDispute)))!)).toMatchObject({ templateKey: 'inaccurate_balance_en', exists: true });
    // Another organization cannot read the brief.
    expect(await asUser(B.ownerId, (db) => loadBrief(db, jordan, jordanDispute))).toBeNull();
    expect(await asUser(owner.userId, (db) => loadBrief(db, maria, jordanDispute))).toBeNull(); // not that client's dispute
  });

  it('a second client with the same kind of dispute gets a materially different letter: other reported values, an earlier round, other enclosures', async () => {
    const tl = await account(maria, 'equifax', { creditor_name: 'HARBOR CREDIT UNION', account_last4: '7788', balance_cents: 64050, date_opened: '2021-08-14' }, null);
    const first = await asUser(owner.userId, (db) => createDispute(db, owner, { clientId: maria, tradelineId: tl, category: 'incorrect_balance', reason: 'Equifax reports a balance of $640.50. I paid this loan off in full.', fields: ['Balance'] }));
    const l1 = await asUser(owner.userId, (db) => createLetter(db, owner, { clientId: maria, disputeId: first }));
    // Round 1 is reviewed, approved, mailed, answered "verified" and resolved, as a person would do it.
    await recordConsentRows(A.orgId, maria);
    await asUser(owner.userId, async (db) => {
      await transitionDispute(db, owner, first, 'ready_for_review');
      await transitionDispute(db, owner, first, 'approved');
      await setLetterStatus(db, owner, l1, 'pending_approval');
      await setLetterStatus(db, owner, l1, 'approved');
      await transitionDispute(db, owner, first, 'submitted', { sentOn: '2026-08-03', receivedOn: '2026-08-06' });
      await recordResponse(db, owner, first, { outcome: 'verified', receivedOn: '2026-09-01' });
      await transitionDispute(db, owner, first, 'resolved');
    });
    const second = await asUser(owner.userId, (db) => startNextRound(db, owner, first, { reason: 'Equifax still reports a balance of $640.50.', newInformation: 'the payoff letter dated September 12, 2026 confirms a balance of $0.00.' }));
    await asUser(owner.userId, (db) => addEvidence(db, owner, second, { label: 'Payoff letter from Harbor Credit Union' }));

    const brief = (await asUser(owner.userId, (db) => loadBrief(db, maria, second)))!;
    expect(brief.history).toMatchObject({ round: 2, prior: { round: 1, sentOn: '2026-08-03', responseOn: '2026-09-01', outcome: 'verified' } });
    expect(recommendLetter(brief)).toMatchObject({ templateKey: 'redispute_new_information_en', reason: 'Round 2 follows a result of “verified as reported” received on September 1, 2026, and new information is on file for it.' });

    // The same situation letter as Jordan's, so the only differences come from the two files.
    const same = await asUser(owner.userId, (db) => createLetter(db, owner, { clientId: maria, disputeId: second, templateKey: 'inaccurate_balance_en' }));
    const [m, j] = [await body(same), await body(jordanLetter)];
    expect(m).toContain('As it appears on my Equifax credit report: date opened August 14, 2021; balance $640.50.');
    expect(m).toContain('I previously disputed this item on August 3, 2026. Your results, which I received on September 1, 2026, stated that the information was verified.\n\nReason for my request:');
    expect(m).toContain('I have enclosed the following document: Payoff letter from Harbor Credit Union.');
    expect(m).not.toMatch(/photo ID/); // none accepted for this client, so none is said to be enclosed
    expect(m).toContain('— request 2');
    const between = (s: string) => s.slice(s.indexOf('To whom it may concern:'), s.indexOf('Sincerely,')).split('\n').filter((l) => l.trim());
    // Same template, so the fixed lines match (the salutation, two headings, the request); most of the letter does not.
    const shared = between(m).filter((l) => between(j).includes(l));
    expect(shared.length / between(m).length).toBeLessThan(0.6);
    // With nothing named, the pipeline picks the re-dispute for this round, as recommended.
    const auto = await asUser(owner.userId, (db) => createLetter(db, owner, { clientId: maria, disputeId: second }));
    expect((await withSystem((db) => db.row<{ template_key: string }>('select template_key from public.letters where id = $1', [auto])))!.template_key).toBe('redispute_new_information_en');
    await asUser(owner.userId, (db) => setLetterStatus(db, owner, auto, 'void'));
  });
});

describe('AI tailoring is paid for once when it is accepted by the checks, and never when it is discarded', () => {
  const ask = (provider: AiProvider, letterId = jordanLetter) => asUser(owner.userId, (db) => loadTailorSubject(db, letterId)).then((s) =>
    suggestForLetter({ orgId: A.orgId, userId: owner.userId, letterId, version: s!.version, body: s!.body, protectedTerms: s!.protectedTerms, seed: s!.seed, specificity: s!.specificity }, tx(owner.userId), provider));
  /** A draft letter for Jordan about an account of its own, so no test depends on how many disputes one account may have open. */
  const letterOnNewAccount = async (creditor: string, last4: string) => {
    const acct = await account(jordan, 'experian', { creditor_name: creditor, account_last4: last4 }, '2026-10-30');
    const d = await asUser(owner.userId, (db) => createDispute(db, owner, { clientId: jordan, tradelineId: acct, category: 'incorrect_balance', reason: REASON, fields: ['Balance'] }));
    return asUser(owner.userId, (db) => createLetter(db, owner, { clientId: jordan, disputeId: d }));
  };

  it('with no credits the model is never called and nothing is written', async () => {
    const ai = fake(reword);
    expect(await ask(ai.provider)).toMatchObject({ ok: false, ai: { status: 'no_credits' } });
    expect(ai.calls).toEqual([]);
    expect(await ledger(A.orgId)).toEqual([]);
  });

  it('a discarded result costs nothing: a changed fact, a threat, a failing provider', async () => {
    await grant(A.orgId, 20);
    const discards: [string, (m: string) => string | Error][] = [
      ['a fact written into the wording', (m) => reword(m).replace('Respectfully,', 'The correct balance is $450.00.\nRespectfully,')],
      ['a protected passage dropped', (m) => reword(m).replace('[[LOCKED_9]]', '')],
      ['a threat', (m) => reword(m).replace('Respectfully,', 'Otherwise I will take this further.\nRespectfully,')],
      ['a failing provider', () => new Error('HTTP 500')],
    ];
    for (const [name, fn] of discards) {
      const ai = fake(fn);
      const r = await ask(ai.provider);
      expect(r.ok, name).toBe(false);
      expect(!r.ok && r.ai.status, name).toBe('refunded');
      expect(!r.ok && r.message, name).toMatch(/No AI credits were used/);
      expect(ai.calls, name).toHaveLength(1);
      expect(await getBalance(A.orgId), name).toBe(20);
    }
    expect((await ledger(A.orgId)).map((x) => x.reason)).toEqual(['grant', 'use', 'refund', 'use', 'refund', 'use', 'refund', 'use', 'refund']);
    expect(await asUser(owner.userId, (db) => storedSuggestion(db, jordanLetter, 1))).toBeNull();
    expect(await body(jordanLetter)).toContain('To whom it may concern:'); // the letter itself was never touched
  });

  it('an accepted result is charged once, keeps every fact, and is not charged again for the same version', async () => {
    const ai = fake(reword);
    const before = await body(jordanLetter);
    const r = await ask(ai.provider);
    expect(r).toMatchObject({ ok: true, cost: AI_COSTS.letter_suggestion, provider: 'fake' });
    const text = r.ok ? r.text : '';
    for (const fact of ['Jordan Rivera', '123 Main St', 'Tampa, FL 33602', 'Item: ACME BANK, account ending 1234', 'date opened March 3, 2019; balance $1,200.00', 'I closed this card when I moved.', 'January 2026 statement', '  - Copy: Proof of current address', '15 U.S.C. § 1681i']) expect(text, fact).toContain(fact);
    expect(text).toContain('Dear Sir or Madam:');
    expect(text).toContain(rewordedCourtesy(jordan));
    expect(VOICE_LINES.filter((l) => text.includes(l))).toEqual([]); // every sentence it was shown was reworded
    expect(await getBalance(A.orgId)).toBe(20 - AI_COSTS.letter_suggestion);
    expect(await ask(ai.provider)).toEqual({ ok: true, text, provider: 'fake', cost: 0 });
    expect(ai.calls).toHaveLength(1);
    expect((await ledger(A.orgId)).filter((x) => x.reason === 'use')).toHaveLength(5); // four refunded above, one that stands
    expect((await ledger(A.orgId)).reduce((n, x) => n + x.delta, 0)).toBe(20 - AI_COSTS.letter_suggestion);
    expect(await body(jordanLetter)).toBe(before); // a suggestion saves nothing: a person compares it and decides

    // What left the server: the masked template and a voice made of fixed phrases. Nothing from the client's file.
    const prompt = `${ai.calls[0]!.system}\n${ai.calls[0]!.user}`;
    for (const secret of ['Jordan', 'Rivera', 'Main St', 'Tampa', '33602', 'ACME', '1234', 'Experian', '1,200', '900', 'January', 'statement', 'closed this card', 'photo ID', jordan, A.orgId]) expect(prompt, secret).not.toContain(secret);
    const s = (await asUser(owner.userId, (db) => loadTailorSubject(db, jordanLetter)))!;
    expect(ai.calls[0]!.user.startsWith(`Goal: ${tailorGoal(s.seed)}\n\n<source>\n`)).toBe(true);
    expect(/<source>\n([\s\S]*)\n<\/source>/.exec(ai.calls[0]!.user)![1]!.replace(/\[\[LOCKED_\d+\]\]/g, '')).not.toMatch(/\d|\$|§/);
  });

  it('two requests for the same version that overlap are charged once, and both are shown the suggestion that was kept', async () => {
    const l = await letterOnNewAccount('NORTH SHORE BANK', '6677');
    await grant(A.orgId, 10);
    const before = await getBalance(A.orgId);
    // Neither request has a result before both have reached the model: the stand-in answers only once two are waiting.
    let waiting = 0;
    let release = () => {};
    const bothWaiting = new Promise<void>((resolve) => { release = resolve; });
    const answered: string[] = [];
    const slow: AiProvider = {
      name: 'fake',
      async complete(req) {
        const signOff = ['Respectfully,', 'Cordially,'][waiting]!;
        if (++waiting === 2) release();
        await bothWaiting;
        answered.push(signOff);
        return /<source>\n([\s\S]*)\n<\/source>/.exec(req.user)![1]!.replace('Sincerely,', signOff);
      },
    };
    const [a, b] = await Promise.all([ask(slow, l), ask(slow, l)]);
    expect(answered.sort()).toEqual(['Cordially,', 'Respectfully,']); // both were worded, each differently
    expect([a.ok, b.ok]).toEqual([true, true]);
    // One of them pays; the other finds a suggestion already kept for the version and is given its credits back.
    expect([a, b].map((r) => (r.ok ? r.cost : null)).sort()).toEqual([0, AI_COSTS.letter_suggestion]);
    expect(await getBalance(A.orgId)).toBe(before - AI_COSTS.letter_suggestion);
    const kept = (await asUser(owner.userId, (db) => storedSuggestion(db, l, 1)))!;
    expect(kept.body).toMatch(/\n(Respectfully|Cordially),\n/);
    for (const r of [a, b]) expect(r.ok && r.text).toBe(kept.body); // what each person compares is the one that can be accepted later
    expect(await withSystem((db) => db.rows('select count(*)::int as n from public.letter_suggestions where letter_id = $1', [l]))).toEqual([{ n: 1 }]);
    // On the ledger: two charges and one refund. The refund carries no reference, which the ledger allows.
    const rows = await withSystem((db) => db.rows<{ reason: string; delta: number; feature: string | null; ref_id: number | null; note: string | null; settled: boolean }>(
      'select reason, delta, feature, ref_id, note, settled_at is not null as settled from public.ai_credit_ledger where org_id = $1 order by id desc limit 3', [A.orgId]));
    expect(rows.reverse()).toEqual([
      { reason: 'use', delta: -AI_COSTS.letter_suggestion, feature: 'letter_suggestion', ref_id: null, note: null, settled: true },
      { reason: 'use', delta: -AI_COSTS.letter_suggestion, feature: 'letter_suggestion', ref_id: null, note: null, settled: true },
      { reason: 'refund', delta: AI_COSTS.letter_suggestion, feature: 'letter_suggestion', ref_id: null, note: 'This letter version already had a suggestion', settled: false },
    ]);
    // Asking again is free and does not reach the model.
    const again = fake(reword);
    expect(await ask(again.provider, l)).toEqual({ ok: true, text: kept.body, provider: 'fake', cost: 0 });
    expect(again.calls).toEqual([]);
    expect(await getBalance(A.orgId)).toBe(before - AI_COSTS.letter_suggestion);
    await asUser(owner.userId, (db) => setLetterStatus(db, owner, l, 'void'));
  });

  it('a suggestion kept from earlier is offered again only while it still passes the checks', async () => {
    const v = voiceFor(styleSeed(jordan));
    const closing = [v.contact, v.thanks].filter(Boolean).join(' ');
    // Stored for the version under looser rules: one changes an amount, the other says something nobody recorded in
    // words that were all on the courtesy list when it was made.
    const earlier: [string, string, (text: string) => string][] = [
      ['LAKESIDE FINANCE', '5521', (text) => text.replace('balance of $900.00', 'balance of $90.00')],
      ['RIVERBEND CREDIT', '5522', (text) => text.replace(closing, 'This is mine. I reached out to you by mail.')],
    ];
    for (const [creditor, last4, change] of earlier) {
      const l = await letterOnNewAccount(creditor, last4);
      const stored = change(await body(l));
      expect(stored, creditor).not.toBe(await body(l));
      await withSystem((db) => db.run("insert into public.letter_suggestions (letter_id, version, org_id, body, provider) values ($1, 1, $2, $3, 'earlier')", [l, A.orgId, stored]));
      const ai = fake(reword);
      const balance = await getBalance(A.orgId);
      const r = await ask(ai.provider, l);
      expect(r, creditor).toMatchObject({ ok: false, ai: { status: 'not_called', cost: 0 } });
      expect(!r.ok && r.message, creditor).toMatch(/no longer passes the wording checks[\s\S]*No AI credits were used/);
      expect(ai.calls, creditor).toEqual([]);
      expect(await getBalance(A.orgId), creditor).toBe(balance);
      await asUser(owner.userId, (db) => setLetterStatus(db, owner, l, 'void'));
    }
  });

  it('a reason typed for a standalone letter is locked too, from a built-in template or the agency’s own', async () => {
    const story = 'My mother was ill last spring and I was away from home for many weeks. We have been customers for a long time.';
    const own = await withSystem((db) => db.row<{ id: string }>(
      "insert into public.letter_templates (org_id, name, kind, language, body) values ($1, 'Our goodwill', 'goodwill', 'en', $2) returning id",
      [A.orgId, '{{date}}\n\n{{client_name}}\n{{client_address}}\n\nDear {{recipient_name}}:\n\nI hope this note finds you well.\n\n{{reason}}\n\nWith thanks for hearing me out.\n\nSincerely,\n\n{{client_name}}']));
    for (const templateKey of ['goodwill_en', `org:${own!.id}`]) {
      const l = await asUser(owner.userId, (db) => createLetter(db, owner, { clientId: jordan, templateKey, reasonOverride: story, recipientName: 'Lakeside Finance', recipientAddress: 'PO Box 1, Anytown, ST 00000' }));
      const subject = (await asUser(owner.userId, (db) => loadTailorSubject(db, l)))!;
      expect(subject.body, templateKey).toContain(story);
      expect(subject.specificity, templateKey).toBeNull();
      const wording = editableWording(subject.body, subject.protectedTerms);
      expect(wording, templateKey).not.toMatch(/mother|ill last spring|away from home|customers|Lakeside|Jordan|Tampa/);
      await asUser(owner.userId, (db) => setLetterStatus(db, owner, l, 'void'));
    }
  });

  it('a letter that fails the specificity check is not sent to the model at all', async () => {
    const d = await asUser(owner.userId, (db) => createDispute(db, owner, { clientId: jordan, category: 'other', bureau: 'equifax', reason: 'Please verify this item.' }));
    const l = await asUser(owner.userId, (db) => createLetter(db, owner, { clientId: jordan, disputeId: d }));
    const ai = fake(reword);
    const r = await ask(ai.provider, l);
    expect(r).toMatchObject({ ok: false, ai: { status: 'not_called' } });
    expect(!r.ok && r.message).toMatch(/cannot add what the letter is missing/);
    expect(ai.calls).toEqual([]);
    await asUser(owner.userId, (db) => setLetterStatus(db, owner, l, 'void'));
  });
});

describe('“Tailor wording automatically when a letter is drafted”', () => {
  const STATUS_REASON = 'Experian reports this account as open. I closed it in March 2024 and have the closing letter.';
  let drafts = 0;
  /** Each draft is about an account of its own, so no test depends on how many disputes one account may have open. */
  const draft = async () => {
    const acct = await account(jordan, 'experian', { creditor_name: `HARBOR CARD ${++drafts}`, account_last4: String(7000 + drafts) }, '2026-10-30');
    const d = await asUser(owner.userId, (db) => createDispute(db, owner, { clientId: jordan, tradelineId: acct, category: 'incorrect_status', reason: STATUS_REASON, fields: ['Account status'] }));
    return asUser(owner.userId, (db) => createLetter(db, owner, { clientId: jordan, disputeId: d }));
  };

  it('is off by default: the draft keeps its standard wording and nothing is spent', async () => {
    expect(await asUser(owner.userId, (db) => autoTailorOn(db, A.orgId))).toBe(false);
    const letter = await draft();
    const ai = fake(reword);
    const balance = await getBalance(A.orgId);
    expect(await autoTailorDraft(owner, letter, tx(owner.userId), ai.provider)).toBe('off');
    expect(ai.calls).toEqual([]);
    expect(await getBalance(A.orgId)).toBe(balance);
    expect(await withSystem((db) => db.row('select current_version, status from public.letters where id = $1', [letter]))).toEqual({ current_version: 1, status: 'draft' });
  });

  it('only an owner or admin can turn it on', async () => {
    await asUser(specialist.userId, (db) => setAutoTailor(db, A.orgId, true)); // row-level security: the update touches nothing
    expect(await asUser(owner.userId, (db) => autoTailorOn(db, A.orgId))).toBe(false);
    await asUser(owner.userId, (db) => setAutoTailor(db, A.orgId, true));
    expect(await asUser(specialist.userId, (db) => autoTailorOn(db, A.orgId))).toBe(true);
    expect(await asUser(B.ownerId, (db) => autoTailorOn(db, B.orgId))).toBe(false); // another workspace is unaffected
  });

  it('on: the draft is reworded once, charged once, marked as AI wording, and still has to be approved by a person', async () => {
    const letter = await draft();
    const original = await body(letter);
    const ai = fake(reword);
    const balance = await getBalance(A.orgId);
    expect(await autoTailorDraft(specialist, letter, tx(specialist.userId), ai.provider)).toBe('applied');
    expect(ai.calls).toHaveLength(1);
    expect(await getBalance(A.orgId)).toBe(balance - AI_COSTS.letter_suggestion);
    const row = await withSystem((db) => db.row<{ current_version: number; status: string; approved_by: string | null }>('select current_version, status, approved_by from public.letters where id = $1', [letter]));
    expect(row).toEqual({ current_version: 2, status: 'draft', approved_by: null });
    const versions = await withSystem((db) => db.rows<{ version: number; source: string; change_note: string | null }>('select version, source, change_note from public.letter_versions where letter_id = $1 order by version', [letter]));
    expect(versions).toEqual([{ version: 1, source: 'template', change_note: 'Generated from template' }, { version: 2, source: 'ai_draft', change_note: 'AI wording applied when the letter was drafted (fake)' }]);
    const now = await body(letter);
    expect(now).toContain('Dear Sir or Madam:');
    expect(now).toContain(STATUS_REASON);
    expect(now).toContain('date opened March 3, 2019; account status “Open”; payment status “Current”.');
    expect(now.split('\n').filter((l) => !original.split('\n').includes(l)).length).toBeLessThanOrEqual(4);
    // Human approval is not removed: it cannot be approved from draft, and a specialist cannot approve at all.
    await expect(asUser(owner.userId, (db) => setLetterStatus(db, owner, letter, 'approved'))).rejects.toThrow(/Send the letter for approval first/);
    await asUser(specialist.userId, (db) => setLetterStatus(db, specialist, letter, 'pending_approval'));
    await expect(asUser(specialist.userId, (db) => setLetterStatus(db, specialist, letter, 'approved'))).rejects.toThrow(/letters:approve/);
    await asUser(owner.userId, (db) => setLetterStatus(db, owner, letter, 'approved'));
    // Running it again on a letter that is no longer a draft does nothing.
    expect(await autoTailorDraft(owner, letter, tx(owner.userId), ai.provider)).toBe('unchanged');
    expect(ai.calls).toHaveLength(1);
  });

  it('on, but nothing safe comes back: the draft is left exactly as it was and nothing is charged', async () => {
    const letter = await draft();
    const original = await body(letter);
    const balance = await getBalance(A.orgId);
    const bad = fake((m) => reword(m).replace('Respectfully,', 'You must answer immediately.\nRespectfully,'));
    expect(await autoTailorDraft(owner, letter, tx(owner.userId), bad.provider)).toBe('unchanged');
    expect(bad.calls).toHaveLength(1);
    expect(await autoTailorDraft(owner, letter, tx(owner.userId), null)).toBe('off'); // no provider connected
    expect(await getBalance(A.orgId)).toBe(balance);
    expect(await body(letter)).toBe(original);
    expect(await withSystem((db) => db.row('select current_version, status from public.letters where id = $1', [letter]))).toEqual({ current_version: 1, status: 'draft' });
    await asUser(owner.userId, (db) => setAutoTailor(db, A.orgId, false));
  });
});

describe('wording overlap with other recent letters', () => {
  it('compares with other clients’ letters in the same organization only, worked out from stored text', async () => {
    const s = (await asUser(owner.userId, (db) => loadTailorSubject(db, jordanLetter)))!;
    const others = await asUser(owner.userId, (db) => recentOtherWording(db, jordan));
    // Maria's letters only: none of Jordan's own, no void letter, and nothing that names a person, an account, a bureau, a date or an amount.
    const mariaLetters = await withSystem((db) => db.row<{ n: number }>("select count(*)::int as n from public.letters where client_id = $1 and status <> 'void'", [maria]));
    expect(others).toHaveLength(mariaLetters!.n);
    expect(others.length).toBeGreaterThanOrEqual(2);
    for (const o of others) expect(o).not.toMatch(/Maria|Chen|Seattle|Pine|HARBOR|7788|Equifax|August|September|\d|\$/);
    // The same is taken out of this letter before it is compared: what is left is wording.
    expect(s.comparable).not.toMatch(/Jordan|Rivera|Main St|Tampa|ACME|1234|Experian|\d|\$/);
    // The whole letter is measured, not only the few connecting sentences an AI may reword: the statutory opening and
    // the request, which every letter from this template shares, are in it. The reason and the enclosure list are not.
    expect(s.comparable).toContain('I am writing under Section of the Fair Credit Reporting Act');
    expect(s.comparable).toContain('Please conduct a reasonable reinvestigation of the balance reported for this account');
    expect(s.comparable).not.toContain('My statement shows');
    expect(s.comparable).not.toMatch(/^\s*-/m);
    expect(s.comparable.split(/\s+/).length).toBeGreaterThan(4 * editableWording(s.body, s.protectedTerms).split(/\s+/).length);
    const overlap = (await asUser(owner.userId, (db) => letterOverlap(db, s)))!;
    expect(overlap).toEqual(wordingOverlap(s.comparable, others));
    // Jordan's and Maria's letters come from the same template: most of their wording is the same, whatever their facts.
    expect(overlap.level).toBe('high');
    expect(overlap.compared).toBe(others.length);
    // Seen from Maria's side, Jordan's letters are the others.
    expect((await asUser(owner.userId, (db) => recentOtherWording(db, maria))).length).toBeGreaterThanOrEqual(1);
    // Another organization has nothing to compare with, and cannot read these letters.
    expect(await asUser(B.ownerId, (db) => recentOtherWording(db, jordan))).toEqual([]);
    expect(await asUser(B.ownerId, (db) => loadTailorSubject(db, jordanLetter))).toBeNull();
  });

  it('rewording the courtesy lines does not make a template letter read as the client’s own; a letter in other words does', async () => {
    // A third client with the same kind of dispute as Jordan, drafted from the same template.
    const pat = await addClient(A.orgId, 'Pat Lee');
    await withSystem((db) => db.run(`update public.clients set address = '{"line1":"77 Lake Rd","city":"Orlando","state":"FL","zip":"32801"}' where id = $1`, [pat]));
    const d = await asUser(owner.userId, (db) => createDispute(db, owner, { clientId: pat, category: 'incorrect_balance', bureau: 'experian', itemLabel: 'Lakeside Finance ••5521',
      reason: 'Experian reports a balance of $85.00 for Lakeside Finance. My receipt dated May 4, 2026 shows I paid it in full.', fields: ['Balance'] }));
    const l = await asUser(owner.userId, (db) => createLetter(db, owner, { clientId: pat, disputeId: d }));
    const overlapOf = async () => (await asUser(owner.userId, async (db) => letterOverlap(db, (await loadTailorSubject(db, l))!)))!;
    const standard = await overlapOf();
    expect(standard.level).toBe('high');
    expect(standard.score).toBeGreaterThanOrEqual(OVERLAP_HIGH);

    // The stand-in model rewords every line an AI may touch: the lead-in, the salutation, the thanks and the sign-off.
    const draft = await body(l);
    const tailored = reword(draft);
    expect(tailored).not.toBe(draft);
    await asUser(owner.userId, (db) => saveVersion(db, owner, l, tailored, 'ai_draft', 'reworded'));
    // The letter still reads as the template it is: the opening that cites the right and the request, which are most of
    // it, are word for word in the other clients' letters. That is what a bureau would see too.
    const afterTailoring = await overlapOf();
    expect(afterTailoring.level).toBe('high');
    expect(afterTailoring.score).toBeGreaterThan(OVERLAP_HIGH);

    // A letter in the client's own words, with the same facts, is what reads differently.
    const own = draft.split('\n');
    const re = own.findIndex((x) => x.startsWith('Re:'));
    const to = own.findIndex((x) => x.startsWith('Sincerely'));
    const rewritten = [...own.slice(0, re), 'Re: The balance you show for Lakeside Finance ••5521', '', 'To whom it may concern:', '',
      'I looked at my credit file last week and one account on it is not right, so I am asking you to look into it again.', '',
      'Experian reports a balance of $85.00 for Lakeside Finance. My receipt dated May 4, 2026 shows I paid it in full.', '',
      'Would you check what Lakeside Finance told you against the receipt, and write back to me with what you find? If my file changes I would like to see the new version of it.', '',
      ...own.slice(to)].join('\n');
    await asUser(owner.userId, (db) => saveVersion(db, owner, l, rewritten, 'manual_edit', 'own words'));
    const ownWords = await overlapOf();
    expect(ownWords.level).toBe('low');
    expect(ownWords.score).toBeLessThan(OVERLAP_MEDIUM);
  });
});
