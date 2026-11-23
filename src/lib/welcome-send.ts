/**
 * Emailing a client their welcome link: make the link, hand the email to the email service, and log what became of
 * it. One function, used by "Email welcome link" on the client page and by "Invite a client" on New client
 * (src/app/app/clients/welcome-actions.ts, quick-add-actions.ts), so both follow the same rules:
 *  - the email is the welcome email in the client's language (./welcome-link.ts), from the agency's name, with replies
 *    going to the agency's own address (Settings: lead_reply_email) when one is saved;
 *  - it is never sent with a prohibited claim in it (the agency's name is part of the email);
 *  - "emailed" is logged only once the email service took the email ("may not have arrived" when it did not answer);
 *  - an email that was not sent is logged as failed and its link is ended at once, in one transaction;
 *  - once the email has been handed over, what the email service said is the answer. If that log entry cannot be
 *    written, the failure is printed for the operator and the caller is still told "sent" (or "no answer"): telling
 *    staff to send again would mean a second email and a first link that no longer works.
 *
 * The caller checks first that the client can be invited, that email is connected (emailIsLive) and the workspace's
 * hourly limit (holdUnapprovedEmail): all of that happens before anything is made.
 */
import type { Ctx } from './auth/context';
import { delivers, sendEmail } from './mailer';
import { expireWelcomeLinks, issueWelcomeLink, logWelcomeEmail, portalSignInUrl, providerError, welcomeEmail, welcomeEmailIssue, type WelcomeClient } from './welcome-link';

/**
 * What became of the welcome email.
 *  - sent: the email service took it;
 *  - unconfirmed: the email service did not answer, so it may or may not have arrived; its link stays usable;
 *  - failed: nothing was sent and the link was ended. `why` says which of the three it was and `detail` carries the
 *    words to show: the claim the email would have made ('claims'), or what the email service answered ('refused').
 */
export type WelcomeSend =
  | { status: 'sent' }
  | { status: 'unconfirmed' }
  | { status: 'failed'; why: 'claims' | 'not_connected' | 'refused'; detail: string };

export async function sendWelcomeEmail(ctx: Pick<Ctx, 'orgId' | 'userId' | 'session' | 'meta' | 'tx'>, client: WelcomeClient): Promise<WelcomeSend> {
  const org = await ctx.tx((db) => db.row<{ reply: string | null }>("select nullif(trim(settings->>'lead_reply_email'), '') as reply from public.organizations where id = $1", [ctx.orgId]));
  const actor = { orgId: ctx.orgId, userId: ctx.userId, ip: ctx.meta.ip };
  const { link, expired } = await ctx.tx((db) => issueWelcomeLink(db, actor, client, 'email'));
  const lang = client.preferred_language === 'es' ? 'es' : 'en';
  const mail = welcomeEmail({ lang, fullName: client.full_name, orgName: ctx.session.orgName, link, signIn: portalSignInUrl({ mode: ctx.session.orgMode, slug: ctx.session.orgSlug }, lang) });
  // Not sent: the link is ended and the failure logged, in one transaction. `reason` goes to the audit log.
  const failed = async (why: 'claims' | 'not_connected' | 'refused', detail: string, reason: string): Promise<WelcomeSend> => {
    await ctx.tx(async (db) => { await expireWelcomeLinks(db, client.id); await logWelcomeEmail(db, actor, client.id, { status: 'failed', reason }, expired); });
    return { status: 'failed', why, detail };
  };
  const issue = welcomeEmailIssue(mail);
  if (issue) return failed('claims', issue, `claims check: ${issue}`);
  const sent = await sendEmail({ to: client.email!, ...mail, fromName: ctx.session.orgName, ...(org?.reply ? { replyTo: org.reply } : {}) });
  if (!delivers(sent)) return failed('not_connected', '', 'email is not connected');
  if (sent.ok || sent.unconfirmed) {
    const status = sent.ok ? 'sent' : 'unconfirmed';
    try { await ctx.tx((db) => logWelcomeEmail(db, actor, client.id, { status }, expired)); }
    catch (e) { console.error('[welcome-send] the welcome email was handed over but could not be logged', client.id, e); }
    return { status };
  }
  const why = providerError(sent.error);
  return failed('refused', why, why);
}
