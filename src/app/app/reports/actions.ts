'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import type { ActionState } from '@/components/forms';
import { parseForm, run, UserError, zBool, zDate, zOpt, zText, zUuid } from '@/lib/action';
import { requireStaff } from '@/lib/auth/context';
import { sha256Hex } from '@/lib/crypto';
import { logEvent } from '@/lib/crm';
import { parseReportText, parseTradelineCsv, parseMoneyToCents, normalizeDate } from '@/lib/reports/parser';
import { pdfToText, PdfTextError } from '@/lib/reports/pdf-text';
import { requestReportPull } from '@/lib/credit/pull';
import { decideReport, regenerateFindings, ReportError, storeParsedReport } from '@/lib/reports/service';
import type { ParsedReport } from '@/lib/reports/types';
import { deleteObject, putObject } from '@/lib/storage';
import { readUpload, UploadError } from '@/lib/upload';
import { BUREAUS } from '@/lib/util';

export async function uploadReportAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const ctx = await requireStaff('reports:write');
  return run(async () => {
    const d = parseForm(z.object({ clientId: zUuid, bureau: z.enum(BUREAUS).optional().or(z.literal('')) }), fd);
    let up;
    try { up = await readUpload(fd.get('file') as File | null, ['application/pdf', 'text/plain', 'text/html', 'text/csv']); }
    catch (e) { if (e instanceof UploadError) throw new UserError(e.message); throw e; }

    let parsed: ParsedReport;
    try {
      if (up.mime === 'text/csv' || /\.csv$/i.test(up.name)) parsed = parseTradelineCsv(up.bytes.toString('utf8'));
      else if (up.mime === 'application/pdf') parsed = parseReportText(await pdfToText(up.bytes));
      else parsed = parseReportText(up.bytes.toString('utf8'), up.mime === 'text/html' ? 'html' : 'text');
    } catch (e) {
      if (e instanceof PdfTextError) throw new UserError(e.message);
      throw e;
    }
    if (!parsed.tradelines.length && !parsed.inquiries.length && !parsed.publicRecords.length && !parsed.identity.length)
      throw new UserError(parsed.warnings[0] ?? 'Nothing could be read from this file.');

    const key = await putObject(ctx.orgId, d.clientId, up.bytes);
    let firstId = '';
    try {
      await ctx.tx(async (db) => {
        const doc = await db.row<{ id: string }>(
          `insert into public.documents (org_id, client_id, kind, file_name, mime_type, size_bytes, sha256, storage_key, uploaded_by, source, review_status)
           values ($1,$2,'credit_report',$3,$4,$5,$6,$7,$8,'staff','accepted') returning id`, [ctx.orgId, d.clientId, up.name, up.mime, up.bytes.length, sha256Hex(up.bytes), key, ctx.userId]);
        const ids = await storeParsedReport(db, ctx, { clientId: d.clientId, parsed, bureau: d.bureau || null, documentId: doc!.id, source: up.mime === 'text/csv' ? 'csv' : 'upload' });
        firstId = ids[0]!;
      });
    } catch (e) {
      await deleteObject(key).catch(() => undefined);
      if (e instanceof ReportError) throw new UserError(e.message);
      throw e;
    }
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
  const d = parseForm(z.object({ id: zUuid, decision: z.enum(['approved', 'rejected']) }), fd);
  const { clientId } = await ctx.tx((db) => decideReport(db, ctx, d.id, d.decision));
  revalidatePath(`/app/clients/${clientId}`);
  redirect(d.decision === 'approved' ? `/app/clients/${clientId}/compare` : `/app/clients/${clientId}?tab=reports`);
}

const money = z.string().trim().optional().transform((v) => (v ? parseMoneyToCents(v) : null));
const date = z.string().trim().optional().transform((v) => (v ? normalizeDate(v) : null));

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
      await db.run(
        `update public.tradelines set creditor_name = $2, account_last4 = $3, account_status = $4, payment_status = $5, balance_cents = $6, credit_limit_cents = $7,
                date_opened = $8, date_reported = $9, date_of_first_delinquency = $10, payment_history = $11, user_provided = $12, confidence = 1, field_meta = '{}'::jsonb
          where id = $1`,
        [d.id, d.creditor, d.last4 || null, d.accountStatus ?? null, d.paymentStatus ?? null, d.balance, d.limit, d.opened, d.reported, d.dofd, d.history ?? null, JSON.stringify(up)],
      );
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
  await ctx.tx((db) => db.run("delete from public.tradelines where id = $1 and report_id = $2 and exists (select 1 from public.credit_reports r where r.id = $2 and r.status = 'pending_review')", [d.id, d.reportId]));
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
