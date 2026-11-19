import { z } from 'zod';
import { BUREAUS } from '../util';
import type { ParsedReport, ParsedTradeline } from '../reports/types';

/**
 * The normalized report format. Every automatic source — a provider adapter, the inbound REST API, Zapier — must produce
 * this shape; it is validated strictly and converted to the same ParsedReport the upload path produces, so automatic
 * imports go through exactly the same human review before anything is analysed or disputed.
 *
 * Privacy: full account numbers are accepted only to be reduced to their last four characters and are never stored.
 */
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'use YYYY-MM-DD').refine((s) => !Number.isNaN(Date.parse(s)), 'invalid date');
const cents = z.number().int().min(-1_000_000_000_00).max(1_000_000_000_00);
const str = (max: number) => z.string().trim().max(max);

export const tradelineInput = z.object({
  creditor_name: str(200).min(1),
  account_number: str(40).optional(),
  item_type: z.enum(['tradeline', 'collection']).default('tradeline'),
  original_creditor: str(200).optional(),
  account_type: str(100).optional(),
  account_status: str(100).optional(),
  payment_status: str(100).optional(),
  balance_cents: cents.optional(),
  credit_limit_cents: cents.optional(),
  high_balance_cents: cents.optional(),
  date_opened: date.optional(),
  date_reported: date.optional(),
  date_of_first_delinquency: date.optional(),
  payment_history: str(120).optional(),
  remarks: str(300).optional(),
});

export const reportInput = z.object({
  bureau: z.enum(BUREAUS),
  report_date: date.optional(),
  tradelines: z.array(tradelineInput).max(500).default([]),
  inquiries: z.array(z.object({ name: str(200).min(1), date: date.optional() })).max(200).default([]),
  public_records: z.array(z.object({ kind: str(80).min(1), court: str(200).optional(), amount_cents: cents.optional(), filed_date: date.optional(), status: str(100).optional() })).max(50).default([]),
  identity: z.array(z.object({ kind: z.enum(['name', 'address', 'employer']), value: str(300).min(1) })).max(100).default([]),
  scores: z.array(z.object({ model: str(60).min(1), score: z.number().int().min(250).max(900), date: date.optional() })).max(10).default([]),
});
export type ReportInput = z.infer<typeof reportInput>;

/** Body of POST /api/v1/clients/{id}/reports: one report or up to three (one per bureau). */
export const ingestBody = z.object({
  external_ref: str(120).optional(),
  reports: z.array(reportInput).min(1).max(3),
}).refine((b) => new Set(b.reports.map((r) => r.bureau)).size === b.reports.length, { message: 'Send at most one report per bureau' });
export type IngestBody = z.infer<typeof ingestBody>;

/** Convert a validated report into the parser's output shape (account numbers become last-4 only). */
export function toParsed(r: ReportInput): ParsedReport {
  const tradelines: ParsedTradeline[] = r.tradelines.map((t) => {
    const digits = (t.account_number ?? '').replace(/[^0-9A-Za-z]/g, '');
    return {
      bureau: r.bureau, item_type: t.item_type, creditor_name: t.creditor_name, original_creditor: t.original_creditor ?? null,
      account_last4: digits ? digits.slice(-4) : null, account_type: t.account_type ?? null, account_status: t.account_status ?? null,
      payment_status: t.payment_status ?? null, balance_cents: t.balance_cents ?? null, credit_limit_cents: t.credit_limit_cents ?? null,
      high_balance_cents: t.high_balance_cents ?? null, date_opened: t.date_opened ?? null, date_reported: t.date_reported ?? null,
      date_of_first_delinquency: t.date_of_first_delinquency ?? null, payment_history: t.payment_history ?? null, remarks: t.remarks ?? null,
      confidence: 1, field_meta: {},
    };
  });
  return {
    bureau: r.bureau, reportDate: r.report_date ?? null, tradelines,
    inquiries: r.inquiries.map((i) => ({ bureau: r.bureau, name: i.name, inquiry_date: i.date ?? null })),
    publicRecords: r.public_records.map((p) => ({ bureau: r.bureau, kind: p.kind, court: p.court ?? null, amount_cents: p.amount_cents ?? null, filed_date: p.filed_date ?? null, status: p.status ?? null })),
    identity: r.identity.map((i) => ({ bureau: r.bureau, kind: i.kind, value: i.value })),
    scores: r.scores.map((s) => ({ bureau: r.bureau, model: s.model, score: s.score, scored_on: s.date ?? r.report_date ?? null })),
    warnings: [],
  };
}
