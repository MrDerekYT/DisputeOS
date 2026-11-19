'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import type { ActionState } from '@/components/forms';
import { parseForm, run, zBool, zDate, zUuid } from '@/lib/action';
import { requireStaff } from '@/lib/auth/context';
import { SPECIALTY_KEYS, SPECIALTY_REPORT_STATUSES } from '@/lib/credit/agencies';
import { setBankingConcern, setSpecialtyReport } from '@/lib/credit/specialty-reports';

/** Staff record where a client's specialty report stands: not requested, requested on a date, or received (with the file attached). */
export async function setSpecialtyReportAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const ctx = await requireStaff('clients:write');
  return run(async () => {
    const d = parseForm(z.object({
      clientId: zUuid, agency: z.string().refine((a) => SPECIALTY_KEYS.includes(a), 'Choose the reporting agency'),
      status: z.enum(SPECIALTY_REPORT_STATUSES), on: zDate.optional().or(z.literal('')), documentId: zUuid.optional().or(z.literal('')),
    }), fd);
    await ctx.tx((db) => setSpecialtyReport(db, ctx, d.clientId, d.agency, { status: d.status, on: d.on || null, documentId: d.documentId || null }));
    revalidatePath(`/app/clients/${d.clientId}`);
    return { ok: 'Saved.' };
  });
}

export async function setBankingConcernAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const ctx = await requireStaff('clients:write');
  return run(async () => {
    const d = parseForm(z.object({ clientId: zUuid, bankingConcern: zBool }), fd);
    await ctx.tx((db) => setBankingConcern(db, ctx, d.clientId, d.bankingConcern));
    revalidatePath(`/app/clients/${d.clientId}`);
    return { ok: 'Saved.' };
  });
}
