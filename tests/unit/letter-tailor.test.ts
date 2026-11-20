import { describe, expect, it } from 'vitest';
import { protect, sameProtectedContent } from '@/lib/ai/protected';
import type { AiProvider, AiRequest } from '@/lib/ai/provider';
import { findBlockedClaims } from '@/lib/compliance/claims';
import { buildBrief, contextFor, disputeLetterKey, styleSeed, voiceFor, type BriefRecord } from '@/lib/letters/brief';
import { comparableWording, editableWording, OVERLAP_HIGH, OVERLAP_MEDIUM, shingles, wordingOverlap } from '@/lib/letters/overlap';
import { buildValues, mergeTemplate } from '@/lib/letters/render';
import type { SpecificityInput } from '@/lib/letters/specificity';
import { COURTESY_WORDS, letterTerms, reasonLinesFrom, REWORDABLE, rewordingIssue, tailorGoal, tailorIssue, tailorSafely, toneIssue, toneWordIssue } from '@/lib/letters/tailor';
import { ALL_TEMPLATES, templateByKey } from '@/lib/letters/templates';

// ---------------------------------------------------------------- one client's file, and the letter drafted from it
const CLIENT_ID = '11111111-1111-4111-8111-111111111111';
const REASON = 'Experian reports a balance of $1,200.00. My January 2026 statement shows a balance of $900.00. I closed this card when I moved.';
const RECORD: BriefRecord = {
  today: '2026-11-19', tz: 'America/New_York',
  client: { id: CLIENT_ID, full_name: 'Jordan Rivera', address: { line1: '123 Main St', line2: 'Unit B', city: 'Tampa', state: 'FL', zip: '33602' }, ssn_last4: '4321', dob: '1985-03-03', bankruptcy_chapter: null, bankruptcy_filed_on: null, bankruptcy_discharged_on: null },
  dispute: {
    id: 'd-1', item_label: 'Acme Bank ••1234 (Experian)', target_type: 'bureau', bureau: 'experian', recipient_name: 'Experian', recipient_address: null, category: 'incorrect_balance', workflow: 'standard', reason: REASON, fields: ['Balance'],
    round: 2, status: 'draft', submitted_at: null, response_at: null, due_at: null, outcome: null, client_confirmed_accurate: false, agency: null, agency_item: null, tradeline_id: 't-1', sent_on: null,
  },
  tradeline: { creditor_name: 'Acme Bank', original_creditor: null, account_last4: '1234', bureau: 'experian', item_type: 'tradeline', account_status: 'Open', payment_status: 'Current', payment_history: 'CCCC', balance_cents: 120000, date_opened: '2019-03-03', date_of_first_delinquency: null, report_date: '2026-10-30', report_status: 'approved' },
  prior: { round: 1, submitted_at: '2026-08-04T15:00:00Z', sent_on: '2026-08-03', response_at: '2026-09-01T16:00:00Z', outcome: 'verified' },
  finding: null, evidence: ['January 2026 statement', 'Letter from my landlord'], identityDocs: [{ key: 'id', label: 'Government-issued photo ID' }, { key: 'proof_of_address', label: 'Proof of current address' }],
  identityTheftReports: [], notices: [], letters: [],
};
const letterFor = (r: BriefRecord) => {
  const brief = buildBrief(r, { now: new Date('2026-11-19T12:00:00Z'), includeSsnLast4: true });
  const tpl = templateByKey(disputeLetterKey(brief)!)!;
  const body = mergeTemplate(tpl.body, buildValues(contextFor(brief, tpl)));
  const protectedTerms = letterTerms({
    clientName: r.client.full_name, address: r.client.address, body,
    names: [r.dispute!.recipient_name, r.tradeline!.creditor_name, r.dispute!.item_label], facts: [r.dispute!.reason, r.tradeline!.account_status, r.tradeline!.payment_status],
  });
  const specificity: Omit<SpecificityInput, 'body'> = { category: r.dispute!.category, reason: r.dispute!.reason, fields: r.dispute!.fields, account: { name: r.tradeline!.creditor_name, reference: r.tradeline!.account_last4 } };
  return { body, input: { protectedTerms, seed: brief.seed, specificity }, brief };
};
const { body: LETTER, input: INPUT, brief: BRIEF } = letterFor(RECORD);
const VOICE = voiceFor(BRIEF.seed);
const COURTESY = [VOICE.contact, VOICE.thanks].filter(Boolean).join(' ');

/** A stand-in for the model: it sees exactly what a provider would be sent, and answers with `fn(masked template)`. */
const fake = (fn: (masked: string) => string | Error): AiProvider & { seen: AiRequest[] } => {
  const seen: AiRequest[] = [];
  return { name: 'fake', seen, complete: async (r) => { seen.push(r); const out = fn(/<source>\n([\s\S]*)\n<\/source>/.exec(r.user)![1]!); if (out instanceof Error) throw out; return out; } };
};
/** Rewords the connective wording only, and puts the closing sentences in another order. */
const reword = (m: string) => m
  .replace('To whom it may concern:', 'Dear Sir or Madam:')
  .replace(VOICE.leadIn, 'I set out the particulars here.')
  .replace(COURTESY, 'Many thanks for reading this. I can be reached by mail at the address above.')
  .replace('Sincerely,', 'Respectfully,');

