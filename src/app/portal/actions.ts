'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { after } from 'next/server';
import { z } from 'zod';
import type { ActionState } from '@/components/forms';
import { parseForm, run, UserError, zBool, zDate, zText } from '@/lib/action';
import { agencyZone, AgreementError, cancelAgreement, signAgreement, type SignProblem } from '@/lib/agreements';
import { audit } from '@/lib/audit';
import { clearSessionCookie, currentSession, requireClient, sessionToken } from '@/lib/auth/context';
import { portalLoginPath } from '@/lib/org-brand';
import { changePassword, revokeSession } from '@/lib/auth/service';
import { CONSENT_KINDS } from '@/lib/compliance/disclosures';
import { encryptPII, sha256Hex } from '@/lib/crypto';
import { DOC_KINDS } from '@/lib/crm';
import { deleteObject, putObject } from '@/lib/storage';
import { portalMessage, tr, type Lang, type PortalKey } from '@/lib/portal-i18n';
import { isRealDay } from '@/lib/real-day';
import { readUpload, UploadError } from '@/lib/upload';
import { dayInZone } from '@/lib/util';
import { withSystem } from '@/lib/db';
import { alertStaff } from '@/lib/staff-alerts';
import { autoReadClientReport } from '@/lib/reports/auto-read';
import { label as kindLabel } from '@/components/ui';

/**
 * After the client's change is saved and the page has answered: tell the workspace's owners and admins (in the app
 * and by email). Never delays or breaks what the client did.
 */
function tellStaff(ctx: PortalCtx, title: (name: string) => string, body: (name: string) => string, href: string) {
  after(async () => {
    const c = await withSystem((db) => db.row<{ full_name: string }>('select full_name from public.clients where id = $1', [ctx.clientId])).catch(() => null);
    const name = c?.full_name?.trim() || 'A client';
    await alertStaff({ orgId: ctx.orgId, title: title(name), body: body(name), href });
  });
}

type PortalCtx = Awaited<ReturnType<typeof requireClient>>;

/**
 * Every portal form action runs through here so that results and errors reach the client in their own language,
 * without internal field names. `t` is bound to the language saved on the client's own record.
 */
async function portalAction(fn: (ctx: PortalCtx, t: (k: PortalKey) => string, lang: Lang) => Promise<ActionState | void>): Promise<ActionState> {
  const ctx = await requireClient();
  const row = await ctx.tx((db) => db.row<{ preferred_language: Lang }>('select preferred_language from public.clients where id = $1', [ctx.clientId]));
  const lang: Lang = row?.preferred_language === 'es' ? 'es' : 'en';
  const r = await run(() => fn(ctx, tr(lang), lang));
  return r?.error ? { ...r, error: portalMessage(lang, r.error) } : r;
}

export async function portalLogoutAction() {
  const s = await currentSession();
  const t = await sessionToken();
  if (t) await revokeSession(t);
  await clearSessionCookie();
  // Back to the agency's own branded sign-in page, so the client never lands somewhere unfamiliar.
  redirect(s?.orgMode === 'agency' ? portalLoginPath(s.orgSlug) : '/portal/login');
}

export async function portalSendMessageAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return portalAction(async (ctx, t) => {
    const d = parseForm(z.object({ body: zText(4000) }), fd);
    await ctx.tx((db) => db.run(
      `insert into public.communications (org_id, client_id, direction, channel, body, status, author_id) values ($1, $2, 'inbound', 'portal', $3, 'received', $4)`,
      [ctx.orgId, ctx.clientId, d.body, ctx.userId]));
    // The message itself is not copied into the email: staff read it in the app.
    tellStaff(ctx, (n) => `New message from ${n}`, (n) => `${n} sent you a message in their portal.`, `/app/clients/${ctx.clientId}?tab=messages`);
    revalidatePath('/portal/messages');
    return { ok: t('a_messageSent') };
  });
}

/** Where an upload returns to: only these pages, never a path taken from the form. */
const UPLOAD_RETURN = { documents: '/portal/documents?uploaded=1', welcome: '/portal/welcome?step=documents&uploaded=1' } as const;

