import { describe, expect, it } from 'vitest';
import { clientTermsIssue, termsIssue } from '@/lib/compliance/agreement-terms';
import { findAdvanceFee, findContractClaims } from '@/lib/compliance/claims';
import { CROA_STATEMENT, CROA_STATEMENT_TITLE } from '@/lib/compliance/croa';
import { findGeneratedClaims } from '@/lib/guide/llm';
import { CLAIMS_CORPUS, type CorpusClass, type CorpusSentence } from '../fixtures/claims-corpus';

/**
 * Every sentence four rounds of independent review wrote for the rule-based text checks (tests/fixtures/claims-corpus.ts),
 * read through the save path its round used, must come out as the reviewers labelled it:
 *  - contract sentences: the agency's terms with the sentence in Services (termsIssue) and findContractClaims (round 1
 *    also counted findAdvanceFee);
 *  - payment sentences: the agency's Payment terms (termsIssue) and a client's own (clientTermsIssue); round 1 also
 *    read findAdvanceFee and findContractClaims; an advance fee counts as refused in round 1 and 2 when every one of
 *    them refuses it, in rounds 3 and 4 when either save does (round 4 used round 3's base terms and save paths);
 *  - guide sentences: findGeneratedClaims (any issue is a refusal).
 * The checks are lists of rules that catch common wordings, so some sentences are read the other way: KNOWN_LIMITS names
 * them with the reason, and a test checks that each is still read that way, so a rule that starts reading one right
 * moves it out of the list instead of hiding there.
 */

// Each round's base terms (which pass) and the padding its harness gave a short sentence.
const ROUND_TERMS = {
  r1: {
    legalName: 'Bright Path Credit LLC', address: '500 Bayshore Blvd, Suite 210, Tampa, FL 33606',
    services: 'We review your three credit reports with you, prepare dispute letters for the items you choose, track each investigation and report every response to you in your portal.',
    paymentTerms: 'A monthly fee of $99.00, charged on the 1st of each month for the work fully performed in the month before.',
    totalCents: 59_400, duration: 'About 6 months from the date you sign.', additional: '',
  },
  r2: {
    legalName: 'Harbor Light Credit Services LLC', address: '1200 Commerce St, Suite 400, Dallas, TX 75202',
    services: 'We review your three credit reports with you, prepare dispute letters for the items you choose and send you every response.',
    paymentTerms: 'You are billed $89 at the end of each month for the work fully performed during that month.',
    totalCents: 53_400, duration: 'About six months from the date you sign.', additional: '',
  },
  r3: {
    legalName: 'Lakeshore Credit Advocates LLC', address: '455 W Main St, Suite 210, Louisville, KY 40202',
    services: 'We review your reports with you each month, prepare the dispute letters you approve and send you every reply.',
    paymentTerms: 'You are billed $95 on the last business day of each month for the work completed that month.',
    totalCents: 57_000, duration: 'About six months from the start of work.', additional: '',
  },
};
const ROUND = {
  r1: { terms: ROUND_TERMS.r1, services: (t: string) => `${t} We review your reports with you every month.`, payment: (t: string) => (t.length >= 10 ? t : `${t} (terms)`), clientTotal: 59_400 },
  r2: { terms: ROUND_TERMS.r2, services: (t: string) => (t.length >= 40 ? t : `${t} We go over your reports with you every month.`), payment: (t: string) => (t.length >= 10 ? t : `${t} (terms)`), clientTotal: 53_400 },
  r3: { terms: ROUND_TERMS.r3, services: (t: string) => (t.length >= 40 ? t : `${t} We go over every reply from the bureaus with you.`), payment: (t: string) => t, clientTotal: 53_400 },
  r4: { terms: ROUND_TERMS.r3, services: (t: string) => (t.length >= 40 ? t : `${t} We go over every reply from the bureaus with you.`), payment: (t: string) => t, clientTotal: 53_400 },
};

/** Sentences the rules read the other way, each with why. Left out of the per-class tests; a fix moves one out of this list. */
const KNOWN_LIMITS: { text: string; reason: string }[] = [
  { text: 'We make the bureaus drop the account.', reason: '"drop" with an object is no removal word: it has ordinary meanings (drop a dispute, a fee).' },
  { text: 'Your report will be clear of collections by month three.', reason: '"be clear of" is not read as a removal ("it is clear from the record" is ordinary).' },
  { text: 'Your report will show zero collections when we are done.', reason: 'A result stated as a count of zero is in no list.' },
  { text: 'The full program price is billed when you start.', reason: '"When you start" is no time word: it also names when the work starts.' },
  { text: 'Clients who pay for all six months at once save 15%.', reason: 'Paying for months ahead for a discount names no time of signing or of the work.' },
  { text: 'No cobramos otros cargos al firmar, solo la primera mensualidad.', reason: 'The negated charge reaches the time word; the exception after the comma ("solo…") is not read.' },
  { text: 'Pay the $299 program fee and you may cancel before work starts.', reason: 'A command to pay names no time of its own, and "before work starts" is read as the time to cancel in.' },
  { text: 'Your $499 is charged unless you cancel before signing.', reason: '"Unless" ends the clause of the charge, so the time word is read with "you cancel" only (reading across it would refuse "billed at the end of each month unless you cancel before the month begins").' },
];
const known = new Set(KNOWN_LIMITS.map((k) => k.text));