describe('AI tailoring: the wording changes, the facts cannot', () => {
  it('the drafted letter has connective wording for the model to work with', () => {
    expect(VOICE.leadIn).not.toBe('');
    expect(LETTER).toContain(COURTESY);
    expect(editableWording(LETTER, INPUT.protectedTerms).split('\n')).toEqual(['To whom it may concern:', VOICE.leadIn, COURTESY, 'Sincerely,']);
  });

  it('keeps every locked fact: each protected passage comes back verbatim, in place', async () => {
    const ai = fake(reword);
    const r = await tailorSafely(LETTER, INPUT, ai);
    expect(r).toMatchObject({ usedAi: true, provider: 'fake' });
    expect(r.text).not.toBe(LETTER);
    for (const want of ['Dear Sir or Madam:', 'I set out the particulars here.', 'Many thanks for reading this. I can be reached by mail at the address above.', 'Respectfully,']) expect(r.text).toContain(want);
    // Every protected passage of the original is in the result, unchanged and in the same order.
    const before = protect(LETTER, INPUT.protectedTerms).locked;
    expect(before.length).toBeGreaterThan(20);
    expect(protect(r.text, INPUT.protectedTerms).locked).toEqual(before);
    expect(sameProtectedContent(LETTER, r.text, INPUT.protectedTerms)).toBe(true);
    // The only lines that differ are the four lines of connective wording.
    const changed = LETTER.split('\n').filter((l) => l.trim() && !r.text.split('\n').includes(l));
    expect(changed).toEqual(['To whom it may concern:', expect.stringContaining(VOICE.leadIn), COURTESY, 'Sincerely,']);
    for (const fact of ['Jordan Rivera', '123 Main St, Unit B', 'Tampa, FL 33602', 'Date of birth: March 3, 1985', 'SSN (last 4): 4321', 'Item: Acme Bank, account ending 1234', 'date opened March 3, 2019; balance $1,200.00', REASON, 'I previously disputed this item on August 3, 2026.',
      'which I received on September 1, 2026, stated that the information was verified.', 'January 2026 statement; Letter from my landlord', '  - Copy: Government-issued photo ID', 'Section 611 of the Fair Credit Reporting Act (15 U.S.C. § 1681i)',
      'Please conduct a reasonable reinvestigation of the balance reported for this account']) expect(r.text, fact).toContain(fact);
    expect(findBlockedClaims(r.text)).toEqual([]);
    expect(ai.seen).toHaveLength(1);
  });

  it('is discarded on any fact change: a marker dropped, repeated, reordered, moved or invented, or a fact written into the wording', async () => {
    const cases: [string, (m: string) => string][] = [
      ['a protected passage dropped', (m) => reword(m).replace('[[LOCKED_9]]', '')],
      ['a protected passage repeated', (m) => reword(m).replace('[[LOCKED_9]]', '[[LOCKED_9]] [[LOCKED_9]]')],
      ['two protected passages swapped', (m) => reword(m).replace('[[LOCKED_9]]', '[[LOCKED_X]]').replace('[[LOCKED_10]]', '[[LOCKED_9]]').replace('[[LOCKED_X]]', '[[LOCKED_10]]')],
      ['a protected passage moved to another line', (m) => reword(m).replace('[[LOCKED_9]]', '').replace('Dear Sir or Madam:', 'Dear Sir or Madam: [[LOCKED_9]]')],
      ['a marker invented', (m) => `${reword(m)}\n[[LOCKED_99]]`],
      ['an amount written into the wording', (m) => reword(m).replace('Respectfully,', 'The correct balance is $450.00.\nRespectfully,')],
      ['a date written into the wording', (m) => reword(m).replace('Respectfully,', 'I wrote to you on March 3.\nRespectfully,')],
      ['the creditor named in the wording', (m) => reword(m).replace('Respectfully,', 'Acme Bank made an error.\nRespectfully,')],
      ['another bureau named in the wording', (m) => reword(m).replace('Respectfully,', 'TransUnion already agreed with me.\nRespectfully,')],
      ['a dispute statement written into the wording', (m) => reword(m).replace('Respectfully,', 'This account is not mine.\nRespectfully,')],
      ['a prohibited claim', (m) => reword(m).replace('Respectfully,', 'We guarantee this will be fixed.\nRespectfully,')],
    ];
    for (const [name, mutate] of cases) {
      const ai = fake(mutate);
      const r = await tailorSafely(LETTER, INPUT, ai);
      expect(r, name).toMatchObject({ usedAi: false, text: LETTER });
      expect(r.note, name).toMatch(/discarded/);
      expect(ai.seen, name).toHaveLength(1);
    }
  });

  it('is discarded when the wording turns into a demand, a threat, a deadline, a promise or a new request', async () => {
    const lines: [string, RegExp][] = [
      ['I insist on a reply.', /demand/], ['Otherwise I will speak to an attorney.', /threat/], ['I expect to hear from you immediately.', /deadline/],
      ['I know this will be fixed soon.', /promises or predicts/], ['I am sure this will be resolved in my favor.', /promises or predicts/], ['Kindly wipe this from my file.', /taken off/], ['What you did was unlawful.', /accusation/],
      ['You are required to answer me.', /demand/], ['The statute entitles me to an answer.', /legal claim/],
      ['Please also send me a new copy of everything you hold.', /did not ask for/],
    ];
    for (const [line, why] of lines) {
      const r = await tailorSafely(LETTER, INPUT, fake((m) => reword(m).replace('Respectfully,', `${line}\nRespectfully,`)));
      expect(r, line).toMatchObject({ usedAi: false, text: LETTER });
      expect(r.note, line).toMatch(why);
    }
    expect(toneWordIssue('Thank you for your time and attention.')).toBeNull();
    expect(toneIssue('Please write to me at the address above.', 'Please write to me at the address above. Thank you.')).toBeNull();
    // An invitation to write back is courtesy, however it is put; a request about the file is not.
    expect(toneIssue('You can reach me by mail at the address above.', 'Please feel free to contact me by mail at the address above.')).toBeNull();
    expect(toneIssue('Thank you.', 'Thank you. Please do not hesitate to write to me.')).toBeNull();
    expect(toneIssue('Thank you.', 'Thank you. Kindly contact me at the address above should you need more.')).toBeNull();
    expect(toneIssue('Thank you.', 'Thank you for your prompt attention. I look forward to hearing from you at your convenience.')).toBeNull();
    expect(toneIssue('Thank you.', 'Thank you. Please update my file.')).toMatch(/did not ask for/);
    expect(toneIssue('Thank you.', 'Thank you. Kindly look at this again.')).toMatch(/did not ask for/);
  });

  it('does not call the model for a letter it could not make acceptable, or when there is nothing to reword', async () => {
    const ai = fake(reword);
    // A stock reason: the letter fails the specificity check, and rewording cannot add the client's facts.
    const vague = letterFor({ ...RECORD, dispute: { ...RECORD.dispute!, reason: 'Please verify this item.' } });
    const r = await tailorSafely(vague.body, vague.input, ai);
    expect(r).toMatchObject({ usedAi: false, text: vague.body });
    expect(r.note).toMatch(/cannot add what the letter is missing\. Give a concrete reason/);
    const claim = await tailorSafely(`${LETTER}\nWe guarantee this account will be deleted.`, INPUT, ai);
    expect(claim.note).toMatch(/prohibited claim/);
    const threat = await tailorSafely(LETTER.replace('Sincerely,', 'Otherwise I will take this further.\nSincerely,'), INPUT, ai);
    expect(threat.note).toMatch(/Reword that sentence first/);
    expect(await tailorSafely(LETTER, INPUT, null)).toEqual({ text: LETTER, usedAi: false, provider: 'rules' });
    expect(ai.seen).toEqual([]);
    // Unchanged wording, or a failing provider, is not a result either.
    expect(await tailorSafely(LETTER, INPUT, fake((m) => m))).toMatchObject({ usedAi: false, text: LETTER });
    expect(await tailorSafely(LETTER, INPUT, fake(() => new Error('HTTP 500')))).toMatchObject({ usedAi: false, text: LETTER });
  });

  it('the server-side re-check before saving refuses a suggestion that changes a fact, whatever the browser sends', () => {
    expect(tailorIssue(LETTER, reword(LETTER), INPUT)).toBeNull();
    expect(tailorIssue(LETTER, LETTER.replace('$1,200.00', '$1,000.00'), INPUT)).toMatch(/name, amount, date or dispute statement/);
    expect(tailorIssue(LETTER, LETTER.replace('I closed this card when I moved.', 'I never had this card.'), INPUT)).toMatch(/name, amount, date or dispute statement/);
    expect(tailorIssue(LETTER, LETTER.replace('  - Letter from my landlord\n', ''), INPUT)).toMatch(/name, amount, date or dispute statement/);
    expect(tailorIssue(LETTER, LETTER.replace('Sincerely,', 'You must answer.\nSincerely,'), INPUT)).toMatch(/demand/);
  });
});