export async function portalUploadAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return portalAction(async (ctx) => {
    const d = parseForm(z.object({ kind: z.enum(DOC_KINDS), returnTo: z.enum(['documents', 'welcome']).default('documents') }), fd);
    if (d.kind === 'contract' || d.kind === 'bureau_response' || d.kind === 'evidence' || d.kind === 'credit_report') { /* allowed: clients may send these too */ }
    let up;
    try { up = await readUpload(fd.get('file') as File | null, ['application/pdf', 'image/png', 'image/jpeg']); }
    catch (e) { if (e instanceof UploadError) throw new UserError(e.message); throw e; }
    const key = await putObject(ctx.orgId, ctx.clientId, up.bytes);
    let docId = '';
    try {
      // Row-level security requires source = 'client', uploaded_by = me, and this client's organization.
      const row = await ctx.tx((db) => db.row<{ id: string }>(
        `insert into public.documents (org_id, client_id, kind, file_name, mime_type, size_bytes, sha256, storage_key, uploaded_by, source) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,'client') returning id`,
        [ctx.orgId, ctx.clientId, d.kind, up.name, up.mime, up.bytes.length, sha256Hex(up.bytes), key, ctx.userId]));
      docId = row!.id;
    } catch (e) {
      await deleteObject(key).catch(() => undefined);
      throw e;
    }
    const file = { bytes: up.bytes, mime: up.mime, name: up.name };
    // A credit report is read right away (after the page answers, so the client never waits on it) and queued for
    // review; staff are told either way. Anything else: staff are told a file arrived.
    after(async () => {
      const c = await withSystem((db) => db.row<{ full_name: string }>('select full_name from public.clients where id = $1', [ctx.clientId])).catch(() => null);
      const name = c?.full_name?.trim() || 'A client';
      if (d.kind === 'credit_report') {
        const r = await autoReadClientReport({ orgId: ctx.orgId, clientId: ctx.clientId, userId: ctx.userId, documentId: docId, ...file });
        if (r.reportIds.length) {
          await alertStaff({ orgId: ctx.orgId, title: `${name} uploaded a credit report: ready to review`,
            body: `${name} uploaded a credit report. It was read automatically: ${r.accounts} account${r.accounts === 1 ? '' : 's'} and ${r.collections} collection${r.collections === 1 ? '' : 's'}. Check it and approve it to flag the negative items.`,
            href: `/app/reports/${r.reportIds[0]}` });
        } else {
          await alertStaff({ orgId: ctx.orgId, title: `${name} uploaded a credit report`,
            body: `${name} uploaded a credit report that could not be read automatically (${r.error ?? 'unknown reason'}). Open their documents to read it by hand or ask for the PDF from AnnualCreditReport.com.`,
            href: `/app/clients/${ctx.clientId}?tab=documents` });
        }
      } else {
        await alertStaff({ orgId: ctx.orgId, title: `${name} uploaded a document`, body: `${name} uploaded a document (${kindLabel(d.kind)}): “${file.name}”. Review it in their documents.`,
          href: `/app/clients/${ctx.clientId}?tab=documents` });
      }
    });
    revalidatePath('/portal', 'layout');
    redirect(UPLOAD_RETURN[d.returnTo]);
  });
}

export async function portalUpdateProfileAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return portalAction(async (ctx) => {
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
    return { ok: tr(d.language)('a_saved') }; // in the language just saved, like the page around it
  });
}

const SIGN_MESSAGE: Record<SignProblem, PortalKey> = {
  order: 'a_order', not_ready: 'a_notReady', changed: 'a_changed', already: 'a_alreadySigned', name: 'a_legalName', not_found: 'e_noAccess',
  // Refusals of staff recording (a paper date, the E-SIGN consent) and of a personal workspace, which has no portal clients:
  // a client signing in the portal never meets them. client_terms: the payment terms staff set for this client no longer
  // pass the checks, so for the client the agreement is simply not ready yet.
  paper_date: 'a_notReady', portal_only: 'a_notReady', personal: 'a_notReady', client_terms: 'a_notReady',
};

/**
 * Refusals that mean the page the client signed on is out of date: the text changed since it was shown (terms saved,
 * the day rolled over), the documents moved on (signed in another tab), or the agreement is no longer ready. The page
 * is shown again from the records, with the current text and its hash, and a note saying why (`notice`): posting the
 * same stale text again could only be refused again.
 */
