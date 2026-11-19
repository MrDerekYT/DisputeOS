'use server';

import { zUuid } from '@/lib/action';
import { requireStaff } from '@/lib/auth/context';
import { rateLimit } from '@/lib/auth/rate-limit';
import { buildPaidGuideReply, validQuestion, type GuideReply } from '@/lib/guide/ask';
import { loadStaffSteps } from '@/lib/guide/steps';

/**
 * Credit guide for staff and personal-workspace owners. `clientId` is the client page being viewed, if any: its plan
 * steps are loaded under the caller's own row-level security, so an id they cannot see simply yields no steps.
 */
export async function askStaffGuide(question: string, clientId?: string | null): Promise<GuideReply> {
  const ctx = await requireStaff();
  const q = validQuestion(question);
  if (!q) return { ok: false, error: 'Ask a question of up to 500 characters.' };
  if (!(await rateLimit(`guide:user:${ctx.userId}`, 30, 300)).allowed) return { ok: false, error: 'Too many questions in a short time. Try again in a few minutes.' };
  try {
    const id = zUuid.safeParse(clientId);
    const personal = id.success ? await ctx.tx((db) => loadStaffSteps(db, id.data, ctx.session.orgMode === 'personal')) : undefined;
    return await buildPaidGuideReply({ question: q, lang: 'en', audience: 'app', personal }, { orgId: ctx.orgId, userId: ctx.userId });
  } catch (e) {
    console.error('[guide]', e);
    return { ok: false, error: 'Something went wrong. Please try again.' };
  }
}
