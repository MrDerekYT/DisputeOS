/**
 * Signing, cancelling and keeping the client's agreements, against the database. Every function runs inside the
 * caller's tenant transaction (row-level security decides what is visible): staff see their organization, a portal
 * client only their own records.
 *
 * The rules, each with the law it comes from:
 *  - signing order: E-SIGN consent → Consumer Credit File Rights statement → contract → authorization
 *    (15 U.S.C. § 7001(c)(1); § 1679c(a): the statement comes before any contract). The one function that says what
 *    counts as signed and what comes next is agreementProgress; signAgreement and src/lib/onboarding.ts both use it.
 *  - the contract is built only from the agency's saved terms (§ 1679d(b)); without them it cannot be signed. A client
 *    may have their own payment terms and total (set by staff on the client page before signing, for an agency with
 *    several plans): the contract then states those (§ 1679d(b)(1)), and they cannot change while it is in force.
 *  - what was shown is what is stored: the client's page posts the hash of the text it displayed, and a signature is
 *    refused when the text built now differs. A paper signature recorded by staff stores the app's text on the day it
 *    was recorded (not a copy of the paper) and the date written on the paper.
 *  - no service without a service agreement in force (§ 1679d(a)(1)), none while its cancellation period runs
 *    (§ 1679d(a)(2)), and no sent date before the agreement or inside that period: loadServiceStatus, serviceRefusal and
 *    sentDateRefusal, used by transitionDispute and markSent.
 *  - the signed statement is kept 2 years (§ 1679c(c)): deletionBlock, used before a client is deleted.
 *
 * A personal workspace (someone repairing their own credit) is no credit repair organization and makes no contract
 * with itself: none of these CROA rules apply there (Agency.personal).
 */
import type { Db } from './db';
import { addDays, cancellationEndsOn, sayDay, toDay, type Day } from './business-days';
import { orgTimezone } from './client-updates/templates';
import { clientPaymentTerms, clientTermsIssue, parseTerms, termsForClient, type AgreementTerms, type ClientPaymentTerms } from './compliance/agreement-terms';
import { longDay } from './compliance/croa';
import {
  consentStatus, consentTitle, isConsentKind, isCurrentSignature, isRendered, renderConsent, SERVICE_CONSENTS, signingOrderProblem, SIGNING_ORDER,
  type ConsentContext, type ConsentKind, type ConsentRow, type ConsentStatus, type RenderedConsent, type RenderResult, type SignatureSource,
} from './compliance/disclosures';
import { getEnv } from './env';
import { UserError } from './errors';
import { isRealDay } from './real-day';
import { dayInZone } from './util';

export interface Agency {
  /** The workspace name. */
  name: string;
  /** The name the agreements carry: the legal name from the saved terms, otherwise the workspace name. */
  agencyName: string;
  tz: string;
  terms: AgreementTerms | null;
  settings: Record<string, unknown>;
  /** organizations.mode = 'personal': someone working on their own credit file. No CROA agreement applies. */
  personal: boolean;
}

export async function loadAgency(db: Db, orgId: string): Promise<Agency> {
  const o = await db.row<{ name: string; settings: Record<string, unknown> | null; mode: string }>('select name, settings, mode from public.organizations where id = $1', [orgId]);
  const settings = o?.settings ?? {};
  const terms = parseTerms(settings);
  return { name: o?.name ?? '', agencyName: terms?.legalName || o?.name || '', tz: orgTimezone(settings, getEnv().APP_TIMEZONE), terms, settings, personal: o?.mode === 'personal' };
}

/** The zone the agency works in (Settings → Client updates), or the deployment's default. */
export const agencyZone = async (db: Db, orgId: string): Promise<string> => (await loadAgency(db, orgId)).tz;

// ---------------------------------------------------------------- what counts as signed, and what comes next

/** One signature as the signing order reads it. */
export interface SignatureRow { kind: string; version: string; has_text: boolean; recorded_by: string | null; revoked_at: string | null }

