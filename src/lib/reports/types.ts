import type { Bureau } from '../util';

export interface FieldMeta {
  confidence: number; // 0..1
  snippet: string; // masked source line
}

export interface ParsedTradeline {
  bureau: Bureau | null;
  item_type: 'tradeline' | 'collection';
  creditor_name: string;
  original_creditor: string | null;
  account_last4: string | null;
  account_type: string | null;
  account_status: string | null;
  payment_status: string | null;
  balance_cents: number | null;
  credit_limit_cents: number | null;
  high_balance_cents: number | null;
  date_opened: string | null;
  date_reported: string | null;
  date_of_first_delinquency: string | null;
  payment_history: string | null;
  remarks: string | null;
  confidence: number; // overall: weakest required field
  field_meta: Record<string, FieldMeta>;
}

export interface ParsedInquiry { bureau: Bureau | null; name: string; inquiry_date: string | null }
export interface ParsedPublicRecord { bureau: Bureau | null; kind: string; court: string | null; amount_cents: number | null; filed_date: string | null; status: string | null }
export interface ParsedIdentity { bureau: Bureau | null; kind: 'name' | 'address' | 'employer'; value: string }

export interface ParsedScore { bureau: Bureau | null; model: string; score: number; scored_on: string | null }

export interface ParsedReport {
  bureau: Bureau | null;
  reportDate: string | null;
  tradelines: ParsedTradeline[];
  inquiries: ParsedInquiry[];
  publicRecords: ParsedPublicRecord[];
  identity: ParsedIdentity[];
  /** Scores exactly as the report states them (never computed). */
  scores?: ParsedScore[];
  warnings: string[];
}

export const REVIEW_THRESHOLD = 0.8;
