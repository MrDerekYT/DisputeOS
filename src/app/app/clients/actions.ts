'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import type { ActionState } from '@/components/forms';
import { parseForm, run, UserError, zBool, zDate, zOpt, zText, zUuid } from '@/lib/action';
import { audit } from '@/lib/audit';
import { requireStaff } from '@/lib/auth/context';
import { createInviteToken } from '@/lib/auth/service';
import { fireTrigger } from '@/lib/automation/engine';
import { consentDoc, type ConsentKind } from '@/lib/compliance/disclosures';
import { DOC_KINDS, CLIENT_STAGES, CLIENT_STATUSES, logEvent } from '@/lib/crm';
import { encryptPII } from '@/lib/crypto';
import { getEnv } from '@/lib/env';
import { sendEmail } from '@/lib/mailer';
import { deleteObject, putObject } from '@/lib/storage';
import { readUpload, UploadError } from '@/lib/upload';
import { sha256Hex } from '@/lib/crypto';
import { portalLoginPath } from '@/lib/org-brand';
import { PRODUCT } from '@/lib/product';

const email = z.string().trim().toLowerCase().email('Enter a valid email address').max(254);
const optEmail = z.union([email, z.literal('')]).transform((v) => v || undefined);
const phone = zOpt(30);

const profileShape = {
  fullName: zText(160),
  email: optEmail.optional(),
  phone,
  preferredLanguage: z.enum(['en', 'es']).default('en'),
  source: zOpt(80),
  goals: zOpt(2000),
  line1: zOpt(120), line2: zOpt(120), city: zOpt(80),
  state: z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/, 'Use a two-letter state code').optional().or(z.literal('')),
  zip: z.string().trim().regex(/^\d{5}(-\d{4})?$/, 'Use a 5-digit ZIP').optional().or(z.literal('')),
  dob: zDate.optional().or(z.literal('')),
  ssn: z.string().trim().regex(/^(\d{3}-?\d{2}-?\d{4})?$/, 'SSN must be 9 digits').optional(),
  assignedTo: zUuid.optional().or(z.literal('')),
  tags: zOpt(200),
};

function addressOf(d: { line1?: string; line2?: string; city?: string; state?: string; zip?: string }) {
  return { line1: d.line1 ?? '', line2: d.line2 ?? '', city: d.city ?? '', state: d.state ?? '', zip: d.zip ?? '' };
}
const tagsOf = (t?: string) => (t ? t.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean).slice(0, 10) : []);

async function recordConsent(db: Parameters<Parameters<Awaited<ReturnType<typeof requireStaff>>['tx']>[0]>[0], ctx: Awaited<ReturnType<typeof requireStaff>>, clientId: string, kind: ConsentKind, signedName: string) {
  const doc = consentDoc(kind);
  await db.run(
    `insert into public.client_consents (org_id, client_id, kind, version, signed_name, ip, user_agent) values ($1, $2, $3, $4, $5, $6, $7)`,
    [ctx.orgId, clientId, kind, `${doc.version}:${sha256Hex(doc.text).slice(0, 12)}`, signedName, ctx.meta.ip ?? null, ctx.meta.userAgent?.slice(0, 300) ?? null],
  );
  await logEvent(db, ctx, clientId, 'consent', `${doc.title} recorded`, { kind });
}

