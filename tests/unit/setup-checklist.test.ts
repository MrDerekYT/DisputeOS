import { describe, expect, it } from 'vitest';
import { findBlockedClaims } from '@/lib/compliance/claims';
import { buildSetupChecklist, HUMAN_ONLY, JOB_FRESH_HOURS, SETUP_ANCHOR, type SetupSnapshot, type SetupStep } from '@/lib/setup/checklist';

const NOW = '2026-11-19T12:00:00.000Z';
const hoursAgo = (h: number) => new Date(Date.parse(NOW) - h * 3_600_000).toISOString();

/** Everything in place and proved. Each test removes one piece. */
const complete = (): SetupSnapshot => ({
  email: { driver: 'resend', hasApiKey: true, fromSet: true, testAcceptedAt: hoursAgo(1) },
  sms: { state: 'connected', missing: [], webhookUrl: 'https://app.example.test/api/webhooks/twilio', webhookReachable: true, webhookSeenAt: hoursAgo(2), testAcceptedAt: hoursAgo(1) },
  agency: { isAgency: true, mailingAddress: true, replyEmail: true, timezoneChosen: true, agreementTerms: true },
  jobs: { cronSecretSet: true, lastRunAt: hoursAgo(3), lastRunOk: true },
  ai: { state: 'connected', provider: 'anthropic:claude-opus-5-5', missing: [], testPassedAt: hoursAgo(1), testProvider: 'anthropic:claude-opus-5-5' },
  now: NOW,
});
const AI_OFF: SetupSnapshot['ai'] = { state: 'off', provider: 'rules', missing: ['AI_PROVIDER=anthropic', 'ANTHROPIC_API_KEY'], testPassedAt: null, testProvider: null };
const steps = (s: SetupSnapshot) => Object.fromEntries(buildSetupChecklist(s).groups.flatMap((g) => g.steps).map((x) => [x.key, x])) as Record<string, SetupStep>;
const edit = (fn: (s: SetupSnapshot) => void) => { const s = complete(); fn(s); return s; };

