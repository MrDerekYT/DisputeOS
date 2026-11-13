'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import type { ActionState } from '@/components/forms';
import { parseForm, run, UserError, zBool, zDate, zOpt, zText, zUuid } from '@/lib/action';
import { audit } from '@/lib/audit';
import { rewriteSafely } from '@/lib/ai/provider';
import { requireStaff, type Ctx } from '@/lib/auth/context';
import { findBlockedClaims } from '@/lib/compliance/claims';
import { sameProtectedContent } from '@/lib/ai/protected';
import type { Db } from '@/lib/db';
import { createLetter, currentBody, markSent, saveVersion, setLetterStatus, type LActor } from '@/lib/letters/service';
import { KIND_LABEL } from '@/lib/letters/templates';

const actorOf = (ctx: Ctx): LActor => ({ orgId: ctx.orgId, userId: ctx.userId, role: ctx.role, meta: ctx.meta });
const kinds = Object.keys(KIND_LABEL) as [keyof typeof KIND_LABEL, ...(keyof typeof KIND_LABEL)[]];

export async function createLetterAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const ctx = await requireStaff('letters:write');
  return run(async () => {
    const d = parseForm(
      z.object({ clientId: zUuid, disputeId: zUuid.optional().or(z.literal('')), templateKey: zText(80), reason: zOpt(4000), recipientName: zOpt(160), recipientAddress: zOpt(300), includeSsn: zBool }),
      fd,
    );
    let id = '';
    await ctx.tx(async (db) => {
      id = await createLetter(db, actorOf(ctx), {
        clientId: d.clientId, disputeId: d.disputeId || null, templateKey: d.templateKey, reasonOverride: d.reason, recipientName: d.recipientName,
        recipientAddress: d.recipientAddress, includeSsnLast4: d.includeSsn, orgName: ctx.session.orgName,
      });
    });
    redirect(`/app/letters/${id}`);
  });
}

export async function saveLetterAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const ctx = await requireStaff('letters:write');
  return run(async () => {
    const d = parseForm(z.object({ id: zUuid, body: z.string().min(20, 'The letter is empty').max(30000), note: zOpt(300) }), fd);
    const v = await ctx.tx((db) => saveVersion(db, actorOf(ctx), d.id, d.body, 'manual_edit', d.note));
    revalidatePath(`/app/letters/${d.id}`);
    return { ok: `Saved as version ${v}. Any earlier approval no longer applies.` };
  });
}

export async function letterStatusAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const ctx = await requireStaff('letters:write');
  return run(async () => {
    const d = parseForm(z.object({ id: zUuid, to: z.enum(['pending_approval', 'approved', 'draft', 'void']) }), fd);
    await ctx.tx((db) => setLetterStatus(db, actorOf(ctx), d.id, d.to));
    revalidatePath(`/app/letters/${d.id}`);
    revalidatePath('/app/letters');
    return { ok: { pending_approval: 'Sent for approval.', approved: 'Approved. It can now be downloaded and mailed.', draft: 'Returned to draft.', void: 'Voided.' }[d.to] };
  });
}

export async function markSentAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const ctx = await requireStaff('letters:write');
  return run(async () => {
    const d = parseForm(z.object({ id: zUuid, method: z.enum(['certified_mail', 'first_class_mail', 'portal', 'manual']), tracking: zOpt(80), sentOn: zDate.optional().or(z.literal('')) }), fd);
    await ctx.tx((db) => markSent(db, actorOf(ctx), d.id, d.method, d.tracking, d.sentOn || null));
    revalidatePath(`/app/letters/${d.id}`);
    return { ok: 'Recorded as sent. This is a staff record, not a carrier confirmation.' };
  });
}

export async function restoreVersionAction(fd: FormData) {
  const ctx = await requireStaff('letters:write');
  const d = parseForm(z.object({ id: zUuid, version: z.coerce.number().int().min(1) }), fd);
  await ctx.tx(async (db) => {
    const v = await db.row<{ body: string }>('select body from public.letter_versions where letter_id = $1 and version = $2', [d.id, d.version]);
    if (!v) throw new UserError('Version not found.');
    await saveVersion(db, actorOf(ctx), d.id, v.body, 'manual_edit', `Restored version ${d.version}`);
  });
  revalidatePath(`/app/letters/${d.id}`);
}

/** Names that must never be editable by the model for this letter: the client, the recipient and the creditor. */
async function protectedTermsFor(db: Db, letterId: string): Promise<string[]> {
  const r = await db.row<{ client: string; recipient: string | null; creditor: string | null; item: string | null }>(
    `select c.full_name as client, d.recipient_name as recipient, t.creditor_name as creditor, d.item_label as item
       from public.letters l join public.clients c on c.id = l.client_id
       left join public.disputes d on d.id = l.dispute_id left join public.tradelines t on t.id = d.tradeline_id
      where l.id = $1`, [letterId]);
  if (!r) return [];
  return [r.client, ...r.client.split(/\s+/).filter((w) => w.length > 2), r.recipient, r.creditor, r.item].filter((x): x is string => !!x);
}

