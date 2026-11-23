/**
 * The agency's own terms for the client service agreement, as an owner or admin saves them in Settings → Client
 * agreement (stored in organizations.settings.agreement), and a client's own payment terms and total where staff set
 * them on the client page (clients.agreement_payment_terms, agreement_total_cents). Pure: reading and checking only.
 *
 * What 15 U.S.C. § 1679d(b) requires a contract to state, and where it comes from here:
 *   (1) the terms and conditions of payment, with the total of all payments  → paymentTerms, totalCents (the client's
 *       own when set: an agency with several plans states what this client will pay)
 *   (2) a full and detailed description of the services, with an estimate of how long they take → services, duration
 *   (3) the organization's name and principal business address               → legalName, address
 *   (4) the bold statement next to the signature                              → fixed (./croa.ts)
 * Every field the agency types goes through the contract claims check (findContractClaims) and the advance-fee check
 * (findAdvanceFee, § 1679b(b)). Both are lists of rules: they refuse the common promises of a result and the common
 * ways of asking for payment before the work is done; they are not a legal review of the text.
 */
import { findAdvanceFee, findContractClaims } from './claims';
import { mailingAddressIssue } from '../mailing-address';

export interface AgreementTerms {
  legalName: string;
  address: string;
  services: string;
  paymentTerms: string;
  /** The total of all payments, in cents. */
  totalCents: number;
  duration: string;
  additional: string;
  updatedAt: string;
  updatedBy: string;
}

export const TERMS_LIMITS = {
  legalName: [2, 160], services: [40, 4000], paymentTerms: [10, 2000], duration: [3, 300], additional: [0, 8000],
} as const;
/** Largest total accepted: $1,000,000.00. */
export const MAX_TOTAL_CENTS = 100_000_000;

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

/** What is stored in organizations.settings.agreement, read as terms, whether or not it passes today's checks. */
function storedValues(settings: Record<string, unknown> | null | undefined): AgreementTerms | null {
  const a = settings?.agreement;
  if (!a || typeof a !== 'object') return null;
  const o = a as Record<string, unknown>;
  return {
    legalName: str(o.legal_name), address: str(o.address), services: str(o.services), paymentTerms: str(o.payment_terms),
    totalCents: typeof o.total_cents === 'number' && Number.isInteger(o.total_cents) ? o.total_cents : -1,
    duration: str(o.duration), additional: str(o.additional), updatedAt: str(o.updated_at), updatedBy: str(o.updated_by),
  };
}

/**
 * The saved terms, or null when there are none or they are no longer complete. A value saved by an older version (or
 * edited by hand) that would not pass today's checks reads as "not saved", so a contract is never built from it.
 */
export function parseTerms(settings: Record<string, unknown> | null | undefined): AgreementTerms | null {
  const t = storedValues(settings);
  return t && !termsIssue(t) ? t : null;
}

/**
 * Why terms that are saved cannot be used today, or null (nothing saved, or they pass). Settings shows it, so an agency
 * whose terms were saved before a check was added is told what to change instead of "not saved yet".
 */
export function savedTermsIssue(settings: Record<string, unknown> | null | undefined): string | null {
  const t = storedValues(settings);
  return t ? termsIssue(t) : null;
}

/** The shape stored in organizations.settings.agreement. */
export function storedTerms(t: AgreementTerms): Record<string, unknown> {
  return {
    legal_name: t.legalName, address: t.address, services: t.services, payment_terms: t.paymentTerms, total_cents: t.totalCents,
    duration: t.duration, additional: t.additional, updated_at: t.updatedAt, updated_by: t.updatedBy,
  };
}

const LABEL: Record<keyof typeof TERMS_LIMITS, string> = {
  legalName: 'Legal business name', services: 'Services', paymentTerms: 'Payment terms', duration: 'How long the services should take', additional: 'Additional terms',
};

const TOTAL_ISSUE = 'Total of all payments: enter the amount in dollars, for example 594.00.';
const totalIssue = (cents: number) => (!Number.isInteger(cents) || cents < 0 || cents > MAX_TOTAL_CENTS ? TOTAL_ISSUE : null);

