'use server';

import { requireClient } from '@/lib/auth/context';
import { rateLimit } from '@/lib/auth/rate-limit';
import { buildPortalGuideReply, validQuestion, type GuideReply } from '@/lib/guide/ask';
import { loadPortalSteps } from '@/lib/guide/steps';
import { tr, type Lang } from '@/lib/portal-i18n';

/**
 * Credit guide for a signed-in client. Reads only this client's own record, under their own session and row-level
 * security; writes nothing (the conversation lives in the browser tab and is gone when it closes). AI wording is used
 * only when the agency switched it on for the portal and the client is under the daily cap (buildPortalGuideReply).
 */
export async function askPortalGuide(question: string): Promise<GuideReply> {
  const ctx = await requireClient();
  const row = await ctx.tx((db) => db.row<{ preferred_language: Lang }>('select preferred_language from public.clients where id = $1', [ctx.clientId]));
  const lang: Lang = row?.preferred_language === 'es' ? 'es' : 'en';
  const t = tr(lang);
  const q = validQuestion(question);
  if (!q) return { ok: false, error: t('g_tooLong') };
  if (!(await rateLimit(`guide:user:${ctx.userId}`, 20, 300)).allowed) return { ok: false, error: t('e_tooMany') };
  try {
    const personal = await ctx.tx((db) => loadPortalSteps(db, ctx.clientId, lang));
    return await buildPortalGuideReply({ question: q, lang, personal }, { orgId: ctx.orgId, userId: ctx.userId });
  } catch (e) {
    console.error('[guide]', e);
    return { ok: false, error: t('e_generic') };
  }
}
