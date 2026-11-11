'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import type { ActionState } from '@/components/forms';
import { parseForm, run, UserError, zBool, zDate, zOpt, zText, zUuid } from '@/lib/action';
import { requireStaff, type Ctx } from '@/lib/auth/context';
import { classifyResponse } from '@/lib/ai/assistant';
import { findBlockedClaims } from '@/lib/compliance/claims';
import { createDispute, draftDisputesFromFindings, recordResponse, startNextRound, transitionDispute, addEvidence, type DActor } from '@/lib/disputes/service';
import { CATEGORIES, DISPUTE_STATUSES, FIELD_OPTIONS, OUTCOMES } from '@/lib/disputes/workflow';
import { createLetter } from '@/lib/letters/service';
import { BUREAUS } from '@/lib/util';

const actorOf = (ctx: Ctx): DActor => ({ orgId: ctx.orgId, userId: ctx.userId, role: ctx.role, meta: ctx.meta });

export async function createDisputeAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const ctx = await requireStaff('disputes:write');
  return run(async () => {
    const d = parseForm(
      z.object({
        clientId: zUuid, tradelineId: zUuid.optional().or(z.literal('')), findingId: zUuid.optional().or(z.literal('')), category: z.string().refine((c) => c in CATEGORIES, 'Choose a category'),
        bureau: z.enum(BUREAUS).optional().or(z.literal('')), recipientName: zOpt(160), reason: z.string().trim().min(10, 'Explain the reason (a sentence or two)').max(4000),
        fields: z.union([z.string(), z.array(z.string())]).optional().transform((v) => (v == null ? [] : Array.isArray(v) ? v : [v]).filter((x) => FIELD_OPTIONS.includes(x))),
        makeLetter: zBool,
      }),
      fd,
    );
    const warn = findBlockedClaims(d.reason);
    if (warn.length) throw new UserError(`The reason contains a claim we cannot allow: “${warn[0]!.excerpt}” — ${warn[0]!.why}`);
    let newId = '';
    await ctx.tx(async (db) => {
      newId = await createDispute(db, actorOf(ctx), {
        clientId: d.clientId, tradelineId: d.tradelineId || null, findingId: d.findingId || null, category: d.category, reason: d.reason, fields: d.fields,
        bureau: d.bureau || null, recipientName: d.recipientName,
      });
      if (d.makeLetter) await createLetter(db, actorOf(ctx), { clientId: d.clientId, disputeId: newId, orgName: ctx.session.orgName });
    });
    revalidatePath('/app/disputes');
    redirect(`/app/disputes/${newId}`);
  });
}

export async function transitionAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const ctx = await requireStaff('disputes:write');
  return run(async () => {
    const d = parseForm(
      z.object({
        id: zUuid, to: z.enum(DISPUTE_STATUSES), receivedOn: zDate.optional().or(z.literal('')), extended: zBool,
        sentMethod: z.enum(['certified_mail', 'first_class_mail', 'portal', 'manual']).optional(), tracking: zOpt(80), note: zOpt(2000),
      }),
      fd,
    );
    await ctx.tx((db) => transitionDispute(db, actorOf(ctx), d.id, d.to, { receivedOn: d.receivedOn || null, extended: d.extended, sentMethod: d.sentMethod, tracking: d.tracking, note: d.note }));
    revalidatePath(`/app/disputes/${d.id}`);
    revalidatePath('/app/disputes');
    return { ok: 'Status updated.' };
  });
}

export async function recordResponseAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const ctx = await requireStaff('disputes:write');
  return run(async () => {
    const d = parseForm(z.object({ id: zUuid, outcome: z.enum(OUTCOMES), notes: zOpt(4000), receivedOn: zDate.optional().or(z.literal('')) }), fd);
    await ctx.tx((db) => recordResponse(db, actorOf(ctx), d.id, { outcome: d.outcome, notes: d.notes, receivedOn: d.receivedOn || undefined }));
    revalidatePath(`/app/disputes/${d.id}`);
    return { ok: 'Response recorded.' };
  });
}

