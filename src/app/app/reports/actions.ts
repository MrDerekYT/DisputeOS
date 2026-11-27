'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import type { ActionState } from '@/components/forms';
import { parseForm, run, UserError, zBool, zDate, zOpt, zText, zUuid } from '@/lib/action';
import { requireStaff } from '@/lib/auth/context';
import { sha256Hex } from '@/lib/crypto';
import { logEvent } from '@/lib/crm';
import { parseMoneyToCents, normalizeDate } from '@/lib/reports/parser';
import { staffReportRefusal } from '@/lib/credit/authorization';
import { queueClientUpdate } from '@/lib/client-updates/service';
import { ocrEnabled } from '@/lib/reports/ocr';
import { pagesNote, readReportFile, ReportReadError, reportMimes, SCANS_OFF_IMAGE, type ReadResult } from '@/lib/reports/read-file';
import { requestReportPull } from '@/lib/credit/pull';
import { rereadReport, type RereadResult } from '@/lib/reports/reread';
import { decideReport, regenerateFindings, ReportChangedError, ReportError, storeParsedReport } from '@/lib/reports/service';
import type { ParsedReport } from '@/lib/reports/types';
import { deleteObject, getObject, putObject } from '@/lib/storage';
import { readUpload, UploadError, type DetectedMime } from '@/lib/upload';
import { BUREAUS } from '@/lib/util';

export async function uploadReportAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const ctx = await requireStaff('reports:write');
  return run(async () => {
    const { firstId } = await importUploadedReport(ctx, fd);
    redirect(`/app/reports/${firstId}`);
  });
}

/**
 * One file from the drag-and-drop box. Same reading and storing as uploadReportAction, but answers with the result
 * instead of leaving the page, so the box can upload several files in turn and show each one's outcome.
 */
export async function uploadReportFileAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const ctx = await requireStaff('reports:write');
  return run(async () => {
    const r = await importUploadedReport(ctx, fd);
    const p = r.parsed;
    const accounts = p.tradelines.filter((t) => t.item_type === 'tradeline').length;
    return { ok: readingLine(p.bureau, { accounts, collections: p.tradelines.length - accounts, inquiries: p.inquiries.length, publicRecords: p.publicRecords.length }, r), data: { reportId: r.firstId } };
  });
}

const BUREAU_NAME: Record<string, string> = { experian: 'Experian', equifax: 'Equifax', transunion: 'TransUnion' };

/** One line on what a reading found: "TransUnion: 12 accounts, 3 collections, 3 inquiries, all 6 pages read". */
function readingLine(bureau: string | null, n: { accounts: number; collections: number; inquiries: number; publicRecords: number }, r: Pick<ReadResult, 'via' | 'pages'>): string {
  const parts = [`${n.accounts} account${n.accounts === 1 ? '' : 's'}`, `${n.collections} collection${n.collections === 1 ? '' : 's'}`, `${n.inquiries} inquir${n.inquiries === 1 ? 'y' : 'ies'}`];
  if (n.publicRecords) parts.push(`${n.publicRecords} public record${n.publicRecords === 1 ? '' : 's'}`);
  return `${BUREAU_NAME[bureau ?? ''] ?? 'Report'}: ${parts.join(', ')}${pagesNote(r)}${r.via.startsWith('ai') ? ' (read by AI, check each field)' : ''}`;
}

/**
 * Reads the stored file of a report that is still waiting for review once more, with the readers as they are now, and
 * puts what the fresh reading holds for that report in place of what it held before (src/lib/reports/reread.ts). Only
 * that one report changes; an approved or rejected report is never touched, and nothing changes when the file cannot
 * be read.
 */
export async function rereadReportAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const ctx = await requireStaff('reports:write');
  return run(async () => {
    const d = parseForm(z.object({ id: zUuid }), fd);
    let r: RereadResult;
    try { r = await rereadReport(ctx.tx, ctx, d.id); }
    catch (e) {
      // The report may have been approved or rejected in another tab meanwhile: the page is drawn again as it now stands.
      if (e instanceof ReportError) revalidatePath(`/app/reports/${d.id}`);
      throw e;
    }
    revalidatePath(`/app/clients/${r.clientId}`);
    revalidatePath(`/app/reports/${d.id}`);
    const also = r.alsoHolds.map((b) => BUREAU_NAME[b]).join(' and ');
    return { ok: `Read again. ${readingLine(r.bureau, r, r)}.`
      + (r.movedFrom ? ` The file reads as a ${BUREAU_NAME[r.bureau]} report, so this report is now filed under ${BUREAU_NAME[r.bureau]} (it was under ${BUREAU_NAME[r.movedFrom]}).` : '')
      + (also ? ` The file also holds ${also} rows; they are not part of this report.` : '') };
  });
}

