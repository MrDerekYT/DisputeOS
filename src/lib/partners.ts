/**
 * What a staff member does to a referral partner record. Every function runs inside the caller's tenant transaction,
 * so row-level security decides whose partners can be touched, and each change lands on the partner's timeline and
 * in the audit log. None of this sends anything: the email sequence is sent by the scheduled job
 * (src/lib/partner-outreach.ts), and nothing anywhere texts or calls a partner.
 */
import { audit } from './audit';
import type { Db } from './db';
import { markPartnerOptedOut } from './partner-outreach';
import type { PartnerInput } from './partner-import';

export interface PartnerActor { orgId: string; userId: string; ip?: string | null }

const event = (db: Db, a: PartnerActor, partnerId: string, kind: string, summary: string) =>
  db.run('insert into public.partner_events (org_id, partner_id, actor_id, kind, summary) values ($1, $2, $3, $4, $5)', [a.orgId, partnerId, a.userId, kind, summary.slice(0, 300)]);

/** What a person can record about a partner. Each one stops the automatic emails. */
export const PARTNER_MARKS = ['replied', 'interested', 'not_interested', 'bounced'] as const;
export type PartnerMark = (typeof PARTNER_MARKS)[number];
const MARK_SUMMARY: Record<PartnerMark, string> = {
  replied: 'Marked as replied. The automatic emails stopped; the reply itself is in your own mailbox.',
  interested: 'Marked as interested. The automatic emails stopped.',
  not_interested: 'Marked as not interested. No further automatic email is sent.',
  bounced: 'Marked as bounced: an email to this address came back undelivered. No further automatic email is sent.',
};

/**
 * "They replied", "Interested", "Not interested", "Bounced". Replies and bounce notices arrive outside this system
 * (in the agency's own mailbox or its email service), so a person records them here.
 *
 * A partner who opted out of the emails stays opted out whatever is pressed: the stop is the opt-out stamp, which
 * nothing here touches and the database will not lift. They may still write or call, so that they replied, are
 * interested or are not interested can be recorded for them too; none of that sends anything. ("Bounced" is about an
 * address that is being written to, so it does not apply to one that no longer is.)
 */
export async function markPartner(db: Db, a: PartnerActor, partnerId: string, mark: PartnerMark): Promise<boolean> {
  // A recorded answer supersedes a manual pause, so the pause is cleared with it.
  const changed = await db.run(
    "update public.partners set status = $2, paused_at = null where id = $1 and org_id = $3 and status <> $2 and (opted_out_at is null or $2 <> 'bounced')", [partnerId, mark, a.orgId]);
  if (!changed) return false;
  const stopped = await db.row<{ opted_out: boolean }>('select (opted_out_at is not null) as opted_out from public.partners where id = $1', [partnerId]);
  await event(db, a, partnerId, mark, stopped?.opted_out ? `${MARK_SUMMARY[mark].split('.')[0]}. This address opted out of the emails and is still never emailed.` : MARK_SUMMARY[mark]);
  await audit(db, { orgId: a.orgId, actorId: a.userId, action: 'partner.marked', entityType: 'partner', entityId: partnerId, ip: a.ip, meta: { status: mark } });
  return true;
}

/** Manual pause: the sequence waits for this partner until it is resumed. Nothing already sent is affected. */
export async function pausePartner(db: Db, a: PartnerActor, partnerId: string): Promise<boolean> {
  const changed = await db.run("update public.partners set paused_at = now() where id = $1 and org_id = $2 and paused_at is null and status in ('new', 'in_sequence')", [partnerId, a.orgId]);
  if (changed) await event(db, a, partnerId, 'paused', 'Sequence paused. No automatic email is sent until it is resumed.');
  return changed > 0;
}
export async function resumePartner(db: Db, a: PartnerActor, partnerId: string): Promise<boolean> {
  const changed = await db.run('update public.partners set paused_at = null where id = $1 and org_id = $2 and paused_at is not null', [partnerId, a.orgId]);
  if (changed) await event(db, a, partnerId, 'resumed', 'Sequence resumed.');
  return changed > 0;
}