/** Reads a pasted bureau reply and SUGGESTS an outcome. It records nothing — a person chooses. */
export async function analyzeReplyAction(_: ActionState, fd: FormData): Promise<ActionState> {
  await requireStaff('disputes:write');
  return run(async () => {
    const d = parseForm(z.object({ reply: zText(10000) }), fd);
    const r = classifyResponse(d.reply);
    return { ok: `${r.summary}${r.outcome ? ` Suggested outcome: ${r.outcome.replace(/_/g, ' ')}.` : ''} Choose the outcome yourself below.` };
  });
}

export async function nextRoundAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const ctx = await requireStaff('disputes:write');
  return run(async () => {
    const d = parseForm(z.object({ id: zUuid, reason: zText(4000), newInformation: zText(2000) }), fd);
    const warn = findBlockedClaims(`${d.reason} ${d.newInformation}`);
    if (warn.length) throw new UserError(`Contains a claim we cannot allow: “${warn[0]!.excerpt}” — ${warn[0]!.why}`);
    let newId = '';
    await ctx.tx(async (db) => {
      newId = await startNextRound(db, actorOf(ctx), d.id, { reason: d.reason, newInformation: d.newInformation });
    });
    redirect(`/app/disputes/${newId}`);
  });
}

export async function addEvidenceAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const ctx = await requireStaff('disputes:write');
  return run(async () => {
    const d = parseForm(z.object({ id: zUuid, documentId: zUuid.optional().or(z.literal('')), label: zText(200), note: zOpt(1000) }), fd);
    await ctx.tx((db) => addEvidence(db, actorOf(ctx), d.id, { documentId: d.documentId || null, label: d.label, note: d.note }));
    revalidatePath(`/app/disputes/${d.id}`);
    return { ok: 'Evidence added.' };
  });
}

export async function assignDisputeAction(fd: FormData) {
  const ctx = await requireStaff('disputes:write');
  const d = parseForm(z.object({ id: zUuid, assignee: zUuid.optional().or(z.literal('')) }), fd);
  await ctx.tx((db) => db.run('update public.disputes set assigned_to = $2 where id = $1', [d.id, d.assignee || null]));
  revalidatePath(`/app/disputes/${d.id}`);
}

export async function addFollowUpTaskAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const ctx = await requireStaff('tasks:manage');
  return run(async () => {
    const d = parseForm(z.object({ id: zUuid, title: zText(200), due: zDate.optional().or(z.literal('')) }), fd);
    await ctx.tx(async (db) => {
      const x = await db.row<{ client_id: string; assigned_to: string | null }>('select client_id, assigned_to from public.disputes where id = $1', [d.id]);
      if (!x) throw new UserError('Dispute not found.');
      await db.run(`insert into public.tasks (org_id, client_id, dispute_id, assignee_id, created_by, title, kind, due_at) values ($1,$2,$3,$4,$5,$6,'follow_up',$7)`,
        [ctx.orgId, x.client_id, d.id, x.assigned_to ?? ctx.userId, ctx.userId, d.title, d.due ? `${d.due}T17:00:00Z` : null]);
    });
    revalidatePath(`/app/disputes/${d.id}`);
    return { ok: 'Follow-up task created.' };
  });
}

/** Drafts a dispute for each ticked finding on the comparison page. Every draft still goes through review and approval. */
export async function bulkDraftAction(fd: FormData) {
  const ctx = await requireStaff('disputes:write');
  const d = parseForm(z.object({
    clientId: zUuid,
    finding: z.union([zUuid, z.array(zUuid)]).optional().transform((v) => (v == null ? [] : Array.isArray(v) ? v : [v])),
  }), fd);
  const back = `/app/clients/${d.clientId}/compare`;
  if (d.finding.length === 0) redirect(`${back}?bulk=none#findings`);
  let q = '';
  try {
    const r = await ctx.tx((db) => draftDisputesFromFindings(db, actorOf(ctx), d.clientId, d.finding));
    q = `drafted=${r.created.length}&skipped=${r.skipped.length}${r.skipped[0] ? `&why=${encodeURIComponent(r.skipped[0].why)}` : ''}`;
  } catch (e) {
    if (!(e instanceof UserError)) throw e;
    q = `bulk=error&why=${encodeURIComponent(e.message)}`;
  }
  revalidatePath('/app/disputes');
  revalidatePath(back);
  redirect(`${back}?${q}#findings`);
}
