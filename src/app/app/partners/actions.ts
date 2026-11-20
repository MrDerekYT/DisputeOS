'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import type { ActionState } from '@/components/forms';
import { parseForm, run, UserError, zBool, zUuid } from '@/lib/action';
import { audit } from '@/lib/audit';
import { requireStaff } from '@/lib/auth/context';
import { mailingAddressIssue } from '@/lib/mailing-address';
import { isPartnerCategory, PARTNER_CATEGORIES } from '@/lib/partner-emails';
import { parsePartnerList, PARTNER_ATTESTATION, PARTNER_IMPORT_MAX_CHARS, partnerSchema } from '@/lib/partner-import';
import { addPartners } from '@/lib/partner-outreach';
import { markPartner, PARTNER_MARKS, partnerAskedToStop, pausePartner, removePartner, resumePartner, retryPartnerStep, setReferredBy, updatePartner } from '@/lib/partners';

const ATTEST_FIRST = 'Tick the box to confirm where these contacts came from. Partners are only added from public business contact details and your own contacts.';
const fields = (fd: FormData) => ({
  businessName: fd.get('businessName') ?? '', contactName: fd.get('contactName') ?? '', category: fd.get('category') ?? '', email: fd.get('email') ?? '',
  phone: fd.get('phone') ?? '', city: fd.get('city') ?? '', state: fd.get('state') ?? '', language: fd.get('language') === 'es' ? 'es' : 'en', sourceNote: fd.get('sourceNote') ?? '',
});
const firstIssue = (e: z.ZodError) => e.issues[0]?.message ?? 'Please check the form.';

/**
 * Adds one partner. The person confirms where the contact came from: who confirmed it is stored on the row, and the
 * sentence they ticked on the audit entry.
 */
export async function addPartnerAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const ctx = await requireStaff('clients:write');
  return run(async () => {
    if (!parseForm(z.object({ attest: zBool }), fd).attest) throw new UserError(ATTEST_FIRST);
    const r = partnerSchema.safeParse(fields(fd));
    if (!r.success) throw new UserError(firstIssue(r.error));
    const out = await ctx.tx(async (db) => {
      const res = await addPartners(db, { orgId: ctx.orgId, userId: ctx.userId }, [r.data], 'Added by hand. The person who added it confirmed it is a public business contact or one of the agency’s own.');
      if (res.added) await audit(db, { orgId: ctx.orgId, actorId: ctx.userId, action: 'partner.added', entityType: 'partner', entityId: res.ids[0], ip: ctx.meta.ip, meta: { attestation: PARTNER_ATTESTATION } });
      return res;
    });
    if (!out.added) throw new UserError('That email address is already on your partner list, perhaps in another spelling: a “+tag”, and for Gmail the dots, do not make a different mailbox. A mailbox is only ever listed once, and one that opted out stays opted out.');
    revalidatePath('/app/partners');
    return { ok: `${r.data.businessName} was added. Nothing is sent until the email sequence is switched on.` };
  });
}

/**
 * Adds a pasted or uploaded list. Rows that are not valid are left out and named; addresses repeated in the list or
 * already on file (in any spelling of the same mailbox) are skipped. Nothing is fetched or looked up: the list is
 * whatever the agency compiled. The sentence the person ticked is kept on the audit entry.
 */
