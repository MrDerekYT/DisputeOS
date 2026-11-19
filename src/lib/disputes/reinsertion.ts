/**
 * Reinsertion watch.
 *
 * When a dispute with a bureau was recorded as "deleted" and a LATER approved report from the same bureau shows the
 * same account again, staff get one finding that states those two facts and asks a question: did the client receive
 * the written notice? Under 15 U.S.C. § 1681i(a)(5)(B), information deleted after a reinvestigation may generally be
 * reinserted only if the furnisher certifies it is complete and accurate, and the agency must generally notify the
 * consumer in writing within 5 business days of reinserting it.
 *
 * The finding never says a violation occurred. The software cannot know whether a notice was sent, whether the
 * recorded outcome was right, or whether two report lines are truly the same account, so matching is deliberately
 * narrow: same client, same bureau, the exact match key (creditor + account last 4, and only when the last 4 is
 * present), and a report dated after the day the response was recorded.
 */
import type { Db } from '../db';
import type { Evidence } from '../reports/analysis';
import { BUREAU_LABEL, type Bureau } from '../util';

export const REINSERTION_CATEGORY = 'possible_reinsertion';
/** Not 'rules': the rules pass retires its own stale suggestions on every run, and these must survive it. */
export const REINSERTION_GENERATED_BY = 'reinsertion_watch';

export interface DeletedDispute { disputeId: string; bureau: Bureau; matchKey: string; deletedOn: string }
export interface ReportedLine { tradelineId: string; matchKey: string; creditorName: string; accountLast4: string | null }
export interface ReportInfo { id: string; bureau: Bureau; date: string }
export interface ReinsertionFinding {
  dedupe_key: string; category: typeof REINSERTION_CATEGORY; severity: 'review'; basis: 'potential_discrepancy';
  title: string; explanation: string; evidence: Evidence[]; tradeline_ids: string[];
}

/** A match key is usable only when it carries both a creditor and the account's last 4. "acme|" could be any Acme account. */
export const isExactKey = (key: string): boolean => /^[^|]+\|[^|]+$/.test(key);

/**
 * Pure matching: which recorded deletions reappear on this report. One finding per deleted dispute (the latest
 * deletion per account), so running it again, or approving yet another report that still shows the account, adds nothing.
 */
export function findReinsertions(report: ReportInfo, lines: ReportedLine[], deleted: DeletedDispute[]): ReinsertionFinding[] {
  const latest = new Map<string, DeletedDispute>();
  for (const d of deleted) {
    if (d.bureau !== report.bureau || !isExactKey(d.matchKey) || !(d.deletedOn < report.date)) continue;
    const prev = latest.get(d.matchKey);
    if (!prev || prev.deletedOn < d.deletedOn) latest.set(d.matchKey, d);
  }
  const out: ReinsertionFinding[] = [];
  for (const d of latest.values()) {
    const line = lines.find((l) => l.matchKey === d.matchKey);
    if (!line) continue;
    const name = `${line.creditorName}${line.accountLast4 ? ` (ending ${line.accountLast4})` : ''}`;
    const bureau = BUREAU_LABEL[report.bureau];
    out.push({
      dedupe_key: `reinsertion:${d.disputeId}`, category: REINSERTION_CATEGORY, severity: 'review', basis: 'potential_discrepancy',
      title: `${name} appears on ${bureau} again after a recorded deletion`,
      explanation: `A dispute with ${bureau} about this account was recorded as deleted (response recorded on ${d.deletedOn}). The account appears again in the ${bureau} report dated ${report.date}. `
        + 'Ask the client whether they received a written notice from the agency about it: when deleted information is put back, the agency must generally notify the consumer in writing within 5 business days (15 U.S.C. § 1681i(a)(5)(B)). '
        + 'Also check that the recorded outcome and both report entries refer to the same account. This states what the records show; it is not a conclusion that anything was done wrong.',
      evidence: [
        { bureau: report.bureau, field: 'Dispute outcome recorded', value: `Deleted, response recorded on ${d.deletedOn}`, source: 'record' },
        { bureau: report.bureau, field: 'Appears in report dated', value: report.date, source: 'reported', tradeline_id: line.tradelineId },
        { field: 'Written notice of reinsertion', value: 'Not known. Ask the client.', source: 'record' },
      ],
      tradeline_ids: [line.tradelineId],
    });
  }
  return out;
}

/**
 * Checks one approved report against the client's recorded deletions and stores any findings. Idempotent: the unique
 * (client_id, dedupe_key) index keeps one finding per deleted dispute. Run inside the caller's tenant transaction, so
 * row-level security limits every read and write to the caller's organisation; the queries also filter by client.
 */
export async function watchReinsertions(db: Db, actor: { orgId: string }, reportId: string): Promise<number> {
  const rep = await db.row<{ id: string; client_id: string; bureau: Bureau | null; date: string }>(
    `select id, client_id, bureau, to_char(coalesce(report_date, created_at::date), 'YYYY-MM-DD') as date from public.credit_reports where id = $1 and status = 'approved'`, [reportId]);
  if (!rep?.bureau) return 0;
  // Only disputes sent to the bureau itself: § 1681i(a)(5) is about information an agency deleted after its own reinvestigation.
  const deleted = await db.rows<{ dispute_id: string; match_key: string; deleted_on: string }>(
    `select d.id as dispute_id, t.match_key, to_char(d.response_at at time zone 'UTC', 'YYYY-MM-DD') as deleted_on
       from public.disputes d join public.tradelines t on t.id = d.tradeline_id
      where d.client_id = $1 and t.client_id = $1 and d.outcome = 'deleted' and d.response_at is not null and d.target_type = 'bureau' and d.bureau = $2
        and t.bureau = $2 and t.report_id <> $3`, [rep.client_id, rep.bureau, rep.id]);
  if (!deleted.length) return 0;
  const lines = await db.rows<{ id: string; match_key: string; creditor_name: string; account_last4: string | null }>(
    'select id, match_key, creditor_name, account_last4 from public.tradelines where report_id = $1 and client_id = $2', [rep.id, rep.client_id]);
  const findings = findReinsertions(
    { id: rep.id, bureau: rep.bureau, date: rep.date },
    lines.map((l) => ({ tradelineId: l.id, matchKey: l.match_key, creditorName: l.creditor_name, accountLast4: l.account_last4 })),
    deleted.map((d) => ({ disputeId: d.dispute_id, bureau: rep.bureau!, matchKey: d.match_key, deletedOn: d.deleted_on })));
  let created = 0;
  for (const f of findings) {
    created += await db.run(
      `insert into public.findings (org_id, client_id, category, severity, title, explanation, evidence, basis, tradeline_ids, generated_by, dedupe_key)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) on conflict (client_id, dedupe_key) do nothing`,
      [actor.orgId, rep.client_id, f.category, f.severity, f.title, f.explanation, JSON.stringify(f.evidence), f.basis, f.tradeline_ids, REINSERTION_GENERATED_BY, f.dedupe_key]);
  }
  return created;
}
