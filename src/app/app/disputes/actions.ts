'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import type { ActionState } from '@/components/forms';
import { parseForm, run, UserError, zBool, zDate, zOpt, zText, zUuid } from '@/lib/action';
import { requireStaff, type Ctx } from '@/lib/auth/context';
import { classifyResponse } from '@/lib/ai/assistant';
import { findBlockedClaims } from '@/lib/compliance/claims';
import { createDispute, createSpecialtyDispute, draftDisputesFromFindings, recordResponse, startNextRound, transitionDispute, addEvidence, type DActor } from '@/lib/disputes/service';
import { CATEGORIES, DISPUTE_STATUSES, FIELD_OPTIONS, mustNameAccount, OUTCOMES, typedItemLabel } from '@/lib/disputes/workflow';
import { confirmIdentityDocs } from '@/lib/intake-load';
import { createLetter, LetterError } from '@/lib/letters/service';
import type { Db } from '@/lib/db';
import { autoTailorDraft } from '@/lib/letters/tailor-load';
import { BUREAUS } from '@/lib/util';
import { SPECIALTY_KEYS } from '@/lib/credit/agencies';

const actorOf = (ctx: Ctx): DActor => ({ orgId: ctx.orgId, userId: ctx.userId, role: ctx.role, meta: ctx.meta });

/**
 * "Also draft the letter" for a dispute created a moment ago in the same transaction. When the letter cannot be
 * drafted yet (a fact it rests on is not on file) the dispute is kept and '' comes back: the dispute page then names
 * what is missing under "Recommended letter". Losing the dispute the person just typed would help nobody.
 */
async function draftFirstLetter(db: Db, ctx: Ctx, clientId: string, disputeId: string): Promise<string> {
  await db.run('savepoint first_letter');
  try {
    const id = await createLetter(db, actorOf(ctx), { clientId, disputeId, orgName: ctx.session.orgName });
    await db.run('release savepoint first_letter');
    return id;
  } catch (e) {
    await db.run('rollback to savepoint first_letter');
    if (e instanceof LetterError) return '';
    throw e;
  }
}

export async function createDisputeAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const ctx = await requireStaff('disputes:write');
  return run(async () => {
    const d = parseForm(
      z.object({
        clientId: zUuid, tradelineId: zUuid.optional().or(z.literal('')), findingId: zUuid.optional().or(z.literal('')), category: z.string().refine((c) => c in CATEGORIES, 'Choose a category'),
        bureau: z.enum(BUREAUS).optional().or(z.literal('')), recipientName: zOpt(160), reason: z.string().trim().min(10, 'Explain the reason (a sentence or two)').max(4000),
        fields: z.union([z.string(), z.array(z.string())]).optional().transform((v) => (v == null ? [] : Array.isArray(v) ? v : [v]).filter((x) => FIELD_OPTIONS.includes(x))),
        // An account that is not on an imported report, named by hand. Only the last digits are taken: a full account number is never stored.
        accountName: zOpt(100),
        accountLast4: z.union([z.string().trim().regex(/^[0-9A-Za-z]{2,4}$/, 'Enter only the last 2 to 4 characters of the account number'), z.literal('')]).optional(),
        makeLetter: zBool,
      }),
      fd,
    );
    const warn = findBlockedClaims(d.reason);
    if (warn.length) throw new UserError(`The reason contains a claim we cannot allow: “${warn[0]!.excerpt}” — ${warn[0]!.why}`);
    // The company the account is with: typed for a bureau dispute, and for a letter to a creditor or collector the company it goes to.
    const accountWith = d.accountName || (CATEGORIES[d.category]!.target !== 'bureau' ? d.recipientName : undefined);
    // A bureau dispute about an account that is on no report has to name it: the letter would otherwise read “Item: Item”.
    if (mustNameAccount(d.category, !!d.tradelineId) && !d.accountName) throw new UserError('Name the account: enter the creditor or collector as the client’s report or statement shows it.');
    if (d.accountLast4 && !accountWith) throw new UserError('Enter the name of the creditor or collector the account is with.');
    let newId = '';
    let letterId = '';
    await ctx.tx(async (db) => {
      newId = await createDispute(db, actorOf(ctx), {
        clientId: d.clientId, tradelineId: d.tradelineId || null, findingId: d.findingId || null, category: d.category, reason: d.reason, fields: d.fields,
        bureau: d.bureau || null, recipientName: d.recipientName,
        itemLabel: typedItemLabel({ category: d.category, hasReportAccount: !!d.tradelineId, accountName: d.accountName, accountLast4: d.accountLast4, recipientName: d.recipientName }),
      });
      if (d.makeLetter) letterId = await draftFirstLetter(db, ctx, d.clientId, newId);
    });
    // Only when the agency turned it on (off by default): the AI wording step, saved as a new draft version.
    if (letterId) await autoTailorDraft(actorOf(ctx), letterId, ctx.tx);
    revalidatePath('/app/disputes');
    redirect(`/app/disputes/${newId}`);
  });
}

