import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { clientPaymentTerms, clientTermsIssue, parseTerms, savedTermsIssue, storedTerms, termsForClient, termsIssue, type AgreementTerms } from '@/lib/compliance/agreement-terms';
import { findAdvanceFee, findContractClaims, findMarketingClaims } from '@/lib/compliance/claims';
import { readingCopyBlocks, signedCopyBlocks, unprintableNote } from '@/lib/compliance/consent-pdf';
import { isRendered, renderConsent, signedPayment, type RenderedConsent } from '@/lib/compliance/disclosures';
import { renderPdf, renderPdfBlocks, unprintable } from '@/lib/letters/pdf';

/**
 * The agency's terms, a client's own payment terms and the PDF copies: findings LEG-3, SEC-3, LEG-5, LEG-9, LEG-13 and
 * LEG-14 of the review.
 */
const NY = 'America/New_York';
const TERMS: AgreementTerms = {
  legalName: 'Bright Path Credit LLC', address: '500 Bayshore Blvd, Suite 210, Tampa, FL 33606',
  services: 'We review your three credit reports with you, prepare dispute letters for the items you choose, track each investigation and report every response to you in your portal.',
  paymentTerms: 'A monthly fee of $99.00, charged on the 1st of each month for the work fully performed in the month before.',
  totalCents: 59_400, duration: 'About 6 months from the date you sign.', additional: '', updatedAt: '2026-11-20T15:00:00.000Z', updatedBy: 'u1',
};
const contract = (clientName: string, terms: AgreementTerms = TERMS) => {
  const r = renderConsent('croa_contract', { agencyName: terms.legalName, terms, clientName, today: '2026-11-25', personal: false });
  if (!isRendered(r)) throw new Error('not rendered');
  return r as RenderedConsent;
};
const portalRow = (c: RenderedConsent, signed_name: string) => ({ kind: 'croa_contract', text_shown: c.text, text_sha256: c.sha256, signed_name, signed_at: '2026-11-25T15:04:00.000Z', ip: '203.0.113.7', recorded_by: null, revoked_at: null });

describe('LEG-13: characters the PDF cannot print', () => {
  it('finds each character the PDF prints as "?", and nothing that prints', () => {
    expect(unprintable('Nguyễn Thị Hương')).toEqual(['ễ', 'ị', 'ư', 'ơ']);
    expect(unprintable('Zoë Łukasz → ≤ ™ ​')).toEqual(['Ł', '→', '≤', '™', '​']);
    // Spanish names, the curly quotes, dashes and bullets the letters use, and white space all print.
    expect(unprintable('Ñandú café “ACME” — ••1234 – … € \t?')).toEqual([]);
  });

  it('a copy with such a character says so at the top, and the fingerprint is of the stored text, never "the text above"', () => {
    const c = contract('Nguyễn Thị Hương');
    const blocks = signedCopyBlocks(portalRow(c, 'Nguyễn Thị Hương'), NY, TERMS.legalName);
    expect(blocks[0]!.text).toBe(unprintableNote(true));
    expect(blocks[0]!.text).toBe('Some characters in this document could not be printed in this PDF and appear as "?". The text stored with the signature is exact and complete: the fingerprint below is the SHA-256 of that stored text.');
    const all = blocks.map((b) => b.text).join('\n');
    expect(all).toContain(`Fingerprint of the stored text (SHA-256): ${c.sha256}`);
    expect(all).not.toContain('text above');
    // The fingerprint is the SHA-256 of the stored text, with the name exactly as it was signed.
    expect(createHash('sha256').update(c.text, 'utf8').digest('hex')).toBe(c.sha256);
    expect(c.text).toContain('and Nguyễn Thị Hương (“you”)');
    // The PDF itself prints the name with "?" (the reason for the note) and the note in full.
    const pdf = renderPdfBlocks(blocks, { title: 'Service agreement (signed copy)' }).toString('latin1');
    expect(pdf).toContain('Nguy?n Th? H??ng');
    expect(pdf).toContain('(Some characters in this document could not be printed in this PDF and appear');
    expect(pdf).toContain('the fingerprint below is the SHA-256 of that) Tj T*\n(stored text.) Tj');
  });

  it('a name only in the signature block counts too; a copy that prints in full has no note', () => {
    const c = contract('Dana Whitfield');
    expect(signedCopyBlocks(portalRow(c, 'Dana Whitfield'), NY, TERMS.legalName)[0]!.text).toBe(c.doc.title);
    expect(signedCopyBlocks(portalRow(c, 'Dana Łukasz Whitfield'), NY, TERMS.legalName)[0]!.text).toBe(unprintableNote(true));
    const es = contract('María José Núñez');
    const blocks = signedCopyBlocks(portalRow(es, 'María José Núñez'), NY, TERMS.legalName);
    expect(blocks[0]!.text).toBe('Service agreement');
    expect(blocks.map((b) => b.text).join('\n')).toContain(`Fingerprint of the stored text (SHA-256): ${es.sha256}`);
  });

  it('agency terms with a symbol the font lacks, and a paper record, get the note too; the reading copy says the signing page is exact', () => {
    const arrow = contract('Dana Whitfield', { ...TERMS, services: `${TERMS.services} Reports → letters → responses.` });
    const paper = { ...portalRow(arrow, 'Dana Whitfield'), recorded_by: 'staff-user', signed_on: '2026-11-23' };
    const texts = signedCopyBlocks(paper, NY, TERMS.legalName).map((b) => b.text);
    expect(texts[0]).toBe(unprintableNote(true));
    expect(texts[2]).toMatch(/^This is not a copy of the paper the client signed\./);
    expect(texts.join('\n')).toContain(`Fingerprint of the app's stored text (SHA-256): ${arrow.sha256}`);
    expect(readingCopyBlocks(arrow.doc.title, arrow.blocks)[0]).toEqual({ text: 'Some characters in this document could not be printed in this PDF and appear as "?". The text on the signing page is exact and complete.' });
    expect(readingCopyBlocks(contract('Dana Whitfield').doc.title, contract('Dana Whitfield').blocks)[0]).toEqual({ text: 'Service agreement' });
  });

  it('letters are drawn exactly as before (the byte-for-byte hashes are in intake-agreements.test.ts)', () => {
    // A letter with a character the font lacks still prints it as "?" and gains no note: the note is for consent copies.
    const pdf = renderPdf('Dear Experian,\n\nNguyễn Thị Hương\n').toString('latin1');
    expect(pdf).toContain('(Nguy?n Th? H??ng) Tj');
    expect(pdf).not.toContain('could not be printed');
  });
});

