'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import type { ActionState } from '@/components/forms';
import { parseForm, run, UserError, zOpt, zUuid } from '@/lib/action';
import { requireClient } from '@/lib/auth/context';
import { addMark, removeMark } from '@/lib/credit/personal-info';
import { portalLangForUser } from '@/lib/portal';
import { tr } from '@/lib/portal-i18n';

/**
 * The client lists an entry on one of their credit reports that is wrong or not theirs, typed as the report shows it.
 * It only records what the client says: nothing is sent to a bureau, and the correction letter is drafted by staff.
 * Runs as the client; row-level security (0026) keeps the write to their own file and marks it as theirs.
 */
export async function portalAddPersonalInfoAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const ctx = await requireClient();
  const t = tr(await portalLangForUser(ctx.userId));
  return run(async () => {
    const d = z.object({ bureau: z.enum(['experian', 'equifax', 'transunion']), kind: z.enum(['name', 'address', 'employer', 'phone', 'date_of_birth']), value: z.string().trim().min(1).max(300), issue: z.enum(['not_mine', 'incorrect']), correctValue: zOpt(300) })
      .safeParse(Object.fromEntries([...fd.entries()].filter(([k, v]) => !k.startsWith('$ACTION') && typeof v === 'string')));
    if (!d.success) throw new UserError(t('pi_bad'));
    const written = await ctx.tx((db) => addMark(db, { orgId: ctx.orgId, userId: ctx.userId, source: 'client' }, ctx.clientId, d.data));
    // Staff already marked this entry and their answer stands: nothing was saved, so the client is told that instead.
    if (!written) return { error: t('pi_teamListed') };
    revalidatePath('/portal/profile');
    return { ok: t('a_saved') };
  });
}

export async function portalRemovePersonalInfoAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const ctx = await requireClient();
  const t = tr(await portalLangForUser(ctx.userId));
  return run(async () => {
    const d = parseForm(z.object({ markId: zUuid }), fd);
    await ctx.tx((db) => removeMark(db, ctx.clientId, d.markId));
    revalidatePath('/portal/profile');
    return { ok: t('a_saved') };
  });
}