/** The partner asked, by reply, phone or any other way, not to be emailed. Same effect as the opt-out link: permanent. */
export async function partnerAskedToStop(db: Db, a: PartnerActor, partnerId: string): Promise<boolean> {
  const changed = await markPartnerOptedOut(db, { orgId: a.orgId, partnerId, actorId: a.userId, summary: 'Asked not to be emailed (recorded by the team). No further email is sent to this address.' });
  if (changed) await audit(db, { orgId: a.orgId, actorId: a.userId, action: 'partner.opted_out', entityType: 'partner', entityId: partnerId, ip: a.ip });
  return changed;
}

/**
 * Asks for another try of an email that failed: the email service refused it, or this app's own claims guard did.
 * Row-level security allows exactly this change ('failed' -> 'retry'); the scheduled job then sends it, at most three
 * attempts in all. An email the service gave no answer for is not 'failed' and cannot be tried again: it may have
 * gone out.
 */
export async function retryPartnerStep(db: Db, a: PartnerActor, partnerId: string): Promise<boolean> {
  const changed = await db.run("update public.partner_outreach set status = 'retry' where partner_id = $1 and org_id = $2 and status = 'failed'", [partnerId, a.orgId]);
  if (changed) await event(db, a, partnerId, 'retry', 'Asked to try the email that failed again. It goes out with the next scheduled run.');
  return changed > 0;
}

/** Removes a partner nothing was ever sent to and no client is linked to (row-level security refuses any other). */
export async function removePartner(db: Db, a: PartnerActor, partnerId: string): Promise<boolean> {
  const changed = await db.run('delete from public.partners where id = $1 and org_id = $2', [partnerId, a.orgId]);
  if (changed) await audit(db, { orgId: a.orgId, actorId: a.userId, action: 'partner.removed', entityType: 'partner', entityId: partnerId, ip: a.ip });
  return changed > 0;
}

/** Edits the details of a partner. The email address is not among them: it cannot change (add a new partner instead). */
export async function updatePartner(db: Db, a: PartnerActor, partnerId: string, d: Omit<PartnerInput, 'email'>): Promise<boolean> {
  const changed = await db.run(
    `update public.partners set business_name = $3, contact_name = $4, category = $5, phone = $6, city = $7, state = $8, language = $9, source_note = $10
      where id = $1 and org_id = $2`, [partnerId, a.orgId, d.businessName, d.contactName, d.category, d.phone, d.city, d.state, d.language, d.sourceNote]);
  if (changed) await event(db, a, partnerId, 'updated', 'Details updated.');
  return changed > 0;
}

/**
 * "Referred by" on a client: links the client to the one partner who sent them, changes it, or clears it (null).
 * Both must belong to the caller's organization; row-level security refuses anything else.
 */
export async function setReferredBy(db: Db, a: PartnerActor, clientId: string, partnerId: string | null): Promise<void> {
  const before = await db.row<{ partner_id: string }>('select partner_id from public.partner_referrals where client_id = $1 and org_id = $2', [clientId, a.orgId]);
  if ((before?.partner_id ?? null) === partnerId) return;
  if (!partnerId) {
    await db.run('delete from public.partner_referrals where client_id = $1 and org_id = $2', [clientId, a.orgId]);
  } else {
    await db.run(
      `insert into public.partner_referrals (client_id, partner_id, org_id, created_by) values ($1, $2, $3, $4)
       on conflict (client_id) do update set partner_id = excluded.partner_id, created_by = excluded.created_by, created_at = now()`, [clientId, partnerId, a.orgId, a.userId]);
    await event(db, a, partnerId, 'referral', 'A client was linked to this partner as referred by them.');
  }
  await db.run("insert into public.client_events (org_id, client_id, actor_id, kind, summary) values ($1, $2, $3, 'referred_by', $4)",
    [a.orgId, clientId, a.userId, partnerId ? 'Referred-by partner recorded' : 'Referred-by partner cleared']);
  await audit(db, { orgId: a.orgId, actorId: a.userId, action: 'client.referred_by', entityType: 'client', entityId: clientId, ip: a.ip, meta: { linked: partnerId !== null } });
}
