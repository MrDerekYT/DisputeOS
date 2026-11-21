import { describe, expect, it } from 'vitest';
import {
  agreementProgress, countsAsSigned, notReadyMessage, paperDateProblem, paperDateRange, revokeConfirmation, sentDateRefusal, serviceRefusal, type ServiceStatus, type SignatureRow,
} from '@/lib/agreements';
import { chargeEligibility } from '@/lib/billing/eligibility';
import { cancellationEndsOn } from '@/lib/business-days';
import type { AgreementTerms } from '@/lib/compliance/agreement-terms';
import { copyTitle, paperNote, signedCopyBlocks } from '@/lib/compliance/consent-pdf';
import { CONSENT_DOCS, consentStatus, contractPeriod, isCurrentSignature, isDraftEraSignature, isRendered, renderConsent, signatureSource, signingOrderProblem, type RenderedConsent } from '@/lib/compliance/disclosures';
import { encryptPII } from '@/lib/crypto';
import { storedDob } from '@/lib/letters/brief-load';
import { isRealDay } from '@/lib/real-day';

/**
 * The gates in front of the service and what the records say about signatures, without a database: findings LEG-1,
 * LEG-2, LEG-4, LEG-6, LEG-7, LEG-8, LEG-11, LEG-12, EXP-6 and SEC-5 of the review.
 */
const NY = 'America/New_York';
const version = (kind: string) => `${CONSENT_DOCS.find((d) => d.kind === kind)!.version}:0123456789ab`;
const sig = (kind: string, o: Partial<SignatureRow> = {}): SignatureRow => ({ kind, version: version(kind), has_text: true, recorded_by: null, revoked_at: null, ...o });
/** A signature from before migration 0031: the 2026-01 draft, no stored text. */
const draft = (kind: string, o: Partial<SignatureRow> = {}): SignatureRow => sig(kind, { version: '2026-01-draft:0123456789ab', has_text: false, ...o });

describe('SEC-5: a date is real only when it reads back unchanged', () => {
  it('refuses the days JavaScript rolls over into the next month, and anything not shaped YYYY-MM-DD', () => {
    for (const d of ['2000-02-31', '2001-02-29', '2000-04-31', '2000-02-32', '2000-13-01', '2000-00-10', '2000-2-3', '', 'yesterday']) expect(isRealDay(d), d).toBe(false);
    for (const d of ['2000-02-29', '2001-02-28', '1985-03-03', '2026-12-31']) expect(isRealDay(d), d).toBe(true);
  });

  it('a stored impossible date of birth reads as not on file, so the letter prints the marked line instead of 2 March 2000', () => {
    expect(storedDob(encryptPII('2000-02-31'))).toBeNull();
    expect(storedDob(encryptPII('1985-03-03'))).toBe('1985-03-03');
    expect(storedDob(null)).toBeNull();
  });
});