describe('LEG-3 and SEC-3: no promise of a result in the agency’s terms', () => {
  const base = { legalName: TERMS.legalName, address: TERMS.address, services: TERMS.services, paymentTerms: TERMS.paymentTerms, totalCents: TERMS.totalCents, duration: TERMS.duration, additional: '' };
  // Every promise the review found saved into a contract (LEG-3 and SEC-3, with the skeptics' extra cases).
  const PROMISES = [
    'We remove late payments and collections from your reports.',
    'We will get your collections deleted.',
    'We delete inaccurate items within 30 days.',
    'Most clients see 5 to 10 items removed in the first round.',
    'We challenge accurate negative items as unverifiable to get them taken off.',
    'We erase bad credit.',
    'Bankruptcies, charge-offs and judgments removed.',
    'We dispute every negative item on your reports, including accurate late payments, until they are deleted.',
    'We remove late payments, collections and charge-offs from your credit reports, and we get negative items deleted for you.',
    'We delete collections and charge-offs from your reports so your credit score goes up and you get approved for a mortgage.',
    'Our clients typically gain 100 points. We will get your bankruptcy erased from your reports.',
    'We erase your bad credit and raise your score so you can qualify for a home loan.',
    'We have removed over 1,200 negative items for our clients.',
    'Items deleted within 45 days of your first letter.',
    'We clean up your credit report.',
    'We dispute your late payments even if they are accurate.',
    'We guarantee results.',
  ];
  // Honest descriptions of the work, and careful disclaimers an attorney might add.
  const HONEST = [
    'We ask the bureaus to correct or delete information that cannot be verified.',
    'We dispute items you believe are inaccurate.',
    'We prepare dispute letters asking the credit bureaus to investigate items you believe are inaccurate, and to correct or delete any late payments or collections that cannot be verified.',
    'We cannot guarantee that any negative item will be deleted.',
    'We do not promise that any item will be removed from your credit reports, and we do not promise any change in your credit score.',
    'Results vary and are not guaranteed.',
    'We make no guarantee of performance or of any result.',
    'Accurate, current and verifiable information cannot be removed from a credit report.',
    'We do not dispute accurate information.',
    'We do not sell tradelines, credit privacy numbers or new credit identities.',
    'No one can promise that you will qualify for a loan.',
    'You may qualify for a refund under the laws of your state.',
    'You get a letter each time a bureau answers, and we tell you which items it changed.',
    'We delete your documents and personal information when you ask, except what the law requires us to keep.',
    'There is no charge for paper copies.',
    TERMS.services,
  ];

  it('refuses every promise the review found, in any of the five fields', () => {
    for (const text of PROMISES) {
      expect(findContractClaims(text), text).not.toEqual([]);
      expect(termsIssue({ ...base, services: `${TERMS.services} ${text}` }), text).toMatch(/^Services: /);
      expect(termsIssue({ ...base, additional: text }), text).toMatch(/^Additional terms: /);
    }
    expect(termsIssue({ ...base, duration: 'Items deleted within 45 days.' })).toMatch(/^How long the services should take: Do not promise/);
    expect(termsIssue({ ...base, paymentTerms: 'A fee of $99 a month until your bad credit is erased.' })).toMatch(/^Payment terms: Do not promise that an item will be removed/);
    expect(termsIssue({ ...base, legalName: 'Guaranteed Removal Credit LLC' })).toMatch(/^Legal business name: Results cannot be guaranteed/);
  });

  it('says what is wrong and what to write instead', () => {
    expect(termsIssue({ ...base, services: `${TERMS.services} We remove late payments and collections from your reports.` }))
      .toBe('Services: Do not promise that an item will be removed. (“remove late payments and collections”). Describe what you will do, not a result.');
    expect(termsIssue({ ...base, services: `${TERMS.services} We challenge accurate negative items as unverifiable.` }))
      .toBe('Services: Do not offer to dispute information that is accurate. (“challenge accurate negative items”). Describe disputes of information the client believes is inaccurate, incomplete or cannot be verified.');
  });

  it('lets honest wording through, including disclaimers that name what is not promised', () => {
    for (const text of HONEST) {
      expect(findContractClaims(text), text).toEqual([]);
      expect(termsIssue({ ...base, additional: text }), text).toBeNull();
    }
    // The 'free' rule of the website check is not used: an ordinary payment term in a contract passes.
    expect(findMarketingClaims('There is no charge for paper copies.').map((i) => i.id)).toEqual(['free']);
  });

  it('a negation or disclaimer counts only for its own clause', () => {
    for (const text of [
      'No refunds, we sell tradelines.',
      'We do not sell tradelines, but we offer CPNs.',
      'We cannot promise anything, but we remove late payments.',
      'We ask for nothing: we delete your collections.',
      'We do not promise miracles, yet your score goes up.',
    ]) expect(findContractClaims(text), text).not.toEqual([]);
  });

  it('terms saved before these checks read as not saved, and Settings is told why', () => {
    const settings = { agreement: storedTerms({ ...TERMS, services: `${TERMS.services} We remove late payments and collections from your reports.` }) };
    expect(parseTerms(settings)).toBeNull();
    expect(savedTermsIssue(settings)).toMatch(/^Services: Do not promise that an item will be removed/);
    expect(savedTermsIssue({ agreement: storedTerms(TERMS) })).toBeNull();
    expect(savedTermsIssue({})).toBeNull();
  });
});

describe('LEG-5: no payment asked for at signing or in advance (15 U.S.C. § 1679b(b))', () => {
  const ADVANCE = [
    'A setup fee of $199 is due when you sign this agreement, then $99 a month.',
    'The first month ($99) is charged today, at signing.',
    'A $50 deposit is collected at enrollment.',
    'Payment of the full $594 is due upfront.',
    'You pay $594 in advance for the whole program.',
    'An enrolment fee of $149 is charged upon enrollment.',
    'A one-time set-up fee of $99, then $79 per month.',
    'The monthly fee of $99.00 is billed up front at the start of each month.',
    'Your card is charged $99 immediately after you sign.',
    'A retainer of $300 is required before work begins.',
    'Payment is due before we start the disputes.',
    'No refunds, a $99 deposit is required.',
  ];
  const HONEST_PAYMENT = [
    TERMS.paymentTerms,
    'A monthly fee, charged after the work of each month is fully performed.',
    '$99 per month, charged only after the services for that month are fully performed.',
    'There is no setup fee and no deposit. Nothing is charged when you sign.',
    'We never charge in advance: each month is billed after its work is done.',
    'There are no upfront fees. You pay $99 at the end of each month for the letters sent that month.',
    'You will not be charged before the work is fully performed.',
    'There is no charge for paper copies.',
  ];

  it('refuses each wording that asks for payment at or before signing, citing the law in plain words', () => {
    for (const text of ADVANCE) expect(findAdvanceFee(text), text).not.toBeNull();
    const base = { legalName: TERMS.legalName, address: TERMS.address, services: TERMS.services, paymentTerms: ADVANCE[0]!, totalCents: TERMS.totalCents, duration: TERMS.duration, additional: '' };
    expect(termsIssue(base)).toBe('Payment terms: “setup fee” asks for payment before the work it pays for is done. Federal law (15 U.S.C. § 1679b(b)) does not allow charging for a service before it is fully performed. Say when each payment is charged, after the work it pays for.');
    expect(termsIssue({ ...base, paymentTerms: 'Payment of the full $594 is due upfront.' })).toMatch(/^Payment terms: “upfront” asks for payment before the work it pays for is done\./);
    // Anywhere in the agreement, not only under Payment terms.
    expect(termsIssue({ ...base, paymentTerms: TERMS.paymentTerms, additional: 'A $50 deposit is collected at enrollment.' })).toMatch(/^Additional terms: “deposit” asks for payment/);
  });

  it('passes honest payment terms, and time words that are not about paying', () => {
    for (const text of HONEST_PAYMENT) expect(findAdvanceFee(text), text).toBeNull();
    for (const text of ['About 6 months from the date you sign.', 'Once you sign, we wait for the cancellation period to end before any work starts.', 'We tell you up front which items we will dispute.', 'Today’s laws let you dispute inaccurate information for free.'])
      expect(findAdvanceFee(text), text).toBeNull();
  });

  // The same advance fees in other words (the verification of LEG-5 found these saved).
  const MORE_ADVANCE: [string, string][] = [
    ['Your first payment of $99 is due on the day you sign, then $99 a month.', 'on the day you sign'],
    ['A fee of $99 is payable on the day of signing.', 'on the day of signing'],
    ['The fee is charged on the same day the agreement is signed.', 'on the same day the agreement is signed'],
    ['The first $99 is due at the time you sign.', 'at the time you sign'],
    ['An initial payment of $149 is due within 24 hours of signing.', 'within 24 hours of signing'],
    ['$99 is paid within two days of signing this agreement.', 'within two days of signing'],
    ['A payment of $99 is collected within one day after the client signs.', 'within one day after the client signs'],
    ['Payment is collected within 3 days of the effective date.', 'within 3 days of the effective date'],
    ['The full $594 is due on the effective date of this agreement.', 'on the effective date'],
    ['Fees are due on the date of this agreement.', 'on the date of this agreement'],
    ['Payment is due upon execution of this agreement.', 'upon execution of this agreement'],
    ['We charge $99 at the beginning of each month for that month’s work.', 'at the beginning of each month for that month'],
    ['The monthly fee is charged at the start of each month for the work of that month.', 'at the start of each month for the work of that month'],
    ['Each month is charged on the first day of the month for the work performed in that month.', 'on the first day of the month for the work performed in that month'],
    ['You are billed $99 on the 1st of each month for the month ahead.', 'on the 1st of each month for the month ahead'],
    ['You pay $99 before we send your first letters.', 'before we send your first letters'],
    ['You pay before the first letters are sent.', 'before the first letters'],
    ['Payment is due before work starts.', 'before work'],
    ['Payment is due prior to the start of the disputes.', 'prior to the start'],
  ];
  const MORE_HONEST = [
    'Charged at the end of each month for the work fully performed that month.',
    'Billed after each round of letters has been sent.',
    'You pay $99 on the 1st of each month for the work fully performed in the month before.',
    'Charged on the 1st of each month for the previous month’s work.',
    'We bill on the first day of each month for the work done the month before.',
    'We charge $99 after the first letters are sent.',
    'The first payment is due 30 days after the effective date, for the work performed in that period.',
    'Each payment is due within 10 days of the invoice, which we send after the work is performed.',
    'Nothing is due on the day you sign.',
    'No payment is due before work starts.',
    'You are never charged at the time you sign.',
  ];

  it('refuses payment due on the day or at the time of signing, within hours or days of signing or of the effective date, on the effective date, at the start of the month for that month’s work, and before the work', () => {
    for (const [text, excerpt] of MORE_ADVANCE) expect(findAdvanceFee(text)?.excerpt, text).toBe(excerpt);
    const base = { legalName: TERMS.legalName, address: TERMS.address, services: TERMS.services, paymentTerms: MORE_ADVANCE[0]![0], totalCents: TERMS.totalCents, duration: TERMS.duration, additional: '' };
    expect(termsIssue(base)).toBe('Payment terms: “on the day you sign” asks for payment before the work it pays for is done. Federal law (15 U.S.C. § 1679b(b)) does not allow charging for a service before it is fully performed. Say when each payment is charged, after the work it pays for.');
    expect(termsIssue({ ...base, paymentTerms: TERMS.paymentTerms, additional: 'The full $594 is due on the effective date of this agreement.' })).toMatch(/^Additional terms: “on the effective date” asks for payment/);
  });

  it('passes payment charged after the work it pays for, and those time words when nothing is paid', () => {
    for (const text of MORE_HONEST) expect(findAdvanceFee(text), text).toBeNull();
    for (const text of ['This agreement starts on the effective date.', 'Within 30 days of the effective date, we send your first letters.', 'We start work at the beginning of each month.'])
      expect(findAdvanceFee(text), text).toBeNull();
  });
});

