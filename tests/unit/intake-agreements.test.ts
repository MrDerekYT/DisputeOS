import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { cancellationEndsOn } from '@/lib/business-days';
import { parseDollars, parseTerms, storedTerms, termsIssue, type AgreementTerms } from '@/lib/compliance/agreement-terms';
import { findBlockedClaims } from '@/lib/compliance/claims';
import { readingCopyBlocks, signedCopyBlocks, storedBlocks } from '@/lib/compliance/consent-pdf';
import { CROA_CANCEL_STATEMENT, CROA_STATEMENT, CROA_STATEMENT_TITLE, NOTICE_BLANK, NOTICE_HEADING, NOTICE_TEMPLATE, noticeOfCancellation } from '@/lib/compliance/croa';
import {
  CONSENT_DOCS, consentStatus, isRendered, REQUIRED_CONSENTS, renderConsent, SERVICE_CONSENTS, SIGNING_ORDER, signingOrderProblem, type ConsentContext, type RenderedConsent,
} from '@/lib/compliance/disclosures';
import { renderPdf, renderPdfBlocks } from '@/lib/letters/pdf';
import { PRODUCT } from '@/lib/product';
import { onboarding } from '@/lib/onboarding';
import { tr } from '@/lib/portal-i18n';
import { welcomeEmail, welcomeEmailIssue } from '@/lib/welcome-link';

