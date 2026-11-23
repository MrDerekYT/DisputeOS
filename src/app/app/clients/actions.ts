'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import type { ActionState } from '@/components/forms';
import { parseForm, run, UserError, zBool, zDate, zOpt, zText, zUuid } from '@/lib/action';
import { audit } from '@/lib/audit';
import { loadDisputeCounts, polishedProgress } from '@/lib/ai/assistant';
import { AI_OFF, notChargedNote, withAiCredits } from '@/lib/ai/credits';
import { requireStaff } from '@/lib/auth/context';
import { createInviteToken } from '@/lib/auth/service';
import { fireTrigger } from '@/lib/automation/engine';
import { AgreementError, deletionBlock, notReadyMessage, signAgreement } from '@/lib/agreements';
import { clientTermsIssue, dollars, parseDollars } from '@/lib/compliance/agreement-terms';
import { CONSENT_KINDS, type ConsentKind } from '@/lib/compliance/disclosures';
import { staffReportRefusal } from '@/lib/credit/authorization';
import { DOC_KINDS, CLIENT_STAGES, CLIENT_STATUSES, logEvent } from '@/lib/crm';
import { intakeSummary } from '@/lib/intake';
import { loadIntake } from '@/lib/intake-load';
import { encryptPII } from '@/lib/crypto';
import { getEnv } from '@/lib/env';
import { delivers, sendEmail } from '@/lib/mailer';
import { deleteObject, putObject } from '@/lib/storage';
import { readUpload, UploadError } from '@/lib/upload';
import { sha256Hex } from '@/lib/crypto';
import { PRODUCT } from '@/lib/product';
import { dayBucket, hourBucket, queueClientUpdate } from '@/lib/client-updates/service';
import { isRealDay } from '@/lib/real-day';
import { holdUnapprovedEmail } from '@/lib/staff-email';
import { expireWelcomeLinks, portalSignInUrl, welcomeEmail, welcomeEmailIssue } from '@/lib/welcome-link';
import { emailWelcomeLinkAction } from './welcome-actions';

/** What staff are told when the email service gave no answer: the email may have gone out, so it is not simply "failed". */
const UNANSWERED = 'The email service did not answer, so it may or may not have arrived.';

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
  // A day that exists: 2000-02-31 would otherwise be stored and printed in bureau letters as 2 March 2000.
  dob: zDate.refine(isRealDay, 'Enter a real date of birth').optional().or(z.literal('')),
  ssn: z.string().trim().regex(/^(\d{3}-?\d{2}-?\d{4})?$/, 'SSN must be 9 digits').optional(),
  assignedTo: zUuid.optional().or(z.literal('')),
  tags: zOpt(200),
};

function addressOf(d: { line1?: string; line2?: string; city?: string; state?: string; zip?: string }) {
  return { line1: d.line1 ?? '', line2: d.line2 ?? '', city: d.city ?? '', state: d.state ?? '', zip: d.zip ?? '' };
}
const tagsOf = (t?: string) => (t ? t.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean).slice(0, 10) : []);

type StaffCtx = Awaited<ReturnType<typeof requireStaff>>;
type TxDb = Parameters<Parameters<StaffCtx['tx']>[0]>[0];

/**
 * A signature the client gave on paper, recorded by staff, with the date written on the paper. It stores the app's
 * text of the document on the recording day (with its hash), dated with the date on the paper, not a copy of the paper,
 * and the staff member who recorded it; the order rule and the need for saved agreement terms apply as they do in the
 * portal (src/lib/agreements.ts), except that paper needs no consent to electronic records (staff never record that one).
 * In a personal workspace it is the account holder's own consent, given in the app that day: no paper and no paper date.
 * The refusal while the agency's terms are not saved says who can save them, and on New client how to go on without.
 */