describe('the removal rules in a contract are about items on a credit report, not the agency’s own records', () => {
  const base = { legalName: TERMS.legalName, address: TERMS.address, services: TERMS.services, paymentTerms: TERMS.paymentTerms, totalCents: TERMS.totalCents, duration: TERMS.duration, additional: '' };
  const DATA_PRACTICE = [
    'When you close your account, we delete your documents within 30 days.',
    'When this agreement ends, we delete your account and your documents within 30 days of your request.',
    'Your documents will be deleted within 30 days of your request.',
    'Upon a valid request, your data will be deleted.',
    'We are legally required to delete your personal information within 45 days of a verified request.',
    'You can get your account deleted at any time by writing to us.',
    'We delete copies of your credit reports when you ask.',
    'We will delete your credit card information when you cancel.',
    'After we review your credit reports with you, we delete your documents within 30 days of your request.',
  ];
  const CREDIT_REMOVAL = [
    'We delete inaccurate items within 30 days.',
    'Items deleted within 45 days of your first letter.',
    'We delete your account from your credit report within 30 days.',
    'We remove accounts from your credit report.',
    'We delete negative accounts within 30 days.',
    'We delete collection accounts in 30 days.',
    'Collections removed from your credit report within 45 days.',
    'Accounts will be removed from your credit report.',
    'Your late payments will be deleted.',
    'We will get your negative accounts removed.',
    'We remove them from your credit report.',
    'We remove inaccurate information from your credit report.',
    'The bureaus are legally required to delete negative items.',
    // Promises that name the bureaus or common credit items without the word "report" (the verifier's list).
    'We remove accounts from Experian, Equifax and TransUnion.',
    'We will delete the account from all three bureaus within 30 days.',
    'We will get the account removed from Equifax.',
    'We erase old accounts in as little as 30 days.',
    'We will remove your closed accounts within 30 days.',
    'We delete the accounts you dispute within 30 days.',
    'Medical bills removed within 30 days.',
    'We remove repos and evictions in 45 days.',
    'We will remove your student loans from your credit.',
    'We will delete hard pulls within 30 days.',
  ];

  it('passes how the agency deletes its own records', () => {
    for (const text of DATA_PRACTICE) {
      expect(findContractClaims(text), text).toEqual([]);
      expect(termsIssue({ ...base, additional: text }), text).toBeNull();
    }
  });

  it('still refuses removing or deleting anything on a credit report: negative items, accounts or items on the report, or from it', () => {
    for (const text of CREDIT_REMOVAL) {
      expect(findContractClaims(text), text).not.toEqual([]);
      expect(termsIssue({ ...base, additional: text }), text).toMatch(/^Additional terms: (Do not promise that an item will be removed|Do not promise results within a time frame|Do not misstate legal obligations)\./);
    }
    expect(termsIssue({ ...base, additional: 'When you close your account, we delete your negative items within 30 days.' })).toMatch(/^Additional terms: Do not promise that an item will be removed\./);
  });
});

describe('advance fees: the wordings the last verification found, and honest cancellation terms', () => {
  const base = { legalName: TERMS.legalName, address: TERMS.address, services: TERMS.services, paymentTerms: TERMS.paymentTerms, totalCents: TERMS.totalCents, duration: TERMS.duration, additional: '' };
  const ADVANCE = [
    'Payment of $99 is due when this agreement is signed.',
    '$99 is billed as soon as the agreement is signed.',
    'The first $99 is charged once the contract is signed.',
    'Payment of $99 is required to begin services.',
    'Services begin once your first payment of $99 is received.',
    'We start work after we receive your first payment of $99.',
    'Fees of $99 are due 48 hours after signing.',
    '$99 is due at the start of each month for the work we will do that month.',
    'First payment: $99, due immediately.',
    'Pay $99 now to get started.',
    'Your card is charged $99 when your account is opened.',
    'No payment is due today; $99 is charged when you sign.',
  ];
  const HONEST = [
    'You may cancel before work starts at no charge.',
    'If you cancel before we send your first letters, you pay nothing.',
    'You can cancel at any time. If you cancel before the first round of letters, no payment is due.',
    'If you cancel before the work starts, you will not be charged.',
    'If you cancel before any letters are sent, no fee is due.',
    'Charged at the end of each month for the work fully performed that month.',
    'Billed after each round of letters has been sent.',
  ];
  it('refuses each of them', () => {
    for (const text of ADVANCE) expect(findAdvanceFee(text), text).not.toBeNull();
  });
  it('passes honest cancellation and refund terms, and billing after the work', () => {
    for (const text of HONEST) {
      expect(findAdvanceFee(text), text).toBeNull();
      expect(termsIssue({ ...base, paymentTerms: text.length >= 10 ? text : base.paymentTerms, additional: text }), text).toBeNull();
    }
  });
});

