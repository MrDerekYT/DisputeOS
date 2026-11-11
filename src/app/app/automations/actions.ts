'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import type { ActionState } from '@/components/forms';
import { parseForm, run, UserError, zBool, zOpt, zUuid } from '@/lib/action';
import { audit } from '@/lib/audit';
import { requireStaff } from '@/lib/auth/context';
import { ACTION_TYPES, runSweeps, TRIGGERS, validateActions, type ActionDef, type ActionType, type TriggerKey } from '@/lib/automation/engine';
import { STARTER_AUTOMATIONS } from '@/lib/automation/presets';
import { DOC_KINDS } from '@/lib/crm';

const triggers = Object.keys(TRIGGERS) as [TriggerKey, ...TriggerKey[]];
const actionTypes = Object.keys(ACTION_TYPES) as [ActionType, ...ActionType[]];
const int = (min: number, max: number) => z.coerce.number().int().min(min).max(max);

export async function saveAutomationAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const ctx = await requireStaff('automations:manage');
  return run(async () => {
    const d = parseForm(
      z.object({
        id: zUuid.optional().or(z.literal('')), name: z.string().trim().min(2).max(160), trigger: z.enum(triggers),
        days: int(1, 365).optional().or(z.literal('')), afterDays: int(1, 90).optional().or(z.literal('')), withinDays: int(1, 30).optional().or(z.literal('')),
        toStatus: zOpt(40), requiresApproval: zBool, cap: int(1, 500).default(25), cooldown: int(0, 365).default(7), enabled: zBool,
        a1: z.enum(actionTypes).optional().or(z.literal('')), t1: zOpt(200), b1: zOpt(1000), k1: z.enum(DOC_KINDS).optional().or(z.literal('')), d1: int(0, 60).optional().or(z.literal('')),
        a2: z.enum(actionTypes).optional().or(z.literal('')), t2: zOpt(200), b2: zOpt(1000), k2: z.enum(DOC_KINDS).optional().or(z.literal('')), d2: int(0, 60).optional().or(z.literal('')),
        a3: z.enum(actionTypes).optional().or(z.literal('')), t3: zOpt(200), b3: zOpt(1000), k3: z.enum(DOC_KINDS).optional().or(z.literal('')), d3: int(0, 60).optional().or(z.literal('')),
      }),
      fd,
    );
    const actions: ActionDef[] = [];
    for (const [a, t, b, k, dd] of [[d.a1, d.t1, d.b1, d.k1, d.d1], [d.a2, d.t2, d.b2, d.k2, d.d2], [d.a3, d.t3, d.b3, d.k3, d.d3]] as const) {
      if (!a) continue;
      actions.push({ type: a, title: t, body: b, kind: k || undefined, dueInDays: dd === '' || dd == null ? undefined : Number(dd) });
    }
    const problem = validateActions(actions);
    if (problem) throw new UserError(problem);
    const conditions = {
      ...(d.days ? { days: Number(d.days) } : {}), ...(d.afterDays ? { afterDays: Number(d.afterDays) } : {}),
      ...(d.withinDays ? { withinDays: Number(d.withinDays) } : {}), ...(d.toStatus ? { toStatus: d.toStatus } : {}),
    };
    const clientFacing = actions.some((a) => ACTION_TYPES[a.type].clientFacing);
    if (clientFacing && !d.requiresApproval && TRIGGERS[d.trigger].kind === 'sweep')
      throw new UserError('Scheduled automations that message clients must require approval. Remove the “send without approval” option, or use an event trigger.');
    await ctx.tx(async (db) => {
      let id = d.id;
      if (d.id) {
        await db.run('update public.automations set name=$2, trigger=$3, conditions=$4, actions=$5, requires_approval=$6, max_subjects_per_run=$7, cooldown_days=$8, enabled=$9 where id=$1',
          [d.id, d.name, d.trigger, JSON.stringify(conditions), JSON.stringify(actions), d.requiresApproval, d.cap, d.cooldown, d.enabled]);
      } else {
        const r = await db.row<{ id: string }>('insert into public.automations (org_id, name, trigger, conditions, actions, requires_approval, max_subjects_per_run, cooldown_days, enabled, created_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id',
          [ctx.orgId, d.name, d.trigger, JSON.stringify(conditions), JSON.stringify(actions), d.requiresApproval, d.cap, d.cooldown, d.enabled, ctx.userId]);
        id = r!.id;
      }
      await audit(db, { orgId: ctx.orgId, actorId: ctx.userId, action: d.id ? 'automation.updated' : 'automation.created', entityType: 'automation', entityId: id, ip: ctx.meta.ip, meta: { trigger: d.trigger, enabled: d.enabled, requires_approval: d.requiresApproval } });
    });
    revalidatePath('/app/automations');
    return { ok: 'Automation saved.' };
  });
}