export async function importPartnersAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const ctx = await requireStaff('clients:write');
  return run(async () => {
    const d = parseForm(z.object({ attest: zBool, defaultCategory: z.union([z.enum(PARTNER_CATEGORIES), z.literal('')]).optional(), list: z.string().max(PARTNER_IMPORT_MAX_CHARS, 'That list is too large. Import it in parts of up to 200 rows.').optional() }), fd);
    if (!d.attest) throw new UserError(ATTEST_FIRST);
    const file = fd.get('file');
    let text = d.list?.trim() ?? '';
    if (!text && file instanceof File && file.size > 0) {
      if (file.size > PARTNER_IMPORT_MAX_CHARS) throw new UserError('That file is too large. Import it in parts of up to 200 rows.');
      text = await file.text();
    }
    if (!text) throw new UserError('Paste your list, or choose a .csv file.');
    const parsed = parsePartnerList(text, isPartnerCategory(d.defaultCategory) ? d.defaultCategory : null);
    if (parsed.error) throw new UserError(parsed.error);
    const problems = parsed.issues.length ? ` Left out: ${parsed.issues.slice(0, 5).map((i) => `line ${i.line} (${i.message})`).join('; ')}${parsed.issues.length > 5 ? `; and ${parsed.issues.length - 5} more` : ''}.` : '';
    if (!parsed.rows.length) throw new UserError(`No row could be added.${problems}`);
    const out = await ctx.tx(async (db) => {
      const res = await addPartners(db, { orgId: ctx.orgId, userId: ctx.userId }, parsed.rows, 'Imported from a list. The person who imported it confirmed it was compiled from public business contact details and the agency’s own contacts.');
      await audit(db, { orgId: ctx.orgId, actorId: ctx.userId, action: 'partners.imported', entityType: 'organization', entityId: ctx.orgId, ip: ctx.meta.ip, meta: { added: res.added, already_listed: res.existing, repeated: parsed.repeated, left_out: parsed.issues.length, attestation: PARTNER_ATTESTATION } });
      return res;
    });
    revalidatePath('/app/partners');
    const skipped = out.existing + parsed.repeated;
    return { ok: `${out.added} added.${skipped ? ` ${skipped} skipped: already on your list or repeated in this one.` : ''}${problems} Nothing is sent until the email sequence is switched on.` };
  });
}

/** Edits a partner's details. The email address is never editable (add a new partner instead). */
export async function updatePartnerAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const ctx = await requireStaff('clients:write');
  return run(async () => {
    const { id } = parseForm(z.object({ id: zUuid }), fd);
    const r = partnerSchema.omit({ email: true }).safeParse(fields(fd));
    if (!r.success) throw new UserError(firstIssue(r.error));
    const changed = await ctx.tx((db) => updatePartner(db, { orgId: ctx.orgId, userId: ctx.userId, ip: ctx.meta.ip }, id, r.data));
    if (!changed) throw new UserError('Partner not found.');
    revalidatePath(`/app/partners/${id}`);
    revalidatePath('/app/partners');
    return { ok: 'Saved.' };
  });
}

const refresh = (id: string) => { revalidatePath('/app/partners'); revalidatePath(`/app/partners/${id}`); };

/**
 * "They replied", "Interested", "Not interested", "Bounced". A reply reaches the agency's own mailbox, which this
 * system cannot read, so a person records it here; that stops the automatic emails to this partner.
 */
export async function markPartnerAction(fd: FormData) {
  const ctx = await requireStaff('clients:write');
  const d = parseForm(z.object({ id: zUuid, mark: z.enum(PARTNER_MARKS) }), fd);
  await ctx.tx((db) => markPartner(db, { orgId: ctx.orgId, userId: ctx.userId, ip: ctx.meta.ip }, d.id, d.mark));
  refresh(d.id);
}

export async function pausePartnerAction(fd: FormData) {
  const ctx = await requireStaff('clients:write');
  const d = parseForm(z.object({ id: zUuid, paused: z.enum(['1', '0']) }), fd);
  await ctx.tx((db) => (d.paused === '1' ? pausePartner : resumePartner)(db, { orgId: ctx.orgId, userId: ctx.userId, ip: ctx.meta.ip }, d.id));
  refresh(d.id);
}

/** "Asked to stop": same effect as the opt-out link in the email. Permanent for that address. */
export async function partnerAskedToStopAction(fd: FormData) {
  const ctx = await requireStaff('clients:write');
  const d = parseForm(z.object({ id: zUuid }), fd);
  await ctx.tx((db) => partnerAskedToStop(db, { orgId: ctx.orgId, userId: ctx.userId, ip: ctx.meta.ip }, d.id));
  refresh(d.id);
}

export async function retryPartnerAction(fd: FormData) {
  const ctx = await requireStaff('clients:write');
  const d = parseForm(z.object({ id: zUuid }), fd);
  await ctx.tx((db) => retryPartnerStep(db, { orgId: ctx.orgId, userId: ctx.userId, ip: ctx.meta.ip }, d.id));
  refresh(d.id);
}