describe('LEG-9: a client’s own payment terms and total', () => {
  const PREMIUM = 'A monthly fee of $149.00, charged on the 1st of each month for the work fully performed in the month before.';

  it('the contract states the client’s own figures when set, the agency’s otherwise; the rest of the terms stay the agency’s', () => {
    const own = clientPaymentTerms({ agreement_payment_terms: PREMIUM, agreement_total_cents: 89_400 });
    expect(own).toEqual({ paymentTerms: PREMIUM, totalCents: 89_400 });
    expect(clientPaymentTerms({ agreement_payment_terms: null, agreement_total_cents: null })).toBeNull();
    expect(termsForClient(TERMS, null)).toBe(TERMS);
    expect(termsForClient(null, own)).toBeNull(); // no agreement before the agency saves its terms
    const t = termsForClient(TERMS, own)!;
    expect(t).toEqual({ ...TERMS, paymentTerms: PREMIUM, totalCents: 89_400 });
    const c = contract('Dana Whitfield', t);
    expect(c.text).toContain(`3. Payment\n${PREMIUM}\nTotal of all payments you will make under this agreement, to us or to any other person: $894.00.`);
    expect(c.text).toContain(TERMS.services);
    expect(c.sha256).not.toBe(contract('Dana Whitfield').sha256);
  });

  it('reads back the figures an agreement was signed with, from its stored text', () => {
    expect(signedPayment(contract('Dana Whitfield').text)).toEqual({ paymentTerms: TERMS.paymentTerms, total: '$594.00' });
    const twoParagraphs = `${PREMIUM}\n\nLate fees: none.`;
    expect(signedPayment(contract('Dana Whitfield', { ...TERMS, paymentTerms: twoParagraphs, totalCents: 100_000_000 }).text)).toEqual({ paymentTerms: twoParagraphs, total: '$1,000,000.00' });
    expect(signedPayment('Service agreement\n\nA placeholder from the 2026-01 drafts.')).toBeNull();
  });

  it('checks them as the agency’s payment terms and total are checked', () => {
    expect(clientTermsIssue({ paymentTerms: PREMIUM, totalCents: 89_400 })).toBeNull();
    expect(clientTermsIssue({ paymentTerms: 'Monthly', totalCents: 89_400 })).toBe('Payment terms: required.');
    expect(clientTermsIssue({ paymentTerms: PREMIUM, totalCents: -1 })).toBe('Total of all payments: enter the amount in dollars, for example 594.00.');
    expect(clientTermsIssue({ paymentTerms: PREMIUM, totalCents: 100_000_001 })).toBe('Total of all payments: enter the amount in dollars, for example 594.00.');
    expect(clientTermsIssue({ paymentTerms: 'A $50 deposit is due at enrollment, then $99 a month.', totalCents: 64_400 })).toMatch(/^Payment terms: “deposit” asks for payment before the work it pays for is done\./);
    expect(clientTermsIssue({ paymentTerms: 'A fee of $99 a month until your bad credit is erased.', totalCents: 59_400 })).toMatch(/^Payment terms: Do not promise that an item will be removed\./);
  });
});

// ---------------------------------------------------------------- the last verification's corpus

/*
 * The sentences of the last verification (its probes a1, a2, a5 and a6), each with the outcome the verifier expects,
 * checked through the real save paths: the agency's Services or Payment terms (termsIssue) and a client's own payment
 * terms (clientTermsIssue).
 */
const VERIFY_BASE = { legalName: TERMS.legalName, address: TERMS.address, services: TERMS.services, paymentTerms: TERMS.paymentTerms, totalCents: TERMS.totalCents, duration: TERMS.duration, additional: '' };