/**
 * Whether a signature counts for the signing order. A signature in force counts, except:
 *  - the Consumer Credit File Rights statement counts only in its current version with its text stored, so a client
 *    whose old (2026-01 draft) agreement is replaced signs the current statement before the new agreement
 *    (15 U.S.C. § 1679c(a));
 *  - the consent to electronic records counts only in its current version, with its text stored, given by the client
 *    in the portal (§ 7001(c)(1): the old one-line consent gave none of the required disclosures, and staff never record it).
 */
export function countsAsSigned(r: SignatureRow): boolean {
  if (r.revoked_at) return false;
  if (r.kind === 'croa_disclosure') return isCurrentSignature(r);
  if (r.kind === 'esign') return isCurrentSignature(r) && !r.recorded_by;
  return true;
}

export interface AgreementProgress {
  /** Every kind that counts as signed (countsAsSigned), required or optional. */
  signed: ConsentKind[];
  /** Of the four required agreements (SIGNING_ORDER), how many count as signed, and how many there are. */
  count: number;
  total: number;
  /** The first of the four, in signing order, that does not count as signed yet: the next one the client signs. Null when all do. */
  next: ConsentKind | null;
}

/** The signing order, from the signatures on file. The one source for signAgreement, the portal and the staff card. */
export function agreementProgress(rows: readonly SignatureRow[]): AgreementProgress {
  const signed = [...new Set(rows.filter(countsAsSigned).map((r) => r.kind))].filter(isConsentKind);
  return {
    signed,
    count: SIGNING_ORDER.filter((k) => signed.includes(k)).length,
    total: SIGNING_ORDER.length,
    next: SIGNING_ORDER.find((k) => !signed.includes(k)) ?? null,
  };
}

/**
 * The day, on the agency's calendar (`tz`), the client cancelled their service agreement in the portal, while no
 * service agreement is in force since: the latest one was revoked by app.cancel_own_contract() (revoked_reason
 * 'client_cancelled'). Null otherwise, including after a staff revocation. The one definition behind the service gate
 * (loadServiceStatus), the portal's cancelled state (src/lib/onboarding.ts) and signing again (signAgreement).
 */
export function clientCancelledOn(rows: readonly { kind: string; signed_at: string; revoked_at: string | null; revoked_reason?: string | null }[], tz: string): Day | null {
  const contracts = rows.filter((r) => r.kind === 'croa_contract');
  if (contracts.some((r) => !r.revoked_at)) return null;
  const last = [...contracts].sort((x, y) => y.signed_at.localeCompare(x.signed_at))[0];
  return last?.revoked_at && last.revoked_reason === 'client_cancelled' ? toDay(last.revoked_at, tz) : null;
}

// ---------------------------------------------------------------- one client's agreements

export interface ClientAgreements {
  agency: Agency;
  clientName: string;
  /** This client's own payment terms and total (clients.agreement_*), or null when the agency's apply. */
  ownTerms: ClientPaymentTerms | null;
  /** Why the client's own terms cannot be used today (they no longer pass the checks), or null. The contract is then not built. */
  ownTermsIssue: string | null;
  /** Today in the agency's zone: the day a document signed now carries. */
  today: Day;
  context: ConsentContext;
  /** Kinds in force (signed and not revoked), whatever their version. */
  inForce: string[];
  /** Kinds that count as signed for the signing order (agreementProgress). */
  signed: ConsentKind[];
  rows: {
    id: string; kind: string; version: string; signed_at: string; revoked_at: string | null; signed_name: string; has_text: boolean; recorded_by: string | null;
    /** The day the client signed (the date on the paper for a staff-recorded signature); null on rows signed before migration 0031. */
    signed_on: string | null;
    cancellation_ends_on: string | null;
    /** 'client_cancelled' (the client cancelled in the portal) or 'staff'; null when in force or revoked before migration 0031. */
    revoked_reason: string | null;
  }[];
  status: ConsentStatus;
}