describe('setup checklist', () => {
  it('with everything configured and proved, nothing is left; what cannot be checked is still never ticked', () => {
    const list = buildSetupChecklist(complete());
    expect(list.remaining).toBe(0);
    expect(list.groups.map((g) => [g.key, g.remaining])).toEqual([['email', 0], ['texts', 0], ['basics', 0]]);
    const s = steps(complete());
    expect(s.sms_registration!.status).toBe('cannot_check');
    expect(s.custom_domain!.status).toBe('optional');
    expect(Object.values(s).filter((x) => x.status === 'todo')).toEqual([]);
  });

  it('email: each missing setting is named, and nothing in the group is done until the provider accepted a test', () => {
    const off = steps(edit((s) => { s.email = { driver: 'disabled', hasApiKey: false, fromSet: false, testAcceptedAt: null }; }));
    expect(off.email_config).toMatchObject({ status: 'todo', missing: ['EMAIL_DRIVER=resend', 'RESEND_API_KEY', 'EMAIL_FROM'] });
    expect(off.email_config!.detail).toMatch(/no email is sent/);
    expect([off.email_domain!.status, off.email_test!.status]).toEqual(['todo', 'todo']);

    expect(steps(edit((s) => { s.email.hasApiKey = false; })).email_config!.missing).toEqual(['RESEND_API_KEY']);
    expect(steps(edit((s) => { s.email.fromSet = false; })).email_config!.missing).toEqual(['EMAIL_FROM']);
    const log = steps(edit((s) => { s.email.driver = 'log'; }));
    expect(log.email_config).toMatchObject({ status: 'todo', missing: ['EMAIL_DRIVER=resend'] });
    expect(log.email_config!.detail).toMatch(/Nothing is delivered/);

    // Configured but never proved: the settings step passes, the domain and the test do not.
    const unproved = steps(edit((s) => { s.email.testAcceptedAt = null; }));
    expect(unproved.email_config!.status).toBe('done');
    expect(unproved.email_domain).toMatchObject({ status: 'todo' });
    expect(unproved.email_domain!.detail).toMatch(/Resend shows the DNS records/);
    expect(unproved.email_test!.status).toBe('todo');

    // An old accepted test proves nothing once a setting is missing again.
    const stale = steps(edit((s) => { s.email.hasApiKey = false; }));
    expect([stale.email_config!.status, stale.email_domain!.status, stale.email_test!.status]).toEqual(['todo', 'todo', 'todo']);
  });

  it('text messages: missing settings are named, registration is required but never ticked, the webhook is ticked only when seen', () => {
    const missing = ['SMS_DRIVER=twilio', 'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_MESSAGING_SERVICE_SID or TWILIO_FROM_NUMBER'];
    const off = steps(edit((s) => { s.sms = { ...s.sms, state: 'disabled', missing }; }));
    expect(off.sms_config).toMatchObject({ status: 'todo', missing });
    // Stored proofs do not count while the settings are missing.
    expect([off.sms_webhook!.status, off.sms_test!.status]).toEqual(['todo', 'todo']);

    const partial = steps(edit((s) => { s.sms = { ...s.sms, state: 'needs_credentials', missing: ['TWILIO_AUTH_TOKEN'] }; }));
    expect(partial.sms_config).toMatchObject({ status: 'todo', missing: ['TWILIO_AUTH_TOKEN'] });
    expect(steps(edit((s) => { s.sms.state = 'test_only'; })).sms_config).toMatchObject({ status: 'todo', missing: ['SMS_DRIVER=twilio'] });

    const reg = steps(complete()).sms_registration!;
    expect(reg.detail).toMatch(/^Required\./);
    expect(reg.detail).toMatch(/carriers block texts/);
    expect(reg.detail).toMatch(/A2P 10DLC/);

    const unseen = steps(edit((s) => { s.sms.webhookSeenAt = null; }));
    expect(unseen.sms_webhook).toMatchObject({ status: 'todo', copy: 'https://app.example.test/api/webhooks/twilio' });
    expect(unseen.sms_webhook!.detail).toMatch(/Not seen yet/);
    expect(steps(complete()).sms_webhook!.detail).toMatch(/Twilio last reached it on Nov 19, 2026/);
    expect(steps(edit((s) => { s.sms.webhookReachable = false; })).sms_webhook!.detail).toMatch(/APP_URL is not a public https address/);

    const untested = steps(edit((s) => { s.sms.testAcceptedAt = null; }));
    expect(untested.sms_test!.status).toBe('todo');
    expect(steps(complete()).sms_test!.detail).toMatch(/Accepted is not the same as delivered/);
  });

  it('agency basics: each missing piece is its own step with where to fix it', () => {
    expect(steps(edit((s) => { s.agency.mailingAddress = false; })).mailing_address).toMatchObject({ status: 'todo', href: '/app/leads#follow-up' });
    expect(steps(edit((s) => { s.agency.replyEmail = false; })).reply_email).toMatchObject({ status: 'todo', href: '/app/leads#follow-up' });
    expect(steps(edit((s) => { s.agency.timezoneChosen = false; })).timezone).toMatchObject({ status: 'todo', href: '/app/settings#updates' });
    expect(buildSetupChecklist(edit((s) => { s.agency.mailingAddress = false; s.agency.replyEmail = false; s.agency.timezoneChosen = false; })).remaining).toBe(3);
    expect(steps(complete()).custom_domain).toMatchObject({ status: 'optional', href: '/app/website' });
    // A personal workspace has no lead follow-up, client updates or website.
    expect(Object.keys(steps(edit((s) => { s.agency.isAgency = false; }))).filter((k) => ['mailing_address', 'reply_email', 'timezone', 'custom_domain'].includes(k))).toEqual([]);
  });

  it('scheduled job: done only after a recent successful run', () => {
    expect(steps(complete()).scheduled_job!.status).toBe('done');
    const never = steps(edit((s) => { s.jobs = { cronSecretSet: true, lastRunAt: null, lastRunOk: false }; })).scheduled_job!;
    expect(never.status).toBe('todo');
    expect(never.detail).toMatch(/never run/);
    const noSecret = steps(edit((s) => { s.jobs = { cronSecretSet: false, lastRunAt: null, lastRunOk: false }; })).scheduled_job!;
    expect(noSecret).toMatchObject({ status: 'todo', missing: ['CRON_SECRET'] });
    const failed = steps(edit((s) => { s.jobs.lastRunOk = false; })).scheduled_job!;
    expect(failed.status).toBe('todo');
    expect(failed.detail).toMatch(/failed/);
    const old = steps(edit((s) => { s.jobs.lastRunAt = hoursAgo(JOB_FRESH_HOURS + 1); })).scheduled_job!;
    expect(old.status).toBe('todo');
    expect(old.detail).toMatch(/more than 48 hours ago/);
  });

  it('AI switched off is optional: it never adds to what is left', () => {
    const s = edit((x) => { x.ai = { ...AI_OFF }; });
    expect(steps(s).ai).toMatchObject({ status: 'optional', missing: ['AI_PROVIDER=anthropic', 'ANTHROPIC_API_KEY'] });
    expect(steps(s).ai!.detail).toMatch(/nothing depends on it/);
    expect(buildSetupChecklist(s).remaining).toBe(0);
  });

  it('AI is done only after the connection test passed, with the provider and model in use now', () => {
    expect(steps(complete()).ai).toMatchObject({ status: 'done' });
    expect(steps(complete()).ai!.detail).toMatch(/^The connection test passed on Nov 19, 2026 with anthropic:claude-opus-5-5\./);
    // Connected but never tested: to do, and the page says what the test sends.
    const untested = steps(edit((x) => { x.ai.testPassedAt = null; x.ai.testProvider = null; })).ai!;
    expect(untested).toMatchObject({ status: 'todo' });
    expect(untested.detail).toMatch(/has not passed the connection test here yet\. The test sends one short fixed request with no client data\./);
    // A pass with another model proves nothing about this one.
    const moved = steps(edit((x) => { x.ai.provider = 'anthropic:claude-sonnet-5-5'; })).ai!;
    expect(moved).toMatchObject({ status: 'todo' });
    expect(moved.detail).toMatch(/the last test passed with anthropic:claude-opus-5-5\. Test it again\./);
    // A provider chosen without its key: to do, with the missing name, and nothing is tested.
    const keyless = steps(edit((x) => { x.ai = { state: 'needs_credentials', provider: 'anthropic', missing: ['ANTHROPIC_API_KEY'], testPassedAt: hoursAgo(5), testProvider: 'anthropic:claude-opus-5-5' }; })).ai!;
    expect(keyless).toMatchObject({ status: 'todo', missing: ['ANTHROPIC_API_KEY'] });
    expect(keyless.detail).toMatch(/built-in wording is used/);
    // The test is the host's and the operator's business: it never puts a reminder on an agency's dashboard.
    expect(buildSetupChecklist(edit((x) => { x.ai.testPassedAt = null; })).actionable).toEqual([]);
  });

  it('the counts add up, and every piece missing at once leaves nothing done except nothing', () => {
    const bare: SetupSnapshot = {
      email: { driver: 'disabled', hasApiKey: false, fromSet: false, testAcceptedAt: null },
      sms: { state: 'disabled', missing: ['SMS_DRIVER=twilio'], webhookUrl: 'http://localhost:3000/api/webhooks/twilio', webhookReachable: false, webhookSeenAt: null, testAcceptedAt: null },
      agency: { isAgency: true, mailingAddress: false, replyEmail: false, timezoneChosen: false, agreementTerms: false },
      jobs: { cronSecretSet: false, lastRunAt: null, lastRunOk: false },
      ai: { ...AI_OFF },
      now: NOW,
    };
    const list = buildSetupChecklist(bare);
    expect(list.groups.flatMap((g) => g.steps).filter((x) => x.status === 'done')).toEqual([]);
    expect(list.groups.map((g) => g.remaining)).toEqual([3, 3, 5]);
    expect(list.remaining).toBe(11);
    // Of those eleven, only the agency's own details are something this workspace can finish; the rest is the host's.
    expect(list.actionable).toEqual(['Agency basics']);
  });

  it('the client agreement terms are an agency basic the workspace finishes itself', () => {
    const step = (snap: SetupSnapshot) => buildSetupChecklist(snap).groups.find((g) => g.key === 'basics')!.steps.find((x) => x.key === 'agreement_terms');
    expect(step(complete())).toMatchObject({ status: 'done', href: '/app/settings#agreement' });
    const without = edit((s) => { s.agency.agreementTerms = false; });
    expect(step(without)).toMatchObject({ status: 'todo' });
    expect(buildSetupChecklist(without).actionable).toEqual(['Agency basics']);
    // A personal workspace has no client agreement.
    expect(step(edit((s) => { s.agency.isAgency = false; s.agency.agreementTerms = false; }))).toBeUndefined();
  });

  it('the dashboard reminder counts only what the workspace itself can finish', () => {
    expect(buildSetupChecklist(complete()).actionable).toEqual([]);
    // The host's settings never count: environment variables, the Twilio webhook, the scheduler.
    expect(buildSetupChecklist(edit((s) => { s.email.driver = 'log'; s.email.testAcceptedAt = null; s.sms.state = 'disabled'; s.sms.testAcceptedAt = null; s.sms.webhookSeenAt = null; s.jobs.cronSecretSet = false; s.jobs.lastRunAt = null; })).actionable).toEqual([]);
    expect(buildSetupChecklist(edit((s) => { s.sms.webhookSeenAt = null; })).actionable).toEqual([]);
    // Its own details do, and its own test once the provider is connected.
    expect(buildSetupChecklist(edit((s) => { s.agency.timezoneChosen = false; })).actionable).toEqual(['Agency basics']);
    expect(buildSetupChecklist(edit((s) => { s.email.testAcceptedAt = null; s.sms.testAcceptedAt = null; })).actionable).toEqual(['Email', 'Text messages']);
  });

  it('the wording passes the claims guard, and the settings links point at real sections', () => {
    const text = [...Object.values(steps(complete())), ...Object.values(steps(edit((s) => { s.email.testAcceptedAt = null; s.sms.state = 'disabled'; s.jobs.lastRunAt = null; })))]
      .map((x) => `${x.title}. ${x.detail}`).concat(HUMAN_ONLY.map((h) => `${h.title}. ${h.detail}`)).join('\n');
    expect(findBlockedClaims(text)).toEqual([]);
    expect(HUMAN_ONLY.map((h) => h.title)).toEqual(['Attorney review', 'State registration and bonding', 'A payment processor']);
    const ids = new Set([...buildSetupChecklist(complete()).groups.map((g) => g.key as string), 'people']);
    for (const id of Object.values(SETUP_ANCHOR)) expect(ids.has(id), id).toBe(true);
  });
});