describe('removal promises: every removal word, in any tense, voice or person, unless it is honest (verification corpus)', () => {
  // The sentence put into Services, after which a neutral sentence keeps the field over its 40-character minimum.
  const saved = (t: string) => termsIssue({ ...VERIFY_BASE, services: `${t} We review your reports with you every month.` });
  const PROMISES: Record<string, string[]> = {
    verifier: [
      'We will get the account removed from Equifax within 30 days.',
      'We remove accounts from Experian, Equifax and TransUnion.',
      'We will delete hard pulls within 30 days.',
      'We will delete the account from all three bureaus within 30 days.',
      'We will remove your student loans from your credit.',
      'Medical bills removed within 30 days.',
      'We remove repos and evictions in 45 days.',
      'We delete the accounts you dispute within 30 days.',
      'We will remove your closed accounts within 30 days.',
      'We erase old accounts in as little as 30 days.',
      'We will get the account removed from Equifax.',
    ],
    present_first_person: [
      'We remove student loans.',
      'We remove medical bills.',
      'We remove the account.',
      'We delete evictions.',
      'We remove your evictions from all three bureaus.',
      'We delete your medical debt.',
      'We wipe out your medical debt.',
      'We remove your account with Capital One.',
      'We delete your account with the original creditor.',
      'We remove hard inquiries.',
      'We remove the hard pull from your Experian report.',
      'We remove unpaid bills from your history.',
      'We remove charge-offs.',
      'We take collections off your report.',
      'We take negative items off your credit report.',
      'We knock late payments off your report.',
      'We eliminate medical bills from your report.',
      'We purge your report of negative accounts.',
      'We clear your report of collections.',
      'We clear medical debt from your credit.',
      'We remove your account from ChexSystems.',
      'We remove your account from the consumer reporting agencies.',
      'We remove your account from your Innovis file.',
      'We delete your account from LexisNexis.',
      'We can remove any account.',
      'There is no account we cannot remove.',
      'There is no negative item we cannot remove.',
    ],
    adverbs_tenses: [
      'We will also remove your student loans.',
      'We will then delete your medical bills.',
      'We routinely remove student loans.',
      'We successfully remove evictions.',
      'We always remove medical bills.',
      'We usually remove repos.',
      'We can and will remove repos.',
      'We’ll also remove your student loans.',
      "We're removing your medical bills.",
      'We are removing your medical bills from your credit report.',
      'We have removed medical bills for thousands of clients.',
      'We have removed accounts from Equifax for hundreds of clients.',
      'We will quickly and permanently remove your evictions.',
      'We will permanently delete your student loans.',
      'We remove, dispute and delete medical bills.',
      "We'll delete your evictions.",
      'We will remove all your evictions.',
      'Our goal is simple: we remove your student loans.',
    ],
    passive: [
      'Accounts are removed from Experian, Equifax and TransUnion.',
      'Medical bills are removed from your credit report.',
      'Student loans are deleted from your credit.',
      'Your evictions will be removed.',
      'Hard inquiries are removed within 30 days.',
      'Medical bills are taken off your report.',
      'Your account with Capital One will be removed.',
      'Your student loans will be deleted from your credit.',
      'The account is removed from all three bureaus.',
      'Repossessions are deleted from your file.',
      'Negative accounts are deleted.',
      'Medical debt is erased from your reports.',
      'Your report is cleared of collections.',
      'Each account you dispute is removed from your report.',
      'Disputed accounts are deleted from Equifax.',
      'Student loans removed from your credit.',
      'Evictions deleted from all three bureaus.',
    ],
    get_have: [
      'We get medical bills removed.',
      'Clients get their student loans removed.',
      'You get your evictions deleted from your report.',
      'We will have your medical bills removed.',
      'You will have your student loans removed from your credit.',
      'We get the account taken off your report.',
      'Your medical bills get removed.',
      'We will get your account removed from Equifax.',
      'We will get your account with the creditor removed.',
      'We will get your account removed by the consumer reporting agencies.',
      'We will get your account removed from ChexSystems.',
      'We help you get your evictions removed.',
      'We get your account removed.',
      'We will get your Capital One account removed.',
    ],
    third_person: [
      'Our team removes medical bills from your report.',
      'Our specialists remove negative accounts from your credit.',
      'Bright Path removes evictions and repos from your credit file.',
      'The company deletes student loans from all three bureaus.',
      'Our dispute process removes medical bills.',
      'This program removes collections.',
    ],
    spanish: [
      'Eliminamos sus cuentas de cobranza.',
      'Eliminaremos las cuentas de su reporte de crédito.',
      'Borramos las deudas médicas de su historial.',
      'Quitamos los préstamos estudiantiles de su crédito.',
      'Vamos a eliminar sus cuentas de Equifax.',
      'Sus cuentas serán eliminadas de Experian.',
      'Las cuentas negativas serán eliminadas.',
      'Removemos los desalojos de su historial de crédito.',
      'Eliminamos las consultas duras en 30 días.',
      'Podemos eliminar cualquier cuenta de su reporte.',
      'Le eliminamos las cuentas de su informe de crédito.',
      'Sacamos las cuentas de su reporte de crédito.',
    ],
    disclaimer_abuse: [
      'We cannot promise any result, but we will remove your student loans.',
      'We cannot guarantee results; we will remove your student loans.',
      'We cannot guarantee results, and we will remove your student loans.',
      'We do not promise results, and we will remove your student loans within 30 days.',
      'Without any guarantee, we will remove your evictions within 30 days.',
      'No promises, we just remove your medical bills.',
      'Not only do we remove medical bills, we remove evictions too.',
    ],
    data_practice_abuse: [
      'We delete your data and your collection accounts.',
      'We delete your documents and your bad debts.',
      'We delete your uploads and the medical debt.',
      'We delete your documents and your student loan.',
      'We delete your data, and we also remove your medical bills.',
      'We delete your documents and your medical bills.',
      'We delete your documents and your evictions within 30 days.',
      'We delete your personal information and your account with the creditor.',
      'We delete your data from the furnisher’s records.',
      'We remove your personal data from the consumer reporting agencies.',
      'We remove your personal information from ChexSystems within 30 days.',
      'We delete your account and the account history at the bank.',
      'We delete your documents, then we remove your evictions.',
    ],
  };
  // Nouns and gerunds (probe a5).
  PROMISES.nouns_and_gerunds = [
    'Our services include the removal of medical bills from your credit report.',
    'Service: deletion of student loans and evictions from all three bureaus.',
    'Removal of up to 10 accounts per round.',
    'We handle the removal of your medical debt.',
    'Get your medical bills off your report.',
    'We make medical bills disappear.',
    'Watch your evictions disappear from your report.',
    'We fix your credit by removing student loans.',
    'We specialize in removing medical bills, student loans and evictions.',
    'We specialize in removing collections.',
    'Our services include the removal of inaccurate negative items.',
  ];
  const HONEST: string[] = [
    'We delete your documents within 30 days of your request.',
    'When you close your account, we delete your documents within 30 days.',
    'When this agreement ends, we delete your account and your documents within 30 days of your request.',
    'We delete copies of your credit reports when you ask.',
    'We delete your card details when you cancel.',
    'We remove your uploads from our servers within 30 days after the agreement ends.',
    'You may ask us to delete your personal information at any time.',
    'We delete your data within 30 days after you close your account.',
    'Your payment information is deleted when you cancel.',
    'We ask the bureaus to correct or delete information that cannot be verified.',
    'We ask the credit bureaus to delete information you believe is inaccurate.',
    'We ask the bureaus to remove negative items that you believe are inaccurate.',
    'We request that the bureaus delete late payments that cannot be verified.',
    'We cannot guarantee any item will be removed.',
    'We cannot guarantee that any account will be removed from your credit report.',
    'We do not promise that any negative item will be deleted.',
    'No one can promise that accurate information will be removed.',
    'We review your three credit reports with you and prepare dispute letters for the items you choose.',
    'We send each dispute letter only after you approve it.',
    'The bureaus decide whether an item is corrected, updated or deleted.',
    'If a bureau cannot verify an item, the law requires it to correct or delete that item.',
    'If a furnisher cannot verify a collection, the bureau must delete or correct it.',
    'We dispute late payments you believe are inaccurate; the bureaus decide the outcome.',
    'You may close your account at any time and we will delete your documents.',
    'We will delete your account and all your documents when you ask.',
    'We will delete your uploaded files 30 days after your agreement ends.',
    'We delete the photos of your ID once your identity is confirmed.',
    'We delete copies of your Equifax reports within 30 days.',
    'We delete the credit reports you uploaded within 30 days of your request.',
    'Credit reports you upload are deleted within 30 days after your agreement ends.',
    'Copies of your credit reports are deleted within 30 days after your agreement ends.',
    'Your credit card details are deleted within 30 days after you cancel.',
    'Your credit card is removed from our billing system within 30 days.',
    'We delete your Social Security number from our system within 30 days of your request.',
    'We delete your SSN and date of birth within 30 days after you close your account.',
    'We delete your messages and notes within 30 days after the agreement ends.',
    'We delete your file within 30 days after the agreement ends.',
    'We delete your records within 30 days of your request.',
    'We delete your information within 30 days of your request.',
    'We delete your account information within 30 days of your request.',
    'Your profile is deleted within 30 days after you close it.',
    'Your messages will be deleted after two years.',
    'Your information will be deleted when you ask.',
    'Your file will be deleted when you close your account.',
    'When you cancel, we delete your account.',
    'We remove your name from our mailing list when you ask.',
    'We delete old messages from your portal after two years.',
    'You can ask us to delete your account, your documents and your data at any time.',
    'We may ask a creditor to delete an account that you believe is reported in error.',
    'We will ask Equifax to delete the account if it cannot be verified.',
    'If you ask, we delete your account and every document you uploaded.',
    'Deleted documents cannot be recovered.',
    'Accurate negative information cannot be removed from your credit report.',
    'We will never tell you that an item will be removed.',
    'We prepare and mail dispute letters to Experian, Equifax and TransUnion for the items you choose.',
    'We track each investigation and tell you whether each item was verified, updated or deleted.',
    'Items the bureaus delete or update are shown in your portal.',
    'You will see in your portal which items were deleted, updated or verified.',
    'If an item is deleted, we let you know.',
    'We send letters asking furnishers to verify or delete accounts you believe are reported in error.',
    'Late payments that cannot be verified must be corrected or deleted by the bureau.',
    'We delete your documents within 30 days and email you a confirmation.',
    'We delete your login and your documents when you close your account.',
    'When your agreement ends, we delete your portal account within 30 days.',
    'We delete the documents you uploaded, such as pay stubs and bank statements, within 30 days of your request.',
    'You can remove a document you uploaded at any time from your portal.',
    'Your uploads are removed from our storage within 30 days after you leave.',
    'We remove your ID documents from our files within 30 days after your identity is confirmed.',
    'If an account is deleted after a dispute and later reappears, we help you dispute it again.',
    'The bureaus, not us, decide whether any account is removed.',
  ];
  // Data practices refused before (probe a6).
  HONEST.push(
    'We delete your bank account details within 30 days after you cancel.',
    'We delete your billing information within 30 days after you cancel.',
    'We delete your login credentials within 30 days after you close your account.',
  );

  it.each(Object.keys(PROMISES))('refuses every promise of the %s group, in Services', (group) => {
    for (const t of PROMISES[group]!) {
      expect(findContractClaims(t), t).not.toEqual([]);
      expect(saved(t), t).toMatch(/^Services: /);
    }
  });

  it('passes every data practice, request, disclaimer, statement of the law and description of the work', () => {
    for (const t of HONEST) {
      expect(findContractClaims(t), t).toEqual([]);
      expect(findAdvanceFee(t), t).toBeNull();
      expect(saved(t), t).toBeNull();
    }
  });

  it('reads "your account" with a creditor or a consumer reporting agency as a credit account, and says what it refused', () => {
    expect(saved('We remove your account with Capital One.')).toBe('Services: Do not promise that an item will be removed. (“We remove your account with Capital One”). Describe what you will do, not a result.');
    expect(saved('We will get your account removed by the consumer reporting agencies.')).toMatch(/^Services: Do not promise that an item will be removed\. \(“get your account removed by the consumer reporting agencies”\)/);
    expect(saved('We remove your personal information from ChexSystems within 30 days.')).toMatch(/^Services: Do not promise that an item will be removed\./);
    // The client's account with the agency, where the sentence says so.
    for (const t of ['When you cancel, we delete your account.', 'You can get your account deleted at any time by writing to us.', 'We delete your account with us when you ask.']) expect(saved(t), t).toBeNull();
    // A count of items removed keeps its own, more precise message.
    expect(findContractClaims('Most clients see 5 to 10 items removed in the first round.')[0]?.id).toBe('removal-count');
  });
});

