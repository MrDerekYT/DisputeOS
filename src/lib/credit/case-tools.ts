/**
 * Storage for the three case tools (collector validation clock, medical collection screen, bankruptcy discharge
 * audit) and the one function that turns their results into ordinary findings. Every function runs inside the
 * caller's tenant transaction, so row-level security limits each read and write to the caller's organisation; the
 * queries also filter by client. Nothing here drafts, approves or sends anything: a finding is a suggestion a person
 * reviews, and a letter only ever comes from the existing dispute and letter screens.
 */
import { audit } from '../audit';
import { logEvent } from '../crm';
import type { Db } from '../db';
import { UserError } from '../errors';
import { businessToday } from '../letters/service';
import { can, PermissionError, type Role } from '../rbac';
import type { Evidence } from '../reports/analysis';
import { BANKRUPTCY_CHAPTERS, bankruptcyFindings, type Bankruptcy, type BankruptcyChapter, type BankruptcyLine } from './bankruptcy-audit';
import { medicalScreen, type MedicalLine } from './medical-screen';
import { validationPeriod, VALIDATION_PERIOD_DAYS, type NoticeDateKind, type ValidationPeriod } from './validation-clock';

export interface CActor { orgId: string; userId: string; role: Role; meta?: { ip?: string | null } }

/** Not 'rules': the rules pass retires its own stale suggestions on every run, and these are retired here instead. */
export const CASE_TOOLS_GENERATED_BY = 'case_tools';
export const COLLECTOR_NOTICE_CATEGORY = 'collector_notice';

const isDay = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(new Date(`${v}T00:00:00Z`).getTime());
const notFuture = (day: string) => day <= businessToday() || day <= new Date().toISOString().slice(0, 10);

export type CaseLine = MedicalLine & BankruptcyLine;

/** Every account on the newest approved report of each bureau, with staff's "medical debt" answer (carried over from an earlier report of the same account). */
export async function loadCaseLines(db: Db, clientId: string): Promise<CaseLine[]> {
  const rows = await db.rows<Omit<CaseLine, 'balance_cents'> & { balance_cents: string | number | null }>(
    `select t.id, t.bureau, t.item_type, t.creditor_name, t.original_creditor, t.account_last4, t.account_type, t.account_status, t.payment_status, t.payment_history, t.remarks,
            t.balance_cents, t.date_opened::text, t.date_of_first_delinquency::text, t.match_key,
            coalesce((t.user_provided ->> 'medical')::boolean,
              (select (p.user_provided ->> 'medical')::boolean from public.tradelines p
                where p.client_id = t.client_id and p.match_key = t.match_key and t.match_key ~ '^[^|]+\\|[^|]+$' and p.user_provided ? 'medical'
                order by p.created_at desc limit 1)) as medical_flag
       from public.tradelines t
      where t.client_id = $1 and t.report_id in (
        select distinct on (bureau) id from public.credit_reports where client_id = $1 and status = 'approved' and bureau is not null
         order by bureau, coalesce(report_date, created_at::date) desc, created_at desc)
      order by t.creditor_name, t.bureau`, [clientId]);
  return rows.map((r) => ({ ...r, balance_cents: r.balance_cents == null ? null : Number(r.balance_cents) }));
}

export async function loadBankruptcy(db: Db, clientId: string): Promise<Bankruptcy | null> {
  const c = await db.row<{ chapter: string | null; filed_on: string | null; discharged_on: string | null }>(
    'select bankruptcy_chapter as chapter, bankruptcy_filed_on::text as filed_on, bankruptcy_discharged_on::text as discharged_on from public.clients where id = $1', [clientId]);
  if (!c?.chapter || !c.filed_on || !(BANKRUPTCY_CHAPTERS as readonly string[]).includes(c.chapter)) return null;
  return { chapter: c.chapter as BankruptcyChapter, filedOn: c.filed_on, dischargedOn: c.discharged_on };
}

/**
 * Recomputes the medical and bankruptcy findings for one client. Idempotent: the unique (client_id, dedupe_key) index
 * keeps one finding per account and bureau, suggestions that no longer apply are retired, and anything a person has
 * already accepted, dismissed or disputed is left alone.
 */
export async function syncCaseFindings(db: Db, actor: { orgId: string }, clientId: string, today = businessToday()): Promise<number> {
  const lines = await loadCaseLines(db, clientId);
  const bankruptcy = await loadBankruptcy(db, clientId);
  const findings = [...medicalScreen(lines, today), ...(bankruptcy ? bankruptcyFindings(bankruptcy, lines) : [])];
  await db.run(
    `delete from public.findings where client_id = $1 and status = 'suggested' and generated_by = $2
        and (dedupe_key like 'medical:%' or dedupe_key like 'bankruptcy:%') and not (dedupe_key = any($3::text[]))`,
    [clientId, CASE_TOOLS_GENERATED_BY, findings.map((f) => f.dedupe_key)]);
  let created = 0;
  for (const f of findings) created += await insertFinding(db, actor.orgId, clientId, f);
  return created;
}