describe('LEG-6: what counts as signed, and what is signed next (one function for the portal, the staff card and signing)', () => {
  it('the four current agreements in order; optional ones never stand in the way', () => {
    expect(agreementProgress([])).toEqual({ signed: [], count: 0, total: 4, next: 'esign' });
    expect(agreementProgress([sig('esign'), sig('communications')])).toMatchObject({ count: 1, next: 'croa_disclosure' });
    expect(agreementProgress(['esign', 'croa_disclosure', 'croa_contract', 'fcra_authorization'].map((k) => sig(k)))).toMatchObject({ count: 4, next: null });
    expect(agreementProgress([sig('esign'), sig('croa_disclosure', { revoked_at: '2026-11-01T00:00:00Z' })])).toMatchObject({ next: 'croa_disclosure' });
  });

  it('a statement signed on the 2026-01 draft does not count, so a re-papered client signs the current statement before the new agreement', () => {
    // The old agreement was revoked by staff; the old statement and authorization are still in force.
    const rows = [sig('esign'), draft('croa_disclosure'), draft('croa_contract', { revoked_at: '2026-11-19T15:00:00Z' }), draft('fcra_authorization')];
    const p = agreementProgress(rows);
    expect(p.next).toBe('croa_disclosure');
    expect(p.signed).toEqual(['esign', 'fcra_authorization']);
    // So signing the agreement is refused until the current statement is signed, in the portal and on paper.
    expect(signingOrderProblem('croa_contract', p.signed, 'client')).toBe('croa_disclosure');
    expect(signingOrderProblem('croa_contract', p.signed, 'staff')).toBe('croa_disclosure');
    // Once it is, the agreement is next.
    expect(agreementProgress([...rows, sig('croa_disclosure')]).next).toBe('croa_contract');
  });

  it('an old agreement still in force counts (staff revoke it to replace it); a staff-recorded or old E-SIGN consent does not', () => {
    expect(countsAsSigned(draft('croa_contract'))).toBe(true);
    expect(countsAsSigned(draft('fcra_authorization'))).toBe(true);
    expect(countsAsSigned(draft('esign'))).toBe(false);
    expect(countsAsSigned(sig('esign', { recorded_by: 'staff-user' }))).toBe(false);
    expect(countsAsSigned(sig('esign'))).toBe(true);
    expect(isCurrentSignature({ kind: 'croa_disclosure', version: version('croa_disclosure'), has_text: false })).toBe(false);
  });

  it('flags for staff only a statement or agreement in force that was signed before the current documents', () => {
    expect(isDraftEraSignature({ kind: 'croa_contract', has_text: false, revoked_at: null })).toBe(true);
    expect(isDraftEraSignature({ kind: 'croa_disclosure', has_text: false, revoked_at: null })).toBe(true);
    expect(isDraftEraSignature({ kind: 'croa_contract', has_text: false, revoked_at: '2026-11-01T00:00:00Z' })).toBe(false);
    expect(isDraftEraSignature({ kind: 'croa_contract', has_text: true, revoked_at: null })).toBe(false);
    expect(isDraftEraSignature({ kind: 'fcra_authorization', has_text: false, revoked_at: null })).toBe(false);
  });
});

