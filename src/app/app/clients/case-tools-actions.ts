'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import type { ActionState } from '@/components/forms';
import { parseForm, run, zDate, zOpt, zUuid } from '@/lib/action';
import { requireStaff } from '@/lib/auth/context';
import { recordCollectorNotice, removeCollectorNotice, setBankruptcy, setMedicalFlags } from '@/lib/credit/case-tools';

const ids = z.union([zUuid, z.array(zUuid)]).optional().transform((v) => (v == null ? [] : Array.isArray(v) ? v : [v]));
const optDate = zDate.optional().or(z.literal(''));

/** Staff record that the client received a debt collector's notice; the 30-day validation period is worked out from the date. */
export async function recordCollectorNoticeAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const ctx = await requireStaff('clients:write');
  return run(async () => {
    const d = parseForm(z.object({ clientId: zUuid, tradelineId: zUuid.optional().or(z.literal('')), collectorName: zOpt(200), kind: z.enum(['received', 'sent']), date: zDate }), fd);
    await ctx.tx((db) => recordCollectorNotice(db, ctx, { clientId: d.clientId, tradelineId: d.tradelineId || null, collectorName: d.collectorName, kind: d.kind, date: d.date }));
    revalidatePath(`/app/clients/${d.clientId}`);
    return { ok: 'Notice recorded.' };
  });
}

export async function removeCollectorNoticeAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const ctx = await requireStaff('clients:write');
  return run(async () => {
    const d = parseForm(z.object({ clientId: zUuid, noticeId: zUuid }), fd);
    await ctx.tx((db) => removeCollectorNotice(db, ctx, d.clientId, d.noticeId));
    revalidatePath(`/app/clients/${d.clientId}`);
    return { ok: 'Removed.' };
  });
}

/** Staff say which collection accounts are medical debts. Every account listed on the form gets an answer. */
export async function setMedicalFlagsAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const ctx = await requireStaff('clients:write');
  return run(async () => {
    const d = parseForm(z.object({ clientId: zUuid, listed: ids, medical: ids }), fd);
    await ctx.tx((db) => setMedicalFlags(db, ctx, d.clientId, d.listed, d.medical));
    revalidatePath(`/app/clients/${d.clientId}`);
    return { ok: 'Saved.' };
  });
}

/** Staff enter the chapter, filing date and discharge date. No court record is read. */
export async function setBankruptcyAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const ctx = await requireStaff('clients:write');
  return run(async () => {
    const d = parseForm(z.object({ clientId: zUuid, chapter: z.enum(['', '7', '13']), filedOn: optDate, dischargedOn: optDate }), fd);
    await ctx.tx((db) => setBankruptcy(db, ctx, d.clientId, { chapter: d.chapter || null, filedOn: d.filedOn || null, dischargedOn: d.dischargedOn || null }));
    revalidatePath(`/app/clients/${d.clientId}`);
    return { ok: 'Saved.' };
  });
}
