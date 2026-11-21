'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import type { ActionState } from '@/components/forms';
import { parseForm, run, UserError, zText } from '@/lib/action';
import { audit } from '@/lib/audit';
import { requireStaff } from '@/lib/auth/context';
import { parseDollars, parseTerms, storedTerms, termsIssue } from '@/lib/compliance/agreement-terms';

/**
 * Saves the agency's client agreement terms (Settings → Client agreement), owners and admins only. Every field is
 * checked on the server (src/lib/compliance/agreement-terms.ts): the contract claims check refuses the common promises
 * of a result and the advance-fee check the common ways of asking for payment before the work is done (§ 1679b(b)).
 * Both are lists of rules, not a legal review. Signatures already on file keep the exact text they were signed with;
 * only new signatures use the new terms.
 */
export async function saveAgreementAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const ctx = await requireStaff('settings:manage');
  return run(async () => {
    const d = parseForm(z.object({
      legalName: zText(160), address: z.string().trim().max(160), services: z.string().trim().max(4000), paymentTerms: z.string().trim().max(2000),
      total: z.string().trim().max(20), duration: z.string().trim().max(300), additional: z.string().trim().max(8000).optional(),
    }), fd);
    const totalCents = parseDollars(d.total);
    if (totalCents === null) throw new UserError('Total of all payments: enter the amount in dollars, for example 594.00.');
    const terms = { legalName: d.legalName, address: d.address, services: d.services, paymentTerms: d.paymentTerms, totalCents, duration: d.duration, additional: d.additional ?? '' };
    const issue = termsIssue(terms);
    if (issue) throw new UserError(issue);
    await ctx.tx(async (db) => {
      const o = await db.row<{ settings: Record<string, unknown> | null }>('select settings from public.organizations where id = $1', [ctx.orgId]);
      const before = parseTerms(o?.settings);
      const changed = before ? (Object.keys(terms) as (keyof typeof terms)[]).filter((k) => before[k] !== terms[k]) : ['first_saved'];
      const saved = await db.run("update public.organizations set settings = settings || jsonb_build_object('agreement', $2::jsonb) where id = $1",
        [ctx.orgId, JSON.stringify(storedTerms({ ...terms, updatedAt: new Date().toISOString(), updatedBy: ctx.userId }))]);
      if (!saved) throw new UserError('Only an owner or admin can change the client agreement.');
      await audit(db, { orgId: ctx.orgId, actorId: ctx.userId, action: 'org.agreement_updated', entityType: 'organization', entityId: ctx.orgId, ip: ctx.meta.ip, meta: { changed: changed.join(', ') } });
    });
    revalidatePath('/app/settings');
    return { ok: 'Client agreement saved. New signatures use these terms; agreements already signed keep the exact text they were signed with.' };
  });
}
