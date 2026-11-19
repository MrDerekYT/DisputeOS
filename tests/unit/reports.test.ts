import { describe, expect, it } from 'vitest';
import { lowConfidenceFields, maskSnippet, normalizeDate, parseMoneyToCents, parseReportText, parseTradelineCsv, CSV_TEMPLATE } from '@/lib/reports/parser';
import { analyze, diffGroup, groupAccounts, normCreditor, type AnalysisTradeline } from '@/lib/reports/analysis';
import { renderPdf } from '@/lib/letters/pdf';
import { pdfToText } from '@/lib/reports/pdf-text';
import type { Bureau } from '@/lib/util';

const REPORT = `Experian Credit Report
Report Date: 01/15/2026

Personal Information
Name: JORDAN A RIVERA
Address: 123 Main Street Apt 4, Tampa FL 33602
Employer: ACME LOGISTICS

Accounts
Account Name: CAPITAL ONE BANK USA
Account Number: 517805551234
Account Type: Revolving
Account Status: Open
Payment Status: Late 30 days
Balance: $1,200.50
Credit Limit: $5,000
Date Opened: 03/2018
Date Reported: 01/02/2026
Payment History: CCC30CCC

Collections
Collection Agency: MIDLAND CREDIT MGMT
Original Creditor: CAPITAL ONE
Account Number: 00099887766
Balance: $980
Status: Open
Date of First Delinquency: 02/14/2016
Date Reported: 12/20/2025

Inquiries
ACME AUTO FINANCE - 03/11/2023
Inquiry: BIG BANK 2025-11-02

Public Records
Record Type: Civil Judgment
Court: Hillsborough County
Amount: $2,300
Date Filed: 05/01/2015
`;

describe('parsing helpers', () => {
  it('normalises dates and rejects impossible ones', () => {
    expect(normalizeDate('01/15/2026')).toBe('2026-01-15');
    expect(normalizeDate('3/4/99')).toBe('1999-03-04');
    expect(normalizeDate('Jan 5, 2022')).toBe('2022-01-05');
    expect(normalizeDate('03/2018')).toBe('2018-03-01');
    expect(normalizeDate('02/30/2022')).toBeNull();
    expect(normalizeDate('garbage')).toBeNull();
  });
  it('parses money to cents', () => {
    expect(parseMoneyToCents('$1,200.50')).toBe(120050);
    expect(parseMoneyToCents('980')).toBe(98000);
    expect(parseMoneyToCents('n/a')).toBeNull();
  });
  it('masks account numbers and SSNs in stored snippets', () => {
    expect(maskSnippet('Account Number: 517805551234')).not.toContain('51780555');
    expect(maskSnippet('SSN 123-45-6789')).toContain('***-**-****');
  });
});