async function recordConsent(db: TxDb, ctx: StaffCtx, clientId: string, kind: ConsentKind, signedName: string, paperSignedOn: string | undefined, onNewClient = false) {
  try {
    const { rendered, source, signedOn } = await signAgreement(db, { orgId: ctx.orgId, clientId, userId: ctx.userId, ip: ctx.meta.ip, userAgent: ctx.meta.userAgent, by: 'staff' }, { kind, signedName, lang: 'en', paperSignedOn });
    if (source === 'self') await logEvent(db, ctx, clientId, 'consent', `${rendered.doc.title} given by the account holder`, { kind });
    else await logEvent(db, ctx, clientId, 'consent', `${rendered.doc.title} recorded (signed on paper on ${signedOn})`, { kind, paper_signed_on: signedOn });
  } catch (e) {
    if (e instanceof AgreementError && e.code === 'not_ready') throw new UserError(notReadyMessage(ctx.can('settings:manage'), onNewClient));
    throw e;
  }
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
        // The date written on the signed paper (checked in src/lib/agreements.ts: a real day, not in the future, not over a year back).
        paperSignedOn: zOpt(10),
        invite: zBool,
      }),
      fd,
    );
    // Recorded in signing order, so ticking all three works; a later one ticked without the one before it is refused.
    const consents: ConsentKind[] = [];
    if (d.consentDisclosure) consents.push('croa_disclosure');
    if (d.consentContract) consents.push('croa_contract');
    if (d.consentAuthorization) consents.push('fcra_authorization');
    if (consents.length && !d.signedName) throw new UserError('Enter the name the client signed with to record consents.');
    if (consents.length && !d.paperSignedOn) throw new UserError('Enter the date written on the signed paper to record consents.');
    if (d.invite && !d.email) throw new UserError('An email address is required to invite the client to the portal.');
    if (d.assignedTo && !ctx.can('clients:assign') && d.assignedTo !== ctx.userId) throw new UserError('You can only assign clients to yourself.');
    if (d.invite && d.email) await holdUnapprovedEmail(ctx);

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
      try {
        for (const k of consents) await recordConsent(db, ctx, newId, k, d.signedName!, d.paperSignedOn, true);
      } catch (e) {
        if (e instanceof AgreementError && e.code === 'order') throw new UserError('Tick the Consumer Credit File Rights disclosure before the service agreement, and the service agreement before the authorization: they are signed in that order.');
        throw e;
      }
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
      const mail = welcomeEmail({ lang: d.preferredLanguage, fullName: d.fullName, orgName: ctx.session.orgName, link: inviteLink, signIn: portalSignInUrl({ mode: ctx.session.orgMode, slug: ctx.session.orgSlug }, d.preferredLanguage) });
      const issue = welcomeEmailIssue(mail);
      if (issue) return { ok: `Client created, but the invitation email was not sent: ${issue}. Share this one-time invitation link with the client instead: ${inviteLink} — then open the client from the Clients list.` };
      const replyTo = await ctx.tx((db) => db.row<{ r: string | null }>("select nullif(trim(settings->>'lead_reply_email'), '') as r from public.organizations where id = $1", [ctx.orgId]));
      const sent = await sendEmail({ to: d.email, ...mail, fromName: ctx.session.orgName, ...(replyTo?.r ? { replyTo: replyTo.r } : {}) });
      if (!delivers(sent)) {
        return { ok: `Client created, but email delivery is not configured. Share this one-time invitation link with the client: ${inviteLink} — then open the client from the Clients list.` };
      }
      // Not an error state: the client exists, so the form must not invite a second submission.
      if (!sent.ok) {
        if (sent.unconfirmed) return { ok: `Client created. ${UNANSWERED} Ask the client before sending the invitation again; the link to share is: ${inviteLink} — then open the client from the Clients list.` };
        return { ok: `Client created, but the invitation email could not be sent (${sent.error ?? 'delivery failed'}). Share this one-time invitation link with the client instead: ${inviteLink} — then open the client from the Clients list.` };
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
    let linksEnded = 0;
    await ctx.tx(async (db) => {
      const before = await db.row<{ status: string; stage: string; assigned_to: string | null; email: string | null }>('select status, stage, assigned_to, email from public.clients where id = $1', [d.id]);
      if (!before) throw new UserError('Client not found.');
      // A welcome link sent to the old (perhaps mistyped) address must not stay usable once the email changes or is
      // cleared: whoever reads that mailbox could otherwise become this client's portal account. The client is sent a
      // new link to the new address. Same transaction, so the change and the end of the old links go together.
      const was = (before.email ?? '').trim().toLowerCase();
      if (was !== (d.email ?? '')) {
        linksEnded = await expireWelcomeLinks(db, d.id);
        if (linksEnded) await logEvent(db, ctx, d.id, 'portal_invite_ended', 'Unused welcome link ended because the client’s email changed');
      }
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
      await audit(db, { orgId: ctx.orgId, actorId: ctx.userId, action: 'client.updated', entityType: 'client', entityId: d.id, ip: ctx.meta.ip, meta: { fields: 'profile', ssn_changed: !!ssn, welcome_links_ended: linksEnded } });
    });
    revalidatePath(`/app/clients/${d.id}`);
    return { ok: linksEnded ? 'Client updated. The welcome link sent to the old email no longer works: send a new one from the client page.' : 'Client updated.' };
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
      // 15 U.S.C. § 1679c(c): the signed Consumer Credit File Rights statement is kept 2 years (the database holds the same rule).
      const keep = await deletionBlock(db, d.id);
      if (keep) throw new UserError(keep);
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
/**
 * Paid AI polish of the progress note. The note is rebuilt on the server from the dispute data (nothing typed in the
 * browser is sent to the model), and credits are charged only when polished wording is returned. Nothing is saved or sent.
 */
export async function polishProgressAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const ctx = await requireStaff('comms:send');
  return run(async () => {
    const d = parseForm(z.object({ clientId: zUuid }), fd);
    const loaded = await ctx.tx(async (db) => ({
      client: await db.row<{ full_name: string; preferred_language: 'en' | 'es' }>('select full_name, preferred_language from public.clients where id = $1', [d.clientId]),
      counts: await loadDisputeCounts(db, d.clientId),
    }));
    if (!loaded.client || !loaded.counts) throw new UserError('Client not found.');
    const stats = { firstName: loaded.client.full_name.split(' ')[0] ?? '', language: loaded.client.preferred_language, ...loaded.counts };
    const { result, ai } = await withAiCredits({ orgId: ctx.orgId, feature: 'progress_note', actorUserId: ctx.userId }, (p) => polishedProgress(stats, p));
    revalidatePath(`/app/clients/${d.clientId}`);
    if (result.usedAi && ai.status === 'charged') return { ok: `Wording polished by ${result.provider} (${ai.cost} AI credits used); the numbers are verified unchanged. Read it before you send it.`, data: { text: result.text } };
    if (ai.status === 'no_provider' || ai.status === 'no_credits') return { error: `${AI_OFF[ai.status]} The draft is unchanged.` };
    return { error: `${result.note ?? 'The AI wording was not safe to use.'} The draft is unchanged. ${notChargedNote(ai)}` };
  });
}

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
      await holdUnapprovedEmail(ctx);
      const r = await sendEmail({ to: client.email, subject: d.subject || `Message from ${ctx.session.orgName}`, text: d.body });
      status = !delivers(r) ? 'queued' : r.ok ? 'sent' : 'failed';
      providerRef = r.providerRef ?? null;
      note = !delivers(r) ? 'Recorded, but email is not connected so nothing was delivered.' : r.ok ? 'Email sent.' : r.unconfirmed ? `${UNANSWERED} Check with the client before sending it again.` : `Email failed: ${r.error}`;
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
      // A reply that actually went out answers the client's messages, so they stop counting as unread.
      if (direction === 'outbound' && status !== 'failed') await db.run("update public.communications set read_at = now() where client_id = $1 and direction = 'inbound' and read_at is null", [d.clientId]);
      await logEvent(db, ctx, d.clientId, 'message', `${direction === 'internal' ? 'Logged' : 'Sent'} ${channel} message`);
      if (channel === 'portal') await queueClientUpdate(db, { orgId: ctx.orgId, clientId: d.clientId, event: 'team_message', subjectId: hourBucket() });
    });
    revalidatePath(`/app/clients/${d.clientId}`);
    revalidatePath('/app', 'layout');
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
    // A credit report staff add needs the client's written authorization on file (src/lib/credit/authorization.ts).
    const isReport = d.kind === 'credit_report';
    if (isReport) { const refused = await ctx.tx((db) => staffReportRefusal(db, d.clientId)); if (refused) throw new UserError(refused); }
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
        if (isReport) { const again = await staffReportRefusal(db, d.clientId); if (again) throw new UserError(again); }
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
      await queueClientUpdate(db, { orgId: ctx.orgId, clientId: d.clientId, event: 'document_needed', subjectId: dayBucket() });
    });
    revalidatePath(`/app/clients/${d.clientId}`);
    return { ok: 'Request added. The client sees it in their portal.' };
  });
}