// The statute as read from the Legal Information Institute on 2026-11-20 (copies of the files the brief points to).
const STATUTES = path.resolve(__dirname, '../fixtures/statutes');
const statute = (f: string) => readFileSync(path.join(STATUTES, f), 'utf8').split('\n');
/** The Code quotes a multi-paragraph statement with a mark at the start of each paragraph and `".` at its very end. */
const unquote = (lines: string[]) => lines.map((l, i) => {
  let s = l.replace(/^"/, '');
  if (i === lines.length - 1) s = s.replace(/"\.$/, '');
  return s;
});
const between = (lines: string[], start: (l: string) => boolean, end: (l: string) => boolean) => lines.slice(lines.findIndex(start), lines.findIndex(end));

const TERMS: AgreementTerms = {
  legalName: 'Bright Path Credit LLC', address: '500 Bayshore Blvd, Suite 210, Tampa, FL 33606',
  services: 'We review your three credit reports with you, prepare dispute letters for the items you choose, track each investigation and report every response to you in your portal.',
  paymentTerms: 'A monthly fee of $99.00, charged on the 1st of each month for the work fully performed in the month before.',
  totalCents: 59_400, duration: 'About 6 months from the date you sign.', additional: 'Florida residents: see the attached state disclosure.', updatedAt: '2026-11-20T15:00:00.000Z', updatedBy: 'u1',
};
const ctx = (over: Partial<ConsentContext> = {}): ConsentContext => ({ agencyName: TERMS.legalName, terms: TERMS, clientName: 'Dana Whitfield', today: '2026-11-25', ...over });
const rendered = (kind: (typeof SIGNING_ORDER)[number], c = ctx()) => { const r = renderConsent(kind, c); if (!isRendered(r)) throw new Error('not rendered'); return r as RenderedConsent; };

describe('the statutory wording is the statute, word for word', () => {
  it('§ 1679c(a): the heading and every paragraph of the Consumer Credit File Rights statement', () => {
    const lines = statute('15usc1679c.txt');
    const quoted = unquote(between(lines, (l) => l.startsWith('"Consumer Credit File Rights'), (l) => l.startsWith('(b) Separate statement')));
    expect([CROA_STATEMENT_TITLE, ...CROA_STATEMENT]).toEqual(quoted);
    // Nothing is added: the document is the title and those paragraphs, the FTC's address as three lines of one.
    const doc = rendered('croa_disclosure');
    expect(doc.doc.title).toBe(CROA_STATEMENT_TITLE);
    expect(doc.text).toBe(`${CROA_STATEMENT_TITLE}\n\n${CROA_STATEMENT.slice(0, -3).join('\n\n')}\n\n${CROA_STATEMENT.slice(-3).join('\n')}`);
  });

  it('§ 1679d(b)(4): the statement next to the signature', () => {
    const line = statute('15usc1679d.txt').find((l) => l.startsWith('(4) a conspicuous statement'))!;
    expect(CROA_CANCEL_STATEMENT).toBe(line.slice(line.indexOf('"') + 1).replace(/"\.$/, ''));
  });

  it('§ 1679e(b): the heading and the statement of the Notice of Cancellation, blanks included', () => {
    const lines = statute('15usc1679e.txt');
    expect(lines.find((l) => l.startsWith('Each contract shall be accompanied'))).toContain(`the heading "${NOTICE_HEADING}"`);
    expect([...NOTICE_TEMPLATE]).toEqual(unquote(between(lines, (l) => l.startsWith('"You may cancel this contract,'), (l) => l.startsWith('(c) Consumer copy'))));
    // Filling in changes only the organization's three blanks; the consumer's own two become lines to write on.
    const filled = noticeOfCancellation({ name: 'Bright Path Credit LLC', address: '500 Bayshore Blvd, Tampa, FL 33606', date: 'December 1, 2026' });
    expect(filled[0]).toBe(NOTICE_TEMPLATE[0]);
    expect(filled[1]).toBe(NOTICE_TEMPLATE[1]!.replace(NOTICE_BLANK.name, 'Bright Path Credit LLC').replace(NOTICE_BLANK.address, '500 Bayshore Blvd, Tampa, FL 33606').replace(NOTICE_BLANK.date, 'December 1, 2026'));
    expect(filled[2]).toBe(NOTICE_TEMPLATE[2]);
    expect(filled.slice(3).join('\n')).toMatch(/^Date: _+\nPurchaser's signature: _+$/);
  });
});

describe('the service agreement', () => {
  it('names the parties, the date, the services, payment with the total, the time estimate and the fixed parts, in that order', () => {
    const c = rendered('croa_contract');
    expect(c.doc.title).toBe('Service agreement');
    const order = ['Date: November 25, 2026', 'between Bright Path Credit LLC, 500 Bayshore Blvd, Suite 210, Tampa, FL 33606', 'Dana Whitfield', '“you”', TERMS.services, TERMS.duration, TERMS.paymentTerms,
      'Total of all payments you will make under this agreement, to us or to any other person: $594.00.', 'We make no guarantee of performance or of any result.',
      'we do not promise any change in your credit score', 'Accurate, current and verifiable information cannot be removed from a credit report.',
      'We will not ask for or accept any payment for a service before that service is fully performed.', TERMS.additional, CROA_CANCEL_STATEMENT, NOTICE_HEADING];
    let at = -1;
    for (const part of order) {
      const i = c.text.indexOf(part, at + 1);
      expect(i, part).toBeGreaterThan(at);
      at = i;
    }
  });

  it('puts the § 1679d(b)(4) statement in bold right before the Notice of Cancellation, which is bold, with the name, address and last day filled in', () => {
    const c = rendered('croa_contract');
    const notice = c.blocks.findIndex((b) => b.text === NOTICE_HEADING);
    expect(c.blocks[notice - 1]).toEqual({ text: CROA_CANCEL_STATEMENT, bold: true });
    expect(c.blocks.slice(notice).every((b) => b.bold)).toBe(true);
    expect(c.blocks.slice(0, notice - 1).some((b) => b.bold)).toBe(false);
    // Signed Wednesday 25 November 2026: Thanksgiving (26th) and the weekend are skipped, so the third business day is 1 December.
    expect(c.blocks[notice + 2]!.text).toBe('To cancel this contract, mail or deliver a signed, dated copy of this cancellation notice, or any other written notice to Bright Path Credit LLC at 500 Bayshore Blvd, Suite 210, Tampa, FL 33606 before midnight on December 1, 2026');
  });

  it('cannot be built until the agency has saved its terms', () => {
    expect(renderConsent('croa_contract', ctx({ terms: null }))).toEqual({ notReady: true, doc: CONSENT_DOCS.find((d) => d.kind === 'croa_contract') });
    // The other documents do not depend on the terms.
    for (const k of ['esign', 'croa_disclosure', 'fcra_authorization'] as const) expect(isRendered(renderConsent(k, ctx({ terms: null }))), k).toBe(true);
  });

  it('records its full SHA-256 and keeps the version format; the text, and so the hash, changes with the day and with the terms', () => {
    const c = rendered('croa_contract');
    expect(c.sha256).toBe(createHash('sha256').update(c.text, 'utf8').digest('hex'));
    expect(c.version).toBe(`2026-11:${c.sha256.slice(0, 12)}`);
    expect(rendered('croa_contract', ctx({ today: '2026-11-26' })).sha256).not.toBe(c.sha256); // after midnight
    expect(rendered('croa_contract', ctx({ terms: { ...TERMS, duration: 'About 4 months.' } })).sha256).not.toBe(c.sha256); // terms edited
    expect(rendered('croa_contract').sha256).toBe(c.sha256); // and nothing else moves it
  });

  it('the consent to electronic records covers what § 7001(c)(1) asks for, and the authorization names the agency', () => {
    const e = rendered('esign').text;
    for (const part of [/Which records this covers/, /Paper copies are free/, /at no charge: send a message in your client portal, or write to Bright Path Credit LLC at 500 Bayshore Blvd/, /You may withdraw this consent/, /on paper by mail/, /Keeping your email address up to date/, /current web browser/, /email account/, /opens PDF files/, /open its PDF copy/]) expect(e).toMatch(part);
    expect(rendered('fcra_authorization').text).toContain('I authorize Bright Path Credit LLC to review the credit reports I provide');
    // The client-facing texts make no promise of a result (the contract's no-guarantee paragraph is the one exception, on purpose).
    for (const k of ['esign', 'croa_disclosure', 'fcra_authorization'] as const) expect(findBlockedClaims(rendered(k).text), k).toEqual([]);
  });
});

describe('the signing order', () => {
  it('in the portal: E-SIGN consent, then the statement, then the contract, then the authorization', () => {
    expect(SIGNING_ORDER).toEqual(['esign', 'croa_disclosure', 'croa_contract', 'fcra_authorization']);
    expect(REQUIRED_CONSENTS).toEqual([...SIGNING_ORDER]);
    expect(CONSENT_DOCS.filter((d) => d.required).map((d) => d.kind)).toEqual([...SIGNING_ORDER]);
    expect(signingOrderProblem('esign', [], 'client')).toBeNull();
    expect(signingOrderProblem('croa_disclosure', [], 'client')).toBe('esign');
    expect(signingOrderProblem('croa_contract', ['esign'], 'client')).toBe('croa_disclosure');
    expect(signingOrderProblem('fcra_authorization', ['esign', 'croa_disclosure'], 'client')).toBe('croa_contract');
    expect(signingOrderProblem('fcra_authorization', ['esign', 'croa_disclosure', 'croa_contract'], 'client')).toBeNull();
    // The optional two can be signed at any time.
    expect(signingOrderProblem('communications', [], 'client')).toBeNull();
    expect(signingOrderProblem('data_processing', [], 'client')).toBeNull();
  });

  it('on paper, recorded by staff: the statement before the contract and the contract before the authorization; no E-SIGN consent is needed for paper', () => {
    expect(signingOrderProblem('croa_disclosure', [], 'staff')).toBeNull();
    expect(signingOrderProblem('croa_contract', [], 'staff')).toBe('croa_disclosure');
    expect(signingOrderProblem('fcra_authorization', ['croa_disclosure'], 'staff')).toBe('croa_contract');
    expect(signingOrderProblem('esign', [], 'staff')).toBeNull();
  });

  it('only the statement, the contract and the authorization gate a dispute: withdrawing e-consent does not stop the service', () => {
    expect(SERVICE_CONSENTS).toEqual(['croa_disclosure', 'croa_contract', 'fcra_authorization']);
    expect(consentStatus([]).missing).toEqual(['croa_disclosure', 'croa_contract', 'fcra_authorization']);
  });
});

describe('the cancellation period, on the agency’s calendar day', () => {
  const NY = 'America/New_York';
  const contract = (signed_at: string) => [{ kind: 'croa_contract', signed_at, revoked_at: null }];
  it('runs through the third business day after signing, skipping weekends and federal holidays', () => {
    expect(cancellationEndsOn('2026-03-02')).toBe('2026-03-05'); // Monday → Thursday
    expect(cancellationEndsOn('2026-03-06')).toBe('2026-03-11'); // Friday → the weekend skipped → Wednesday
    expect(cancellationEndsOn('2026-11-25')).toBe('2026-12-01'); // Thanksgiving and the weekend skipped
    expect(cancellationEndsOn('2026-12-24')).toBe('2026-12-30'); // Christmas Day skipped
    expect(cancellationEndsOn('2027-07-02')).toBe('2027-07-08'); // Independence Day observed on Monday 5 July
  });

  it('still runs on the last day (it used to end a day early) and is over from the next morning', () => {
    const s = (now: string) => consentStatus(contract('2026-03-02T15:00:00Z'), new Date(now), NY);
    expect(s('2026-03-05T12:00:00Z')).toMatchObject({ inCancellationWindow: true, contractSignedOn: '2026-03-02', cancellationEndsOn: '2026-03-05' }); // Thursday
    expect(s('2026-03-06T04:59:00Z').inCancellationWindow).toBe(true); // 11:59 p.m. Thursday in New York
    expect(s('2026-03-06T05:01:00Z').inCancellationWindow).toBe(false); // 12:01 a.m. Friday
  });

  it('counts holidays: signed the day before Thanksgiving, the period runs into December', () => {
    const s = (now: string) => consentStatus(contract('2026-11-25T15:00:00Z'), new Date(now), NY);
    expect(s('2026-11-30T15:00:00Z').inCancellationWindow).toBe(true);
    expect(s('2026-12-01T15:00:00Z')).toMatchObject({ inCancellationWindow: true, cancellationEndsOn: '2026-12-01' });
    expect(s('2026-12-02T15:00:00Z').inCancellationWindow).toBe(false);
  });

  it('reads the signing day in the agency’s zone, not in UTC', () => {
    // 10:30 p.m. Monday in New York is already Tuesday in UTC: the period is counted from Monday.
    expect(consentStatus(contract('2026-03-03T03:30:00Z'), new Date('2026-03-04T15:00:00Z'), NY)).toMatchObject({ contractSignedOn: '2026-03-02', cancellationEndsOn: '2026-03-05' });
    expect(consentStatus(contract('2026-03-03T03:30:00Z'), new Date('2026-03-04T15:00:00Z'), 'UTC')).toMatchObject({ contractSignedOn: '2026-03-03', cancellationEndsOn: '2026-03-06' });
  });

  it('a revoked contract has no period, and the newest contract in force counts', () => {
    expect(consentStatus([{ kind: 'croa_contract', signed_at: '2026-03-02T15:00:00Z', revoked_at: '2026-03-03T15:00:00Z' }], new Date('2026-03-04T15:00:00Z'), NY).inCancellationWindow).toBe(false);
    const two = [...contract('2026-01-05T15:00:00Z'), ...contract('2026-03-02T15:00:00Z')];
    expect(consentStatus(two, new Date('2026-03-04T15:00:00Z'), NY).cancellationEndsOn).toBe('2026-03-05');
  });
});

describe('copies of what was signed (PDF)', () => {
  // A letter, exactly as before the bold font was added: the same bytes (hashes recorded before the change).
  const SAMPLE = `Jordan Rivera\n500 Test Avenue\nTampa, FL 33602\n\nNovember 20, 2026\n\nExperian\nP.O. Box 4500\nAllen, TX 75013\n\nRe: Request to investigate — “ACME BANK” ••1234 (Ñandú, café)\n\n${'This paragraph is long enough to wrap across several lines of the page so that the wrapping logic is exercised, with (parentheses) and a backslash \\ in it. '.repeat(6)}\n\n    Indented line\n\nSincerely,\n\nJordan Rivera\n` + 'Line\n'.repeat(80);
  const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

  it('letters render byte for byte as they did before', () => {
    expect(sha(renderPdf(SAMPLE, { title: 'Letter to Experian' }))).toBe('2ddb72100526765b89f711d31cc4ec70259269e5ce78683795c4c90fe69438d5');
    expect(sha(renderPdf(SAMPLE, { title: 'Draft', footerNote: 'DRAFT — not approved for sending' }))).toBe('84fe75f522e93c410a0c7ec2b98f73a277e834e8287b03fcc304cb7d735a86f9');
    expect(sha(renderPdf('', {}))).toBe('ba693197472986732b10f038064e79043fc807e629925ce55d5b9322ff5e31f0');
    expect(renderPdf(SAMPLE).toString('latin1')).not.toContain('Helvetica-Bold');
  });

  it('the contract copy: the stored text, the signature block under the bold statement, then the Notice of Cancellation twice, in bold', () => {
    const c = rendered('croa_contract');
    const row = { kind: 'croa_contract', text_shown: c.text, text_sha256: c.sha256, signed_name: 'Dana Whitfield', signed_at: '2026-11-25T15:04:00.000Z', ip: '203.0.113.7', recorded_by: null, revoked_at: null };
    // The stored text comes back with the same paragraphs in bold.
    expect(storedBlocks(c.text)).toEqual({ title: c.doc.title, blocks: c.blocks });
    const blocks = signedCopyBlocks(row, 'America/New_York', TERMS.legalName);
    const texts = blocks.map((b) => b.text);
    const statement = texts.indexOf(CROA_CANCEL_STATEMENT);
    expect(texts[statement + 1]).toBe('');
    expect(texts.slice(statement + 2, statement + 7).join('\n')).toMatch(/^_+\nSigned electronically by typing the name: Dana Whitfield\nDate and time: November 25, 2026 at 10:04 AM \(America\/New_York\)\nIP address: 203\.0\.113\.7\nFingerprint/);
    expect(texts.filter((t) => t === NOTICE_HEADING)).toHaveLength(2);
    expect(blocks.filter((b) => b.pageBreakBefore).map((b) => b.text)).toEqual(['Copy 1 of 2', 'Copy 2 of 2']);
    expect(blocks.filter((b) => b.text === NOTICE_HEADING || b.text === CROA_CANCEL_STATEMENT).every((b) => b.bold)).toBe(true);
    const pdf = renderPdfBlocks(blocks, { title: 'Service agreement (signed copy)' }).toString('latin1');
    expect(pdf.startsWith('%PDF-1.4')).toBe(true);
    expect(pdf).toContain('/BaseFont /Helvetica-Bold');
    expect(pdf.match(/\(Notice of Cancellation\) Tj/g)).toHaveLength(2);
    // Each bold paragraph is drawn with the bold font (F2) and the font goes back to F1 after it.
    expect(pdf).toMatch(/\/F2 11 Tf\n\(You may cancel this contract without penalty/);
    expect(pdf).toMatch(/\/F1 11 Tf\n\(\) Tj T\*\n\(_+\) Tj/);
  });

  it('a signature recorded by staff from paper says so, and gives no IP address as if the client had signed online', () => {
    const d = rendered('croa_disclosure');
    const text = signedCopyBlocks({ kind: 'croa_disclosure', text_shown: d.text, text_sha256: d.sha256, signed_name: 'Dana Whitfield', signed_at: '2026-11-25T15:04:00.000Z', ip: '10.0.0.9', recorded_by: 'staff-user', signed_on: '2026-11-23', revoked_at: null }, 'America/New_York', TERMS.legalName).map((b) => b.text).join('\n');
    expect(text).toContain('Acknowledgement, signed on paper: I received and read this statement.');
    expect(text).toContain('Bright Path Credit LLC staff recorded the paper signature on November 25, 2026');
    expect(text).toContain('Date written on the signed paper: November 23, 2026');
    expect(text).not.toContain('10.0.0.9');
    expect(readingCopyBlocks(d.doc.title, d.blocks)[0]).toEqual({ text: CROA_STATEMENT_TITLE });
  });
});

describe('the agency’s terms (Settings → Client agreement)', () => {
  const base = { legalName: TERMS.legalName, address: TERMS.address, services: TERMS.services, paymentTerms: TERMS.paymentTerms, totalCents: TERMS.totalCents, duration: TERMS.duration, additional: '' };
  it('accepts complete terms and round-trips through settings', () => {
    expect(termsIssue(base)).toBeNull();
    expect(parseTerms({ agreement: storedTerms(TERMS) })).toEqual(TERMS);
    expect(parseTerms({})).toBeNull();
    expect(parseTerms({ agreement: { ...storedTerms(TERMS), services: 'Too short' } })).toBeNull(); // incomplete reads as not saved
  });
  it('refuses a promise anywhere, an address that is not one, and a services line that is not a full description', () => {
    expect(termsIssue({ ...base, services: `${TERMS.services} We guarantee every collection will be deleted.` })).toMatch(/^Services: Results cannot be guaranteed/);
    expect(termsIssue({ ...base, duration: 'We fix your credit in 30 days' })).toMatch(/^How long the services should take:/);
    expect(termsIssue({ ...base, additional: 'We will boost your score by 100 points.' })).toMatch(/^Additional terms:/);
    expect(termsIssue({ ...base, address: 'Call us any time' })).toMatch(/^Principal business address:/);
    expect(termsIssue({ ...base, services: 'Credit repair.' })).toMatch(/^Services: describe the services in full/);
    expect(termsIssue({ ...base, totalCents: -1 })).toMatch(/^Total of all payments/);
  });
  it('reads a dollar amount', () => {
    expect(parseDollars('594.00')).toBe(59_400);
    expect(parseDollars('$1,200.50')).toBe(120_050);
    expect(parseDollars('594')).toBe(59_400);
    expect(parseDollars('59.4')).toBeNull();
    expect(parseDollars('abc')).toBeNull();
  });
});

describe('the welcome email and the welcome steps', () => {
  it('is warm, in the client’s language, carries the link, and makes no promise', () => {
    const en = welcomeEmail({ lang: 'en', fullName: 'Dana Whitfield', orgName: 'Bright Path Credit', link: 'https://app.example/invite/abc', signIn: 'https://app.example/portal/login?org=bright' });
    expect(en.text.split('\n')[0]).toBe('Hello Dana,');
    expect(en.text).toContain('https://app.example/invite/abc');
    expect(en.text).toContain('about 10 minutes');
    const es = welcomeEmail({ lang: 'es', fullName: 'Dana Whitfield', orgName: 'Bright Path Credit', link: 'https://app.example/invite/abc', signIn: 'https://app.example/portal/login?org=bright&lang=es' });
    expect(es.text.split('\n')[0]).toBe('Hola Dana:');
    expect(es.subject).toMatch(/bienvenida/);
    for (const m of [en, es]) expect(welcomeEmailIssue(m)).toBeNull();
    expect(welcomeEmailIssue(welcomeEmail({ lang: 'en', fullName: 'Dana', orgName: 'Guaranteed Credit Fix', link: 'x', signIn: 'y' }))).toMatch(/Results cannot be guaranteed/);
  });

  it('works out the current step from the records only', () => {
    const address = { line1: '9 Elm St', city: 'Dayton', state: 'OH', zip: '45402' };
    // Signatures of the current documents, with their text stored, as every signature since migration 0031 is.
    const signed = (...kinds: string[]) => kinds.map((kind) => ({ kind, version: `${CONSENT_DOCS.find((x) => x.kind === kind)!.version}:0123456789ab`, has_text: true, recorded_by: null, revoked_at: null }));
    const none = onboarding({ address: null, hasDob: false, hasSsn: false, signatures: [], documents: { provided: 0, total: 3 } });
    expect(none).toMatchObject({ current: 'details', complete: false, stepsDone: 0, details: { missing: ['address', 'dob', 'ssn'] }, agreements: { signed: 0, total: 4, next: 'esign' } });
    const signing = onboarding({ address, hasDob: true, hasSsn: true, signatures: signed('esign', 'croa_disclosure', 'communications'), documents: { provided: 1, total: 3 } });
    expect(signing).toMatchObject({ current: 'agreements', agreements: { signed: 2, next: 'croa_contract', done: false }, stepsDone: 1 });
    const docs = onboarding({ address, hasDob: true, hasSsn: true, signatures: signed(...SIGNING_ORDER), documents: { provided: 2, total: 3 } });
    expect(docs).toMatchObject({ current: 'documents', complete: false, stepsDone: 2 });
    expect(onboarding({ address, hasDob: true, hasSsn: true, signatures: signed(...SIGNING_ORDER), documents: { provided: 3, total: 3 } })).toMatchObject({ current: 'done', complete: true, stepsDone: 3 });
  });

  it('every new portal string exists in Spanish, and the agreement titles match the documents', () => {
    for (const k of ['wl_title', 'wl_done_title', 'wl_done_period', 'cx_body', 'inv_usedBody', 'a_changed', 'wl_a_canRead', 'wl_a_received'] as const) {
      expect(tr('es')(k), k).toMatch(/\S/);
      expect(tr('es')(k), k).not.toBe(tr('en')(k));
    }
    expect(tr('en')('a_changed')).toBe('This agreement changed since you opened it. Please read it again.');
    for (const k of ['wl_hero_b', 'wl_done_title', 'wl_done_period', 'inv_stepsTime', 'cx_body'] as const) expect(findBlockedClaims(tr('en')(k)), k).toEqual([]);
  });
});

describe('the authorization in a personal workspace', () => {
  const base = { agencyName: 'Pat Self', terms: null, clientName: 'Pat Self', today: '2026-11-20' };
  const text = (personal: boolean) => {
    const r = renderConsent('fcra_authorization', { ...base, personal });
    if (!isRendered(r)) throw new Error('not rendered');
    return r.text;
  };
  it('names the software and the report provider the person connects, for their own reports, not their own workspace as an agency', () => {
    const own = text(true);
    expect(own).toContain(`I authorize ${PRODUCT.name}, the software I use to work on my own credit, and any credit report provider I connect in it, to obtain my own credit reports and scores when I ask`);
    expect(own).toContain('I decide whether to send each dispute.');
    expect(own).not.toContain('I authorize Pat Self');
  });
  it('is unchanged for an agency client', () => {
    expect(text(false)).toContain('I authorize Pat Self to review the credit reports I provide, and to prepare and, with my approval, submit disputes');
  });
});
