/**
 * Adding referral partners: the fields of one partner, and reading a pasted or uploaded list. Pure: no database.
 *
 * A list is one the agency says it compiled itself from public business contact details and its own contacts. This
 * file only checks its shape (a header line, valid addresses, a known category, at most PARTNER_IMPORT_MAX_ROWS rows)
 * and drops repeated addresses. Nothing here fetches, looks up or enriches a contact.
 */
import { z } from 'zod';
import { isPartnerCategory, isPlainCity, PARTNER_CATEGORIES, partnerCityIssue, type PartnerCategory } from './partner-emails';

export const PARTNER_IMPORT_MAX_ROWS = 200;
/** Largest pasted or uploaded list, in characters. 200 rows fit many times over. */
export const PARTNER_IMPORT_MAX_CHARS = 200_000;

const plain = (max: number) => z.string().trim().max(max, `Keep it under ${max} characters`).regex(/^[^<>\r\n]*$/, 'Use plain text on one line');
const blank = (max: number) => plain(max).optional().transform((v) => (v ? v : null));

/** One partner as the agency enters it. The email address is the business contact address the sequence writes to. */
export const partnerSchema = z.object({
  businessName: plain(160).min(1, 'Enter the business name'),
  contactName: blank(120),
  category: z.enum(PARTNER_CATEGORIES, { error: 'Choose a category' }),
  email: z.string().trim().toLowerCase().max(254).email('Enter a valid email address'),
  phone: blank(30).refine((v) => v == null || /^[0-9+().\-\sx]*$/i.test(v), 'Use digits and + ( ) - only'),
  // Printed in the email ("because you work as a real estate agent in Austin, TX"), so it has to be a city name and
  // nothing else, and one the claims guard lets through: a place such as "Free Soil" would get the email refused later.
  city: blank(80).refine((v) => v == null || isPlainCity(v), 'Enter the city name only, for example “Austin” or “St. Louis”').superRefine((v, ctx) => {
    const issue = v != null && isPlainCity(v) ? partnerCityIssue(v) : null;
    if (issue) ctx.addIssue({ code: 'custom', message: `This city cannot be printed in the emails: “${issue.excerpt}” would read as a claim they may not make. Leave the city empty for this partner.` });
  }),
  state: z.string().trim().toUpperCase().optional().transform((v) => (v ? v : null)).refine((v) => v == null || /^[A-Z]{2}$/.test(v), 'Use a two-letter state code'),
  language: z.enum(['en', 'es']).default('en'),
  sourceNote: blank(300),
});
export type PartnerInput = z.infer<typeof partnerSchema>;

/**
 * The exact sentence a person confirms when adding one partner or a list. Who confirmed and when is on each row; the
 * sentence itself is written to the audit entry of the addition, so a later change of wording leaves a record of what
 * was confirmed at the time.
 */
export const PARTNER_ATTESTATION = 'I compiled this myself from public business contact details and my own business contacts. These are business email addresses, and none came from a bought, rented or scraped list.';

// ---------------------------------------------------------------- reading a list
/** Splits delimited text into rows of cells: quoted cells, doubled quotes and line breaks inside quotes are handled. */
export function parseDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const src = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell === '') quoted = true;
    else if (ch === delimiter) { row.push(cell); cell = ''; }
    else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

/** Comma, tab (a paste from a spreadsheet) or semicolon: whichever the first line uses most. */
export function detectDelimiter(text: string): string {
  const first = text.replace(/^﻿/, '').split(/\r?\n/, 1)[0] ?? '';
  const count = (d: string) => first.split(d).length - 1;
  return ['\t', ';', ','].sort((a, b) => count(b) - count(a))[0]!;
}

type Column = keyof PartnerInput;
const COLUMN_ALIASES: Record<Column, string[]> = {
  businessName: ['business name', 'business', 'company', 'company name', 'organization', 'organisation', 'office', 'brokerage', 'dealership'],
  contactName: ['contact name', 'contact', 'name', 'full name', 'person'],
  category: ['category', 'role', 'type', 'kind'],
  email: ['email', 'e mail', 'email address', 'business email', 'work email'],
  phone: ['phone', 'telephone', 'phone number', 'business phone', 'work phone'],
  city: ['city', 'town'],
  state: ['state', 'st'],
  language: ['language', 'lang'],
  sourceNote: ['source', 'source note', 'note', 'notes', 'where from'],
};
const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * What a list may call each category. The WHOLE cell has to be one of these (accents, case and punctuation aside):
 * every partner is then written to as what the list said they are, word for word. A cell that merely contains a
 * familiar word ("real estate attorney", "auto insurance agent", "HR administrator") is not a category we know, and
 * its row is left out and reported, because the first email says "I am contacting you because you work as ...".
 */
