'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import type { ActionState } from '@/components/forms';
import { parseForm, run, UserError, zBool, zOpt, zText, zUuid } from '@/lib/action';
import { audit } from '@/lib/audit';
import { rewriteSafely } from '@/lib/ai/provider';
import { requireStaff, type Ctx } from '@/lib/auth/context';
import { findBlockedClaims } from '@/lib/compliance/claims';
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
    const d = parseForm(z.object({ id: zUuid, method: z.enum(['certified_mail', 'first_class_mail', 'portal', 'manual']), tracking: zOpt(80) }), fd);
    await ctx.tx((db) => markSent(db, actorOf(ctx), d.id, d.method, d.tracking));
    revalidatePath(`/app/letters/${d.id}`);
    return { ok: 'Recorded as sent.' };
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

/** Optional wording polish. Only kept if every fact survives and no prohibited claim appears; otherwise nothing changes. */
export async function aiAssistLetterAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const ctx = await requireStaff('letters:write');
  return run(async () => {
    const d = parseForm(z.object({ id: zUuid }), fd);
    const cur = await ctx.tx((db) => currentBody(db, d.id));
    if (!cur) throw new UserError('Letter not found.');
    const out = await rewriteSafely(cur.body, 'Polish this consumer letter: clear, courteous, concise. Keep the structure, headings and all legal citations exactly.');
    if (!out.usedAi) return { error: out.provider === 'rules' ? 'No AI provider is configured (AI_PROVIDER). The template wording is unchanged.' : out.note ?? 'The AI suggestion was not safe to use, so nothing changed.' };
    const v = await ctx.tx((db) => saveVersion(db, actorOf(ctx), d.id, out.text, 'ai_draft', `AI wording suggestion (${out.provider})`));
    revalidatePath(`/app/letters/${d.id}`);
    return { ok: `AI suggestion saved as version ${v}. Review it carefully — it still needs approval.` };
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

