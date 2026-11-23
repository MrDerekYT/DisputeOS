import { describe, expect, it } from 'vitest';
import { detectLayout, last4, parseEquifaxAcr, parseExperianAcr } from '@/lib/reports/bureau-layouts';
import { readReportFile } from '@/lib/reports/read-file';

// Made-up people and accounts, laid out exactly as text comes out of the AnnualCreditReport.com PDFs.

const EXPERIAN = `Prepared For
JORDAN RIVERA
Personal & Confidential
Date Generated Nov 23, 2026
Report Number 1111-2222-33
2 Accounts 0 Public Records 3 Hard Inquiries
Personal Information
11/23/26, 3:34 PM Annual Credit Report - Experian
https://usa.experian.com/acr/printReport?type=CDI 1/9
Names
JORDAN RIVERA
Name ID #123
JORDAN A
RIVERA
Name ID #456
Addresses
100 MAIN
ST
TAMPA FL, 33602-
1234
Address ID
#0001
Single family
Accounts
Includes credit cards
 Account Info
Account Name FIRST BANK CARD
Account Number 4111XXXXXXXX
Account Type Credit card
Responsibility Individual
Interest Type Variable
Date Opened 01/15/2024
Status Open. $120 past due as of Oct 2026.
Status Updated Oct 2026
Balance $1,050
Balance Updated 10/30/2026
Recent Payment $40 as of 10/01/2026
Monthly Payment $35
Original Balance -
Highest Balance $1,200
Credit Limit $1,500
Terms -
On Record Until Jan 2033
 Payment History
2026
J
—
 Balance Histories
Date Balance Scheduled Payment Paid
Payment history guide
30 days past due as of Oct 2026
COLLECTOR ONE
POTENTIALLY NEGATIVE
 Account Info
Account Name COLLECTOR ONE
Account Number 9988XX
Account Type Collection
Responsibility Joint with SAM RIVERA
Date Opened 03/01/2026
Status Collection account. $900 past due as of Nov 2026.
Status Updated Mar 2026
Balance $900
Balance Updated 11/02/2026
Original Balance $850
Highest Balance -
On Record Until Aug 2032
Payment history guide
Collection as of Nov 2026 to Mar 2026
 Historical Info
Original Creditor ACME APARTMENTS
 Comment
Current:
Account information disputed by consumer (Meets requirement
of the Fair Credit Reporting Act).
Previous:
Account information disputed by consumer.
Public Records
Hard Inquiries
Hard inquiries are requests for your consumer information
at least two years.
JPMCB CARD
Inquired on
03/28/2026
PO BOX 1
WILMINGTON
DE, 19850
Auto loan. This
inquiry is
scheduled to
continue on record
until Apr 2028.
M1F/MAZDAFI
NSV/DEFI/TMC
C
Inquired on
07/24/2025
TX, 75024
Unspecified. This
inquiry is
scheduled to
continue on record
until Aug 2027.
700
CREDIT/OCEAN
Inquired on
01/31/2026
Soft Inquiries
SOFT LENDER
Inquired on
02/01/2026`;

