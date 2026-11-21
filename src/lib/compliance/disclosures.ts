import { sha256Hex } from '../crypto';
import { cancellationEndsOn, toDay, type Day } from '../business-days';
import { getEnv } from '../env';
import { PRODUCT } from '../product';
import { dayInZone } from '../util';
import { dollars, type AgreementTerms } from './agreement-terms';
import { CROA_CANCEL_STATEMENT, CROA_STATEMENT, CROA_STATEMENT_ADDRESS_LINES, CROA_STATEMENT_TITLE, longDay, NOTICE_HEADING, noticeOfCancellation } from './croa';

/**
 * The documents a client signs, how each one's text is built, the order they are signed in, and what the record says.
 *
 * Every signature stores the exact text that was shown (title and body as one string), its SHA-256 and the language of
 * the page (client_consents.text_shown, text_sha256, page_lang). The text of four documents depends on the agency and
 * the day: the E-SIGN consent and the authorization name the agency, and the service agreement is built from the
 * agency's saved terms (Settings → Client agreement) with the client's name, the date and the last day of the
 * cancellation period. A signing form posts the hash of what it displayed; the server builds the text again and
 * refuses when it differs (terms edited meanwhile, or the day changed at midnight).
 *
 * IMPORTANT — NOT LEGAL ADVICE: the statutory wording (./croa.ts) is copied from the U.S. Code and tested against it,
 * but contract content is also regulated by state law (several states require registration, bonding and specific
 * contract terms). Have the agency's attorney review the agreement before it is used with real clients.
 */
export type ConsentKind = 'croa_disclosure' | 'croa_contract' | 'fcra_authorization' | 'esign' | 'communications' | 'data_processing';
export const CONSENT_KINDS = ['croa_disclosure', 'croa_contract', 'fcra_authorization', 'esign', 'communications', 'data_processing'] as const satisfies readonly ConsentKind[];

export interface ConsentDoc {
  kind: ConsentKind;
  title: string;
  version: string;
  /** One of the client's four required agreements (SIGNING_ORDER). The optional ones can be signed at any time. */
  required: boolean;
}

/** In the order a client reads and signs them. */
export const CONSENT_DOCS: readonly ConsentDoc[] = [
  { kind: 'esign', title: 'Consent to electronic records and signatures', version: '2026-11', required: true },
  { kind: 'croa_disclosure', title: CROA_STATEMENT_TITLE, version: '2026-11', required: true },
  { kind: 'croa_contract', title: 'Service agreement', version: '2026-11', required: true },
  { kind: 'fcra_authorization', title: 'Authorization to review credit reports and dispute on my behalf', version: '2026-11', required: true },
  { kind: 'communications', title: 'Communication preferences', version: '2026-01-draft', required: false },
  { kind: 'data_processing', title: 'How my information is used', version: '2026-01-draft', required: false },
];

export const consentDoc = (kind: ConsentKind) => CONSENT_DOCS.find((d) => d.kind === kind)!;
export const isConsentKind = (v: unknown): v is ConsentKind => typeof v === 'string' && (CONSENT_KINDS as readonly string[]).includes(v);

/**
 * The order the server enforces when a client signs in the portal: the consent to electronic records first (15 U.S.C.
 * § 7001(c): it must come before any record is given electronically), then the Consumer Credit File Rights statement
 * (§ 1679c(a): before any contract), then the contract, then the authorization.
 */
export const SIGNING_ORDER: readonly ConsentKind[] = ['esign', 'croa_disclosure', 'croa_contract', 'fcra_authorization'];
/** The client's required agreements: all four, in signing order. */
export const REQUIRED_CONSENTS: ConsentKind[] = [...SIGNING_ORDER];
/**
 * What must be in force before a dispute is submitted for the client: the statement, the contract and the
 * authorization. The consent to electronic records is not one of them: a paper signature recorded by staff needs no
 * such consent, and a client who withdraws it gets paper from then on without their service stopping
 * (15 U.S.C. § 7001(c)(1)(B)(i)).
 */
export const SERVICE_CONSENTS: readonly ConsentKind[] = ['croa_disclosure', 'croa_contract', 'fcra_authorization'];

/**
 * The earlier document that has to be in force before `kind` can be signed, or null when nothing stands in the way.
 * In the portal (`client`) all four go in SIGNING_ORDER. A signature that staff record from paper skips the consent
 * to electronic records (paper needs none) but keeps the statement → contract → authorization order.
 */