describe('AI tailoring: a rewording cannot add anything', () => {
  // What a model produced in review when asked to make the letter "one person's own writing": sentences nobody recorded.
  const INVENTED = [
    'I have been a loyal customer for many years and have always paid on time, so I am writing to ask for your consideration.',
    'I lost my job last spring and my family has been struggling since.',
    'I know I fell behind on what I owed for a while.',
    'I have already spoken with your office by phone several times and was told this would be fixed.',
    'Thank you for your patience during what has been a very stressful time for my family.',
  ];
  const discarded = async (mutate: (m: string) => string) => { const ai = fake(mutate); const r = await tailorSafely(LETTER, INPUT, ai); expect(ai.seen).toHaveLength(1); return r; };

  it('is discarded, and nothing is charged, when a sentence is added: on a new line, at the end of a line, or in place of a courtesy line', async () => {
    for (const line of INVENTED) {
      const asNewLine = await discarded((m) => reword(m).replace('Respectfully,', `${line}\nRespectfully,`));
      expect(asNewLine, line).toMatchObject({ usedAi: false, text: LETTER });
      expect(asNewLine.note, line).toMatch(/discarded: it adds or removes a line/);
      const atLineEnd = await discarded((m) => m.replace(COURTESY, `${COURTESY} ${line}`));
      expect(atLineEnd, line).toMatchObject({ usedAi: false, text: LETTER });
      expect(atLineEnd.note, line).toMatch(/discarded: it adds a sentence the letter did not have/);
      const inPlace = await discarded((m) => m.replace(VOICE.leadIn, line));
      expect(inPlace, line).toMatchObject({ usedAi: false, text: LETTER });
      expect(inPlace.note, line).toMatch(/discarded: it (makes a line much longer than it was|uses wording that is not plain courtesy|adds a sentence)/);
      // The same check runs on the server before a suggestion is saved, whatever the browser sends.
      expect(tailorIssue(LETTER, LETTER.replace(VOICE.leadIn, line), INPUT), line).not.toBeNull();
      expect(tailorIssue(LETTER, LETTER.replace('Sincerely,', `${line}\nSincerely,`), INPUT), line).not.toBeNull();
    }
  });

  it('is discarded when a courtesy line becomes a statement about the writer, however short', async () => {
    const short: [string, RegExp][] = [
      ['I lost my job last spring.', /“lost”/], ['I know I fell behind.', /“fell”/], ['I spoke with your office by phone.', /“spoke”/], ['My family is struggling.', /“family”/],
      ['I am a loyal customer.', /“loyal”/], ['I wrote to you once before.', /“wrote”/], ['I have your letter here.', /“have”/], ['Your reply did not help me.', /“reply”/],
      // Made of everyday words only, and still a statement about the writer or a complaint about the reader.
      ['I am not well.', /“not”/], ['I am out of work.', /“work”/], ['I am not happy with your help.', /“not”/], ['Time is short for me.', /“short”/], ['You should look at this.', /“should”/], ['You will hear from me.', /“will”/],
    ];
    for (const [line, word] of short) {
      const r = await discarded((m) => m.replace(VOICE.leadIn, line));
      expect(r, line).toMatchObject({ usedAi: false, text: LETTER });
      expect(r.note, line).toMatch(/not plain courtesy/);
      expect(r.note, line).toMatch(word);
    }
  });

  it('is discarded when a courtesy line thanks the reader for contact nobody recorded, although every word of it is a courtesy word', async () => {
    for (const line of ['Thank you for writing to me.', 'Thank you for contacting me.', 'Thanks for reaching out to me.', 'It is good to hear from you.', 'I appreciate hearing from you.', 'I am glad you could get in touch; thank you for letting me know.', 'Thank you for your reply.', 'Thank you for your letter.']) {
      const r = await discarded((m) => m.replace(COURTESY, line));
      expect(r, line).toMatchObject({ usedAi: false, text: LETTER });
      expect(r.note, line).toMatch(/discarded: it (refers to earlier contact that is not on file|uses wording that is not plain courtesy)/);
      expect(tailorIssue(LETTER, LETTER.replace(COURTESY, line), INPUT), line).not.toBeNull();
    }
    // The courtesy that looks ahead is still fine, and so is the one negative a courtesy line uses.
    for (const fine of ['I look forward to hearing from you.', 'Please do not hesitate to write to me at the address above.', 'Please don’t hesitate to contact me. Thank you for your time.', 'You can reach me by post at the address above. Many thanks.']) {
      expect(rewordingIssue(LETTER, LETTER.replace(COURTESY, fine), INPUT.protectedTerms), fine).toBeNull();
      expect(toneIssue(COURTESY, fine), fine).toBeNull();
    }
  });

  it('accepts a like-for-like rewording, and one that leaves a courtesy line out', () => {
    const terms = INPUT.protectedTerms;
    expect(rewordingIssue(LETTER, reword(LETTER), terms)).toBeNull();
    expect(rewordingIssue(LETTER, LETTER.replace(` ${VOICE.leadIn}`, ''), terms)).toBeNull();
    expect(rewordingIssue(LETTER, LETTER.replace('Sincerely,', 'Respectfully yours,'), terms)).toBeNull();
    expect(rewordingIssue(LETTER, LETTER.replace('Sincerely,', 'With all my hope that you can help me soon,'), terms)).toMatch(/much longer|not plain courtesy/);
    expect(rewordingIssue(LETTER, `${LETTER}\nThank you.`, terms)).toMatch(/adds or removes a line/);
    // Wording where the letter had none: a sentence after a locked one.
    expect(LETTER).toContain('Specific information I am asking you to review: Balance.\n');
    expect(rewordingIssue(LETTER, LETTER.replace('to review: Balance.\n', 'to review: Balance. Thank you.\n'), terms)).toMatch(/adds wording where the letter had none/);
  });

  it('every sentence the model may see is made of courtesy words, so a rewording has the same vocabulary to work with', () => {
    const outside = new Set<string>();
    for (const line of REWORDABLE) for (const w of line.toLowerCase().split(/[^a-z']+/).filter(Boolean)) if (!COURTESY_WORDS.has(w)) outside.add(w);
    // "have" and "letter" are in two of the app's own lines; a rewording may keep them on those lines and use them nowhere else.
    expect([...outside].sort()).toEqual(['have', 'letter']);
    // Nothing in the vocabulary can carry a fact about a person, an account, money, time or earlier contact.
    for (const w of ['paid', 'customer', 'years', 'family', 'job', 'work', 'lost', 'well', 'ill', 'phone', 'called', 'spoke', 'told', 'already', 'before', 'again', 'have', 'has', 'had', 'was', 'were', 'been', 'received', 'reply', 'response', 'letter',
      'will', 'should', 'must', 'not', 'no', 'never', 'nothing', 'soon', 'short', 'today', 'balance', 'account']) {
      expect(COURTESY_WORDS.has(w), w).toBe(false);
    }
    expect(tailorGoal(7)).toMatch(/Add nothing about the writer, their circumstances, the matter, any earlier contact or what should happen next/);
    expect(tailorGoal(7)).not.toMatch(/one person’s own writing|form letter|merge, split or reorder/);
  });
});

describe('AI tailoring: every line of the letter is locked by position', () => {
  /** A drafted letter with the protected terms the tailoring step builds for it (src/lib/letters/tailor-load.ts). */
  const drafted = (r: BriefRecord, key?: string, recipientAddress?: string) => {
    const brief = buildBrief(r, { now: new Date('2026-11-19T12:00:00Z'), recipientAddress });
    const tpl = templateByKey(key ?? disputeLetterKey(brief)!)!;
    const body = mergeTemplate(tpl.body, buildValues(contextFor(brief, tpl)));
    return { body, voice: voiceFor(brief.seed), input: { protectedTerms: letterTerms({ clientName: r.client.full_name, address: r.client.address, body, templateBody: tpl.body, names: [r.dispute!.recipient_name, r.dispute!.item_label] }), seed: brief.seed } };
  };
  const history = drafted({ ...RECORD, dispute: { ...RECORD.dispute!, category: 'incorrect_payment_history', fields: ['Payment history', 'Dates'], round: 1 }, prior: null });
  const chex = drafted({ ...RECORD, dispute: { ...RECORD.dispute!, target_type: 'agency', bureau: null, workflow: 'specialty', category: 'specialty_item', agency: 'chexsystems', agency_item: { name: 'First Coast Bank', reference: 'xxxx4321', amount: '$312.40' }, recipient_name: 'Chex Systems, Inc.', item_label: 'First Coast Bank · xxxx4321 (ChexSystems)', fields: [], round: 1, tradeline_id: null, reason: 'The disclosure lists an unpaid balance of $312.40. My bank statement dated 04/02/2024 shows the account was paid in full.' }, tradeline: null, prior: null });
  const validation = drafted({ ...RECORD, dispute: { ...RECORD.dispute!, target_type: 'collector', bureau: null, workflow: 'validation', category: 'unverifiable_collection', recipient_name: 'Northstar Recovery', item_label: 'Northstar Recovery ••5521', fields: [], round: 1, tradeline_id: null, reason: 'The notice states a balance of $640.00. I do not recognize this amount.' }, tradeline: null, prior: null, identityDocs: [], evidence: [] }, undefined, 'PO Box 9, Anytown, ST 00000');
  const CASES: [string, { body: string; voice: ReturnType<typeof voiceFor>; input: { protectedTerms: string[]; seed: number } }, string[]][] = [
    ['fields with no lock word', history, ['Specific information I am asking you to review: Payment history, Dates.']],
    ['a ChexSystems letter', chex, ['Attn: Consumer Relations', 'The item, as it appears on my disclosure:', 'What I believe is inaccurate, incomplete or unverifiable, and why:']],
    ['a validation letter with no notice on file', validation, ['I am writing about the debt referenced above. I dispute this debt and ask that you provide validation of it, including:']],
  ];

  it('lines the standing vocabulary rules would have left open are never sent, and cannot be reworded or dropped', async () => {
    for (const [name, letter, lines] of CASES) {
      for (const line of lines) {
        expect(letter.body, `${name}: ${line}`).toContain(line);
        // Changing it or deleting it is refused before anything is saved.
        expect(tailorIssue(letter.body, letter.body.replace(line, 'I would like everything about this entry looked at again.'), letter.input), `${name}: ${line}`).toMatch(/name, amount, date or dispute statement would change/);
        expect(tailorIssue(letter.body, letter.body.replace(`${line}\n`, ''), letter.input), `${name}: ${line}`).toMatch(/name, amount, date or dispute statement would change/);
      }
      // And the model is sent none of it: only this client's voice lines, the salutation and the sign-off.
      const ai = fake((m) => m.replace('Sincerely,', 'Respectfully,'));
      const r = await tailorSafely(letter.body, letter.input, ai);
      expect(r.usedAi, name).toBe(true);
      const sent = /<source>\n([\s\S]*)\n<\/source>/.exec(ai.seen[0]!.user)![1]!.replace(/\[\[LOCKED_\d+\]\]/g, '').split('\n').map((l) => l.trim()).filter(Boolean);
      for (const s of sent.flatMap((l) => l.split(/(?<=[.!?])\s+/))) expect(REWORDABLE.has(s), `${name}: “${s}” was sent`).toBe(true);
      for (const line of lines) expect(ai.seen[0]!.user, `${name}: ${line}`).not.toContain(line.slice(0, 24));
    }
  });

  it('the standing rules alone would have let those lines through', () => {
    for (const line of ['Specific information I am asking you to review: Payment history, Dates.', 'Attn: Consumer Relations', 'Attn: Consumer Services', 'I understand that this is a courtesy and that the decision is yours.']) {
      expect(protect(line).locked, line).toEqual([]);
    }
  });
});

describe('what reaches the provider', () => {
  it('nothing personal: only the connective wording, the markers and a voice made of fixed phrases', async () => {
    const ai = fake(reword);
    await tailorSafely(LETTER, INPUT, ai);
    const { system, user } = ai.seen[0]!;
    const prompt = `${system}\n${user}`;
    // No name, address, identifier, account, creditor, bureau, amount, date, reason, document or history from the file.
    for (const secret of ['Jordan', 'Rivera', '123 Main', 'Unit B', 'Tampa', 'FL', '33602', '4321', '1985', 'birth', 'Acme', '1234', 'Experian', '1,200', '900', 'January', 'March', 'August', 'September', '2026', '2019',
      'statement', 'landlord', 'closed this card', 'when I moved', 'photo ID', 'Proof of current address', 'verified', 'Balance', CLIENT_ID, String(BRIEF.seed)]) {
      expect(prompt, secret).not.toContain(secret);
    }
    expect(prompt.replace(/\[\[LOCKED_\d+\]\]/g, '')).not.toMatch(/\$|§|\d/); // no amount, citation or number: the only digits are the marker numbers
    // What it was sent is exactly the masked template: markers plus the four lines of connective wording.
    const source = /<source>\n([\s\S]*)\n<\/source>/.exec(user)![1]!;
    expect(source).toBe(protect(LETTER, INPUT.protectedTerms).masked);
    expect(source.replace(/\[\[LOCKED_\d+\]\]/g, '').split('\n').map((l) => l.trim()).filter(Boolean)).toEqual(['To whom it may concern:', VOICE.leadIn, COURTESY, 'Sincerely,']);
    // The instruction carries the client's voice and nothing else about them.
    expect(user.startsWith(`Goal: ${tailorGoal(BRIEF.seed)}\n\n<source>\n`)).toBe(true);
    expect(tailorGoal(BRIEF.seed)).toContain(`Voice: ${VOICE.tone}. ${VOICE.habit}`);
    expect(tailorGoal(BRIEF.seed)).not.toMatch(/\d/);
  });

  it('the same client always gets the same voice; other clients get others', () => {
    expect(tailorGoal(styleSeed(CLIENT_ID))).toBe(tailorGoal(styleSeed(CLIENT_ID)));
    const goals = new Set(Array.from({ length: 40 }, (_, i) => tailorGoal(styleSeed(`client-${i}`))));
    expect(goals.size).toBeGreaterThanOrEqual(10);
    expect(tailorGoal()).toContain('Voice: clear, courteous and concise.');
  });

  it('locks the reason sentence by sentence, the address, every enclosure line and every reported status', () => {
    const terms = letterTerms({ clientName: 'Jordan Rivera', address: { line1: '123 Main St', city: 'Tampa' }, names: ['Experian', null, 'Acme Bank'], facts: ['First sentence here. Second one "quoted." Third one.', 'Paid. Closed'],
      body: 'Reason for my request:\nA line edited in the letter\nand continued here.\n\nPlease conduct a review.\n\nEnclosures:\n  - Bank statement\n  1. Numbered item\n' });
    for (const t of ['Jordan Rivera', 'Jordan', 'Rivera', '123 Main St', 'Tampa', 'Experian', 'Acme Bank', 'First sentence here.', 'Second one "quoted."', 'Third one.', 'Paid.', 'Closed', 'Bank statement', 'Numbered item', 'A line edited in the letter', 'and continued here.']) expect(terms, t).toContain(t);
    // A sentence of the reason with no number and no dispute word is still hidden from the model.
    expect(protect('I closed this card when I moved.').locked).toEqual([]);
    expect(protect(LETTER, INPUT.protectedTerms).masked).not.toContain('closed this card');
  });
});

describe('a reason that is stored nowhere but in the letter', () => {
  // A standalone letter, or a reason typed over the dispute's: sentences with no number and no dispute word, which the
  // standing rules alone would leave editable. They are a person's own account of what happened, so they are locked.
  const STORY = ['My mother was ill last spring and I was away from home for many weeks.', 'I came back and caught up as soon as I could. We have been customers for a long time.'];
  const paragraphs = { lead_in: ' The details follow.', courtesy: 'You can reach me by mail at the address above. Thank you for your time and attention.', enclosed_text: 'I have enclosed the following document: A note from my employer.' };
  const withReason = ALL_TEMPLATES.filter((t) => t.body.includes('{{reason}}'));

  it('is locked wherever the template puts it, with or without a heading', () => {
    expect(withReason.length).toBeGreaterThanOrEqual(20);
    for (const line of STORY) expect(protect(line).locked, line).toEqual([]); // the standing rules would have let these through
    for (const t of withReason) {
      const values = { ...buildValues({ client: RECORD.client, now: new Date('2026-11-19T12:00:00Z'), recipientAddress: 'PO Box 1, Anytown, ST 00000', enclosures: ['A note from my employer'], paragraphs }), reason: STORY.join('\n'), recipient_name: 'Acme Bank', item_label: 'Acme Bank ••1234' };
      const body = mergeTemplate(t.body, values);
      expect(reasonLinesFrom(t.body, body), t.key).toEqual(STORY);
      const wording = editableWording(body, letterTerms({ clientName: 'Jordan Rivera', address: RECORD.client.address, names: ['Acme Bank'], body, templateBody: t.body }));
      expect(wording, t.key).not.toMatch(/mother|ill last spring|away from home|caught up|customers/);
      // The courtesy line is still there to reword where the template has one.
      if (t.body.includes('{{courtesy}}')) expect(wording, t.key).toContain('Thank you for your time and attention.');
    }
  });

  it('never reaches the provider from a standalone letter: every line a person typed is locked, wherever it sits', async () => {
    // A goodwill letter has no linking or closing line of this app's own, so there is nothing to reword and the model is not called.
    const g = templateByKey('goodwill_en')!;
    const goodwill = mergeTemplate(g.body, { ...buildValues({ client: RECORD.client, now: new Date('2026-11-19T12:00:00Z'), recipientAddress: 'PO Box 1, Anytown, ST 00000' }), reason: STORY.join(' '), recipient_name: 'Acme Bank', item_label: 'Acme Bank ••1234' })
      .replace('Sincerely,', 'With my thanks for reading this far, and with best wishes to you all.\nSincerely,');
    const idle = fake((m) => m);
    const none = await tailorSafely(goodwill, { protectedTerms: letterTerms({ clientName: 'Jordan Rivera', address: RECORD.client.address, names: ['Acme Bank'], body: goodwill, templateBody: g.body }), seed: 7 }, idle);
    expect(none).toMatchObject({ usedAi: false, text: goodwill });
    expect(none.note).toMatch(/too little connective wording to reword/);
    expect(idle.seen).toEqual([]);
    // A standalone letter to the creditor carries the courtesy lines: those are reworded, and the story and the line a
    // person typed above the sign-off never leave the server.
    const t = templateByKey('creditor_dispute_en')!;
    const typed = 'With my thanks for reading this far, and with best wishes to you all.';
    const body = mergeTemplate(t.body, { ...buildValues({ client: RECORD.client, now: new Date('2026-11-19T12:00:00Z'), recipientAddress: 'PO Box 1, Anytown, ST 00000', paragraphs }), reason: STORY.join(' '), recipient_name: 'Acme Bank', item_label: 'Acme Bank ••1234' })
      .replace('Sincerely,', `${typed}\nSincerely,`);
    const protectedTerms = letterTerms({ clientName: 'Jordan Rivera', address: RECORD.client.address, names: ['Acme Bank'], body, templateBody: t.body });
    const ai = fake((m) => m.replace('You can reach me by mail at the address above. Thank you for your time and attention.', 'I can be reached by mail at the address above. Many thanks for your time.'));
    const r = await tailorSafely(body, { protectedTerms, seed: 7 }, ai);
    expect(r.usedAi).toBe(true);
    for (const line of [...STORY, typed]) expect(r.text).toContain(line);
    expect(r.text).toContain('I can be reached by mail at the address above. Many thanks for your time.');
    expect(ai.seen[0]!.user).not.toMatch(/mother|ill last spring|away from home|caught up|customers|best wishes|reading this far|Jordan|Acme|Tampa/);
    // The standing vocabulary rules alone would have sent both: neither has a number or a dispute word.
    expect(protect(body, ['Jordan Rivera', 'Acme Bank']).masked).toMatch(/mother was ill/);
    expect(protect(typed).locked).toEqual([]);
  });

  it('falls back to nothing when the letter no longer has the line above the reason', () => {
    const t = templateByKey('goodwill_en')!;
    expect(reasonLinesFrom(t.body, 'A letter rewritten from scratch.\n\nSincerely,')).toEqual([]);
    expect(reasonLinesFrom(templateByKey('method_of_verification_en')!.body, 'anything')).toEqual([]);
  });
});

describe('wording overlap with other recent letters', () => {
  /** A letter as the overlap score reads it: this client's names, reason and numbers out, the standard paragraphs in. */
  const comparable = (x: { body: string }, r: BriefRecord) => comparableWording(x.body, {
    lines: r.dispute!.reason.split('\n'), names: [r.client.full_name, ...r.client.full_name.split(' '), r.client.address.line1, r.client.address.line2, r.client.address.city, r.dispute!.recipient_name, r.tradeline!.creditor_name, r.dispute!.item_label],
  });
  const otherRecord = (id: string, name: string): BriefRecord => ({ ...RECORD, client: { ...RECORD.client, id, full_name: name, address: { line1: '9 Pine Ave', city: 'Seattle', state: 'WA', zip: '98101' } }, dispute: { ...RECORD.dispute!, item_label: 'Harbor Credit Union ••7788 (Experian)', reason: 'Experian reports a balance of $640.50. My payoff letter shows $0.00.' }, tradeline: { ...RECORD.tradeline!, creditor_name: 'Harbor Credit Union', account_last4: '7788' }, evidence: ['Payoff letter'] });
  const other = (id: string, name: string) => { const r = otherRecord(id, name); return comparable(letterFor(r), r); };
  const mine = comparable({ body: LETTER }, RECORD);

  it('compares the whole letter with the client’s own facts taken out: the standard paragraphs count, the facts do not', () => {
    // The opening that cites the right, the request and the enclosure sentence are all compared.
    expect(mine).toContain('I am writing under Section');
    expect(mine).toContain('Please conduct a reasonable reinvestigation of the balance reported for this account');
    expect(mine).toContain('Reason for my request:');
    // The heading block, the signature, the names, the reason, the enclosure list and every number are not.
    expect(mine).not.toMatch(/Jordan|Rivera|Tampa|Main St|Unit B|Acme|Experian|closed this card|statement shows|Copy:|\d|Sincerely/);
    expect(mine.split('\n')[0]).toMatch(/^Re: Further dispute with new information|^Re: /);
    // About seven times the wording the old score read (the salutation, one linking line and the closing lines).
    expect(shingles(mine).size).toBeGreaterThan(5 * shingles(editableWording(LETTER, INPUT.protectedTerms)).size);
  });

  it('is high for two clients’ letters from the same template, however different their facts and their closing lines', () => {
    // Another client, another account, another reason, other documents and (for most seeds) another voice: same template.
    const scores = Array.from({ length: 12 }, (_, i) => wordingOverlap(mine, [other(`client-${i}`, `Person ${i}`)])!);
    for (const o of scores) {
      expect(o.level).toBe('high');
      expect(o.score).toBeGreaterThanOrEqual(OVERLAP_HIGH);
    }
    // Rewording the linking and closing lines does not make it a different letter: the score barely moves.
    const reworded = comparable({ body: reword(LETTER) }, RECORD);
    expect(wordingOverlap(reworded, [other('client-1', 'Person 1')])!.level).toBe('high');
    expect(wordingOverlap(mine, [mine])).toEqual({ level: 'high', score: 1, compared: 1 });
  });

  it('is lower for a letter of another kind, and low for one mostly in its own words', () => {
    const goodwillRecord: BriefRecord = { ...otherRecord('client-g', 'Sam Lee'), dispute: { ...otherRecord('client-g', 'Sam Lee').dispute!, target_type: 'furnisher', bureau: null, workflow: 'goodwill', category: 'goodwill', recipient_name: 'Harbor Credit Union', round: 1 }, prior: null };
    const g = buildBrief(goodwillRecord, { now: new Date('2026-11-19T12:00:00Z') });
    const goodwill = comparableWording(mergeTemplate(templateByKey('goodwill_en')!.body, buildValues(contextFor(g, templateByKey('goodwill_en')!))), { lines: goodwillRecord.dispute!.reason.split('\n'), names: ['Sam Lee', 'Sam', 'Lee', 'Harbor Credit Union'] });
    const vsGoodwill = wordingOverlap(mine, [goodwill])!;
    expect(vsGoodwill.level).toBe('low');
    const ownWords = 'Re: My account\nTo whom it may concern:\nI looked at my file last week and something on it surprised me, so I went back through my own paperwork before writing.\nWhat I found is set out in the pages I am sending with this letter, in the order the events happened.\nI would welcome a written answer once you have looked at them.';
    expect(wordingOverlap(comparableWording(ownWords), [mine])!.level).toBe('low');
    expect(wordingOverlap(mine, [goodwill, other('client-2', 'Person 2')])!.level).toBe('high'); // the closest of the others decides
    expect(OVERLAP_HIGH).toBeGreaterThan(OVERLAP_MEDIUM);
  });

  it('takes the closest of the other letters, and grades what is partly shared', () => {
    const first = (share: number) => mine.split(' ').slice(0, Math.ceil(mine.split(' ').length * share)).join(' '); // the start of the letter, word for word
    const nothingShared = 'Dear Sir or Madam:\nMy particulars are given here.\nWith many thanks for reading.\nRespectfully,';
    const third = wordingOverlap(mine, [nothingShared, first(0.35)])!;
    expect(third.compared).toBe(2);
    expect(third.score).toBeGreaterThan(OVERLAP_MEDIUM);
    expect(third.score).toBeLessThan(OVERLAP_HIGH);
    expect(third.level).toBe('medium'); // a quarter or more of the letter, and not most of it
    expect(wordingOverlap(mine, [nothingShared, first(0.65)])!.level).toBe('high'); // more than half
    expect(wordingOverlap(mine, [nothingShared, first(0.15)])!.level).toBe('low');
    expect(wordingOverlap(mine, [nothingShared])!.level).toBe('low');
    expect(wordingOverlap(mine, [nothingShared, mine, first(0.35)])!.level).toBe('high');
    // The words beside the badge are plain fractions: "most" is more than half, "part" a quarter or more.
    expect([OVERLAP_MEDIUM, OVERLAP_HIGH]).toEqual([0.25, 0.5]);
  });

  it('says nothing when there is nothing to compare', () => {
    expect(wordingOverlap(mine, [])).toBeNull();
    expect(wordingOverlap(mine, ['', ''])).toBeNull();
    expect(wordingOverlap('Sincerely,', [mine])).toBeNull(); // a letter with almost no wording of its own
    expect(comparableWording('')).toBe('');
    expect(editableWording('text with a [[LOCKED_1]] marker')).toBe('');
    expect([...shingles('Thank you for your time')]).toEqual(['thank you for', 'you for your', 'for your time']);
    expect([...shingles('Thank you')]).toEqual(['thank you']);
  });
});