export async function reviewDocumentAction(fd: FormData) {
  const ctx = await requireStaff('clients:write');
  // `reason` is shown to the client when a document is rejected. The two dates are optional and only ever come from
  // what the reviewer read on the document: the date printed on a proof of address, and the expiry of an ID.
  const d = parseForm(z.object({ id: zUuid, clientId: zUuid, decision: z.enum(['accepted', 'rejected']), reason: zOpt(300), docDate: zDate.optional().or(z.literal('')), expiresOn: zDate.optional().or(z.literal('')) }), fd);
  await ctx.tx(async (db) => {
    await db.run('update public.documents set review_status = $2, review_note = $3, doc_date = coalesce($4::date, doc_date), expires_on = coalesce($5::date, expires_on) where id = $1 and client_id = $6',
      [d.id, d.decision, d.decision === 'rejected' ? d.reason ?? null : null, d.docDate || null, d.expiresOn || null, d.clientId]);
    await logEvent(db, ctx, d.clientId, 'document_reviewed', `Document ${d.decision}`);
    if (d.decision === 'rejected') await queueClientUpdate(db, { orgId: ctx.orgId, clientId: d.clientId, event: 'document_rejected', subjectId: d.id });
  });
  revalidatePath(`/app/clients/${d.clientId}`);
}

