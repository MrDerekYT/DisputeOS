import { describe, expect, it } from 'vitest';
import { isNegative } from '@/lib/credit/reporting-period';
import {
  detectLayout, parseBureauLayout, parseTransUnionAcr, TRANSUNION_CHECK_WARNING, TRANSUNION_FIELD_CONFIDENCE, TU_NO_LATES, tuNameAndNumber, tuPaymentHistory,
} from '@/lib/reports/bureau-layouts';
import { lowConfidenceFields } from '@/lib/reports/parser';
import { readReportFile } from '@/lib/reports/read-file';
import { REVIEW_THRESHOLD } from '@/lib/reports/types';
import { TU_FOOTER, TU_HEADER, TU_ROWS, TU_STACKED } from '../fixtures/transunion-acr';

// A made-up person's report in TransUnion's own layout (tests/fixtures/transunion-acr.ts), in both shapes the PDF
// reader hands rows over in.

const SHAPES = [['label and value on one line', TU_ROWS], ['label, then the value on the next line', TU_STACKED]] as const;

/** A short report in the layout, for one case at a time. */
const tu = (body: string) => `Personal Credit Report for JORDAN A. RIVERA\nFile Number:123456789\nDate Created:11/23/2026\nVisit transunion.com/dispute to start a dispute online.\n${body}`;
const account = (rows: string, history = '') => `Account Name\nSAMPLE LENDER ****7788\nAccount Information\n${rows}\nPayment History\n${history}`;

describe('TransUnion layout: detection', () => {
  it('knows TransUnion’s own report in both shapes', () => {
    expect(detectLayout(TU_ROWS)).toBe('transunion_acr');
    expect(detectLayout(TU_STACKED)).toBe('transunion_acr');
    expect(parseBureauLayout(TU_ROWS)!.bureau).toBe('transunion');
  });
  it('does not claim a file that only names the bureau', () => {
    expect(detectLayout('TransUnion Credit Report\nReport Date: 01/15/2026\n\nAccounts\nCreditor: SOME BANK\nBalance: $10')).toBeNull();
    expect(detectLayout('Personal Credit Report for JORDAN A. RIVERA\nAccount Name\nSOME BANK ****1234')).toBeNull();
  });
});