/** Everything a page or action needs to show or sign one client's agreements. Null when the client is not visible. */
export async function loadClientAgreements(db: Db, orgId: string, clientId: string, now = new Date()): Promise<ClientAgreements | null> {
  const client = await db.row<{ full_name: string; agreement_payment_terms: string | null; agreement_total_cents: number | null }>(
    'select full_name, agreement_payment_terms, agreement_total_cents from public.clients where id = $1', [clientId]);
  if (!client) return null;
  const agency = await loadAgency(db, orgId);
  const rows = await db.rows<ClientAgreements['rows'][number]>(
    `select id, kind, version, signed_at, revoked_at, signed_name, text_shown is not null as has_text, recorded_by, signed_on::text, cancellation_ends_on::text, revoked_reason
       from public.client_consents where client_id = $1 order by signed_at desc`, [clientId]);
  const today = dayInZone(agency.tz, now);
  // The contract states this client's own payment terms and total when staff set them; own terms that no longer pass
  // the checks build no contract at all (never the agency's figures in their place).
  const ownTerms = clientPaymentTerms(client);
  const ownTermsIssue = ownTerms ? clientTermsIssue(ownTerms) : null;
  return {
    agency, clientName: client.full_name, ownTerms, ownTermsIssue, today,
    context: { agencyName: agency.agencyName, terms: ownTermsIssue ? null : termsForClient(agency.terms, ownTerms), clientName: client.full_name, today, personal: agency.personal },
    inForce: rows.filter((r) => !r.revoked_at).map((r) => r.kind),
    signed: agreementProgress(rows).signed,
    rows,
    status: consentStatus(rows, now, agency.tz),
  };
}

export const renderFor = (a: ClientAgreements, kind: ConsentKind): RenderResult => renderConsent(kind, a.context);

// ---------------------------------------------------------------- signing

export type SignProblem = 'order' | 'not_ready' | 'changed' | 'already' | 'name' | 'not_found' | 'paper_date' | 'portal_only' | 'personal' | 'client_terms';
/** A refusal to sign. `code` lets the portal say it in the client's language; `before` names the document to sign first. */
export class AgreementError extends UserError {
  constructor(public code: SignProblem, message: string, public before?: ConsentKind) { super(message); }
}

const STAFF_MESSAGE: Record<SignProblem, string> = {
  order: 'Record the earlier documents first: the Consumer Credit File Rights statement comes before the service agreement, and the service agreement before the authorization.',
  not_ready: 'Your client agreement terms are not saved yet, so the service agreement cannot be recorded. Save them in Settings → Client agreement first.',
  changed: 'This agreement changed since you opened it. Please read it again.',
  already: 'This document is already signed and in force.',
  name: 'Type the full legal name as it is on the client record.',
  not_found: 'Client not found.',
  paper_date: 'Enter the date written on the signed paper.',
  portal_only: 'The consent to electronic records is given by the client in their portal, never recorded by staff. A client who signs on paper does not need it.',
  personal: 'A personal workspace has no service agreement or Consumer Credit File Rights statement to record: you are working on your own credit file, not buying a credit repair service.',
  client_terms: 'This client’s own payment terms cannot be used in the service agreement. Change them on the client page first.',
};

/**
 * The refusal staff see while the agency's terms are not saved. Someone who cannot open Settings → Client agreement is
 * told to ask an owner or admin; on New client, that the client can be created now without the service agreement and
 * the authorization (they are recorded in order, so the authorization waits for the agreement).
 */
export function notReadyMessage(canManageSettings: boolean, onNewClient = false): string {
  const save = canManageSettings ? 'Save them in Settings → Client agreement first.' : 'Ask an owner or admin to save them in Settings → Client agreement.';
  const now = onNewClient ? ' Or untick the service agreement and the authorization to create the client now, and record them once the terms are saved.' : '';
  return `Your client agreement terms are not saved yet, so the service agreement cannot be recorded. ${save}${now}`;
}

/** First word of a name, compared without case or extra spaces. */
const firstWord = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ').split(' ')[0] ?? '';