export async function toggleAutomationAction(fd: FormData) {
  const ctx = await requireStaff('automations:manage');
  const d = parseForm(z.object({ id: zUuid }), fd);
  await ctx.tx(async (db) => {
    const r = await db.row<{ enabled: boolean }>('update public.automations set enabled = not enabled where id = $1 returning enabled', [d.id]);
    await audit(db, { orgId: ctx.orgId, actorId: ctx.userId, action: r?.enabled ? 'automation.enabled' : 'automation.disabled', entityType: 'automation', entityId: d.id, ip: ctx.meta.ip });
  });
  revalidatePath('/app/automations');
}

export async function deleteAutomationAction(fd: FormData) {
  const ctx = await requireStaff('automations:manage');
  const d = parseForm(z.object({ id: zUuid }), fd);
  await ctx.tx(async (db) => {
    await db.run('delete from public.automations where id = $1', [d.id]);
    await audit(db, { orgId: ctx.orgId, actorId: ctx.userId, action: 'automation.deleted', entityType: 'automation', entityId: d.id, ip: ctx.meta.ip });
  });
  revalidatePath('/app/automations');
}

export async function addStartersAction(_: ActionState): Promise<ActionState> {
  const ctx = await requireStaff('automations:manage');
  return run(async () => {
    let added = 0;
    await ctx.tx(async (db) => {
      for (const s of STARTER_AUTOMATIONS) {
        if (await db.row('select 1 from public.automations where name = $1', [s.name])) continue;
        await db.run('insert into public.automations (org_id, name, trigger, conditions, actions, requires_approval, max_subjects_per_run, cooldown_days, enabled, created_by) values ($1,$2,$3,$4,$5,true,$6,$7,false,$8)',
          [ctx.orgId, s.name, s.trigger, JSON.stringify(s.conditions), JSON.stringify(s.actions), s.cap, s.cooldown, ctx.userId]);
        added++;
      }
      await audit(db, { orgId: ctx.orgId, actorId: ctx.userId, action: 'automation.starters_added', entityType: 'automation', ip: ctx.meta.ip, meta: { added } });
    });
    revalidatePath('/app/automations');
    return { ok: added ? `Added ${added} starter automation${added > 1 ? 's' : ''}. All are switched off — review and enable the ones you want.` : 'The starter set is already there.' };
  });
}

export async function runNowAction(_: ActionState): Promise<ActionState> {
  const ctx = await requireStaff('automations:manage');
  return run(async () => {
    const sums = await ctx.tx((db) => runSweeps(db, { orgId: ctx.orgId, userId: ctx.userId }));
    revalidatePath('/app/automations');
    if (!sums.length) return { ok: 'No scheduled automations are enabled.' };
    return { ok: sums.map((s) => `${s.automation}: ${s.executed} done, ${s.pending} waiting for approval, ${s.skipped} skipped${s.capped ? ' (capped)' : ''}`).join(' · ') };
  });
}