describe.each(SHAPES)('TransUnion layout: %s', (_shape, text) => {
  const p = parseTransUnionAcr(text);
  const [adverse, collection, open, closed] = p.tradelines;

  it('reads the report date, the name and the addresses', () => {
    expect(p.bureau).toBe('transunion');
    expect(p.reportDate).toBe('2026-11-23');
    expect(p.identity).toEqual([
      { bureau: 'transunion', kind: 'name', value: 'JORDAN A. RIVERA' },
      { bureau: 'transunion', kind: 'address', value: '100 MAIN ST, TAMPA, FL 33602' },
      { bureau: 'transunion', kind: 'address', value: '22 OLD RD, ORLANDO, FL 32801' },
    ]);
  });

  it('finds every account once, and nothing in the key that explains the codes', () => {
    expect(p.tradelines.map((t) => t.creditor_name)).toEqual(['FIRST BANK CARD', 'NORTH RECOVERY LLC', 'CITY AUTO FINANCE', 'OLD LENDER LLC']);
    expect(p.publicRecords).toEqual([]);
  });

  it('an account with adverse information: every value in its field, across a page break', () => {
    expect(adverse).toMatchObject({
      bureau: 'transunion', item_type: 'tradeline', creditor_name: 'FIRST BANK CARD', original_creditor: null,
      // The number is masked at the end ("411100002468****"): what is printed is not the last 4, so none is stored.
      account_last4: null,
      account_type: 'Revolving Account (CREDIT CARD)', account_status: 'Closed 09/15/2026', payment_status: 'Account 90 Days Past Due Date',
      balance_cents: 61200, credit_limit_cents: 70000, high_balance_cents: 61200,
      date_opened: '2024-01-15', date_reported: '2026-10-30', date_of_first_delinquency: null,
      payment_history: 'Jul 2026 30; Aug 2026 60; Sep 2026 90',
      remarks: 'Terms: $48 per month; paid Monthly',
    });
  });

  it('a collection: the collector, the original creditor, and when it is due to come off', () => {
    expect(collection).toMatchObject({
      item_type: 'collection', creditor_name: 'NORTH RECOVERY LLC', original_creditor: 'ACME APARTMENTS', account_last4: null,
      account_type: 'Open Account (COLLECTION AGENCY/ATTORNEY)', account_status: 'Collection', payment_status: 'In Collection',
      balance_cents: 90000, credit_limit_cents: null, high_balance_cents: null, date_opened: '2026-03-01', date_reported: '2026-11-02',
      payment_history: 'Oct 2026 COL; Nov 2026 COL',
      remarks: 'ACCT INFO DISPUTED BY CONSUMR; PLACED FOR COLLECTION · Past due: $900 · Estimated month and year this item will be removed: 05/2032',
    });
  });

  it('an open account in good standing, with its history grid split by a page break', () => {
    expect(open).toMatchObject({
      item_type: 'tradeline', creditor_name: 'CITY AUTO FINANCE', account_last4: '4821',
      account_type: 'Installment Account (AUTOMOBILE)', account_status: 'Open', payment_status: 'Current Account',
      balance_cents: 1240000, credit_limit_cents: null, high_balance_cents: 2100000, date_opened: '2022-12-28', date_reported: '2026-11-01',
      payment_history: TU_NO_LATES,
      remarks: 'Responsibility: Joint Account · Terms: $310 per month; paid Monthly for 72 months',
    });
  });

  it('a closed account that was never late', () => {
    expect(closed).toMatchObject({
      item_type: 'tradeline', creditor_name: 'OLD LENDER LLC', account_last4: '5512', account_type: 'Installment Account (UNSECURED)',
      account_status: 'Closed 12/30/2023', payment_status: 'Paid, Closed; was Paid as agreed', balance_cents: 0, high_balance_cents: 360000,
      date_opened: '2019-02-10', date_reported: '2023-12-30', payment_history: TU_NO_LATES,
      remarks: 'CLOSED · Terms: $120 per month; paid Monthly for 36 months',
    });
  });

  it('flags the late account and the collection as negative, and neither of the others', () => {
    expect(p.tradelines.map((t) => isNegative(t))).toEqual([true, true, false, false]);
  });

  it('imports hard inquiries only, one row for each date', () => {
    expect(p.inquiries).toEqual([
      { bureau: 'transunion', name: 'WELLS AUTO FINANCE', inquiry_date: '2025-06-30' },
      { bureau: 'transunion', name: 'NORTHWEST FCU', inquiry_date: '2025-07-25' },
      { bureau: 'transunion', name: 'NORTHWEST FCU', inquiry_date: '2025-07-26' },
    ]);
  });

  it('keeps the page header and footer out of every value', () => {
    const everything = JSON.stringify(p);
    expect(everything).not.toMatch(/View Your Report|annualcreditreport|disclosure\.page|3:05 PM|11\/23\/26/);
  });

  it('holds every field for a person to check', () => {
    expect(p.warnings).toEqual([TRANSUNION_CHECK_WARNING, 'Phone numbers and employers on the TransUnion report were not imported; check them on the original if they matter.']);
    expect(TRANSUNION_FIELD_CONFIDENCE).toBeLessThan(REVIEW_THRESHOLD);
    for (const t of p.tradelines) {
      expect(t.confidence).toBe(TRANSUNION_FIELD_CONFIDENCE);
      expect(Object.values(t.field_meta).map((m) => m.confidence)).toEqual(Object.keys(t.field_meta).map(() => TRANSUNION_FIELD_CONFIDENCE));
      expect(lowConfidenceFields(t)).toEqual(Object.keys(t.field_meta));
      // What was read is shown next to each field, and no full account number is kept in it.
      expect(JSON.stringify(t.field_meta)).not.toContain('411100002468');
    }
  });
});

