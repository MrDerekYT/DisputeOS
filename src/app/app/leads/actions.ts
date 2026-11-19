'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import type { ActionState } from '@/components/forms';
import { parseForm, run, UserError, zBool, zUuid } from '@/lib/action';
import { audit } from '@/lib/audit';
import { requireStaff } from '@/lib/auth/context';
import { logEvent } from '@/lib/crm';

/** "Convert to client" (→ onboarding) and "Mark not interested" (→ cancelled). Only ever moves a record that is still a lead. */
export async function setLeadStatusAction(fd: FormData) {
  const ctx = await requireStaff('clients:write');
  const d = parseForm(z.object({ id: zUuid, status: z.enum(['onboarding', 'cancelled']) }), fd);
  await ctx.tx(async (db) => {
    const changed = await db.run("update public.clients set status = $2 where id = $1 and status = 'lead'", [d.id, d.status]);
    if (!changed) return;
    await logEvent(db, ctx, d.id, 'status_changed', `Status changed: lead → ${d.status}${d.status === 'cancelled' ? ' (not interested)' : ''}`);
    await audit(db, { orgId: ctx.orgId, actorId: ctx.userId, action: d.status === 'onboarding' ? 'lead.converted' : 'lead.not_interested', entityType: 'client', entityId: d.id, ip: ctx.meta.ip });
  });
  revalidatePath('/app/leads');
  revalidatePath('/app', 'layout');
}

/**
 * "They replied": the lead answered an automatic email (the reply went to the agency's own mailbox, which this system
 * cannot read). Records an inbound message on the lead, which stops automatic follow-up for them.
 */
export async function leadRepliedAction(fd: FormData) {
  const ctx = await requireStaff('clients:write');
  const d = parseForm(z.object({ id: zUuid }), fd);
  await ctx.tx(async (db) => {
    if (!(await db.row("select 1 from public.clients where id = $1 and status = 'lead' for update", [d.id]))) return;
    if (await db.row("select 1 from public.communications where client_id = $1 and direction = 'inbound' limit 1", [d.id])) return;
    await db.run(
      `insert into public.communications (org_id, client_id, direction, channel, body, status, author_id)
       values ($1, $2, 'inbound', 'email', 'The lead replied by email. Logged by the team; the reply itself is in the agency mailbox.', 'received', $3)`, [ctx.orgId, d.id, ctx.userId]);
    await logEvent(db, ctx, d.id, 'lead_replied', 'Marked as replied; automatic follow-up emails stopped');
    await audit(db, { orgId: ctx.orgId, actorId: ctx.userId, action: 'lead.reply_logged', entityType: 'client', entityId: d.id, ip: ctx.meta.ip });
  });
  revalidatePath('/app/leads');
}

/** "Asked to stop": the lead asked (by reply, phone, any way) not to be emailed. Same effect as the opt-out link. */
export async function leadAskedToStopAction(fd: FormData) {
  const ctx = await requireStaff('clients:write');
  const d = parseForm(z.object({ id: zUuid }), fd);
  await ctx.tx(async (db) => {
    const changed = await db.run('update public.clients set outreach_opt_out_at = now() where id = $1 and outreach_opt_out_at is null', [d.id]);
    if (!changed) return;
    await logEvent(db, ctx, d.id, 'lead_opt_out', 'Asked not to receive automatic follow-up emails (recorded by the team)');
    await audit(db, { orgId: ctx.orgId, actorId: ctx.userId, action: 'lead.opted_out', entityType: 'client', entityId: d.id, ip: ctx.meta.ip });
  });
  revalidatePath('/app/leads');
}

/** The agency-level switch for automatic follow-up, plus the postal and reply addresses every such email carries. */
export async function saveLeadFollowUpAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const ctx = await requireStaff('settings:manage');
  return run(async () => {
    const d = parseForm(z.object({
      enabled: zBool,
      address: z.string().trim().max(300).regex(/^[^<>]*$/, 'Use plain text').optional(),
      replyTo: z.union([z.string().trim().toLowerCase().email('Enter a valid reply email address').max(254), z.literal('')]).optional(),
    }), fd);
    const address = (d.address ?? '').replace(/\s+/g, ' ').trim();
    const replyTo = d.replyTo ?? '';
    if (d.enabled && (!address || !replyTo)) throw new UserError('To switch automatic follow-up on, enter your mailing address and a reply email address. Marketing email must show a postal address, and people need a way to answer.');
    await ctx.tx(async (db) => {
      // `lead_followup_since` is set when the switch goes from off to on: only enquiries received after that are emailed.
      await db.run(
        `update public.organizations
            set settings = (settings - 'lead_followup_since')
              || jsonb_build_object('lead_followup_enabled', $2::boolean, 'lead_mailing_address', $3::text, 'lead_reply_email', $4::text)
              || case when $2::boolean then jsonb_build_object('lead_followup_since',
                   case when settings->>'lead_followup_enabled' = 'true' and settings ? 'lead_followup_since' then settings->>'lead_followup_since'
                        else to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') end) else '{}'::jsonb end
          where id = $1`, [ctx.orgId, d.enabled, address, replyTo]);
      await audit(db, { orgId: ctx.orgId, actorId: ctx.userId, action: 'lead_followup.updated', entityType: 'organization', entityId: ctx.orgId, ip: ctx.meta.ip, meta: { enabled: d.enabled, has_address: address !== '' } });
    });
    revalidatePath('/app/leads');
    return { ok: d.enabled ? 'Saved. Automatic follow-up is on for new enquiries from now on.' : 'Saved. Automatic follow-up is off.' };
  });
}
