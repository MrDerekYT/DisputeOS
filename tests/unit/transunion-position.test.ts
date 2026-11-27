import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseBureauLayout, readingScore, TRANSUNION_CHECK_WARNING, TRANSUNION_FIELD_CONFIDENCE, tuTextFromLines } from '@/lib/reports/bureau-layouts';
import { readPdfLines, readPdfText } from '@/lib/reports/pdf-text';
import { readReportFile } from '@/lib/reports/read-file';
import { analyze, printedRemovalMonth, type AnalysisTradeline } from '@/lib/reports/analysis';
import { categoryForFinding } from '@/lib/disputes/workflow';
import type { ParsedTradeline } from '@/lib/reports/types';

/**
 * The TransUnion reader on files its own author did not write: three generated reports from the MIT-licensed Errata
 * project (tests/fixtures/errata/NOTICE.md), every person and account in them invented. They lay an account out the
 * way the page does: up to three labels in a row, each value under its label. Read in the order the file stores its
 * text, that grid cannot be told apart; read by position it can.
 */
const file = (name: string) => readFileSync(`tests/fixtures/errata/${name}`);
const read = (name: string) => readReportFile({ bytes: file(name), mime: 'application/pdf', name }, { orgId: 'o', userId: 'u' }, { enabled: () => false });
const row = (t: ParsedTradeline) => [t.item_type, t.creditor_name, t.account_type, t.account_status, t.payment_status, t.balance_cents, t.credit_limit_cents, t.high_balance_cents, t.date_opened, t.date_reported, t.original_creditor, t.payment_history, t.remarks];