export interface Signer {
  orgId: string; clientId: string; userId: string; ip?: string | null; userAgent?: string | null;
  /** `client`: e-signed in the portal. `staff`: a signature the client gave on paper, recorded by a staff member. */
  by: 'client' | 'staff';
}

/** A signed paper is dated no later than today (the agency's day or the UTC day, whichever is later) and no more than a year back. */
export const PAPER_DATE_MAX_DAYS = 366;

/** The days a paper date may take, for the form's date input and for the check below. */
export function paperDateRange(agencyToday: Day, now = new Date()): { min: Day; max: Day } {
  const utc = now.toISOString().slice(0, 10);
  return { min: addDays(agencyToday, -PAPER_DATE_MAX_DAYS), max: utc > agencyToday ? utc : agencyToday };
}

/** Why the date staff typed from a signed paper cannot be used, or null. */
export function paperDateProblem(day: string | null | undefined, agencyToday: Day, now = new Date()): string | null {
  if (!day) return STAFF_MESSAGE.paper_date;
  if (!isRealDay(day)) return 'Enter the date written on the signed paper as a real date.';
  const { min, max } = paperDateRange(agencyToday, now);
  if (day > max) return 'The date written on the signed paper cannot be in the future.';
  if (day < min) return 'The date written on the signed paper is more than a year ago. Check it: a paper signature that old is not recorded here.';
  return null;
}

/**
 * Records one signature with the exact text, its SHA-256 and the language of the page. The text is built here, now,
 * from the records: never taken from the browser. A client's signature must carry `shown`, the hash of the text their
 * page displayed, and is refused when the text built now is different.
 *
 * A signature staff record from paper (`by: 'staff'`) needs `paperSignedOn`, the date written on the signed paper. Its
 * stored text is the app's text of the document on the recording day, not a copy of the paper, dated with the date on
 * the paper: for a service agreement, its date line and the last day its Notice of Cancellation states are counted from
 * the date on the paper, as the cancellation period is (15 U.S.C. § 1679e(a): it runs from "the date of the
 * transaction", not from the day staff recorded it). That last day is stored with the signature (cancellation_ends_on),
 * as it is for an agreement signed in the portal.
 *
 * In a personal workspace (`agency.personal`) there is no staff and no paper: what the account holder records in the
 * app is their own consent, given that day (`source` 'self'), so no paper date is asked for.
 */