export function signingOrderProblem(kind: ConsentKind, inForce: readonly string[], by: 'client' | 'staff'): ConsentKind | null {
  const order = by === 'client' ? SIGNING_ORDER : SERVICE_CONSENTS;
  const i = order.indexOf(kind);
  if (i <= 0) return null;
  return order.slice(0, i).find((k) => !inForce.includes(k)) ?? null;
}

// ---------------------------------------------------------------- the text of each document

/** A paragraph. `bold` marks the § 1679d(b)(4) statement and the Notice of Cancellation, which the law sets in bold. */
export interface Block { text: string; bold?: boolean }

export interface ConsentContext {
  /** The agency's legal name from its saved terms, otherwise the workspace name. */
  agencyName: string;
  /**
   * The terms the contract is built from: the agency's saved terms, with this client's own payment terms and total when
   * staff set them (termsForClient). Null when none are saved: then the contract cannot be built.
   */
  terms: AgreementTerms | null;
  clientName: string;
  /** The day the document is signed, in the agency's zone (YYYY-MM-DD). */
  today: Day;
  /**
   * A personal workspace: the account holder works on their own credit, so there is no agency to authorize. Their
   * authorization names the software and the report provider they connect, for their own reports.
   */
  personal?: boolean;
}

export interface RenderedConsent {
  doc: ConsentDoc;
  blocks: Block[];
  /** Title and body as one string: exactly what is stored with the signature and hashed. */
  text: string;
  sha256: string;
  /** client_consents.version: the document version and the first 12 characters of the text's hash. */
  version: string;
}
export type RenderResult = RenderedConsent | { notReady: true; doc: ConsentDoc };
export const isRendered = (r: RenderResult): r is RenderedConsent => !('notReady' in r);

const p = (text: string, bold = false): Block => (bold ? { text, bold } : { text });

function esignBlocks(c: ConsentContext): Block[] {
  const a = c.agencyName;
  const ask = c.terms ? `send a message in your client portal, or write to ${a} at ${c.terms.address}` : 'send a message in your client portal';
  return [
    p(`${a} would like to give you the documents for your credit repair services electronically and to have you sign them electronically. Before you agree, federal law (the Electronic Signatures in Global and National Commerce Act, 15 U.S.C. § 7001) requires us to tell you the following.`),
    p(`Which records this covers. If you agree, ${a} will provide these records to you electronically, in your secure client portal and by email, for as long as you are a client: the Consumer Credit File Rights statement, your service agreement and its Notice of Cancellation, your authorization for us to review your credit reports and dispute on your behalf, copies of everything you sign, letters we prepare for you, and other notices about your file. You will sign these documents electronically by typing your full legal name.`),
    p(`Paper copies are free. You may have any of these records on paper instead. You can ask for a paper copy of any record at any time, at no charge: ${ask}.`),
    p('You may withdraw this consent. You can withdraw your consent to electronic records at any time, at no charge, in the same way. If you do, we will send you the records on paper by mail from then on. Withdrawing does not cancel your service agreement and does not change documents you have already signed. Until you have signed your agreements, you can also choose to sign them on paper instead.'),
    p('Keeping your email address up to date. We use the email address on your file to reach you. To change it, send a message in your client portal and your specialist will update it.'),
    p('What you need. A phone, tablet or computer with internet access; a current web browser (for example a recent version of Chrome, Safari, Edge or Firefox); an email account; and a program that opens PDF files (most phones and computers have one built in). To keep a record, save or print the PDF copies.'),
    p('When you sign below, you confirm that you can read this document and open its PDF copy, and you agree to receive these records electronically and to sign them electronically.'),
  ];
}

function disclosureBlocks(): Block[] {
  const n = CROA_STATEMENT.length - CROA_STATEMENT_ADDRESS_LINES;
  return [...CROA_STATEMENT.slice(0, n).map((t) => p(t)), p(CROA_STATEMENT.slice(n).join('\n'))];
}

/** The sentence after the payment terms that states the total (§ 1679d(b)(1)), up to the amount. */
const TOTAL_LINE = 'Total of all payments you will make under this agreement, to us or to any other person: ';
const escapeRe = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const SIGNED_PAYMENT = new RegExp(String.raw`\n\n3\. Payment\n([\s\S]*?)\n${escapeRe(TOTAL_LINE)}(\$[\d,]+\.\d{2})\.\n\n`);

/**
 * The payment terms and total a service agreement states, read back from its stored text (section 3), so staff see
 * what the client signed. Null for a text without them.
 */
