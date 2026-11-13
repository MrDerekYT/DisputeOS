'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import type { ActionState } from '@/components/forms';
import { parseForm, run, UserError, zOpt, zText } from '@/lib/action';
import { audit } from '@/lib/audit';
import { clearSessionCookie, currentSession, requireStaff } from '@/lib/auth/context';
import { changePassword, revokeAllSessions } from '@/lib/auth/service';

export async function updateOrgAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const ctx = await requireStaff('settings:manage');
  return run(async () => {
    const d = parseForm(z.object({ name: zText(160), stateCode: z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/, 'Use a two-letter state code').optional().or(z.literal('')), retentionDays: z.coerce.number().int().min(365).max(3650), brandColor: z.string().trim().regex(/^#[0-9a-fA-F]{6}$/, 'Choose a colour like #0f766e').optional().or(z.literal('')) }), fd);
    await ctx.tx(async (db) => {
      await db.run("update public.organizations set name = $2, state_code = $3, settings = (settings || jsonb_build_object('retention_days', $4::int)) - 'brand_color' || case when $5::text <> '' then jsonb_build_object('brand_color', $5::text) else '{}'::jsonb end where id = $1", [ctx.orgId, d.name, d.stateCode || null, d.retentionDays, d.brandColor ?? '']);
      await audit(db, { orgId: ctx.orgId, actorId: ctx.userId, action: 'org.updated', entityType: 'organization', entityId: ctx.orgId, ip: ctx.meta.ip, meta: { retention_days: d.retentionDays } });
    });
    revalidatePath('/app', 'layout');
    return { ok: 'Settings saved.' };
  });
}

export async function changePasswordAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const ctx = await requireStaff();
  return run(async () => {
    const d = parseForm(z.object({ current: z.string().min(1).max(200), next: z.string().min(1).max(200), confirm: z.string() }), fd);
    if (d.next !== d.confirm) throw new UserError('The new passwords do not match.');
    const r = await changePassword(ctx.userId, d.current, d.next, ctx.session.sessionId);
    if (!r.ok) return { error: r.error };
    await ctx.tx((db) => audit(db, { orgId: ctx.orgId, actorId: ctx.userId, action: 'auth.password_changed', entityType: 'user', entityId: ctx.userId, ip: ctx.meta.ip }));
    return { ok: 'Password changed. Your other sessions were signed out.' };
  });
}

export async function signOutEverywhereAction() {
  const s = await currentSession();
  if (s) await revokeAllSessions(s.userId);
  await clearSessionCookie();
  redirect('/login');
}

void zOpt;
