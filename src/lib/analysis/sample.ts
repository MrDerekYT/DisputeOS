import { parseReportText } from "../reports/parser";

export const SAMPLE_REPORTS = [
  `Experian Credit Report
Accounts
Account: Capital One
Account Number: 5178 0012 3456 4421
Type: Credit Card
Status: Open
Date Opened: 01/15/2019
Balance: $1,234

Account: Midland Credit Management
Account Number: 998800009980
Type: Collection
Payment Status: Collection
Date of First Delinquency: 11/2018
Balance: $2,310
Original Creditor:

Account: Old Furniture Co
Account Number: 4000111122223333
Type: Collection
Payment Status: Collection
Date of First Delinquency: 02/2016
Balance: $480
Original Creditor: Old Furniture Co

Account: Synchrony
Account Number: 6035 0000 1177
Status: Closed
Balance: $300
`,
  `Equifax Credit Report
Accounts
Account: Capital One
Account Number: 5178 0012 3456 4421
Type: Credit Card
Status: Open
Date Opened: 01/15/2019
Balance: $900

Account: Midland Credit Management
Account Number: 998800009980
Type: Collection
Payment Status: Collection
Date of First Delinquency: 03/2019
Balance: $2,310
`,
].map(parseReportText);