describe('text report parser', () => {
  const r = parseReportText(REPORT);
  it('identifies the bureau and report date', () => {
    expect(r.bureau).toBe('experian');
    expect(r.reportDate).toBe('2026-01-15');
  });
  it('extracts accounts with only the last four digits of the number', () => {
    const cap = r.tradelines.find((t) => t.creditor_name.startsWith('CAPITAL'))!;
    expect(cap).toMatchObject({ bureau: 'experian', account_last4: '1234', balance_cents: 120050, credit_limit_cents: 500000, date_opened: '2018-03-01', payment_status: 'Late 30 days', item_type: 'tradeline' });
    expect(JSON.stringify(r)).not.toContain('517805551234');
  });
  it('reads collections with original creditor and first-delinquency date', () => {
    const col = r.tradelines.find((t) => t.item_type === 'collection')!;
    expect(col).toMatchObject({ creditor_name: 'MIDLAND CREDIT MGMT', original_creditor: 'CAPITAL ONE', account_last4: '7766', date_of_first_delinquency: '2016-02-14' });
  });
  it('reads inquiries, public records and identity lines', () => {
    expect(r.inquiries.map((i) => [i.name, i.inquiry_date])).toEqual([['ACME AUTO FINANCE', '2023-03-11'], ['BIG BANK', '2025-11-02']]);
    expect(r.publicRecords[0]).toMatchObject({ kind: 'Civil Judgment', amount_cents: 230000, filed_date: '2015-05-01' });
    expect(r.identity.map((i) => i.kind)).toEqual(['name', 'address', 'employer']);
  });
  it('flags low-confidence fields instead of guessing', () => {
    const bad = parseReportText('Experian Credit Report\n\nAccounts\nAccount Name: X BANK\nBalance: lots\nDate Opened: 31/31/2020\n');
    expect(lowConfidenceFields(bad.tradelines[0]!).sort()).toEqual(['balance_cents', 'date_opened']);
    expect(bad.tradelines[0]!.balance_cents).toBeNull();
  });
  it('warns when nothing is recognised', () => {
    expect(parseReportText('hello world').warnings.join(' ')).toMatch(/No accounts were recognised/);
  });
  it('strips HTML before parsing', () => {
    const h = parseReportText('<html><body><p>Equifax Credit Report</p><p>&nbsp;</p><p>Account Name: ACME</p><p>Balance: $10</p></body></html>', 'html');
    expect(h.bureau).toBe('equifax');
    expect(h.tradelines[0]!.creditor_name).toBe('ACME');
  });
});

describe('CSV import', () => {
  it('parses the shipped template', () => {
    const r = parseTradelineCsv(CSV_TEMPLATE);
    expect(r.warnings).toEqual([]);
    expect(r.tradelines).toHaveLength(2);
    expect(r.tradelines[1]).toMatchObject({ bureau: 'equifax', item_type: 'collection', original_creditor: 'Example Bank', date_of_first_delinquency: '2021-06-01', account_last4: '1234' });
  });
  it('reports row-level problems and never stores full account numbers', () => {
    const r = parseTradelineCsv('bureau,creditor_name,account_number,balance\nnope,A,1,5\nexperian,B,999988887777,abc\n');
    expect(r.warnings.join('|')).toMatch(/unknown bureau/);
    expect(r.warnings.join('|')).toMatch(/not an amount/);
    expect(JSON.stringify(r)).not.toContain('999988887777');
  });
  it('requires the bureau and creditor columns', () => {
    expect(parseTradelineCsv('a,b\n1,2\n').warnings.join()).toMatch(/Missing required column/);
  });
});

// ------------------------------------------------------------------ analysis
let seq = 0;
const T = (bureau: Bureau, o: Partial<AnalysisTradeline> = {}): AnalysisTradeline => ({
  id: `t${++seq}`, bureau, item_type: 'tradeline', creditor_name: 'CAPITAL ONE BANK USA', original_creditor: null, account_last4: '1234', account_status: 'Open',
  payment_status: 'Current', balance_cents: 100000, credit_limit_cents: 500000, date_opened: '2018-03-01', date_reported: '2026-01-02', date_of_first_delinquency: null,
  payment_history: 'CCCCCC', user_provided: {}, ...o,
});
const run = (tradelines: AnalysisTradeline[], extra: Record<string, unknown> = {}) =>
  analyze({ tradelines, inquiries: [], publicRecords: [], identity: [], now: new Date('2026-02-01T00:00:00Z'), ...extra });

describe('account matching', () => {
  it('matches the same account across bureaus despite name noise', () => {
    expect(normCreditor('Capital One Bank (USA), N.A.')).toBe(normCreditor('CAPITAL ONE'));
    const g = groupAccounts([T('experian'), T('equifax', { creditor_name: 'Capital One' }), T('transunion', { account_last4: '9999' })]);
    expect(g).toHaveLength(2);
    expect(g.find((x) => x.bureauCount === 2)).toBeTruthy();
  });
  it('lists only fields that differ on two or more bureaus', () => {
    const [g] = groupAccounts([T('experian'), T('equifax', { balance_cents: 90000 }), T('transunion')]);
    expect(diffGroup(g!).map((d) => d.field)).toEqual(['balance_cents']);
  });
});