/**
 * One click: a portal request for every required identity document the client still has to send (missing, rejected,
 * expired or no longer recent) that is not already requested. Uses the ordinary document requests, so the client sees
 * them on their portal home and an upload of that kind fulfils them. No email is sent from here.
 */
export async function requestMissingIntakeAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const ctx = await requireStaff('clients:write');
  return run(async () => {
    const d = parseForm(z.object({ clientId: zUuid }), fd);
    const out = await ctx.tx(async (db) => {
      const c = await db.row<{ preferred_language: string; portal_user_id: string | null }>('select preferred_language, portal_user_id from public.clients where id = $1', [d.clientId]);
      if (!c) throw new UserError('Client not found.');
      const needed = intakeSummary(await loadIntake(db, d.clientId)).needed;
      const open = await db.rows<{ kind: string }>('select kind from public.document_requests where client_id = $1 and fulfilled_document_id is null', [d.clientId]);
      const toAsk = needed.filter((n) => !open.some((o) => o.kind === n.item.key));
      const lang = c.preferred_language === 'es' ? 'es' : 'en';
      for (const n of toAsk) {
        await db.run('insert into public.document_requests (org_id, client_id, kind, note, created_by) values ($1, $2, $3, $4, $5)', [ctx.orgId, d.clientId, n.item.key, n.item.accepts[lang], ctx.userId]);
      }
      if (toAsk.length) await logEvent(db, ctx, d.clientId, 'document_requested', `Requested identity documents: ${toAsk.map((n) => n.item.label.en).join(', ')}`);
      if (toAsk.length) await queueClientUpdate(db, { orgId: ctx.orgId, clientId: d.clientId, event: 'document_needed', subjectId: dayBucket() });
      return { asked: toAsk.map((n) => n.item.label.en), already: needed.length - toAsk.length, nothing: needed.length === 0, portal: !!c.portal_user_id };
    });
    revalidatePath(`/app/clients/${d.clientId}`);
    if (out.nothing) return { ok: 'Nothing to ask for: every required identity document is uploaded or accepted.' };
    const where = out.portal ? 'The client sees this in their portal.' : 'The client has no portal login yet, so they will see it once you invite them.';
    if (out.asked.length === 0) return { ok: `Already requested. ${where} No email was sent.` };
    return { ok: `Requested: ${out.asked.join(', ')}. ${where} No email was sent.` };
  });
}

