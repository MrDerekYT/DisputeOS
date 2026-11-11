import { BUREAUS, type Bureau } from '../util';
import { REVIEW_THRESHOLD, type FieldMeta, type ParsedIdentity, type ParsedInquiry, type ParsedPublicRecord, type ParsedReport, type ParsedTradeline } from './types';

const MAX_TEXT = 2_000_000;

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/(p|div|tr|li|h\d|table|section)>|<br\s*\/?>/gi, '\n')
    .replace(/<\/t[dh]>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/[ \t]+/g, ' ');
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** MM/DD/YYYY, M/D/YY, YYYY-MM-DD, "Jan 5, 2022", and MM/YYYY (→ first of month). Null if not a real date. */
export function normalizeDate(raw: string): string | null {
  const s = raw.trim();
  let y: number, m: number, d: number;
  let r: RegExpExecArray | null;
  if ((r = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s))) [y, m, d] = [+r[1]!, +r[2]!, +r[3]!];
  else if ((r = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(s))) {
    [m, d] = [+r[1]!, +r[2]!];
    y = r[3]!.length === 2 ? (+r[3]! > 40 ? 1900 + +r[3]! : 2000 + +r[3]!) : +r[3]!;
  } else if ((r = /^(\d{1,2})\/(\d{4})$/.exec(s))) [m, d, y] = [+r[1]!, 1, +r[2]!];
  else if ((r = /^([A-Za-z]{3})[a-z]*\.? (\d{1,2}),? (\d{4})$/.exec(s))) {
    m = MONTHS.indexOf(r[1]!.toLowerCase()) + 1;
    [d, y] = [+r[2]!, +r[3]!];
  } else if ((r = /^([A-Za-z]{3})[a-z]*\.? (\d{4})$/.exec(s))) {
    m = MONTHS.indexOf(r[1]!.toLowerCase()) + 1;
    [d, y] = [1, +r[2]!];
  } else return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (m < 1 || dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return dt.toISOString().slice(0, 10);
}