function insertFinding(db: Db, orgId: string, clientId: string, f: { category: string; severity: string; title: string; explanation: string; evidence: Evidence[]; basis: string; tradeline_ids: string[]; dedupe_key: string }) {
  return db.run(
    `insert into public.findings (org_id, client_id, category, severity, title, explanation, evidence, basis, tradeline_ids, generated_by, dedupe_key)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) on conflict (client_id, dedupe_key) do nothing`,
    [orgId, clientId, f.category, f.severity, f.title, f.explanation, JSON.stringify(f.evidence), f.basis, f.tradeline_ids, CASE_TOOLS_GENERATED_BY, f.dedupe_key]);
}

// ---------------------------------------------------------------- bankruptcy (entered by staff)

export async function setBankruptcy(db: Db, actor: CActor, clientId: string, input: { chapter: string | null; filedOn?: string | null; dischargedOn?: string | null }): Promise<void> {
  if (!can(actor.role, 'clients:write')) throw new PermissionError('clients:write');
  const client = await db.row<{ id: string }>('select id from public.clients where id = $1 for update', [clientId]);
  if (!client) throw new UserError('Client not found.');
  if (!input.chapter) {
    await db.run('update public.clients set bankruptcy_chapter = null, bankruptcy_filed_on = null, bankruptcy_discharged_on = null where id = $1', [clientId]);
    await logEvent(db, actor, clientId, 'case_tools', 'Bankruptcy record cleared');
  } else {
    if (!(BANKRUPTCY_CHAPTERS as readonly string[]).includes(input.chapter)) throw new UserError('Choose Chapter 7 or Chapter 13.');
    const filed = input.filedOn ?? '';
    const discharged = input.dischargedOn || null;
    if (!isDay(filed) || !notFuture(filed)) throw new UserError('Enter the filing date. It cannot be in the future.');
    if (discharged && (!isDay(discharged) || !notFuture(discharged) || discharged < filed)) throw new UserError('The discharge date must be on or after the filing date and not in the future.');
    await db.run('update public.clients set bankruptcy_chapter = $2, bankruptcy_filed_on = $3, bankruptcy_discharged_on = $4 where id = $1', [clientId, input.chapter, filed, discharged]);
    await logEvent(db, actor, clientId, 'case_tools', `Bankruptcy recorded: Chapter ${input.chapter}, filed ${filed}${discharged ? `, discharged ${discharged}` : ''}`);
  }
  await audit(db, { orgId: actor.orgId, actorId: actor.userId, action: 'client.bankruptcy', entityType: 'client', entityId: clientId, ip: actor.meta?.ip, meta: { chapter: input.chapter } });
  await syncCaseFindings(db, actor, clientId);
}

// ---------------------------------------------------------------- medical debt (marked by staff)

/** Saves staff's answer for every collection account listed on the form: ticked = medical, not ticked = not medical. */
export async function setMedicalFlags(db: Db, actor: CActor, clientId: string, listed: string[], medical: string[]): Promise<void> {
  if (!can(actor.role, 'clients:write')) throw new PermissionError('clients:write');
  const yes = new Set(medical);
  for (const id of listed) {
    const n = await db.run(
      `update public.tradelines set user_provided = user_provided || jsonb_build_object('medical', $3::boolean) where id = $1 and client_id = $2 and item_type = 'collection'`,
      [id, clientId, yes.has(id)]);
    if (!n) throw new UserError('That account does not belong to this client.');
  }
  await logEvent(db, actor, clientId, 'case_tools', `Medical debt marked on ${yes.size} of ${listed.length} collection account${listed.length === 1 ? '' : 's'}`);
  await syncCaseFindings(db, actor, clientId);
}

// ---------------------------------------------------------------- collector notices (validation period)

export interface CollectorNotice { id: string; tradelineId: string | null; collectorName: string; kind: NoticeDateKind; date: string; period: ValidationPeriod; isCollection: boolean }

export async function loadCollectorNotices(db: Db, clientId: string, today = businessToday()): Promise<CollectorNotice[]> {
  const rows = await db.rows<{ id: string; tradeline_id: string | null; collector_name: string; date_kind: NoticeDateKind; notice_date: string; is_collection: boolean }>(
    `select n.id, n.tradeline_id, n.collector_name, n.date_kind, n.notice_date::text,
            exists (select 1 from public.tradelines t where t.id = n.tradeline_id and t.item_type = 'collection') as is_collection
       from public.collector_notices n where n.client_id = $1 order by n.notice_date desc, n.created_at desc`, [clientId]);
  return rows.map((r) => ({ id: r.id, tradelineId: r.tradeline_id, collectorName: r.collector_name, kind: r.date_kind, date: r.notice_date, isCollection: r.is_collection, period: validationPeriod({ kind: r.date_kind, date: r.notice_date }, today) }));
}