describe('discrepancy findings', () => {
  it('reports a balance difference as a potential discrepancy with evidence — never as an error', () => {
    const f = run([T('experian'), T('equifax', { balance_cents: 90000 })]).find((x) => x.category === 'balance_mismatch')!;
    expect(f.basis).toBe('potential_discrepancy');
    expect(f.evidence.map((e) => e.value).sort()).toEqual(['$1,000.00', '$900.00']);
    expect(f.explanation).toMatch(/not a conclusion that anything is inaccurate/);
    // Apart from the disclaimer itself, no finding may assert that anything is wrong.
    const asserted = JSON.stringify(f).replace(/not a conclusion that anything is inaccurate/g, '');
    expect(asserted).not.toMatch(/inaccura|incorrect|\bwrong\b|\berror\b|\bfalse\b|\bfraud/i);
  });
  it('never asserts inaccuracy in any finding category produced by the engine', () => {
    const all = run([
      T('experian', { payment_history: 'CC30CC', user_provided: { never_late: true, not_mine: true }, date_of_first_delinquency: '2015-01-01', payment_status: 'Late 30' }),
      T('equifax', { balance_cents: 5, account_status: 'Closed', date_opened: '2017-01-01' }),
      T('experian', { item_type: 'collection', creditor_name: 'MIDLAND', original_creditor: 'Capital One', account_last4: '7766', payment_status: 'Collection' }),
    ]);
    expect(all.length).toBeGreaterThan(5);
    for (const f of all) {
      const text = `${f.title} ${f.explanation}`.replace(/not a conclusion that anything is inaccurate/g, '').replace(/If it was re-aged[^.]*\./g, '');
      expect(text, f.dedupe_key).not.toMatch(/\b(is|are|was|were) (inaccurate|incorrect|wrong|false|fraudulent)\b/i);
    }
  });
  it('produces no findings when bureaus agree', () => {
    expect(run([T('experian'), T('equifax'), T('transunion')])).toEqual([]);
  });
  it('notes an account missing from a bureau as informational', () => {
    const f = run([T('experian'), T('equifax'), T('transunion', { account_last4: '7777', creditor_name: 'OTHER CO' })]).filter((x) => x.category === 'missing_on_bureau');
    expect(f.length).toBeGreaterThan(0);
    expect(f.every((x) => x.severity === 'info' && x.basis === 'verified_fact')).toBe(true);
  });
  it('flags a first-delinquency date older than seven years, citing the derived age', () => {
    const f = run([T('experian', { item_type: 'collection', creditor_name: 'MIDLAND', account_last4: '7766', date_of_first_delinquency: '2016-02-14', payment_status: 'Collection' })]).find((x) => x.category === 'obsolete_item')!;
    expect(f.severity).toBe('strong');
    expect(f.evidence.some((e) => e.source === 'derived')).toBe(true);
    expect(f.explanation).toMatch(/Confirm the date/);
  });
  it('does not flag recent negatives as obsolete', () => {
    expect(run([T('experian', { payment_status: 'Late 30', date_of_first_delinquency: '2024-05-01' })]).some((f) => f.category === 'obsolete_item')).toBe(false);
  });
  it('detects a collector and original creditor both reporting a balance', () => {
    const f = run([
      T('experian', { balance_cents: 98000 }),
      T('experian', { item_type: 'collection', creditor_name: 'MIDLAND', original_creditor: 'Capital One', account_last4: '7766', balance_cents: 98000, payment_status: 'Collection' }),
    ]).find((x) => x.category === 'duplicate_account');
    expect(f?.basis).toBe('potential_discrepancy');
    expect(f?.tradeline_ids).toHaveLength(2);
  });
  it('keeps client assertions separate and labelled as client-provided', () => {
    const f = run([T('experian', { payment_history: 'CC30CC', user_provided: { never_late: true } })]).find((x) => x.category === 'client_statement')!;
    expect(f.basis).toBe('user_provided');
    expect(f.evidence.map((e) => e.source).sort()).toEqual(['client', 'reported']);
  });
  it('does not assert identity theft for “not mine” — it asks for the client’s account of events', () => {
    const f = run([T('experian', { user_provided: { not_mine: true } })]).find((x) => x.dedupe_key.startsWith('client-not-mine'))!;
    expect(f.explanation).toMatch(/will not assert identity theft/);
    expect(JSON.stringify(f)).not.toMatch(/fraud/i);
  });
  it('flags only old hard inquiries', () => {
    const f = analyze({ tradelines: [], publicRecords: [], identity: [], now: new Date('2026-02-01T00:00:00Z'),
      inquiries: [{ id: 'i1', bureau: 'experian', name: 'OLD CO', inquiry_date: '2023-01-01', kind: 'hard' }, { id: 'i2', bureau: 'experian', name: 'NEW CO', inquiry_date: '2025-06-01', kind: 'hard' }] });
    expect(f.map((x) => x.title)).toEqual([expect.stringContaining('OLD CO')]);
  });
  it('flags personal information that differs between bureaus or from the client profile', () => {
    const f = run([], {
      clientName: 'Jordan Rivera', clientAddress: '123 Main St Apt 4',
      identity: [
        { bureau: 'experian', kind: 'address', value: '123 Main Street Apt 4' }, { bureau: 'equifax', kind: 'address', value: '123 Main St Apt 4' },
        { bureau: 'experian', kind: 'address', value: '9 Elm Ave' },
        { bureau: 'experian', kind: 'name', value: 'JORDAN RIVERA' }, { bureau: 'equifax', kind: 'name', value: 'JORDAN RIVERA' }, { bureau: 'equifax', kind: 'name', value: 'JORDON RIVERO' },
      ],
    }).filter((x) => x.category === 'personal_info');
    expect(f.map((x) => x.title).join('|')).toMatch(/9 Elm Ave/);
    expect(f.map((x) => x.title).join('|')).toMatch(/JORDON RIVERO/);
    expect(f.some((x) => /123 Main/.test(x.title))).toBe(false); // abbreviation variants of the client's address are fine
  });
  it('gives each finding a stable dedupe key so re-running never duplicates', () => {
    const lines = [T('experian'), T('equifax', { balance_cents: 1 })];
    expect(run(lines).map((f) => f.dedupe_key)).toEqual(run(lines).map((f) => f.dedupe_key));
  });
});

