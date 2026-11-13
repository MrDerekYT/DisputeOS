'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import type { ActionState } from '@/components/forms';
import { parseForm, run, UserError, zBool, zText } from '@/lib/action';
import { audit } from '@/lib/audit';
import { clearSessionCookie, currentSession, requireClient, sessionToken } from '@/lib/auth/context';
import { portalLoginPath } from '@/lib/org-brand';
import { changePassword, revokeSession } from '@/lib/auth/service';
import { consentDoc, type ConsentKind } from '@/lib/compliance/disclosures';
import { sha256Hex } from '@/lib/crypto';
import { DOC_KINDS } from '@/lib/crm';
import { deleteObject, putObject } from '@/lib/storage';
import { readUpload, UploadError } from '@/lib/upload';

export async function portalLogoutAction() {
  const s = await currentSession();
  const t = await sessionToken();
  if (t) await revokeSession(t);
  await clearSessionCookie();
  // Back to the agency's own branded sign-in page, so the client never lands somewhere unfamiliar.
  redirect(s?.orgMode === 'agency' ? portalLoginPath(s.orgSlug) : '/portal/login');
}

export async function portalSendMessageAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const ctx = await requireClient();
  return run(async () => {
    const d = parseForm(z.object({ body: zText(4000) }), fd);
    await ctx.tx((db) => db.run(
      `insert into public.communications (org_id, client_id, direction, channel, body, status, author_id) values ($1, $2, 'inbound', 'portal', $3, 'received', $4)`,
      [ctx.orgId, ctx.clientId, d.body, ctx.userId]));
    revalidatePath('/portal/messages');
    return { ok: 'Message sent. Your specialist will reply here.' };
  });
}

export async function portalUploadAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const ctx = await requireClient();
  return run(async () => {
    const d = parseForm(z.object({ kind: z.enum(DOC_KINDS) }), fd);
    if (d.kind === 'contract' || d.kind === 'bureau_response' || d.kind === 'evidence' || d.kind === 'credit_report') { /* allowed: clients may send these too */ }
    let up;
    try { up = await readUpload(fd.get('file') as File | null, ['application/pdf', 'image/png', 'image/jpeg']); }
    catch (e) { if (e instanceof UploadError) throw new UserError(e.message); throw e; }
    const key = await putObject(ctx.orgId, ctx.clientId, up.bytes);
    try {
      // Row-level security requires source = 'client', uploaded_by = me, and this client's organization.
      await ctx.tx((db) => db.run(
        `insert into public.documents (org_id, client_id, kind, file_name, mime_type, size_bytes, sha256, storage_key, uploaded_by, source) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,'client')`,
        [ctx.orgId, ctx.clientId, d.kind, up.name, up.mime, up.bytes.length, sha256Hex(up.bytes), key, ctx.userId]));
    } catch (e) {
      await deleteObject(key).catch(() => undefined);
      throw e;
    }
    revalidatePath('/portal', 'layout');
    redirect('/portal/documents?uploaded=1');
  });
}

export async function portalUpdateProfileAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const ctx = await requireClient();
  return run(async () => {
    const d = parseForm(
      z.object({
        phone: z.string().trim().max(30).optional(), language: z.enum(['en', 'es']),
        line1: z.string().trim().max(120).optional(), line2: z.string().trim().max(120).optional(), city: z.string().trim().max(80).optional(),
        state: z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/, 'Use a two-letter state code').optional().or(z.literal('')), zip: z.string().trim().regex(/^\d{5}(-\d{4})?$/, 'Use a 5-digit ZIP').optional().or(z.literal('')),
      }),
      fd,
    );
    // The database trigger rejects any change outside phone / address / language, even if this code were wrong.
    await ctx.tx(async (db) => {
      await db.run('update public.clients set phone = $2, preferred_language = $3, address = $4 where id = $1', [ctx.clientId, d.phone || null, d.language, JSON.stringify({ line1: d.line1 ?? '', line2: d.line2 ?? '', city: d.city ?? '', state: d.state ?? '', zip: d.zip ?? '' })]);
      await audit(db, { orgId: ctx.orgId, actorId: ctx.userId, action: 'portal.profile_updated', entityType: 'client', entityId: ctx.clientId, ip: ctx.meta.ip });
    });
    revalidatePath('/portal', 'layout');
    return { ok: 'Saved.' };
  });
}

export async function portalSignConsentAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const ctx = await requireClient();
  return run(async () => {
    const d = parseForm(z.object({ kind: z.enum(['croa_disclosure', 'croa_contract', 'fcra_authorization', 'esign', 'communications', 'data_processing']), signedName: zText(160), agree: zBool }), fd);
    if (!d.agree) throw new UserError('Please confirm you have read and agree.');
    const doc = consentDoc(d.kind as ConsentKind);
    await ctx.tx(async (db) => {
      const client = await db.row<{ full_name: string }>('select full_name from public.clients where id = $1', [ctx.clientId]);
      const typed = d.signedName.trim().toLowerCase().replace(/\s+/g, ' ');
      const known = (client?.full_name ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
      if (known && typed.split(' ')[0] !== known.split(' ')[0]) throw new UserError('Please type your full legal name as it appears on your account.');
      const dup = await db.row('select 1 from public.client_consents where client_id = $1 and kind = $2 and revoked_at is null', [ctx.clientId, d.kind]);
      if (dup) throw new UserError('You have already signed this.');
      await db.run('insert into public.client_consents (org_id, client_id, kind, version, signed_name, ip, user_agent) values ($1,$2,$3,$4,$5,$6,$7)',
        [ctx.orgId, ctx.clientId, d.kind, `${doc.version}:${sha256Hex(doc.text).slice(0, 12)}`, d.signedName, ctx.meta.ip ?? null, ctx.meta.userAgent?.slice(0, 300) ?? null]);
      await audit(db, { orgId: ctx.orgId, actorId: ctx.userId, action: 'consent.signed_by_client', entityType: 'client', entityId: ctx.clientId, ip: ctx.meta.ip, meta: { kind: d.kind } });
    });
    revalidatePath('/portal', 'layout');
    return { ok: 'Signed. Thank you.' };
  });
}

export async function portalChangePasswordAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const ctx = await requireClient();
  return run(async () => {
    const d = parseForm(z.object({ current: z.string().min(1).max(200), next: z.string().min(1).max(200), confirm: z.string() }), fd);
    if (d.next !== d.confirm) throw new UserError('The new passwords do not match.');
    const r = await changePassword(ctx.userId, d.current, d.next, ctx.session.sessionId);
    return r.ok ? { ok: 'Password changed.' } : { error: r.error };
  });
}
