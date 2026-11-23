/**
 * The welcome link: a one-time invitation to the client portal that staff copy and share, or email, to start a client's
 * guided welcome (/invite/<token> → /portal/welcome). It is an ordinary row of public.invites (src/lib/auth/service.ts):
 * single use, valid 7 days, only its hash stored. Making a new link expires the client's earlier unused ones, so only
 * the latest link works.
 */
import { audit } from './audit';
import { createInviteToken } from './auth/service';
import { findBlockedClaims } from './compliance/claims';
import { logEvent } from './crm';
import type { Db } from './db';
import { getEnv } from './env';
import { greetingName } from './lead-emails';
import { portalLoginPath } from './org-brand';
import type { Lang } from './portal-i18n';
import { toE164 } from './sms';

/** Links one client may be given per day, emailed or copied. A new link replaces the last, so more are never needed. */
export const WELCOME_LINKS_PER_DAY = 10;
export const WELCOME_LINK_DAYS = 7;

export interface WelcomeClient { id: string; full_name: string; email: string | null; preferred_language: Lang; portal_user_id: string | null }

/** The client, read under the staff member's row-level security: another agency's client is simply not found. */
export async function welcomeClient(db: Db, clientId: string): Promise<WelcomeClient | null> {
  return db.row<WelcomeClient>('select id, full_name, email, preferred_language, portal_user_id from public.clients where id = $1', [clientId]);
}

/** Why no link can be made for this client, or null. */
export function welcomeLinkProblem(c: WelcomeClient | null): string | null {
  if (!c) return 'Client not found.';
  if (c.portal_user_id) return 'This client already has portal access. They sign in at your client sign-in page.';
  if (!c.email) return 'Add the client’s email address first: the portal account is made for it.';
  return null;
}

type Actor = { orgId: string; userId: string; ip?: string | null };

/**
 * Expires the client's earlier unused links and makes a new one, in the staff member's transaction (row-level security:
 * staff can only touch their own agency's client invitations). Returns the link to share.
 *
 * A link to copy is logged here. A link to email is logged by logWelcomeEmail once the email service has answered:
 * the client's timeline and the audit log say "emailed" only for an email that was handed over.
 */
export async function issueWelcomeLink(db: Db, actor: Actor, client: WelcomeClient, via: 'copy' | 'email'): Promise<{ link: string; expired: number }> {
  const expired = await expireWelcomeLinks(db, client.id);
  const token = await createInviteToken(db, { orgId: actor.orgId, email: client.email!, role: 'client', clientId: client.id, invitedBy: actor.userId });
  if (via === 'copy') {
    await logEvent(db, actor, client.id, 'portal_invited', 'Welcome link created to share with the client', { via });
    await audit(db, { orgId: actor.orgId, actorId: actor.userId, action: 'client.welcome_link', entityType: 'client', entityId: client.id, ip: actor.ip, meta: { via, earlier_links_expired: expired } });
  }
  return { link: `${getEnv().APP_URL}/invite/${token}`, expired };
}

/** What became of a welcome email: handed to the email service, no answer from it, or not sent (its link was ended). */
export type WelcomeEmailOutcome = { status: 'sent' } | { status: 'unconfirmed' } | { status: 'failed'; reason: string };

/**
 * Logs a welcome email on the client's timeline and in the audit log, once its outcome is known:
 *  - sent: "Welcome link emailed to the client";
 *  - unconfirmed (the email service did not answer): emailed, but it may not have arrived; the link stays usable;
 *  - failed (refused, not sent, or held back by the claims check): the email failed and its link was ended, which the
 *    caller does in the same transaction (expireWelcomeLinks).
 */
export async function logWelcomeEmail(db: Db, actor: Actor, clientId: string, outcome: WelcomeEmailOutcome, earlierLinksExpired: number): Promise<void> {
  const base = { orgId: actor.orgId, actorId: actor.userId, entityType: 'client', entityId: clientId, ip: actor.ip };
  if (outcome.status === 'failed') {
    await logEvent(db, actor, clientId, 'portal_invite_ended', 'Welcome email could not be sent, so its link was ended', { via: 'email', failed: true });
    await audit(db, { ...base, action: 'client.welcome_link_failed', meta: { channel: 'email', delivery: 'failed', reason: outcome.reason.slice(0, 200), earlier_links_expired: earlierLinksExpired } });
    return;
  }
  const unconfirmed = outcome.status === 'unconfirmed';
  await logEvent(db, actor, clientId, 'portal_invited',
    unconfirmed ? 'Welcome link emailed to the client; the email service did not answer, so it may not have arrived' : 'Welcome link emailed to the client',
    unconfirmed ? { via: 'email', unconfirmed: true } : { via: 'email' });
  await audit(db, { ...base, action: 'client.welcome_link', meta: { via: 'email', delivery: outcome.status, earlier_links_expired: earlierLinksExpired } });
}

