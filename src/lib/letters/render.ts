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
  includeSsnLast4?: boolean;
  dispute?: {
    item_label: string; bureau: string | null; recipient_name: string; reason: string; fields: string[]; round: number;
    tradeline?: { creditor_name: string; account_last4: string | null } | null; prior_submitted_at?: string | null;
  } | null;
  recipientAddress?: string | null;
  enclosures?: string[];
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
  const es = c.language === 'es';
  const encl = c.enclosures?.length ? `${es ? 'Anexos' : 'Enclosures'}:\n${c.enclosures.map((e) => `  - ${e}`).join('\n')}\n` : '';
  return {
    date: longDate(c.now ?? new Date(), c.language),
    client_name: c.client.full_name,
    client_address: formatAddress(c.client.address),
    ssn_last4_text: c.includeSsnLast4 && c.client.ssn_last4 ? `${es ? 'Últimos 4 del SSN' : 'SSN (last 4)'}: ${c.client.ssn_last4}\n` : '',
    recipient_name: bureau?.name ?? d?.recipient_name ?? '[RECIPIENT NAME NEEDED]',
    recipient_address: bureau?.address ?? c.recipientAddress ?? '[RECIPIENT ADDRESS NEEDED]',
    item_label: d?.item_label ?? '[ITEM NEEDED]',
    creditor: d?.tradeline?.creditor_name ?? d?.recipient_name ?? '',
    account_text: d?.tradeline?.account_last4 ? `${es ? 'cuenta terminada en' : 'account ending'} ${d.tradeline.account_last4}` : '',
    bureau: d?.bureau ?? '',
    reason: d?.reason ?? '[REASON NEEDED]',
    fields_text: d?.fields.length ? `${es ? 'Información específica a revisar' : 'Specific information I am asking you to review'}: ${d.fields.join(', ')}.\n` : '',
    enclosures: encl,
    round_text: d && d.round > 1 ? (es ? ` — solicitud ${d.round}` : ` — request ${d.round}`) : '',
    prior_date: d?.prior_submitted_at ? longDate(new Date(d.prior_submitted_at), c.language) : '[DATE NEEDED]',
    org_name: c.orgName ?? '',
  };
}
