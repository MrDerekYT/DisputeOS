/**
 * The "Get set up" checklist: a pure function over a snapshot of what is really configured. No environment access and
 * no database here, so every branch is unit-tested (tests/unit/setup-checklist.test.ts).
 *
 * The snapshot carries only names and present/missing flags. No secret, and no environment variable VALUE, is ever
 * put in it, so nothing here can leak one to the browser. The one deliberate exception is the Twilio webhook address,
 * which is built from APP_URL and has to be shown so it can be pasted into Twilio.
 *
 * A step is `done` only when a real check passed. What cannot be checked from this app (carrier registration, an
 * optional custom domain) is `cannot_check` or `optional` and is never shown with a tick.
 */
export type StepStatus = 'done' | 'todo' | 'cannot_check' | 'optional';

export interface SetupStep {
  key: string;
  title: string;
  status: StepStatus;
  /** The exact next step, in plain words. */
  detail: string;
  /** Environment variable NAMES still to set. Never values. */
  missing?: string[];
  /** Something to copy and paste elsewhere (the webhook address). */
  copy?: string;
  href?: string;
  hrefLabel?: string;
}
export type SetupGroupKey = 'email' | 'texts' | 'basics';
export interface SetupGroup { key: SetupGroupKey; title: string; steps: SetupStep[]; remaining: number }
export interface SetupChecklist {
  groups: SetupGroup[];
  remaining: number;
  /** Titles of the groups with a step the workspace itself can finish today. This, not `remaining`, drives the dashboard reminder. */
  actionable: string[];
}

export interface SetupSnapshot {
  email: {
    driver: 'log' | 'resend' | 'disabled';
    hasApiKey: boolean;
    /** EMAIL_FROM is set to something other than the built-in placeholder address. */
    fromSet: boolean;
    /** When the email provider last accepted a test email sent from the setup page; null when never, or when the last test was refused. */
    testAcceptedAt: string | null;
  };
  sms: {
    state: 'connected' | 'needs_credentials' | 'test_only' | 'disabled';
    missing: string[];
    webhookUrl: string;
    /** False when APP_URL is not a public https address, which Twilio cannot call. */
    webhookReachable: boolean;
    /** When a request from Twilio last reached the webhook, from stored inbound texts and delivery reports. */
    webhookSeenAt: string | null;
    testAcceptedAt: string | null;
  };
  agency: { isAgency: boolean; mailingAddress: boolean; replyEmail: boolean; timezoneChosen: boolean };
  jobs: { cronSecretSet: boolean; lastRunAt: string | null; lastRunOk: boolean };
  ai: { active: boolean };
  now: string;
}

/** The scheduled job counts as running when its last successful run is newer than this. The hosted schedule runs twice a day. */
export const JOB_FRESH_HOURS = 48;

const HOST_ENV = 'This is done by whoever hosts this app (the platform operator): set it where the host keeps environment variables (on Vercel: Project → Settings → Environment Variables), then redeploy.';
const day = (iso: string) => new Date(iso).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' });

function emailSteps(e: SetupSnapshot['email']): SetupStep[] {
  const missing = [...(e.driver !== 'resend' ? ['EMAIL_DRIVER=resend'] : []), ...(!e.hasApiKey ? ['RESEND_API_KEY'] : []), ...(!e.fromSet ? ['EMAIL_FROM'] : [])];
  const configured = missing.length === 0;
  const proved = configured && !!e.testAcceptedAt;
  const now = e.driver === 'disabled' ? 'Email is switched off, so no email is sent: no invitations, password resets, client updates or lead follow-ups. '
    : e.driver === 'log' ? 'Emails are being written to a local log. Nothing is delivered. ' : '';
  return [
    { key: 'email_config', title: 'Switch email on', status: configured ? 'done' : 'todo', ...(configured ? {} : { missing }),
      detail: configured ? 'The email settings are in place.'
        : `${now}Create a Resend account, make an API key, and set the values below. EMAIL_FROM is the address your email comes from, on your own domain (for example “Your Agency <hello@youragency.com>”). ${HOST_ENV}` },
    { key: 'email_domain', title: 'Verify your sending domain in Resend', status: proved ? 'done' : 'todo',
      detail: proved ? 'Resend accepted email from your address, which it only does for a verified domain.'
        : 'In Resend, open Domains and add the domain of your EMAIL_FROM address. Resend shows the DNS records on that page: add them where you bought the domain, then press Verify in Resend. We cannot see your Resend account from here, so this is ticked when the test email below is accepted.' },
    { key: 'email_test', title: 'Send a test email to yourself', status: proved ? 'done' : 'todo',
      detail: proved ? `Resend accepted a test email on ${day(e.testAcceptedAt!)}.`
        : configured ? 'Send one now. The result shown is what Resend answered.' : 'Available once the settings above are in place.' },
  ];
}

