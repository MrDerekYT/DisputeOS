import { z } from 'zod';
import { BUREAUS } from './disputes';

export const MAX_IMPORT_BYTES = 1_000_000;
export const MAX_IMPORT_ROWS = 2000;
export const ITEM_TYPES = ['tradeline', 'collection', 'inquiry', 'public_record'] as const;

export const CSV_TEMPLATE =
  'bureau,item_type,creditor_name,account_number,balance,account_status,date_opened,date_reported\n' +
  'experian,collection,Example Collections,00001234,540.25,Open,2022-03-01,2026-01-15\n';

export interface ParsedTradeline {
  bureau: (typeof BUREAUS)[number];
  item_type: (typeof ITEM_TYPES)[number];
  creditor_name: string;
  account_last4: string | null;
  balance_cents: number | null;
  account_status: string | null;
  date_opened: string | null;
  date_reported: string | null;
}

export interface ImportResult {
  rows: ParsedTradeline[];
  errors: string[];
}

/** RFC 4180-style CSV parser (quoted fields, escaped quotes, CRLF). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const src = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.some((f) => f.trim() !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== '')) rows.push(row);
  return rows;
}

const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'dates must be YYYY-MM-DD')
  .refine((s) => !Number.isNaN(Date.parse(s)), 'invalid date');

const rowSchema = z.object({
  bureau: z.enum(BUREAUS),
  item_type: z.enum(ITEM_TYPES).default('tradeline'),
  creditor_name: z.string().min(1).max(200),
  account_number: z.string().max(40).optional(),
  balance: z.string().optional(),
  account_status: z.string().max(100).optional(),
  date_opened: date.optional(),
  date_reported: date.optional(),
});

/** Parse a tradeline CSV. Full account numbers are reduced to the last 4 characters and never returned. */
export function parseTradelineCsv(text: string): ImportResult {
  const table = parseCsv(text);
  const errors: string[] = [];
  if (table.length < 2) return { rows: [], errors: ['File has no data rows.'] };
  if (table.length - 1 > MAX_IMPORT_ROWS)
    return { rows: [], errors: [`Too many rows (max ${MAX_IMPORT_ROWS}).`] };
  const header = table[0].map((h) => h.trim().toLowerCase());
  for (const required of ['bureau', 'creditor_name'])
    if (!header.includes(required)) errors.push(`Missing required column: ${required}`);
  if (errors.length) return { rows: [], errors };

  const rows: ParsedTradeline[] = [];
  table.slice(1).forEach((cells, idx) => {
    const raw: Record<string, string> = {};
    header.forEach((h, i) => {
      const v = (cells[i] ?? '').trim();
      if (v !== '') raw[h] = h === 'bureau' || h === 'item_type' ? v.toLowerCase() : v;
    });
    const p = rowSchema.safeParse(raw);
    if (!p.success) {
      errors.push(
        `Row ${idx + 2}: ${p.error.issues[0].path.join('.')} ${p.error.issues[0].message}`,
      );
      return;
    }
    let cents: number | null = null;
    if (p.data.balance) {
      const n = Number(p.data.balance.replace(/[$,\s]/g, ''));
      if (!Number.isFinite(n)) {
        errors.push(`Row ${idx + 2}: balance is not a number`);
        return;
      }
      cents = Math.round(n * 100);
    }
    const acct = p.data.account_number?.replace(/[^0-9A-Za-z]/g, '') ?? '';
    rows.push({
      bureau: p.data.bureau,
      item_type: p.data.item_type,
      creditor_name: p.data.creditor_name,
      account_last4: acct ? acct.slice(-4) : null,
      balance_cents: cents,
      account_status: p.data.account_status ?? null,
      date_opened: p.data.date_opened ?? null,
      date_reported: p.data.date_reported ?? null,
    });
  });
  return { rows, errors };
}