const SHOW_AGAIN: Partial<Record<SignProblem, 'changed' | 'order' | 'already' | 'notReady'>> = {
  changed: 'changed', order: 'order', already: 'already', not_ready: 'notReady', client_terms: 'notReady',
};

/**
 * The client e-signs one document. The page posts `shown`, the SHA-256 of the exact text it displayed; the server
 * builds the text again from the records and refuses when it differs (src/lib/agreements.ts). The four required
 * documents go in order; from the welcome steps the page moves on to the next one.
 */
export async function portalSignConsentAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return portalAction(async (ctx, t, lang) => {
    const d = parseForm(z.object({
      kind: z.enum(CONSENT_KINDS), signedName: zText(160), agree: zBool, canRead: zBool, shown: z.string().regex(/^[0-9a-f]{64}$/),
      from: z.enum(['welcome', 'profile']).default('profile'),
    }), fd);
    if (!d.agree) throw new UserError(t('a_confirmAgree'));
    // 15 U.S.C. § 7001(c)(1)(C)(ii): the consent is given in a way that shows the client can open the electronic form used.
    if (d.kind === 'esign' && !d.canRead) throw new UserError(t('a_confirmCanRead'));
    let id = '';
    try {
      await ctx.tx(async (db) => {
        ({ id } = await signAgreement(db, { orgId: ctx.orgId, clientId: ctx.clientId, userId: ctx.userId, ip: ctx.meta.ip, userAgent: ctx.meta.userAgent, by: 'client' }, { kind: d.kind, signedName: d.signedName, shown: d.shown, lang }));
        await audit(db, { orgId: ctx.orgId, actorId: ctx.userId, action: 'consent.signed_by_client', entityType: 'client', entityId: ctx.clientId, ip: ctx.meta.ip, meta: { kind: d.kind, consent_id: id } });
      });
    } catch (e) {
      if (e instanceof AgreementError) {
        const notice = SHOW_AGAIN[e.code];
        if (notice) {
          revalidatePath('/portal', 'layout');
          redirect(d.from === 'welcome' ? `/portal/welcome?step=agreements&notice=${notice}` : `/portal/profile?notice=${notice}#agreements`);
        }
        throw new UserError(t(SIGN_MESSAGE[e.code]));
      }
      throw e;
    }
    tellStaff(ctx, (n) => `${n} signed: ${kindLabel(d.kind)}`, (n) => `${n} signed “${kindLabel(d.kind)}” in their portal.`, `/app/clients/${ctx.clientId}`);
    revalidatePath('/portal', 'layout');
    if (d.from === 'welcome') redirect(`/portal/welcome?step=agreements&signed=${id}`);
    return { ok: t('a_signedOk') };
  });
}

/**
 * Step 1 of the welcome: contact details, plus the date of birth and Social Security number, which a client may give
 * once. They are only ever written while empty (coalesce here, and the database guard refuses any later change); once
 * on file they are never shown back.
 */
