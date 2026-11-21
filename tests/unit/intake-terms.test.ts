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
  const r = renderConsent('croa_contract', { agencyName: terms.legalName, terms, clientName, today: '2026-11-25' });
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