function textSteps(s: SetupSnapshot['sms']): SetupStep[] {
  const connected = s.state === 'connected';
  const proved = connected && !!s.testAcceptedAt;
  const seen = connected && !!s.webhookSeenAt;
  return [
    { key: 'sms_config', title: 'Switch text messages on', status: connected ? 'done' : 'todo', ...(connected ? {} : { missing: s.state === 'test_only' ? ['SMS_DRIVER=twilio'] : s.missing }),
      detail: connected ? 'The Twilio settings are in place.'
        : `${s.state === 'test_only' ? 'Texts are being written to a local log. Nothing is delivered. ' : s.state === 'disabled' ? 'Text messaging is switched off, so no text is ever sent. ' : ''}Create a Twilio account, get a number, and set the values below. ${HOST_ENV}` },
    { key: 'sms_registration', title: 'Register your business for texting (A2P 10DLC)', status: 'cannot_check',
      detail: 'Required. US mobile carriers block texts from ordinary ten-digit numbers that are not registered. In Twilio, open Messaging → Regulatory Compliance → A2P 10DLC, register your brand and a campaign, and add your number to it. Approval generally takes from a few days to a few weeks. A verified toll-free number is the alternative. We cannot see your registration from here: an unregistered sender looks like a text that Twilio accepts but that never arrives (Twilio error 30034).' },
    { key: 'sms_webhook', title: 'Paste the webhook address into Twilio', status: seen ? 'done' : 'todo', copy: s.webhookUrl,
      detail: `In Twilio, on your number or Messaging Service, set “A message comes in” to this address, method HTTP POST. It is how a STOP reply and delivery reports reach this app. ${
        seen ? `Twilio last reached it on ${day(s.webhookSeenAt!)}.` : 'Not seen yet: nothing from Twilio has arrived here. To check it, reply to your test text with a word such as “hi” and reload this page.'}${
        s.webhookReachable ? '' : ' APP_URL is not a public https address, so Twilio cannot reach this app yet.'}` },
    { key: 'sms_test', title: 'Send a test text to yourself', status: proved ? 'done' : 'todo',
      detail: proved ? `Twilio accepted a test text on ${day(s.testAcceptedAt!)}. Accepted is not the same as delivered: make sure it arrived on your phone.`
        : connected ? 'Send one now. The result shown is what Twilio answered.' : 'Available once the settings above are in place.' },
  ];
}