export async function portalSaveDetailsAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return portalAction(async (ctx, t) => {
    const d = parseForm(z.object({
      phone: z.string().trim().max(30).optional(), language: z.enum(['en', 'es']),
      line1: z.string().trim().max(120).optional(), line2: z.string().trim().max(120).optional(), city: z.string().trim().max(80).optional(),
      state: z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/, 'Use a two-letter state code').optional().or(z.literal('')), zip: z.string().trim().regex(/^\d{5}(-\d{4})?$/, 'Use a 5-digit ZIP').optional().or(z.literal('')),
      dob: zDate.optional().or(z.literal('')), ssn: z.string().trim().optional(),
    }), fd);
    const t2 = tr(d.language);
    if (!d.line1 || !d.city || !d.state || !d.zip) throw new UserError(t2('e_address'));
    const ssn = (d.ssn ?? '').replace(/[\s-]/g, '');
    if (ssn && !/^\d{9}$/.test(ssn)) throw new UserError(t2('e_ssn'));
    await ctx.tx(async (db) => {
      const c = await db.row<{ has_dob: boolean; has_ssn: boolean; org_id: string }>('select dob_encrypted is not null as has_dob, ssn_last4 is not null as has_ssn, org_id from public.clients where id = $1', [ctx.clientId]);
      if (!c) throw new UserError(t('e_noAccess'));
      if (!c.has_dob) {
        if (!d.dob) throw new UserError(t2('e_dob'));
        const tz = await agencyZone(db, ctx.orgId);
        // A day that exists: 2000-02-31 would otherwise be stored, kept for good, and printed as 2 March 2000.
        if (!isRealDay(d.dob) || d.dob < '1900-01-01' || d.dob > dayInZone(tz)) throw new UserError(t2('e_dob'));
      }
      if (!c.has_ssn && !ssn) throw new UserError(t2('e_ssn'));
      // Written only while empty. The database refuses a portal user's change to either once it is on file (0031).
      await db.run(
        `update public.clients set phone = $2, preferred_language = $3, address = $4,
                dob_encrypted = coalesce(dob_encrypted, $5), ssn_last4 = coalesce(ssn_last4, $6), ssn_encrypted = coalesce(ssn_encrypted, $7)
          where id = $1`,
        [ctx.clientId, d.phone || null, d.language, JSON.stringify({ line1: d.line1 ?? '', line2: d.line2 ?? '', city: d.city ?? '', state: d.state ?? '', zip: d.zip ?? '' }),
          !c.has_dob && d.dob ? encryptPII(d.dob) : null, !c.has_ssn && ssn ? ssn.slice(-4) : null, !c.has_ssn && ssn ? encryptPII(ssn) : null]);
      await audit(db, { orgId: ctx.orgId, actorId: ctx.userId, action: 'portal.details_saved', entityType: 'client', entityId: ctx.clientId, ip: ctx.meta.ip, meta: { dob_added: !c.has_dob, ssn_added: !c.has_ssn } });
    });
    revalidatePath('/portal', 'layout');
    redirect('/portal/welcome');
  });
}

/**
 * "Cancel my agreement", while the cancellation period runs (15 U.S.C. § 1679e(a)). The client's written notice is
 * posted to their specialist as a portal message in the words of the Notice of Cancellation (§ 1679e(b)), and the
 * service agreement in force is revoked through app.cancel_own_contract(), which records why (revoked_reason
 * 'client_cancelled'), marks the client cancelled and notifies the owners, admins and specialist. With no agreement in
 * force no dispute can be submitted and no letter recorded as sent (src/lib/agreements.ts), and a charge is held.
 * After the period only a message to the specialist is offered.
 *
 * On success the client is taken to the portal home, which leads with the cancelled state read from the records ("You
 * cancelled your service agreement on …", with the copy): the form that was used is gone once nothing is in force.
 */
export async function portalCancelAgreementAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return portalAction(async (ctx, t) => {
    const d = parseForm(z.object({ signedName: zText(160), confirm: zBool }), fd);
    if (!d.confirm) throw new UserError(t('a_confirmCancel'));
    try {
      await ctx.tx(async (db) => {
        await cancelAgreement(db, { orgId: ctx.orgId, clientId: ctx.clientId, userId: ctx.userId }, d.signedName);
        await audit(db, { orgId: ctx.orgId, actorId: ctx.userId, action: 'consent.cancelled_by_client', entityType: 'client', entityId: ctx.clientId, ip: ctx.meta.ip, meta: { kind: 'croa_contract' } });
      });
    } catch (e) {
      if (e instanceof AgreementError) throw new UserError(t(e.code === 'name' ? 'a_legalName' : 'a_cancelClosed'));
      throw e;
    }
    revalidatePath('/portal', 'layout');
    redirect('/portal');
  });
}

export async function portalChangePasswordAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return portalAction(async (ctx, t) => {
    const d = parseForm(z.object({ current: z.string().min(1).max(200), next: z.string().min(1).max(200), confirm: z.string() }), fd);
    if (d.next !== d.confirm) throw new UserError(t('a_pwMismatch'));
    const r = await changePassword(ctx.userId, d.current, d.next, ctx.session.sessionId);
    return r.ok ? { ok: t('a_pwChanged') } : { error: r.error };
  });
}
