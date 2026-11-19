'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import type { ActionState } from '@/components/forms';
import { parseForm, run, UserError, zBool, zDate, zText, zUuid } from '@/lib/action';
import { requireStaff, type Ctx } from '@/lib/auth/context';
import { recordFrivolousNotice, recordMoreInformation, recordProcedureDates, requestProcedureDescription, setConfirmedAccurate } from '@/lib/disputes/escalation';
import type { DActor } from '@/lib/disputes/service';

const actorOf = (ctx: Ctx): DActor => ({ orgId: ctx.orgId, userId: ctx.userId, role: ctx.role, meta: ctx.meta });
const optDate = zDate.optional().or(z.literal(''));

/** "Client sent more information on <date>": extends the reinvestigation period to 45 days from receipt. */
export async function recordMoreInfoAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const ctx = await requireStaff('disputes:write');
  return run(async () => {
    const d = parseForm(z.object({ id: zUuid, sentOn: zDate }), fd);
    await ctx.tx((db) => recordMoreInformation(db, actorOf(ctx), d.id, d.sentOn));
    revalidatePath(`/app/disputes/${d.id}`);
    revalidatePath('/app/disputes');
    return { ok: 'Recorded. The period now runs up to 45 days from receipt.' };
  });
}

export async function confirmedAccurateAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const ctx = await requireStaff('disputes:write');
  return run(async () => {
    const d = parseForm(z.object({ id: zUuid, confirmed: zBool }), fd);
    await ctx.tx((db) => setConfirmedAccurate(db, actorOf(ctx), d.id, d.confirmed));
    revalidatePath(`/app/disputes/${d.id}`);
    return { ok: 'Saved.' };
  });
}

/** Drafts the request for the reinvestigation procedure and opens it. It is a draft: approval and mailing are separate, human steps. */
export async function requestProcedureAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const ctx = await requireStaff('letters:write');
  return run(async () => {
    const d = parseForm(z.object({ id: zUuid }), fd);
    const letterId = await ctx.tx((db) => requestProcedureDescription(db, actorOf(ctx), d.id, ctx.session.orgName));
    revalidatePath(`/app/disputes/${d.id}`);
    redirect(`/app/letters/${letterId}`);
  });
}

export async function procedureDatesAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const ctx = await requireStaff('disputes:write');
  return run(async () => {
    const d = parseForm(z.object({ id: zUuid, letterId: zUuid, receivedOn: optDate, replyOn: optDate }), fd);
    if (!d.receivedOn && !d.replyOn) throw new UserError('Enter a date.');
    await ctx.tx((db) => recordProcedureDates(db, actorOf(ctx), d.letterId, { receivedOn: d.receivedOn || null, replyOn: d.replyOn || null }));
    revalidatePath(`/app/disputes/${d.id}`);
    return { ok: 'Recorded.' };
  });
}

/** The agency's "frivolous or irrelevant" notice: what it said was missing becomes a task and a request the client sees. */
export async function frivolousNoticeAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const ctx = await requireStaff('disputes:write');
  return run(async () => {
    const d = parseForm(z.object({ id: zUuid, missing: zText(1000), receivedOn: optDate }), fd);
    await ctx.tx((db) => recordFrivolousNotice(db, actorOf(ctx), d.id, { missing: d.missing, receivedOn: d.receivedOn || null }));
    revalidatePath(`/app/disputes/${d.id}`);
    revalidatePath('/app/disputes');
    return { ok: 'Recorded. A task was created for what the agency asked for, and the client sees the request in their portal.' };
  });
}