/** Whether NOW reads a sentence as its round's harness expects, and what it found. */
function judge(s: CorpusSentence): { right: boolean; found: string } {
  const r = ROUND[s.corpus];
  const claim = (t: string) => { const c = findContractClaims(t)[0]; return c ? `${c.id} «${c.excerpt}»` : null; };
  const fee = (t: string) => { const f = findAdvanceFee(t); return f ? `advance «${f.excerpt}»` : null; };
  if (s.cls === 'promise' || s.cls === 'honest-contract') {
    const save = termsIssue({ ...r.terms, services: r.services(s.text) });
    const direct = s.corpus === 'r1' ? claim(s.text) ?? fee(s.text) : claim(s.text);
    const found = direct ?? save ?? 'nothing';
    if (s.expect === 'pass') return { right: save === null && direct === null, found };
    return { right: s.corpus === 'r1' ? save !== null && direct !== null : save !== null, found };
  }
  if (s.cls === 'advance' || s.cls === 'honest-payment') {
    const agency = termsIssue({ ...r.terms, paymentTerms: r.payment(s.text) });
    const client = clientTermsIssue({ paymentTerms: s.text, totalCents: r.clientTotal });
    const direct = s.corpus === 'r1' ? fee(s.text) ?? claim(s.text) : null;
    const found = direct ?? agency ?? client ?? 'nothing';
    if (s.expect === 'pass') return { right: agency === null && client === null && direct === null, found };
    const refused = s.corpus === 'r1' ? direct !== null && agency !== null && client !== null
      : s.corpus === 'r2' ? agency !== null && client !== null
        : agency !== null || client !== null;
    return { right: refused, found };
  }
  const issues = findGeneratedClaims(s.text);
  return { right: s.expect === 'pass' ? issues.length === 0 : issues.length > 0, found: issues.map((i) => i.id).join(', ') || 'nothing' };
}

const CLASSES: CorpusClass[] = ['promise', 'honest-contract', 'advance', 'honest-payment', 'prediction', 'ordinary'];

describe('the review rounds’ corpus, through the real save paths', () => {
  for (const corpus of ['r1', 'r2', 'r3', 'r4'] as const) {
    for (const cls of CLASSES) {
      const rows = CLAIMS_CORPUS.filter((s) => s.corpus === corpus && s.cls === cls);
      if (!rows.length) continue;
      const outcome = rows[0]!.expect === 'refuse' ? 'refused' : 'passed';
      it(`${corpus} ${cls}: each of ${rows.length} sentences is ${outcome}`, () => {
        const wrong = rows.filter((s) => !known.has(s.text)).map((s) => ({ s, v: judge(s) })).filter(({ v }) => !v.right).map(({ s, v }) => `${s.text} [${s.source}] → ${v.found}`);
        expect(wrong).toEqual([]);
      });
    }
  }

  it('each known limit is still read the other way (a rule that reads one right moves it out of KNOWN_LIMITS)', () => {
    const fixed = KNOWN_LIMITS.filter((k) => judge(CLAIMS_CORPUS.find((s) => s.text === k.text)!).right).map((k) => k.text);
    expect(fixed).toEqual([]);
  });

  it('each known limit is a corpus sentence, listed once', () => {
    const texts = new Set(CLAIMS_CORPUS.map((s) => s.text));
    for (const k of KNOWN_LIMITS) expect(texts.has(k.text), k.text).toBe(true);
    expect(known.size).toBe(KNOWN_LIMITS.length);
    // Every corpus sentence is there once and labelled consistently with its class.
    expect(new Set(CLAIMS_CORPUS.map((s) => s.text)).size).toBe(CLAIMS_CORPUS.length);
    for (const s of CLAIMS_CORPUS) expect(s.expect, s.text).toBe(['promise', 'advance', 'prediction'].includes(s.cls) ? 'refuse' : 'pass');
  });

  it('the 15 U.S.C. § 1679c(a) statement, quoted word for word, passes in Services and in Additional terms', () => {
    // The removal paragraph ("neither you nor any 'credit repair' company … has the right to have accurate, current, and
    // verifiable information removed …; the credit bureau must remove accurate, negative information from your report
    // only if it is over 7 years old") and the whole statement.
    const removalParagraph = CROA_STATEMENT[0]!;
    expect(removalParagraph).toContain('has the right to have accurate, current, and verifiable information removed from your credit report');
    const whole = [CROA_STATEMENT_TITLE, ...CROA_STATEMENT].join('\n\n');
    for (const t of [removalParagraph, whole]) {
      expect(findContractClaims(t), t.slice(0, 60)).toEqual([]);
      expect(findAdvanceFee(t), t.slice(0, 60)).toBeNull();
    }
    const terms = ROUND_TERMS.r3;
    expect(termsIssue({ ...terms, services: `${terms.services} ${removalParagraph}` })).toBeNull();
    expect(termsIssue({ ...terms, additional: whole })).toBeNull();
  });
});
