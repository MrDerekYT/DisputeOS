import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { runSweeps } from '@/lib/automation/engine';
import { JOBS_DEADLINE_MS, runScheduledJobs } from '@/lib/automation/jobs';
import { addDays, isBusinessDay } from '@/lib/business-days';
import { queueClientUpdate } from '@/lib/client-updates/service';
import { resetEnvCache } from '@/lib/env';
import { submitLead } from '@/lib/leads';
import { addPartners } from '@/lib/partner-outreach';
import { transitionDispute } from '@/lib/disputes/service';
import { businessToday, checkSentOn, markSent } from '@/lib/letters/service';
import { recordConsentRows } from './consents';
import { addClient, addDispute, addMember, addPortalClient, approveOutreach, asUser, closePool, makeOrg, testIp, uniq, withSystem } from './helpers';

afterAll(closePool);

const count = (sql: string, p: unknown[]) => withSystem((db) => db.row<{ n: number }>(sql, p as never[])).then((r) => r!.n);

/** A synthetic agency with one enabled deadline automation and one submitted dispute that is due soon. */
async function agencyWithDueDispute(label: string) {
  const o = await makeOrg(label);
  const sp = await addMember(o.orgId, 'specialist');
  const clientId = await addClient(o.orgId, `${label} Client`);
  await withSystem(async (db) => {
    await db.run('update public.clients set assigned_to = $2 where id = $1', [clientId, sp.id]);
    await db.run(
      `insert into public.automations (org_id, name, trigger, conditions, actions, enabled, requires_approval, max_subjects_per_run, cooldown_days, created_by)
       values ($1, 'Deadline follow-up', 'dispute_deadline', '{"withinDays":5}', $2, true, false, 25, 7, $3)`,
      [o.orgId, JSON.stringify([{ type: 'create_task', title: 'Follow up: {{item}}' }]), o.ownerId]);
    await db.run(
      `insert into public.disputes (org_id, client_id, item_label, recipient_name, category, reason, status, due_at, assigned_to)
       values ($1, $2, 'Synthetic Bank ••0001 (Experian)', 'Experian', 'other', 'Synthetic reason long enough', 'submitted', now() + interval '3 days', $3)`, [o.orgId, clientId, sp.id]);
  });
  return { ...o, clientId };
}

