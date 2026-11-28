import { describe, expect, it } from 'vitest';
import { aiLabelRequest, parseAiLabels, AI_LABEL_LIMIT } from '@/lib/credit/account-labels';

const acct = (id: string, o: Record<string, string | null> = {}) => ({
  id, item_type: 'tradeline', creditor_name: 'ACME LLC', original_creditor: null, account_type: null, account_status: null, payment_status: null, payment_history: null, remarks: null, ...o,
});

describe('what is sent to AI', () => {
  it('one numbered block per account with its own words; amounts, long numbers, holder remarks and the client’s name left out', () => {
    const { user, refs, system } = aiLabelRequest([
      acct('a', { creditor_name: 'MIDLAND CREDIT MANAGEMENT' }),
      acct('b', { remarks: 'Rating: Unrated · call 555-123-4567 · Responsibility: Joint with SAM RIVERA · Terms: $310 per month · Ref 1234567 for ROBIN', account_type: 'Revolving', payment_status: 'Open. $690 past due' }),
    ], 'Robin Example');
    expect([...refs.keys()]).toEqual(['A1', 'A2']);
    expect(user).toBe('Accounts:\n\nA1\ncompany: MIDLAND CREDIT MANAGEMENT\nlisted under: accounts\n\nA2\ncompany: ACME LLC\naccount type: Revolving\npayment status: Open. [amount] past due\nremarks: Rating: Unrated · call [PHONE] · Terms: [amount] per month · Ref [number] for [name]\nlisted under: accounts');
    expect(user).not.toMatch(/SAM RIVERA|Robin|ROBIN|310|690|1234567/);
    expect(system).toMatch(/Use only the words given for that account/);
    expect(system).toMatch(/A name never shows any other kind/);
  });

  it(`never more than ${AI_LABEL_LIMIT} accounts`, () => {
    expect(aiLabelRequest(Array.from({ length: AI_LABEL_LIMIT + 5 }, (_, i) => acct(String(i)))).refs.size).toBe(AI_LABEL_LIMIT);
  });
});

describe('what is kept from the reply', () => {
  const req = aiLabelRequest([
    acct('a', { creditor_name: 'MIDLAND CREDIT MANAGEMENT' }),
    acct('b', { remarks: 'Rating: Unrated' }),
    acct('c', { payment_status: 'Pmt OK each month' }),
    acct('d', { account_status: 'R/O 04' }),
    acct('e', { payment_status: 'CHRG OFF PROFIT/LOSS' }),
    acct('f', { account_status: 'Not paid' }),
    acct('g', { payment_status: 'Unpaid' }),
    acct('h', { payment_history: 'No late payments in the months reported' }),
    acct('i', { remarks: 'Terms: paid Monthly for 30 months' }),
  ]);
  const one = (reply: string) => parseAiLabels(reply, req.refs, req.texts);
  const unknown = (id: string) => ({ id, kind: 'unknown', words: null, field: null });

  it('keeps a negative kind whose whole words, in that account, show it', () => {
    expect(one('- A1 | collection | “Midland Credit Management”')).toEqual([{ id: 'a', kind: 'collection', words: 'Midland Credit Management', field: 'creditor_name' }]);
    expect(one('A5|charge_off|CHRG OFF')).toEqual([{ id: 'e', kind: 'charge_off', words: 'CHRG OFF', field: 'payment_status' }]);
  });

  it('keeps good standing only as a hint for a person, never as a label', () => {
    expect(one('A3|good|Pmt OK each month')).toEqual([{ id: 'c', kind: 'unknown', words: 'Pmt OK each month', field: 'payment_status', hint: 'good' }]);
  });

  it('drops what the review found: fragments, negated words, words that do not show the kind, names used for anything but a collection', () => {
    expect(one('A4|charge_off|Charged off as bad debt')).toEqual([unknown('d')]); // not in the account
    expect(one('A2|charge_off|ra')).toEqual([unknown('b')]); // a fragment of "Rating"
    expect(one('A2|negative|Unrated')).toEqual([unknown('b')]); // "Unrated" shows nothing negative
    expect(one('A2|good|Unrated')).toEqual([unknown('b')]); // good never rests on remarks
    expect(one('A1|good|MIDLAND CREDIT MANAGEMENT')).toEqual([unknown('a')]);
    expect(one('A6|no_negative|paid')).toEqual([unknown('f')]); // "paid" out of "Not paid"
    expect(one('A7|good|Unpaid')).toEqual([unknown('g')]);
    expect(one('A7|good|paid')).toEqual([unknown('g')]); // not a whole word of "Unpaid"
    expect(one('A8|was_late|late payments')).toEqual([unknown('h')]); // "No late payments"
    expect(one('A9|was_late|30')).toEqual([unknown('i')]); // a term, and no letters
    expect(one('A9|was_late|for 30 months')).toEqual([unknown('i')]);
  });

  it('drops a kind that is not one, an empty answer, unknown references and repeats; ignores other lines', () => {
    expect(one('Here you go:\nA1|great|MIDLAND\nA2|late|\nA99|late|x\nA5|charge_off|CHRG OFF\nA5|late|CHRG OFF'))
      .toEqual([unknown('a'), unknown('b'), { id: 'e', kind: 'charge_off', words: 'CHRG OFF', field: 'payment_status' }]);
    expect(one('')).toEqual([]);
  });
});
