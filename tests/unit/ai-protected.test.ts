import { describe, expect, it } from 'vitest';
import { rewriteSafely, type AiProvider } from '@/lib/ai/provider';
import { protect, restore, sameProtectedContent } from '@/lib/ai/protected';
import { scrubPii } from '@/lib/scrub';

const LETTER = [
  'Dear Sir or Madam,',
  '',
  'I hope this letter finds you well. I am writing to you today about my file.',
  'Experian reports a balance of $1,200.00 for Acme Bank (account ending 1234); Equifax reports $900.00. Please verify the balance with the furnisher.',
  '',
  'Thank you for your time and attention.',
  'Sincerely,',
  'Jordan Rivera',
].join('\n');
const TERMS = ['Jordan Rivera', 'Acme Bank'];

const fake = (fn: (masked: string) => string | Error): AiProvider & { seen: string[] } => {
  const seen: string[] = [];
  return { name: 'fake', seen, complete: async (r) => { const masked = /<source>\n([\s\S]*)\n<\/source>/.exec(r.user)![1]!; seen.push(r.user); const out = fn(masked); if (out instanceof Error) throw out; return out; } };
};
const polite = (m: string) => m.replace('I hope this letter finds you well. I am writing to you today about my file.', 'I hope you are well. I am writing about my file.').replace('Thank you for your time and attention.', 'Thank you for your help.');