describe('scheduled jobs', () => {
  it('a retry creates no duplicate actions', async () => {
    const a = await agencyWithDueDispute('Retry');
    const first = await runScheduledJobs({ onlyOrgIds: [a.orgId] });
    expect(first).toMatchObject({ orgs: 1, failures: 0, executed: 1 });
    expect(await count('select count(*)::int as n from public.tasks where client_id = $1', [a.clientId])).toBe(1);

    const second = await runScheduledJobs({ onlyOrgIds: [a.orgId] });
    const third = await runScheduledJobs({ onlyOrgIds: [a.orgId] });
    expect(second).toMatchObject({ failures: 0, executed: 0 });
    expect(third.executed).toBe(0);
    expect(await count('select count(*)::int as n from public.tasks where client_id = $1', [a.clientId])).toBe(1);
    expect(await count('select count(*)::int as n from public.automation_runs where org_id = $1', [a.orgId])).toBe(1);
    // every run is on record for the operator, including the ones that had nothing to do
    expect(await count("select count(*)::int as n from public.job_runs where org_id = $1 and status = 'ok'", [a.orgId])).toBe(3);
  });

  it('a failure in one agency is recorded and notified, and does not stop or roll back the others', async () => {
    const bad = await agencyWithDueDispute('Broken');
    const good = await agencyWithDueDispute('Healthy');
    const r = await runScheduledJobs({
      onlyOrgIds: [bad.orgId, good.orgId],
      sweep: async (db, actor) => {
        const out = await runSweeps(db, actor); // does real work first, so we can prove it is rolled back for the failing agency
        if (actor.orgId === bad.orgId) throw new Error('synthetic failure: mail provider unreachable');
        return out;
      },
    });
    expect(r).toMatchObject({ orgs: 2, failures: 1, executed: 1 });
    expect(r.failed).toEqual([{ orgId: bad.orgId, error: 'synthetic failure: mail provider unreachable' }]);
    expect(await count('select count(*)::int as n from public.tasks where client_id = $1', [good.clientId])).toBe(1);
    expect(await count('select count(*)::int as n from public.tasks where client_id = $1', [bad.clientId])).toBe(0); // rolled back, not half done

    // visible to the operator: a failed job_runs row readable by that agency's staff, and a notification for its owner
    const seen = await asUser(bad.ownerId, (db) => db.rows<{ status: string; error: string }>('select status, error from public.job_runs order by started_at desc'));
    expect(seen).toEqual([{ status: 'failed', error: 'synthetic failure: mail provider unreachable' }]);
    const note = await withSystem((db) => db.row<{ title: string; body: string; href: string }>("select title, body, href from public.notifications where org_id = $1 and user_id = $2", [bad.orgId, bad.ownerId]));
    expect(note).toMatchObject({ title: 'Scheduled jobs failed', href: '/app/automations' });
    expect(note!.body).toContain('mail provider unreachable');

    // failing again the same day does not spam, and the work happens once the cause is fixed
    await runScheduledJobs({ onlyOrgIds: [bad.orgId], sweep: async () => { throw new Error('still down'); } });
    expect(await count("select count(*)::int as n from public.notifications where org_id = $1 and title = 'Scheduled jobs failed'", [bad.orgId])).toBe(1);
    expect(await count("select count(*)::int as n from public.job_runs where org_id = $1 and status = 'failed'", [bad.orgId])).toBe(2);
    const recovered = await runScheduledJobs({ onlyOrgIds: [bad.orgId] });
    expect(recovered).toMatchObject({ failures: 0, executed: 1 });
    expect(await count('select count(*)::int as n from public.tasks where client_id = $1', [bad.clientId])).toBe(1);
  });

  it('job history is private to each agency and hidden from portal clients', async () => {
    const a = await agencyWithDueDispute('PrivateA');
    const b = await agencyWithDueDispute('PrivateB');
    await runScheduledJobs({ onlyOrgIds: [a.orgId, b.orgId] });
    const fromA = await asUser(a.ownerId, (db) => db.rows<{ org_id: string }>('select org_id from public.job_runs'));
    expect(fromA.length).toBeGreaterThan(0);
    expect(fromA.every((r) => r.org_id === a.orgId)).toBe(true);
    const portal = await addPortalClient(a.orgId);
    expect(await asUser(portal.userId, (db) => db.rows('select 1 from public.job_runs'))).toEqual([]);
  });
});

