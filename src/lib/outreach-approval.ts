/**
 * The platform operator's approval of a workspace for unattended outreach: the email sequence to referral partners and
 * the follow-up texts to leads. Pure rules; the two columns live on public.organizations (migration 0028) and are
 * written only by `npm run outreach:approve` through the system connection. A tenant cannot set them.
 *
 * Why it exists. Sign-up is open and unverified, and every workspace sends through the deployment's one email service
 * and one text number. Without a gate, anyone could create a workspace, switch outreach on and use the platform to
 * cold-email or text numbers of their choice under a name of their choice. So nothing unattended goes out for a
 * workspace until a person at the operator has looked at it. The approval is for the business name it had then: the
 * name is in every subject, From line and text, so after a rename the workspace has to be approved again.
 */
export interface ApprovalRow { name: string; outreach_approved_at: string | Date | null; outreach_approved_name: string | null }
export type OutreachApproval = 'approved' | 'not_approved' | 'renamed';

export function outreachApproval(o: ApprovalRow | null | undefined): OutreachApproval {
  if (!o?.outreach_approved_at) return 'not_approved';
  return o.outreach_approved_name === o.name ? 'approved' : 'renamed';
}
export const outreachApproved = (o: ApprovalRow | null | undefined) => outreachApproval(o) === 'approved';

/** What staff are told when outreach is switched on but the workspace is not approved (Partners and Leads pages). */
export const APPROVAL_NEEDED: Record<Exclude<OutreachApproval, 'approved'>, string> = {
  not_approved: 'This workspace has not been approved for automatic outreach yet. The platform operator approves each workspace before partner emails or lead texts go out; nothing is sent until then.',
  renamed: 'Your business name changed after this workspace was approved for automatic outreach. The name is in every message, so the platform operator has to approve it again; nothing is sent until then.',
};

/** The columns the rules above read, for a select list (alias-free: use on public.organizations). */
export const APPROVAL_COLS = 'name, outreach_approved_at, outreach_approved_name';

/**
 * A workspace approved less than this many days ago sends at a lower daily rate (NEW_WORKSPACE_DAILY_EMAILS), so a
 * list that turns out to be bad shows itself in a few bounces and complaints, not in forty.
 */
export const NEW_WORKSPACE_DAYS = 14;
export const NEW_WORKSPACE_DAILY_EMAILS = 10;
export const isNewlyApproved = (o: ApprovalRow, now: Date = new Date()) =>
  !!o.outreach_approved_at && now.getTime() - new Date(o.outreach_approved_at).getTime() < NEW_WORKSPACE_DAYS * 86_400_000;