/** A specialty agency item (ChexSystems, LexisNexis, ...) typed in by a person from the consumer's disclosure. Same pipeline as any dispute. */
export async function createSpecialtyDisputeAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const ctx = await requireStaff('disputes:write');
  return run(async () => {
    const d = parseForm(
      z.object({
        clientId: zUuid, agency: z.string().refine((a) => SPECIALTY_KEYS.includes(a), 'Choose the reporting agency'),
        itemName: zText(160), itemReference: zOpt(60), itemDate: zOpt(40), itemAmount: zOpt(40), consumerId: zOpt(60),
        reason: z.string().trim().min(10, 'Explain what is inaccurate, incomplete or unverifiable, and why').max(4000),
        recipientAddress: zOpt(400), makeLetter: zBool,
      }),
      fd,
    );
    const warn = findBlockedClaims(d.reason);
    if (warn.length) throw new UserError(`The reason contains a claim we cannot allow: “${warn[0]!.excerpt}” — ${warn[0]!.why}`);
    let newId = '';
    let letterId = '';
    await ctx.tx(async (db) => {
      newId = await createSpecialtyDispute(db, actorOf(ctx), {
        clientId: d.clientId, agency: d.agency, reason: d.reason, recipientAddress: d.recipientAddress,
        item: { name: d.itemName, reference: d.itemReference, date: d.itemDate, amount: d.itemAmount, consumerId: d.consumerId },
      });
      if (d.makeLetter) letterId = await draftFirstLetter(db, ctx, d.clientId, newId);
    });
    if (letterId) await autoTailorDraft(actorOf(ctx), letterId, ctx.tx);
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
        sentMethod: z.enum(['certified_mail', 'first_class_mail', 'portal', 'manual']).optional(), tracking: zOpt(80), sentOn: zDate.optional().or(z.literal('')), note: zOpt(2000), sendAnyway: zBool,
      }),
      fd,
    );
    await ctx.tx(async (db) => {
      // A warning that needs an explicit yes, not a gate: the bureau or agency may ask for identity documents that are not on file.
      if (d.to === 'submitted') await confirmIdentityDocs(db, ctx, d.id, d.sendAnyway);
      await transitionDispute(db, actorOf(ctx), d.id, d.to, { receivedOn: d.receivedOn || null, extended: d.extended, sentMethod: d.sentMethod, tracking: d.tracking, sentOn: d.sentOn || null, note: d.note });
    });
    revalidatePath(`/app/disputes/${d.id}`);
    revalidatePath('/app/disputes');
    return { ok: 'Status updated.' };
  });
}

export async function recordResponseAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const ctx = await requireStaff('disputes:write');
  return run(async () => {
    // A "frivolous or irrelevant" notice has its own form (frivolousNoticeAction): it must say what the agency asked for.
    const d = parseForm(z.object({ id: zUuid, outcome: z.enum(OUTCOMES).exclude(['frivolous']), notes: zOpt(4000), receivedOn: zDate.optional().or(z.literal('')), completedOn: zDate.optional().or(z.literal('')) }), fd);
    await ctx.tx((db) => recordResponse(db, actorOf(ctx), d.id, { outcome: d.outcome, notes: d.notes, receivedOn: d.receivedOn || undefined, completedOn: d.completedOn || undefined }));
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
    // Each different reason a finding was skipped for is shown, not only the first: one may say to start it by hand.
    // (Up to four, so the address stays short; the count of skipped findings is always the full number.)
    const reasons = [...new Set(r.skipped.map((x) => x.why))].slice(0, 4);
    q = `drafted=${r.created.length}&skipped=${r.skipped.length}${reasons.length ? `&why=${encodeURIComponent(reasons.join(' '))}` : ''}`;
  } catch (e) {
    if (!(e instanceof UserError)) throw e;
    q = `bulk=error&why=${encodeURIComponent(e.message)}`;
  }
  revalidatePath('/app/disputes');
  revalidatePath(back);
  redirect(`${back}?${q}#findings`);
}
