import { describe, expect, it } from 'vitest';
import { clientCancelledOn, type SignatureRow } from '@/lib/agreements';
import { findBlockedClaims } from '@/lib/compliance/claims';
import { SIGNING_ORDER, type ConsentKind } from '@/lib/compliance/disclosures';
import { onboarding, type OnboardingInput } from '@/lib/onboarding';
import { fill, portalMessage, tr, type PortalKey } from '@/lib/portal-i18n';
import { portalHero } from '@/lib/portal-next-step';
import { providerError } from '@/lib/welcome-link';

/**
 * The client's screens after the review (fixer 2): the pure rules behind them. LEG-10/EXP-3 (a cancelled agreement is
 * a state of its own), LEG-6/EXP-2 (gentler asks while work goes on; the investigation keeps the hero), EXP-5 (the
 * agreement waits for the agency), EXP-7 (the provider's error) and EXP-9 (the other-portal message, translated).
 */
const current = (kind: ConsentKind, extra: Partial<SignatureRow> = {}): SignatureRow => ({ kind, version: '2026-11:abcdef012345', has_text: true, recorded_by: null, revoked_at: null, ...extra });
const draft = (kind: ConsentKind, extra: Partial<SignatureRow> = {}): SignatureRow => ({ kind, version: '2026-01-draft:abcdef012345', has_text: false, recorded_by: null, revoked_at: null, ...extra });
const address = { line1: '9 Elm St', city: 'Dayton', state: 'OH', zip: '45402' };
const ready = (o: Partial<OnboardingInput> = {}) => onboarding({ address, hasDob: true, hasSsn: true, signatures: [], documents: { provided: 3, total: 3 }, ...o });
const all = SIGNING_ORDER.map((k) => current(k));

describe('LEG-10 / EXP-3: a service agreement the client cancelled is a state of its own', () => {
  it('nothing is asked next: no signature, no details, no documents', () => {
    const signatures = [current('esign'), current('croa_disclosure'), current('croa_contract', { revoked_at: '2026-11-20T15:00:00.000Z' }), current('fcra_authorization')];
    const ob = ready({ signatures, cancelledOn: '2026-11-20', documents: { provided: 0, total: 3 }, hasDob: false });
    expect(ob).toMatchObject({ ask: null, agreements: { cancelledOn: '2026-11-20', next: 'croa_contract', asked: [] } });
    // A contract revoked by staff (re-papering) is no cancellation: the client is asked to sign it.
    expect(ready({ signatures }).ask).toEqual({ step: 'agreements', next: 'croa_contract', needed: true });
  });

  it('the day it was cancelled, on the agency’s calendar, while no agreement is in force since', () => {
    const NY = 'America/New_York';
    const row = (o: { signed_at: string; revoked_at?: string | null; revoked_reason?: string | null }) => ({ kind: 'croa_contract', revoked_at: null, revoked_reason: null, ...o });
    // 03:00 UTC on 21 November is still 20 November in New York.
    const cancelled = row({ signed_at: '2026-11-19T15:00:00.000Z', revoked_at: '2026-11-21T03:00:00.000Z', revoked_reason: 'client_cancelled' });
    expect(clientCancelledOn([cancelled], NY)).toBe('2026-11-20');
    expect(clientCancelledOn([{ ...cancelled, revoked_reason: 'staff' }], NY)).toBeNull();
    // Signed again since: the latest is in force.
    expect(clientCancelledOn([row({ signed_at: '2026-11-22T15:00:00.000Z' }), cancelled], NY)).toBeNull();
    // An older cancellation under a newer agreement revoked by staff is not the client's.
    expect(clientCancelledOn([row({ signed_at: '2026-11-25T15:00:00.000Z', revoked_at: '2026-11-26T15:00:00.000Z', revoked_reason: 'staff' }), cancelled], NY)).toBeNull();
    expect(clientCancelledOn([{ kind: 'esign', signed_at: '2026-11-19T15:00:00.000Z', revoked_at: '2026-11-20T15:00:00.000Z', revoked_reason: 'client_cancelled' }], NY)).toBeNull();
  });

  it('the portal home leads with it, whatever else is going on', () => {
    expect(portalHero({ cancelledOn: '2026-11-20', ask: null, next: { key: 'wait', mine: false } })).toEqual({ kind: 'cancelled', on: '2026-11-20' });
  });
});

