'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import type { ActionState } from '@/components/forms';
import { parseForm, run, zUuid } from '@/lib/action';
import { notChargedNote } from '@/lib/ai/credits';
import { AiUnavailable } from '@/lib/ai/provider';
import { requireStaff } from '@/lib/auth/context';
import { STAFF_KINDS } from '@/lib/credit/account-kind';
import { labelAccountsWithAi, setAccountKind } from '@/lib/credit/account-labels';

const ids = z.union([zUuid, z.array(zUuid)]).transform((v) => (Array.isArray(v) ? v : [v]));

/** A person says what an account is (one line per bureau it is reported on), or clears their label. */
export async function setAccountKindAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const ctx = await requireStaff('reports:write');
  return run(async () => {
    const d = parseForm(z.object({ clientId: zUuid, ids, kind: z.enum(['', ...STAFF_KINDS]) }), fd);
    await ctx.tx((db) => setAccountKind(db, ctx, d.clientId, d.ids, d.kind || null));
    revalidatePath(`/app/clients/${d.clientId}`);
    return { ok: d.kind ? 'Label saved.' : 'Label cleared: the report’s words decide again.' };
  });
}

/** Asks AI about the accounts the rules could not label. Charged only when at least one suggestion passes the checks. */
export async function labelAccountsAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const ctx = await requireStaff('reports:write');
  return run(async () => {
    const d = parseForm(z.object({ clientId: zUuid }), fd);
    let r;
    try {
      r = await labelAccountsWithAi({ orgId: ctx.orgId, userId: ctx.userId, role: ctx.role, ip: ctx.meta?.ip ?? null, tx: ctx.tx }, d.clientId);
    } catch (e) {
      if (e instanceof AiUnavailable) return { error: `AI could not be reached just now${e.retryable ? '; try again in a minute' : ''}. No AI credits were used.` };
      throw e;
    }
    revalidatePath(`/app/clients/${d.clientId}`);
    if (r.ai.status === 'no_provider') return { error: 'AI is not connected, so nothing was asked. Choose these labels yourself.' };
    if (r.ai.status === 'no_credits') return { error: 'No AI credits left, so nothing was asked. Choose these labels yourself.' };
    if (!r.asked) return { ok: 'Every account already has a label.' };
    if (!r.labelled && !r.hinted) return { ok: `AI could not tell for ${r.asked === 1 ? 'this account' : `any of the ${r.asked} account entries`}. Choose ${r.asked === 1 ? 'its label' : 'their labels'} yourself. ${notChargedNote(r.ai)}` };
    const said = [r.labelled ? `${r.labelled} negative` : '', r.hinted ? `${r.hinted} possibly in good standing` : ''].filter(Boolean).join(' and ');
    return { ok: `AI suggested ${said} (${r.ai.cost} AI credits). Each shows the words it rests on and does nothing until you confirm it under “Confirm or change”.${r.unknown ? ` For ${r.unknown} it could not tell; choose ${r.unknown === 1 ? 'that label' : 'those'} yourself.` : ''}` };
  });
}