describe('delivery records', () => {
  // The default sent date is today in the business time zone, which is not the UTC date for part of every evening.
  const today = businessToday();
  const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

  async function approvedLetter() {
    const o = await makeOrg('Delivery');
    const clientId = await addClient(o.orgId, 'Delivery Client');
    await recordConsentRows(o.orgId, clientId);
    const disputeId = await addDispute(o.orgId, clientId, 'approved');
    const letterId = (await withSystem(async (db) => {
      const l = await db.row<{ id: string }>(
        "insert into public.letters (org_id, client_id, dispute_id, kind, title, recipient_name, status, approved_by, approved_at) values ($1,$2,$3,'bureau_dispute','Synthetic letter','Experian','approved',$4, now()) returning id", [o.orgId, clientId, disputeId, o.ownerId]);
      await db.run("insert into public.letter_versions (org_id, letter_id, version, body) values ($1, $2, 1, 'Synthetic letter body for a delivery test.')", [o.orgId, l!.id]);
      await db.run('update public.disputes set approved_by = $2, approved_at = now() where id = $1', [disputeId, o.ownerId]);
      return l!.id;
    }));
    return { ...o, clientId, disputeId, letterId, actor: { orgId: o.orgId, userId: o.ownerId, role: 'owner' as const } };
  }
  const letter = (id: string) => withSystem((db) => db.row<{ status: string; sent_on: string; sent_method: string; tracking_number: string | null; delivery_source: string; carrier_delivered_at: string | null; sent_recorded_by: string }>(
    'select status, sent_on::text, sent_method, tracking_number, delivery_source, carrier_delivered_at, sent_recorded_by from public.letters where id = $1', [id]));

  it('records method, sent date and optional tracking as a staff record, never as a carrier confirmation', async () => {
    const x = await approvedLetter();
    await asUser(x.ownerId, (db) => markSent(db, x.actor, x.letterId, 'certified_mail', ' 9407 1000 0000 0000 0000 00 ', daysAgo(2)));
    expect(await letter(x.letterId)).toEqual({ status: 'sent', sent_on: daysAgo(2), sent_method: 'certified_mail', tracking_number: '9407 1000 0000 0000 0000 00', delivery_source: 'staff_recorded', carrier_delivered_at: null, sent_recorded_by: x.ownerId });

    const y = await approvedLetter();
    await asUser(y.ownerId, (db) => markSent(db, y.actor, y.letterId, 'first_class_mail'));
    expect(await letter(y.letterId)).toMatchObject({ sent_on: today, tracking_number: null, delivery_source: 'staff_recorded' });
  });

  it('submitting a dispute uses the recorded sent date for the dispute and its letter', async () => {
    const x = await approvedLetter();
    await asUser(x.ownerId, (db) => transitionDispute(db, x.actor, x.disputeId, 'submitted', { sentMethod: 'certified_mail', tracking: 'TRACK-1', sentOn: daysAgo(3) }));
    const d = await withSystem((db) => db.row<{ status: string; submitted: string }>("select status, submitted_at::date::text as submitted from public.disputes where id = $1", [x.disputeId]));
    expect(d).toEqual({ status: 'submitted', submitted: daysAgo(3) });
    expect(await letter(x.letterId)).toMatchObject({ status: 'sent', sent_on: daysAgo(3), tracking_number: 'TRACK-1', delivery_source: 'staff_recorded' });
  });

  it('a portal client can read the current text of their own approved or sent letter, and nothing else', async () => {
    const o = await makeOrg('LetterText');
    const mine = await addPortalClient(o.orgId, 'Mine');
    const other = await addPortalClient(o.orgId, 'Other');
    const mk = (clientId: string, status: string, versions: number) => withSystem(async (db) => {
      const l = await db.row<{ id: string }>("insert into public.letters (org_id, client_id, kind, title, recipient_name, status, current_version) values ($1,$2,'bureau_dispute','Synthetic','Experian',$3,$4) returning id", [o.orgId, clientId, status, versions]);
      for (let v = 1; v <= versions; v++) await db.run('insert into public.letter_versions (org_id, letter_id, version, body) values ($1,$2,$3,$4)', [o.orgId, l!.id, v, `synthetic body version ${v}`]);
      return l!.id;
    });
    const sent = await mk(mine.clientId, 'sent', 2);
    const draft = await mk(mine.clientId, 'draft', 1);
    await mk(other.clientId, 'sent', 1);
    const seen = await asUser(mine.userId, (db) => db.rows<{ letter_id: string; version: number }>('select letter_id, version from public.letter_versions order by version'));
    expect(seen).toEqual([{ letter_id: sent, version: 2 }]); // not v1, not the draft, not the other client's
    expect(seen.some((r) => r.letter_id === draft)).toBe(false);
    await expect(asUser(mine.userId, (db) => db.run("update public.letter_versions set body = 'tampered' where letter_id = $1", [sent]))).resolves.toBe(0);
  });

  it('rejects impossible dates and cannot claim carrier delivery on a staff record', async () => {
    expect(() => checkSentOn(new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10))).toThrow(/future/);
    expect(() => checkSentOn('2020-01-01')).toThrow(/year ago/);
    expect(() => checkSentOn('not-a-date')).toThrow(/valid date/);
    const x = await approvedLetter();
    await expect(asUser(x.ownerId, (db) => transitionDispute(db, x.actor, x.disputeId, 'submitted', { sentOn: today, receivedOn: daysAgo(5) }))).rejects.toThrow(/before the sent date/);
    await asUser(x.ownerId, (db) => markSent(db, x.actor, x.letterId, 'manual', undefined, today));
    await expect(withSystem((db) => db.run('update public.letters set carrier_delivered_at = now() where id = $1', [x.letterId]))).rejects.toThrow(/letters_carrier_delivery_chk/);
  });
});

