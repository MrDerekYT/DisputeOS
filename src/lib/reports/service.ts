import type { Db } from '../db';
import { UserError } from '../errors';
import { audit } from '../audit';
import { logEvent } from '../crm';
import { fireTrigger } from '../automation/engine';
import { BUREAUS, type Bureau } from '../util';
import { analyze, normCreditor, type AnalysisIdentity, type AnalysisInquiry, type AnalysisPublicRecord, type AnalysisTradeline } from './analysis';
import type { ParsedReport } from './types';

export interface Actor { orgId: string; userId: string; meta?: { ip?: string | null } }

export class ReportError extends UserError {}

const matchKey = (creditor: string, last4: string | null) => `${normCreditor(creditor)}|${last4 ?? ''}`;

/** Persist a parsed report as one `credit_reports` row per bureau, awaiting human review. Returns the new report ids. */
export async function storeParsedReport(
  db: Db, actor: Actor,
  input: { clientId: string; parsed: ParsedReport; bureau?: Bureau | null; documentId?: string | null; source: 'upload' | 'csv' | 'provider' | 'manual' },
): Promise<string[]> {
  const { parsed } = input;
  const fallback = input.bureau ?? parsed.bureau;
  const byBureau = new Map<Bureau, { t: typeof parsed.tradelines; i: typeof parsed.inquiries; p: typeof parsed.publicRecords; id: typeof parsed.identity }>();
  const bucket = (b: Bureau) => byBureau.get(b) ?? (byBureau.set(b, { t: [], i: [], p: [], id: [] }), byBureau.get(b)!);
  const need = (b: Bureau | null) => {
    const bb = b ?? fallback;
    if (!bb) throw new ReportError('Choose which bureau this report is from.');
    return bb;
  };
  parsed.tradelines.forEach((t) => bucket(need(t.bureau)).t.push(t));
  parsed.inquiries.forEach((x) => bucket(need(x.bureau)).i.push(x));
  parsed.publicRecords.forEach((x) => bucket(need(x.bureau)).p.push(x));
  parsed.identity.forEach((x) => bucket(need(x.bureau)).id.push(x));
  (parsed.scores ?? []).forEach((x) => bucket(need(x.bureau)));
  if (!byBureau.size) {
    if (!fallback) throw new ReportError('Nothing was found in this file and no bureau was selected.');
    bucket(fallback);
  }

  const ids: string[] = [];
  for (const [bureau, rows] of byBureau) {
    const rep = await db.row<{ id: string }>(
      `insert into public.credit_reports (org_id, client_id, document_id, bureau, source, status, report_date, warnings, created_by)
       values ($1, $2, $3, $4, $5, 'pending_review', $6, $7, $8) returning id`,
      [actor.orgId, input.clientId, input.documentId ?? null, bureau, input.source, parsed.reportDate, JSON.stringify(parsed.warnings), actor.userId],
    );
    const rid = rep!.id;
    ids.push(rid);
    for (const t of rows.t) {
      await db.run(
        `insert into public.tradelines (org_id, client_id, report_id, bureau, item_type, creditor_name, original_creditor, account_last4, account_type, account_status,
           payment_status, balance_cents, credit_limit_cents, high_balance_cents, date_opened, date_reported, date_of_first_delinquency, payment_history, remarks,
           match_key, confidence, field_meta)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
        [actor.orgId, input.clientId, rid, bureau, t.item_type, t.creditor_name, t.original_creditor, t.account_last4, t.account_type, t.account_status, t.payment_status,
          t.balance_cents, t.credit_limit_cents, t.high_balance_cents, t.date_opened, t.date_reported, t.date_of_first_delinquency, t.payment_history, t.remarks,
          matchKey(t.creditor_name, t.account_last4), Number(t.confidence.toFixed(2)), JSON.stringify(t.field_meta)],
      );
    }
    for (const x of rows.i) await db.run('insert into public.inquiries (org_id, client_id, report_id, bureau, name, inquiry_date) values ($1,$2,$3,$4,$5,$6)', [actor.orgId, input.clientId, rid, bureau, x.name, x.inquiry_date]);
    for (const x of rows.p) await db.run('insert into public.public_records (org_id, client_id, report_id, bureau, kind, court, amount_cents, filed_date, status) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)', [actor.orgId, input.clientId, rid, bureau, x.kind, x.court, x.amount_cents, x.filed_date, x.status]);
    for (const x of rows.id) await db.run('insert into public.report_identity_items (org_id, client_id, report_id, bureau, kind, value) values ($1,$2,$3,$4,$5,$6)', [actor.orgId, input.clientId, rid, bureau, x.kind, x.value]);
    for (const sc of parsed.scores ?? []) {
      if ((sc.bureau ?? fallback) !== bureau) continue;
      await db.run(
        `insert into public.credit_scores (org_id, client_id, report_id, bureau, model, score, scored_on) values ($1,$2,$3,$4,$5,$6,$7) on conflict (report_id, model) do nothing`,
        [actor.orgId, input.clientId, rid, bureau, sc.model, sc.score, sc.scored_on ?? parsed.reportDate ?? new Date().toISOString().slice(0, 10)]);
    }
    await logEvent(db, actor, input.clientId, 'report_uploaded', `${bureau[0]!.toUpperCase()}${bureau.slice(1)} report imported (${rows.t.length} accounts) — awaiting review`);
    await audit(db, { orgId: actor.orgId, actorId: actor.userId, action: 'report.imported', entityType: 'credit_report', entityId: rid, ip: actor.meta?.ip, meta: { bureau, accounts: rows.t.length, source: input.source } });
  }
  await fireTrigger(db, actor, 'report_uploaded', { type: 'client', id: input.clientId });
  return ids;
}

export async function loadAnalysisInput(db: Db, clientId: string) {
  const latest = await db.rows<{ id: string; bureau: Bureau }>(
    `select distinct on (bureau) id, bureau from public.credit_reports where client_id = $1 and status = 'approved' order by bureau, coalesce(report_date, created_at::date) desc, created_at desc`, [clientId]);
  const ids = latest.map((r) => r.id);
  if (!ids.length) return { reports: latest, tradelines: [] as AnalysisTradeline[], inquiries: [] as AnalysisInquiry[], publicRecords: [] as AnalysisPublicRecord[], identity: [] as AnalysisIdentity[] };
  const tradelines = await db.rows<AnalysisTradeline>(
    `select id, bureau, item_type, creditor_name, original_creditor, account_last4, account_status, payment_status, balance_cents, credit_limit_cents, date_opened, date_reported,
            date_of_first_delinquency, payment_history, user_provided from public.tradelines where report_id = any($1::uuid[]) order by creditor_name`, [ids]);
  const inquiries = await db.rows<AnalysisInquiry>('select id, bureau, name, inquiry_date, kind from public.inquiries where report_id = any($1::uuid[])', [ids]);
  const publicRecords = await db.rows<AnalysisPublicRecord>('select id, bureau, kind, filed_date, status from public.public_records where report_id = any($1::uuid[])', [ids]);
  const identity = await db.rows<AnalysisIdentity>('select bureau, kind, value from public.report_identity_items where report_id = any($1::uuid[])', [ids]);
  return { reports: latest, tradelines, inquiries, publicRecords, identity };
}

/** Recompute findings from the latest approved report per bureau. Existing reviewed findings are never overwritten. */
export async function regenerateFindings(db: Db, actor: Actor, clientId: string, clientName: string, clientAddress: string, now = new Date()): Promise<{ created: number; removed: number }> {
  const input = await loadAnalysisInput(db, clientId);
  const findings = analyze({ ...input, clientName, clientAddress, now });
  const keys = findings.map((f) => f.dedupe_key);
  // Suggestions that no longer apply (e.g. a newer report fixed the item) are retired; reviewed ones stay as history.
  const removed = await db.run("delete from public.findings where client_id = $1 and status = 'suggested' and generated_by = 'rules' and not (dedupe_key = any($2::text[]))", [clientId, keys]);
  let created = 0;
  for (const f of findings) {
    created += await db.run(
      `insert into public.findings (org_id, client_id, category, severity, title, explanation, evidence, basis, tradeline_ids, dedupe_key)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) on conflict (client_id, dedupe_key) do nothing`,
      [actor.orgId, clientId, f.category, f.severity, f.title, f.explanation, JSON.stringify(f.evidence), f.basis, f.tradeline_ids, f.dedupe_key],
    );
  }
  return { created, removed };
}

export async function decideReport(db: Db, actor: Actor, reportId: string, decision: 'approved' | 'rejected'): Promise<{ clientId: string }> {
  const rep = await db.row<{ client_id: string; status: string; bureau: Bureau }>('select client_id, status, bureau from public.credit_reports where id = $1 for update', [reportId]);
  if (!rep) throw new ReportError('Report not found.');
  if (rep.status !== 'pending_review') throw new ReportError('This report has already been reviewed.');
  await db.run('update public.credit_reports set status = $2, approved_by = $3 where id = $1', [reportId, decision, actor.userId]);
  if (decision === 'approved') {
    await db.run('update public.tradelines set reviewed_at = now() where report_id = $1', [reportId]);
    const c = await db.row<{ full_name: string; address: { line1?: string; city?: string } }>('select full_name, address from public.clients where id = $1', [rep.client_id]);
    await regenerateFindings(db, actor, rep.client_id, c?.full_name ?? '', c?.address?.line1 ?? '');
    await db.run("update public.clients set stage = case when stage = 'intake' then 'analysis' else stage end where id = $1", [rep.client_id]);
  }
  await logEvent(db, actor, rep.client_id, 'report_reviewed', `${rep.bureau} report ${decision}`);
  await audit(db, { orgId: actor.orgId, actorId: actor.userId, action: `report.${decision}`, entityType: 'credit_report', entityId: reportId, ip: actor.meta?.ip });
  return { clientId: rep.client_id };
}

export const BUREAU_LIST = BUREAUS;
