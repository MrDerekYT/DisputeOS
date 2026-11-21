/**
 * Reads the rows a letter brief is built from (./brief.ts). Run inside the caller's tenant transaction: row-level
 * security limits every read to the caller's organization, and each query also filters by the client or the dispute.
 * Nothing is written here.
 */
import { decryptPII } from '../crypto';
import type { Db } from '../db';
import { getEnv } from '../env';
import { INTAKE_REQUIRED, intakeStatus } from '../intake';
import { isRealDay } from '../real-day';
import { loadIntakeDocs } from '../intake-load';
import type { Evidence } from '../reports/analysis';
import { dayInZone } from '../util';
import { buildBrief, sameName, type BriefDisputeRow, type BriefOptions, type BriefRecord, type BriefTradelineRow, type LetterBrief } from './brief';

/**
 * The date of birth on the client's record as a day, or null. It is kept encrypted and is read here only to be stated
 * in a letter to a reporting agency, which asks for it to find the file. A value that cannot be read (a key that is no
 * longer configured, or something that is not a real date, such as 2000-02-31) is treated as not on file: the letter
 * then carries the marked "[DATE OF BIRTH NEEDED]" line instead of a rolled-over date nobody gave.
 */
export function storedDob(encrypted: string | null): string | null {
  if (!encrypted) return null;
  try {
    const day = decryptPII(encrypted).trim();
    return isRealDay(day) ? day : null;
  } catch {
    return null;
  }
}

/**
 * Everything on file for one letter. Null when the client does not exist (or is not the caller's to see). When a
 * dispute is named but is not this client's, `dispute` stays null: the caller decides what that means.
 */