// ================================================================ running out of time, fairly
describe('scheduled jobs: a run that runs out of time', () => {
  const saved = { ...process.env };
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); process.env = { ...saved }; resetEnvCache(); });
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it('stops starting work at its deadline, says who was not reached, still cleans up, and takes those organizations first next time', async () => {
    const [a, b, c] = [await makeOrg('JobsFairA'), await makeOrg('JobsFairB'), await makeOrg('JobsFairC')];
    const ids = [a.orgId, b.orgId, c.orgId];
    const order: string[] = [];
    // Every sweep takes longer than the whole run is allowed: only the first organization is started.
    const slow = async (_: unknown, actor: { orgId: string }) => { order.push(actor.orgId); await sleep(120); return []; };
    const first = await runScheduledJobs({ onlyOrgIds: ids, sweep: slow, deadlineMs: 40 });
    expect(order).toEqual([a.orgId]);
    expect(first).toMatchObject({ orgs: 3, failures: 0, notReached: 2, outreachCutShort: true });
    // The clean-up at the end is not behind the deadline.
    expect(Object.keys(first.cleaned).sort()).toEqual(['invites', 'jobRuns', 'rateLimits', 'resets', 'sessions']);
    expect(await count('select count(*)::int as n from public.job_runs where org_id = any($1::uuid[])', [ids])).toBe(1);

    // The next run takes the two that went without first, and the one that was served last time last.
    order.length = 0;
    const second = await runScheduledJobs({ onlyOrgIds: ids, sweep: async (_, actor) => { order.push(actor.orgId); return []; } });
    expect(order).toEqual([b.orgId, c.orgId, a.orgId]);
    expect(second).toMatchObject({ orgs: 3, failures: 0, notReached: 0, outreachCutShort: false });
    // Cut short again after two: the one left out this time is the one that waited least before, and it is first in the run after.
    order.length = 0;
    await runScheduledJobs({ onlyOrgIds: ids, sweep: async (_, actor) => { order.push(actor.orgId); await sleep(order.length === 2 ? 150 : 0); return []; }, deadlineMs: 100 });
    expect(order).toEqual([b.orgId, c.orgId]);
    order.length = 0;
    await runScheduledJobs({ onlyOrgIds: ids, sweep: async (_, actor) => { order.push(actor.orgId); return []; } });
    expect(order[0]).toBe(a.orgId);
    expect(JOBS_DEADLINE_MS).toBeLessThan(60_000 - 15_000); // room for a send in flight inside the route's 60 seconds
  });

  it('outreach comes after every organization’s own work, and an organization whose outreach was cut off is first in the next run', async () => {
    // Email is "connected": the real driver, with the provider's HTTP API stood in for, and slow to answer.
    Object.assign(process.env, { EMAIL_DRIVER: 'resend', RESEND_API_KEY: 're_test_key_for_vitest' });
    resetEnvCache();
    const sentTo: string[] = [];
    let delay = 1500;
    vi.stubGlobal('fetch', async (url: string | URL, init?: RequestInit) => {
      if (String(url) !== 'https://api.resend.com/emails') throw new Error(`unexpected request to ${String(url)}`);
      const to = (JSON.parse(String(init?.body ?? '{}')) as { to: string[] }).to[0]!;
      sentTo.push(to);
      await sleep(delay);
      return new Response(JSON.stringify({ id: `re_${uniq()}` }), { status: 200 });
    });
    let next = addDays(new Date().toISOString().slice(0, 10), 1);
    while (!isBusinessDay(next)) next = addDays(next, 1);
    const when = new Date(`${next}T20:00:00Z`);
    const orgs = [await makeOrg('JobsOutreachA'), await makeOrg('JobsOutreachB'), await makeOrg('JobsOutreachC')];
    const emails: string[] = [];
    for (const o of orgs) {
      await withSystem((db) => db.run("update public.organizations set settings = settings || $2::jsonb where id = $1", [o.orgId, JSON.stringify({ partner_outreach_enabled: true, lead_mailing_address: '12 Main St, Austin, TX 78701', lead_reply_email: 'hello@agency.example.test' })]));
      await approveOutreach(o.orgId, new Date('2025-06-02T15:00:00Z'));
      const email = `p-${uniq()}@biz.example.test`;
      emails.push(email);
      await asUser(o.ownerId, (db) => addPartners(db, { orgId: o.orgId, userId: o.ownerId }, [{ businessName: 'Hill Realty', contactName: 'Dana Whitfield', category: 'real_estate_agent', email, phone: null, city: 'Austin', state: 'TX', language: 'en', sourceNote: null }], 'Added by hand.'));
    }
    const ids = orgs.map((o) => o.orgId);
    const swept: string[] = [];
    const sweep = async (_: unknown, actor: { orgId: string }) => { swept.push(actor.orgId); return []; };

    // One email takes longer than the time the run has left: the first organization's partner is emailed, and the run
    // does not start on the next organization's outreach.
    const first = await runScheduledJobs({ onlyOrgIds: ids, sweep, now: when, deadlineMs: 1000 });
    // Every organization's own work was done before any outreach started.
    expect(swept).toEqual(ids);
    expect(first).toMatchObject({ failures: 0, notReached: 0, partnerEmails: 1, outreachCutShort: true });
    expect(sentTo).toEqual([emails[0]]);
    // The email that was in flight when the time ran out was finished and recorded: nothing is left half-sent.
    expect(await withSystem((db) => db.rows('select status from public.partner_outreach where org_id = any($1::uuid[])', [ids]))).toEqual([{ status: 'sent' }]);

    // Next run, with time: the two that were left out go first, in turn, and the first is not written to again.
    delay = 0;
    const second = await runScheduledJobs({ onlyOrgIds: ids, sweep, now: when });
    expect(second).toMatchObject({ failures: 0, partnerEmails: 2, outreachCutShort: false });
    expect(sentTo).toEqual([emails[0], emails[1], emails[2]]);
  });

  it('an organization’s own lead emails and client updates stop at the deadline too: the send in flight is finished, the rest waits for the next run, and the run says so', async () => {
    // Email is "connected": the real driver, with the provider's HTTP API stood in for.
    Object.assign(process.env, { EMAIL_DRIVER: 'resend', RESEND_API_KEY: 're_test_key_for_vitest' });
    resetEnvCache();
    // One organization with a queue of its own work: three leads waiting for their welcome email and four client
    // updates by email. A second organization is behind it.
    const [busy, next] = [await makeOrg('JobsOwnQueue'), await makeOrg('JobsOwnQueueNext')];
    const { slug } = (await withSystem((db) => db.row<{ slug: string }>('update public.organizations set settings = settings || $2::jsonb where id = $1 returning slug', [busy.orgId, JSON.stringify({
      lead_followup_enabled: true, lead_followup_since: new Date(Date.now() - 60_000).toISOString(), lead_mailing_address: '12 Main St, Austin, TX 78701', lead_reply_email: 'hello@agency.example.test',
      client_updates: { switches: { team_message: { sms: false, email: true } }, window_since: null },
    })])))!;
    await approveOutreach(busy.orgId); // lead emails go out only for a workspace the platform operator has approved
    // `defer` is given and never run: the welcome is left to the scheduled job, as when the after-response step is lost.
    for (let i = 0; i < 3; i++) expect(await submitLead(slug, { fullName: 'Pat Lead', email: `lead-${uniq()}@example.test`, language: 'en', consent: true }, { ip: testIp(), defer: () => undefined })).toEqual({ ok: true });
    for (let i = 0; i < 4; i++) {
      const c = await addPortalClient(busy.orgId, `Client ${i}`);
      expect(await withSystem((db) => queueClientUpdate(db, { orgId: busy.orgId, clientId: c.clientId, event: 'team_message', subjectId: `m-${i}`, defer: false }))).toBe(1);
    }
    const leadEmails = () => count("select count(*)::int as n from public.lead_outreach where org_id = $1 and status = 'sent'", [busy.orgId]);
    const updates = (status: string) => count('select count(*)::int as n from public.client_updates where org_id = $1 and status = $2', [busy.orgId, status]);
    const ids = [busy.orgId, next.orgId];
    const swept: string[] = [];
    const sweep = async (_: unknown, actor: { orgId: string }) => { swept.push(actor.orgId); return []; };

    // The clock moves only when the test moves it: the run's deadline passes while the first email is with the email service.
    let jump = true;
    const sentTo: string[] = [];
    vi.stubGlobal('fetch', async (url: string | URL, init?: RequestInit) => {
      if (String(url) !== 'https://api.resend.com/emails') throw new Error(`unexpected request to ${String(url)}`);
      sentTo.push((JSON.parse(String(init?.body ?? '{}')) as { to: string[] }).to[0]!);
      if (jump) vi.setSystemTime(Date.now() + 60_000);
      return new Response(JSON.stringify({ id: `re_${uniq()}` }), { status: 200 });
    });
    vi.useFakeTimers({ toFake: ['Date'] });
    const first = await runScheduledJobs({ onlyOrgIds: ids, sweep, deadlineMs: 5_000 });
    vi.useRealTimers();
    jump = false;
    // One lead email was handed over before the deadline. Nothing was claimed after it: not the other two lead emails,
    // not one client update. The second organization was not started, and the result says all of that.
    expect(swept).toEqual([busy.orgId]);
    expect(first).toMatchObject({ failures: 0, leadEmails: 1, clientUpdates: 0, unfinished: 1, notReached: 1 });
    expect(sentTo).toHaveLength(1);
    // The email that was in flight is recorded as sent, the rest is exactly as it was: nothing is left half-done.
    expect(await leadEmails()).toBe(1);
    expect(await count('select count(*)::int as n from public.lead_outreach where org_id = $1', [busy.orgId])).toBe(1);
    expect([await updates('queued'), await updates('sending'), await updates('sent')]).toEqual([4, 0, 0]);
    // The run was still written down for the organization it worked on, and the clean-up ran.
    expect(await count("select count(*)::int as n from public.job_runs where org_id = $1 and status = 'ok'", [busy.orgId])).toBe(1);
    expect(Object.keys(first.cleaned).sort()).toEqual(['invites', 'jobRuns', 'rateLimits', 'resets', 'sessions']);

    // The next run, with time: the organization that went without is first, then the rest of the queue goes out.
    swept.length = 0;
    const second = await runScheduledJobs({ onlyOrgIds: ids, sweep });
    expect(swept).toEqual([next.orgId, busy.orgId]);
    expect(second).toMatchObject({ failures: 0, leadEmails: 2, clientUpdates: 4, unfinished: 0, notReached: 0 });
    expect(sentTo).toHaveLength(7);
    expect(new Set(sentTo).size).toBe(7); // nobody was written to twice
    expect([await leadEmails(), await updates('queued'), await updates('sent')]).toEqual([3, 0, 4]);
  });
});