async function importUploadedReport(ctx: Awaited<ReturnType<typeof requireStaff>>, fd: FormData) {
    const d = parseForm(z.object({ clientId: zUuid, bureau: z.enum(BUREAUS).optional().or(z.literal('')) }), fd);
    // A report staff add needs the client's written authorization on file (src/lib/credit/authorization.ts); checked
    // before the file is read or stored, and again in the transaction that records it.
    const refused = await ctx.tx((db) => staffReportRefusal(db, d.clientId));
    if (refused) throw new UserError(refused);
    let up;
    try { up = await readUpload(fd.get('file') as File | null, reportMimes() as DetectedMime[]); }
    catch (e) {
      if (e instanceof UploadError) throw new UserError(e.message);
      throw e;
    }

    let parsed: ParsedReport;
    let via: ReadResult['via'];
    let pages: ReadResult['pages'];
    try { ({ parsed, via, pages } = await readReportFile(up, { orgId: ctx.orgId, userId: ctx.userId })); }
    catch (e) {
      if (e instanceof ReportReadError) throw new UserError(e.message);
      throw e;
    }
    if (!parsed.tradelines.length && !parsed.inquiries.length && !parsed.publicRecords.length && !parsed.identity.length)
      throw new UserError(parsed.warnings[0] ?? 'Nothing could be read from this file.');

    const key = await putObject(ctx.orgId, d.clientId, up.bytes);
    let firstId = '';
    try {
      await ctx.tx(async (db) => {
        const again = await staffReportRefusal(db, d.clientId);
        if (again) throw new UserError(again);
        const doc = await db.row<{ id: string }>(
          `insert into public.documents (org_id, client_id, kind, file_name, mime_type, size_bytes, sha256, storage_key, uploaded_by, source, review_status)
           values ($1,$2,'credit_report',$3,$4,$5,$6,$7,$8,'staff','accepted') returning id`, [ctx.orgId, d.clientId, up.name, up.mime, up.bytes.length, sha256Hex(up.bytes), key, ctx.userId]);
        const ids = await storeParsedReport(db, ctx, { clientId: d.clientId, parsed, bureau: d.bureau || null, documentId: doc!.id, source: up.mime === 'text/csv' ? 'csv' : 'upload' });
        firstId = ids[0]!;
        await queueClientUpdate(db, { orgId: ctx.orgId, clientId: d.clientId, event: 'report_received', subjectId: doc!.id });
      });
    } catch (e) {
      await deleteObject(key).catch(() => undefined);
      if (e instanceof ReportError) throw new UserError(e.message);
      throw e;
    }
    revalidatePath(`/app/clients/${d.clientId}`);
    return { firstId, parsed, via, pages };
}

/**
 * Reads a file that is already in the client's vault as a credit report — typically the free report the client
 * downloaded from AnnualCreditReport.com and uploaded through the portal. Nothing is re-uploaded. The result lands in
 * the same review queue as any other import: a person checks it against the original and approves it before use.
 * A file the client uploaded can be read at any time; one staff uploaded needs the client's written authorization on
 * file, like any report staff add (src/lib/credit/authorization.ts).
 */
