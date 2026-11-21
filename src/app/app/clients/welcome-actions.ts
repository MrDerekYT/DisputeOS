'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import type { ActionState } from '@/components/forms';
import { parseForm, run, UserError, zUuid } from '@/lib/action';
import { requireStaff } from '@/lib/auth/context';
import { rateLimit } from '@/lib/auth/rate-limit';
import { emailIsLive } from '@/lib/lead-outreach';
import { delivers, sendEmail } from '@/lib/mailer';
import { holdUnapprovedEmail } from '@/lib/staff-email';
import {
  expireWelcomeLinks, issueWelcomeLink, logWelcomeEmail, portalSignInUrl, providerError, welcomeClient, welcomeEmail, welcomeEmailIssue, welcomeLinkProblem,
  WELCOME_LINKS_PER_DAY, type WelcomeClient,
} from '@/lib/welcome-link';

type StaffCtx = Awaited<ReturnType<typeof requireStaff>>;

/**
 * The checks both buttons share: the client is this agency's, has an email and no portal account yet. Then `hold`
 * (the workspace's email limit, for the email button) and the per-client daily limit, both before anything is made.
 */
async function prepare(ctx: StaffCtx, fd: FormData, hold?: () => Promise<void>): Promise<WelcomeClient> {
  const { clientId } = parseForm(z.object({ clientId: zUuid }), fd);
  const client = await ctx.tx((db) => welcomeClient(db, clientId));
  const problem = welcomeLinkProblem(client);
  if (problem) throw new UserError(problem);
  if (hold) await hold();
  const limit = await rateLimit(`welcome-link:client:${clientId}`, WELCOME_LINKS_PER_DAY, 86_400);
  if (!limit.allowed) throw new UserError(`${WELCOME_LINKS_PER_DAY} welcome links were made for this client today. Use the latest one, or try again tomorrow.`);
  return client!;
}

/**
 * "Copy welcome link": a fresh one-time link to share however the agency likes. Earlier unused links stop working.
 * The link comes back in `data.link`; the card shows it with a copy button.
 */
export async function copyWelcomeLinkAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const ctx = await requireStaff('clients:write');
  return run(async () => {
    const client = await prepare(ctx, fd);
    const { link } = await ctx.tx((db) => issueWelcomeLink(db, { orgId: ctx.orgId, userId: ctx.userId, ip: ctx.meta.ip }, client, 'copy'));
    revalidatePath(`/app/clients/${client.id}`);
    return { ok: 'Share this one-time link with the client. It works once and expires in 7 days; any earlier link no longer works.', data: { link } };
  });
}

/**
 * "Email welcome link": the same link in a warm email in the client's language, from the agency's name with replies
 * going to the agency's own address. Only when email really delivers, under the workspace's hourly limit before the
 * operator's approval, and never with a prohibited claim in it. A link whose email failed is expired at once.
 *
 * The timeline and the audit log say "emailed" only once the email service took the email ("may not have arrived" when
 * it did not answer); an email that was not sent is logged as failed, with its link ended (logWelcomeEmail).
 */
export async function emailWelcomeLinkAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const ctx = await requireStaff('clients:write');
  return run(async () => {
    if (!emailIsLive()) throw new UserError('Email is not connected, so nothing can be emailed. Use “Copy welcome link” and send the link yourself.');
    const client = await prepare(ctx, fd, () => holdUnapprovedEmail(ctx));
    const org = await ctx.tx((db) => db.row<{ reply: string | null }>("select nullif(trim(settings->>'lead_reply_email'), '') as reply from public.organizations where id = $1", [ctx.orgId]));
    const actor = { orgId: ctx.orgId, userId: ctx.userId, ip: ctx.meta.ip };
    const { link, expired } = await ctx.tx((db) => issueWelcomeLink(db, actor, client, 'email'));
    const lang = client.preferred_language === 'es' ? 'es' : 'en';
    const mail = welcomeEmail({ lang, fullName: client.full_name, orgName: ctx.session.orgName, link, signIn: portalSignInUrl({ mode: ctx.session.orgMode, slug: ctx.session.orgSlug }, lang) });
    // Not sent: the link is ended and the failure logged, in one transaction.
    const fail = async (reason: string) => {
      await ctx.tx(async (db) => { await expireWelcomeLinks(db, client.id); await logWelcomeEmail(db, actor, client.id, { status: 'failed', reason }, expired); });
      revalidatePath(`/app/clients/${client.id}`);
    };
    const issue = welcomeEmailIssue(mail);
    if (issue) { await fail(`claims check: ${issue}`); throw new UserError(`The welcome email was not sent: ${issue}. Use “Copy welcome link” instead.`); }
    const sent = await sendEmail({ to: client.email!, ...mail, fromName: ctx.session.orgName, ...(org?.reply ? { replyTo: org.reply } : {}) });
    if (!delivers(sent)) { await fail('email is not connected'); throw new UserError('Email is not connected, so nothing was sent. Use “Copy welcome link” instead.'); }
    if (sent.ok || sent.unconfirmed) {
      await ctx.tx((db) => logWelcomeEmail(db, actor, client.id, { status: sent.ok ? 'sent' : 'unconfirmed' }, expired));
      revalidatePath(`/app/clients/${client.id}`);
      return sent.ok ? { ok: `Invitation emailed to ${client.email}.` } : { error: 'The email service did not answer, so it may or may not have arrived. Ask the client before sending the welcome link again.' };
    }
    const why = providerError(sent.error);
    await fail(why);
    return { error: `Could not send the email: ${why}. Nothing was sent; use “Copy welcome link” instead.` };
  });
}