const EQUIFAX = `Credit Report
Date: November 23, 2026
Confirmation # 5555555555
Prepared for:
JORDAN A RIVERA
equifax.com/personal/disputes
000000001-DISC Page 1 of 9 5555555555-EFX-ACR-abc-11232026
Prepared for:
JORDAN A RIVERA
Date: November 23, 2026
Confirmation # 5555555555
Summary
Report Date November 23, 2026
Personal Information
Creditors use your personal information to identify you. This information has no impact on your credit score.
JORDAN A RIVERA
100 MAIN ST, TAMPA, FL 33602
Social Security Number: XXX-XX-1234
Former Name(s): Employment Information: Consumer File Notices:
Former Address(es): Former Phone Number(s):
22 OLD RD, ORLANDO, FL
32801
None
Consumer Statement:
Credit Accounts
This includes all types of credit accounts.
FIRST BANK CARD
PO BOX 1, CITY, ST 00000 | (800) 555-0100 Date Reported: 10/30/2026 | Balance: $1,050
Account Number: *4821 | Owner: Individual Account Credit Limit: $1,500 | High Credit: $1,200
Loan/Account Type: Credit Card | Status: 30 - 59 Days Past Due
Date Opened: 01/15/2024 Date of 1st Delinquency: 09/30/2026 Terms Frequency: Monthly
Date of Last Activity: 10/01/2026 Date Major Delinquency 1st Reported: Months Reviewed: 30
Scheduled Payment Amount: $35 Amount Past Due: $120 Deferred Payment Start Date:
Actual Payment Amount: $40 Charge Off Amount: Balloon Payment Amount:
Date of Last Payment: 10/01/2026 Date Closed: Balloon Payment Date:
Term Duration: Activity Designator: Narrative Code(s): 002
Payment History
Year Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec
2026 30
Narrative Code Narrative Code Description
002 Credit Card
OLD LENDER LLC - Closed
1 ST, CITY, ST 00000 | (800) 555-0101 Date Reported: 12/31/2023 | Balance: $0
000000001-DISC Page 2 of 9 5555555555-EFX-ACR-abc-11232026
Prepared for:
JORDAN A RIVERA
Date: November 23, 2026
Confirmation # 5555555555
Account Number: *5VZS | Owner: Joint Account Credit Limit: | High Credit: $120
Loan/Account Type: Secured | Status: Pays As Agreed
Date Opened: 12/28/2022 Date of 1st Delinquency: Terms Frequency: Monthly
Date of Last Payment: 12/30/2023 Date Closed: 12/30/2023 Balloon Payment Date:
Collections
If you fall behind on payments, the lender may transfer your account.
COLLECTOR ONE
2 ST, CITY, ST 00000 | (866) 555-0102
Account Number: *9166 | Owner: Individual Account
Collection Reported: 11/11/2026 Amount: $850 Original Creditor: ACME APARTMENTS
Assigned: 09/09/2025 Balance as of 11/11/2026: $900 Creditor Classification: Rental/Leasing
Date of 1st Delinquency: 06/30/2025 Last Payment Date: None Status as of 11/11/2026: Unpaid
Additional Information: Consumer Disputes This Account Information
Inquiries
A request for your credit history is called an inquiry.
Company Information Inquiry Type Inquiry Date(s)
WELLS FARGO AUTO
PO BOX 1 IRVING TX 75016
Phone: (888) 555-0103
Hard 06/30/2025
PROMO BANK
PO BOX 2 CITY ST 00000
Phone: (888) 555-0104
Soft 05/01/2026
Inquiries
More intro text that is not a company.
Company Information Inquiry Type Inquiry Date(s)
NORTHWEST FCU
200 SPRING ST HERNDON VA 20170
Phone: (800) 555-0105
Hard 07/25/2025, 07/26/2025
A Summary of Your Rights Under the Fair Credit Reporting Act`;