export function parseMoneyToCents(raw: string): number | null {
  const m = /^\(?-?\$?\s*([\d,]+(?:\.\d{1,2})?)\)?$/.exec(raw.trim());
  if (!m) return null;
  const n = Number(m[1]!.replace(/,/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

/** Masks digit runs of 5+ (keeping the last 4) so stored snippets never carry full account numbers or SSNs. */
export function maskSnippet(line: string): string {
  return line
    .replace(/\b\d{3}-\d{2}-\d{4}\b/g, '***-**-****')
    .replace(/[0-9Xx*-]{6,}/g, (m) => {
      const d = m.replace(/[^0-9A-Za-z]/g, '');
      return d.length >= 5 ? `••••${d.slice(-4)}` : m;
    })
    .slice(0, 160);
}

export const bureauFrom = (text: string): Bureau | null => {
  const t = text.toLowerCase();
  if (t.includes('transunion') || t.includes('trans union')) return 'transunion';
  return BUREAUS.find((b) => t.includes(b)) ?? null;
};

type Section = 'tradeline' | 'collection' | 'inquiry' | 'public_record' | 'identity';
const SECTIONS: [RegExp, Section][] = [
  [/^\s*(?:collections?|collection accounts?)\s*:?\s*$/i, 'collection'],
  [/^\s*(?:inquiries|hard inquiries|credit inquiries|regular inquiries)\s*:?\s*$/i, 'inquiry'],
  [/^\s*(?:public records?|bankruptcies|judgments|liens)\s*:?\s*$/i, 'public_record'],
  [/^\s*(?:personal information|personal data|identification|consumer information)\s*:?\s*$/i, 'identity'],
  [/^\s*(?:accounts?|tradelines?|credit accounts?|account information|trade accounts)\s*:?\s*$/i, 'tradeline'],
];

const L = {
  creditor: /^(?:account name|creditor(?: name)?|company|collection agency|furnisher|subscriber name)\s*[:\-]\s*(.+)$/i,
  original: /^original creditor\s*[:\-]\s*(.+)$/i,
  number: /^(?:account\s*(?:#|no\.?|number)|acct\s*(?:#|no\.?))\s*[:\-]?\s*(.+)$/i,
  type: /^(?:account type|type)\s*[:\-]\s*(.+)$/i,
  status: /^(?:account status|status)\s*[:\-]\s*(.+)$/i,
  pay: /^(?:payment status|pay status|current payment status)\s*[:\-]\s*(.+)$/i,
  balance: /^(?:balance|current balance|amount|balance owed)\s*[:\-]\s*(.+)$/i,
  limit: /^(?:credit limit|limit)\s*[:\-]\s*(.+)$/i,
  high: /^(?:high(?:est)? balance|high credit)\s*[:\-]\s*(.+)$/i,
  opened: /^(?:date opened|opened)\s*[:\-]\s*(.+)$/i,
  reported: /^(?:date reported|last reported|reported|date updated|last updated)\s*[:\-]\s*(.+)$/i,
  dofd: /^(?:date of first delinquency|dofd|first delinquency)\s*[:\-]\s*(.+)$/i,
  history: /^(?:payment history|pay history)\s*[:\-]\s*(.+)$/i,
  remarks: /^(?:remarks?|comments?)\s*[:\-]\s*(.+)$/i,
  bureau: /^(?:bureau|reported by|credit bureau)\s*[:\-]\s*(.+)$/i,
  reportDate: /^(?:report date|date of report|date generated|as of)\s*[:\-]\s*(.+)$/i,
  court: /^court\s*[:\-]\s*(.+)$/i,
  recordType: /^(?:record type|type|kind)\s*[:\-]\s*(.+)$/i,
  filed: /^(?:date filed|filed|filing date)\s*[:\-]\s*(.+)$/i,
  idName: /^(?:name|also known as|aka|previous name)\s*[:\-]\s*(.+)$/i,
  idAddr: /^(?:address|current address|previous address|former address)\s*[:\-]\s*(.+)$/i,
  idEmp: /^(?:employer|employment)\s*[:\-]\s*(.+)$/i,
};

const field = (confidence: number, snippet: string): FieldMeta => ({ confidence, snippet: maskSnippet(snippet) });

function getter(block: string[]) {
  return (re: RegExp) => {
    for (const line of block) {
      const m = re.exec(line);
      if (m) return { raw: m[1]!.trim(), line };
    }
    return null;
  };
}

function parseTradeline(block: string[], section: 'tradeline' | 'collection', reportBureau: Bureau | null): ParsedTradeline | null {
  const get = getter(block);
  const cred = get(L.creditor);
  if (!cred) return null;
  const meta: Record<string, FieldMeta> = {};
  const date = (re: RegExp, key: string): string | null => {
    const g = get(re);
    if (!g) return null;
    const n = normalizeDate(g.raw);
    meta[key] = field(n ? 0.95 : 0.2, g.line);
    return n;
  };
  const money = (re: RegExp, key: string): number | null => {
    const g = get(re);
    if (!g) return null;
    const n = parseMoneyToCents(g.raw);
    meta[key] = field(n === null ? 0.2 : 0.95, g.line);
    return n;
  };
  const text = (re: RegExp, key: string, max = 100): string | null => {
    const g = get(re);
    if (!g) return null;
    meta[key] = field(0.9, g.line);
    return g.raw.slice(0, max);
  };

  const num = get(L.number);
  const digits = num?.raw.replace(/[^0-9A-Za-z]/g, '') ?? '';
  meta.creditor_name = field(0.95, cred.line);
  if (num) meta.account_last4 = field(digits ? 0.9 : 0.2, num.line);
  const bu = get(L.bureau);
  const bureau = (bu && bureauFrom(bu.raw)) || reportBureau;
  if (bu && bureauFrom(bu.raw)) meta.bureau = field(0.95, bu.line);

  const t: ParsedTradeline = {
    bureau,
    item_type: section,
    creditor_name: cred.raw.slice(0, 200),
    original_creditor: text(L.original, 'original_creditor', 200),
    account_last4: digits ? digits.slice(-4) : null,
    account_type: text(L.type, 'account_type'),
    account_status: text(L.status, 'account_status'),
    payment_status: text(L.pay, 'payment_status'),
    balance_cents: money(L.balance, 'balance_cents'),
    credit_limit_cents: money(L.limit, 'credit_limit_cents'),
    high_balance_cents: money(L.high, 'high_balance_cents'),
    date_opened: date(L.opened, 'date_opened'),
    date_reported: date(L.reported, 'date_reported'),
    date_of_first_delinquency: date(L.dofd, 'date_of_first_delinquency'),
    payment_history: text(L.history, 'payment_history', 120),
    remarks: text(L.remarks, 'remarks', 300),
    confidence: 1,
    field_meta: meta,
  };
  // Overall confidence = weakest of the fields a dispute relies on.
  const weakest = Object.values(meta).reduce((m, f) => Math.min(m, f.confidence), 1);
  t.confidence = Math.min(weakest, bureau ? 1 : 0.3);
  return t;
}

/** Fields (present in the source) that fall below the review threshold and need a human to confirm. */
export function lowConfidenceFields(t: Pick<ParsedTradeline, 'field_meta'>): string[] {
  return Object.entries(t.field_meta).filter(([, m]) => m.confidence < REVIEW_THRESHOLD).map(([k]) => k);
}

/**
 * Rules-based parser for text/HTML credit reports. Accounts are blocks of "Label: value" lines separated by blank
 * lines, under optional section headings. Every field carries a confidence and its masked source line, so the
 * review screen can show exactly what was read. Real-world bureau PDFs vary widely: treat output as a DRAFT that a
 * person confirms before it is used for anything.
 */
export function parseReportText(input: string, kind: 'text' | 'html' = 'text'): ParsedReport {
  if (input.length > MAX_TEXT) throw new Error('Report text too large');
  const text = kind === 'html' ? htmlToText(input) : input;
  const lines = text.split(/\r?\n/).map((l) => l.replace(/\s+/g, ' ').trim());
  const out: ParsedReport = { bureau: null, reportDate: null, tradelines: [], inquiries: [], publicRecords: [], identity: [], warnings: [] };

  // Bureau + report date from the first lines of the document.
  for (const line of lines.slice(0, 25)) {
    if (!out.bureau && /report|credit file|consumer disclosure/i.test(line)) out.bureau = bureauFrom(line);
    if (!out.reportDate) {
      const m = L.reportDate.exec(line);
      if (m) out.reportDate = normalizeDate(m[1]!);
    }
  }
  if (!out.bureau) out.bureau = bureauFrom(lines.slice(0, 40).join(' '));
  if (!out.bureau) out.warnings.push('Could not tell which credit bureau this report is from; set it manually below.');

  // Scores as stated on the report (e.g. "VantageScore 3.0: 612"). Matched anywhere outside account blocks.
  const SCORE = /^(credit score|fico[®™]?(?: score)?(?: [\w.]+)?|vantage ?score(?: [\d.]+)?)\s*[:\-]\s*(\d{3})\b/i;
  out.scores = [];
  for (const line of lines) {
    const m = SCORE.exec(line);
    if (m) {
      const score = Number(m[2]);
      if (score >= 250 && score <= 900) out.scores.push({ bureau: out.bureau, model: m[1]!.replace(/\s+/g, ' ').trim().slice(0, 60), score, scored_on: out.reportDate });
    }
  }

  let section: Section = 'tradeline';
  let block: string[] = [];
  const flush = () => {
    if (block.length) {
      if (section === 'tradeline' || section === 'collection') {
        const t = parseTradeline(block, section, out.bureau);
        if (t) out.tradelines.push(t);
      } else if (section === 'public_record') {
        const get = getter(block);
        const kindRaw = get(L.recordType)?.raw ?? block[0] ?? '';
        const amt = get(L.balance);
        const filed = get(L.filed);
        if (kindRaw) {
          out.publicRecords.push({
            bureau: out.bureau, kind: kindRaw.slice(0, 80), court: get(L.court)?.raw.slice(0, 200) ?? null,
            amount_cents: amt ? parseMoneyToCents(amt.raw) : null, filed_date: filed ? normalizeDate(filed.raw) : null, status: get(L.status)?.raw.slice(0, 100) ?? null,
          } satisfies ParsedPublicRecord);
        }
      }
    }
    block = [];
  };

  for (const line of lines) {
    if (!line) { flush(); continue; }
    const sec = SECTIONS.find(([re]) => re.test(line));
    if (sec) { flush(); section = sec[1]; continue; }

    if (section === 'inquiry') {
      const m = /^(?:inquiry\s*[:\-]\s*)?(.+?)(?:\s*[-–|,:]\s*|\s+)((?:\d{1,2}\/\d{1,2}\/\d{2,4})|(?:\d{4}-\d{2}-\d{2})|(?:[A-Za-z]{3}[a-z]* \d{1,2},? \d{4}))\s*$/i.exec(line);
      if (m) out.inquiries.push({ bureau: out.bureau, name: m[1]!.trim().slice(0, 200), inquiry_date: normalizeDate(m[2]!) } satisfies ParsedInquiry);
      else if (!/^date\b/i.test(line)) out.inquiries.push({ bureau: out.bureau, name: line.replace(/^inquiry\s*[:\-]\s*/i, '').slice(0, 200), inquiry_date: null });
      continue;
    }
    if (section === 'identity') {
      for (const [re, kind] of [[L.idName, 'name'], [L.idAddr, 'address'], [L.idEmp, 'employer']] as const) {
        const m = re.exec(line);
        if (m) { out.identity.push({ bureau: out.bureau, kind, value: m[1]!.trim().slice(0, 300) } satisfies ParsedIdentity); break; }
      }
      continue;
    }
    block.push(line);
  }
  flush();
  if (!out.tradelines.length && !out.inquiries.length && !out.publicRecords.length) {
    out.warnings.push('No accounts were recognised. The file may be scanned, image-only or in an unsupported layout — try the CSV import.');
  }
  return out;
}

// ------------------------------------------------------------------ CSV import (the dependable path)
export const MAX_IMPORT_ROWS = 2000;
export const CSV_TEMPLATE =
  'bureau,item_type,creditor_name,account_number,account_type,account_status,payment_status,balance,credit_limit,high_balance,date_opened,date_reported,dofd,original_creditor,payment_history,remarks\n' +
  'experian,tradeline,Example Bank,000012341234,Revolving,Open,Current,540.25,5000,1200,2020-03-01,2026-01-15,,,CCCCCCCC,\n' +
  'equifax,collection,Example Collections,00001234,Collection,Open,Collection,1200,,,2022-03-01,2026-01-15,2021-06-01,Example Bank,,\n';

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let f = '';
  let quoted = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') { f += '"'; i++; } else if (c === '"') quoted = false; else f += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(f); f = '';
      if (row.some((x) => x.trim() !== '')) rows.push(row);
      row = [];
    } else f += c;
  }
  row.push(f);
  if (row.some((x) => x.trim() !== '')) rows.push(row);
  return rows;
}

export function parseTradelineCsv(text: string): ParsedReport {
  const out: ParsedReport = { bureau: null, reportDate: null, tradelines: [], inquiries: [], publicRecords: [], identity: [], warnings: [] };
  const table = parseCsv(text);
  if (table.length < 2) { out.warnings.push('File has no data rows.'); return out; }
  if (table.length - 1 > MAX_IMPORT_ROWS) { out.warnings.push(`Too many rows (max ${MAX_IMPORT_ROWS}).`); return out; }
  const header = table[0]!.map((h) => h.trim().toLowerCase());
  for (const need of ['bureau', 'creditor_name']) if (!header.includes(need)) out.warnings.push(`Missing required column: ${need}`);
  if (out.warnings.length) return out;

  table.slice(1).forEach((cells, idx) => {
    const r: Record<string, string> = {};
    header.forEach((h, i) => { const v = (cells[i] ?? '').trim(); if (v) r[h] = v; });
    const row = idx + 2;
    const bureau = bureauFrom(r.bureau ?? '');
    if (!bureau) { out.warnings.push(`Row ${row}: unknown bureau “${r.bureau ?? ''}”`); return; }
    if (!r.creditor_name) { out.warnings.push(`Row ${row}: creditor_name is required`); return; }
    const cents = (k: string): number | null => {
      if (!r[k]) return null;
      const n = parseMoneyToCents(r[k]!);
      if (n === null) out.warnings.push(`Row ${row}: ${k} “${r[k]}” is not an amount`);
      return n;
    };
    const dt = (k: string): string | null => {
      if (!r[k]) return null;
      const n = normalizeDate(r[k]!);
      if (!n) out.warnings.push(`Row ${row}: ${k} “${r[k]}” is not a valid date`);
      return n;
    };
    const acct = (r.account_number ?? '').replace(/[^0-9A-Za-z]/g, '');
    out.tradelines.push({
      bureau, item_type: r.item_type?.toLowerCase() === 'collection' ? 'collection' : 'tradeline', creditor_name: r.creditor_name.slice(0, 200),
      original_creditor: r.original_creditor?.slice(0, 200) ?? null, account_last4: acct ? acct.slice(-4) : null,
      account_type: r.account_type?.slice(0, 100) ?? null, account_status: r.account_status?.slice(0, 100) ?? null, payment_status: r.payment_status?.slice(0, 100) ?? null,
      balance_cents: cents('balance'), credit_limit_cents: cents('credit_limit'), high_balance_cents: cents('high_balance'),
      date_opened: dt('date_opened'), date_reported: dt('date_reported'), date_of_first_delinquency: dt('dofd'),
      payment_history: r.payment_history?.slice(0, 120) ?? null, remarks: r.remarks?.slice(0, 300) ?? null,
      confidence: 1, field_meta: {},
    });
  });
  const bureaus = new Set(out.tradelines.map((t) => t.bureau));
  out.bureau = bureaus.size === 1 ? [...bureaus][0]! : null; // multi-bureau CSVs are stored per row
  return out;
}