export async function loadBriefRecord(db: Db, clientId: string, disputeId: string | null): Promise<BriefRecord | null> {
  const tz = getEnv().APP_TIMEZONE;
  const today = dayInZone(tz);
  const row = await db.row<Omit<BriefRecord['client'], 'dob'> & { dob_encrypted: string | null }>(
    'select id, full_name, address, ssn_last4, dob_encrypted, bankruptcy_chapter, bankruptcy_filed_on::text, bankruptcy_discharged_on::text from public.clients where id = $1', [clientId]);
  if (!row) return null;
  const { dob_encrypted, ...rest } = row;
  const client: BriefRecord['client'] = { ...rest, dob: storedDob(dob_encrypted) };
  const record: BriefRecord = { today, tz, client, dispute: null, tradeline: null, prior: null, finding: null, evidence: [], identityDocs: [], identityTheftReports: [], notices: [], letters: [] };
  // Identity theft reports on file, by what they are. Only one a person has accepted counts: a client's own upload that
  // nobody has looked at yet is not a report on file, and a rejected one never is.
  record.identityTheftReports = (await db.rows<{ kind: string }>("select distinct kind from public.documents where client_id = $1 and kind in ('ftc_report', 'police_report') and review_status = 'accepted' order by kind", [clientId]))
    .map((x) => (x.kind === 'ftc_report' ? 'FTC identity theft report' : 'Police report'));
  if (!disputeId) return record;

  const d = await db.row<Omit<BriefDisputeRow, 'sent_on'> & { client_id: string; parent_dispute_id: string | null; finding_id: string | null }>(
    `select id, client_id, item_label, target_type, bureau, recipient_name, recipient_address, category, workflow, reason, fields, round, status, submitted_at, response_at, due_at, outcome,
            client_confirmed_accurate, agency, agency_item, tradeline_id, parent_dispute_id, finding_id
       from public.disputes where id = $1`, [disputeId]);
  if (!d || d.client_id !== clientId) return record;
  // The day a dispute was sent is the sent date staff recorded on its letter; the stored instant is only a fallback.
  const sentOn = async (id: string) =>
    (await db.row<{ sent_on: string | null }>("select sent_on::text from public.letters where dispute_id = $1 and status = 'sent' and kind <> 'method_of_verification' and sent_on is not null order by created_at desc limit 1", [id]))?.sent_on ?? null;
  record.dispute = { ...d, sent_on: await sentOn(d.id) };
  record.tradeline = d.tradeline_id ? await db.row<BriefTradelineRow>(
    `select t.creditor_name, t.original_creditor, t.account_last4, t.bureau, t.item_type, t.account_status, t.payment_status, t.payment_history, t.balance_cents,
            t.date_opened::text, t.date_of_first_delinquency::text, r.report_date::text, r.status as report_status
       from public.tradelines t left join public.credit_reports r on r.id = t.report_id where t.id = $1`, [d.tradeline_id]) : null;
  if (d.parent_dispute_id) {
    const p = await db.row<{ round: number; submitted_at: string | null; response_at: string | null; outcome: string | null }>('select round, submitted_at, response_at, outcome from public.disputes where id = $1', [d.parent_dispute_id]);
    record.prior = p ? { ...p, sent_on: await sentOn(d.parent_dispute_id) } : null;
  }
  record.finding = d.finding_id ? await db.row<{ title: string; basis: string; evidence: Evidence[] }>('select title, basis, evidence from public.findings where id = $1', [d.finding_id]) : null;
  record.evidence = (await db.rows<{ label: string }>('select label from public.dispute_evidence where dispute_id = $1 order by created_at', [d.id])).map((e) => e.label);
  // Identity documents go with a letter to a bureau or a specialty agency: the ones accepted and still good today.
  if (d.target_type === 'bureau' || d.target_type === 'agency') {
    record.identityDocs = intakeStatus(await loadIntakeDocs(db, clientId), today, INTAKE_REQUIRED).filter((x) => x.state === 'accepted').map((x) => ({ key: x.item.key, label: x.item.label.en }));
  }
  if (d.target_type === 'collector') {
    // A notice is this account's when it is linked to the same report row, or to a row with the same creditor and
    // account digits (another bureau's report of the debt, or a later import). A key without digits says too little.
    const notices = await db.rows<BriefRecord['notices'][number]>(
      `select n.collector_name, n.date_kind, n.notice_date::text, n.tradeline_id,
              coalesce(n.tradeline_id is not null and t.match_key ~ '^[^|]+[|][^|]+$'
                and t.match_key = (select x.match_key from public.tradelines x where x.id = $2 and x.client_id = $1), false) as same_account
         from public.collector_notices n left join public.tradelines t on t.id = n.tradeline_id
        where n.client_id = $1 order by n.notice_date desc, n.created_at desc`, [clientId, d.tradeline_id]);
    // A notice recorded by the collector's name alone can be about any of the client's debts with that collector, so
    // the brief uses it only when there is no other one: the client's other collection accounts on an approved report
    // under that name (or the name this debt's own account is reported under) are counted, this dispute's own account
    // left out and one account several bureaus report (the same creditor and account digits) counted once.
    if (notices.some((n) => !n.tradeline_id)) {
      const accounts = await db.rows<{ id: string; creditor_name: string; match_key: string }>(
        `select t.id, t.creditor_name, t.match_key from public.tradelines t join public.credit_reports r on r.id = t.report_id
          where t.client_id = $1 and t.item_type = 'collection' and r.status = 'approved'`, [clientId]);
      const keyed = (k: string | null | undefined): k is string => !!k && /^[^|]+\|[^|]+$/.test(k);
      const own = d.tradeline_id ? await db.row<{ creditor_name: string; match_key: string }>('select creditor_name, match_key from public.tradelines where id = $1 and client_id = $2', [d.tradeline_id, clientId]) : null;
      for (const n of notices.filter((x) => !x.tradeline_id)) {
        const names = [n.collector_name, ...(own ? [own.creditor_name] : [])];
        const others = accounts.filter((t) => names.some((x) => sameName(t.creditor_name, x)) && t.id !== d.tradeline_id && !(keyed(own?.match_key) && t.match_key === own?.match_key));
        n.other_debts = new Set(others.map((t) => (keyed(t.match_key) ? t.match_key : t.id))).size;
      }
    }
    record.notices = notices;
  }
  record.letters = await db.rows<BriefRecord['letters'][number]>("select template_key, kind, status from public.letters where dispute_id = $1 and status <> 'void' order by created_at", [d.id]);
  return record;
}

/** The brief for one client's dispute (or for a standalone letter when no dispute is given). Null when the client or the dispute is not found. */
export async function loadBrief(db: Db, clientId: string, disputeId: string | null, o: BriefOptions = {}): Promise<LetterBrief | null> {
  const r = await loadBriefRecord(db, clientId, disputeId);
  return r && (!disputeId || r.dispute) ? buildBrief(r, o) : null;
}
