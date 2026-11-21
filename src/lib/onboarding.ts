/**
 * Where a client stands in the welcome steps, worked out from their records only (there is no progress column). The
 * one helper behind the portal's welcome page, the portal home, Profile and the staff "Welcome link" card.
 *
 *   1. details      a mailing address, a date of birth and a Social Security number on file
 *   2. agreements   the four required agreements signed, in the signing order of src/lib/agreements.ts
 *                   (agreementProgress: what counts as signed and which one is next)
 *   3. documents    the three required identity documents uploaded (accepted or waiting for review)
 *   4. done
 *
 * Beside the steps, `ask` is what the portal asks of the client now (the portal home's hero, Profile), or nothing:
 *  - a client who cancelled their service agreement in the portal (15 U.S.C. § 1679e) and has signed none since is in
 *    a state of their own: nothing is asked of them as a next step. Signing a new agreement stays possible, from Profile.
 *  - while every document the service needs is in force (SERVICE_CONSENTS), what is left (the consent to electronic
 *    records, or the current version of the statement) is asked gently: work does not wait for it. A consent to
 *    electronic records the client withdrew is not asked for again.
 *  - the service agreement cannot be signed before the agency has saved its terms: the client is not asked to sign it,
 *    but to do what they can meanwhile, and then to wait for the agency.
 */
import type { Db } from './db';
import { agreementProgress, clientCancelledOn, loadClientAgreements, renderFor, type ClientAgreements, type SignatureRow } from './agreements';
import type { Day } from './business-days';
import { isRendered, SERVICE_CONSENTS, SIGNING_ORDER, type ConsentKind } from './compliance/disclosures';
import { intakeSummary } from './intake';
import { loadIntake } from './intake-load';

export const ONBOARDING_STEPS = ['details', 'agreements', 'documents', 'done'] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];
export const isOnboardingStep = (v: unknown): v is OnboardingStep => typeof v === 'string' && (ONBOARDING_STEPS as readonly string[]).includes(v);

export interface OnboardingInput {
  address: { line1?: string; city?: string; state?: string; zip?: string } | null;
  hasDob: boolean;
  hasSsn: boolean;
  /** The client's signatures (in force or not): agreementProgress decides which count. */
  signatures: readonly SignatureRow[];
  documents: { provided: number; total: number };
  /** The day the client cancelled their service agreement in the portal, while none is in force since (clientCancelledOn). */
  cancelledOn?: Day | null;
  /** The service agreement can be built today: the agency saved its terms (and the client's own terms pass the checks). */
  contractReady?: boolean;
}

/** What the portal asks of the client now. */
export type WelcomeAsk =
  | { step: 'details' }
  /**
   * The next agreement to sign. `needed`: a document the service needs is not in force, so no work can start or go on
   * until it is signed. Otherwise every such document is in force, and this one is asked gently.
   */
  | { step: 'agreements'; next: ConsentKind; needed: boolean }
  | { step: 'documents' }
  /** The next agreement waits for the agency (its terms are not saved), and the client has done everything else. */
  | { step: 'waiting' };

export interface Onboarding {
  details: { done: boolean; missing: ('address' | 'dob' | 'ssn')[] };
  agreements: {
    signed: number; total: number; next: ConsentKind | null; done: boolean;
    /** The day the client cancelled their service agreement in the portal, while none is in force since; otherwise null. */
    cancelledOn: Day | null;
    /** Every document the service needs is in force, whatever its version (the gates in src/lib/agreements.ts let work go on). */
    serviceInForce: boolean;
    /** `next` can be signed today (false while the service agreement waits for the agency's terms). */
    nextReady: boolean;
    /**
     * The required agreements the portal asks the client for, in signing order, and whether each can be signed yet (the
     * service agreement and what follows it are "being prepared" while the agency's terms are not saved). Empty once the
     * client cancelled, and while the only thing left would be a consent to electronic records they withdrew.
     */
    asked: { kind: ConsentKind; ready: boolean }[];
  };
  documents: { provided: number; total: number; done: boolean };
  /** All three steps done. */
  complete: boolean;
  /** The first step not done yet, or `done`. */
  current: OnboardingStep;
  /** How many of the three steps are done (for the progress bar). */
  stepsDone: number;
  /** What the portal asks of the client now, or null: nothing is left, or they cancelled their service agreement. */
  ask: WelcomeAsk | null;
}

