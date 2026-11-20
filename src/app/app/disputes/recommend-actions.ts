'use server';

import { redirect } from 'next/navigation';
import { z } from 'zod';
import type { ActionState } from '@/components/forms';
import { parseForm, run, UserError, zUuid } from '@/lib/action';
import { requireStaff, type Ctx } from '@/lib/auth/context';
import { requestProcedureDescription } from '@/lib/disputes/escalation';
import { recommendLetter } from '@/lib/letters/brief';
import { loadBrief } from '@/lib/letters/brief-load';
import { createLetter, type LActor } from '@/lib/letters/service';
import { autoTailorDraft } from '@/lib/letters/tailor-load';
import { procedureTemplateKey } from '@/lib/letters/templates';

const actorOf = (ctx: Ctx): LActor => ({ orgId: ctx.orgId, userId: ctx.userId, role: ctx.role, meta: ctx.meta });

/**
 * "Draft this letter" under a dispute's recommended letter. The recommendation is worked out again here from the file
 * as it is now (the page may be stale and the browser is not trusted), then the letter goes through the ordinary
 * pipeline: a DRAFT that a person reads, sends for approval and mails. Nothing is approved or sent from here.
 */
export async function draftRecommendedLetterAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const ctx = await requireStaff('letters:write');
  return run(async () => {
    const d = parseForm(z.object({ id: zUuid }), fd);
    let letterId = '';
    await ctx.tx(async (db) => {
      const row = await db.row<{ client_id: string }>('select client_id from public.disputes where id = $1', [d.id]);
      const brief = row ? await loadBrief(db, row.client_id, d.id) : null;
      if (!row || !brief) throw new UserError('Dispute not found.');
      const rec = recommendLetter(brief);
      if (!rec.templateKey) throw new UserError(rec.reason);
      if (rec.missing.length) throw new UserError(rec.missing.join(' '));
      if (rec.exists) throw new UserError('A letter of this kind is already on this dispute. Open it from the list, or choose another letter.');
      // The request for the reinvestigation procedure has its own rules (one at a time, a note on the dispute).
      letterId = rec.templateKey === procedureTemplateKey()
        ? await requestProcedureDescription(db, actorOf(ctx), d.id, ctx.session.orgName)
        : await createLetter(db, actorOf(ctx), { clientId: row.client_id, disputeId: d.id, templateKey: rec.templateKey, orgName: ctx.session.orgName });
    });
    // Only when the agency turned it on (off by default): the AI wording step, saved as a new draft version.
    await autoTailorDraft(actorOf(ctx), letterId, ctx.tx);
    redirect(`/app/letters/${letterId}`);
  });
}