function basicSteps(snap: SetupSnapshot): SetupStep[] {
  const { agency: a, jobs: j, ai } = snap;
  const fresh = !!j.lastRunAt && j.lastRunOk && Date.parse(snap.now) - Date.parse(j.lastRunAt) < JOB_FRESH_HOURS * 3_600_000;
  const steps: SetupStep[] = [];
  if (a.isAgency) {
    steps.push(
      // CAN-SPAM, 15 U.S.C. § 7704(a)(5)(A)(iii): a commercial email must include a valid physical postal address of the sender.
      { key: 'mailing_address', title: 'Mailing address', status: a.mailingAddress ? 'done' : 'todo', href: '/app/leads#follow-up', hrefLabel: 'Open lead follow-up',
        detail: a.mailingAddress ? 'Saved. It is shown at the bottom of automatic follow-up emails.' : 'Not saved. Marketing email generally has to show a postal address, so automatic lead follow-up stays off without one.' },
      { key: 'reply_email', title: 'Reply address', status: a.replyEmail ? 'done' : 'todo', href: '/app/leads#follow-up', hrefLabel: 'Open lead follow-up',
        detail: a.replyEmail ? 'Saved. Replies to automatic emails go there.' : 'Not saved. Without it a person who answers an automatic email reaches nobody, so lead follow-up stays off.' },
      { key: 'timezone', title: 'Time zone', status: a.timezoneChosen ? 'done' : 'todo', href: '/app/settings#updates', hrefLabel: 'Open client updates',
        detail: a.timezoneChosen ? 'Saved. Texts are held outside 8 a.m. to 9 p.m. in your time zone.' : 'Not chosen, so the server default is used to decide quiet hours for texts. Choose your own and save.' },
    );
  }
  steps.push({ key: 'scheduled_job', title: 'Scheduled job', status: fresh ? 'done' : 'todo', href: '/app/automations', hrefLabel: 'Open automations', ...(j.cronSecretSet ? {} : { missing: ['CRON_SECRET'] }),
    detail: `Reminders, lead follow-ups, held texts and deadline checks only happen when it runs. ${
      fresh ? `It last ran on ${day(j.lastRunAt!)}.`
        : !j.cronSecretSet ? `It cannot run: the job address answers “not found” until CRON_SECRET is set. ${HOST_ENV}`
        : !j.lastRunAt ? 'It has never run for this workspace. On Vercel it is scheduled for you; on another host, schedule the command in docs/INTEGRATIONS.md.'
        : !j.lastRunOk ? `Its last run, on ${day(j.lastRunAt)}, failed. The error is on the Automations page.`
        : `It last ran on ${day(j.lastRunAt)}, more than ${JOB_FRESH_HOURS} hours ago. Check your host’s scheduler.`}` });
  steps.push({ key: 'ai', title: 'AI wording (optional)', status: ai.active ? 'done' : 'optional', ...(ai.active ? {} : { missing: ['AI_PROVIDER', 'ANTHROPIC_API_KEY (or AI_BASE_URL, AI_API_KEY and AI_MODEL)'] }),
    detail: ai.active ? 'An AI provider is connected. Every AI result is checked against the facts before it is used.' : 'Not connected, and nothing depends on it: the built-in wording is used.' });
  if (a.isAgency) {
    steps.push({ key: 'custom_domain', title: 'Your own domain (optional)', status: 'optional', href: '/app/website', hrefLabel: 'Open the Website editor',
      detail: 'Your website works at its address on this app. Using your own domain is managed from the Website editor; it is not checked here.' });
  }
  return steps;
}

export function buildSetupChecklist(snap: SetupSnapshot): SetupChecklist {
  const group = (key: SetupGroupKey, title: string, steps: SetupStep[]): SetupGroup => ({ key, title, steps, remaining: steps.filter((s) => s.status === 'todo').length });
  const groups = [group('email', 'Email', emailSteps(snap.email)), group('texts', 'Text messages', textSteps(snap.sms)), group('basics', 'Agency basics', basicSteps(snap))];
  // What a workspace can do by itself: its own details, and its own test once the provider is connected. Environment
  // variables, the Twilio webhook and the scheduler belong to whoever hosts the app, and texting is optional, so
  // none of those keep a reminder on an agency's dashboard.
  const e = snap.email;
  const mine = new Set(['mailing_address', 'reply_email', 'timezone',
    ...(e.driver === 'resend' && e.hasApiKey && e.fromSet ? ['email_test'] : []), ...(snap.sms.state === 'connected' ? ['sms_test'] : [])]);
  const actionable = groups.filter((g) => g.steps.some((s) => s.status === 'todo' && mine.has(s.key))).map((g) => g.title);
  return { groups, remaining: groups.reduce((n, g) => n + g.remaining, 0), actionable };
}

/**
 * Things only a person can do. Shown as a plain list: the app cannot know whether they are done, so there are no ticks.
 * CROA, 15 U.S.C. § 1679b(b): a credit repair organization may not charge before the service is fully performed.
 */
export const HUMAN_ONLY: { title: string; detail: string }[] = [
  { title: 'Attorney review', detail: 'Have an attorney review your client contract, the disclosures and your marketing copy. The documents in the app are reference drafts, not legal advice.' },
  { title: 'State registration and bonding', detail: 'Many states regulate credit services organizations, and some require registration or a surety bond. The rules differ by state, so confirm yours before taking clients there.' },
  { title: 'A payment processor', detail: 'The app charges nobody. Take payments with your own processor and record them on the client’s Billing tab. Credit repair fees generally cannot be charged before the work is fully performed.' },
];

/** Settings → Integrations rows that have a matching step on the setup page: integration key → section id. */
export const SETUP_ANCHOR: Record<string, string> = { email: 'email', sms: 'texts', ai: 'basics', custom_domain: 'basics', payments: 'people' };
