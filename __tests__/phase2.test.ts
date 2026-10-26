import {
  parseReportText,
  normalizeDate,
  parseMoneyToCents,
  maskSnippet,
  lowConfidenceFields,
} from '@/lib/parser';
import { diffReports, fingerprint } from '@/lib/diff';
import { detectMime, sanitizeFileName, storagePath } from '@/lib/upload';

const REPORT = `Experian Credit Report

Accounts

Account Name: Big Bank Visa
Account #: 4111111111111234
Balance: $1,250.50
Status: Open
Date Opened: 03/15/2019
Date Reported: 2026-01-15

Collections

Account Name: Example Collections LLC
Original Creditor: Old Telecom
Account Number: 0099887766
Balance: 540
Status: Collection
Date Opened: 13/45/2022
Date of First Delinquency: Jan 5, 2020
Bureau: TransUnion

Hard Inquiries

Company: Lender X
Date Reported: 02/02/2025
`;

test('dates and money', () => {
  expect(normalizeDate('3/5/19')).toBe('2019-03-05');
  expect(normalizeDate('Jan 5, 2020')).toBe('2020-01-05');
  expect(normalizeDate('02/30/2020')).toBeNull();
  expect(parseMoneyToCents('$1,250.50')).toBe(125050);
  expect(parseMoneyToCents('abc')).toBeNull();
});

test('parses sections, fields, bureaus and masks account numbers', () => {
  const items = parseReportText(REPORT);
  expect(items).toHaveLength(3);
  const [card, coll, inq] = items;
  expect(card.bureau.value).toBe('experian');
  expect(card.account_last4.value).toBe('1234');
  expect(card.balance_cents.value).toBe(125050);
  expect(card.date_opened.value).toBe('2019-03-15');
  expect(coll.item_type.value).toBe('collection');
  expect(coll.original_creditor.value).toBe('Old Telecom');
  expect(coll.bureau.value).toBe('transunion');
  expect(coll.date_of_first_delinquency.value).toBe('2020-01-05');
  expect(inq.item_type.value).toBe('inquiry');
  expect(JSON.stringify(items)).not.toMatch(/4111111111111234|0099887766/);
});

test('invalid values get low confidence and are flagged for review', () => {
  const coll = parseReportText(REPORT)[1];
  expect(coll.date_opened.value).toBeNull();
  expect(lowConfidenceFields(coll)).toContain('date_opened');
});

test('HTML input is converted and scripts dropped', () => {
  const html =
    '<html><script>alert(1)</script><body><p>Account Name: Acme</p><p>Balance: $5</p></body></html>';
  const [i] = parseReportText(html, 'html');
  expect(i.creditor_name.value).toBe('Acme');
  expect(i.balance_cents.value).toBe(500);
});

test('maskSnippet hides SSNs and long numbers', () => {
  expect(maskSnippet('SSN 123-45-6789 acct 5500005555555559')).not.toMatch(/6789|5555555/);
});

test('diff detects deleted / added / updated', () => {
  const mk = (c: string, bal: number | null, st = 'Open') => ({
    bureau: 'equifax',
    creditor_name: c,
    account_last4: '1111',
    balance_cents: bal,
    account_status: st,
  });
  const d = diffReports(
    [mk('A Co', 100), mk('B Co', 200), mk('C Co', 300)],
    [mk('a co.', 150), mk('C Co', 300), mk('D Co', 1)],
  );
  expect(d.deleted.map((i) => i.creditor_name)).toEqual(['B Co']);
  expect(d.added.map((i) => i.creditor_name)).toEqual(['D Co']);
  expect(d.updated[0].changes).toEqual(['balance']);
  expect(d.unchanged).toHaveLength(1);
  expect(fingerprint(mk('A Co', 1))).toBe(fingerprint(mk('a co.', 2)));
});

test('upload validation uses magic bytes, not names', () => {
  expect(detectMime(new TextEncoder().encode('%PDF-1.7 ...'))).toBe('application/pdf');
  expect(detectMime(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toBe(
    'image/png',
  );
  expect(detectMime(new TextEncoder().encode('<!DOCTYPE html><p>x'))).toBe('text/html');
  expect(detectMime(new TextEncoder().encode('hello'))).toBe('text/plain');
  expect(detectMime(new Uint8Array([0x4d, 0x5a, 0x90, 0, 3, 0, 0, 0]))).toBeNull(); // Windows executable
});

test('file names and storage paths are traversal-safe', () => {
  expect(sanitizeFileName('../../etc/passwd')).toBe('passwd');
  expect(sanitizeFileName('..\\..\\evil.exe')).toBe('evil.exe');
  expect(sanitizeFileName('.hidden')).toBe('hidden');
  expect(sanitizeFileName('')).toBe('file');
  const p = storagePath('org1', 'cl1', '../x y.pdf');
  expect(p).toMatch(/^org1\/cl1\/[0-9a-f-]{36}-x y\.pdf$/);
});
