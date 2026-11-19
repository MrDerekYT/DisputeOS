'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import type { ActionState } from '@/components/forms';
import { parseForm, run, UserError, zOpt, zUuid } from '@/lib/action';
import { requireStaff } from '@/lib/auth/context';
import { removeBankCase, saveBankCase } from '@/lib/credit/bank-collections';
import { addMark, draftPersonalInfoLetter, PI_BUREAUS, PI_KINDS, removeMark } from '@/lib/credit/personal-info';
import { autoTailorDraft } from '@/lib/letters/tailor-load';
import type { Bureau } from '@/lib/util';

const zBureau = z.enum(['experian', 'equifax', 'transunion']);
const many = z.union([z.string(), z.array(z.string())]).optional().transform((v) => (v == null ? [] : Array.isArray(v) ? v : [v]));

/**
 * Staff mark one entry on one bureau's report as not the client's, or not correct. The entry is either picked from
 * what the imported report shows ("bureau|kind|value") or typed as the report shows it.
 */
export async function addPersonalInfoMarkAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const ctx = await requireStaff('clients:write');
  return run(async () => {
    const d = parseForm(z.object({ clientId: zUuid, picked: zOpt(400), bureau: zOpt(20), kind: zOpt(20), value: zOpt(300), issue: z.enum(['not_mine', 'incorrect']), correctValue: zOpt(300) }), fd);
    let entry = { bureau: d.bureau ?? '', kind: d.kind ?? '', value: d.value ?? '' };
    if (d.picked) {
      const [bureau, kind, ...rest] = d.picked.split('|');
      if (!(PI_BUREAUS as string[]).includes(bureau ?? '') || !(PI_KINDS as readonly string[]).includes(kind ?? '')) throw new UserError('Choose the entry again.');
      entry = { bureau: bureau!, kind: kind!, value: rest.join('|') };
    }
    await ctx.tx((db) => addMark(db, { orgId: ctx.orgId, userId: ctx.userId, source: 'staff' }, d.clientId, { ...entry, issue: d.issue, correctValue: d.correctValue }));
    revalidatePath(`/app/clients/${d.clientId}`);
    return { ok: 'Marked.' };
  });
}

export async function removePersonalInfoMarkAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const ctx = await requireStaff('clients:write');
  return run(async () => {
    const d = parseForm(z.object({ clientId: zUuid, markId: zUuid }), fd);
    await ctx.tx((db) => removeMark(db, d.clientId, d.markId));
    revalidatePath(`/app/clients/${d.clientId}`);
    return { ok: 'Removed.' };
  });
}

/** One click: an ordinary dispute and a DRAFT correction letter to one bureau, from the entries marked for it. Nothing is sent. */
export async function draftPersonalInfoLetterAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const ctx = await requireStaff('letters:write');
  return run(async () => {
    const d = parseForm(z.object({ clientId: zUuid, bureau: zBureau }), fd);
    const out = await ctx.tx((db) => draftPersonalInfoLetter(db, ctx, d.clientId, d.bureau as Bureau, ctx.session.orgName));
    // Only when the agency turned it on (off by default): the AI wording step, saved as a new draft version.
    await autoTailorDraft(ctx, out.letterId, ctx.tx);
    redirect(`/app/letters/${out.letterId}`);
  });
}

/** Staff record the answers to the "bank account sent to collections" questions for one account. Nothing is drafted or sent. */
export async function saveBankCaseAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const ctx = await requireStaff('clients:write');
  return run(async () => {
    const answer = z.enum(['yes', 'no', 'unsure']);
    const d = parseForm(z.object({ clientId: zUuid, bankName: z.string().trim().min(1, 'Enter the name of the bank').max(160), chargeAccurate: answer, details: many, paid: z.enum(['yes', 'no']), onCreditReports: answer }), fd);
    await ctx.tx((db) => saveBankCase(db, ctx, d.clientId, { bankName: d.bankName, chargeAccurate: d.chargeAccurate, inaccurateDetails: d.details, paid: d.paid, onCreditReports: d.onCreditReports }));
    revalidatePath(`/app/clients/${d.clientId}`);
    return { ok: 'Saved. Open the account above to see its steps.' };
  });
}

export async function removeBankCaseAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const ctx = await requireStaff('clients:write');
  return run(async () => {
    const d = parseForm(z.object({ clientId: zUuid, caseId: zUuid }), fd);
    await ctx.tx((db) => removeBankCase(db, ctx, d.clientId, d.caseId));
    revalidatePath(`/app/clients/${d.clientId}`);
    return { ok: 'Removed.' };
  });
}