export async function recordCollectorNotice(db: Db, actor: CActor, input: { clientId: string; tradelineId?: string | null; collectorName?: string | null; kind: NoticeDateKind; date: string }): Promise<string> {
  if (!can(actor.role, 'clients:write')) throw new PermissionError('clients:write');
  const client = await db.row<{ id: string }>('select id from public.clients where id = $1', [input.clientId]);
  if (!client) throw new UserError('Client not found.');
  if (!isDay(input.date) || !notFuture(input.date)) throw new UserError('Enter the date on or before today.');
  let name = input.collectorName?.trim() ?? '';
  if (input.tradelineId) {
    const t = await db.row<{ creditor_name: string; client_id: string; item_type: string }>('select creditor_name, client_id, item_type from public.tradelines where id = $1', [input.tradelineId]);
    if (!t || t.client_id !== input.clientId) throw new UserError('That account does not belong to this client.');
    if (t.item_type !== 'collection') throw new UserError('Choose a collection account.');
    name = name || t.creditor_name;
  }
  if (!name) throw new UserError('Choose the collection account or enter the collector’s name.');
  const row = await db.row<{ id: string }>(
    'insert into public.collector_notices (org_id, client_id, tradeline_id, collector_name, date_kind, notice_date, created_by) values ($1,$2,$3,$4,$5,$6,$7) returning id',
    [actor.orgId, input.clientId, input.tradelineId || null, name.slice(0, 200), input.kind, input.date, actor.userId]);
  const p = validationPeriod({ kind: input.kind, date: input.date }, businessToday());
  // The finding states the recorded dates only, so it stays true whenever it is read.
  await insertFinding(db, actor.orgId, input.clientId, {
    dedupe_key: `collector-notice:${row!.id}`, category: COLLECTOR_NOTICE_CATEGORY, severity: 'review', basis: 'user_provided',
    title: `Collector notice from ${name}: validation period generally ends ${p.endsOn}`.slice(0, 200),
    explanation: `A notice from ${name} was recorded as ${input.kind === 'sent' ? `sent on ${input.date}, so receipt is presumed on ${p.receivedOn} (5 days after sending, not counting Saturdays, Sundays and legal public holidays)` : `received on ${input.date}`}. `
      + `The ${VALIDATION_PERIOD_DAYS}-day validation period under the Fair Debt Collection Practices Act generally ends on ${p.endsOn} (12 CFR 1006.34(b)(5)). `
      + 'A written dispute, or a written request for the original creditor’s name and address, that the client sends within that period generally requires it to pause collection until it responds (12 CFR 1006.38). '
      + 'The notice itself states the end date the collector uses: go by the notice if it differs. This is a separate deadline, under a different law, from any credit-report dispute with a bureau. It applies only if the client questions the debt; nothing needs to be sent about a debt the client agrees is theirs and correct.',
    evidence: [
      { field: input.kind === 'sent' ? 'Notice sent' : 'Notice received', value: input.date, source: 'client', ...(input.tradelineId ? { tradeline_id: input.tradelineId } : {}) },
      ...(p.presumed ? [{ field: 'Receipt presumed', value: p.receivedOn, source: 'derived' as const }] : []),
      { field: 'Validation period generally ends', value: p.endsOn, source: 'derived' },
    ],
    tradeline_ids: input.tradelineId ? [input.tradelineId] : [],
  });
  await logEvent(db, actor, input.clientId, 'case_tools', `Collector notice recorded: ${name}, validation period generally ends ${p.endsOn}`);
  await audit(db, { orgId: actor.orgId, actorId: actor.userId, action: 'client.collector_notice', entityType: 'client', entityId: input.clientId, ip: actor.meta?.ip, meta: { notice_id: row!.id } });
  return row!.id;
}

export async function removeCollectorNotice(db: Db, actor: CActor, clientId: string, noticeId: string): Promise<void> {
  if (!can(actor.role, 'clients:write')) throw new PermissionError('clients:write');
  const n = await db.run('delete from public.collector_notices where id = $1 and client_id = $2', [noticeId, clientId]);
  if (!n) throw new UserError('Notice not found.');
  await db.run("delete from public.findings where client_id = $1 and dedupe_key = $2 and status = 'suggested'", [clientId, `collector-notice:${noticeId}`]);
  await logEvent(db, actor, clientId, 'case_tools', 'Collector notice removed');
}

/** For the client plan: notices whose validation period is still open, soonest end first. */
export async function openValidationWindows(db: Db, clientId: string, today = businessToday()): Promise<{ collector: string; endsOn: string; daysLeft: number }[]> {
  return (await loadCollectorNotices(db, clientId, today)).filter((n) => n.period.open)
    .map((n) => ({ collector: n.collectorName, endsOn: n.period.endsOn, daysLeft: n.period.daysLeft }))
    .sort((a, b) => a.endsOn.localeCompare(b.endsOn));
}