describe('PDF round trip', () => {
  it('generates a valid PDF that the extractor can read back, including accents and pagination', async () => {
    const body = ['Account Name: ACME BANK', 'Balance: $1,200.00', '', 'Hola, ¿cómo está? Año nuevo — “prueba”', ...Array.from({ length: 90 }, (_, i) => `Line ${i + 1} of a long letter that should wrap and paginate across several pages without losing text.`)].join('\n');
    const pdf = renderPdf(body, { title: 'Test' });
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.toString('latin1')).toMatch(/\/Count [3-9]/);
    const text = await pdfToText(pdf);
    expect(text).toContain('Account Name: ACME BANK');
    expect(text).toContain('Line 90');
    expect(text).toMatch(/c[óo]mo est[áa]/);
  });
  it('round-trips a generated report through the parser', async () => {
    const pdf = renderPdf(REPORT);
    const parsed = parseReportText(await pdfToText(pdf));
    expect(parsed.bureau).toBe('experian');
    expect(parsed.tradelines.length).toBe(2);
    expect(parsed.tradelines.find((t) => t.item_type === 'collection')?.account_last4).toBe('7766');
  });
  it('rejects PDFs with no text layer with a helpful message', async () => {
    await expect(pdfToText(renderPdf(' '))).rejects.toThrow(/no readable text/);
    await expect(pdfToText(Buffer.from('%PDF-1.4 garbage'))).rejects.toThrow(/could not be read/);
  });
});