/** Removes a partner nothing was ever sent to. Anything else stays on file: its history is the record of who was written to. */
export async function removePartnerAction(fd: FormData) {
  const ctx = await requireStaff('clients:write');
  const d = parseForm(z.object({ id: zUuid }), fd);
  const removed = await ctx.tx((db) => removePartner(db, { orgId: ctx.orgId, userId: ctx.userId, ip: ctx.meta.ip }, d.id));
  revalidatePath('/app/partners');
  if (removed) redirect('/app/partners');
  revalidatePath(`/app/partners/${d.id}`);
}

/**
 * The agency-level switch for the partner email sequence, and the postal and reply addresses every such email
 * carries. The two addresses are the same ones the lead follow-up uses; the lead switch is untouched. Switching it on
 * sends nothing by itself: the platform operator approves each workspace for outreach first (src/lib/outreach-approval.ts).
 * The postal address is printed in every email and no approval covers it, so only text shaped like a postal address
 * is saved (src/lib/mailing-address.ts). The earlier "let AI reword" option is gone, and its stored value is cleared:
 * the wording is fixed.
 */
export async function savePartnerOutreachAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const ctx = await requireStaff('settings:manage');
  return run(async () => {
    const d = parseForm(z.object({
      enabled: zBool,
      address: z.string().trim().max(300).optional(),
      replyTo: z.union([z.string().trim().toLowerCase().email('Enter a valid reply email address').max(254), z.literal('')]).optional(),
    }), fd);
    const address = (d.address ?? '').replace(/\s+/g, ' ').trim();
    const replyTo = d.replyTo ?? '';
    // Left blank, the saved address is kept; anything typed has to be shaped like a postal address.
    const addressIssue = address ? mailingAddressIssue(address) : null;
    if (addressIssue) throw new UserError(addressIssue);
    if (d.enabled && (!address || !replyTo)) throw new UserError('To switch the sequence on, enter your mailing address and a reply email address. Commercial email must show a postal address, and partners need a way to answer.');
    await ctx.tx(async (db) => {
      // A field left blank here keeps what is saved: the lead follow-up uses the same two addresses, and they are
      // only ever cleared on the Leads page.
      await db.run(
        `update public.organizations
            set settings = (settings - 'partner_outreach_ai') || jsonb_build_object('partner_outreach_enabled', $2::boolean)
              || case when $3::text <> '' then jsonb_build_object('lead_mailing_address', $3::text) else '{}'::jsonb end
              || case when $4::text <> '' then jsonb_build_object('lead_reply_email', $4::text) else '{}'::jsonb end
          where id = $1 and mode = 'agency'`, [ctx.orgId, d.enabled, address, replyTo]);
      await audit(db, { orgId: ctx.orgId, actorId: ctx.userId, action: 'partner_outreach.updated', entityType: 'organization', entityId: ctx.orgId, ip: ctx.meta.ip, meta: { enabled: d.enabled, has_address: address !== '' } });
    });
    revalidatePath('/app/partners');
    revalidatePath('/app/leads');
    return { ok: d.enabled ? 'Saved. The sequence is switched on. Partners are emailed by the scheduled runs, on business days, once nothing above is in the way.' : 'Saved. The sequence is off.' };
  });
}

/** "Referred by" on a client page: link the client to the partner who sent them, or clear it. */
export async function setReferredByAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const ctx = await requireStaff('clients:write');
  return run(async () => {
    const d = parseForm(z.object({ clientId: zUuid, partnerId: z.union([zUuid, z.literal('')]).optional() }), fd);
    await ctx.tx((db) => setReferredBy(db, { orgId: ctx.orgId, userId: ctx.userId, ip: ctx.meta.ip }, d.clientId, d.partnerId || null));
    revalidatePath(`/app/clients/${d.clientId}`);
    revalidatePath('/app/partners');
    return { ok: d.partnerId ? 'Saved.' : 'Cleared.' };
  });
}