export function signedPayment(text: string): { paymentTerms: string; total: string } | null {
  const m = SIGNED_PAYMENT.exec(text);
  return m ? { paymentTerms: m[1]!, total: m[2]! } : null;
}

/** The service agreement: the agency's terms in the fixed frame, the § 1679d(b)(4) statement, then the Notice of Cancellation. */
function contractBlocks(c: ConsentContext, t: AgreementTerms): Block[] {
  const blocks: Block[] = [
    p(`Date: ${longDay(c.today)}`),
    p(`This agreement is between ${t.legalName}, ${t.address} (“we” or “us”), and ${c.clientName} (“you”).`),
    p(`1. The services we will perform\n${t.services}`),
    p(`2. How long the services should take\n${t.duration}`),
    p(`3. Payment\n${t.paymentTerms}\n${TOTAL_LINE}${dollars(t.totalCents)}.`),
    p('4. No guarantee\nWe make no guarantee of performance or of any result. We do not promise that any item will be removed from your credit reports, and we do not promise any change in your credit score. Accurate, current and verifiable information cannot be removed from a credit report. The credit bureaus and the companies that report information to them decide the outcome of each dispute.'),
    p('5. No payment before the service is performed\nWe will not ask for or accept any payment for a service before that service is fully performed.'),
    p('6. Your right to cancel\nYou may cancel this agreement as explained in the Notice of Cancellation below. We will not begin the services before that period ends. Any written notice works, including a message you send through your client portal, where you can also choose “Cancel my agreement”.'),
  ];
  if (t.additional) blocks.push(p(`7. Additional terms\n${t.additional}`));
  blocks.push(p(CROA_CANCEL_STATEMENT, true), p(NOTICE_HEADING, true));
  for (const line of noticeOfCancellation({ name: t.legalName, address: t.address, date: longDay(cancellationEndsOn(c.today)) })) blocks.push(p(line, true));
  return blocks;
}

const STATIC: Partial<Record<ConsentKind, string>> = {
  communications: 'I agree to be contacted about my account by email and through the client portal. Text messages will be sent only if I separately opt in to SMS.',
  data_processing: 'My identity and credit information is stored encrypted, used only to provide the services I requested, and is shared only with the credit bureaus and companies involved in my disputes.',
};

/** Title and body as one string, the way it is stored and hashed. */
export const consentText = (title: string, blocks: Block[]) => `${title}\n\n${blocks.map((b) => b.text).join('\n\n')}`;

/** The exact text of a document for one client on one day, or `notReady` for the contract while the agency has saved no terms. */
export function renderConsent(kind: ConsentKind, c: ConsentContext): RenderResult {
  const doc = consentDoc(kind);
  let blocks: Block[];
  if (kind === 'esign') blocks = esignBlocks(c);
  else if (kind === 'croa_disclosure') blocks = disclosureBlocks();
  else if (kind === 'croa_contract') {
    if (!c.terms) return { notReady: true, doc };
    blocks = contractBlocks(c, c.terms);
  } else if (kind === 'fcra_authorization') {
    blocks = c.personal
      ? [p(`I authorize ${PRODUCT.name}, the software I use to work on my own credit, and any credit report provider I connect in it, to obtain my own credit reports and scores when I ask, and to store them in my workspace so that I can review them and prepare my own disputes. I decide whether to send each dispute. I understand I may withdraw this authorization at any time.`)]
      : [p(`I authorize ${c.agencyName} to review the credit reports I provide, and to prepare and, with my approval, submit disputes about information in my credit files to the consumer reporting agencies and the companies that report on my accounts. I understand I may withdraw this authorization at any time.`)];
  } else blocks = [p(STATIC[kind]!)];
  const text = consentText(doc.title, blocks);
  const sha256 = sha256Hex(text);
  return { doc, blocks, text, sha256, version: `${doc.version}:${sha256.slice(0, 12)}` };
}

// ---------------------------------------------------------------- status

/** Business days between two dates (Mon–Fri; federal holidays are not modelled). Kept for callers that count days. */
export function businessDaysBetween(from: Date, to: Date): number {
  let n = 0;
  const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  const end = Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate());
  while (d.getTime() < end) {
    d.setUTCDate(d.getUTCDate() + 1);
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) n++;
  }
  return n;
}

/**
 * A signature as the status reads it. The two stored days are on rows signed since migration 0031 and null before.
 */