export async function importDocumentAsReportAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const ctx = await requireStaff('reports:write');
  return run(async () => {
    const d = parseForm(z.object({ id: zUuid, clientId: zUuid, bureau: z.enum(BUREAUS).optional().or(z.literal('')) }), fd);
    const USED = 'This file has already been read as a report. Open it from the Reports tab.';
    const REJECTED = 'This document was rejected, so it cannot be read as a report.';
    // Only a document filed as a credit report qualifies; the button is shown for those only, and the same rule applies here.
    const doc = await ctx.tx((db) => db.row<{ id: string; mime_type: string; storage_key: string; review_status: string; used: boolean; source: string }>(
      "select d.id, d.mime_type, d.storage_key, d.review_status, d.source, exists (select 1 from public.credit_reports r where r.document_id = d.id) as used from public.documents d where d.id = $1 and d.client_id = $2 and d.kind = 'credit_report'", [d.id, d.clientId]));
    if (!doc) throw new UserError('Document not found.');
    if (doc.review_status === 'rejected') throw new UserError(REJECTED);
    if (doc.used) throw new UserError(USED);
    const byStaff = doc.source !== 'client';
    if (byStaff) { const refused = await ctx.tx((db) => staffReportRefusal(db, d.clientId)); if (refused) throw new UserError(refused); }
    if (!reportMimes().includes(doc.mime_type)) throw new UserError(ocrEnabled() ? 'Only a PDF, photo, text, HTML or CSV file can be read as a report.' : `Only a PDF, text, HTML or CSV file can be read as a report. ${SCANS_OFF_IMAGE}`);
    const bytes = await getObject(doc.storage_key);
    let parsed: ParsedReport;
    try { ({ parsed } = await readReportFile({ bytes, mime: doc.mime_type, name: '' }, { orgId: ctx.orgId, userId: ctx.userId })); }
    catch (e) {
      if (e instanceof ReportReadError) throw new UserError(e.message);
      throw e;
    }
    if (!parsed.tradelines.length && !parsed.inquiries.length && !parsed.publicRecords.length && !parsed.identity.length)
      throw new UserError(parsed.warnings[0] ?? 'Nothing could be read from this file. If it is a scan or photo, ask the client for the PDF downloaded from the bureau.');
    let firstId = '';
    try {
      await ctx.tx(async (db) => {
        // Checked again under a row lock: two submissions for the same file must not both store a report.
        const cur = await db.row<{ review_status: string; used: boolean }>(
          "select d.review_status, exists (select 1 from public.credit_reports r where r.document_id = d.id) as used from public.documents d where d.id = $1 and d.client_id = $2 and d.kind = 'credit_report' for update of d", [doc.id, d.clientId]);
        if (!cur) throw new UserError('Document not found.');
        if (cur.review_status === 'rejected') throw new UserError(REJECTED);
        if (cur.used) throw new UserError(USED);
        if (byStaff) { const again = await staffReportRefusal(db, d.clientId); if (again) throw new UserError(again); }
        if (cur.review_status !== 'accepted') {
          await db.run("update public.documents set review_status = 'accepted' where id = $1", [doc.id]);
          await logEvent(db, ctx, d.clientId, 'document_reviewed', 'Document accepted (read as credit report)');
        }
        const ids = await storeParsedReport(db, ctx, { clientId: d.clientId, parsed, bureau: d.bureau || null, documentId: doc.id, source: doc.mime_type === 'text/csv' ? 'csv' : 'upload' });
        firstId = ids[0]!;
      });
    } catch (e) {
      if (e instanceof ReportError) throw new UserError(e.message);
      throw e;
    }
    revalidatePath(`/app/clients/${d.clientId}`);
    redirect(`/app/reports/${firstId}`);
  });
}

export async function pullReportAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const ctx = await requireStaff('reports:write');
  return run(async () => {
    const d = parseForm(z.object({ clientId: zUuid, provider: zText(40) }), fd);
    const r = await requestReportPull(ctx.tx, { orgId: ctx.orgId, userId: ctx.userId, role: ctx.role, meta: ctx.meta }, { clientId: d.clientId, provider: d.provider });
    revalidatePath(`/app/clients/${d.clientId}`);
    redirect(`/app/reports/${r.reportIds[0]}`);
  });
}

export async function decideReportAction(fd: FormData) {
  const ctx = await requireStaff('reports:write');
  // `mark`: the reading that was on screen when the button was pressed (readingMark). A report read again, or with a
  // row removed, since then is not decided: the person is shown it as it now stands and decides again.
  const d = parseForm(z.object({ id: zUuid, decision: z.enum(['approved', 'rejected']), mark: z.string().regex(/^[0-9a-f]{32}$/) }), fd);
  let clientId = '';
  try {
    ({ clientId } = await ctx.tx((db) => decideReport(db, ctx, d.id, d.decision, d.mark)));
  } catch (e) {
    // Someone else (or another tab) already reviewed it, or it is gone: show the report as it now stands instead of an error page.
    if (!(e instanceof ReportError)) throw e;
    revalidatePath(`/app/reports/${d.id}`);
    redirect(`/app/reports/${d.id}${e instanceof ReportChangedError ? '?changed=1' : ''}`);
  }
  revalidatePath(`/app/clients/${clientId}`);
  redirect(d.decision === 'approved' ? `/app/clients/${clientId}/compare` : `/app/clients/${clientId}?tab=reports`);
}