/** A provider's error, without a closing full stop, so it reads as one sentence before ". Nothing was sent". */
export const providerError = (e: string | null | undefined): string => (e ?? '').trim().replace(/[\s.]+$/, '') || 'delivery failed';

/** Ends every unused link of the client now. Returns how many there were. */
export async function expireWelcomeLinks(db: Db, clientId: string): Promise<number> {
  return db.run("update public.invites set expires_at = now() where client_id = $1 and role = 'client' and accepted_at is null and expires_at > now()", [clientId]);
}

/** The agency's own branded sign-in page, in the client's language. */
export function portalSignInUrl(org: { mode: string; slug: string }, lang: Lang): string {
  const path = org.mode === 'agency' ? portalLoginPath(org.slug) : '/portal/login';
  return `${getEnv().APP_URL}${path}${lang === 'es' ? `${path.includes('?') ? '&' : '?'}lang=es` : ''}`;
}

/**
 * The welcome email, in the client's language. Warm and plain, with no promise of any result: it is checked by
 * findBlockedClaims before it is sent (welcomeEmailIssue).
 */
export function welcomeEmail(i: { lang: Lang; fullName: string; orgName: string; link: string; signIn: string }): { subject: string; text: string } {
  const first = greetingName(i.fullName);
  if (i.lang === 'es') {
    return {
      subject: `${i.orgName}: le damos la bienvenida a su portal de cliente`,
      text: `Hola${first ? ` ${first}` : ''}:\n\n¡Le damos la bienvenida! ${i.orgName} le invitó a su portal seguro para clientes, donde puede seguir su expediente, subir documentos y escribirle a su especialista.\n\n` +
        'La configuración toma unos 10 minutos: confirme sus datos, lea y firme sus acuerdos y suba sus documentos de identidad. Tenga a mano su identificación con foto y un recibo reciente.\n\n' +
        `Empiece aquí (este enlace funciona una sola vez y vence en ${WELCOME_LINK_DAYS} días):\n${i.link}\n\nDespués, inicie sesión cuando quiera en:\n${i.signIn}\n\nSi no esperaba este correo, puede ignorarlo.`,
    };
  }
  return {
    subject: `${i.orgName}: welcome to your client portal`,
    text: `Hello${first ? ` ${first}` : ''},\n\nWelcome! ${i.orgName} has invited you to your secure client portal, where you can follow your file, upload documents and message your specialist.\n\n` +
      'Setting up takes about 10 minutes: confirm your details, read and sign your agreements, and upload your ID documents. Have your photo ID and a recent bill handy.\n\n' +
      `Start here (this link works once and expires in ${WELCOME_LINK_DAYS} days):\n${i.link}\n\nAfter that, sign in any time at:\n${i.signIn}\n\nIf you weren't expecting this email, you can ignore it.`,
  };
}

/** The first prohibited claim in the email (the agency's name is part of it), or null. */
export function welcomeEmailIssue(mail: { subject: string; text: string }): string | null {
  const c = findBlockedClaims(`${mail.subject}\n${mail.text}`)[0];
  return c ? `${c.why} (“${c.excerpt}”)` : null;
}

/**
 * "Text it from your phone": a link that opens the staff member's own messaging app with the client's number and the
 * welcome link already typed, for a link that is passed on by hand. The app sends nothing: the staff member reads the
 * text and presses send on their own phone. The text is short, in the client's language, and greets the client by a
 * first name only when it reads as one. It says which business it is from, so it does not read like a text from a
 * stranger: the agency's name (`orgName`) is named unless the name itself carries wording the welcome email would be
 * held back for (findBlockedClaims), in which case the text is the fixed words and the link alone.
 * Null when the number cannot be read as a phone number (./sms.ts toE164).
 *
 * Written as the standard says (RFC 5724): sms:<number in international form>?body=<the text, percent-encoded>, which
 * is what Android reads. Apple devices read the text after "&body=" instead, so the page swaps that one separator when
 * it is opened on one (src/app/app/clients/new/quick-add.tsx).
 */
export function welcomeTextHref(phone: string | null | undefined, i: { lang: Lang; fullName: string; orgName?: string | null; link: string }): string | null {
  const to = toE164(phone);
  if (!to) return null;
  const first = greetingName(i.fullName);
  // One line, and no full stop of its own before the one the sentence ends with.
  const name = (i.orgName ?? '').replace(/\s+/g, ' ').trim().replace(/[\s.]+$/, '');
  const org = name && !findBlockedClaims(name).length ? name : '';
  const body = i.lang === 'es'
    ? `Hola${first ? ` ${first}` : ''}: ${org ? `le escribe ${org}. Este` : 'este'} es su enlace para configurar su portal de cliente. Funciona una sola vez y vence en ${WELCOME_LINK_DAYS} días: ${i.link}`
    : `Hello${first ? ` ${first}` : ''}, ${org ? `this is ${org}. Here` : 'here'} is your link to set up your client portal. It works once and expires in ${WELCOME_LINK_DAYS} days: ${i.link}`;
  return `sms:${to}?body=${encodeURIComponent(body)}`;
}