describe('advance fees: the exemptions, more wordings and honest terms (verification corpus)', () => {
  const savedAgency = (t: string) => termsIssue({ ...VERIFY_BASE, paymentTerms: t.length >= 10 ? t : `${t} (terms)` });
  const savedClient = (t: string) => clientTermsIssue({ paymentTerms: t, totalCents: 59_400 });
  const ADVANCE: Record<string, string[]> = {
    verifier_r4: [
      'Payment of $99 is due when this agreement is signed.',
      '$99 is billed as soon as the agreement is signed.',
      'The first $99 is charged once the contract is signed.',
      'Payment of $99 is required to begin services.',
      'Services begin once your first payment of $99 is received.',
      'We start work after we receive your first payment of $99.',
      'Fees of $99 are due 48 hours after signing.',
      '$99 is due at the start of each month for the work we will do that month.',
      'First payment: $99, due immediately.',
      'Pay $99 now to get started.',
      'Your card is charged $99 when your account is opened.',
    ],
    earlier: [
      'Your first payment of $99 is due on the day you sign.',
      'The first $99 is due at the time you sign.',
      'An initial payment of $149 is due within 24 hours of signing.',
      'The full $594 is due on the effective date of this agreement.',
      'We charge $99 at the beginning of each month for that month’s work.',
      'You pay $99 before we send your first letters.',
      'The first payment of $99 is due within 3 days after you sign.',
      'You will be billed $99 on the first of each month for the services of that month.',
      'Monthly fee of $99, charged on the 1st of every month for the current month.',
      'Payment is due before the first round of disputes is sent.',
      'A one-time fee of $199 is due when the client signs.',
      'The client pays $99 at the time of enrollment.',
      'A payment of $99 is due on the date this agreement is signed.',
      'The first payment ($99) is processed on enrollment.',
      'We collect $99 upon execution of this agreement.',
      'Your $99 monthly payment is drafted on the day you enroll and every 30 days after.',
      'You pay $99 prior to the start of the dispute process.',
    ],
    mine: [
      'Payment of $99 is due upon signing.',
      '$99 is payable at signing.',
      'The $99 first-month fee is collected the day you sign up.',
      'You will be charged $99 the same day you sign.',
      'Your first $99 payment is charged right away.',
      'We bill $99 immediately upon enrollment.',
      'Payment for the first month is due in full before services start.',
      'The first month is paid at the start of the month.',
      'You are billed on the 1st for the month ahead.',
      'We charge $99 at the start of every month for the month ahead.',
      'Each month is billed in advance.',
      'Monthly fee: $99, billed on the 1st of each month for that month.',
      'Monthly fee: $99, billed on the 1st of each month for services rendered that month.',
      'We charge $99 at the start of each month to cover that month’s work.',
      'Billing happens on the first day of each month for the upcoming month.',
      'Your subscription is charged at the beginning of each billing cycle.',
      'Payment is collected before each round of letters is mailed.',
      'We require a $99 payment to open your file.',
      'A $99 payment is required to open your file.',
      'Work begins after your first $99 payment clears.',
      'We begin as soon as your payment of $99 clears.',
      'Your file is opened once we receive $99.',
      'We will not start work until your first payment of $99 is received.',
      'Services start upon receipt of payment.',
      'Fees are payable in full at the outset.',
      'The full program fee of $594 is due at the beginning of the program.',
      'Payment of $99 is due on day one.',
      'You pay $99 on your start date.',
      'Fees are due the day this agreement is signed.',
      'Please include your first payment of $99 with this signed agreement.',
      'Return this agreement with your $99 payment.',
      'A $99 audit fee is charged before we review your reports.',
      'A $99 credit audit fee is due at your first consultation.',
      'Your first payment is drafted immediately.',
      'We charge your card immediately.',
      'The $99 fee is charged instantly at checkout.',
      'Pay at checkout to activate your plan.',
      'Your plan is activated once payment is received.',
      'You must pay $99 before we do anything.',
      'The total of $594 is charged at the start.',
      'Fees are due 10 days after you sign.',
      'Fees are due two weeks after you sign.',
      'The first payment is due on the first of the month after you sign.',
      'A $99 first-work fee is charged before the cancellation period ends.',
      'El pago de $99 se cobra al firmar.',
      'Usted paga $99 por adelantado.',
    ],
    exemption_abuse: [
      'If you cancel, you pay nothing; otherwise $99 is due when you sign.',
      'If you cancel within 3 days you owe nothing, and $99 is charged when you sign.',
      'Cancellation policy and fees: $99 is due when you sign.',
      'Non-cancellable: $99 is due when you sign.',
      '$99 is due when you sign and there is no charge for copies.',
      '$99 is due when you sign and no other fees apply.',
      'Pay $99 when you sign and you will not be charged again until the work is done.',
      '$99 is due when you sign and nothing is due after that.',
      'Paper copies are free of charge and $99 is due when you sign.',
      'If you cancel before work starts you pay nothing, but $99 is due when you sign.',
      'Cancel anytime, $99 is due when you sign.',
      'Fee of $99 (cancel anytime) due when you sign.',
      'You may cancel within 3 days and pay nothing; the full $594 is due up front otherwise.',
      'We charge no interest and $99 when you sign.',
      'We never charge over $99 when you sign.',
      'Never more than $99 at signing.',
      'No hidden fees: $99 is due when you sign.',
      'If you do not cancel, $99 is due today.',
      'Unless you cancel, $99 is charged on the effective date.',
      'There is no setup fee and $99 is due when you sign.',
      'No deposit is required, just a $99 retainer.',
    ],
    control_refused: [
      '$99 is due when you sign.',
      'You may cancel at any time. $99 is due when you sign.',
      'We charge $99 when you sign, and you may cancel at any time.',
      '$99 is due when you sign. If you cancel, you pay nothing.',
      'No charge for paper copies; $99 is due when you sign.',
      'You pay nothing extra: $99 is due when you sign.',
    ],
  };
  const HONEST: string[] = [
    'Charged at the end of each month for the work fully performed that month.',
    'You are billed $99 after each round of letters has been sent.',
    'We charge $99 on the 1st of each month for the work fully performed in the month before.',
    'Payment is due within 5 days after each round of letters is sent.',
    'No payment is due on the day you sign.',
    'Nothing is charged before the work is done.',
    'Billed monthly in arrears.',
    'You are billed monthly in arrears for the work performed in the prior month.',
    'The first payment is due 30 days after the effective date, for the work performed in that period.',
    'Payment is due 30 days after you sign, for the work performed during those 30 days.',
    'Each payment is charged only after the work it pays for has been fully performed.',
    'You may cancel within 3 business days and pay nothing.',
    'If you cancel before work starts, you pay nothing.',
    'If you cancel before we send your first letters, you pay nothing.',
    'You may cancel before work starts at no charge.',
    'You can cancel at any time. If you cancel before the first round of letters, no payment is due.',
    'If you cancel before the work starts, you will not be charged.',
    'If you cancel before any letters are sent, no fee is due.',
    'If you cancel within 3 business days of signing, you owe nothing.',
    'You may cancel within 3 business days of signing at no charge.',
    'You have 3 business days after you sign to cancel, and you pay nothing.',
    'You may cancel this agreement without penalty or obligation within 3 business days after you sign.',
    'Refunds: if a payment was charged in error, we refund it within 10 days.',
    'You can cancel at any time; you pay only for work already performed.',
    'We do not charge before the work is done.',
    'There is no setup fee.',
    'No deposit is required.',
    'We never charge in advance.',
    'There are no upfront fees.',
    'Nothing is due when you sign.',
    'You pay nothing when you sign.',
    'You will not be charged when you sign.',
    'Payment for each month’s work is due on the 5th of the following month.',
    'We bill on the 1st of each month for the work fully performed in the previous month.',
    'We bill you at the start of each month for the work we completed in the previous month.',
    'At the start of each month we send you an invoice for the work we did the month before.',
    'On the 1st of each month we will send you a statement of the work performed.',
    'We bill on the last day of each month for that month’s work.',
    'You are billed at the end of each month for the work performed that month.',
    'Fees are due 7 days after each round of disputes is mailed.',
    'Payment is due within 7 days after you receive our invoice for work already performed.',
    'Services begin after the 3-business-day cancellation period ends.',
    'We prepare your first letters after you sign, and we bill only after they are sent.',
    'You can update your payment method when you sign in to the portal.',
    'The agreement starts on the effective date; payments are charged at the end of each month for the work performed that month.',
    'This agreement begins on the effective date. Payments are charged after the work is done.',
    'We charge $99 per round of letters, billed 5 days after each round is mailed.',
    'We review your reports with you today at no charge.',
    'Today’s consultation costs nothing.',
    'Your first invoice is sent 30 days after the effective date, for the work performed in those 30 days.',
    'You pay $99 for each round of disputes, after that round has been mailed.',
    'Payment is due when each round of letters has been sent.',
    'Your card is charged only after each round of letters is mailed.',
    'You will receive a receipt by email each time your card is charged, after the work is done.',
    'Payments are made by card; the card is charged after each round of letters is sent.',
  ];
  // Refused before by a payment word in the next clause, or a refund owed to the client (probe a6).
  HONEST.push(
    'A signed agreement is required to begin services; we bill only after each round of letters is sent.',
    'We send you a welcome email when your account is opened, and we bill only after the work is done.',
    'Sign now to get started; you pay only after each round of letters is sent.',
    'Any refund owed to you is due immediately.',
    'We send your welcome packet 2 days after you sign; you are billed only after each round of letters is sent.',
    'Your first letters are prepared 5 business days after signing, once the cancellation period has ended; payment is charged after they are mailed.',
  );

  it.each(Object.keys(ADVANCE))('refuses the %s group, as the agency’s and as a client’s own payment terms', (group) => {
    for (const t of ADVANCE[group]!) {
      expect(findAdvanceFee(t) ?? findContractClaims(t)[0] ?? null, t).not.toBeNull();
      expect(savedAgency(t), t).not.toBeNull();
      expect(savedClient(t), t).not.toBeNull();
    }
  });

  it('the cancellation and no-payment exemptions cannot carry an advance fee: each abuse sentence is one', () => {
    for (const t of ADVANCE.exemption_abuse!) expect(findAdvanceFee(t), t).not.toBeNull();
    expect(findAdvanceFee('If you cancel, you pay nothing; otherwise $99 is due when you sign.')?.excerpt).toBe('when you sign');
    expect(findAdvanceFee('You may cancel within 3 days and pay nothing; the full $594 is due up front otherwise.')?.excerpt).toBe('up front');
    expect(findAdvanceFee('Never more than $99 at signing.')?.excerpt).toBe('at signing');
  });

  it('passes every honest cancellation, refund and pay-after-the-work term', () => {
    for (const t of HONEST) {
      expect(findAdvanceFee(t), t).toBeNull();
      expect(findContractClaims(t), t).toEqual([]);
      expect(savedAgency(t), t).toBeNull();
      expect(savedClient(t), t).toBeNull();
    }
  });
});

