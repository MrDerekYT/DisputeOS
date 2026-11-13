'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import type { ActionState } from '@/components/forms';
import { parseForm, run, UserError, zBool, zOpt, zText, zUuid } from '@/lib/action';
import { audit } from '@/lib/audit';
import { requireStaff } from '@/lib/auth/context';
import { logEvent } from '@/lib/crm';
import { PRODUCT } from '@/lib/product';

const dollars = z.string().trim().regex(/^\d{1,7}(\.\d{1,2})?$/, 'Enter an amount like 99 or 99.50').transform((v) => Math.round(Number(v) * 100));

/**
 * CROA § 404(b) (15 U.S.C. § 1679b(b)): a credit repair organization may not charge or receive payment before the
 * service is fully performed. We cannot decide that for you, so recording a payment requires an explicit confirmation
 * that it is for work already completed, and the confirmation is stored in the audit log.
 */
export async function recordPaymentAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const ctx = await requireStaff('billing:write');
  return run(async () => {
    const d = parseForm(
      z.object({ clientId: zUuid, amount: dollars, method: z.enum(['card', 'ach', 'cash', 'check', 'other']), note: zOpt(500), subscriptionId: zUuid.optional().or(z.literal('')), performed: zBool }),
      fd,
    );
    if (!d.performed) throw new UserError('Confirm that this payment is for services already performed. Charging in advance of performance is prohibited for credit repair organizations.');
    await ctx.tx(async (db) => {
      const p = await db.row<{ id: string }>(
        `insert into public.payments (org_id, client_id, subscription_id, amount_cents, method, note, recorded_by) values ($1,$2,$3,$4,$5,$6,$7) returning id`,
        [ctx.orgId, d.clientId, d.subscriptionId || null, d.amount, d.method, d.note ?? null, ctx.userId]);
      await logEvent(db, ctx, d.clientId, 'payment', `Payment recorded: $${(d.amount / 100).toFixed(2)}`);
      await audit(db, { orgId: ctx.orgId, actorId: ctx.userId, action: 'payment.recorded', entityType: 'payment', entityId: p!.id, ip: ctx.meta.ip, meta: { amount_cents: d.amount, services_performed_confirmed: true } });
    });
    revalidatePath(`/app/clients/${d.clientId}`);
    revalidatePath('/app/billing');
    return { ok: 'Payment recorded.' };
  });
}

export async function refundPaymentAction(fd: FormData) {
  const ctx = await requireStaff('billing:write');
  const d = parseForm(z.object({ id: zUuid, clientId: zUuid }), fd);
  await ctx.tx(async (db) => {
    await db.run("update public.payments set status = 'refunded' where id = $1 and status = 'succeeded'", [d.id]);
    await audit(db, { orgId: ctx.orgId, actorId: ctx.userId, action: 'payment.refunded', entityType: 'payment', entityId: d.id, ip: ctx.meta.ip });
  });
  revalidatePath(`/app/clients/${d.clientId}`);
  revalidatePath('/app/billing');
}

export async function createPlanAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const ctx = await requireStaff('billing:write');
  return run(async () => {
    const d = parseForm(z.object({ name: zText(120), price: dollars, interval: z.enum(['month', 'one_time']), description: zOpt(500) }), fd);
    await ctx.tx((db) => db.run('insert into public.service_plans (org_id, name, price_cents, interval, description) values ($1,$2,$3,$4,$5)', [ctx.orgId, d.name, d.price, d.interval, d.description ?? null]));
    revalidatePath('/app/billing');
    return { ok: 'Plan created.' };
  });
}

export async function subscribeClientAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const ctx = await requireStaff('billing:write');
  return run(async () => {
    const d = parseForm(z.object({ clientId: zUuid, planId: zUuid }), fd);
    await ctx.tx(async (db) => {
      await db.run("update public.client_subscriptions set status = 'cancelled', cancelled_at = now() where client_id = $1 and status = 'active'", [d.clientId]);
      await db.run('insert into public.client_subscriptions (org_id, client_id, plan_id) values ($1,$2,$3)', [ctx.orgId, d.clientId, d.planId]);
      await logEvent(db, ctx, d.clientId, 'subscription', 'Service plan assigned');
    });
    revalidatePath(`/app/clients/${d.clientId}`);
    return { ok: `Plan assigned. Billing for this plan is recorded manually; no card is charged by ${PRODUCT.name}.` };
  });
}

export async function cancelSubscriptionAction(fd: FormData) {
  const ctx = await requireStaff('billing:write');
  const d = parseForm(z.object({ id: zUuid, clientId: zUuid }), fd);
  await ctx.tx(async (db) => {
    await db.run("update public.client_subscriptions set status = 'cancelled', cancelled_at = now() where id = $1", [d.id]);
    await logEvent(db, ctx, d.clientId, 'subscription', 'Service plan cancelled');
  });
  revalidatePath(`/app/clients/${d.clientId}`);
}
