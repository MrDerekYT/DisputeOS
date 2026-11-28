import { describe, expect, it } from 'vitest';
import { aiLabelRequest, parseAiLabels, AI_LABEL_LIMIT } from '@/lib/credit/account-labels';

const acct = (id: string, o: Record<string, string | null> = {}) => ({
  id, item_type: 'tradeline', creditor_name: 'ACME LLC', original_creditor: null, account_type: null, account_status: null, payment_status: null, payment_history: null, remarks: null, ...o,
});

describe('what is sent to AI', () => {
  it('one numbered block per account with its own words, nothing else', () => {
    const { user, refs, system } = aiLabelRequest([
      acct('a', { creditor_name: 'MIDLAND CREDIT MANAGEMENT' }),
      acct('b', { remarks: 'Rating: Unrated · call 555-123-4567', account_type: 'Revolving' }),
    ]);
    expect([...refs.keys()]).toEqual(['A1', 'A2']);
    expect(user).toBe('Accounts:\n\nA1\ncompany: MIDLAND CREDIT MANAGEMENT\nlisted under: accounts\n\nA2\ncompany: ACME LLC\naccount type: Revolving\nremarks: Rating: Unrated · call [PHONE]\nlisted under: accounts');
    expect(system).toMatch(/Use only the words given for that account/);
    expect(system).toMatch(/A name never shows any other kind/);
  });

  it(`never more than ${AI_LABEL_LIMIT} accounts`, () => {
    expect(aiLabelRequest(Array.from({ length: AI_LABEL_LIMIT + 5 }, (_, i) => acct(String(i)))).refs.size).toBe(AI_LABEL_LIMIT);
  });
});

describe('what is kept from the reply', () => {
  const { refs } = aiLabelRequest([
    acct('a', { creditor_name: 'MIDLAND CREDIT MANAGEMENT' }),
    acct('b', { remarks: 'Rating: Unrated' }),
    acct('c', { payment_status: 'Pmt OK each month' }),
    acct('d', { account_status: 'R/O 04' }),
  ]);
  const one = (reply: string) => parseAiLabels(reply, refs);

  it('keeps a kind whose words are in that account, saying which field they are in', () => {
    expect(one('A3|good|Pmt OK each month')).toEqual([{ id: 'c', kind: 'good', words: 'Pmt OK each month', field: 'payment_status' }]);
    expect(one('- A1 | collection | “Midland Credit Management”')).toEqual([{ id: 'a', kind: 'collection', words: 'Midland Credit Management', field: 'creditor_name' }]);
  });

  it('drops invented words, a name used for anything but a collection, and "good" resting on remarks', () => {
    expect(one('A4|charge_off|Charged off as bad debt')).toEqual([{ id: 'd', kind: 'unknown', words: null, field: null }]);
    expect(one('A1|good|MIDLAND CREDIT MANAGEMENT')).toEqual([{ id: 'a', kind: 'unknown', words: null, field: null }]);
    expect(one('A2|good|Unrated')).toEqual([{ id: 'b', kind: 'unknown', words: null, field: null }]);
    expect(one('A2|negative|Unrated')).toEqual([{ id: 'b', kind: 'negative', words: 'Unrated', field: 'remarks' }]);
  });

  it('drops a kind that is not one, an empty answer, unknown references and repeats; ignores other lines', () => {
    expect(one('Here you go:\nA1|great|MIDLAND\nA2|late|\nA9|late|x\nA3|good|Pmt OK each month\nA3|late|Pmt OK each month'))
      .toEqual([
        { id: 'a', kind: 'unknown', words: null, field: null },
        { id: 'b', kind: 'unknown', words: null, field: null },
        { id: 'c', kind: 'good', words: 'Pmt OK each month', field: 'payment_status' },
      ]);
    expect(one('')).toEqual([]);
  });
});
