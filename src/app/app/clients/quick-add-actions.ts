'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import type { ActionState } from '@/components/forms';
import { parseForm, run, UserError } from '@/lib/action';
import { audit } from '@/lib/audit';
import { requireStaff } from '@/lib/auth/context';
import { fireTrigger } from '@/lib/automation/engine';
import { findBlockedClaims } from '@/lib/compliance/claims';
import { logEvent } from '@/lib/crm';
import type { Db } from '@/lib/db';
import { emailIsLive } from '@/lib/lead-outreach';
import { holdUnapprovedEmail } from '@/lib/staff-email';
import { issueWelcomeLink, welcomeTextHref, WELCOME_LINK_DAYS, type WelcomeClient } from '@/lib/welcome-link';
import { sendWelcomeEmail } from '@/lib/welcome-send';

/** What each field holds. The page's own limits are the same; a request that goes around them is answered in a sentence. */
const NAME_MAX = 79;
const EMAIL_MAX = 254;
const PHONE_MAX = 30;

/** A name as typed: no spaces around it and single spaces inside it. */
const tidy = (v: string | undefined) => (v ?? '').replace(/\s+/g, ' ').trim();
/** Whether anything of a name can be seen: spaces and characters that take no room on the page are not a name. */
const visible = (v: string) => v.replace(/[\p{Z}\p{Cc}\p{Cf}]/gu, '') !== '';

/**
 * What the email service answered when it did not take the email, as far as it is worth showing: its own sentence when
 * it gave one. A bare status ("HTTP 403") or no connection at all ("fetch failed") is said in the app's words instead;
 * the status stays in the audit entry.
 */
const unreachable = (detail: string) => /^fetch failed$/i.test(detail);
const saidBy = (detail: string) => (unreachable(detail) || /^HTTP \d{3}$/.test(detail) || detail === 'delivery failed' ? '' : detail);

interface Existing { id: string; full_name: string; portal_user_id: string | null; recent: boolean }
/**
 * The client of this workspace who has this email, read under the staff member's row-level security and compared
 * without case or surrounding spaces. Existing records may hold the same email twice: the newest one is returned.
 * `recent` says it was added in the last few minutes, which is what a second press of the button finds.
 */
const clientByEmail = (db: Db, orgId: string, email: string) =>
  db.row<Existing>(
    `select id, full_name, portal_user_id, created_at > now() - interval '10 minutes' as recent
       from public.clients where org_id = $1 and lower(trim(email)) = $2 order by created_at desc, id limit 1`, [orgId, email]);

interface Member { user_id: string; role: string; client_id: string | null; client_name: string | null }
/**
 * Whoever signs in to this workspace with this email: a team member, or a client's portal account (with the client it
 * belongs to, whose email on file may be a different one by now). One person has one place in a workspace, so a
 * welcome link made for such an email could never be accepted. Read under the staff member's row-level security, which
 * shows staff the people of their own workspace; the workspace is named in the query because the same person may be
 * staff in another one.
 */
const memberByEmail = (db: Db, orgId: string, email: string) =>
  db.row<Member>(
    `select m.user_id, m.role, c.id as client_id, c.full_name as client_name
       from public.memberships m join public.users u on u.id = m.user_id
       left join public.clients c on c.org_id = m.org_id and c.portal_user_id = m.user_id
      where m.org_id = $1 and u.email = $2 limit 1`, [orgId, email]);

type Made = { existing: Existing } | { existing: null; client: WelcomeClient; link: string | null };

/** The next step when the email belongs to a different person, such as a couple who share one address. */
const SHARED = 'If this is someone else who shares the address, they need an email address of their own to use the portal. To add them without one, use “Enter everything yourself”.';

/**
 * "Invite a client" on New client: first name, last name, email and (optionally) a phone number are enough. The client
 * is created as the full form creates one (status Onboarding, assigned to the staff member, the same timeline event,
 * audit entry and "a client is created" automations), a welcome link is made, and the welcome email is sent
 * (src/lib/welcome-send.ts). The page stays where it is; what happened comes back in `data.outcome`:
 *  - sent: the email service took the welcome email;
 *  - link: email is not connected, so nothing was emailed; `data.link` is a fresh one-time link to pass on by hand,
 *    and `data.sms` opens the staff member's own messaging app with it when a phone number was typed that can be read
 *    as one (the message says so when it cannot);
 *  - email_failed: the email was not sent (held back by the claims check, or refused by the email service). Its link
 *    was ended, so `data.link` is a new one to pass on by hand;
 *  - unconfirmed: the email service did not answer. The emailed link may be in the client's inbox, so no second link
 *    is handed out; the buttons to send it again are on the client's page;
 *  - added: the client exists but the welcome link could not be made or logged, and nothing was emailed; the client's
 *    page has the buttons;
 *  - duplicate (an error: nothing was created or sent): a client of this workspace already has this email, or it is
 *    the portal sign-in of one; `data.clientId` is theirs.
 *
 * Refused before anything is created, in this order: an email a client of this workspace already has (duplicate), an
 * email that already signs in to this workspace (the staff member's own, a colleague's, a portal account), then the
 * workspace's hourly email limit while it is not approved (holdUnapprovedEmail). Two submissions for the same email
 * (a double click, a retry, two colleagues) cannot both create the client: the check and the insert run under a lock
 * on the workspace and the email, held until the transaction commits, so the second waits and then finds the client
 * the first one made. A personal workspace has no client to invite.
 */