/**
 * Step 1 of AI wording help: produce a suggestion and show it next to the current text. NOTHING is saved here.
 * The model only receives the connective wording; every fact-bearing passage is hidden behind a marker and restored
 * server-side (src/lib/ai/protected.ts).
 */
export async function aiSuggestLetterAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const ctx = await requireStaff('letters:write');
  return run(async () => {
    const d = parseForm(z.object({ id: zUuid }), fd);
    const loaded = await ctx.tx(async (db) => ({ cur: await currentBody(db, d.id), terms: await protectedTermsFor(db, d.id) }));
    if (!loaded.cur) throw new UserError('Letter not found.');
    const out = await rewriteSafely(loaded.cur.body, 'Polish the wording of this consumer letter so it is clear, courteous and concise.', undefined, loaded.terms);
    if (!out.usedAi) return { error: out.provider === 'rules' ? 'No AI provider is configured (AI_PROVIDER). The letter is unchanged.' : out.note ?? 'The AI suggestion was not safe to use, so nothing changed.' };
    return { ok: 'Suggestion ready. Compare it with the current text below. Nothing has been saved.', data: { before: loaded.cur.body, after: out.text, version: String(loaded.cur.version), provider: out.provider } };
  });
}

/**
 * Step 2: a person accepts the suggestion they just compared. The text is re-checked on the server against the
 * letter as it is NOW (it may not be the version the suggestion was made from, and the browser is not trusted):
 * every protected passage must be unchanged. It is saved as a new draft version, which still needs approval.
 */
export async function aiAcceptLetterAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const ctx = await requireStaff('letters:write');
  return run(async () => {
    const d = parseForm(z.object({ id: zUuid, version: z.coerce.number().int().min(1), text: z.string().min(20).max(30000), provider: zOpt(80) }), fd);
    const v = await ctx.tx(async (db) => {
      const cur = await currentBody(db, d.id);
      if (!cur) throw new UserError('Letter not found.');
      if (cur.version !== d.version) throw new UserError('The letter changed after this suggestion was made. Ask for a new suggestion.');
      if (!sameProtectedContent(cur.body, d.text, await protectedTermsFor(db, d.id))) throw new UserError('This suggestion changes a name, amount, date or dispute statement, so it was not saved.');
      const claims = findBlockedClaims(d.text);
      if (claims.length) throw new UserError(`This suggestion contains a prohibited claim (${claims[0]!.why}), so it was not saved.`);
      return saveVersion(db, actorOf(ctx), d.id, d.text, 'ai_draft', `AI wording suggestion accepted by staff (${d.provider ?? 'ai'})`);
    });
    revalidatePath(`/app/letters/${d.id}`);
    return { ok: `Saved as version ${v}. It is a draft: read it once more, then send it for approval.` };
  });
}

// ---------------------------------------------------------------- organisation templates (manager+)
export async function saveTemplateAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const ctx = await requireStaff('letters:approve');
  return run(async () => {
    const d = parseForm(
      z.object({ id: zUuid.optional().or(z.literal('')), name: zText(160), kind: z.enum(kinds), language: z.enum(['en', 'es']), body: z.string().trim().min(40, 'Template is too short').max(20000), baseKey: zOpt(80) }),
      fd,
    );
    const claims = findBlockedClaims(d.body);
    if (claims.length) throw new UserError(`Template contains a prohibited claim: “${claims[0]!.excerpt}” — ${claims[0]!.why}`);
    let id = d.id;
    await ctx.tx(async (db) => {
      if (d.id) {
        await db.run('update public.letter_templates set name = $2, kind = $3, language = $4, body = $5, version = version + 1 where id = $1', [d.id, d.name, d.kind, d.language, d.body]);
      } else {
        const r = await db.row<{ id: string }>('insert into public.letter_templates (org_id, base_key, name, kind, language, body, created_by) values ($1,$2,$3,$4,$5,$6,$7) returning id', [ctx.orgId, d.baseKey ?? null, d.name, d.kind, d.language, d.body, ctx.userId]);
        id = r!.id;
      }
      await audit(db, { orgId: ctx.orgId, actorId: ctx.userId, action: d.id ? 'template.updated' : 'template.created', entityType: 'letter_template', entityId: id, ip: ctx.meta.ip });
    });
    redirect('/app/letters?tab=templates');
  });
}

export async function toggleTemplateAction(fd: FormData) {
  const ctx = await requireStaff('letters:approve');
  const d = parseForm(z.object({ id: zUuid }), fd);
  await ctx.tx((db) => db.run('update public.letter_templates set active = not active where id = $1', [d.id]));
  revalidatePath('/app/letters');
}

