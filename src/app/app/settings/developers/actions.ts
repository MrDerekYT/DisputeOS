'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import type { ActionState } from '@/components/forms';
import { parseForm, run, zText, zUuid } from '@/lib/action';
import { API_SCOPES, createApiKey, revokeApiKey, type ApiScope } from '@/lib/api/keys';
import { requireStaff } from '@/lib/auth/context';

export async function createApiKeyAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const ctx = await requireStaff('settings:manage');
  return run(async () => {
    const d = parseForm(z.object({ name: zText(80), scope: z.union([z.string(), z.array(z.string())]).optional().transform((v) => (v == null ? [] : Array.isArray(v) ? v : [v])) }), fd);
    const scopes = d.scope.filter((s): s is ApiScope => (API_SCOPES as readonly string[]).includes(s));
    const k = await ctx.tx((db) => createApiKey(db, ctx, { name: d.name, scopes }));
    revalidatePath('/app/settings/developers');
    return { ok: `Copy this key now — it is shown only once and cannot be recovered: ${k.key}` };
  });
}

export async function revokeApiKeyAction(fd: FormData) {
  const ctx = await requireStaff('settings:manage');
  const d = parseForm(z.object({ id: zUuid }), fd);
  await ctx.tx((db) => revokeApiKey(db, ctx, d.id));
  revalidatePath('/app/settings/developers');
}
