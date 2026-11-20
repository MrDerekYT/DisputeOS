import { audit } from '../audit';
import { rateLimit } from '../auth/rate-limit';
import { cleanOrgName } from '../client-updates/templates';
import { assertNoBlockedClaims } from '../compliance/claims';
import { withSystem, type Db } from '../db';
import { getEnv } from '../env';
import { UserError } from '../errors';
import { sendEmail, type Email, type SendResult } from '../mailer';
import { APPROVAL_COLS, outreachApproval, type ApprovalRow } from '../outreach-approval';
import { PRODUCT } from '../product';
import { can, PermissionError, type Role } from '../rbac';
import { sendSms, smsStatus, toUsE164, type Sms, type SmsResult } from '../sms';
import { EMAIL_TEST_KEY, SMS_TEST_KEY } from './snapshot';

/**
 * "Send a test to me" from the setup page. Both tests:
 *  - need settings:manage (checked here, so the rule holds wherever they are called from);
 *  - are rate limited per person and per workspace (texts also for the whole deployment), and the limit is only
 *    spent when a send is really attempted;
 *  - go to the signed-in person only (their own account email; a phone number they type and confirm is theirs);
 *  - write NO client communication, queue row or consent: the only traces are an audit entry (no address, no number)
 *    and, when the provider accepts, a timestamp in organizations.settings that ticks the step on the checklist;
 *  - report what the provider actually answered. Nothing is reworded into a success.
 *
 * The test text is still a text to a number somebody typed, and sign-up is open. So it is held to the rules every
 * other text is held to: it is refused for a workspace the platform operator has not approved under its current name
 * (read from the database here, not from the session), it goes to a US number only (toUsE164), never to a number
 * that has replied STOP to this deployment, and it does not carry the workspace's name.
 */
export interface TestActor { userId: string; orgId: string; role: Role; email: string; orgName: string; tx<T>(fn: (db: Db) => Promise<T>): Promise<T>; ip?: string | null }
export interface TestSendResult { ok: boolean; message: string }

export const TEST_EMAIL_LIMIT = { max: 5, windowSec: 3600 };
export const TEST_SMS_LIMIT = { max: 3, windowSec: 86_400 };
/** The provider accounts belong to the whole deployment and sign-up is open, so the tests are also capped per workspace and, for texts, for everyone together. */
export const TEST_EMAIL_ORG_LIMIT = { max: 10, windowSec: 3600 };
export const TEST_SMS_ORG_LIMIT = { max: 3, windowSec: 86_400 };
export const TEST_SMS_ALL_LIMIT = { max: 50, windowSec: 86_400 };

function needSettings(a: TestActor) {
  if (!can(a.role, 'settings:manage')) throw new PermissionError('settings:manage');
}
const waitText = (sec: number) => (sec >= 5400 ? `${Math.ceil(sec / 3600)} hours` : `${Math.max(1, Math.ceil(sec / 60))} minutes`);

/** Records the attempt, and sets (provider accepted) or clears (provider refused) the proof the checklist reads. */
async function record(a: TestActor, kind: 'email' | 'sms', key: string, provider: string, accepted: boolean, refused: boolean) {
  await a.tx(async (db) => {
    if (accepted) await db.run('update public.organizations set settings = settings || jsonb_build_object($2::text, $3::text) where id = $1', [a.orgId, key, new Date().toISOString()]);
    else if (refused) await db.run('update public.organizations set settings = settings - $2::text where id = $1', [a.orgId, key]);
    await audit(db, { orgId: a.orgId, actorId: a.userId, action: `setup.test_${kind}`, entityType: 'organization', entityId: a.orgId, ip: a.ip ?? null, meta: { provider, accepted } });
  });
}

export async function sendTestEmail(a: TestActor, opts: { send?: (mail: Email) => Promise<SendResult> } = {}): Promise<TestSendResult> {
  needSettings(a);
  const env = getEnv();
  if (env.EMAIL_DRIVER === 'disabled') return { ok: false, message: 'Not sent: email is not connected (EMAIL_DRIVER=disabled).' };
  if (env.EMAIL_DRIVER === 'resend' && !env.RESEND_API_KEY) return { ok: false, message: 'Not sent: email is not connected. RESEND_API_KEY is missing.' };
  const limit = await rateLimit(`setup-test-email:user:${a.userId}`, TEST_EMAIL_LIMIT.max, TEST_EMAIL_LIMIT.windowSec);
  if (!limit.allowed) throw new UserError(`You have sent ${TEST_EMAIL_LIMIT.max} test emails in the last hour. Try again in ${waitText(limit.retryAfterSec)}.`);
  const orgLimit = await rateLimit(`setup-test-email:org:${a.orgId}`, TEST_EMAIL_ORG_LIMIT.max, TEST_EMAIL_ORG_LIMIT.windowSec);
  if (!orgLimit.allowed) throw new UserError(`Your workspace has sent ${TEST_EMAIL_ORG_LIMIT.max} test emails in the last hour. Try again in ${waitText(orgLimit.retryAfterSec)}.`);
  const org = cleanOrgName(a.orgName, 100);
  const r = await (opts.send ?? sendEmail)({
    to: a.email, fromName: org, subject: `Test email from ${PRODUCT.name}`,
    text: `This is a test email. You asked for it on the “Get set up” page of ${PRODUCT.name}.\n\nIf you are reading this, email from ${org} is being delivered. It was sent only to you: nothing was sent to a client.\n`,
  });
  const live = r.provider === 'resend';
  // No answer from Resend is not a refusal: the email may have gone out, so the checklist is left as it was.
  await record(a, 'email', EMAIL_TEST_KEY, r.provider, live && r.ok, live && !r.ok && !r.unconfirmed);
  if (!live) return { ok: false, message: 'Not delivered: emails are written to a local log here (EMAIL_DRIVER=log). Nothing left this server.' };
  if (r.ok) return { ok: true, message: `Resend accepted it${r.providerRef ? ` (id ${r.providerRef})` : ''}. Look for it at ${a.email}, and in the spam folder too.` };
  const why = r.error ?? 'no reason given';
  if (r.unconfirmed) return { ok: false, message: `Resend did not answer (${why}), so it is not known whether the email was sent. Look in your inbox; if it is not there, try again.` };
  return { ok: false, message: `Resend refused it: “${why}”.${/domain|verif/i.test(why) ? ' That usually means the sending domain is not verified in Resend yet, or EMAIL_FROM is not on that domain.' : ''}` };
}

