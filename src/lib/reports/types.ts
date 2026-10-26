export type Bureau = "equifax" | "experian" | "transunion";

/** An extracted value with the evidence it came from, for side-by-side human review. */
export interface Field<T = string> {
  value: T | null;
  confidence: number; // 0..1
  source: string | null; // the exact source line
}

export interface ParsedTradeline {
  creditor: Field;
  accountNumber: Field; // only last 4 should ever be persisted in the clear
  accountType: Field;
  accountStatus: Field;
  paymentStatus: Field;
  dateOpened: Field; // ISO yyyy-mm-dd
  dofd: Field; // date of first delinquency, ISO
  balance: Field<number>;
  highCredit: Field<number>;
  creditLimit: Field<number>;
  originalCreditor: Field;
  paymentHistory: Field; // e.g. "OK OK 30 60"
}

export interface ParsedInquiry {
  name: string;
  date: string | null;
  source: string;
}

export interface ParsedReport {
  bureau: Bureau | null;
  tradelines: ParsedTradeline[];
  inquiries: ParsedInquiry[];
  warnings: string[];
}