// ---------------------------------------------------------------- consents & portal
export async function recordConsentAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const ctx = await requireStaff('clients:write');
  return run(async () => {
    // Every kind is accepted here and judged in signAgreement, which refuses the consent to electronic records (the
    // client gives that one in the portal) and, in a personal workspace, the two CROA documents.
    const d = parseForm(z.object({ clientId: zUuid, kind: z.enum(CONSENT_KINDS), signedName: zText(160), paperSignedOn: zOpt(10) }), fd);
    // In a personal workspace there is no paper: the account holder gives their own consent (signAgreement ignores a date).
    const personal = ctx.session.orgMode === 'personal';
    await ctx.tx(async (db) => {
      await recordConsent(db, ctx, d.clientId, d.kind, d.signedName, personal ? undefined : d.paperSignedOn);
      await audit(db, { orgId: ctx.orgId, actorId: ctx.userId, action: 'consent.recorded', entityType: 'client', entityId: d.clientId, ip: ctx.meta.ip, meta: { kind: d.kind, paper_signed_on: personal ? null : d.paperSignedOn ?? null } });
    });
    revalidatePath(`/app/clients/${d.clientId}`);
    return { ok: 'Consent recorded.' };
  });
}

export async function revokeConsentAction(fd: FormData) {
  const ctx = await requireStaff('clients:write');
  const d = parseForm(z.object({ id: zUuid, clientId: zUuid }), fd);
  await ctx.tx(async (db) => {
    // revoked_reason tells the client's portal and the staff pages that staff, not the client, revoked it.
    await db.run("update public.client_consents set revoked_at = now(), revoked_reason = 'staff' where id = $1 and revoked_at is null", [d.id]);
    await logEvent(db, ctx, d.clientId, 'consent_revoked', 'A consent was revoked');
    await audit(db, { orgId: ctx.orgId, actorId: ctx.userId, action: 'consent.revoked', entityType: 'client', entityId: d.clientId, ip: ctx.meta.ip });
  });
  revalidatePath(`/app/clients/${d.clientId}`);
}

// ---------------------------------------------------------------- this client's own payment terms (15 U.S.C. § 1679d(b)(1))
const TERMS_LOCKED = 'This client has a service agreement in force, signed with the payment terms and total shown. They cannot be changed while it is in force: revoke it first, then the client signs a new one with the new figures.';

/** Holds the client row for the change and says whether a service agreement is in force (the database refuses the change then, too). */
async function lockForTerms(db: TxDb, clientId: string): Promise<boolean> {
  if (!(await db.row('select id from public.clients where id = $1 for update', [clientId]))) throw new UserError('Client not found.');
  return !!(await db.row("select 1 from public.client_consents where client_id = $1 and kind = 'croa_contract' and revoked_at is null", [clientId]));
}

/**
 * This client's own payment terms and total of all payments, for an agency with several plans: the service agreement
 * the client signs states these instead of the agency's (Settings → Client agreement). Checked as the agency's payment
 * terms are (no promise of a result, no payment asked for before the work is done); refused while a service agreement
 * is in force, so the figures on file are the ones that agreement was signed with. Owners, admins and managers, who set
 * up the client's billing.
 */