export interface ConsentRow {
  kind: string;
  signed_at: string;
  revoked_at: string | null;
  /** The day the client signed: the date written on the paper for a signature staff recorded, the agency's day for a portal one. */
  signed_on?: string | null;
  /** Service agreements: the last day of the cancellation period, fixed when it was signed (the day its Notice states). */
  cancellation_ends_on?: string | null;
}

/**
 * The days of one service agreement, judged in the agency's zone `tz`:
 *  - signedOn: the day the client signed, stored with the signature: the agency's day of a portal signature, the date
 *    written on the paper for a paper agreement recorded by staff (for an older row, the day of signed_at);
 *  - endsOn: the last day of the cancellation period, counted from that day (15 U.S.C. § 1679e(a): "the date of the
 *    transaction"), so a paper agreement recorded later keeps the period its own date gave it. It is the later of the day
 *    stored when it was signed (the day the agreement's Notice of Cancellation states) and the day counted again here,
 *    so a later change of the agency's time zone can never shorten it.
 */
export function contractPeriod(r: ConsentRow, tz: string): { signedOn: Day; endsOn: Day } {
  const signedOn = r.signed_on ?? toDay(r.signed_at, tz);
  const counted = cancellationEndsOn(signedOn);
  return { signedOn, endsOn: r.cancellation_ends_on && r.cancellation_ends_on > counted ? r.cancellation_ends_on : counted };
}

export interface ConsentStatus {
  /** Of SERVICE_CONSENTS, the ones not in force: a dispute cannot be submitted until they are. */
  missing: ConsentKind[];
  /** The service agreement in force was signed so recently that the client can still cancel it without penalty. */
  inCancellationWindow: boolean;
  /** The day the agreement in force was signed (contractPeriod), and the last day of its cancellation period. */
  contractSignedOn: Day | null;
  cancellationEndsOn: Day | null;
}

/**
 * Where a client's consents stand. The cancellation period of 15 U.S.C. § 1679e(a) runs "before midnight of the 3rd
 * business day" after the day of signing: through the last day contractPeriod gives (weekends and federal holidays
 * skipped), judged on the agency's calendar day in `tz` (the zone the agency works in; organizations.settings.timezone
 * via orgTimezone). Pass the stored days (signed_on, cancellation_ends_on) wherever the period matters.
 */
export function consentStatus(rows: ConsentRow[], now = new Date(), tz: string = getEnv().APP_TIMEZONE): ConsentStatus {
  const active = rows.filter((r) => !r.revoked_at);
  const missing = SERVICE_CONSENTS.filter((k) => !active.some((r) => r.kind === k));
  const contract = active.filter((r) => r.kind === 'croa_contract').sort((a, b) => new Date(b.signed_at).getTime() - new Date(a.signed_at).getTime())[0];
  if (!contract) return { missing, inCancellationWindow: false, contractSignedOn: null, cancellationEndsOn: null };
  const { signedOn, endsOn } = contractPeriod(contract, tz);
  return { missing, inCancellationWindow: dayInZone(tz, now) <= endsOn, contractSignedOn: signedOn, cancellationEndsOn: endsOn };
}

// ---------------------------------------------------------------- which signatures are of the current documents

/** A signature of the document's current version with its text stored: every signature made since migration 0031. */
export function isCurrentSignature(r: { kind: string; version: string; has_text: boolean }): boolean {
  return isConsentKind(r.kind) && r.has_text && r.version.startsWith(`${consentDoc(r.kind).version}:`);
}

/**
 * A Consumer Credit File Rights statement or a service agreement signed before the current documents existed (the
 * 2026-01 reference drafts, stored without their text). The old agreement was a placeholder with no terms, no total and
 * no Notice of Cancellation, and the old statement was not the full statutory text: staff are told to have the client
 * sign the current ones.
 */
export function isDraftEraSignature(r: { kind: string; has_text: boolean; revoked_at: string | null }): boolean {
  return (r.kind === 'croa_disclosure' || r.kind === 'croa_contract') && !r.revoked_at && !r.has_text;
}

/**
 * How a signature was given, for what its record, its PDF and the evidence pack call it:
 *  - `portal`: the client e-signed it in their portal;
 *  - `paper`: the client signed on paper and a staff member recorded it (recorded_by), with the date on the paper;
 *  - `self`: in a personal workspace the account holder gives it themselves, in the app (no paper, no staff).
 */
export type SignatureSource = 'portal' | 'paper' | 'self';
export const signatureSource = (r: { recorded_by: string | null }, personal: boolean): SignatureSource =>
  (personal ? 'self' : r.recorded_by ? 'paper' : 'portal');