/** Why the text of one field cannot go into a contract: too short or long, a promise of a result, or payment asked for in advance. */
function fieldIssue(k: keyof typeof TERMS_LIMITS, v: string): string | null {
  const [min, max] = TERMS_LIMITS[k];
  if (v.length < min) return `${LABEL[k]}: ${k === 'services' ? `describe the services in full (at least ${min} characters)` : 'required'}.`;
  if (v.length > max) return `${LABEL[k]}: use ${max.toLocaleString('en-US')} characters or fewer.`;
  const claim = findContractClaims(v)[0];
  if (claim) {
    const fix = claim.id === 'dispute-accurate' ? 'Describe disputes of information the client believes is inaccurate, incomplete or cannot be verified.' : 'Describe what you will do, not a result.';
    return `${LABEL[k]}: ${claim.why} (“${claim.excerpt}”). ${fix}`;
  }
  const fee = findAdvanceFee(v);
  if (fee) return `${LABEL[k]}: “${fee.excerpt}” asks for payment before the work it pays for is done. Federal law (15 U.S.C. § 1679b(b)) does not allow charging for a service before it is fully performed. Say when each payment is charged, after the work it pays for.`;
  return null;
}

/** Why these terms cannot be saved or used, in words for the person typing them, or null when they can. */
export function termsIssue(t: Omit<AgreementTerms, 'updatedAt' | 'updatedBy'>): string | null {
  for (const k of Object.keys(TERMS_LIMITS) as (keyof typeof TERMS_LIMITS)[]) {
    const [min, max] = TERMS_LIMITS[k];
    if (t[k].length < min || t[k].length > max) return fieldIssue(k, t[k]);
  }
  const address = mailingAddressIssue(t.address);
  if (address) return `Principal business address: ${address}`;
  const total = totalIssue(t.totalCents);
  if (total) return total;
  for (const k of Object.keys(LABEL) as (keyof typeof LABEL)[]) {
    const issue = fieldIssue(k, t[k]);
    if (issue) return issue;
  }
  return null;
}

// ---------------------------------------------------------------- one client's own payment terms (LEG-9)

/**
 * A client's own payment terms and total of all payments, set by staff on the client page before the client signs
 * (clients.agreement_payment_terms, agreement_total_cents). For an agency with more than one plan: the contract states
 * what this client will pay (§ 1679d(b)(1)), not the agency's usual figures. Null columns: the agency's terms apply.
 */
export interface ClientPaymentTerms { paymentTerms: string; totalCents: number }

/** The client's own terms from their row, or null when none are set (both columns are set together, or neither). */
export function clientPaymentTerms(row: { agreement_payment_terms: string | null; agreement_total_cents: number | null } | null | undefined): ClientPaymentTerms | null {
  if (!row || row.agreement_payment_terms == null || row.agreement_total_cents == null) return null;
  return { paymentTerms: row.agreement_payment_terms.trim(), totalCents: row.agreement_total_cents };
}

/** Why a client's own payment terms and total cannot be saved or used: the same checks as the agency's payment terms and total. */
export function clientTermsIssue(t: ClientPaymentTerms): string | null {
  return fieldIssue('paymentTerms', t.paymentTerms) ?? totalIssue(t.totalCents);
}

/** The terms a client's contract is built from: the agency's, with this client's own payment terms and total when set. */
export function termsForClient(agency: AgreementTerms | null, own: ClientPaymentTerms | null): AgreementTerms | null {
  if (!agency) return null;
  return own ? { ...agency, paymentTerms: own.paymentTerms, totalCents: own.totalCents } : agency;
}

/** "594.00", "594", "$1,200.50" → cents; anything else → null. */
export function parseDollars(v: string): number | null {
  const m = /^\$?\s*(\d{1,3}(?:,\d{3})*|\d+)(?:\.(\d{2}))?$/.exec(v.trim());
  if (!m) return null;
  const cents = Number(m[1]!.replace(/,/g, '')) * 100 + Number(m[2] ?? '0');
  return Number.isSafeInteger(cents) ? cents : null;
}

export const dollars = (cents: number) => (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