describe('LEG-6 / EXP-2: while the documents the service needs are in force, what is left is asked gently', () => {
  it('a client on the 2026-01 drafts: the E-SIGN consent, then the current statement, never "needed"', () => {
    const old = [draft('croa_disclosure'), draft('croa_contract'), draft('fcra_authorization')];
    expect(ready({ signatures: old })).toMatchObject({ ask: { step: 'agreements', next: 'esign', needed: false }, agreements: { serviceInForce: true, done: false } });
    expect(ready({ signatures: [...old, current('esign')] }).ask).toEqual({ step: 'agreements', next: 'croa_disclosure', needed: false });
    expect(ready({ signatures: [...old, current('esign'), current('croa_disclosure')] })).toMatchObject({ ask: null, complete: true });
    // A consent to electronic records staff recorded (before LEG-11) does not count either, and is asked gently.
    expect(ready({ signatures: [current('esign', { recorded_by: 'u1' }), ...SIGNING_ORDER.slice(1).map((k) => current(k))] }).ask).toEqual({ step: 'agreements', next: 'esign', needed: false });
  });

  it('once the old agreement is revoked, the agreement is needed again, after the current statement', () => {
    const repapered = [draft('croa_disclosure'), draft('croa_contract', { revoked_at: '2026-11-19T15:00:00.000Z' }), draft('fcra_authorization'), current('esign')];
    expect(ready({ signatures: repapered })).toMatchObject({ ask: { step: 'agreements', next: 'croa_disclosure', needed: true }, agreements: { serviceInForce: false } });
    expect(ready({ signatures: [...repapered, current('croa_disclosure')] }).ask).toEqual({ step: 'agreements', next: 'croa_contract', needed: true });
  });

  it('a consent to electronic records the client withdrew is not asked for again while the service goes on', () => {
    const withdrawn = [current('esign', { revoked_at: '2026-11-19T15:00:00.000Z' }), ...SIGNING_ORDER.slice(1).map((k) => current(k))];
    expect(ready({ signatures: withdrawn })).toMatchObject({ ask: null, complete: false, agreements: { next: 'esign', asked: [] } });
    // Without a service agreement in force, it is asked (signing in the portal starts with it).
    expect(ready({ signatures: withdrawn.filter((r) => r.kind !== 'croa_contract') }).ask).toEqual({ step: 'agreements', next: 'esign', needed: true });
  });

  it('an investigation keeps the hero; the welcome asks are listed below it', () => {
    const ask = { step: 'agreements', next: 'esign', needed: false } as const;
    expect(portalHero({ cancelledOn: null, ask, next: { key: 'wait', mine: false } })).toEqual({ kind: 'next', key: 'wait', mine: false });
    expect(portalHero({ cancelledOn: null, ask, next: { key: 'review', mine: false } })).toEqual({ kind: 'next', key: 'review', mine: false });
    expect(portalHero({ cancelledOn: null, ask, next: { key: 'prep', mine: false } })).toEqual({ kind: 'welcome', ask });
    expect(portalHero({ cancelledOn: null, ask: null, next: { key: 'done', mine: false } })).toEqual({ kind: 'next', key: 'done', mine: false });
  });
});

