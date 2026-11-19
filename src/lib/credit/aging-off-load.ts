import type { Db } from '../db';
import { BUREAU_LABEL, type Bureau } from '../util';
import { agingOffWithin, publicRecordFallOff, tradelineFallOff, type AgingOffItem, type AgingOffSource } from './reporting-period';

/**
 * Negative items on the newest approved report of each bureau whose reporting period generally ends within the next
 * `months` (15 U.S.C. § 1681c, see ./reporting-period.ts). Items with no reported date are left out, not estimated.
 * Run inside the caller's tenant transaction (row-level security applies).
 */
export async function loadAgingOff(db: Db, clientId: string, today: string, months = 12): Promise<AgingOffItem[]> {
  const latest = await db.rows<{ id: string }>(
    `select distinct on (bureau) id from public.credit_reports where client_id = $1 and status = 'approved' and bureau is not null
      order by bureau, coalesce(report_date, created_at::date) desc, created_at desc`, [clientId]);
  const ids = latest.map((r) => r.id);
  if (!ids.length) return [];
  const lines = await db.rows<{ bureau: Bureau; item_type: string; creditor_name: string; account_last4: string | null; account_status: string | null; payment_status: string | null; payment_history: string | null; date_of_first_delinquency: string | null }>(
    `select bureau, item_type, creditor_name, account_last4, account_status, payment_status, payment_history, date_of_first_delinquency
       from public.tradelines where report_id = any($1::uuid[]) and client_id = $2 and date_of_first_delinquency is not null`, [ids, clientId]);
  const records = await db.rows<{ bureau: Bureau; kind: string; filed_date: string | null }>(
    'select bureau, kind, filed_date from public.public_records where report_id = any($1::uuid[]) and client_id = $2 and filed_date is not null', [ids, clientId]);
  const sources: AgingOffSource[] = [
    ...lines.map((t) => ({ label: `${t.creditor_name}${t.account_last4 ? ` ••${t.account_last4}` : ''}`, bureau: BUREAU_LABEL[t.bureau], fallOff: tradelineFallOff(t) })),
    ...records.map((r) => ({ label: r.kind, bureau: BUREAU_LABEL[r.bureau], fallOff: publicRecordFallOff(r) })),
  ];
  return agingOffWithin(sources, today, months);
}
