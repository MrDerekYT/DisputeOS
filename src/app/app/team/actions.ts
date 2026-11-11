'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import type { ActionState } from '@/components/forms';
import { parseForm, run, UserError, zUuid } from '@/lib/action';
import { audit } from '@/lib/audit';
import { requireStaff } from '@/lib/auth/context';
import { adminResetMfa, createInviteToken, normEmail } from '@/lib/auth/service';
import { sendEmail } from '@/lib/mailer';
import { getEnv } from '@/lib/env';
import { grantableRoles, type Role } from '@/lib/rbac';
import { PRODUCT } from '@/lib/product';

export async function inviteStaffAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const ctx = await requireStaff('team:manage');
  return run(async () => {
    const d = parseForm(z.object({ email: z.string().trim().toLowerCase().email().max(254), role: z.enum(['admin', 'manager', 'specialist']) }), fd);
    if (!grantableRoles(ctx.role).includes(d.role)) throw new UserError('You cannot grant that role.');
    let link = '';
    await ctx.tx(async (db) => {
      const token = await createInviteToken(db, { orgId: ctx.orgId, email: normEmail(d.email), role: d.role, invitedBy: ctx.userId });
      link = `${getEnv().APP_URL}/invite/${token}`;
      await audit(db, { orgId: ctx.orgId, actorId: ctx.userId, action: 'team.invited', entityType: 'invite', ip: ctx.meta.ip, meta: { role: d.role } });
    });
    const sent = await sendEmail({ to: d.email, subject: `Join ${ctx.session.orgName} on ${PRODUCT.name}`, text: `${ctx.session.fullName || 'A colleague'} invited you to ${ctx.session.orgName} on ${PRODUCT.name} as ${d.role}.\n\nAccept: ${link}\n\nThe link expires in 7 days.` });
    revalidatePath('/app/team');
    return sent.provider === 'log' ? { ok: `Email delivery is not configured. Send this one-time link yourself: ${link}` } : sent.ok ? { ok: `Invitation sent to ${d.email}.` } : { error: `Could not send the email: ${sent.error}` };
  });
}

export async function changeRoleAction(fd: FormData) {
  const ctx = await requireStaff('team:manage');
  const d = parseForm(z.object({ userId: zUuid, role: z.enum(['admin', 'manager', 'specialist']) }), fd);
  if (!grantableRoles(ctx.role).includes(d.role)) throw new UserError('You cannot grant that role.');
  if (d.userId === ctx.userId) throw new UserError('You cannot change your own role.');
  await ctx.tx(async (db) => {
    const t = await db.row<{ role: Role }>('select role from public.memberships where org_id = $1 and user_id = $2', [ctx.orgId, d.userId]);
    if (!t || t.role === 'owner' || (t.role === 'admin' && ctx.role !== 'owner')) throw new UserError('You cannot change that member.');
    await db.run('update public.memberships set role = $3 where org_id = $1 and user_id = $2', [ctx.orgId, d.userId, d.role]);
    await audit(db, { orgId: ctx.orgId, actorId: ctx.userId, action: 'team.role_changed', entityType: 'user', entityId: d.userId, ip: ctx.meta.ip, meta: { role: d.role } });
  });
  revalidatePath('/app/team');
}

export async function removeMemberAction(fd: FormData) {
  const ctx = await requireStaff('team:manage');
  const d = parseForm(z.object({ userId: zUuid }), fd);
  if (d.userId === ctx.userId) throw new UserError('You cannot remove yourself.');
  await ctx.tx(async (db) => {
    const t = await db.row<{ role: Role }>('select role from public.memberships where org_id = $1 and user_id = $2', [ctx.orgId, d.userId]);
    if (!t || t.role === 'owner' || t.role === 'client' || (t.role === 'admin' && ctx.role !== 'owner')) throw new UserError('You cannot remove that member.');
    await db.run('update public.clients set assigned_to = null where assigned_to = $1', [d.userId]);
    await db.run('update public.tasks set assignee_id = null where assignee_id = $1 and status = \'open\'', [d.userId]);
    await db.run('delete from public.memberships where org_id = $1 and user_id = $2', [ctx.orgId, d.userId]);
    await audit(db, { orgId: ctx.orgId, actorId: ctx.userId, action: 'team.removed', entityType: 'user', entityId: d.userId, ip: ctx.meta.ip });
  });
  // end their sessions for this workspace immediately
  const { revokeAllSessions } = await import('@/lib/auth/service');
  await revokeAllSessions(d.userId);
  revalidatePath('/app/team');
}

export async function resetMfaAction(fd: FormData) {
  const ctx = await requireStaff('team:manage');
  const d = parseForm(z.object({ userId: zUuid }), fd);
  const ok = await adminResetMfa(ctx.orgId, d.userId);
  if (!ok) throw new UserError('That member’s two-step verification cannot be reset.');
  await ctx.tx((db) => audit(db, { orgId: ctx.orgId, actorId: ctx.userId, action: 'team.mfa_reset', entityType: 'user', entityId: d.userId, ip: ctx.meta.ip }));
  revalidatePath('/app/team');
}

export async function reassignClientsAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const ctx = await requireStaff('clients:assign');
  return run(async () => {
    const d = parseForm(z.object({ from: zUuid, to: zUuid.optional().or(z.literal('')) }), fd);
    let n = 0;
    await ctx.tx(async (db) => {
      n = await db.run("update public.clients set assigned_to = $2 where assigned_to = $1 and status in ('lead','onboarding','active','paused')", [d.from, d.to || null]);
      await audit(db, { orgId: ctx.orgId, actorId: ctx.userId, action: 'team.clients_reassigned', entityType: 'user', entityId: d.from, ip: ctx.meta.ip, meta: { count: n } });
    });
    revalidatePath('/app/team');
    return { ok: `${n} client${n === 1 ? '' : 's'} reassigned.` };
  });
}
