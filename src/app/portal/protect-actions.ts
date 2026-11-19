'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import type { ActionState } from '@/components/forms';
import { parseForm, run, UserError } from '@/lib/action';
import { requireClient } from '@/lib/auth/context';
import { PROTECTION_OPTIONS, ProtectionError, setProtectionTick } from '@/lib/credit/protections';
import { businessToday } from '@/lib/letters/service';
import { tr, type Lang } from '@/lib/portal-i18n';

/**
 * The client ticks (or clears) "I placed this on <date>" on their own "Protect your file" list. This only records
 * what the client says they did themselves with the agency. Nothing is sent to any agency, and no agency login, PIN
 * or password is asked for or stored. Runs as the client: row-level security and the 0022 trigger keep the write to
 * their own record.
 */
export async function portalProtectionAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const ctx = await requireClient();
  const row = await ctx.tx((db) => db.row<{ preferred_language: Lang }>('select preferred_language from public.clients where id = $1', [ctx.clientId]));
  const t = tr(row?.preferred_language === 'es' ? 'es' : 'en');
  return run(async () => {
    const d = parseForm(z.object({
      option: z.string().refine((k) => PROTECTION_OPTIONS.some((o) => o.key === k)),
      on: z.string().trim().optional(), clear: z.string().optional(),
    }), fd);
    try {
      await ctx.tx((db) => setProtectionTick(db, ctx.clientId, d.option, d.clear ? null : d.on ?? '', businessToday()));
    } catch (e) {
      if (e instanceof ProtectionError) throw new UserError(t('pf_badDate'));
      throw e;
    }
    revalidatePath('/portal/protect');
    return { ok: t('a_saved') };
  });
}