describe('bureau layouts', () => {
  it('detects each layout and ignores other text', () => {
    expect(detectLayout(EXPERIAN)).toBe('experian_acr');
    expect(detectLayout(EQUIFAX)).toBe('equifax_acr');
    expect(detectLayout('Experian Credit Report\nCreditor: X')).toBeNull();
  });

  it('last4 ignores the bureau masking on either side', () => {
    expect(last4('4111XXXXXXXX')).toBe('4111');
    expect(last4('*4821')).toBe('4821');
    expect(last4('3499933128020733')).toBe('0733');
    expect(last4('XXXX')).toBeNull();
  });

  it('Experian: every value lands in its field', () => {
    const p = parseExperianAcr(EXPERIAN);
    expect(p.bureau).toBe('experian');
    expect(p.reportDate).toBe('2026-11-23');
    expect(p.tradelines).toHaveLength(2);
    const [card, coll] = p.tradelines;
    expect(card).toMatchObject({
      item_type: 'tradeline', creditor_name: 'FIRST BANK CARD', account_last4: '4111', account_type: 'Credit card',
      account_status: 'Open. $120 past due as of Oct 2026.', payment_status: '$120 past due as of Oct 2026.',
      balance_cents: 105000, credit_limit_cents: 150000, high_balance_cents: 120000,
      date_opened: '2024-01-15', date_reported: '2026-10-30', original_creditor: null,
    });
    expect(card!.remarks).toContain('30 days past due as of Oct 2026');
    expect(card!.confidence).toBeGreaterThanOrEqual(0.9);
    expect(coll).toMatchObject({
      item_type: 'collection', creditor_name: 'COLLECTOR ONE', account_last4: '9988', balance_cents: 90000,
      high_balance_cents: 85000, original_creditor: 'ACME APARTMENTS', date_reported: '2026-11-02',
    });
    expect(coll!.remarks).toContain('Joint with SAM RIVERA');
    expect(coll!.remarks).toContain('disputed by consumer');
    expect(p.inquiries.map((q) => [q.name, q.inquiry_date])).toEqual([
      ['JPMCB CARD', '2026-03-28'], ['M1F/MAZDAFI NSV/DEFI/TMC C', '2025-07-24'], ['700 CREDIT/OCEAN', '2026-01-31'],
    ]);
    expect(p.identity.filter((i) => i.kind === 'name').map((i) => i.value)).toEqual(['JORDAN RIVERA', 'JORDAN A RIVERA']);
    expect(p.identity.filter((i) => i.kind === 'address').map((i) => i.value)).toEqual(['100 MAIN ST TAMPA FL, 33602-1234']);
  });

  it('Equifax: accounts, closed accounts across a page break, collections, hard inquiries only', () => {
    const p = parseEquifaxAcr(EQUIFAX);
    expect(p.bureau).toBe('equifax');
    expect(p.reportDate).toBe('2026-11-23');
    expect(p.tradelines).toHaveLength(3);
    const [card, closed, coll] = p.tradelines;
    expect(card).toMatchObject({
      item_type: 'tradeline', creditor_name: 'FIRST BANK CARD', account_last4: '4821', account_type: 'Credit Card',
      account_status: 'Open', payment_status: '30 - 59 Days Past Due', balance_cents: 105000, credit_limit_cents: 150000,
      high_balance_cents: 120000, date_opened: '2024-01-15', date_reported: '2026-10-30', date_of_first_delinquency: '2026-09-30',
      payment_history: '2026 30',
    });
    expect(card!.remarks).toContain('Amount past due: $120');
    expect(closed).toMatchObject({ creditor_name: 'OLD LENDER LLC', account_last4: '5VZS', account_status: 'Closed 12/30/2023', balance_cents: 0, high_balance_cents: 12000 });
    expect(closed!.remarks).toContain('Owner: Joint Account');
    expect(coll).toMatchObject({
      item_type: 'collection', creditor_name: 'COLLECTOR ONE', account_last4: '9166', original_creditor: 'ACME APARTMENTS',
      balance_cents: 90000, high_balance_cents: 85000, date_reported: '2026-11-11', date_of_first_delinquency: '2025-06-30',
      account_status: 'Collection: Unpaid',
    });
    expect(p.inquiries.map((q) => [q.name, q.inquiry_date])).toEqual([
      ['WELLS FARGO AUTO', '2025-06-30'], ['NORTHWEST FCU', '2025-07-25'], ['NORTHWEST FCU', '2025-07-26'],
    ]);
    expect(p.identity).toEqual([
      { bureau: 'equifax', kind: 'name', value: 'JORDAN A RIVERA' },
      { bureau: 'equifax', kind: 'address', value: '100 MAIN ST, TAMPA, FL 33602' },
      { bureau: 'equifax', kind: 'address', value: '22 OLD RD, ORLANDO, FL 32801' },
    ]);
  });

  it('import uses the exact reader first: no AI, no credits', async () => {
    const credits = { spend: async () => { throw new Error('must not charge'); }, settle: async () => undefined, refund: async () => undefined };
    for (const text of [EXPERIAN, EQUIFAX]) {
      const r = await readReportFile({ bytes: Buffer.from(text), mime: 'text/plain', name: 'r.txt' }, { orgId: 'o', userId: 'u' }, { enabled: () => true, ocr: async () => { throw new Error('must not call AI'); }, credits: credits as never });
      expect(r.via).toBe('layout');
    }
  });
});
