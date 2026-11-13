import { NextResponse } from 'next/server';
import { audit } from '@/lib/audit';
import { currentSession } from '@/lib/auth/context';
import { withTenant } from '@/lib/db';
import { can } from '@/lib/rbac';
import { isUuid } from '@/lib/util';

export const dynamic = 'force-dynamic';

/**
 * Everything held about one client, as JSON — for access requests and before deletion. Identifiers are masked:
 * full SSN/DOB stay encrypted and are never exported; account numbers are only ever stored as the last four.
 */
export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const s = await currentSession();
  if (!s || !isUuid(id) || !can(s.role, 'clients:delete')) return new NextResponse('Not found', { status: 404 });
  const out = await withTenant(s.userId, async (db) => {
    const client = await db.row('select id, full_name, email, phone, preferred_language, status, stage, source, address, ssn_last4, tags, goals, created_at from public.clients where id = $1', [id]);
    if (!client) return null;
    const q = (sql: string) => db.rows(sql, [id]);
    const data = {
      exported_at: new Date().toISOString(), client,
      consents: await q('select kind, version, signed_name, signed_at, revoked_at from public.client_consents where client_id = $1 order by signed_at'),
      notes: await q('select body, pinned, created_at from public.client_notes where client_id = $1 order by created_at'),
      tasks: await q('select title, detail, kind, status, due_at, created_at from public.tasks where client_id = $1 order by created_at'),
      communications: await q('select direction, channel, subject, body, status, created_at from public.communications where client_id = $1 order by created_at'),
      documents: await q('select kind, file_name, mime_type, size_bytes, sha256, review_status, created_at from public.documents where client_id = $1 order by created_at'),
      credit_reports: await q('select bureau, source, status, report_date, created_at from public.credit_reports where client_id = $1 order by created_at'),
      tradelines: await q('select bureau, item_type, creditor_name, account_last4, account_status, payment_status, balance_cents, date_opened, date_reported from public.tradelines where client_id = $1'),
      disputes: await q('select item_label, category, reason, status, round, outcome, submitted_at, due_at, response_at, created_at from public.disputes where client_id = $1 order by created_at'),
      letters: await q('select title, kind, status, current_version, approved_at, sent_at, created_at from public.letters where client_id = $1 order by created_at'),
      payments: can(s.role, 'billing:read') ? await q('select amount_cents, currency, method, status, paid_at from public.payments where client_id = $1 order by paid_at') : 'not included for your role',
    };
    await audit(db, { orgId: s.orgId, actorId: s.userId, action: 'client.exported', entityType: 'client', entityId: id });
    return data;
  });
  if (!out) return new NextResponse('Not found', { status: 404 });
  return new NextResponse(JSON.stringify(out, null, 2), {
    headers: { 'content-type': 'application/json', 'content-disposition': `attachment; filename="client-${id.slice(0, 8)}-export.json"`, 'cache-control': 'private, no-store' },
  });
}