describe('a TransUnion report laid out as a grid, read by position', () => {
  it('reads every account of the 6-page sample, field by field', async () => {
    const r = await read('tu_planted.pdf');
    expect(r.via).toBe('layout');
    expect(r.pages).toBe(6);
    expect(r.parsed.bureau).toBe('transunion');
    expect(r.parsed.reportDate).toBe('2026-10-20');
    expect(r.parsed.tradelines.map(row)).toEqual([
      ['tradeline', 'EXAMPLE SECURED CARD', 'Revolving Account (CREDIT CARD)', 'Closed 09/27/2024', 'Paid, Closed; was Paid as agreed', 0, 30000, 31000, '2019-05-12', '2024-10-31', null, 'May 2024 30; Jun 2024 60; Jul 2024 90', 'CLOSED BY CREDIT GRANTOR; CLOSED · Terms: Paid Monthly'],
      ['tradeline', 'SAMPLE AUTO FINANCE', 'Installment Account (AUTOMOBILE)', 'Closed 12/20/2023', 'Paid, Closed; was Paid as agreed', 0, null, 3145000, '2019-08-15', '2023-12-20', null, 'Apr 2022 30', 'CLOSED · Terms: $0 per month, paid Monthly for 54 months'],
      ['tradeline', 'EXAMPLE STATE CHILD SUPPORT OFFICE', 'Open Account (CHILD SUPPORT)', 'Open', 'Account 60 Days Past Due Date', 180000, null, null, '2021-03-09', '2026-09-22', null, 'Sep 2026 60', 'Estimated month and year this item will be removed: 08/2033 · Terms: Paid Monthly'],
      ['tradeline', 'PAYLATER EXAMPLE INC', 'Installment Account (UNSECURED)', 'Open', 'Account 30 Days Past Due Date', 27200, null, 54000, '2025-07-21', '2026-10-02', 'EXAMPLE PARTNER BANK', 'Aug 2026 30', 'Estimated month and year this item will be removed: 06/2033 · Terms: $0 per month, paid Monthly for 12 months'],
      ['tradeline', 'PAYLATER EXAMPLE INC', 'Installment Account (UNSECURED)', 'Open', 'Account 30 Days Past Due Date', 12000, null, null, '2026-02-10', '2026-10-02', 'EXAMPLE PARTNER BANK', 'Jul 2026 30', 'Estimated month and year this item will be removed: 06/2033 · Terms: $0 per month, paid Monthly for 6 months'],
      ['tradeline', 'OLD EXAMPLE RETAIL', 'Revolving Account (CHARGE ACCOUNT)', null, 'Charged Off', 64000, 80000, null, '2016-05-02', '2026-09-27', null, 'Jun 2018 30; Jul 2018 60; Aug 2018 90; Sep 2018 120; Oct 2018 c/o', 'Estimated month and year this item will be removed: 12/2024 · PROFIT AND LOSS WRITEOFF'],
      ['tradeline', 'MIDTOWN EXAMPLE CARD', 'Revolving Account (CREDIT CARD)', null, 'Charged Off', 231000, 250000, null, '2018-03-11', '2026-10-01', null, 'Jan 2021 30; Feb 2021 60; Mar 2021 90; Apr 2021 120; May 2021 c/o; Jun 2021 c/o', 'Estimated month and year this item will be removed: 06/2030 · PROFIT AND LOSS WRITEOFF'],
      ['tradeline', 'NORTHWIND EXAMPLE BANK', 'Revolving Account (CREDIT CARD)', null, 'Charged Off', 184000, 200000, null, '2020-08-19', '2026-08-31', null, 'Apr 2024 30; May 2024 60; Jun 2024 90; Jul 2024 120; Aug 2024 c/o; Sep 2024 c/o', 'Estimated month and year this item will be removed: 03/2031 · PROFIT AND LOSS WRITEOFF; TRANSFERRED TO RECOVERY'],
      ['tradeline', 'PROGRESSION EXAMPLE CARD', 'Revolving Account (CREDIT CARD)', 'Open', 'Current Account', 41000, 50000, null, '2021-02-17', '2026-09-27', null, 'Apr 2026 30; May 2026 60; Jun 2026 90', 'Terms: $35 per month; paid Monthly'],
      ['collection', 'EXAMPLE DEBT BUYERS LLC', 'Open Account (FACTORING COMPANY ACCOUNT)', 'Collection', 'Collection', 151200, null, 153000, '2026-05-27', '2026-10-02', 'EXAMPLE ONE BANK', null, 'Estimated month and year this item will be removed: 08/2032 · PLACED FOR COLLECTION · Past due: $1,512'],
      ['collection', 'SAMPLE ASSET RECOVERY', 'Open Account (FACTORING COMPANY ACCOUNT)', 'Collection', 'Collection', 74000, null, 76000, '2026-06-02', '2026-10-08', 'SAMPLE RETAIL BANK', null, 'Estimated month and year this item will be removed: 08/2032 · PLACED FOR COLLECTION · Past due: $740'],
      ['collection', 'TEST RECEIVABLES LLC', 'Open Account (FACTORING COMPANY ACCOUNT)', 'Collection', 'Collection', 184000, null, 184000, '2026-05-19', '2026-10-17', 'NORTHWIND EXAMPLE BANK', null, 'Estimated month and year this item will be removed: 08/2032 · PLACED FOR COLLECTION · Past due: $1,840'],
      ['tradeline', 'EXAMPLE CARD BANK', 'Revolving Account (CREDIT CARD)', 'Open', 'Current Account', 122500, 500000, null, '2025-02-04', '2026-10-10', null, 'No late payments in the months reported', 'Terms: $40 per month; paid Monthly'],
      ['tradeline', 'SAMPLE MORTGAGE CO', 'Mortgage Account (CONVENTIONAL REAL ESTATE MORTGAGE)', 'Open', 'Current Account', 21240000, null, 24000000, '2021-05-20', '2026-10-01', null, 'No late payments in the months reported', 'Responsibility: Joint Account · Terms: $1,620 per month, paid Monthly for 360 months'],
      ['tradeline', 'EXAMPLE CREDIT UNION', 'Installment Account (AUTOMOBILE)', 'Closed 03/04/2024', 'Paid, Closed; was Paid as agreed', 0, null, 1670000, '2019-03-04', '2024-03-04', null, 'No late payments in the months reported', 'CLOSED · Terms: $310 per month, paid Monthly for 60 months'],
    ]);
  });

  it('keeps every value below the review threshold, masks stay unread, and nothing is reported as badly read', async () => {
    const { parsed } = await read('tu_planted.pdf');
    expect(parsed.tradelines.every((t) => t.confidence === TRANSUNION_FIELD_CONFIDENCE)).toBe(true);
    // "4000111122****" shows the first digits and hides the last four, so no last four are stored.
    expect(parsed.tradelines.every((t) => t.account_last4 === null)).toBe(true);
    expect(parsed.warnings).toEqual([TRANSUNION_CHECK_WARNING, 'Phone numbers and employers on the TransUnion report were not imported; check them on the original if they matter.']);
  });

  it('reads the hard inquiries only, each with its date, and the names and addresses', async () => {
    const { parsed } = await read('tu_planted.pdf');
    expect(parsed.inquiries.map((q) => [q.name, q.inquiry_date])).toEqual([['EXAMPLE LENDING CO', '2026-05-18'], ['SAMPLE AUTO GROUP', '2026-02-09'], ['EXAMPLE CARD BANK', '2025-02-04']]);
    expect(parsed.identity.map((i) => [i.kind, i.value])).toEqual([
      ['name', 'JORDAN QUINN SAMPLE'],
      ['address', '100 EXAMPLE AVE ANYTOWN, TX 75001-1234'],
      ['address', '100 EXAMPLE AVE APT 100EXA ANYTOWN, TX 75001-1234'],
      ['address', '22 TESTING RD APT 5 SAMPLEVILLE, OK 73001-0001'],
      ['address', '22 TESTING RD APT 55 SAMPLEVILLE, OK 73001-0002'],
      ['address', '4 PLACEHOLDER CT FICTION CITY, TX 75002-4444'],
    ]);
  });

  it('reads the two other samples: a clean report and a later round', async () => {
    const clean = (await read('tu_clean.pdf')).parsed;
    expect(clean.tradelines.map((t) => t.creditor_name)).toEqual(['EXAMPLE CARD BANK', 'SAMPLE MORTGAGE CO', 'EXAMPLE CREDIT UNION']);
    expect(clean.inquiries.map((q) => [q.name, q.inquiry_date])).toEqual([['EXAMPLE CARD BANK', '2025-02-04']]);
    const later = (await read('tu_round2.pdf')).parsed;
    expect(later.reportDate).toBe('2026-12-01');
    expect(later.tradelines).toHaveLength(12);
    expect(later.inquiries.map((q) => [q.name, q.inquiry_date])).toContainEqual(['NEW EXAMPLE AUTO LENDER', '2026-11-20']);
    expect(later.tradelines.find((t) => t.creditor_name === 'OLD EXAMPLE RETAIL')).toBeUndefined();
  });

  it('is chosen over the reading in stored order, which cannot tell the grid’s values apart', async () => {
    const stored = parseBureauLayout((await readPdfText(file('tu_planted.pdf'))).text)!;
    const placed = (await read('tu_planted.pdf')).parsed;
    expect(readingScore(placed)).toBeGreaterThan(readingScore(stored));
    expect(stored.tradelines.some((t) => t.creditor_name === 'EXAMPLE SECURED CARD')).toBe(false);
  });
});