/** Why the test text is refused while the operator's approval is missing (src/lib/outreach-approval.ts). */
export const TEST_TEXT_NEEDS_APPROVAL: Record<'not_approved' | 'renamed', string> = {
  not_approved: 'Not sent: the platform operator has not approved this workspace for text messages yet. No text is sent from it until then, and that includes this test.',
  renamed: 'Not sent: your business name changed after the platform operator approved this workspace for text messages, so it has to be approved again. No text is sent from it until then, and that includes this test.',
};
export const TEST_TEXT_NEEDS_US_NUMBER = 'Enter a US mobile number with its area code, for example (212) 555-0142. The test text is sent to US numbers only.';
export const TEST_TEXT_STOPPED = 'Not sent: this number replied STOP to a text from this service, so no test text is sent to it. Test with another number of your own.';

export async function sendTestSms(a: TestActor, input: { phone: string; confirmed: boolean }, opts: { send?: (msg: Sms) => Promise<SmsResult> } = {}): Promise<TestSendResult> {
  needSettings(a);
  // The person's own action is the consent here: they type the number and state it is theirs. It is not stored.
  if (!input.confirmed) throw new UserError('Tick the box to confirm this is your own mobile number.');
  // A US number, like every other text: the test is billed to the deployment's one Twilio account, and an open
  // "text any number" button is how premium-rate and foreign numbers get pumped.
  const to = toUsE164(input.phone);
  if (!to) throw new UserError(TEST_TEXT_NEEDS_US_NUMBER);
  const status = smsStatus();
  if (status.state === 'disabled') return { ok: false, message: 'Not sent: text messaging is not connected (SMS_DRIVER=disabled).' };
  if (status.state === 'needs_credentials') return { ok: false, message: `Not sent: text messaging is not connected. Still to set: ${status.missing.join(', ')}.` };
  // The operator's approval, for the name the workspace has now. Read from the database: the session's copy can be old.
  const approval = outreachApproval(await a.tx((db) => db.row<ApprovalRow>(`select ${APPROVAL_COLS} from public.organizations where id = $1`, [a.orgId])));
  if (approval !== 'approved') return { ok: false, message: TEST_TEXT_NEEDS_APPROVAL[approval] };
  // A STOP sent to the deployment's number stands for every workspace that texts from it, and for this test too.
  // (Read through the system connection: the reply may be on file with another workspace, or with none.)
  if (await withSystem((db) => db.row("select 1 from public.sms_inbound where kind = 'stop' and from_phone = $1 limit 1", [to]))) return { ok: false, message: TEST_TEXT_STOPPED };
  const limit = await rateLimit(`setup-test-sms:user:${a.userId}`, TEST_SMS_LIMIT.max, TEST_SMS_LIMIT.windowSec);
  if (!limit.allowed) throw new UserError(`You have sent ${TEST_SMS_LIMIT.max} test texts today. Try again in ${waitText(limit.retryAfterSec)}.`);
  const orgLimit = await rateLimit(`setup-test-sms:org:${a.orgId}`, TEST_SMS_ORG_LIMIT.max, TEST_SMS_ORG_LIMIT.windowSec);
  if (!orgLimit.allowed) throw new UserError(`Your workspace has sent ${TEST_SMS_ORG_LIMIT.max} test texts today. Try again in ${waitText(orgLimit.retryAfterSec)}.`);
  const allLimit = await rateLimit('setup-test-sms:all', TEST_SMS_ALL_LIMIT.max, TEST_SMS_ALL_LIMIT.windowSec);
  if (!allLimit.allowed) throw new UserError(`Test texts are paused for today across the platform. Try again in ${waitText(allLimit.retryAfterSec)}.`);
  // The same words for every workspace: a name somebody chose has no place in a text to a number somebody typed.
  const body = assertNoBlockedClaims(`${PRODUCT.name} test: text messaging is connected. You asked for this on the setup page. Reply STOP to opt out.`);
  const r = await (opts.send ?? sendSms)({ to, body });
  const live = r.provider === 'twilio';
  await record(a, 'sms', SMS_TEST_KEY, r.provider, live && r.ok, live && !r.ok);
  if (!live) return { ok: false, message: 'Not delivered: texts are written to a local log here (SMS_DRIVER=log). Nothing left this server.' };
  if (r.ok) return { ok: true, message: `Twilio accepted it${r.providerRef ? ` (id ${r.providerRef})` : ''}. Accepted is not delivered: if it has not reached your phone in a minute or two, the usual cause is that the number is not registered for business texting (A2P 10DLC).` };
  return { ok: false, message: `Twilio refused it: “${r.error ?? 'no reason given'}”.` };
}