// Empty means "not reported". Anything typed must be understood, otherwise the edit is refused rather than saved as blank.
const money = z.string().trim().optional().transform((v, ctx) => {
  if (!v) return null;
  const n = /^[(-]/.test(v) ? null : parseMoneyToCents(v);
  if (n === null) { ctx.addIssue({ code: 'custom', message: 'Enter an amount like 1,234.56' }); return z.NEVER; }
  return n;
});
const date = z.string().trim().optional().transform((v, ctx) => {
  if (!v) return null;
  const d = normalizeDate(v);
  if (d === null) { ctx.addIssue({ code: 'custom', message: 'Enter a real date, like 03/15/2024' }); return z.NEVER; }
  return d;
});

export async function updateTradelineAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const ctx = await requireStaff('reports:write');
  return run(async () => {
    const d = parseForm(
      z.object({
        id: zUuid, reportId: zUuid, creditor: zText(200), last4: z.string().trim().regex(/^[0-9A-Za-z]{0,4}$/, 'Last 4 must be at most 4 letters/digits').optional(),
        accountStatus: zOpt(100), paymentStatus: zOpt(100), balance: money, limit: money, opened: date, reported: date, dofd: date, history: zOpt(120),
        notMine: zBool, neverLate: zBool,
      }),
      fd,
    );
    await ctx.tx(async (db) => {
      const t = await db.row<{ report_id: string; user_provided: Record<string, unknown>; client_id: string }>('select report_id, user_provided, client_id from public.tradelines where id = $1', [d.id]);
      if (!t || t.report_id !== d.reportId) throw new UserError('Account not found.');
      const up = { ...t.user_provided, not_mine: d.notMine || undefined, never_late: d.neverLate || undefined };
      const saved = await db.run(
        `update public.tradelines set creditor_name = $2, account_last4 = $3, account_status = $4, payment_status = $5, balance_cents = $6, credit_limit_cents = $7,
                date_opened = $8, date_reported = $9, date_of_first_delinquency = $10, payment_history = $11, user_provided = $12, confidence = 1, field_meta = '{}'::jsonb
          where id = $1`,
        [d.id, d.creditor, d.last4 || null, d.accountStatus ?? null, d.paymentStatus ?? null, d.balance, d.limit, d.opened, d.reported, d.dofd, d.history ?? null, JSON.stringify(up)],
      );
      // The row was there a moment ago and is gone: the file was read again (or the row removed) while this was typed.
      if (saved !== 1) throw new UserError('This account is no longer on the report: the file was read again or the row was removed. Reload the page.');
      const rep = await db.row<{ status: string }>('select status from public.credit_reports where id = $1', [d.reportId]);
      if (rep?.status === 'approved') {
        const c = await db.row<{ full_name: string; address: { line1?: string } }>('select full_name, address from public.clients where id = $1', [t.client_id]);
        await regenerateFindings(db, ctx, t.client_id, c?.full_name ?? '', c?.address?.line1 ?? '');
      }
    });
    revalidatePath(`/app/reports/${d.reportId}`);
    return { ok: 'Account updated. It is now treated as confirmed.' };
  });
}

export async function deleteTradelineAction(fd: FormData) {
  const ctx = await requireStaff('reports:write');
  const d = parseForm(z.object({ id: zUuid, reportId: zUuid }), fd);
  await ctx.tx(async (db) => {
    // The report row is locked first, as an approval and a re-read lock it: a row is never removed from a report that
    // is being approved at this moment (the approval either sees it gone and is refused, or the row stays).
    const rep = await db.row<{ status: string }>('select status from public.credit_reports where id = $1 for update', [d.reportId]);
    if (rep?.status !== 'pending_review') return;
    await db.run('delete from public.tradelines where id = $1 and report_id = $2', [d.id, d.reportId]);
  });
  revalidatePath(`/app/reports/${d.reportId}`);
}

export async function setFindingStatusAction(fd: FormData) {
  const ctx = await requireStaff('reports:write');
  const d = parseForm(z.object({ id: zUuid, clientId: zUuid, status: z.enum(['suggested', 'accepted', 'dismissed']) }), fd);
  await ctx.tx(async (db) => {
    await db.run('update public.findings set status = $2, reviewed_by = $3 where id = $1', [d.id, d.status, ctx.userId]);
    await logEvent(db, ctx, d.clientId, 'finding', `Finding marked ${d.status}`);
  });
  revalidatePath(`/app/clients/${d.clientId}/compare`);
}

export async function refreshFindingsAction(fd: FormData) {
  const ctx = await requireStaff('reports:write');
  const d = parseForm(z.object({ clientId: zUuid }), fd);
  await ctx.tx(async (db) => {
    const c = await db.row<{ full_name: string; address: { line1?: string } }>('select full_name, address from public.clients where id = $1', [d.clientId]);
    if (c) await regenerateFindings(db, ctx, d.clientId, c.full_name, c.address?.line1 ?? '');
  });
  revalidatePath(`/app/clients/${d.clientId}/compare`);
}

void zDate; void zBool;