describe('the grid rewritten one value per line', () => {
  const L = (...cells: [number, string][]) => ({ cells: cells.map(([x, s]) => ({ x, s })) });
  it('gives each value to the label it sits under, across wrapped lines', () => {
    expect(tuTextFromLines([
      L([20, 'Accounts with Adverse Information']),
      L([14, 'Account Name'], [300, 'Account Number']),
      L([14, 'FIRST EXAMPLE'], [300, '4000****']),
      L([14, 'BANK NA']),
      L([14, 'Address'], [206, 'Phone'], [400, 'Monthly Payment']),
      L([14, 'ONE PLAZA DETROIT, MI'], [206, '(313) 555-0120'], [400, '$0']),
      L([14, '48226']),
      L([14, 'Pay Status'], [206, 'Terms'], [400, 'Date Closed']),
      L([14, 'Paid, Closed; was Paid as agreed'], [206, '$0 per month, paid Monthly'], [400, '12/20/2023']),
      L([206, 'for 54 months']),
      L([14, 'Maximum Delinquency Note'], [300, 'Remarks']),
      L([14, 'Maximum Delinquency of 60 days in 04/2022'], [300, 'CLOSED']),
      L([14, 'for $410']),
      L([14, 'Payment History']),
      L([14, 'Nov 2021'], [100, 'Dec 2021']),
      L([14, 'OK'], [100, '30']),
    ]).split('\n')).toEqual([
      'Accounts with Adverse Information',
      'Account Name FIRST EXAMPLE BANK NA 4000****',
      'Address ONE PLAZA DETROIT, MI 48226', 'Phone (313) 555-0120', 'Monthly Payment $0',
      'Pay Status Paid, Closed; was Paid as agreed', 'Terms $0 per month, paid Monthly for 54 months', 'Date Closed 12/20/2023',
      'Maximum Delinquency Note Maximum Delinquency of 60 days in 04/2022 for $410', 'Remarks CLOSED',
      'Payment History', 'Nov 2021 Dec 2021', 'OK 30',
    ]);
  });
  it('leaves a row that carries its own label alone, and a label with nothing under it empty', () => {
    expect(tuTextFromLines([
      L([14, 'Account Name']),
      L([14, 'FIRST BANK CARD 411100002468****']),
      L([14, 'Account Information']),
      L([14, 'Balance'], [120, '$612']),
      L([14, 'Date Closed']),
      L([14, 'High Balance (Hist.)'], [150, '$700 from 01/2020 to 06/2021']),
      L([14, 'Remarks']),
      L([14, 'ACCOUNT CLOSED BY CONSUMER']),
    ]).split('\n')).toEqual([
      'Account Name FIRST BANK CARD 411100002468****', 'Account Information', 'Balance $612', 'Date Closed',
      'High Balance (Hist.) $700 from 01/2020 to 06/2021', 'Remarks ACCOUNT CLOSED BY CONSUMER',
    ]);
  });
  it('drops the page header and footer between a row of labels and its values, and touches nothing outside an account', () => {
    expect(tuTextFromLines([
      L([14, 'Remarks']),
      L([14, 'AID: Account information disputed by consumer']),
      L([14, 'Account Name'], [300, 'Account Number']),
      L([14, 'CITY AUTO'], [300, '77****']),
      L([14, 'Loan Type'], [206, 'Balance'], [400, 'Date Updated']),
      L([14, 'https://annualcreditreport.transunion.com/dss/disclosure.page'], [530, '7/16']),
      L([530, '2 / 6']),
      L([14, '11/23/26, 3:05 PM'], [250, 'View Your Report | TransUnion Credit Report']),
      L([14, 'AUTOMOBILE'], [206, '$12,400'], [400, '11/01/2026']),
      L([14, 'Regular Inquiries']),
      L([14, 'Name'], [400, 'Requested On']),
      L([14, 'ACME LENDING'], [400, '05/18/2026']),
      L([14, 'Location'], [206, 'Phone'], [400, 'Inquiry Type']),
    ]).split('\n')).toEqual([
      'Remarks', 'AID: Account information disputed by consumer',
      'Account Name CITY AUTO 77****', 'Loan Type AUTOMOBILE', 'Balance $12,400', 'Date Updated 11/01/2026',
      'Regular Inquiries', 'Name Requested On', 'ACME LENDING 05/18/2026', 'Location Phone Inquiry Type',
    ]);
  });
  it('gives the page as lines of cells, left to right and top to bottom', async () => {
    const lines = await readPdfLines(file('tu_clean.pdf'));
    const at = lines.findIndex((l) => l.cells[0]?.s === 'Account Name');
    expect(lines[at]!.cells.map((c) => c.s)).toEqual(['Account Name', 'Account Number']);
    expect(lines[at + 1]!.cells.map((c) => c.s)).toEqual(['EXAMPLE CARD BANK', '4929000011****']);
    expect(lines[at + 1]!.cells[0]!.x).toBeLessThan(lines[at + 1]!.cells[1]!.x);
    expect(lines.every((l, n) => n === 0 || l.page > lines[n - 1]!.page || l.y >= lines[n - 1]!.y)).toBe(true);
  });
});

