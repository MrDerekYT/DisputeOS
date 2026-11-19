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

const MONTHS_ES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
export function longDate(d: Date, lang: 'en' | 'es'): string {
  return lang === 'es'
    ? `${d.getUTCDate()} de ${MONTHS_ES[d.getUTCMonth()]} de ${d.getUTCFullYear()}`
    : d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

export interface LetterContext {
  client: { full_name: string; address: { line1?: string; line2?: string; city?: string; state?: string; zip?: string }; ssn_last4?: string | null };
  language: 'en' | 'es';
  now?: Date;
  /** The zone the agency works in. Dates in the letter are days there, not UTC days (which are a day ahead every US evening). */
  tz?: string;
  includeSsnLast4?: boolean;
  dispute?: {
    item_label: string; bureau: string | null; recipient_name: string; reason: string; fields: string[]; round: number;
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
}

export function formatAddress(a: LetterContext['client']['address']): string {
  const l1 = [a.line1, a.line2].filter(Boolean).join(', ');
  const l2 = [a.city, [a.state, a.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  return [l1, l2].filter(Boolean).join('\n') || '[CLIENT ADDRESS NEEDED]';
}

export function buildValues(c: LetterContext): Record<string, string> {
  const d = c.dispute;
  const bureau = d?.bureau ? BUREAU_ADDRESSES[d.bureau] : undefined;
  const agency = specialtyAgency(d?.agency);
  // A specialty agency's address comes from the registry when one is verified there; otherwise only from what staff typed. Never a guess.
  const agencyAddress = agency ? addressBlock(agency) ?? (d?.recipient_address?.trim() || null) : null;
  const es = c.language === 'es';
  const encl = c.enclosures?.length ? `${es ? 'Anexos' : 'Enclosures'}:\n${c.enclosures.map((e) => `  - ${e}`).join('\n')}\n`
    : c.enclosuresNone ? `${es ? 'Anexos: ninguno' : 'Enclosures: none'}\n` : '';
  const say = (v: string | Date) => longDate(new Date(`${toDay(v, c.tz)}T00:00:00Z`), c.language);
  return {
    date: say(c.now ?? new Date()),
    client_name: c.client.full_name,
    client_address: formatAddress(c.client.address),
    ssn_last4_text: c.includeSsnLast4 && c.client.ssn_last4 ? `${es ? 'Últimos 4 del SSN' : 'SSN (last 4)'}: ${c.client.ssn_last4}\n` : '',
    recipient_name: bureau?.name ?? d?.recipient_name ?? '[RECIPIENT NAME NEEDED]',
    recipient_address: bureau?.address ?? agencyAddress ?? c.recipientAddress ?? '[RECIPIENT ADDRESS NEEDED]',
    item_label: d?.item_label ?? '[ITEM NEEDED]',
    creditor: d?.tradeline?.creditor_name ?? d?.recipient_name ?? '',
    account_text: d?.tradeline?.account_last4 ? `${es ? 'cuenta terminada en' : 'account ending'} ${d.tradeline.account_last4}` : '',
    bureau: d?.bureau ?? '',
    reason: d?.reason ?? '[REASON NEEDED]',
    agency_identity_text: agencyIdentityLines(agency, d?.agency_item, c.language).map((l) => `${l}\n`).join(''),
    agency_item_text: d?.agency_item ? `${agencyItemLines(d.agency_item, c.language).join('\n')}\n` : '[ITEM NEEDED]\n',
    fields_text: d?.fields.length ? `${es ? 'Información específica a revisar' : 'Specific information I am asking you to review'}: ${d.fields.join(', ')}.\n` : '',
    enclosures: encl,
    round_text: d && d.round > 1 ? (es ? ` — solicitud ${d.round}` : ` — request ${d.round}`) : '',
    // The earlier round's sent date; for a first-round dispute, the day this dispute itself was sent (a follow-up on it).
    prior_date: d?.prior_submitted_at ?? d?.submitted_at ? say((d?.prior_submitted_at ?? d?.submitted_at)!) : '[DATE NEEDED]',
    dispute_date: d?.submitted_at ? say(d.submitted_at) : '[DATE NEEDED]',
    response_date: d?.response_at ? say(d.response_at) : '[DATE NEEDED]',
    org_name: c.orgName ?? '',
  };
}
