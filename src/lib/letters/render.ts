import { addressBlock, agencyIdentityLines, agencyItemLines, specialtyAgency, type AgencyItem } from '../credit/agencies';
import { toDay } from '../disputes/clock';
import { BUREAU_ADDRESSES } from '../disputes/workflow';

const FIELD = /\{\{\s*(\w+)\s*\}\}/g;
const NEEDED = /\[[A-Z][A-Z ]{3,}NEEDED\]/g;

/** Replace {{field}} tokens. Unknown tokens stay visible so a reviewer can never miss them. */
export function mergeTemplate(body: string, values: Record<string, string>): string {
  const merged = body.replace(FIELD, (m, k: string) => (k in values ? values[k]! : m));
  return merged
    .split('\n').map((l) => l.replace(/[ \t]+$/g, '')).join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim() + '\n';
}

/** Anything still needing a human: unreplaced {{tokens}} and [SOMETHING NEEDED] markers. */
export function unresolvedPlaceholders(text: string): string[] {
  return [...new Set([...(text.match(FIELD) ?? []), ...(text.match(NEEDED) ?? [])])];
}

/** A date as a letter states it: "March 1, 2026". Letters are English only. */
export function longDate(d: Date): string {
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

/**
 * Recorded facts a situation letter is built from (see ./library.ts). Each one is something on file: a date the
 * report states, the bankruptcy staff entered, a document in the vault, a recorded result. Nothing here is typed into
 * the letter by the app from anywhere else, and a letter that needs one of them is refused when it is missing.
 */
export interface SituationFacts {
  /** Today where the agency works (YYYY-MM-DD). */
  today?: string;
  /** The end of the reporting period worked out from the reported date of first delinquency (tradelineFallOff). */
  fallOff?: { kind: 'date'; date: string; rule: string; from: string } | { kind: 'not_available' } | null;
  /** The client's bankruptcy as staff entered it (clients.bankruptcy_*). */
  bankruptcy?: { chapter: string; filedOn: string; dischargedOn: string | null } | null;
  /** Identity theft report documents on file for the client (FTC report, police report), by label. */
  identityTheftReports?: string[];
  /** The recorded outcome of the earlier round, for a re-dispute. */
  priorOutcome?: string | null;
  /** The recorded outcome of this dispute, and the day its reinvestigation period ends. */
  outcome?: string | null;
  dueOn?: string | null;
  /** True when the dispute is about a collection: a collection account on a report, or a collector whose written notice is recorded. */
  isCollection?: boolean;
  /** The collector's written notice recorded for this debt, and whether its 30-day validation period is still open today. */
  notice?: { kind: 'received' | 'sent'; date: string; open: boolean } | null;
  /** Keys of the client's identity documents that are accepted and still good today ('id', 'proof_of_address', ...). */
  identityProof?: string[];
}

export interface LetterContext {
  /** `dob` is the client's date of birth as a day (YYYY-MM-DD) when it is on file; it is stated only in a letter to a reporting agency. */
  client: { full_name: string; address: { line1?: string; line2?: string; city?: string; state?: string; zip?: string }; ssn_last4?: string | null; dob?: string | null };
  /** Letters are English only. Accepted so older callers keep compiling; it selects nothing. */
  language?: 'en';
  now?: Date;
  /** The zone the agency works in. Dates in the letter are days there, not UTC days (which are a day ahead every US evening). */
  tz?: string;
  /** Whether the last four digits of the SSN are stated. Left unset, they are stated in a letter to one of the three bureaus and nowhere else. */
  includeSsnLast4?: boolean;
  dispute?: {
    item_label: string; bureau: string | null; recipient_name: string; reason: string; fields: string[]; round: number;
    /** disputes.category and disputes.target_type: what is disputed and who the dispute goes to. Absent on a hand-built context. */
    category?: string; target_type?: string;
    tradeline?: { creditor_name: string; account_last4: string | null } | null; prior_submitted_at?: string | null;
    /**
     * When this dispute itself was sent and when its response arrived: used by the request for the reinvestigation
     * procedure. Each is a day ('YYYY-MM-DD', preferred: the sent date staff recorded on the letter) or a stored
     * timestamp, which is read as a day in `tz`.
     */
    submitted_at?: string | null; response_at?: string | null;
    /** Specialty agency disputes only: the agency key, the item as entered, and the address staff typed when none is verified. */
    agency?: string | null; agency_item?: AgencyItem | null; recipient_address?: string | null;
  } | null;
  recipientAddress?: string | null;
  enclosures?: string[];
  /** Say “Enclosures: none” when nothing is listed, so a dispute letter always states what is in the envelope. */
  enclosuresNone?: boolean;
  orgName?: string;
  facts?: SituationFacts;
  /** Optional paragraphs worked out from the letter brief (./brief.ts). A paragraph with nothing on file behind it is empty. */
  paragraphs?: Partial<Record<ParagraphField, string>>;
}

/**
 * Merge fields the letter brief fills: the account as the bureau reports it, the earlier round, what is enclosed, a
 * collector's notice date, and the two lines of connective wording (the only ones an AI wording suggestion may change).
 */
export const PARAGRAPH_FIELDS = ['reported_text', 'history_text', 'enclosed_text', 'notice_text', 'lead_in', 'courtesy'] as const;
export type ParagraphField = (typeof PARAGRAPH_FIELDS)[number];

export function formatAddress(a: LetterContext['client']['address']): string {
  const l1 = [a.line1, a.line2].filter(Boolean).join(', ');
  const l2 = [a.city, [a.state, a.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  return [l1, l2].filter(Boolean).join('\n') || '[CLIENT ADDRESS NEEDED]';
}

const RULE_SAYS: Record<string, string> = {
  seven_years: 'generally 7 years from the date of first delinquency',
  seven_years_plus_180_days: 'generally 7 years, starting 180 days after the date of first delinquency',
  bankruptcy_ten_years: 'generally 10 years from the filing date',
};

/**
 * What a letter about payment history or dates says is in dispute: what was ticked on the dispute, else what its
 * category names. A client who disputes a date is not made to dispute the payment history too.
 */
function historyOrDates(d: NonNullable<LetterContext['dispute']> | null | undefined): string {
  const ticked = (f: string) => !!d?.fields.includes(f);
  const history = ticked('Payment history') || (!ticked('Dates') && d?.category === 'incorrect_payment_history');
  const dates = ticked('Dates') || (!ticked('Payment history') && d?.category === 'incorrect_dates');
  return history && dates ? 'the payment history and dates' : history ? 'the payment history' : dates ? 'the dates' : 'the payment history or dates';
}

/** A name as it is compared with what staff typed: case, punctuation and spacing aside ("TELECHECK SERVICES INC"). */
const bareName = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
/**
 * The address staff typed for a specialty agency with no verified one. The letter prints the agency's name above it,
 * so a first line that is that name, copied with the address from the agency's instructions, is left out rather than
 * printed twice. Nothing left means there is no address: the letter then carries a marked line.
 */
function typedAgencyAddress(typed: string | null | undefined, names: (string | null | undefined)[]): string | null {
  const lines = (typed ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
  const own = new Set(names.filter((n): n is string => !!n?.trim()).map(bareName));
  if (lines.length && own.has(bareName(lines[0]!))) lines.shift();
  return lines.length ? lines.join('\n') : null;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/**
 * The item as a letter names it. A dispute's label is written for a list on screen ("ACME BANK ••1234 (Experian)"); a
 * letter says "ACME BANK, account ending 1234": the masked digits are spelled out, and the bureau in brackets is left
 * off, because the letter is addressed to that bureau. A specialty item's label ends with its agency the same way
 * ("First Coast Bank · xxxx8841 (ChexSystems)"): pass that agency's short name and it is left off too. A label with
 * neither is used as it is.
 */
export function letterItem(label: string, agencyShortName?: string | null): string {
  const addressedTo = ['Experian', 'Equifax', 'TransUnion', ...(agencyShortName ? [escapeRe(agencyShortName)] : [])].join('|');
  return label.replace(new RegExp(`\\s*\\((?:${addressedTo})\\)\\s*$`, 'i'), '').replace(/\s*•{2,}\s*([0-9A-Za-z]{2,})(?![0-9A-Za-z])/, ', account ending $1');
}

export function buildValues(c: LetterContext): Record<string, string> {
  const d = c.dispute;
  const f = c.facts ?? {};
  const bureau = d?.bureau ? BUREAU_ADDRESSES[d.bureau] : undefined;
  const agency = specialtyAgency(d?.agency);
  // A specialty agency's address comes from the registry when one is verified there; otherwise only from what staff typed. Never a guess.
  const agencyAddress = agency ? addressBlock(agency) ?? typedAgencyAddress(d?.recipient_address, [agency.name, d?.recipient_name]) : null;
  // "Other" is the form's catch-all tick, not information a recipient can look up: it is not printed.
  const fields = (d?.fields ?? []).filter((f) => f.trim().toLowerCase() !== 'other');
  const encl = c.enclosures?.length ? `Enclosures:\n${c.enclosures.map((e) => `  - ${e}`).join('\n')}\n` : c.enclosuresNone ? 'Enclosures: none\n' : '';
  const say = (v: string | Date) => longDate(new Date(`${toDay(v, c.tz)}T00:00:00Z`));
  const address = formatAddress(c.client.address);
  // Identification under the sender's address. The three bureaus ask for the date of birth and the Social Security
  // number to find the file, so a letter to one of them states the date of birth and the last four digits of the SSN:
  // what is on the client's record, or a marked line a person completes or removes before approval. A letter to anyone
  // else carries the SSN digits only when the person drafting asked for them, and never the date of birth. (createLetter
  // then takes the digits out of the letters written for a debt collector and of a letter to a specialty agency,
  // whatever was asked.)
  const dob = c.client.dob ? say(c.client.dob) : null;
  const ssn = c.client.ssn_last4 || null;
  const identification = bureau
    ? `Date of birth: ${dob ?? '[DATE OF BIRTH NEEDED]'}\n${c.includeSsnLast4 === false ? '' : `SSN (last 4): ${ssn ?? '[SOCIAL SECURITY NUMBER NEEDED]'}\n`}`
    : c.includeSsnLast4 && ssn ? `SSN (last 4): ${ssn}\n` : '';
  // A collector must stop collecting until it mails verification only when the consumer writes within the 30 days that
  // follow its notice (15 U.S.C. § 1692g(b)). So the statute is cited, and the notice date stated, only when a notice is
  // on file and its period is open today. Otherwise the letter disputes the debt and asks, without claiming that right.
  // Where it is cited, it is cited for the dispute: the statute gives verification and the original creditor's name and
  // address, and the list the letter asks for goes further, so the list is a request ("Please include:"), not a right.
  const n = f.notice ?? null;
  const lateOnly = f.fallOff?.kind === 'date' && f.fallOff.rule === 'seven_years';
  const noticeDay = n ? (n.kind === 'received' ? `which I received on ${say(n.date)}` : `which was sent on ${say(n.date)}`) : '';
  return {
    ...Object.fromEntries(PARAGRAPH_FIELDS.map((k) => [k, c.paragraphs?.[k] ?? ''])),
    date: say(c.now ?? new Date()),
    client_name: c.client.full_name,
    client_address: address,
    ssn_last4_text: identification,
    recipient_name: bureau?.name ?? d?.recipient_name ?? '[RECIPIENT NAME NEEDED]',
    recipient_address: bureau?.address ?? agencyAddress ?? c.recipientAddress ?? '[RECIPIENT ADDRESS NEEDED]',
    item_label: d?.item_label ? letterItem(d.item_label, agency?.shortName) : '[ITEM NEEDED]',
    creditor: d?.tradeline?.creditor_name ?? d?.recipient_name ?? '',
    account_text: d?.tradeline?.account_last4 ? `account ending ${d.tradeline.account_last4}` : '',
    bureau: d?.bureau ?? '',
    reason: d?.reason ?? '[REASON NEEDED]',
    agency_identity_text: agencyIdentityLines(agency, d?.agency_item, 'en', { dob }).map((l) => `${l}\n`).join(''),
    agency_item_text: d?.agency_item ? `${agencyItemLines(d.agency_item, 'en').join('\n')}\n` : '[ITEM NEEDED]\n',
    fields_text: fields.length ? `Specific information I am asking you to review: ${fields.join(', ')}.\n` : '',
    enclosures: encl,
    round_text: d && d.round > 1 ? ` — request ${d.round}` : '',
    // The earlier round's sent date, for a re-dispute. (With no earlier round it is the day this dispute was sent, which
    // is what an agency's own older follow-up template printed; the built-in follow-up uses dispute_date.)
    prior_date: d?.prior_submitted_at ?? d?.submitted_at ? say((d?.prior_submitted_at ?? d?.submitted_at)!) : '[DATE NEEDED]',
    // The day THIS dispute was sent: what a follow-up or a request about its result refers to, whatever round it is.
    dispute_date: d?.submitted_at ? say(d.submitted_at) : '[DATE NEEDED]',
    response_date: d?.response_at ? say(d.response_at) : '[DATE NEEDED]',
    org_name: c.orgName ?? '',
    // Situation facts. Each is a recorded fact said as it is, or a marked line a person has to resolve: never a guess.
    obsolete_text: f.fallOff?.kind === 'date'
      ? `The date of first delinquency reported for this account is ${say(f.fallOff.from)}. The reporting period is ${RULE_SAYS[f.fallOff.rule] ?? 'generally 7 years from that date'}, so ${lateOnly ? 'the reporting period for the late payment information from that date' : 'the reporting period for this item'} appears to have ended on ${say(f.fallOff.date)}.`
      : '[DATE OF FIRST DELINQUENCY NEEDED]',
    // What the outdated-item letter is about. A collection or a charge-off ages off as a whole. An account that is only
    // late does not: the late payment information from the reported date ages off and the account stays reportable, so
    // the letter never calls that account "an item past its reporting period".
    outdated_subject: lateOnly ? 'Late payment information that appears to be past its reporting period' : 'Item that appears to be past the reporting period',
    outdated_what: lateOnly ? 'late payment information' : 'an item',
    outdated_period: lateOnly ? 'the reporting period for that late payment information' : 'its reporting period',
    bankruptcy_text: f.bankruptcy
      ? `I filed a Chapter ${f.bankruptcy.chapter} bankruptcy case on ${say(f.bankruptcy.filedOn)}${f.bankruptcy.dischargedOn ? `, and a discharge was entered on ${say(f.bankruptcy.dischargedOn)}` : ''}.`
      : '[BANKRUPTCY DETAILS NEEDED]',
    identity_theft_text: f.identityTheftReports?.length ? 'A copy of my identity theft report is enclosed.' : '[IDENTITY THEFT REPORT NEEDED]',
    current_details_text: `  Name: ${c.client.full_name}\n  Address: ${address.replace(/\n/g, ', ')}`,
    disputed_subject: historyOrDates(d),
    validation_intro: n?.open
      ? `I am writing in response to your written notice about the debt referenced above, ${noticeDay}. Under Section 809(b) of the Fair Debt Collection Practices Act (15 U.S.C. § 1692g(b)), I dispute this debt. I ask that you provide validation of it. Please include:`
      : `${n ? 'I am writing in response to your written notice about the debt referenced above.' : 'I am writing about the debt referenced above.'} I dispute this debt and ask that you provide validation of it, including:`,
    validation_cease: n?.open
      ? 'Until you mail me verification of the debt, I ask that you cease collection of it, as the statute provides.'
      : 'Until you have sent me that information, I ask that you pause collection of this debt.',
  };
}