export async function signAgreement(
  db: Db, who: Signer,
  input: { kind: ConsentKind; signedName: string; shown?: string | null; lang: 'en' | 'es'; paperSignedOn?: string | null },
  now = new Date(),
): Promise<{ id: string; rendered: RenderedConsent; source: SignatureSource; signedOn: Day; reSigned: boolean }> {
  const fail = (code: SignProblem, before?: ConsentKind, message = STAFF_MESSAGE[code]): never => { throw new AgreementError(code, message, before); };
  // The service agreement is built from the client's own payment terms when set: hold the client row while it is built
  // and stored, so a change of those terms (which the database refuses once an agreement is in force) cannot cross it.
  if (input.kind === 'croa_contract') await db.row('select id from public.clients where id = $1 for update', [who.clientId]);
  const a = await loadClientAgreements(db, who.orgId, who.clientId, now);
  if (!a) return fail('not_found');
  if (a.agency.personal && (input.kind === 'croa_disclosure' || input.kind === 'croa_contract')) fail('personal');
  // 15 U.S.C. § 7001(c)(1)(C)(ii): the client consents electronically, in a way that shows they can open the records.
  if (who.by === 'staff' && input.kind === 'esign') fail('portal_only');
  const source: SignatureSource = who.by === 'client' ? 'portal' : a.agency.personal ? 'self' : 'paper';
  let signedOn = a.today;
  if (source === 'paper') {
    const problem = paperDateProblem(input.paperSignedOn, a.today, now);
    if (problem) fail('paper_date', undefined, problem);
    signedOn = input.paperSignedOn!;
  }
  const progress = agreementProgress(a.rows);
  if (progress.signed.includes(input.kind)) fail('already');
  // A personal workspace records no CROA document, so nothing it can record has to wait for one.
  const before = a.agency.personal ? null : signingOrderProblem(input.kind, progress.signed, who.by);
  // A document in force that does not count (the statement signed on the 2026-01 draft) is named, so staff know why.
  const named = before === 'croa_disclosure' ? 'Consumer Credit File Rights statement' : before ? docTitle(before) : '';
  if (before) fail('order', before, a.inForce.includes(before) ? `${STAFF_MESSAGE.order} The ${named} on file was signed on an earlier version and does not count: record the current one first.` : STAFF_MESSAGE.order);
  // Dated the day the client signed: today in the portal, the date on the paper for a paper signature.
  const r = renderConsent(input.kind, { ...a.context, today: signedOn });
  if (!isRendered(r)) {
    return a.ownTermsIssue && a.agency.terms
      ? fail('client_terms', undefined, `This client’s own payment terms cannot be used in the service agreement: ${a.ownTermsIssue} Change them on the client page (Agreement payment terms) first.`)
      : fail('not_ready');
  }
  if (who.by === 'client') {
    if (!input.shown || input.shown !== r.sha256) fail('changed');
    const known = firstWord(a.clientName);
    if (known && firstWord(input.signedName) !== known) fail('name');
  }
  // The period runs from the day the client signed: the day of a portal signature, the date on the paper.
  const cancelBy = input.kind === 'croa_contract' ? cancellationEndsOn(signedOn) : null;
  // A client who cancelled their last service agreement in the portal and now signs a new one (reSigned): the client
  // is active again (app.cancel_own_contract() marked them Cancelled), and the agency is told, as it was of the cancellation.
  const reSigned = input.kind === 'croa_contract' && clientCancelledOn(a.rows, a.agency.tz) !== null;
  const row = await db.row<{ id: string }>(
    `insert into public.client_consents (org_id, client_id, kind, version, signed_name, ip, user_agent, signed_at, text_shown, text_sha256, page_lang, recorded_by, signed_on, cancellation_ends_on)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) returning id`,
    [who.orgId, who.clientId, input.kind, r.version, input.signedName.trim().slice(0, 160), who.ip ?? null, who.userAgent?.slice(0, 300) ?? null, now,
      r.text, r.sha256, input.lang, who.by === 'staff' ? who.userId : null, signedOn, cancelBy],
  );
  if (reSigned) await db.row('select app.client_signed_again($1) as n', [who.clientId]);
  return { id: row!.id, rendered: r, source, signedOn, reSigned };
}

// ---------------------------------------------------------------- no service without an agreement in force

export interface ServiceStatus extends ConsentStatus {
  clientName: string;
  /** A personal workspace: no CROA gate applies, so `missing` is empty and there is no cancellation period. */
  personal: boolean;
  /** No agreement is in force because the client cancelled the last one in the portal: the day they did, else null. */
  clientCancelledOn: Day | null;
  tz: string;
}

/**
 * What stands between a client and the service, for the gates and the pages that show them: the documents missing,
 * and the cancellation period of the agreement in force (with the days stored when it was signed). Null when the
 * client is not visible to the caller.
 */
export async function loadServiceStatus(db: Db, clientId: string, now = new Date()): Promise<ServiceStatus | null> {
  const c = await db.row<{ org_id: string; full_name: string }>('select org_id, full_name from public.clients where id = $1', [clientId]);
  if (!c) return null;
  const agency = await loadAgency(db, c.org_id);
  if (agency.personal) return { missing: [], inCancellationWindow: false, contractSignedOn: null, cancellationEndsOn: null, clientName: c.full_name, personal: true, clientCancelledOn: null, tz: agency.tz };
  const rows = await db.rows<ConsentRow & { revoked_reason: string | null }>(
    'select kind, signed_at, revoked_at, revoked_reason, signed_on::text, cancellation_ends_on::text from public.client_consents where client_id = $1 order by signed_at desc', [clientId]);
  return { ...consentStatus(rows, now, agency.tz), clientName: c.full_name, personal: false, clientCancelledOn: clientCancelledOn(rows, agency.tz), tz: agency.tz };
}