describe('TransUnion layout: the two shapes and the page furniture', () => {
  const base = parseTransUnionAcr(TU_ROWS);

  it('reads the same report from both shapes', () => {
    expect(parseTransUnionAcr(TU_STACKED)).toEqual(base);
  });

  it('removes the header whatever stands between the hour and the minutes, and whatever kind of space is used', () => {
    for (const time of ['305 PM', '305 PM', '3:05 PM', '3:05 PM', '12:05 AM']) {
      const header = TU_HEADER.replace('3:05 PM', time);
      for (const text of [TU_ROWS, TU_STACKED]) expect(parseTransUnionAcr(text.split(TU_HEADER).join(header))).toEqual(base);
    }
  });

  it('removes a header or footer that was cut into two lines', () => {
    const cutHeader = TU_STACKED.split(TU_HEADER).join('11/23/26, 3:05 PM\nView Your Report | TransUnion Credit Report');
    expect(parseTransUnionAcr(cutHeader)).toEqual(base);
    const cutFooter = TU_STACKED.replace(new RegExp(`${TU_FOOTER.replace(/[.\/]/g, '\\$&')} (\\d/4)`, 'g'), `${TU_FOOTER}\n$1`);
    expect(cutFooter).toContain(`${TU_FOOTER}\n2/4`);
    expect(parseTransUnionAcr(cutFooter)).toEqual(base);
  });

  it('removes the footer when the print comes from another TransUnion address', () => {
    const other = TU_STACKED.split(TU_FOOTER).join('https://service.transunion.com/dss/disclosure.page');
    expect(other).not.toContain('annualcreditreport');
    expect(detectLayout(other)).toBe('transunion_acr');
    expect(parseTransUnionAcr(other)).toEqual(base);
  });

  it('removes a header and footer printed on the same line as a value', () => {
    const glued = TU_ROWS.replace('Responsibility Individual Account', `Responsibility Individual Account ${TU_HEADER} ${TU_FOOTER} 1/4`);
    expect(parseTransUnionAcr(glued)).toEqual(base);
  });

  it('a page break between "Inquiry Type" and its value does not turn the value into a company', () => {
    const at = TU_STACKED.lastIndexOf('Inquiry Type\nIndividual');
    const broken = `${TU_STACKED.slice(0, at)}Inquiry Type\n${TU_HEADER}\n${TU_FOOTER} 3/4\nIndividual${TU_STACKED.slice(at + 'Inquiry Type\nIndividual'.length)}`;
    expect(parseTransUnionAcr(broken).inquiries).toEqual(base.inquiries);
  });

  it('reads a report with no page furniture at all (text copied from the screen)', () => {
    const bare = TU_ROWS.split('\n').filter((l) => !l.startsWith('11/23/26') && !l.startsWith('https://')).join('\n');
    expect(detectLayout(bare)).toBe('transunion_acr');
    expect(parseTransUnionAcr(bare)).toEqual(base);
  });
});