const filled = (v: unknown) => typeof v === 'string' && v.trim() !== '';
const CONTRACT_AT = SIGNING_ORDER.indexOf('croa_contract');

export function onboarding(i: OnboardingInput): Onboarding {
  const a = i.address ?? {};
  const missing: Onboarding['details']['missing'] = [];
  if (!filled(a.line1) || !filled(a.city) || !filled(a.state) || !filled(a.zip)) missing.push('address');
  if (!i.hasDob) missing.push('dob');
  if (!i.hasSsn) missing.push('ssn');
  const p = agreementProgress(i.signatures);
  const cancelledOn = i.cancelledOn ?? null;
  const contractReady = i.contractReady ?? true;
  const ready = (k: ConsentKind) => contractReady || SIGNING_ORDER.indexOf(k) < CONTRACT_AT;
  const serviceInForce = SERVICE_CONSENTS.every((k) => i.signatures.some((r) => r.kind === k && !r.revoked_at));
  // The client withdrew their consent to electronic records (it was revoked, and none counts since): while the service
  // goes on, the portal does not ask for it again (15 U.S.C. § 7001(c)(1)(B)(i): paper from then on).
  const withdrewEsign = !p.signed.includes('esign') && i.signatures.some((r) => r.kind === 'esign' && r.revoked_at);
  const quiet = !!cancelledOn || (serviceInForce && withdrewEsign);
  const asked = quiet ? [] : SIGNING_ORDER.filter((k) => !p.signed.includes(k)).map((kind) => ({ kind, ready: ready(kind) }));
  const details = { done: missing.length === 0, missing };
  const agreements = { signed: p.count, total: p.total, next: p.next, done: p.next === null, cancelledOn, serviceInForce, nextReady: !p.next || ready(p.next), asked };
  const documents = { ...i.documents, done: i.documents.provided >= i.documents.total };
  const current: OnboardingStep = !details.done ? 'details' : !agreements.done ? 'agreements' : !documents.done ? 'documents' : 'done';
  const first = asked[0];
  const ask: WelcomeAsk | null = cancelledOn ? null
    : !details.done ? { step: 'details' }
      : first?.ready ? { step: 'agreements', next: first.kind, needed: !serviceInForce }
        : !documents.done ? { step: 'documents' }
          : first ? { step: 'waiting' }
            : null;
  return { details, agreements, documents, complete: current === 'done', current, stepsDone: [details.done, agreements.done, documents.done].filter(Boolean).length, ask };
}

/**
 * Reads the records for `onboarding`, under the caller's row-level security (staff, or the client themselves), and
 * returns it with the client's agreements it was worked out from (for the pages that show both).
 */
export async function loadWelcome(db: Db, clientId: string, now = new Date()): Promise<{ ob: Onboarding; ag: ClientAgreements } | null> {
  const c = await db.row<{ org_id: string; address: OnboardingInput['address']; has_dob: boolean; has_ssn: boolean }>(
    'select org_id, address, dob_encrypted is not null as has_dob, ssn_last4 is not null as has_ssn from public.clients where id = $1', [clientId]);
  if (!c) return null;
  const ag = await loadClientAgreements(db, c.org_id, clientId, now);
  if (!ag) return null;
  const docs = intakeSummary(await loadIntake(db, clientId));
  const ob = onboarding({
    address: c.address, hasDob: c.has_dob, hasSsn: c.has_ssn, signatures: ag.rows, documents: { provided: docs.provided, total: docs.total },
    cancelledOn: clientCancelledOn(ag.rows, ag.agency.tz), contractReady: isRendered(renderFor(ag, 'croa_contract')),
  });
  return { ob, ag };
}

/** `onboarding` from the records, under the caller's row-level security. */
export async function loadOnboarding(db: Db, clientId: string, now = new Date()): Promise<Onboarding | null> {
  return (await loadWelcome(db, clientId, now))?.ob ?? null;
}