describe('LEG-8 and LEG-7: the days of a service agreement', () => {
  it('a later change of the agency’s time zone never shortens the period: the last day stored at signing holds', () => {
    // Signed Monday 2026-11-16 at 00:30 in New York (Sunday 21:30 in Los Angeles); the Notice says November 19.
    const row = { kind: 'croa_contract', signed_at: '2026-11-16T05:30:00Z', revoked_at: null, signed_on: '2026-11-16', cancellation_ends_on: '2026-11-19' };
    expect(contractPeriod(row, 'America/Los_Angeles')).toEqual({ signedOn: '2026-11-16', endsOn: '2026-11-19' });
    // Without the stored days (a row from before migration 0031) the day is counted again, in the zone given.
    expect(contractPeriod({ ...row, signed_on: null, cancellation_ends_on: null }, 'America/Los_Angeles')).toEqual({ signedOn: '2026-11-15', endsOn: '2026-11-18' });
    // So on Thursday the 19th, the last day printed on the client's notice, the client can still cancel.
    expect(consentStatus([row], new Date('2026-11-19T20:00:00Z'), 'America/Los_Angeles')).toMatchObject({ inCancellationWindow: true, cancellationEndsOn: '2026-11-19' });
    // A stored day earlier than the one counted again is never used to shorten it either.
    expect(contractPeriod({ ...row, cancellation_ends_on: '2026-11-17' }, NY).endsOn).toBe('2026-11-19');
  });

  it('a paper agreement: its period runs from the date written on the paper, however late staff record it', () => {
    // Signed on paper on Monday 16 November, recorded by staff on Thursday 19 November: the period ran through the 19th,
    // as the Notice of Cancellation stored with it says (15 U.S.C. § 1679e(a): from the date of the transaction).
    const paper = { kind: 'croa_contract', signed_at: '2026-11-19T15:00:00Z', revoked_at: null, signed_on: '2026-11-16', cancellation_ends_on: cancellationEndsOn('2026-11-16') };
    expect(paper.cancellation_ends_on).toBe('2026-11-19');
    expect(contractPeriod(paper, NY)).toEqual({ signedOn: '2026-11-16', endsOn: '2026-11-19' });
    expect(contractPeriod({ ...paper, cancellation_ends_on: null }, NY).endsOn).toBe('2026-11-19');
    expect(consentStatus([paper], new Date('2026-11-20T15:00:00Z'), NY)).toMatchObject({ inCancellationWindow: false, contractSignedOn: '2026-11-16', cancellationEndsOn: '2026-11-19' });
    // An existing client's agreement signed on paper in June and recorded in November: its period ended in June, so
    // the client is not told they can still cancel and a letter really sent in July can be recorded (sentDateRefusal).
    const june = { ...paper, signed_at: '2026-11-20T15:00:00Z', signed_on: '2026-06-01', cancellation_ends_on: cancellationEndsOn('2026-06-01') };
    expect(contractPeriod(june, NY)).toEqual({ signedOn: '2026-06-01', endsOn: '2026-06-04' });
    expect(consentStatus([june], new Date('2026-11-20T15:00:00Z'), NY)).toMatchObject({ inCancellationWindow: false, cancellationEndsOn: '2026-06-04' });
  });

  it('the paper date: a real day, not in the future, not more than a year back', () => {
    const now = new Date('2026-11-20T15:00:00Z');
    expect(paperDateProblem(undefined, '2026-11-20', now)).toBe('Enter the date written on the signed paper.');
    expect(paperDateProblem('2026-02-30', '2026-11-20', now)).toMatch(/as a real date/);
    expect(paperDateProblem('2026-11-21', '2026-11-20', now)).toMatch(/cannot be in the future/);
    expect(paperDateProblem('2025-11-18', '2026-11-20', now)).toMatch(/more than a year ago/);
    expect(paperDateProblem('2026-11-20', '2026-11-20', now)).toBeNull();
    expect(paperDateProblem('2025-11-20', '2026-11-20', now)).toBeNull();
    // Late in the evening in the agency's zone the UTC day is already tomorrow: a paper dated that day is not refused.
    expect(paperDateProblem('2026-11-21', '2026-11-20', new Date('2026-11-21T02:00:00Z'))).toBeNull();
    expect(paperDateRange('2026-11-20', now)).toEqual({ min: '2025-11-19', max: '2026-11-20' });
  });
});

describe('LEG-1, LEG-2, LEG-4: the gate in front of the service', () => {
  const status = (o: Partial<ServiceStatus> = {}): ServiceStatus => ({
    missing: [], inCancellationWindow: false, contractSignedOn: '2026-11-09', cancellationEndsOn: '2026-11-13', clientName: 'Pat Lee', personal: false, clientCancelledOn: null, tz: NY, ...o,
  });

  it('no service without the documents in force; an agreement the client cancelled says so', () => {
    expect(serviceRefusal(status({ missing: ['croa_contract'] }), 'send')).toBe('Required consents are missing for this client: croa contract. Record them before recording a letter as sent.');
    expect(serviceRefusal(status({ missing: ['croa_contract'] }), 'submit')).toBe('Required consents are missing for this client: croa contract. Record them before submitting.');
    expect(serviceRefusal(status({ missing: ['croa_contract'], clientCancelledOn: '2026-11-10' }), 'send')).toMatch(/^Pat Lee cancelled their service agreement on Nov 10, 2026, so no service may be provided under it\. Required consents are missing/);
    expect(serviceRefusal(status({ inCancellationWindow: true }), 'send')).toMatch(/^Pat Lee can still cancel their service agreement: the cancellation period runs through Nov 13, 2026\. No letter can be recorded as sent before it ends/);
    expect(serviceRefusal(status(), 'send')).toBeNull();
  });

  it('no sent date before the agreement was signed or inside its cancellation period; the message names the days and asks for the real one', () => {
    const s = status();
    const before = sentDateRefusal(s, '2026-11-06', 'send')!;
    expect(before).toBe('The date sent, Nov 6, 2026, is before Pat Lee signed the service agreement in force (Nov 9, 2026). No service may be provided before the agreement is signed (15 U.S.C. § 1679d(a)(1)), so this letter cannot be recorded as sent on that day. Record the date it was really sent.');
    for (const day of ['2026-11-09', '2026-11-13']) {
      expect(sentDateRefusal(s, day, 'submit')).toMatch(/is within the cancellation period of the service agreement Pat Lee signed on Nov 9, 2026, which ran through Nov 13, 2026\. .* so this dispute cannot be recorded as submitted on that day\. Record the date it was really sent\.$/);
    }
    // It never proposes another date.
    expect(before).not.toMatch(/after|instead|choose|pick|enter a date/i);
    expect(sentDateRefusal(s, '2026-11-14', 'send')).toBeNull();
  });

  it('a personal workspace has no gate at all', () => {
    const p = status({ personal: true, missing: [], contractSignedOn: null, cancellationEndsOn: null });
    expect(serviceRefusal(p, 'send')).toBeNull();
    expect(sentDateRefusal(p, '2020-01-01', 'submit')).toBeNull();
  });
});

