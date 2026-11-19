'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { parseForm, zUuid } from '@/lib/action';
import { audit } from '@/lib/audit';
import { requireStaff } from '@/lib/auth/context';
import { decideRun } from '@/lib/automation/engine';

export async function decideRunAction(fd: FormData) {
  const ctx = await requireStaff('automations:approve');
  const d = parseForm(z.object({ id: zUuid, decision: z.enum(['approve', 'cancel']) }), fd);
  await ctx.tx(async (db) => {
    const ok = await decideRun(db, { orgId: ctx.orgId, userId: ctx.userId }, d.id, d.decision);
    if (ok) await audit(db, { orgId: ctx.orgId, actorId: ctx.userId, action: `automation.${d.decision}`, entityType: 'automation_run', entityId: d.id, ip: ctx.meta.ip });
  });
  revalidatePath('/app/inbox');
  revalidatePath('/app', 'layout');
}

export async function markNotificationReadAction(fd: FormData) {
  const ctx = await requireStaff();
  const d = parseForm(z.object({ id: zUuid.optional().or(z.literal('')) }), fd);
  await ctx.tx((db) => (d.id ? db.run('update public.notifications set read_at = now() where id = $1', [d.id]) : db.run('update public.notifications set read_at = now() where read_at is null')));
  revalidatePath('/app', 'layout');
}
