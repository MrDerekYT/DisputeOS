import type { Db } from '../db';
import { recheck, type Recheck, type ReportedAccount } from './recheck';

type Row = { match_key: string; balance_cents: string | null; account_status: string | null; payment_status: string | null; date_of_first_delinquency: string | null };
const toAccount = (r: Row): ReportedAccount => ({
  matchKey: r.match_key, balanceCents: r.balance_cents == null ? null : Number(r.balance_cents), accountStatus: r.account_status,
  paymentStatus: r.payment_status, dateOfFirstDelinquency: r.date_of_first_delinquency,
});

/**
 * Loads the disputed account and the newest APPROVED report from the same bureau that was imported after the
 * disputed one, then compares them. Returns null when the dispute is not tied to a reported account.
 */
export async function loadRecheck(db: Db, disputeId: string): Promise<Recheck | null> {
  const t = await db.row<Row & { client_id: string; bureau: string; report_created: string }>(
    `select t.match_key, t.balance_cents, t.account_status, t.payment_status, t.date_of_first_delinquency, t.client_id, t.bureau, r.created_at as report_created
       from public.disputes d join public.tradelines t on t.id = d.tradeline_id join public.credit_reports r on r.id = t.report_id
      where d.id = $1`, [disputeId]);
  if (!t) return null;
  const newer = await db.row<{ id: string; report_date: string | null }>(
    `select id, report_date from public.credit_reports
      where client_id = $1 and bureau = $2 and status = 'approved' and created_at > $3
      order by coalesce(report_date, created_at::date) desc, created_at desc limit 1`, [t.client_id, t.bureau, t.report_created]);
  if (!newer) return recheck(toAccount(t), null);
  const rows = await db.rows<Row>('select match_key, balance_cents, account_status, payment_status, date_of_first_delinquency from public.tradelines where report_id = $1', [newer.id]);
  return recheck(toAccount(t), { reportDate: newer.report_date, accounts: rows.map(toAccount) });
}