describe('TransUnion layout: single cases', () => {
  it('takes the stated credit limit and high balance before the history rows', () => {
    const [t] = parseTransUnionAcr(tu(account('Balance $100\nCredit Limit $1,500\nHigh Balance $1,200\nHigh Balance (Hist.) High balance of $900 from 01/2026 to 02/2026\nCredit Limit (Hist.) Credit limit of $1,000 from 01/2026 to 02/2026\nPay Status Current Account'))).tradelines;
    expect(t).toMatchObject({ creditor_name: 'SAMPLE LENDER', account_last4: '7788', balance_cents: 10000, credit_limit_cents: 150000, high_balance_cents: 120000 });
  });

  it('from a history row: the latest credit limit and the highest balance', () => {
    const [t] = parseTransUnionAcr(tu(account('Balance $100\nHigh Balance (Hist.) High balance of $900 from 01/2026 to 02/2026; $1,400 from 03/2026 to 03/2026; $700 from 04/2026 to\n05/2026\nCredit Limit (Hist.) Credit limit of $2,000 from 01/2026 to 03/2026; $1,000 from 04/2026 to 05/2026'))).tradelines;
    expect(t).toMatchObject({ credit_limit_cents: 100000, high_balance_cents: 140000 });
  });

  it('reads a history row that runs over many lines, and takes the latest limit whichever way the list is ordered', () => {
    // Two years of months, a different amount each month, three periods to a line: eight lines for one row.
    const periods = Array.from({ length: 24 }, (_, i) => ({ amount: 1000 + i * 100, month: `${String((i % 12) + 1).padStart(2, '0')}/${2025 + Math.floor(i / 12)}` }));
    const list = (ps: typeof periods) => {
      const parts = ps.map((p) => `$${p.amount.toLocaleString('en-US')} from ${p.month} to ${p.month}`);
      return Array.from({ length: 8 }, (_, k) => parts.slice(k * 3, k * 3 + 3).join('; ')).join(';\n');
    };
    expect(list(periods).split('\n')).toHaveLength(8);
    for (const order of [periods, [...periods].reverse()]) {
      const [t] = parseTransUnionAcr(tu(account(`Balance $100\nHigh Balance (Hist.) High balance of ${list(order)}\nCredit Limit (Hist.) Credit limit of ${list(order)}\nPay Status Current Account`))).tradelines;
      // The highest balance is the largest amount; the limit is the one in force last (12/2026), not the last one printed.
      expect(t).toMatchObject({ balance_cents: 10000, high_balance_cents: 330000, credit_limit_cents: 330000, payment_status: 'Current Account' });
    }
    const [mixed] = parseTransUnionAcr(tu(account('Credit Limit (Hist.) Credit limit of $2,000 from 07/2026 to 09/2026; $900 from 01/2026 to 06/2026\nPay Status Current Account'))).tradelines;
    expect(mixed!.credit_limit_cents).toBe(200000);
  });

  it('reads an adverse pay status that ran onto a second line, in both shapes', () => {
    const want = { payment_status: 'Paid in Settlement; was Charged Off as Bad Debt', balance_cents: 0, account_status: 'Closed 03/01/2026' };
    const rows = parseTransUnionAcr(tu(account('Pay Status >Paid in Settlement; was Charged\nOff as Bad Debt<\nBalance $0\nDate Closed 03/01/2026'))).tradelines[0]!;
    const stacked = parseTransUnionAcr(tu(account('Pay Status\n>Paid in Settlement; was Charged\nOff as Bad Debt<\nBalance\n$0\nDate Closed\n03/01/2026'))).tradelines[0]!;
    expect(rows).toMatchObject(want);
    expect(stacked).toMatchObject(want);
    expect(isNegative(rows)).toBe(true);
    // A value that closes its bracket takes nothing from the line after it.
    expect(parseTransUnionAcr(tu(account('Pay Status >Charged Off<\nsome stray line\nBalance $5'))).tradelines[0]!.payment_status).toBe('Charged Off');
  });

  it('does not call an account open when its pay status could not be read', () => {
    const [t] = parseTransUnionAcr(tu(account('Balance $9'))).tradelines;
    expect(t!.account_status).toBeNull();
    expect(t!.field_meta.account_status).toBeUndefined();
    const [open] = parseTransUnionAcr(tu(account('Balance $9\nPay Status Current Account'))).tradelines;
    expect(open!.account_status).toBe('Open');
  });

  it('a wrapped history row never swallows the row after it', () => {
    const [t] = parseTransUnionAcr(tu(account('High Balance (Hist.) High balance of $900 from 01/2026 to 02/2026;\n$1,400 from 03/2026 to 03/2026\nBalance $55\nPay Status Current Account'))).tradelines;
    expect(t).toMatchObject({ balance_cents: 5500, high_balance_cents: 140000, payment_status: 'Current Account' });
  });

  it('a row with nothing in it stays empty instead of taking the next label', () => {
    const [t] = parseTransUnionAcr(tu(account('Original Creditor\nBalance\n$40\nDate Closed\nPay Status\nCurrent Account'))).tradelines;
    expect(t).toMatchObject({ item_type: 'tradeline', original_creditor: null, balance_cents: 4000, account_status: 'Open', payment_status: 'Current Account' });
  });

  it('says closed when only the pay status says so', () => {
    const [t] = parseTransUnionAcr(tu(account('Balance $0\nPay Status Paid, Closed; was Paid as agreed'))).tradelines;
    expect(t!.account_status).toBe('Closed');
    expect(isNegative(t!)).toBe(false);
  });

  it('a charged-off account is negative through its pay status', () => {
    const [t] = parseTransUnionAcr(tu(account('Balance $610\nPay Status >Charged Off<\nDate Closed 02/01/2026', '01/2026\nRating\nc/o'))).tradelines;
    expect(t).toMatchObject({ item_type: 'tradeline', account_status: 'Closed 02/01/2026', payment_status: 'Charged Off', payment_history: 'Jan 2026 c/o' });
    expect(isNegative(t!)).toBe(true);
  });

  it('takes the report date from "Date Created" when there is no "Credit Report Date" row', () => {
    expect(parseTransUnionAcr(tu(account('Balance $1'))).reportDate).toBe('2026-11-23');
  });

  it('warns about a public records section that holds a record, and not about an empty one', () => {
    const note = 'This report has a Public Records section. Public records are not imported from this layout: add them from the original by hand.';
    expect(parseTransUnionAcr(tu(`Public Records\nCHAPTER 7 BANKRUPTCY Docket 26-10001\nDate Filed 01/02/2026\n${account('Balance $1')}`)).warnings).toContain(note);
    // "No." in a docket number, or "not" in a record's text, does not make the section empty.
    expect(parseTransUnionAcr(tu(`Public Records\nCHAPTER 13 BANKRUPTCY Docket No. 26-10001\nDebt not discharged\n${account('Balance $1')}`)).warnings).toContain(note);
    for (const none of ['No public records were found.', 'None', 'You have no public records on file.', 'No records found']) {
      expect(parseTransUnionAcr(tu(`Public Records\n${none}\n${account('Balance $1')}`)).warnings).not.toContain(note);
    }
    expect(parseTransUnionAcr(TU_ROWS).warnings).not.toContain(note);
  });

  it('takes only a date for the closing date', () => {
    // In the stacked shape an empty "Date Closed" row is followed by a row this reader has no name for.
    const [t] = parseTransUnionAcr(tu(account('Pay Status\nCurrent Account\nDate Closed\nSome Other Row\nsome value\nBalance\n$12'))).tradelines;
    expect(t).toMatchObject({ account_status: 'Open', payment_status: 'Current Account', balance_cents: 1200 });
  });

  it('keeps a row it does not import out of the remarks before it', () => {
    const [t] = parseTransUnionAcr(tu(account('Pay Status >Account 30 Days Past Due Date<\nRemarks\nACCT INFO DISPUTED BY CONSUMR\nMaximum Delinquency\n>Maximum Delinquency of 30 days in 09/2026<\nBalance\n$70'))).tradelines;
    expect(t).toMatchObject({ remarks: 'ACCT INFO DISPUTED BY CONSUMR', balance_cents: 7000 });
  });

  it('says so when an account has no readable name, and imports the others', () => {
    const p = parseTransUnionAcr(tu(`Account Name\nAccount Information\nBalance $5\nPayment History\n${account('Balance $9')}`));
    expect(p.tradelines.map((t) => t.creditor_name)).toEqual(['SAMPLE LENDER']);
    expect(p.warnings).toContain('An account on the TransUnion report has no readable name and was not imported; check the original.');
  });

  it('checks itself: accounts that came out with few or no details are pointed out', () => {
    const note = (n: string) => `${n} read with few or no details. The file may be laid out differently from what the reader knows: compare every value with the original before approving.`;
    // All the labels first and the values after them: a layout this reader does not know. Most rows come out empty
    // and the last label takes the first value, so the little that is read cannot be trusted. The reader says so.
    const columns = tu('Account Name\nSAMPLE LENDER ****7788\nAccount Information\nBalance\nDate Opened\nPay Status\n$310\n01/15/2024\nCurrent Account\nPayment History');
    const p = parseTransUnionAcr(columns);
    expect(p.tradelines).toHaveLength(1);
    expect(p.tradelines[0]).toMatchObject({ creditor_name: 'SAMPLE LENDER', balance_cents: null, date_opened: null });
    expect(p.warnings).toContain(note('1 account on the TransUnion report was'));
    // Accounts with a name and nothing else.
    const two = parseTransUnionAcr(tu(`Account Name\nLENDER A ****1111\nAccount Information\nPayment History\nAccount Name\nLENDER B ****2222\nAccount Information\nPayment History\n${account('Balance $9')}`));
    expect(two.tradelines).toHaveLength(3);
    expect(two.warnings).toContain(note('2 accounts on the TransUnion report were'));
    // A row or two with nothing in them is ordinary, and so are both shapes of the full report.
    for (const fine of [tu(account('Original Creditor\nBalance\n$40\nDate Closed\nPay Status\nCurrent Account')), tu(account('Balance $9')), TU_ROWS, TU_STACKED]) {
      expect(parseTransUnionAcr(fine).warnings.join(' ')).not.toMatch(/few or no details/);
    }
  });

  it('checks itself: an inquiry section with dates and nothing readable is pointed out', () => {
    const note = 'The Regular Inquiries section of the TransUnion report shows dates, but no inquiry could be read from it. Add the hard inquiries from the original by hand.';
    const unknown = parseTransUnionAcr(tu(`${account('Balance $1')}\nInquiries\nRegular Inquiries\nWELLS AUTO FINANCE\nPO BOX 1 IRVING, TX 75016\nRequested 06/30/2025\nAdditional Information`));
    expect(unknown.inquiries).toEqual([]);
    expect(unknown.warnings).toContain(note);
    // An empty section, or one that was read, says nothing.
    expect(parseTransUnionAcr(tu(`${account('Balance $1')}\nInquiries\nRegular Inquiries\nAdditional Information`)).warnings).not.toContain(note);
    expect(parseTransUnionAcr(TU_ROWS).warnings).not.toContain(note);
  });

  it('reads no inquiries from the soft sections', () => {
    const soft = tu(`${account('Balance $1')}\nInquiries\nPromotional Inquiries\nName\nPROMO BANK\nLocation Requested On Phone\nPO BOX 2\nWILMINGTON, DE 19850\n05/01/2026 (888) 555-0104\nAccount Review Inquiries\nName\nREVIEW BANK\nLocation Requested On Phone\nPO BOX 3\n06/01/2026 (888) 555-0107`);
    expect(parseTransUnionAcr(soft).inquiries).toEqual([]);
  });

  it('keeps a hard inquiry whose date could not be read, without inventing one', () => {
    const p = parseTransUnionAcr(tu(`${account('Balance $1')}\nInquiries\nRegular Inquiries\nName\nWELLS AUTO FINANCE\nLocation Requested On Phone\nPO BOX 1\nIRVING, TX 75016\n(888) 555-0103\nInquiry Type\nIndividual`));
    expect(p.inquiries).toEqual([{ bureau: 'transunion', name: 'WELLS AUTO FINANCE', inquiry_date: null }]);
  });
});

