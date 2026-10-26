import { BUREAU_ADDRESSES, type Bureau } from './disputes';

export interface LetterData {
  clientName: string;
  clientAddress: string;
  bureau: Bureau;
  creditor: string;
  accountLast4?: string;
  reason: string;
  date: Date;
}

const FIELD = /\{\{\s*(\w+)\s*\}\}/g;

/** Replace {{field}} tokens; unknown fields are left intact so they are visible in review. */
export function mergeTemplate(body: string, values: Record<string, string>): string {
  return body.replace(FIELD, (m, k: string) => values[k] ?? m);
}

export const BUREAU_611_TEMPLATE = `{{date}}

{{clientName}}
{{clientAddress}}

{{bureauAddress}}

Re: Dispute of inaccurate information - {{creditor}} {{account}}

To Whom It May Concern:

Under Section 611 of the Fair Credit Reporting Act (15 U.S.C. § 1681i), I dispute the following item as inaccurate or unverifiable: {{creditor}} {{account}}.

Reason: {{reason}}

Please conduct a reasonable reinvestigation within 30 days, delete or correct the information, and send me written results and an updated copy of my report.

Sincerely,
{{clientName}}`;

export function generateBureauLetter(d: LetterData): string {
  return mergeTemplate(BUREAU_611_TEMPLATE, {
    date: d.date.toISOString().slice(0, 10),
    clientName: d.clientName,
    clientAddress: d.clientAddress,
    bureauAddress: BUREAU_ADDRESSES[d.bureau],
    creditor: d.creditor,
    account: d.accountLast4 ? `(account ending ${d.accountLast4})` : '',
    reason: d.reason,
  });
}