describe('EXP-5: before the agency saves its terms', () => {
  it('the client does what they can, then waits for the agency; the agreement and the authorization are being prepared', () => {
    const signatures = [current('esign'), current('croa_disclosure')];
    const docsToDo = ready({ signatures, contractReady: false, documents: { provided: 1, total: 3 } });
    expect(docsToDo).toMatchObject({
      ask: { step: 'documents' }, current: 'agreements',
      agreements: { next: 'croa_contract', nextReady: false, asked: [{ kind: 'croa_contract', ready: false }, { kind: 'fcra_authorization', ready: false }] },
    });
    expect(ready({ signatures, contractReady: false }).ask).toEqual({ step: 'waiting' });
    // Waiting is the agency's: a document the team asked the client for comes first on the portal home.
    expect(portalHero({ cancelledOn: null, ask: { step: 'waiting' }, next: { key: 'upload', mine: true } })).toEqual({ kind: 'next', key: 'upload', mine: true });
    expect(portalHero({ cancelledOn: null, ask: { step: 'waiting' }, next: { key: 'prep', mine: false } })).toEqual({ kind: 'welcome', ask: { step: 'waiting' } });
    // The documents before the agreement can still be signed while it is prepared.
    expect(ready({ signatures: [], contractReady: false }).agreements.asked).toEqual([
      { kind: 'esign', ready: true }, { kind: 'croa_disclosure', ready: true }, { kind: 'croa_contract', ready: false }, { kind: 'fcra_authorization', ready: false }]);
    expect(ready({ signatures: [], contractReady: false }).ask).toEqual({ step: 'agreements', next: 'esign', needed: true });
    // Once the terms are saved it is asked like any other.
    expect(ready({ signatures }).ask).toEqual({ step: 'agreements', next: 'croa_contract', needed: true });
    expect(ready({ signatures: all })).toMatchObject({ ask: null, complete: true });
  });
});

describe('the words', () => {
  it('every new string exists in Spanish, differs from the English, and promises nothing', () => {
    const keys: PortalKey[] = ['cx_badge', 'cx_done_t', 'cx_done_b', 'cx_copy', 'cx_resign', 'cx_resignNote', 'pr_cancelled', 'pr_withdrawn', 'pr_earlier',
      'ns_esign_t', 'ns_esign_b', 'ns_update_t', 'ns_update_b', 'ns_prepAg_t', 'ns_prepAg_b', 'ns_prepItem', 'wl_a_updated', 'wl_a_notReady', 'wl_a_notReadyDocs', 'e_otherPortal'];
    for (const k of keys) {
      expect(tr('es')(k), k).toMatch(/\S/);
      expect(tr('es')(k), k).not.toBe(tr('en')(k));
      expect(findBlockedClaims(tr('en')(k)), k).toEqual([]);
    }
    // The gentle asks never say work cannot start; the agreement in preparation promises no message.
    for (const k of ['ns_esign_b', 'ns_update_b'] as const) expect(tr('en')(k)).toContain('This does not pause the work on your file.');
    for (const k of ['wl_a_notReady', 'ns_prepAg_b'] as const) expect(tr('en')(k)).not.toMatch(/let you know|notify|we.ll tell/i);
    expect(fill(tr('es')('cx_done_b'), { date: '20 de noviembre de 2026', org: 'Bright Path Credit LLC' })).toBe('Usted canceló su contrato de servicios el 20 de noviembre de 2026. Su aviso se envió a Bright Path Credit LLC.');
  });

  it('EXP-9: the other-portal refusal reaches the client in their language, with the inviting agency’s name', () => {
    const m = 'This email already has a client portal with another company. Ask Bright Path Credit to use a different email.';
    expect(portalMessage('en', m)).toBe(m);
    expect(portalMessage('es', m)).toBe('Este correo ya tiene un portal de cliente con otra empresa. Pida a Bright Path Credit que use otro correo.');
    expect(portalMessage('es', 'This invitation is invalid or has expired.')).toBe(tr('es')('e_inviteInvalid'));
  });

  it('EXP-7: a provider’s error loses its closing full stop before ". Nothing was sent"', () => {
    expect(`Could not send the email: ${providerError('The to address is invalid.')}. Nothing was sent`).toBe('Could not send the email: The to address is invalid. Nothing was sent');
    expect(providerError('Invalid `to` field. ')).toBe('Invalid `to` field');
    expect(providerError('rate limited')).toBe('rate limited');
    expect(providerError(undefined)).toBe('delivery failed');
    expect(providerError(' . ')).toBe('delivery failed');
  });
});