type Act = 'submit' | 'send';
const NO_ACT: Record<Act, string> = { submit: 'No dispute can be recorded as submitted', send: 'No letter can be recorded as sent' };

/**
 * The refusal for staff, or null, before a dispute is recorded as submitted or a letter as sent:
 *  1. every document of SERVICE_CONSENTS in force (§ 1679d(a)(1): no service without a signed agreement; an agreement
 *     the client cancelled is not in force);
 *  2. the cancellation period over (§ 1679d(a)(2): no service "before the end of the 3-business-day period"), judged on
 *     the agency's day: the period runs through its last day, so the refusal holds until that day is over.
 */
export function serviceRefusal(s: ServiceStatus, what: Act): string | null {
  if (s.personal) return null;
  if (s.missing.length) {
    const cancelled = s.clientCancelledOn ? `${s.clientName} cancelled their service agreement on ${sayDay(s.clientCancelledOn)}, so no service may be provided under it. ` : '';
    return `${cancelled}Required consents are missing for this client: ${s.missing.join(', ').replace(/_/g, ' ')}. Record them before ${what === 'submit' ? 'submitting' : 'recording a letter as sent'}.`;
  }
  if (s.inCancellationWindow && s.cancellationEndsOn) {
    return `${s.clientName} can still cancel their service agreement: the cancellation period runs through ${sayDay(s.cancellationEndsOn)}. ${NO_ACT[what]} before it ends, because no service may be provided during those 3 business days (15 U.S.C. § 1679d(a)(2)).`;
  }
  return null;
}

/**
 * The refusal for a sent date, or null: a letter or dispute cannot be recorded as sent on a day before the client
 * signed the agreement in force (§ 1679d(a)(1)), or on or before the last day of its cancellation period
 * (§ 1679d(a)(2)). The message names the days and asks for the date it was really sent; it never proposes another one.
 */
export function sentDateRefusal(s: ServiceStatus, sentOn: Day, what: Act): string | null {
  if (s.personal || !s.contractSignedOn || !s.cancellationEndsOn || sentOn > s.cancellationEndsOn) return null;
  const record = what === 'submit' ? 'this dispute cannot be recorded as submitted' : 'this letter cannot be recorded as sent';
  const why = sentOn < s.contractSignedOn
    ? `is before ${s.clientName} signed the service agreement in force (${sayDay(s.contractSignedOn)}). No service may be provided before the agreement is signed (15 U.S.C. § 1679d(a)(1))`
    : `is within the cancellation period of the service agreement ${s.clientName} signed on ${sayDay(s.contractSignedOn)}, which ran through ${sayDay(s.cancellationEndsOn)}. No service may be provided before that period ends (15 U.S.C. § 1679d(a)(2))`;
  return `The date sent, ${sayDay(sentOn)}, ${why}, so ${record} on that day. Record the date it was really sent.`;
}

/**
 * The refusal for staff while the client's cancellation period runs, or null. Only the period: with no agreement in
 * force, or in a personal workspace, it is null (serviceRefusal is the whole gate).
 */
export async function cancellationBlock(db: Db, clientId: string, what: Act, now = new Date()): Promise<string | null> {
  const s = await loadServiceStatus(db, clientId, now);
  if (!s || s.personal || !s.inCancellationWindow) return null;
  return serviceRefusal({ ...s, missing: [] }, what);
}

/**
 * The client cancels their own service agreement from the portal while the period runs (15 U.S.C. § 1679e(a)): their
 * written notice is posted to the agency as an inbound portal message in the words of the Notice of Cancellation
 * (§ 1679e(b)), and the agreement in force is revoked through app.cancel_own_contract() (clients cannot update
 * consents themselves), which also records why (revoked_reason 'client_cancelled'), marks the client cancelled and
 * notifies the owners, admins and the assigned specialist. Both happen in the caller's transaction, so neither happens
 * without the other. Run as the portal client.
 */