describe('more ordinary wording an agency writes, and more promises (beyond the verification corpus)', () => {
  const HONEST = [
    'We may send goodwill letters asking a creditor to consider removing a late payment.',
    'Each dispute letter asks the bureau to verify the item or remove it.',
    'You may remove any item from your dispute list before we send the letters.',
    'You choose which items we dispute; you can take an item off the list at any time.',
    'Results vary; the bureaus and furnishers decide whether to correct, update or delete each item.',
    'Only the credit bureaus and furnishers can correct or delete information on your reports.',
    'We tell you when an item has been deleted, updated or verified.',
    'We keep your records for five years, then delete them.',
    'Deleting your account does not cancel this agreement.',
    'We may remove inactive portal accounts after two years.',
    'We will remove any duplicate letters before mailing.',
    'We delete any report you upload once we have read it.',
    'We delete the old version of a letter when you approve a new one.',
    'We do not charge a setup fee, a cancellation fee or any fee in advance.',
    'We will not charge you before the cancellation period ends.',
    'No work begins, and nothing is charged, before the cancellation period ends.',
    'Your first payment is due 30 days after the effective date, for the services performed in that period.',
    'We do not ask for or accept any payment for a service before that service is fully performed.',
    'We charge nothing up front and nothing when you sign.',
    'When you sign, we start the cancellation period; you pay only after the work is done.',
    'We take $10 off your first monthly fee if you refer a friend.',
    'We have gone through your reports with you.',
    'We explain our fees before we start work.',
    'We explain all fees at the start.',
    'You pay for the work done in the first month at the end of that month.',
  ];
  const PROMISES = [
    'We get negative items deleted.',
    'Our process deletes collections fast.',
    'We knock off late payments.',
    'We keep your collections for review, then delete them.',
    'If you sign today, we delete your collections.',
    'We do not charge a setup fee, and $99 is due when you sign.',
    'We do not charge interest, and we bill $99 when you sign.',
    'We do not charge a fee in advance other than $99.',
    'When you sign, you pay $99.',
    'Upon signing, a $99 fee is charged.',
    'Your collections will be gone in 30 days.',
    'We make your bad debts vanish.',
    'Collections will no longer appear on your report.',
    'Say goodbye to your collections.',
    'Your investment of $594 is collected in the first week.',
    'A $99 payment starts your program.',
    'First month: $99 (due at onboarding).',
    '$99 is billed in the first 3 days.',
    'Payment of $99 secures your spot.',
  ];
  it('passes the honest ones', () => {
    for (const t of HONEST) expect([findContractClaims(t), findAdvanceFee(t)], t).toEqual([[], null]);
  });
  it('refuses the promises', () => {
    for (const t of PROMISES) expect(findContractClaims(t).length > 0 || findAdvanceFee(t) !== null, t).toBe(true);
  });
});

