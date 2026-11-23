import type { Ctx } from './auth/context';
import { rateLimit } from './auth/rate-limit';
import { UserError } from './errors';
import { emailIsLive } from './lead-outreach';
import { APPROVAL_COLS, outreachApproved, type ApprovalRow } from './outreach-approval';

/**
 * Staff email to an address on a client or lead record (the welcome link, a message, the welcome email New client
 * sends, a new client on the full form with the invitation box ticked) leaves through the deployment's one email
 * service, and the address may be one a stranger typed into the public enquiry form. Until the platform operator has
 * approved the workspace (./outreach-approval.ts), those share a limit of UNAPPROVED_EMAILS_PER_HOUR for the whole
 * workspace; an approved workspace has none. Counted only while email is connected, since nothing leaves otherwise.
 * Call before anything is created or sent, and outside a transaction: the counter has a connection of its own.
 */
export const UNAPPROVED_EMAILS_PER_HOUR = 50;
export async function holdUnapprovedEmail(ctx: Pick<Ctx, 'orgId' | 'tx'>): Promise<void> {
  if (!emailIsLive()) return;
  if (outreachApproved(await ctx.tx((db) => db.row<ApprovalRow>(`select ${APPROVAL_COLS} from public.organizations where id = $1`, [ctx.orgId])))) return;
  const limit = await rateLimit(`staff-email:org:${ctx.orgId}`, UNAPPROVED_EMAILS_PER_HOUR, 3600);
  if (!limit.allowed) throw new UserError(`This workspace can send ${UNAPPROVED_EMAILS_PER_HOUR} emails an hour until the platform operator has approved it. Try again later.`);
}
