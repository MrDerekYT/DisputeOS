import { describe, expect, it } from 'vitest';
import { protect, sameProtectedContent } from '@/lib/ai/protected';
import type { AiProvider, AiRequest } from '@/lib/ai/provider';
import { findBlockedClaims } from '@/lib/compliance/claims';
import { buildBrief, contextFor, disputeLetterKey, styleSeed, voiceFor, type BriefRecord } from '@/lib/letters/brief';
import { comparableWording, editableWording, OVERLAP_HIGH, OVERLAP_MEDIUM, shingles, wordingOverlap } from '@/lib/letters/overlap';
import { buildValues, mergeTemplate } from '@/lib/letters/render';
import type { SpecificityInput } from '@/lib/letters/specificity';
import { BY_NAME, COURTESY_WORDS, letterTerms, POINTER_WORDS, reasonLinesFrom, REWORDABLE, rewordingIssue, SALUTATIONS, SIGN_OFFS, tailorGoal, tailorIssue, tailorSafely, toneIssue, toneWordIssue, type TailorInput } from '@/lib/letters/tailor';
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
const NEW_LEAD_IN = 'The particulars follow.';
const NEW_COURTESY = 'Many thanks for reading this. You can write to me at the address above.';
const reword = (m: string) => m
  .replace('To whom it may concern:', 'Dear Sir or Madam:')
  .replace(VOICE.leadIn, NEW_LEAD_IN)
  .replace(COURTESY, NEW_COURTESY)
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
    for (const want of ['Dear Sir or Madam:', NEW_LEAD_IN, NEW_COURTESY, 'Respectfully,']) expect(r.text).toContain(want);
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