describe('the last verification’s fresh corpus: openings, Spanish negations, stopped billing, data retention, statements of the law', () => {
  const ADVANCE = [
    // An opening "Before … ," clause with the payment after the comma.
    'Before your first dispute letter goes out, you pay $99.', 'Before work begins, you pay $99.', 'Before we start work, you pay a $99 fee.',
    'Prior to the start of services, a fee of $199 is due.', 'Prior to the start of the services, the client pays $199.',
    'Before services begin, the client pays a $199 fee.', 'Before any letters are sent, the full fee of $594 is collected.',
    'Before any work is performed, the client pays $250.', 'Before your first letters are mailed, a payment of $99 is collected.',
    'Upon enrollment and before any work is done, you pay $99.', 'Before we review your reports, we charge a $49 audit fee.',
    // The start of a period named with a word before it, the account set up, the moment of signing.
    'Your card will be charged $79 as soon as your enrollment is complete.', 'Payment is due at the beginning of each service month.',
    'Fees are due on the first day of each service period.', 'We charge $99 at the start of each new month.',
    'Your subscription is charged at the start of every 30-day period.', 'Monthly service fees are drafted on the 1st for the current month’s disputes.',
    'Payment of the full $450 must be received before your file is opened.', 'Your first two months are billed together when the agreement takes effect.',
    'Your bank account will be debited $99 the moment you sign.', 'We collect the first payment at the time your account is set up.',
    'We’ll charge your card $99 once you’ve signed.',
    // Spanish.
    'El primer pago de $99 se cobra el día que firma el contrato.', 'Se requiere un depósito de $150 para abrir su caso.',
    'Usted paga $89 al inscribirse.', 'Cobramos $99 antes de enviar la primera carta.', 'El pago mensual se cobra al inicio de cada mes.',
  ];
  const HONEST_PAYMENT = [
    'No cobramos nada por adelantado.', 'Nunca cobramos por adelantado.', 'No se cobra nada por adelantado.', 'No hay pagos por adelantado.',
    'No pedimos ningún pago al firmar.', 'No se cobra nada al firmar el contrato.', 'Sin pagos por adelantado.', 'No se requiere ningún depósito.',
    'Usted paga $89 al final de cada mes por el trabajo realizado ese mes. No cobramos nada por adelantado.',
    'El pago se cobra al inicio de cada mes por el trabajo realizado el mes anterior.',
    'If you cancel, we stop billing you right away.', 'When you cancel, billing stops immediately.',
    'If you cancel, we stop charging your card immediately.', 'We will stop all charges at once if you cancel.',
    'We do not charge a setup, enrollment or activation fee.', 'There are no setup, enrollment or sign-up fees.',
    'The first charge happens 30 days after you sign and covers only the work performed in those 30 days.',
    'Before work begins, we explain our fees.', 'Before work begins, you pay nothing.', 'Before any letters are sent, you can cancel at no cost.',
    'Before work begins, you sign this agreement and pay nothing.', 'Today, nothing is charged.',
    'Payment is due at the beginning of each month for the work performed in the previous month.',
    'Once your account is set up, you are billed $89 at the end of each month for the work performed that month.',
    'Billing starts 30 days after the agreement takes effect, for the work performed in those 30 days.',
    'When the agreement takes effect, nothing is charged.',
  ];
  const PROMISES = [
    'We clean up your TransUnion file.', 'We make sure the Wells Fargo repossession comes off your report.',
    'Collections will fall off your report after our letters go out.',
    'Nuestro equipo elimina los cobros médicos de su historial.', 'Sus deudas médicas desaparecerán de su reporte de crédito.',
    'Le ayudamos a eliminar las cuentas de ChexSystems.', 'Eliminación de cobros médicos de los tres burós.',
    'La empresa remueve los cargos de Capital One de su historial crediticio.',
    // What the new exemptions must not let through.
    'We dispute your collections, then delete them within 30 days.', 'Negative items are disputed and then deleted.',
    'Collections are disputed with the bureaus and then they are deleted.', 'We remove collections and opt you out of prescreened offers.',
    'We get your negative items removed after seven years.', 'Negative items are removed after seven years or sooner with our help.',
    'We delete late payments from your report.', 'Sacamos las deudas de su reporte de crédito.',
  ];
  const HONEST_CONTRACT = [
    // Data retention: a pronoun object, a passive with no subject, a pronoun subject.
    'We keep your uploaded documents while your agreement is in force and delete them within 60 days after it ends.',
    'We keep your documents while you are a client and delete them within 30 days after you leave.',
    'Emails you send us are kept for two years and then deleted.', 'Messages are kept for two years and then deleted.',
    'Your uploads are kept until you cancel and then deleted within 30 days.',
    'We keep your documents for 60 days after the agreement ends, and then they are deleted.',
    'We store your documents securely, then delete them within 30 days after your agreement ends.',
    'We keep your records for five years, then delete them within 30 days.',
    'We keep copies of your ID only until your identity is confirmed, then delete them within 7 days.',
    'You can delete any document you uploaded from the Documents page of your portal.',
    'We delete recordings of our phone calls with you after 90 days.',
    // Requests, disclaimers, possible outcomes, what is not on a report.
    'Our letters dispute the items you choose and demand verification or deletion.',
    'We dispute the items you select for correction or deletion.',
    'Nothing in this agreement promises the removal of any item from your credit report.',
    'A dispute can end with the item verified, updated or deleted.',
    'A successful dispute may lead to an item being corrected or removed.',
    'We help you opt out of prescreened credit offers and remove your name from marketing lists.',
    'We can help you place, lift or remove a security freeze with each bureau.',
    // Statements of the reporting law.
    'A bureau that deletes an item and later puts it back must notify you in writing within five business days.',
    'Late payments stay on your report for up to seven years, after which the bureau removes them.',
    'The FCRA requires most negative information to be removed from your report after seven years.',
    'Most negative items fall off your report after seven years.',
    // Spanish.
    'No podemos prometer que se eliminará ninguna cuenta.', 'No garantizamos que ninguna cuenta será eliminada.',
    'Solicitamos a los burós que corrijan o eliminen la información que no se puede verificar.',
    'Puede pedirnos que eliminemos sus documentos en cualquier momento.', 'Sacamos una copia de sus reportes de crédito cada mes.',
    'Los burós deben corregir o eliminar la información que no se puede verificar.',
  ];
  it('refuses each advance fee, from the agency’s terms and from a client’s own', () => {
    for (const t of ADVANCE) {
      expect(findAdvanceFee(t), t).not.toBeNull();
      expect(clientTermsIssue({ paymentTerms: t, totalCents: 53_400 }), t).toMatch(/^Payment terms: /);
    }
  });
  it('passes honest payment and cancellation terms, in English and Spanish', () => {
    for (const t of HONEST_PAYMENT) expect([findAdvanceFee(t), findContractClaims(t)], t).toEqual([null, []]);
  });
  it('refuses each promise of a removal', () => {
    for (const t of PROMISES) expect(findContractClaims(t).length, t).toBeGreaterThan(0);
  });
  it('passes honest contract sentences', () => {
    for (const t of HONEST_CONTRACT) expect(findContractClaims(t), t).toEqual([]);
  });
  it('terms already saved with such sentences can still be used', () => {
    const settings = { agreement: storedTerms({ ...TERMS, additional: 'Messages are kept for two years and then deleted. If you cancel, we stop billing you right away.', paymentTerms: 'Usted paga $89 al final de cada mes por el trabajo realizado ese mes. No cobramos nada por adelantado.' }) };
    expect(savedTermsIssue(settings)).toBeNull();
    expect(parseTerms(settings)).not.toBeNull();
  });
});
