'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import type { ActionState } from '@/components/forms';
import { parseForm, run, zBool } from '@/lib/action';
import { requireClient } from '@/lib/auth/context';
import { grantSmsConsent, revokeSmsConsent } from '@/lib/client-updates/service';
import { tr, type Lang } from '@/lib/portal-i18n';

async function langOf(ctx: Awaited<ReturnType<typeof requireClient>>): Promise<Lang> {
  const row = await ctx.tx((db) => db.row<{ preferred_language: string }>('select preferred_language from public.clients where id = $1', [ctx.clientId]));
  return row?.preferred_language === 'es' ? 'es' : 'en';
}

/**
 * The client agrees to text messages, in their own portal session. What is stored is the wording they were shown (in
 * their language, naming the business and their number), the time, and the address the request came from. Row-level
 * security only lets a portal user write a record for themselves, labelled 'portal'.
 */
export async function portalSmsOptInAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const ctx = await requireClient();
  const t = tr(await langOf(ctx));
  return run(async () => {
    const d = parseForm(z.object({ agree: zBool }), fd);
    if (!d.agree) return { error: t('a_confirmAgree') };
    const r = await ctx.tx((db) => grantSmsConsent(db, { orgId: ctx.orgId, clientId: ctx.clientId, userId: ctx.userId, source: 'portal', ip: ctx.meta.ip, userAgent: ctx.meta.userAgent }));
    revalidatePath('/portal/profile');
    return r.ok ? { ok: t('a_smsOn') } : { error: t('a_smsNeedPhone') };
  });
}

/** The client withdraws. Nothing more is texted: every send re-checks consent first. */
export async function portalSmsOptOutAction(_: ActionState, _fd: FormData): Promise<ActionState> {
  const ctx = await requireClient();
  const t = tr(await langOf(ctx));
  return run(async () => {
    await ctx.tx((db) => revokeSmsConsent(db, { orgId: ctx.orgId, clientId: ctx.clientId, userId: ctx.userId, via: 'portal', ip: ctx.meta.ip }));
    revalidatePath('/portal/profile');
    return { ok: t('a_smsOff') };
  });
}