export async function cancelAgreement(db: Db, who: { orgId: string; clientId: string; userId: string }, signedName: string, now = new Date()): Promise<{ messageId: string }> {
  const a = await loadClientAgreements(db, who.orgId, who.clientId, now);
  if (!a || !a.status.inCancellationWindow || !a.status.contractSignedOn) throw new AgreementError('not_ready', 'The cancellation period has ended, or no service agreement is in force.');
  if (firstWord(signedName) !== firstWord(a.clientName)) throw new AgreementError('name', STAFF_MESSAGE.name);
  const body = `I hereby cancel this transaction.\n\nDate: ${longDay(a.today)}\nSigned: ${signedName.trim()}\n\nNotice of cancellation of the service agreement signed on ${longDay(a.status.contractSignedOn)}, sent through the client portal.`;
  const m = await db.row<{ id: string }>(
    "insert into public.communications (org_id, client_id, direction, channel, subject, body, status, author_id) values ($1, $2, 'inbound', 'portal', 'Notice of cancellation', $3, 'received', $4) returning id",
    [who.orgId, who.clientId, body, who.userId]);
  const revoked = await db.row<{ n: number }>('select app.cancel_own_contract() as n');
  if (!revoked?.n) throw new AgreementError('not_ready', 'No service agreement in force could be cancelled.');
  return { messageId: m!.id };
}

// ---------------------------------------------------------------- keeping the signed statement

/** The same month and day two years later (29 February moves to 1 March, which keeps the record longer, never shorter). */
const twoYearsAfter = (day: Day): Day => {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y + 2, m - 1, d)).toISOString().slice(0, 10);
};

/**
 * The refusal to delete a client, or null. 15 U.S.C. § 1679c(c)(2): the statement signed by the consumer "shall be
 * maintained in the organization's files for 2 years after the date on which the statement is signed". The latest
 * signature counts, revoked or not. db/migrations/0031_client_intake.sql holds the same rule in the database. A personal
 * workspace is no credit repair organization, so it has no such duty.
 */
export async function deletionBlock(db: Db, clientId: string, now = new Date()): Promise<string | null> {
  const r = await db.row<{ org_id: string; signed_at: string | null }>(
    "select c.org_id, (select max(k.signed_at) from public.client_consents k where k.client_id = c.id and k.kind = 'croa_disclosure') as signed_at from public.clients c where c.id = $1", [clientId]);
  if (!r?.signed_at) return null;
  const agency = await loadAgency(db, r.org_id);
  if (agency.personal) return null;
  const signedOn = toDay(r.signed_at, agency.tz);
  const keepThrough = twoYearsAfter(signedOn);
  if (dayInZone(agency.tz, now) > keepThrough) return null;
  return `This client signed the Consumer Credit File Rights statement on ${sayDay(signedOn)}. Federal law (15 U.S.C. § 1679c(c)) requires you to keep the signed statement for 2 years, so this client can be deleted from ${sayDay(addDays(keepThrough, 1))}. To stop work for them now, set their status to Cancelled instead.`;
}

/** The document's title, for messages ("Sign the … first"); in a personal workspace the authorization's own (consentTitle). */
export const docTitle = (kind: ConsentKind, personal = false) => consentTitle(kind, personal);

/**
 * What staff confirm before revoking a document. Only the statement, the service agreement and the authorization
 * (SERVICE_CONSENTS) stop the service when revoked; the consent to electronic records and the optional documents do
 * not, and in a personal workspace nothing does.
 */
export function revokeConfirmation(kind: ConsentKind, personal = false): string {
  const stops = !personal && SERVICE_CONSENTS.includes(kind);
  return `Revoke “${docTitle(kind, personal)}”? The signed record is marked revoked and cannot be restored${stops ? ', and no dispute can be submitted and no letter recorded as sent for this client until it is signed again' : ''}.`;
}