const CATEGORY_NAMES: Record<Exclude<PartnerCategory, 'other'>, string[]> = {
  real_estate_agent: ['real estate agent', 'real estate agents', 'realtor', 'realtors', 'real estate broker', 'real estate salesperson', 'estate agent', 'listing agent', 'buyers agent', 'buyer s agent',
    'agente de bienes raices', 'agente inmobiliario', 'agente inmobiliaria', 'corredor de bienes raices'],
  loan_officer: ['loan officer', 'loan officers', 'mortgage loan officer', 'loan originator', 'mortgage loan originator', 'mlo', 'oficial de prestamos', 'oficial de prestamo'],
  mortgage_broker: ['mortgage broker', 'mortgage brokers', 'mortgage brokerage', 'corredor hipotecario', 'corredor de hipotecas'],
  car_dealership: ['car dealership', 'car dealer', 'car dealers', 'auto dealership', 'auto dealer', 'automobile dealer', 'automobile dealership', 'used car dealer', 'used car dealership', 'new car dealer',
    'car sales', 'auto sales', 'concesionario', 'concesionario de autos', 'concesionario de automoviles'],
  tax_preparer: ['tax preparer', 'tax preparers', 'tax preparation', 'tax preparation service', 'preparador de impuestos', 'preparadora de impuestos'],
  property_manager: ['property manager', 'property managers', 'property management', 'property management company',
    'administrador de propiedades', 'administradora de propiedades', 'administracion de propiedades'],
};
const CATEGORY_BY_NAME = new Map(Object.entries(CATEGORY_NAMES).flatMap(([category, names]) => names.map((n) => [n, category as PartnerCategory] as const)));

/** A category as someone might type it in a list ("Realtor", "Loan officer", "car dealer"), or null when it is not one we know. */
export function partnerCategoryFrom(raw: string): PartnerCategory | null {
  const v = norm(raw);
  if (!v) return null;
  const key = v.replace(/ /g, '_');
  if (isPartnerCategory(key)) return key;
  return CATEGORY_BY_NAME.get(v) ?? (v === 'other business' ? 'other' : null);
}

export interface ImportIssue { line: number; message: string }
export interface ParsedImport {
  /** Rows that passed every check, first occurrence of each address only. */
  rows: PartnerInput[];
  /** Rows left out, with the line they are on in the list and why. */
  issues: ImportIssue[];
  /** Rows whose address already appeared higher up in the same list. */
  repeated: number;
  /** Set when nothing can be imported at all (no header, no address column, too many rows). */
  error?: string;
}

/**
 * Reads a pasted or uploaded list. The first line names the columns; an email column is required. A row with no
 * category gets `defaultCategory`; one with a category that is not recognised is left out and reported, so nobody is
 * written to as something they are not. A row with no business name uses the contact name.
 */
export function parsePartnerList(text: string, defaultCategory: PartnerCategory | null): ParsedImport {
  const none = (error: string): ParsedImport => ({ rows: [], issues: [], repeated: 0, error });
  if (text.length > PARTNER_IMPORT_MAX_CHARS) return none('That list is too large. Import it in parts of up to 200 rows.');
  const table = parseDelimited(text, detectDelimiter(text));
  const [header, ...lines] = table;
  if (!header || !lines.length) return none('Paste the list with its header line first, for example: business name, contact name, email, category, city, state.');
  const cols = header.map((h) => (Object.keys(COLUMN_ALIASES) as Column[]).find((c) => COLUMN_ALIASES[c].includes(norm(h))) ?? null);
  if (!cols.includes('email')) return none('The first line must name the columns, and one of them must be "email".');
  if (lines.length > PARTNER_IMPORT_MAX_ROWS) return none(`A list can have at most ${PARTNER_IMPORT_MAX_ROWS} rows per import. This one has ${lines.length}; import it in parts.`);

  const out: ParsedImport = { rows: [], issues: [], repeated: 0 };
  const seen = new Set<string>();
  lines.forEach((cells, i) => {
    const line = i + 2; // the header is line 1
    const raw: Partial<Record<Column, string>> = {};
    cols.forEach((c, j) => { if (c && raw[c] === undefined) raw[c] = (cells[j] ?? '').trim(); });
    const typed = raw.category ?? '';
    const category = typed ? partnerCategoryFrom(typed) : defaultCategory;
    if (!category) { out.issues.push({ line, message: typed ? `category “${typed.slice(0, 40)}” is not one of the categories` : 'no category' }); return; }
    const lang = norm(raw.language ?? '');
    const r = partnerSchema.safeParse({
      businessName: raw.businessName || raw.contactName || '', contactName: raw.contactName, category, email: raw.email ?? '',
      phone: raw.phone, city: raw.city, state: /^[a-z]{2}$/i.test(raw.state ?? '') ? raw.state : undefined,
      language: /^(es|spa|spanish|espanol)$/.test(lang) ? 'es' : 'en', sourceNote: raw.sourceNote,
    });
    if (!r.success) {
      const issue = r.error.issues[0];
      const field = { businessName: 'business name', contactName: 'contact name', email: 'email', phone: 'phone', city: 'city', state: 'state', sourceNote: 'source' }[String(issue?.path[0])] ?? 'row';
      out.issues.push({ line, message: `${field}: ${issue?.message ?? 'not valid'}` });
      return;
    }
    if (seen.has(r.data.email)) { out.repeated++; return; }
    seen.add(r.data.email);
    out.rows.push(r.data);
  });
  return out;
}