describe('EXP-8 (a): revoking says that disputes stop only for the documents that gate them', () => {
  it('the statement, the agreement and the authorization stop the service; the E-SIGN consent and optional ones do not; nothing does in a personal workspace', () => {
    for (const k of ['croa_disclosure', 'croa_contract', 'fcra_authorization'] as const) expect(revokeConfirmation(k), k).toMatch(/no dispute can be submitted and no letter recorded as sent for this client until it is signed again\.$/);
    for (const k of ['esign', 'communications', 'data_processing'] as const) expect(revokeConfirmation(k), k).toMatch(/cannot be restored\.$/);
    expect(revokeConfirmation('esign')).toBe('Revoke “Consent to electronic records and signatures”? The signed record is marked revoked and cannot be restored.');
    expect(revokeConfirmation('fcra_authorization', true)).toMatch(/cannot be restored\.$/);
  });
});

describe('EXP-6: the "terms not saved" message fits who reads it', () => {
  it('owners and admins are sent to Settings; others are told to ask an owner or admin; New client says how to go on now', () => {
    expect(notReadyMessage(true)).toBe('Your client agreement terms are not saved yet, so the service agreement cannot be recorded. Save them in Settings → Client agreement first.');
    expect(notReadyMessage(false)).toBe('Your client agreement terms are not saved yet, so the service agreement cannot be recorded. Ask an owner or admin to save them in Settings → Client agreement.');
    expect(notReadyMessage(false, true)).toMatch(/Ask an owner or admin .* Or untick the service agreement and the authorization to create the client now, and record them once the terms are saved\.$/);
  });
});