describe('TransUnion layout: name and number', () => {
  it('splits the name from the masked number wherever the mask is', () => {
    expect(tuNameAndNumber('FIRST BANK CARD 411100002468****')).toEqual({ name: 'FIRST BANK CARD', number: '411100002468****' });
    expect(tuNameAndNumber('FIRST BANK CARD 411100002468 ****')).toEqual({ name: 'FIRST BANK CARD', number: '411100002468****' });
    expect(tuNameAndNumber('CITY AUTO FINANCE ****4821')).toEqual({ name: 'CITY AUTO FINANCE', number: '****4821' });
    expect(tuNameAndNumber('CITY AUTO FINANCE **** 4821')).toEqual({ name: 'CITY AUTO FINANCE', number: '****4821' });
    expect(tuNameAndNumber('>NORTH RECOVERY LLC< 88123****')).toEqual({ name: 'NORTH RECOVERY LLC', number: '88123****' });
  });
  it('leaves a name without a number alone, digits in it included', () => {
    expect(tuNameAndNumber('SAMPLE LENDER')).toEqual({ name: 'SAMPLE LENDER', number: null });
    expect(tuNameAndNumber('BANK 24')).toEqual({ name: 'BANK 24', number: null });
  });
});

describe('TransUnion layout: payment history', () => {
  const month = (m: string, rating: string, remark = '---') => [m, 'Balance $10', 'Past Due $0', 'Scheduled Payment $5', `Remarks ${remark}`, 'Rating', rating];

  it('keeps only the late months, in TransUnion’s own codes', () => {
    expect(tuPaymentHistory([...month('05/2026', 'OK'), ...month('06/2026', '30'), ...month('07/2026', '120'), ...month('08/2026', 'c/o'), ...month('09/2026', 'N/R'), ...month('10/2026', 'X')]))
      .toBe('Jun 2026 30; Jul 2026 120; Aug 2026 c/o');
  });
  it('says so in words when no month is late: no number that could be taken for a late code', () => {
    expect(tuPaymentHistory([...month('05/2030', 'OK'), ...month('06/2030', 'OK')])).toBe(TU_NO_LATES);
    expect(TU_NO_LATES).not.toMatch(/\d/);
  });
  it('never takes a remark code for a rating', () => {
    expect(tuPaymentHistory([...month('05/2026', 'OK', 'FC'), ...month('06/2026', 'OK', 'CBG')])).toBe(TU_NO_LATES);
  });
  it('stays within 120 characters and says how many months were left out', () => {
    const many = Array.from({ length: 24 }, (_, i) => month(`${String((i % 12) + 1).padStart(2, '0')}/${2025 + Math.floor(i / 12)}`, '30')).flat();
    const out = tuPaymentHistory(many)!;
    expect(out.length).toBeLessThanOrEqual(120);
    expect(out).toMatch(/^Jan 2025 30; Feb 2025 30; .*; \+\d+ more$/);
    const shown = out.split('; ').length - 1;
    expect(out.endsWith(`+${24 - shown} more`)).toBe(true);
  });
  it('when months and ratings do not pair up, keeps the late codes and guesses no month', () => {
    expect(tuPaymentHistory(['05/2026', '06/2026', '07/2026', 'Rating', '30', 'Rating', 'COL'])).toBe('Late codes reported: 30, COL (months not matched; see the original)');
    expect(tuPaymentHistory(['05/2026', '06/2026', '07/2026', 'Rating', 'OK', 'Rating', 'OK'])).toBeNull();
  });
  it('gives nothing when there is no rating to read', () => {
    expect(tuPaymentHistory([])).toBeNull();
    expect(tuPaymentHistory(['05/2026', 'Balance $10'])).toBeNull();
  });
});

describe('TransUnion layout: import', () => {
  const payer = { orgId: 'o', userId: 'u' };
  const credits = { spend: async () => { throw new Error('must not charge'); }, settle: async () => undefined, refund: async () => undefined };
  const ocr = async () => { throw new Error('must not call AI'); };

  it.each(SHAPES)('is read by the exact reader with AI on or off: no AI, no credits (%s)', async (_shape, text) => {
    for (const on of [true, false]) {
      const r = await readReportFile({ bytes: Buffer.from(text), mime: 'text/plain', name: 'transunion.txt' }, payer, { enabled: () => on, ocr, credits: credits as never });
      expect(r.via).toBe('layout');
      expect(r.parsed.bureau).toBe('transunion');
      expect(r.parsed.tradelines).toHaveLength(4);
      expect(r.parsed.inquiries).toHaveLength(3);
    }
  });
});