// ---------------------------------------------------------------- create / edit
export async function createClientAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const ctx = await requireStaff('clients:write');
  return run(async () => {
    let newId = '';
    const d = parseForm(
      z.object({
        ...profileShape,
        status: z.enum(CLIENT_STATUSES).default('onboarding'),
        consentDisclosure: zBool, consentContract: zBool, consentAuthorization: zBool,
        signedName: zOpt(160),
        invite: zBool,
      }),
      fd,
    );
    const consents: ConsentKind[] = [];
    if (d.consentDisclosure) consents.push('croa_disclosure');
    if (d.consentContract) consents.push('croa_contract');
    if (d.consentAuthorization) consents.push('fcra_authorization');
    if (consents.length && !d.signedName) throw new UserError('Enter the name the client signed with to record consents.');
    if (d.invite && !d.email) throw new UserError('An email address is required to invite the client to the portal.');
    if (d.assignedTo && !ctx.can('clients:assign') && d.assignedTo !== ctx.userId) throw new UserError('You can only assign clients to yourself.');

    const ssn = d.ssn?.replace(/\D/g, '') ?? '';
    let inviteLink = '';
    await ctx.tx(async (db) => {
      const c = await db.row<{ id: string }>(
        `insert into public.clients (org_id, assigned_to, full_name, email, phone, preferred_language, status, source, goals, address,
                                      ssn_last4, ssn_encrypted, dob_encrypted, tags)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) returning id`,
        [ctx.orgId, d.assignedTo || ctx.userId, d.fullName, d.email ?? null, d.phone ?? null, d.preferredLanguage, d.status, d.source ?? null, d.goals ?? null,
          JSON.stringify(addressOf(d)), ssn ? ssn.slice(-4) : null, ssn ? encryptPII(ssn) : null, d.dob ? encryptPII(d.dob) : null, tagsOf(d.tags)],
      );
      newId = c!.id;
      await logEvent(db, ctx, newId, 'client_created', 'Client created');
      for (const k of consents) await recordConsent(db, ctx, newId, k, d.signedName!);
      if (d.invite && d.email) {
        const token = await createInviteToken(db, { orgId: ctx.orgId, email: d.email, role: 'client', clientId: newId, invitedBy: ctx.userId });
        inviteLink = `${getEnv().APP_URL}/invite/${token}`;
        await logEvent(db, ctx, newId, 'portal_invited', 'Portal invitation created');
      }
      await audit(db, { orgId: ctx.orgId, actorId: ctx.userId, action: 'client.created', entityType: 'client', entityId: newId, ip: ctx.meta.ip });
      await fireTrigger(db, ctx, 'client_created', { type: 'client', id: newId });
    });
    revalidatePath('/app/clients');
    if (inviteLink && d.email) {
      const sent = await sendEmail({
        to: d.email,
        subject: `${ctx.session.orgName}: your secure client portal`,
        text: `Hello ${d.fullName.split(' ')[0]},\n\n${ctx.session.orgName} has invited you to your secure client portal, where you can see progress, upload documents and message your specialist.\n\nCreate your account: ${inviteLink}\n\nThis link expires in 7 days.`,
      });
      if (sent.provider === 'log') {
        return { ok: `Client created, but email delivery is not configured. Share this one-time invitation link with the client: ${inviteLink} — then open the client from the Clients list.` };
      }
    }
    redirect(`/app/clients/${newId}`);
  });
}

export async function updateClientAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const ctx = await requireStaff('clients:write');
  return run(async () => {
    const d = parseForm(
      z.object({
        id: zUuid, ...profileShape,
        status: z.enum(CLIENT_STATUSES), stage: z.enum(CLIENT_STAGES),
      }),
      fd,
    );
    if (d.assignedTo && !ctx.can('clients:assign') && d.assignedTo !== ctx.userId) throw new UserError('You do not have permission to reassign clients.');
    const ssn = d.ssn?.replace(/\D/g, '') ?? '';
    await ctx.tx(async (db) => {
      const before = await db.row<{ status: string; stage: string; assigned_to: string | null }>('select status, stage, assigned_to from public.clients where id = $1', [d.id]);
      if (!before) throw new UserError('Client not found.');
      await db.run(
        `update public.clients set full_name = $2, email = $3, phone = $4, preferred_language = $5, source = $6, goals = $7, address = $8,
                status = $9, stage = $10, assigned_to = $11, tags = $12,
                ssn_last4 = coalesce($13, ssn_last4), ssn_encrypted = coalesce($14, ssn_encrypted),
                dob_encrypted = coalesce($15, dob_encrypted)
          where id = $1`,
        [d.id, d.fullName, d.email ?? null, d.phone ?? null, d.preferredLanguage, d.source ?? null, d.goals ?? null, JSON.stringify(addressOf(d)),
          d.status, d.stage, ctx.can('clients:assign') ? d.assignedTo || null : before.assigned_to, tagsOf(d.tags),
          ssn ? ssn.slice(-4) : null, ssn ? encryptPII(ssn) : null, d.dob ? encryptPII(d.dob) : null],
      );
      if (before.status !== d.status) await logEvent(db, ctx, d.id, 'status_changed', `Status changed: ${before.status} → ${d.status}`);
      if (before.stage !== d.stage) await logEvent(db, ctx, d.id, 'stage_changed', `Stage changed: ${before.stage} → ${d.stage}`);
      if (before.assigned_to !== (d.assignedTo || null) && ctx.can('clients:assign')) await logEvent(db, ctx, d.id, 'assigned', 'Specialist assignment changed');
      await audit(db, { orgId: ctx.orgId, actorId: ctx.userId, action: 'client.updated', entityType: 'client', entityId: d.id, ip: ctx.meta.ip, meta: { fields: 'profile', ssn_changed: !!ssn } });
    });
    revalidatePath(`/app/clients/${d.id}`);
    return { ok: 'Client updated.' };
  });
}

