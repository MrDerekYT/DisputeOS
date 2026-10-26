import { BUREAUS, type Bureau } from './disputes';

export type ItemType = 'tradeline' | 'collection' | 'inquiry' | 'public_record';

export interface ParsedField<T> {
  value: T;
  confidence: number; // 0..1
  snippet: string; // source line, account numbers masked to last 4
}

export interface ParsedItem {
  bureau: ParsedField<Bureau | null>;
  item_type: ParsedField<ItemType>;
  creditor_name: ParsedField<string | null>;
  original_creditor: ParsedField<string | null>;
  account_last4: ParsedField<string | null>;
  balance_cents: ParsedField<number | null>;
  account_status: ParsedField<string | null>;
  date_opened: ParsedField<string | null>;
  date_reported: ParsedField<string | null>;
  date_of_first_delinquency: ParsedField<string | null>;
  confidence: number; // overall: min of required fields
}

const MAX_TEXT = 2_000_000;

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/(p|div|tr|li|h\d|table|section)>|<br\s*\/?>/gi, '\n')
    .replace(/<\/t[dh]>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/[ \t]+/g, ' ');
}

const LABELS: Record<string, RegExp> = {
  creditor_name:
    /^(?:account name|creditor(?: name)?|company|collection agency|furnisher)\s*[:\-]\s*(.+)$/i,
  original_creditor: /^original creditor\s*[:\-]\s*(.+)$/i,
  account_number: /^(?:account\s*(?:#|no\.?|number)|acct\s*(?:#|no\.?))\s*[:\-]?\s*(.+)$/i,
  balance: /^(?:balance|current balance|amount)\s*[:\-]\s*(.+)$/i,
  account_status: /^(?:status|account status|payment status)\s*[:\-]\s*(.+)$/i,
  date_opened: /^(?:date opened|opened)\s*[:\-]\s*(.+)$/i,
  date_reported: /^(?:date reported|last reported|reported|date updated)\s*[:\-]\s*(.+)$/i,
  dofd: /^(?:date of first delinquency|dofd|first delinquency)\s*[:\-]\s*(.+)$/i,
  bureau: /^(?:bureau|reported by|credit bureau)\s*[:\-]\s*(.+)$/i,
};

const SECTIONS: [RegExp, ItemType][] = [
  [/^\s*(?:collections?|collection accounts?)\s*$/i, 'collection'],
  [/^\s*(?:inquiries|hard inquiries|credit inquiries)\s*$/i, 'inquiry'],
  [/^\s*(?:public records?|bankruptcies|judgments)\s*$/i, 'public_record'],
  [/^\s*(?:accounts?|tradelines?|credit accounts?)\s*$/i, 'tradeline'],
];

/** Normalizes MM/DD/YYYY, M/D/YY, YYYY-MM-DD and "Jan 5, 2022"; returns null if invalid. */
export function normalizeDate(raw: string): string | null {
  const s = raw.trim();
  let y: number, m: number, d: number;
  let r: RegExpExecArray | null;
  if ((r = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s))) [y, m, d] = [+r[1], +r[2], +r[3]];
  else if ((r = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(s))) {
    [m, d] = [+r[1], +r[2]];
    y = r[3].length === 2 ? (+r[3] > 40 ? 1900 + +r[3] : 2000 + +r[3]) : +r[3];
  } else if ((r = /^([A-Za-z]{3})[a-z]*\.? (\d{1,2}),? (\d{4})$/.exec(s))) {
    m =
      ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(
        r[1].toLowerCase(),
      ) + 1;
    [d, y] = [+r[2], +r[3]];
  } else return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (m < 1 || dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d)
    return null;
  return dt.toISOString().slice(0, 10);
}

export function parseMoneyToCents(raw: string): number | null {
  const m = /^\(?-?\$?\s*([\d,]+(?:\.\d{1,2})?)\)?$/.exec(raw.trim());
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

/** Masks every digit run of 5+ digits, keeping the last 4 — so snippets never carry full account numbers/SSNs. */
export function maskSnippet(line: string): string {
  return line
    .replace(/\b\d{3}-\d{2}-\d{4}\b/g, '***-**-****')
    .replace(/[0-9Xx*-]{6,}/g, (m) => {
      const d = m.replace(/[^0-9A-Za-z]/g, '');
      return d.length >= 5 ? `••••${d.slice(-4)}` : m;
    })
    .slice(0, 160);
}

const field = <T>(value: T, confidence: number, snippet: string): ParsedField<T> => ({
  value,
  confidence,
  snippet,
});
const empty = <T>(value: T): ParsedField<T> => field(value, 0, '');

function bureauFrom(text: string): Bureau | null {
  const t = text.toLowerCase();
  return BUREAUS.find((b) => t.includes(b)) ?? null;
}

/**
 * Rules-based parser for text/HTML credit reports. Items are blocks separated by blank lines,
 * under optional section headings. Every field carries a confidence and the masked source line.
 * Low-confidence fields are meant to be reviewed by a human before saving (see review UI).
 */
export function parseReportText(input: string, kind: 'text' | 'html' = 'text'): ParsedItem[] {
  if (input.length > MAX_TEXT) throw new Error('Report text too large');
  const text = kind === 'html' ? htmlToText(input) : input;
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const items: ParsedItem[] = [];
  let section: ItemType = 'tradeline';
  let reportBureau: ParsedField<Bureau | null> = empty(null);
  let block: string[] = [];

  const flush = () => {
    if (block.length) {
      const item = parseBlock(block, section, reportBureau);
      if (item) items.push(item);
    }
    block = [];
  };

  for (const line of lines) {
    if (!line) {
      flush();
      continue;
    }
    const sec = SECTIONS.find(([re]) => re.test(line));
    if (sec) {
      flush();
      section = sec[1];
      continue;
    }
    if (!block.length && !reportBureau.value && !/:/.test(line)) {
      const b = bureauFrom(line);
      if (b && /report|credit file/i.test(line)) {
        reportBureau = field(b, 0.7, maskSnippet(line));
        continue;
      }
    }
    block.push(line);
  }
  flush();
  return items;
}

function parseBlock(
  block: string[],
  section: ItemType,
  reportBureau: ParsedField<Bureau | null>,
): ParsedItem | null {
  const get = (key: string) => {
    for (const line of block) {
      const m = LABELS[key].exec(line);
      if (m) return { raw: m[1].trim(), snippet: maskSnippet(line) };
    }
    return null;
  };
  const creditor = get('creditor_name');
  if (!creditor) return null; // not an item block

  const acct = get('account_number');
  const digits = acct?.raw.replace(/[^0-9A-Za-z]/g, '') ?? '';
  const bal = get('balance');
  const cents = bal ? parseMoneyToCents(bal.raw) : null;
  const date = (key: string): ParsedField<string | null> => {
    const g = get(key);
    if (!g) return empty(null);
    const n = normalizeDate(g.raw);
    return n ? field(n, 0.95, g.snippet) : field(null, 0.2, g.snippet);
  };
  const oc = get('original_creditor');
  const st = get('account_status');
  const bu = get('bureau');
  const bureau =
    bu && bureauFrom(bu.raw) ? field(bureauFrom(bu.raw), 0.95, bu.snippet) : reportBureau;

  const item: ParsedItem = {
    bureau,
    item_type: field(
      section,
      section === 'tradeline' ? 0.6 : 0.85,
      block[0] ? maskSnippet(block[0]) : '',
    ),
    creditor_name: field(creditor.raw.slice(0, 200), 0.95, creditor.snippet),
    original_creditor: oc ? field(oc.raw.slice(0, 200), 0.95, oc.snippet) : empty(null),
    account_last4: acct && digits ? field(digits.slice(-4), 0.9, acct.snippet) : empty(null),
    balance_cents: bal
      ? cents === null
        ? field(null, 0.2, bal.snippet)
        : field(cents, 0.95, bal.snippet)
      : empty(null),
    account_status: st ? field(st.raw.slice(0, 100), 0.9, st.snippet) : empty(null),
    date_opened: date('date_opened'),
    date_reported: date('date_reported'),
    date_of_first_delinquency: date('dofd'),
    confidence: 0,
  };
  item.confidence = Math.min(
    item.creditor_name.confidence,
    item.bureau.value ? item.bureau.confidence : 0.3,
    item.balance_cents.value === null && bal ? 0.2 : 1,
  );
  return item;
}

export const REVIEW_THRESHOLD = 0.8;

/** Fields below the threshold (that were present in the source) must be confirmed by a reviewer. */
export function lowConfidenceFields(item: ParsedItem): string[] {
  return (Object.entries(item) as [string, unknown][])
    .filter(
      ([k, v]) => k !== 'confidence' && typeof v === 'object' && v !== null && 'confidence' in v,
    )
    .filter(([, v]) => {
      const f = v as ParsedField<unknown>;
      return f.snippet !== '' && f.confidence < REVIEW_THRESHOLD;
    })
    .map(([k]) => k);
}