export async function saveClientTermsAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const ctx = await requireStaff('billing:write');
  return run(async () => {
    if (ctx.session.orgMode === 'personal') throw new UserError('A personal workspace has no service agreement.');
    const d = parseForm(z.object({ clientId: zUuid, paymentTerms: z.string().trim().max(2000), total: z.string().trim().max(20) }), fd);
    const totalCents = parseDollars(d.total);
    if (totalCents === null) throw new UserError('Total of all payments: enter the amount in dollars, for example 594.00.');
    const terms = { paymentTerms: d.paymentTerms, totalCents };
    const issue = clientTermsIssue(terms);
    if (issue) throw new UserError(issue);
    await ctx.tx(async (db) => {
      if (await lockForTerms(db, d.clientId)) throw new UserError(TERMS_LOCKED);
      await db.run('update public.clients set agreement_payment_terms = $2, agreement_total_cents = $3 where id = $1', [d.clientId, terms.paymentTerms, totalCents]);
      await logEvent(db, ctx, d.clientId, 'agreement_terms', `Own payment terms set for the service agreement (total of all payments ${dollars(totalCents)})`, { total_cents: totalCents });
      await audit(db, { orgId: ctx.orgId, actorId: ctx.userId, action: 'client.agreement_terms_set', entityType: 'client', entityId: d.clientId, ip: ctx.meta.ip, meta: { total_cents: totalCents } });
    });
    revalidatePath(`/app/clients/${d.clientId}`);
    return { ok: `Saved. This client’s service agreement will state these payment terms and a total of all payments of ${dollars(totalCents)}.` };
  });
}

/** Back to the agency's payment terms and total for this client (before they sign). */
export async function clearClientTermsAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const ctx = await requireStaff('billing:write');
  return run(async () => {
    const d = parseForm(z.object({ clientId: zUuid }), fd);
    await ctx.tx(async (db) => {
      if (await lockForTerms(db, d.clientId)) throw new UserError(TERMS_LOCKED);
      await db.run('update public.clients set agreement_payment_terms = null, agreement_total_cents = null where id = $1', [d.clientId]);
      await logEvent(db, ctx, d.clientId, 'agreement_terms', 'Own payment terms removed: the service agreement uses the agency’s terms');
      await audit(db, { orgId: ctx.orgId, actorId: ctx.userId, action: 'client.agreement_terms_cleared', entityType: 'client', entityId: d.clientId, ip: ctx.meta.ip });
    });
    revalidatePath(`/app/clients/${d.clientId}`);
    return { ok: 'This client’s service agreement will use your agency’s payment terms and total (Settings → Client agreement).' };
  });
}

/** The portal invitation by email: the welcome link (./welcome-actions.ts). Kept under this name for existing callers. */
export async function invitePortalAction(prev: ActionState, fd: FormData): Promise<ActionState> {
  return emailWelcomeLinkAction(prev, fd);
}

// ---------------------------------------------------------------- status and stage
/** "Status and stage" on the client page: a person's choice, which the automatic updates then leave alone. */
export async function setProgressAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const ctx = await requireStaff('clients:write');
  return run(async () => {
    const d = parseForm(z.object({ clientId: zUuid, status: z.enum(CLIENT_STATUSES), stage: z.enum(CLIENT_STAGES) }), fd);
    await ctx.tx(async (db) => {
      const before = await db.row<{ status: string; stage: string }>('select status, stage from public.clients where id = $1', [d.clientId]);
      if (!before) throw new UserError('Client not found.');
      await db.run('update public.clients set status = $2, stage = $3 where id = $1', [d.clientId, d.status, d.stage]);
      if (before.status !== d.status) await logEvent(db, ctx, d.clientId, 'status_changed', `Status changed: ${before.status} → ${d.status}`);
      if (before.stage !== d.stage) await logEvent(db, ctx, d.clientId, 'stage_changed', `Stage changed: ${before.stage} → ${d.stage}`);
      await audit(db, { orgId: ctx.orgId, actorId: ctx.userId, action: 'client.updated', entityType: 'client', entityId: d.clientId, ip: ctx.meta.ip, meta: { fields: 'progress' } });
    });
    revalidatePath(`/app/clients/${d.clientId}`);
    return { ok: 'Saved.' };
  });
}
