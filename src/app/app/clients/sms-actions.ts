'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import type { ActionState } from '@/components/forms';
import { parseForm, run, UserError, zBool, zUuid } from '@/lib/action';
import { requireStaff } from '@/lib/auth/context';
import { grantSmsConsent, reviewSmsReplies, revokeSmsConsent, SMS_STOPPED_MESSAGE } from '@/lib/client-updates/service';

/**
 * Staff record that a client agreed to texts outside the portal (on a call, in person, on paper). The record is
 * labelled staff-recorded, never as the client's own action, and needs a note saying how and when the client agreed.
 */
export async function recordSmsConsentAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const ctx = await requireStaff('clients:write');
  return run(async () => {
    const d = parseForm(z.object({ clientId: zUuid, confirmed: zBool, note: z.string().trim().min(10, 'Say how and when the client agreed (at least 10 characters)').max(500) }), fd);
    if (!d.confirmed) throw new UserError('Confirm that you read the wording to the client and they agreed.');
    const r = await ctx.tx((db) => grantSmsConsent(db, { orgId: ctx.orgId, clientId: d.clientId, userId: ctx.userId, source: 'staff', note: d.note, ip: ctx.meta.ip }));
    if (!r.ok && r.reason === 'stopped') throw new UserError(SMS_STOPPED_MESSAGE);
    if (!r.ok) throw new UserError(r.reason === 'no_phone' ? 'Save a US mobile number with its area code on the client’s record first, for example (212) 555-0142. Texts are sent to US numbers only.' : 'Client not found.');
    revalidatePath(`/app/clients/${d.clientId}`);
    return { ok: `Recorded for ${r.phone}, labelled as recorded by staff.` };
  });
}

export async function revokeSmsConsentAction(fd: FormData) {
  const ctx = await requireStaff('clients:write');
  const d = parseForm(z.object({ clientId: zUuid }), fd);
  await ctx.tx((db) => revokeSmsConsent(db, { orgId: ctx.orgId, clientId: d.clientId, userId: ctx.userId, via: 'staff', ip: ctx.meta.ip }));
  revalidatePath(`/app/clients/${d.clientId}`);
}

/**
 * A staff member has read the client's free-text reply. Until then nothing more is texted to the client. "It asks to
 * stop" ends consent exactly as a STOP would; "it does not" lets texts resume.
 */
export async function reviewSmsReplyAction(fd: FormData) {
  const ctx = await requireStaff('clients:write');
  const d = parseForm(z.object({ clientId: zUuid, decision: z.enum(['stop', 'keep']) }), fd);
  await ctx.tx((db) => reviewSmsReplies(db, { orgId: ctx.orgId, clientId: d.clientId, userId: ctx.userId, asksToStop: d.decision === 'stop', ip: ctx.meta.ip }));
  revalidatePath(`/app/clients/${d.clientId}`);
}