describe('AI tailoring: what a rewording may not add', () => {
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
      ['I lost my job last spring.', /“lost”/], ['I know I fell behind.', /“know”/], ['I spoke with your office by phone.', /“spoke”/], ['My family is struggling.', /“my”/],
      ['I am a loyal customer.', /“am”/], ['I wrote to you once before.', /“wrote”/], ['I fell behind for a while.', /“fell”/], ['You did not help me.', /“did”/],
      // Made of everyday words only, and still a statement about the writer or a complaint about the reader.
      ['I am not well.', /“am”/], ['I can not help you.', /“not”/], ['I can find no work.', /“find”/], ['Time is short for me.', /“time”/], ['You should look at this.', /“should”/], ['You will hear from me.', /“will”/],
    ];
    for (const [line, word] of short) {
      const r = await discarded((m) => m.replace(VOICE.leadIn, line));
      expect(r, line).toMatchObject({ usedAi: false, text: LETTER });
      expect(r.note, line).toMatch(/not plain courtesy/);
      expect(r.note, line).toMatch(word);
      // The word check refuses it by itself, before any other rule is asked.
      expect(rewordingIssue(LETTER, LETTER.replace(VOICE.leadIn, line), INPUT.protectedTerms), line).toMatch(word);
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
    for (const fine of ['I look forward to hearing from you.', 'Please do not hesitate to write to me at the address above.', 'Please don’t hesitate to contact me. Thank you for your time.', 'You can write to me at the address above. Many thanks.']) {
      expect(rewordingIssue(LETTER, LETTER.replace(COURTESY, fine), INPUT.protectedTerms), fine).toBeNull();
      expect(toneIssue(COURTESY, fine), fine).toBeNull();
    }
  });

  it('accepts a like-for-like rewording, and one that leaves a courtesy line out', () => {
    const terms = INPUT.protectedTerms;
    expect(rewordingIssue(LETTER, reword(LETTER), terms)).toBeNull();
    expect(rewordingIssue(LETTER, LETTER.replace(` ${VOICE.leadIn}`, ''), terms)).toBeNull();
    expect(rewordingIssue(LETTER, LETTER.replace('Sincerely,', 'Yours sincerely,'), terms)).toBeNull();
    expect(rewordingIssue(LETTER, LETTER.replace('Sincerely,', 'With all my hope that you can help me soon,'), terms)).toMatch(/sign-off is missing or is not one of the standard ones/);
    expect(rewordingIssue(LETTER, `${LETTER}\nThank you.`, terms)).toMatch(/adds or removes a line/);
    // Wording where the letter had none: a sentence after a locked one.
    expect(LETTER).toContain('Specific information I am asking you to review: Balance.\n');
    expect(rewordingIssue(LETTER, LETTER.replace('to review: Balance.\n', 'to review: Balance. Thank you.\n'), terms)).toMatch(/adds wording where the letter had none/);
  });

  it('the word list has no word for what happened, was said, was sent or is someone’s; this app’s own lines keep theirs only while they are left alone', () => {
    // The voice lines use a few words a rewording may not: a sentence left exactly as it is keeps them, a changed one does not get them.
    const outside = new Set<string>();
    for (const line of REWORDABLE) if (!SALUTATIONS.has(line) && !SIGN_OFFS.has(line)) for (const w of BY_NAME.reduce((t, [, re, to]) => t.replace(re, to), line).toLowerCase().split(/[^a-z']+/).filter(Boolean)) if (!COURTESY_WORDS.has(w)) outside.add(w);
    expect([...outside].sort()).toEqual(['are', 'careful', 'from', 'further', 'have', 'letter', 'mail', 'need', 'out', 'review', 'set']);
    // The list has no word for a person's circumstances, an account, money, time that has passed, or an earlier letter or call.
    for (const w of ['paid', 'customer', 'years', 'family', 'job', 'work', 'lost', 'well', 'ill', 'phone', 'called', 'spoke', 'told', 'already', 'before', 'again', 'have', 'has', 'had', 'was', 'were', 'been', 'received', 'reply', 'response', 'letter',
      'will', 'should', 'must', 'not', 'no', 'never', 'nothing', 'soon', 'short', 'today', 'balance', 'account']) {
      expect(COURTESY_WORDS.has(w), w).toBe(false);
    }
    // Nor the usual words for saying that something is someone's, happened, was said or was sent, or for turning thanks into something else.
    for (const w of ['mine', 'my', 'yours', 'myself', 'is', 'are', 'am', 'be', 'reached', 'reaching', 'read', 'stated', 'explained', 'provided', 'described', 'shown', 'included', 'listed', 'laid', 'put', 'set', 'out', 'taking', 'care', 'careful',
      'want', 'need', 'wish', 'like', 'keep', 'keeping', 'mail', 'post', 'postal', 'via', 'available', 'know', 'let', 'get', 'touch', 'hear', 'hearing', 'see', 'find', 'look', 'review', 'feel', 'forward', 'further', 'following', 'from', 'time', 'more', 'questions', 'advance', 'facts', 'points', 'summary', 'outline',
      'appreciated', 'obliged', 'pleased', 'glad', 'happy', 'welcome', 'helpful', 'good', 'only', 'just', 'but', 'there', 'do', 'does', 'question', 'concern', 'concerning', 'address', 'hesitate', 'information',
      'dear', 'sir', 'madam', 'sincerely', 'regards', 'whom', "i'm", 'may', 'hope', 'might', 'could']) {
      expect(COURTESY_WORDS.has(w), w).toBe(false);
    }
    expect(tailorGoal(7)).toMatch(/Add nothing about the writer, their circumstances, the matter, any earlier contact or what should happen next/);
    expect(tailorGoal(7)).not.toMatch(/one person’s own writing|form letter|merge, split or reorder/);
    // The linking sentence has a part of the list to itself: the words that point to the details.
    expect([...POINTER_WORDS].filter((w) => !COURTESY_WORDS.has(w))).toEqual([]);
    expect([...POINTER_WORDS].sort()).toEqual(['a', 'as', 'below', 'details', 'follow', 'follows', 'here', 'matter', 'of', 'particulars', 'specifics', 'the', 'these', 'this', 'those']);
    // The model is told what the checks accept: the fixed salutations and sign-offs, the words for each kind of line and the phrases.
    const closingWords = [...COURTESY_WORDS].filter((w) => !['details', 'specifics', 'particulars'].includes(w)).join(' ');
    for (const fixed of [...SALUTATIONS, ...SIGN_OFFS, ...BY_NAME.map(([phrase]) => phrase), `rewrite it using only these words: ${[...POINTER_WORDS].join(' ')}.`, `rewrite it using only these words: ${closingWords};`]) expect(tailorGoal(7), fixed).toContain(fixed);
  });
});

describe('AI tailoring: a reworded line is checked on the model’s result and again before it is saved', () => {
  type Letter = { body: string; input: TailorInput };
  const MAIN: Letter = { body: LETTER, input: INPUT };
  /**
   * Both paths: what the model returns (tailorSafely: what is charged and, with the automatic setting, saved) and
   * what the browser sends back to be saved (tailorIssue, as the accept action runs it).
   */
  const refused = async (letter: Letter, from: string, to: string) => {
    expect(letter.body, from).toContain(from);
    const ai = fake((m) => m.replace(from, to));
    const r = await tailorSafely(letter.body, letter.input, ai);
    expect(ai.seen, to).toHaveLength(1);
    expect(r, to).toMatchObject({ usedAi: false, text: letter.body });
    expect(r.note, to).toMatch(/^AI rewrite discarded: /);
    const issue = tailorIssue(letter.body, letter.body.replace(from, to), letter.input);
    expect(issue, to).not.toBeNull();
    return { note: r.note!, issue: issue! };
  };
  const accepted = async (letter: Letter, from: string, to: string) => {
    expect(letter.body, from).toContain(from);
    const r = await tailorSafely(letter.body, letter.input, fake((m) => m.replace(from, to)));
    expect(r.note, to).toBeUndefined();
    expect(r, to).toMatchObject({ usedAi: true });
    expect(r.text, to).toContain(to);
    expect(tailorIssue(letter.body, letter.body.replace(from, to), letter.input), to).toBeNull();
  };
  /** A client whose linking sentence is the one that says "I have set out the details in this letter." */
  const haveLetter = (): Letter & { leadIn: string } => {
    for (let i = 0; i < 500; i++) {
      const id = `aaaaaaaa-aaaa-4aaa-8aaa-${String(i).padStart(12, '0')}`;
      if (voiceFor(styleSeed(id)).leadIn === 'I have set out the details in this letter.') { const l = letterFor({ ...RECORD, client: { ...RECORD.client, id } }); return { body: l.body, input: l.input, leadIn: voiceFor(l.brief.seed).leadIn }; }
    }
    throw new Error('no client with that linking sentence');
  };

  it('this client’s closing line has one “me”, and the linking sentence has none', () => {
    expect(COURTESY).toBe('You can reach me by mail at the address above. Thank you for your time and attention.');
    expect(VOICE.leadIn).toBe('Here are the details.');
  });

  it('refuses a statement made of everyday words: that something is the writer’s, happened, was said or was sent', async () => {
    // Every one of these was accepted, charged and (with the automatic setting) saved before the list was tightened.
    const statements = [
      'This is mine.', 'The information above is mine.', 'I am taking care of this matter.', 'I reached out to you by mail about this matter.', 'You stated this to me by mail.', 'I read your mail.',
      'I want all of this information out.', 'The details are in the mail to you.', 'I set all of this out to you by mail.',
      'I need more time.', 'I need time.', 'You reached me by mail.', 'As you explained by mail, this is mine.', 'You provided the details to me by mail.', 'I put all of this to you by mail.', 'I would like this information out.',
      'I hope to see this put out.', 'I can put more in the mail to you.', 'As you know, all of this is in the mail.', 'You know all about this matter.',
    ];
    for (const s of statements) {
      await refused(MAIN, COURTESY, s);
      await refused(MAIN, VOICE.leadIn, s);
      // The word list alone refuses it: no other rule is needed.
      expect(rewordingIssue(LETTER, LETTER.replace(COURTESY, s), INPUT.protectedTerms), s).toMatch(/^it uses wording that is not plain courtesy \(“\w+”\)$/);
    }
    // More of the same kind, built from what was on the list: ownership, earlier contact, a wish, a warning, a limit on how to write back.
    for (const s of ['The information above is my information.', 'This is your information.', 'The details are with you.', 'You are looking into this matter.', 'I hear that you can help.', 'I see that you are helping.',
      'I appreciated your help with this matter.', 'I write to you further about this matter.', 'Following your review, here are the details.', 'I forward the details to you.', 'I look into this matter.', 'I review this matter.',
      'I would like more information from you.', 'You need to review this matter.', 'You can keep this information.', 'Please write to me only at the address above.', 'Be careful with this matter.', 'You hesitate to help me.',
      'Please write to me in time.', 'I can be reached at the address above.']) {
      await refused(MAIN, COURTESY, s);
      expect(rewordingIssue(LETTER, LETTER.replace(COURTESY, s), INPUT.protectedTerms), s).toMatch(/not plain courtesy/);
    }
    // Ways of saying the reader wrote first that need no past tense. The first is made of listed words only, so the
    // word list lets it through and the tone rules are what refuse it.
    expect(rewordingIssue(LETTER, LETTER.replace(COURTESY, 'You write to me about this matter.'), INPUT.protectedTerms)).toBeNull();
    for (const s of ['You write to me about this matter.', 'As you contact me, here are the details.', 'Regarding your contact about this matter, the details follow.', 'About your questions: the details follow.', 'Regarding your writing to me, the details follow.']) {
      expect((await refused(MAIN, COURTESY, s)).issue, s).toMatch(/earlier contact that is not on file/);
    }
    // An invitation that looks ahead is not one of them.
    for (const s of ['If you write to me at the address above, I would be grateful.', 'You can write to me at the address above.', 'Please contact me with any questions.']) expect(toneWordIssue(s), s).toBeNull();
  });

  it('a line no longer lends its own words to a new sentence', async () => {
    const have = haveLetter();
    // "have" and "letter" are in this client’s own linking sentence. A sentence that was changed does not get them.
    for (const s of ['I have your letter here.', 'I have read your letter.', 'I have put the details in the mail to you.', 'The details are set out in this letter.']) {
      await refused(have, have.leadIn, s);
      expect(rewordingIssue(have.body, have.body.replace(have.leadIn, s), have.input.protectedTerms), s).toMatch(/not plain courtesy \(“(have|are)”\)/);
    }
    await accepted(have, have.leadIn, 'The details follow.');
    // A sentence left exactly as it was keeps its words ("by mail"); the sentence beside it may still be reworded.
    await accepted(MAIN, COURTESY, `${VOICE.contact} Many thanks for your time.`);
    await accepted(MAIN, COURTESY, `${VOICE.thanks} ${VOICE.contact}`);
    expect((await refused(MAIN, COURTESY, `You can write to me by mail at the address above. ${VOICE.thanks}`)).issue).toMatch(/“mail”/);
    expect((await refused(MAIN, COURTESY, `${VOICE.contact} Thank you for your time and your mail.`)).issue).toMatch(/your mail|“mail”/);
  });

  it('refuses anything that is not a plain English word: an address, a missing space, look-alike letters and digits, invisible characters', async () => {
    const odd = [
      'Please write to me at reach@my-mail.me. Thank you.', 'You can reach me by mail at contact-me.at/address. Thank you.', 'Please write to me c/o the address above.', 'Thank you!!! :) <b>Thank you</b> & thanks.',
      'Thank you.This is mine.I reached out to you by mail.', `${COURTESY}Thank you for your kind help.`, 'Thank you for your time - this is mine - I reached you by mail.', 'Thank you for your help — and for your time.',
      'I can šúé you.', 'Your help is ñó help.', 'I can put ＄５００ in the mail.', 'Ｉ ｌｏｓｔ ｍｙ ｊｏｂ ｌａｓｔ ｓｐｒｉｎｇ．', 'Я потерял работу прошлой весной.', 'Gracias por su atención.',
      'Thank you for your time for ３０ and more.', 'Thank you for your time for ٣٠ and more.',
      `\u202e${COURTESY}`, `\u202e${COURTESY}\u200d`, 'See you so\u200bon.',
      // Blank characters other than a plain space are not read as one: "so on" with a zero-width character between would print as "soon".
      'I hope to hear from you so\ufeffon.', 'Thank you for your\u00a0help.', 'Thank you for your\u2009help.', 'Thank you for your help.\u2028Thank you.',
    ];
    for (const s of odd) {
      const { note, issue } = await refused(MAIN, COURTESY, s);
      expect(issue, s).toMatch(/^it uses (something that is not a plain English word \(“[\x21-\x7e]+”\)|characters that are not plain English letters)$/);
      expect(note, s).toBe(`AI rewrite discarded: ${issue}.`);
    }
    // What the message shows is printable: an invisible or look-alike character is never echoed back.
    expect((await refused(MAIN, COURTESY, `\u202e${COURTESY}`)).issue).toBe('it uses characters that are not plain English letters');
    expect((await refused(MAIN, COURTESY, 'Please write to me at reach@my-mail.me. Thank you.')).issue).toBe('it uses something that is not a plain English word (“reach@my-mail.me.”)');
    // Capital letters belong at the start of a sentence and in "I": elsewhere they shout, or make a word read as a name.
    for (const [s, word] of [['THANK YOU FOR YOUR HELP.', 'THANK'], ['Thank You For Your Help.', 'You'], ['Thank you for Your help.', 'Your'], ['Many thanks. thank You.', 'You.'], ['I’D appreciate your help.', 'I’D'], ['Thank you for your Attention.', 'Attention.']] as const) {
      expect((await refused(MAIN, COURTESY, s)).issue, s).toBe(`it uses a capital letter where a plain word has none (“${word}”)`);
    }
    // A listed word that is also a first name is not on the list at all.
    for (const s of ['Thank you, May.', 'May, thank you for your help.', 'Many thanks, Hope.']) expect((await refused(MAIN, COURTESY, s)).issue, s).toMatch(/not plain courtesy \(“(may|hope)”\)/);
    // The same text on the salutation and the sign-off lines.
    await refused(MAIN, 'Sincerely,', 'Sinc\u0435rely,');
    await refused(MAIN, 'Sincerely,', 'Sin\u200bcerely,');
    await refused(MAIN, 'To whom it may concern:', 'To whom it may concern:\u200b');
  });

  it('the salutation and the sign-off each come from a short fixed list and stay where they are', async () => {
    expect([[...SALUTATIONS][0], [...SIGN_OFFS][0]]).toEqual(['To whom it may concern:', 'Sincerely,']); // what the built-in letters use
    for (const s of SALUTATIONS) if (s !== 'To whom it may concern:') await accepted(MAIN, 'To whom it may concern:', s);
    for (const s of SIGN_OFFS) if (s !== 'Sincerely,') await accepted(MAIN, 'Sincerely,', s);
    for (const s of ['Dear May:', 'Dear Jordan:', 'This is mine:', 'Dear Sir or Madam: thank you.', 'Dear Sir or Madam,', 'Dear Sirs:', 'Hello,', 'Thank you:', 'Sincerely,', '']) {
      expect((await refused(MAIN, 'To whom it may concern:', s)).issue, s).toMatch(/salutation is missing or is not one of the standard ones|name, amount, date or dispute statement/);
    }
    for (const s of ['Sincerely, May', 'It is mine, sincerely,', 'Regards, Sir May Good', 'Thank you, this is mine,', 'With thanks for your help,', 'Sincerely', 'sincerely,', 'To whom it may concern:', '']) {
      expect((await refused(MAIN, 'Sincerely,', s)).issue, s).toMatch(/sign-off is missing or is not one of the standard ones/);
    }
    // Swapped, or both gone together with the linking and closing lines: each was accepted and charged before.
    const swap = (m: string) => m.replace('To whom it may concern:', '@@').replace('Sincerely,', 'To whom it may concern:').replace('@@', 'Sincerely,');
    const bare = (m: string) => m.replace('To whom it may concern:', '').replace(VOICE.leadIn, '').replace(COURTESY, '').replace('Sincerely,', '');
    for (const mutate of [swap, bare]) {
      const ai = fake(mutate);
      expect(await tailorSafely(LETTER, INPUT, ai)).toMatchObject({ usedAi: false, text: LETTER, note: expect.stringMatching(/discarded: the salutation is missing or is not one of the standard ones/) });
      expect(ai.seen).toHaveLength(1);
      expect(tailorIssue(LETTER, mutate(LETTER), INPUT)).toMatch(/salutation is missing or is not one of the standard ones/);
    }
    // A linking or closing line may still be left out; the salutation and the sign-off may not.
    expect(tailorIssue(LETTER, LETTER.replace(` ${VOICE.leadIn}`, '').replace(COURTESY, ''), INPUT)).toBeNull();
    // “Dear” and “sincerely” are not on the word list, so a salutation or such a sign-off does not go where a sentence was.
    expect((await refused(MAIN, VOICE.leadIn, 'Dear Sir or Madam:')).issue).toMatch(/“dear”/);
    expect((await refused(MAIN, COURTESY, 'Sincerely,')).issue).toMatch(/“sincerely”/);
  });

  it('a reworded line may not say “I”, “me” or “my” more often than the line it replaces', async () => {
    // The closing line has one.
    for (const s of ['I thank you for your help, and I appreciate your attention.', 'You can write to me at the address above. I appreciate your help.', 'Many thanks to you for helping me with this, and for your attention to me.']) {
      expect((await refused(MAIN, COURTESY, s)).issue, s).toBe('it uses “I”, “me” or “my” more often than the line it replaces');
    }
    await accepted(MAIN, COURTESY, 'I look forward to hearing from you. Thank you for your help.');
    await accepted(MAIN, COURTESY, 'Thank you very much for your time and attention.');
  });

  it('accepts ordinary courtesy: thanks, an invitation to write back, a pointer to the details', async () => {
    for (const s of ['The particulars follow.', 'The specifics follow below.', 'The details of this matter follow.', 'Details follow.', 'These details follow here.']) await accepted(MAIN, VOICE.leadIn, s);
    // The linking sentence points to the details and does nothing else: no thanks, no request, no "I".
    for (const [s, word] of [['Many thanks for reading this.', 'many'], ['Thank you in advance for the details.', 'thank'], ['I would appreciate the details.', 'i'], ['You can write to me here.', 'you'], ['Please follow the details below.', 'please']] as const) {
      expect((await refused(MAIN, VOICE.leadIn, s)).issue, s).toMatch(new RegExp(`^it (makes the linking sentence do more than point to the details \\(“${word}”\\)|asks for something the letter did not ask for)$`));
    }
    for (const s of [
      'You can write to me at the address above. Many thanks for your time and attention.', 'You can contact me at the address above. Thank you for your help with this matter.',
      'Please write to me at the address above with any questions. Thank you for your time.', 'Please do not hesitate to write to me at the address above. Many thanks.', 'Please don’t hesitate to contact me. Thank you for your time.',
      'Please feel free to contact me at the address above. Thank you very much for your attention.', 'I look forward to hearing from you. Thank you for your time and consideration.', 'You can write to me at your convenience. Many thanks for your assistance.',
      'I would be grateful for your help. Thank you for looking into this matter.', 'I’d be grateful for your help with this matter.', 'I would be most thankful for your attention.', 'Thank you for reviewing this matter carefully.', 'Thank you in advance for your help and for your time.',
      'Thank you so much for your attention to this matter.', 'You can reach me by writing to the address above. Thank you.',
      `${VOICE.contact} Thank you for your time and attention, and thank you for your kind help.`,
    ]) await accepted(MAIN, COURTESY, s);
    // The details are pointed to where the letter already pointed to them, and nowhere else: in a closing line the same
    // words would ask for them ("thank you in advance for the details") or pass comment on them.
    for (const s of ['I would appreciate the details.', 'Thank you in advance for the details.', 'I would be grateful for any other details.', 'Thank you for the details above.', 'I can help with all the particulars.']) {
      expect((await refused(MAIN, COURTESY, s)).issue, s).toBe('it brings up the details in a line that did not mention them');
    }
    // The phrases allowed by name are allowed in that form only.
    for (const [s, word] of [['I hear from you about this matter.', 'hear'], ['Thank you for the time.', 'time'], ['I forward this to you.', 'forward'], ['You can be of help to me.', 'be'], ['This would be your matter.', 'be'], ['All of this questions your cooperation.', 'questions'], ['I can advance this matter.', 'advance'], ['Please write to me at the address below.', 'address'], ['I feel grateful to you.', 'feel']] as const) {
      expect((await refused(MAIN, COURTESY, s)).issue, s).toBe(`it uses wording that is not plain courtesy (“${word}”)`);
    }
  });

  it('a protected passage cannot move to another line, although every sentence is still there in the same order', async () => {
    const lines = LETTER.split('\n');
    const at = lines.findIndex((l) => l.startsWith('Please conduct a reasonable reinvestigation'));
    expect(lines[at - 1]).toBe('');
    const joined = [...lines];
    joined[at - 2] = `${joined[at - 2]} ${joined[at]}`; // the request paragraph run on to the end of the reason
    joined[at] = '';
    expect(sameProtectedContent(LETTER, joined.join('\n'), INPUT.protectedTerms)).toBe(true);
    expect(tailorIssue(LETTER, joined.join('\n'), INPUT)).toBe('it moves a protected passage to another line');
    // From the model: the blank line under the date moved below the name. Every marker is still on a line of its own, in order.
    const ai = fake((m) => { const out = m.replace('[[LOCKED_1]]\n\n[[LOCKED_2]]\n', '[[LOCKED_1]]\n[[LOCKED_2]]\n\n'); expect(out).not.toBe(m); return out.replace('Sincerely,', 'Respectfully,'); });
    expect(await tailorSafely(LETTER, INPUT, ai)).toMatchObject({ usedAi: false, text: LETTER, note: 'AI rewrite discarded: it moves a protected passage to another line.' });
    expect(ai.seen).toHaveLength(1);
  });
});

describe('line ends are read the same way where a line is locked and where it is hidden', () => {
  const CR = '\r';
  /** A drafted letter with the protected terms the tailoring step builds for it (src/lib/letters/tailor-load.ts loadTailorSubject). */
  const drafted = (r: BriefRecord) => {
    const brief = buildBrief(r, { now: new Date('2026-11-19T12:00:00Z'), includeSsnLast4: true });
    const tpl = templateByKey(disputeLetterKey(brief)!)!;
    const body = mergeTemplate(tpl.body, buildValues(contextFor(brief, tpl)));
    const [d, t] = [r.dispute!, r.tradeline!];
    const protectedTerms = letterTerms({ clientName: r.client.full_name, address: r.client.address, body, templateBody: tpl.body, names: [d.recipient_name, t.creditor_name, t.original_creditor, d.item_label], facts: [d.reason, t.account_status, t.payment_status] });
    const v = voiceFor(brief.seed);
    return { body, input: { protectedTerms, seed: brief.seed, specificity: { category: d.category, reason: d.reason, fields: d.fields, account: { name: t.creditor_name, reference: t.account_last4 } } }, wording: ['To whom it may concern:', v.leadIn, [v.contact, v.thanks].filter(Boolean).join(' '), 'Sincerely,'] };
  };
  const sentTo = (ai: { seen: AiRequest[] }) => /<source>\n([\s\S]*)\n<\/source>/.exec(ai.seen[0]!.user)![1]!.replace(/\[\[LOCKED_\d+\]\]/g, '').split(/[\n\r]/).map((l) => l.trim()).filter(Boolean);
  const TYPED = ['I was in hospital in the spring', 'My sister handled my mail then', 'Experian reports a late payment for March 2025.'];

  it('a reason typed with a lone carriage return, a line feed or both between its lines is locked line by line', async () => {
    for (const eol of [CR, '\n', '\r\n']) {
      const l = drafted({ ...RECORD, dispute: { ...RECORD.dispute!, reason: TYPED.join(eol) } });
      expect(l.body, JSON.stringify(eol)).toContain(TYPED.join(eol)); // the letter carries the reason as it was typed
      expect(editableWording(l.body, l.input.protectedTerms).split('\n'), JSON.stringify(eol)).toEqual(l.wording);
      const ai = fake((m) => m.replace('Sincerely,', 'Respectfully,'));
      expect((await tailorSafely(l.body, l.input, ai)).usedAi, JSON.stringify(eol)).toBe(true);
      expect(sentTo(ai), JSON.stringify(eol)).toEqual(l.wording); // nothing a person typed reaches the provider
      // Rewording or dropping a typed line is refused before anything is saved.
      expect(tailorIssue(l.body, l.body.replace('My sister handled my mail then', 'I handled my mail then'), l.input), JSON.stringify(eol)).toBe('a name, amount, date or dispute statement would change');
      expect(tailorIssue(l.body, l.body.replace(`I was in hospital in the spring${eol}`, ''), l.input), JSON.stringify(eol)).toBe('a name, amount, date or dispute statement would change');
    }
  });

  it('a creditor name that arrives with a carriage return inside it is locked on both of its lines', async () => {
    const name = ['Harbor Lending', 'Card Services'].join(CR);
    const l = drafted({ ...RECORD, tradeline: { ...RECORD.tradeline!, creditor_name: name }, dispute: { ...RECORD.dispute!, item_label: `${name} ••1234 (Experian)` } });
    expect(l.body).toContain(`Item: ${name}, account ending 1234`);
    expect(editableWording(l.body, l.input.protectedTerms).split('\n')).toEqual(l.wording);
    const ai = fake((m) => m.replace('Sincerely,', 'Respectfully,'));
    expect((await tailorSafely(l.body, l.input, ai)).usedAi).toBe(true);
    expect(sentTo(ai)).toEqual(l.wording);
    expect(ai.seen[0]!.user).not.toMatch(/Harbor|Lending|Card Services/);
    expect(tailorIssue(l.body, l.body.replace('Item: Harbor Lending', ''), l.input)).toBe('a name, amount, date or dispute statement would change');
    // A term is looked for inside one line, so a name with a line break in it is locked part by part, wherever it is written.
    const terms = letterTerms({ clientName: 'Jordan Rivera', names: [name, 'Northstar\r\nRecovery'], facts: [TYPED.join(CR)] });
    for (const t of ['Harbor Lending', 'Card Services', 'Northstar', 'Recovery', ...TYPED]) expect(terms, t).toContain(t);
    expect(terms.filter((t) => /[\r\n]/.test(t))).toEqual([]);
    expect(reasonLinesFrom('Reason for my request:\r\n{{reason}}\r\n\r\nPlease conduct a review.', `Reason for my request:\n${TYPED.join(CR)}\n\nPlease conduct a review.`)).toEqual(TYPED);
  });

  it('a letter stored with CRLF line ends is not charged for a result that changes nothing', async () => {
    const crlf = LETTER.replace(/\n/g, '\r\n');
    // "usedAi" is what the caller is charged for and what the automatic setting saves as a new AI-worded version.
    expect(await tailorSafely(crlf, INPUT, fake((m) => m))).toEqual({ text: crlf, usedAi: false, provider: 'fake', note: 'The AI had no wording changes to suggest.' });
    const r = await tailorSafely(crlf, INPUT, fake(reword));
    expect(r.usedAi).toBe(true);
    expect(r.text).toBe(reword(LETTER).trim());
    expect(tailorIssue(crlf, reword(LETTER).replace(/\n/g, '\r\n'), INPUT)).toBeNull(); // what a browser form sends back
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
    const ai = fake((m) => m.replace('You can reach me by mail at the address above. Thank you for your time and attention.', 'You can write to me at the address above. Many thanks for your time.'));
    const r = await tailorSafely(body, { protectedTerms, seed: 7 }, ai);
    expect(r.usedAi).toBe(true);
    for (const line of [...STORY, typed]) expect(r.text).toContain(line);
    expect(r.text).toContain('You can write to me at the address above. Many thanks for your time.');
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