describe('protected rewriting: what the model can and cannot touch', () => {
  it('hides every fact-bearing passage from the model, including names it was told to protect', () => {
    const p = protect(LETTER, TERMS);
    expect(p.masked).not.toMatch(/Experian|Equifax|1,200|900|1234|Acme|Jordan|verify/);
    expect(p.masked).toContain('I hope this letter finds you well.');
    expect(p.locked.join(' ')).toContain('Experian reports a balance of $1,200.00 for Acme Bank (account ending 1234); Equifax reports $900.00.');
    expect(restore(p, p.masked, TERMS)).toEqual({ ok: true, text: LETTER });
  });

  it('accepts a rewrite of the connective wording and restores every fact exactly', async () => {
    const ai = fake(polite);
    const r = await rewriteSafely(LETTER, 'polish', ai, TERMS);
    expect(r.usedAi).toBe(true);
    expect(r.text).toContain('I hope you are well. I am writing about my file.');
    expect(r.text).toContain('Experian reports a balance of $1,200.00 for Acme Bank (account ending 1234); Equifax reports $900.00. Please verify the balance with the furnisher.');
    expect(r.text).toContain('Jordan Rivera');
    expect(ai.seen[0]).not.toMatch(/Experian|Equifax|\$|Acme|Jordan Rivera/); // none of it left the server
  });

  it('REGRESSION: cannot swap the Experian and Equifax balances', async () => {
    // the old number-set check accepted this, because every number is still present
    const swapped = LETTER.replace('Experian reports a balance of $1,200.00', 'Experian reports a balance of $900.00').replace('Equifax reports $900.00', 'Equifax reports $1,200.00');
    const r = await rewriteSafely(LETTER, 'polish', fake(() => swapped), TERMS);
    expect(r).toMatchObject({ usedAi: false, text: LETTER });
    expect(sameProtectedContent(LETTER, swapped, TERMS)).toBe(false);
  });

  it('REGRESSION: cannot change the creditor name', async () => {
    const renamed = LETTER.replace('Acme Bank', 'Apex Bank');
    const r = await rewriteSafely(LETTER, 'polish', fake(() => renamed), TERMS);
    expect(r).toMatchObject({ usedAi: false, text: LETTER });
    expect(sameProtectedContent(LETTER, renamed, TERMS)).toBe(false);
  });

  it('REGRESSION: a missing, repeated, renumbered, reordered or altered placeholder is rejected', async () => {
    const p = protect(LETTER, TERMS);
    expect(p.locked.length).toBeGreaterThanOrEqual(3);
    const cases: [string, (m: string) => string][] = [
      ['missing', (m) => m.replace('[[LOCKED_2]]', '')],
      ['repeated', (m) => m.replace('[[LOCKED_2]]', '[[LOCKED_2]] [[LOCKED_2]]')],
      ['invented', (m) => `${m}\n[[LOCKED_99]]`],
      ['renumbered', (m) => m.replace('[[LOCKED_2]]', '[[LOCKED_3]]').replace(/\[\[LOCKED_3\]\](?![\s\S]*\[\[LOCKED_3\]\])/, '[[LOCKED_2]]')],
      ['altered', (m) => m.replace('[[LOCKED_2]]', '[[LOCKED_2 ]]')],
      ['lower-cased', (m) => m.replace('[[LOCKED_2]]', '[[locked_2]]')],
      ['moved to another paragraph', (m) => m.replace('[[LOCKED_2]]', '').replace('Dear Sir or Madam,', 'Dear Sir or Madam, [[LOCKED_2]]')],
    ];
    for (const [name, mutate] of cases) {
      expect(restore(p, mutate(p.masked), TERMS).ok, name).toBe(false);
      const r = await rewriteSafely(LETTER, 'polish', fake(mutate), TERMS);
      expect(r, name).toMatchObject({ usedAi: false, text: LETTER });
      expect(r.note, name).toMatch(/discarded/);
    }
  });

  it('rejects editable wording that smuggles in a fact, a name, a bureau or a prohibited claim', async () => {
    const additions = ['The correct balance is $450.00.', 'TransUnion agrees with me.', 'Acme Bank made this up.', 'You must remove this account.', 'We guarantee this will be fixed.'];
    for (const add of additions) {
      const r = await rewriteSafely(LETTER, 'polish', fake((m) => `${m}\n${add}`), TERMS);
      expect(r, add).toMatchObject({ usedAi: false, text: LETTER });
    }
  });

  it('falls back to the original when the provider fails, is absent, or there is nothing safe to reword', async () => {
    expect((await rewriteSafely(LETTER, 'x', fake(() => new Error('boom')), TERMS)).text).toBe(LETTER);
    expect(await rewriteSafely(LETTER, 'x', null, TERMS)).toMatchObject({ usedAi: false, provider: 'rules', text: LETTER });
    const allFacts = 'Experian reports $1,200.00. Equifax reports $900.00.';
    const ai = fake((m) => m);
    expect(await rewriteSafely(allFacts, 'x', ai)).toMatchObject({ usedAi: false, text: allFacts });
    expect(ai.seen).toEqual([]); // the model was never called
  });

  it('refuses to start from a source that makes a prohibited claim, and scrubs identifiers that are not locked', async () => {
    await expect(rewriteSafely('We guarantee deletion of all your negative items.', 'x', fake(() => 'ok'))).rejects.toThrow(/prohibited/i);
    expect(scrubPii('Contact jane@example.com')).toBe('Contact [EMAIL]');
    const ai = fake((m) => m);
    await rewriteSafely('Hello there, thank you so much for your kind note. Write to jane@example.com any time you like, we are happy to help.', 'x', ai);
    expect(ai.seen[0]).not.toContain('jane@example.com');
  });

  it('never cuts an address or a legal citation in two, and labelled lines stay whole', () => {
    const text = ['Experian', 'P.O. Box 4500, Allen, TX 75013', '', 'To whom it may concern:', '',
      'I am writing under the Fair Credit Reporting Act, 15 U.S.C. § 1681i. Please investigate the item below.',
      'Item: Acme Bank account ending 1234', 'Specific information I am asking you to review: Balance', '', 'Thank you for your kind attention to this matter.', 'Sincerely,'].join('\n');
    const p = protect(text, ['Acme Bank']);
    expect(p.masked.replace(/\[\[LOCKED_\d+\]\]/g, '')).not.toMatch(/P\.O\.|S\.C\.|U\.S|Box|Item:|Specific information|Acme|\d/);
    expect(p.masked).toContain('To whom it may concern:');
    expect(p.masked).toContain('Thank you for your kind attention to this matter.');
    expect(restore(p, p.masked, ['Acme Bank'])).toEqual({ ok: true, text });
  });

  it('refuses text that already contains protection markers', () => {
    expect(() => protect('Hello [[LOCKED_1]] there')).toThrow();
    expect(sameProtectedContent(LETTER, `${LETTER}\n[[LOCKED_1]]`, TERMS)).toBe(false);
  });
});