export async function quickAddClientAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const ctx = await requireStaff('clients:write');
  return run(async () => {
    if (ctx.session.orgMode === 'personal') throw new UserError('A personal workspace has no clients to invite.');
    const d = parseForm(
      z.object({
        firstName: z.string().optional(), lastName: z.string().optional(),
        email: z.string().trim().toLowerCase().optional(),
        phone: z.string().trim().optional(),
        preferredLanguage: z.enum(['en', 'es']).default('en'),
      }),
      fd,
    );
    const live = emailIsLive();
    const first = tidy(d.firstName);
    const last = tidy(d.lastName);
    if (!visible(first) || !visible(last)) throw new UserError('Enter the client’s first name and last name.');
    if (first.length > NAME_MAX || last.length > NAME_MAX) throw new UserError(`That name is too long. Use up to ${NAME_MAX} characters for the first name and for the last name.`);
    const email = d.email ?? '';
    if (!email) throw new UserError(`Enter the client’s email address. ${live ? 'The welcome email goes to it.' : 'Their portal account is made for it.'}`);
    if (email.length > EMAIL_MAX || !z.string().email().safeParse(email).success) throw new UserError('That email address does not look right. Check it and try again.');
    const phone = d.phone || undefined;
    if (phone && phone.length > PHONE_MAX) throw new UserError(`That phone number is too long. Use up to ${PHONE_MAX} characters.`);
    const fullName = `${first} ${last}`;

    const firstOf = (name: string) => name.split(' ')[0] || name;
    const duplicate = (c: Existing): ActionState => {
      const theirFirst = firstOf(c.full_name);
      const next = c.portal_user_id ? `${theirFirst} already has portal access.` : `You can send the welcome link from ${theirFirst}’s page.`;
      return {
        // What a second press finds says only what this press did: an email may or may not have gone out the first time.
        error: c.recent
          ? `${c.full_name} was already added with this email in the last few minutes. This time nothing was added and no email was sent. ${next} ${SHARED}`
          : `A client with this email is already in your workspace: ${c.full_name}. Nothing was added and no email was sent. ${next} ${SHARED}`,
        data: { outcome: 'duplicate', clientId: c.id, first: theirFirst },
      };
    };
    // Looked up first, so a press that finds the client is answered without using up one of the workspace's hourly
    // emails. (Submissions that arrive together all get past this before any of them has created the client, so each
    // of those is counted, though only one creates the client and sends the email.)
    const found = await ctx.tx(async (db) => {
      const client = await clientByEmail(db, ctx.orgId, email);
      return { client, member: client ? null : await memberByEmail(db, ctx.orgId, email) };
    });
    if (found.client) return duplicate(found.client);
    if (found.member?.client_id && found.member.client_name) {
      return {
        error: `This email is the portal sign-in of ${found.member.client_name}, a client who is already in your workspace. Nothing was added and no email was sent. ${SHARED}`,
        data: { outcome: 'duplicate', clientId: found.member.client_id, first: firstOf(found.member.client_name) },
      };
    }
    if (found.member) {
      if (found.member.user_id === ctx.userId) {
        throw new UserError(`That is the email you sign in with, so it cannot also be a client’s. Nothing was added. To ${live ? 'see the welcome email' : 'try the welcome link'} yourself, use another email address of yours.${
          live && ctx.can('settings:manage') ? ' To check that email works, use “Send a test email to me” on Get set up.' : ''}`);
      }
      throw new UserError(found.member.role === 'client'
        ? 'This email already has a client portal sign-in in your workspace, so it cannot be used for a new client. Nothing was added. Use a different email address.'
        : 'This email belongs to someone on your team, so it cannot also be a client’s. Nothing was added. Use the client’s own email address.');
    }

    try { await holdUnapprovedEmail(ctx); } catch (e) {
      if (e instanceof UserError) throw new UserError(`${e.message} To add the client now without sending an email, use “Enter everything yourself”.`);
      throw e;
    }

    const actor = { orgId: ctx.orgId, userId: ctx.userId, ip: ctx.meta.ip };
    const made = await ctx.tx(async (db): Promise<Made> => {
      await db.run('select pg_advisory_xact_lock(hashtextextended($1, 31))', [`${ctx.orgId}:${email}`]);
      const existing = await clientByEmail(db, ctx.orgId, email);
      if (existing) return { existing };
      const client = await db.row<WelcomeClient>(
        `insert into public.clients (org_id, assigned_to, full_name, email, phone, preferred_language, status, address)
         values ($1, $2, $3, $4, $5, $6, 'onboarding', $7) returning id, full_name, email, preferred_language, portal_user_id`,
        [ctx.orgId, ctx.userId, fullName, email, phone ?? null, d.preferredLanguage, JSON.stringify({ line1: '', line2: '', city: '', state: '', zip: '' })],
      );
      await logEvent(db, ctx, client!.id, 'client_created', 'Client created');
      await audit(db, { orgId: ctx.orgId, actorId: ctx.userId, action: 'client.created', entityType: 'client', entityId: client!.id, ip: ctx.meta.ip });
      await fireTrigger(db, ctx, 'client_created', { type: 'client', id: client!.id });
      // With no email service there is nothing to wait for: the link to pass on by hand is made with the client.
      const link = live ? null : (await issueWelcomeLink(db, actor, client!, 'copy')).link;
      return { existing: null, client: client!, link };
    });
    if (made.existing) return duplicate(made.existing);
    revalidatePath('/app/clients');

    const { client } = made;
    const base = { clientId: client.id, first };
    // A link to pass on by hand, with the text link when the phone number can be read as one. `note` says so when a
    // number was typed and it cannot, so the text link the page promised is not dropped without a word.
    const byHand = (link: string) => {
      const sms = welcomeTextHref(phone, { lang: d.preferredLanguage, fullName, orgName: ctx.session.orgName, link });
      return { data: { ...base, link, ...(sms ? { sms } : {}) }, note: phone && !sms ? ' The phone number could not be read as a full number, so there is no button to text the link.' : '' };
    };
    const once = `It works once and expires in ${WELCOME_LINK_DAYS} days.`;
    const notConnected = (link: string): ActionState => {
      const h = byHand(link);
      return { ok: `${first} was added. Email is not connected, so no email was sent. Send ${first} this link yourself. ${once}${h.note}`, data: { outcome: 'link', ...h.data } };
    };
    if (made.link) return notConnected(made.link);

    // The client exists from here on, so nothing below may read as "try again": a second submission would be refused.
    try {
      const sent = await sendWelcomeEmail(ctx, client);
      if (sent.status === 'sent') return { ok: `${first} was added. Welcome email sent to ${email}.`, data: { outcome: 'sent', ...base } };
      if (sent.status === 'unconfirmed') {
        return { ok: `${first} was added. The email service did not answer, so the welcome email may or may not have arrived. Ask ${first} before sending it again. You can send it again from ${first}’s page.`, data: { outcome: 'unconfirmed', ...base } };
      }
      // The emailed link was ended with the failed email: a new one is made to pass on by hand.
      const { link } = await ctx.tx((db) => issueWelcomeLink(db, actor, client, 'copy'));
      if (sent.why === 'not_connected') return notConnected(link);
      const h = byHand(link);
      const yourself = `Send ${first} this link yourself. ${once}${h.note}`;
      if (sent.why === 'claims') {
        // The email's own words are fixed, so in practice the wording is in the business name, which every welcome
        // email carries: say so, and that it will be the same for the next client until the name changes.
        const inName = findBlockedClaims(ctx.session.orgName)[0];
        return {
          ok: inName
            ? `${first} was added, but the welcome email was not sent. The email carries your business name, and the name has wording an email may not use: “${inName.excerpt}”. ${inName.why} Welcome emails are held back until the name is changed in Settings. ${yourself}`
            : `${first} was added, but the welcome email was not sent: ${sent.detail.replace('. (“', ' (“')}. ${yourself}`,
          data: { outcome: 'email_failed', ...h.data },
        };
      }
      // Said in the app's words; what the email service answered is quoted after them, for whoever looks into it.
      const down = unreachable(sent.detail);
      const said = saidBy(sent.detail);
      return {
        ok: `${first} was added, but the welcome email to ${email} was not sent: ${down ? 'the email service could not be reached' : 'the email service did not accept it'}. ${yourself}${
          down ? '' : ` If the address has a typo, correct it on ${first}’s page and make a new link there.`}${said ? ` The email service said: “${said}”.` : ''}`,
        data: { outcome: 'email_failed', ...h.data },
      };
    } catch (e) {
      // Reached only when nothing was handed to the email service: once it has the email, sendWelcomeEmail answers
      // with what it said, even if that could not be logged.
      console.error('[quick-add] welcome link', client.id, e);
      return { ok: `${first} was added, but something went wrong with the welcome link. Open ${first}’s page to check it and send it again.`, data: { outcome: 'added', ...base } };
    }
  });
}