export async function deleteClientAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const ctx = await requireStaff('clients:delete');
  return run(async () => {
    const d = parseForm(z.object({ id: zUuid, confirm: z.string() }), fd);
    const keys: string[] = [];
    await ctx.tx(async (db) => {
      const c = await db.row<{ full_name: string }>('select full_name from public.clients where id = $1', [d.id]);
      if (!c) throw new UserError('Client not found.');
      if (d.confirm.trim() !== c.full_name) throw new UserError('Type the client’s full name exactly to confirm deletion.');
      keys.push(...(await db.rows<{ storage_key: string }>('select storage_key from public.documents where client_id = $1', [d.id])).map((r) => r.storage_key));
      await db.run('delete from public.clients where id = $1', [d.id]);
      await audit(db, { orgId: ctx.orgId, actorId: ctx.userId, action: 'client.deleted', entityType: 'client', entityId: d.id, ip: ctx.meta.ip, meta: { documents_removed: keys.length } });
    });
    await Promise.all(keys.map((k) => deleteObject(k).catch(() => undefined)));
    redirect('/app/clients');
  });
}

// ---------------------------------------------------------------- notes & tasks
export async function addNoteAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const ctx = await requireStaff('clients:write');
  return run(async () => {
    const d = parseForm(z.object({ clientId: zUuid, body: zText(5000), pinned: zBool }), fd);
    await ctx.tx(async (db) => {
      await db.run('insert into public.client_notes (org_id, client_id, author_id, body, pinned) values ($1, $2, $3, $4, $5)', [ctx.orgId, d.clientId, ctx.userId, d.body, d.pinned]);
      await logEvent(db, ctx, d.clientId, 'note', 'Internal note added');
    });
    revalidatePath(`/app/clients/${d.clientId}`);
    return { ok: 'Note added.' };
  });
}

export async function togglePinAction(fd: FormData) {
  const ctx = await requireStaff('clients:write');
  const id = parseForm(z.object({ id: zUuid, clientId: zUuid }), fd);
  await ctx.tx((db) => db.run('update public.client_notes set pinned = not pinned where id = $1', [id.id]));
  revalidatePath(`/app/clients/${id.clientId}`);
}