describe('the removal month a bureau prints', () => {
  let seq = 0;
  const T = (o: Partial<AnalysisTradeline> = {}): AnalysisTradeline => ({
    id: `r${++seq}`, bureau: 'transunion', item_type: 'collection', creditor_name: 'TEST RECEIVABLES LLC', original_creditor: 'A BANK', account_last4: null, account_status: 'Collection',
    payment_status: 'Collection', balance_cents: 184000, credit_limit_cents: null, date_opened: '2026-05-19', date_reported: '2026-10-17',
    date_of_first_delinquency: null, payment_history: null, user_provided: {}, remarks: 'Estimated month and year this item will be removed: 08/2032 · PLACED FOR COLLECTION', ...o,
  });
  const run = (t: AnalysisTradeline) => analyze({ tradelines: [t], inquiries: [], publicRecords: [], identity: [], now: new Date('2026-11-27T00:00:00Z') });

  it('is read from the account’s notes, in either wording', () => {
    expect(printedRemovalMonth({ remarks: 'Estimated month and year this item will be removed: 08/2032 · PLACED FOR COLLECTION' })).toBe('2032-08');
    expect(printedRemovalMonth({ remarks: 'Estimated month and year that this item will be removed 12/2024' })).toBe('2024-12');
    expect(printedRemovalMonth({ remarks: 'PLACED FOR COLLECTION' })).toBeNull();
    expect(printedRemovalMonth({ remarks: null })).toBeNull();
  });
  it('stands in for a date of first delinquency: the account is not flagged for showing none', () => {
    expect(run(T()).map((f) => f.category)).toEqual(['collection_validation']);
    expect(run(T({ remarks: 'PLACED FOR COLLECTION' })).map((f) => f.category)).toEqual(['dofd_mismatch', 'collection_validation']);
  });
  it('is flagged when the account was still updated after it, with both printed values, as a request to verify', () => {
    const t = T({ item_type: 'tradeline', creditor_name: 'OLD EXAMPLE RETAIL', original_creditor: null, account_status: null, payment_status: 'Charged Off', date_reported: '2026-09-27',
      remarks: 'Estimated month and year this item will be removed: 12/2024 · PROFIT AND LOSS WRITEOFF' });
    const f = run(t).find((x) => x.category === 'removal_month_passed')!;
    expect(f.severity).toBe('strong');
    expect(f.title).toBe('OLD EXAMPLE RETAIL on TransUnion was still reported after the removal month the report prints');
    expect(f.evidence.map((e) => [e.field, e.value])).toEqual([['Estimated removal month, as printed', '12/2024'], ['Date updated', '2026-09-27']]);
    expect(f.explanation).toContain('not a conclusion that anything is inaccurate');
    expect(categoryForFinding(f)).toBe('other');
    // Updated in the removal month itself, or before it: nothing to flag.
    expect(run({ ...t, id: 'same', date_reported: '2024-12-30' }).some((x) => x.category === 'removal_month_passed')).toBe(false);
    expect(run({ ...t, id: 'before', date_reported: '2024-06-01' }).some((x) => x.category === 'removal_month_passed')).toBe(false);
  });
});