describe('LEG-7: a paper signature’s copy is the app’s text when it was recorded, and says so', () => {
  const TERMS: AgreementTerms = {
    legalName: 'Bright Path Credit LLC', address: '500 Bayshore Blvd, Suite 210, Tampa, FL 33606',
    services: 'We review your three credit reports with you, prepare dispute letters for the items you choose, and track each investigation.',
    paymentTerms: 'A monthly fee of $99.00, charged for the work fully performed in the month before.', totalCents: 59_400, duration: 'About 6 months.', additional: '', updatedAt: '', updatedBy: '',
  };
  // Signed on paper on Monday 16 November and recorded on Thursday 19 November: the app's text, dated the 16th.
  const contract = renderConsent('croa_contract', { agencyName: TERMS.legalName, terms: TERMS, clientName: 'Dana Whitfield', today: '2026-11-16' });
  const c = (isRendered(contract) ? contract : null) as RenderedConsent;
  const row = { kind: 'croa_contract', text_shown: c.text, text_sha256: c.sha256, signed_name: 'Dana Whitfield', signed_at: '2026-11-19T15:00:00.000Z', ip: '10.0.0.9', recorded_by: 'staff-user', signed_on: '2026-11-16', revoked_at: null };

  it('title, the note above the text and the signature block: the app’s text on the recording day, the date on the paper, never a signed copy', () => {
    expect(copyTitle('croa_contract', 'paper')).toBe("Service agreement (app's text when the paper signature was recorded, not a copy of the paper)");
    expect(copyTitle('croa_contract')).toBe('Service agreement (signed copy)');
    expect(paperNote(row, NY, TERMS.legalName)).toBe("This is not a copy of the paper the client signed. It is the text of this document as it was in the app on November 19, 2026, the day Bright Path Credit LLC staff recorded the client's paper signature. The paper is dated November 16, 2026: the date of this agreement and the last day to cancel in its Notice of Cancellation are counted from that date. The signed paper itself is the record of what the client signed.");
    expect(paperNote({ ...row, kind: 'fcra_authorization' }, NY, TERMS.legalName)).toMatch(/recorded the client's paper signature\. The paper is dated November 16, 2026\. The signed paper itself/);
    // The text is dated with the date on the paper, and its Notice gives the last day counted from it.
    expect(c.text).toContain('Date: November 16, 2026');
    expect(c.text).toContain('before midnight on November 19, 2026');
    const texts = signedCopyBlocks(row, NY, TERMS.legalName).map((b) => b.text);
    expect(texts[0]).toBe(paperNote(row, NY, TERMS.legalName));
    expect(texts[2]).toBe('Service agreement');
    const all = texts.join('\n');
    expect(all).toContain('Signed on paper by: Dana Whitfield');
    expect(all).toContain('Date written on the signed paper: November 16, 2026');
    expect(all).toContain("The text above is the app's text on that day, not a copy of the paper.");
    expect(all).toContain(`Fingerprint of the app's stored text (SHA-256): ${c.sha256}`);
    expect(all).not.toMatch(/signed copy|copy of the signed text|10\.0\.0\.9/);
  });

  it('in a personal workspace the account holder’s own consent is labelled as given by them, with no paper wording', () => {
    const auth = renderConsent('fcra_authorization', { agencyName: 'Robin', terms: null, clientName: 'Robin Self', today: '2026-11-19' });
    const a = (isRendered(auth) ? auth : null) as RenderedConsent;
    const own = { kind: 'fcra_authorization', text_shown: a.text, text_sha256: a.sha256, signed_name: 'Robin Self', signed_at: '2026-11-19T15:00:00.000Z', ip: '10.0.0.9', recorded_by: 'owner-user', signed_on: '2026-11-19', revoked_at: null };
    expect(signatureSource(own, true)).toBe('self');
    expect(signatureSource(own, false)).toBe('paper');
    expect(signatureSource({ recorded_by: null }, false)).toBe('portal');
    expect(copyTitle('fcra_authorization', 'self')).toBe('Authorization to review credit reports and dispute on my behalf (given by the account holder)');
    const texts = signedCopyBlocks(own, NY, 'Robin', 'self').map((b) => b.text);
    expect(texts[0]).toBe('Authorization to review credit reports and dispute on my behalf');
    const all = texts.join('\n');
    expect(all).toContain('Given by the account holder, in their own workspace, by typing the name: Robin Self');
    expect(all).toContain('IP address: 10.0.0.9');
    expect(all).toContain(`Fingerprint of the stored text (SHA-256): ${a.sha256}`);
    expect(all).not.toMatch(/paper|staff|signed copy/i);
  });
});

describe('LEG-12 and LEG-8: the charge check uses the agreement’s own last day', () => {
  it('the hold never lifts before the last day stored with the agreement', () => {
    const base = { chargeDate: '2026-11-19', period: { from: '2026-11-01', to: '2026-11-30' }, clientStatus: 'active', soldByPhone: false, lettersSentOn: ['2026-11-18'] };
    // Counted again from a signing day one day earlier (another zone), the period would be over on the 19th.
    expect(chargeEligibility({ ...base, contractSignedOn: '2026-11-15' }).reasons.map((r) => r.code)).toEqual([]);
    const held = chargeEligibility({ ...base, contractSignedOn: '2026-11-15', contractCancellationEndsOn: '2026-11-19' });
    expect(held.reasons.map((r) => r.code)).toEqual(['cancellation_window']);
    expect(held.cancellationEndsOn).toBe('2026-11-19');
  });
});