export async function createTaskAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const ctx = await requireStaff('tasks:manage');
  return run(async () => {
    const d = parseForm(
      z.object({
        clientId: zUuid.optional().or(z.literal('')), title: zText(200), detail: zOpt(2000),
        kind: z.enum(['general', 'follow_up', 'document', 'review', 'deadline']).default('general'),
        due: zDate.optional().or(z.literal('')), assigneeId: zUuid.optional().or(z.literal('')),
      }),
      fd,
    );
    await ctx.tx(async (db) => {
      await db.run(
        `insert into public.tasks (org_id, client_id, assignee_id, created_by, title, detail, kind, due_at) values ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [ctx.orgId, d.clientId || null, d.assigneeId || ctx.userId, ctx.userId, d.title, d.detail ?? null, d.kind, d.due ? `${d.due}T17:00:00Z` : null],
      );
      if (d.clientId) await logEvent(db, ctx, d.clientId, 'task', `Task created: ${d.title}`);
    });
    revalidatePath('/app/tasks');
    if (d.clientId) revalidatePath(`/app/clients/${d.clientId}`);
    return { ok: 'Task created.' };
  });
}

export async function setTaskStatusAction(fd: FormData) {
  const ctx = await requireStaff('tasks:manage');
  const d = parseForm(z.object({ id: zUuid, status: z.enum(['open', 'done', 'cancelled']) }), fd);
  await ctx.tx((db) => db.run("update public.tasks set status = $2, completed_at = case when $2 = 'done' then now() else null end where id = $1", [d.id, d.status]));
  revalidatePath('/app/tasks');
  revalidatePath('/app', 'layout');
}

// ---------------------------------------------------------------- messaging
export async function sendMessageAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const ctx = await requireStaff('comms:send');
  return run(async () => {
    const d = parseForm(z.object({ clientId: zUuid, channel: z.enum(['portal', 'email', 'note_call', 'note_sms']), subject: zOpt(200), body: zText(10000) }), fd);
    const client = await ctx.tx((db) => db.row<{ email: string | null; full_name: string }>('select email, full_name from public.clients where id = $1', [d.clientId]));
    if (!client) throw new UserError('Client not found.');
    let note = 'Message sent to the client portal.';
    let status = 'sent';
    let channel: 'portal' | 'email' | 'call' | 'sms' = 'portal';
    let direction: 'outbound' | 'internal' = 'outbound';
    let providerRef: string | null = null;
    if (d.channel === 'email') {
      channel = 'email';
      if (!client.email) throw new UserError('This client has no email address.');
      const r = await sendEmail({ to: client.email, subject: d.subject || `Message from ${ctx.session.orgName}`, text: d.body });
      status = r.provider === 'log' ? 'queued' : r.ok ? 'sent' : 'failed';
      providerRef = r.providerRef ?? null;
      note = r.provider === 'log' ? 'Recorded, but email delivery is not configured so nothing was delivered (set EMAIL_DRIVER=resend).' : r.ok ? 'Email sent.' : `Email failed: ${r.error}`;
    } else if (d.channel === 'note_call' || d.channel === 'note_sms') {
      channel = d.channel === 'note_call' ? 'call' : 'sms';
      direction = 'internal';
      note = `Logged. (Nothing was sent — this records a conversation that happened outside ${PRODUCT.name}.)`;
    }
    await ctx.tx(async (db) => {
      await db.run(
        `insert into public.communications (org_id, client_id, direction, channel, subject, body, status, author_id, approved_by, provider_ref) values ($1, $2, $3, $4, $5, $6, $7, $8, $8, $9)`,
        [ctx.orgId, d.clientId, direction, channel, d.subject ?? null, d.body, status, ctx.userId, providerRef],
      );
      await logEvent(db, ctx, d.clientId, 'message', `${direction === 'internal' ? 'Logged' : 'Sent'} ${channel} message`);
    });
    revalidatePath(`/app/clients/${d.clientId}`);
    return status === 'failed' ? { error: note } : { ok: note };
  });
}

export async function markInboundReadAction(fd: FormData) {
  const ctx = await requireStaff();
  const d = parseForm(z.object({ clientId: zUuid }), fd);
  await ctx.tx((db) => db.run("update public.communications set read_at = now() where client_id = $1 and direction = 'inbound' and read_at is null", [d.clientId]));
  revalidatePath('/app', 'layout');
}

// ---------------------------------------------------------------- documents
export async function uploadDocumentAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const ctx = await requireStaff('clients:write');
  return run(async () => {
    const d = parseForm(z.object({ clientId: zUuid, kind: z.enum(DOC_KINDS) }), fd);
    let up;
    try {
      up = await readUpload(fd.get('file') as File | null, ['application/pdf', 'image/png', 'image/jpeg', 'text/plain', 'text/csv']);
    } catch (e) {
      if (e instanceof UploadError) throw new UserError(e.message);
      throw e;
    }
    const key = await putObject(ctx.orgId, d.clientId, up.bytes);
    try {
      await ctx.tx(async (db) => {
        const doc = await db.row<{ id: string }>(
          `insert into public.documents (org_id, client_id, kind, file_name, mime_type, size_bytes, sha256, storage_key, uploaded_by, source, review_status)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'staff', 'accepted') returning id`,
          [ctx.orgId, d.clientId, d.kind, up.name, up.mime, up.bytes.length, sha256Hex(up.bytes), key, ctx.userId],
        );
        await db.run(
          `update public.document_requests set fulfilled_document_id = $2
            where id = (select id from public.document_requests where client_id = $1 and kind = $3 and fulfilled_document_id is null order by created_at limit 1)`,
          [d.clientId, doc!.id, d.kind],
        );
        await logEvent(db, ctx, d.clientId, 'document', `Document uploaded: ${up.name}`, { kind: d.kind });
        await audit(db, { orgId: ctx.orgId, actorId: ctx.userId, action: 'document.uploaded', entityType: 'document', entityId: doc!.id, ip: ctx.meta.ip, meta: { kind: d.kind, bytes: up.bytes.length } });
      });
    } catch (e) {
      await deleteObject(key).catch(() => undefined);
      throw e;
    }
    revalidatePath(`/app/clients/${d.clientId}`);
    return { ok: `Uploaded ${up.name}.` };
  });
}

export async function requestDocumentAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const ctx = await requireStaff('clients:write');
  return run(async () => {
    const d = parseForm(z.object({ clientId: zUuid, kind: z.enum(DOC_KINDS), note: zOpt(500), due: zDate.optional().or(z.literal('')) }), fd);
    await ctx.tx(async (db) => {
      await db.run('insert into public.document_requests (org_id, client_id, kind, note, due_at, created_by) values ($1, $2, $3, $4, $5, $6)',
        [ctx.orgId, d.clientId, d.kind, d.note ?? null, d.due ? `${d.due}T23:59:00Z` : null, ctx.userId]);
      await logEvent(db, ctx, d.clientId, 'document_requested', `Requested: ${d.kind.replace(/_/g, ' ')}`);
    });
    revalidatePath(`/app/clients/${d.clientId}`);
    return { ok: 'Request added. The client sees it in their portal.' };
  });
}

export async function reviewDocumentAction(fd: FormData) {
  const ctx = await requireStaff('clients:write');
  const d = parseForm(z.object({ id: zUuid, clientId: zUuid, decision: z.enum(['accepted', 'rejected']) }), fd);
  await ctx.tx(async (db) => {
    await db.run('update public.documents set review_status = $2 where id = $1', [d.id, d.decision]);
    await logEvent(db, ctx, d.clientId, 'document_reviewed', `Document ${d.decision}`);
  });
  revalidatePath(`/app/clients/${d.clientId}`);
}

// ---------------------------------------------------------------- consents & portal
export async function recordConsentAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const ctx = await requireStaff('clients:write');
  return run(async () => {
    const d = parseForm(z.object({ clientId: zUuid, kind: z.enum(['croa_disclosure', 'croa_contract', 'fcra_authorization', 'esign', 'communications', 'data_processing']), signedName: zText(160) }), fd);
    await ctx.tx(async (db) => {
      await recordConsent(db, ctx, d.clientId, d.kind, d.signedName);
      await audit(db, { orgId: ctx.orgId, actorId: ctx.userId, action: 'consent.recorded', entityType: 'client', entityId: d.clientId, ip: ctx.meta.ip, meta: { kind: d.kind } });
    });
    revalidatePath(`/app/clients/${d.clientId}`);
    return { ok: 'Consent recorded.' };
  });
}

export async function revokeConsentAction(fd: FormData) {
  const ctx = await requireStaff('clients:write');
  const d = parseForm(z.object({ id: zUuid, clientId: zUuid }), fd);
  await ctx.tx(async (db) => {
    await db.run('update public.client_consents set revoked_at = now() where id = $1 and revoked_at is null', [d.id]);
    await logEvent(db, ctx, d.clientId, 'consent_revoked', 'A consent was revoked');
    await audit(db, { orgId: ctx.orgId, actorId: ctx.userId, action: 'consent.revoked', entityType: 'client', entityId: d.clientId, ip: ctx.meta.ip });
  });
  revalidatePath(`/app/clients/${d.clientId}`);
}

export async function invitePortalAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const ctx = await requireStaff('clients:write');
  return run(async () => {
    const d = parseForm(z.object({ clientId: zUuid }), fd);
    let link = '';
    let to = '';
    let first = '';
    await ctx.tx(async (db) => {
      const c = await db.row<{ email: string | null; full_name: string; portal_user_id: string | null }>('select email, full_name, portal_user_id from public.clients where id = $1', [d.clientId]);
      if (!c) throw new UserError('Client not found.');
      if (c.portal_user_id) throw new UserError('This client already has portal access.');
      if (!c.email) throw new UserError('Add an email address to the client first.');
      to = c.email;
      first = c.full_name.split(' ')[0] ?? '';
      const token = await createInviteToken(db, { orgId: ctx.orgId, email: c.email, role: 'client', clientId: d.clientId, invitedBy: ctx.userId });
      link = `${getEnv().APP_URL}/invite/${token}`;
      await logEvent(db, ctx, d.clientId, 'portal_invited', 'Portal invitation created');
    });
    const signIn = `${getEnv().APP_URL}${ctx.session.orgMode === 'agency' ? portalLoginPath(ctx.session.orgSlug) : '/portal/login'}`;
    const sent = await sendEmail({
      to,
      subject: `${ctx.session.orgName}: your secure client portal`,
      text: `Hello ${first},\n\n${ctx.session.orgName} has set up a secure portal for you. There you can follow each item we work on, upload documents, sign your agreements and message your specialist.\n\nCreate your account (this link expires in 7 days):\n${link}\n\nAfter that, sign in any time at:\n${signIn}\n\nIf you weren't expecting this, you can ignore this email.`,
    });
    return sent.provider === 'log'
      ? { ok: `Email delivery is not configured. Share this one-time link with the client: ${link}` }
      : sent.ok ? { ok: `Invitation emailed to ${to}.` } : { error: `Could not send the email: ${sent.error}` };
  });
}
