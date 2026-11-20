import { afterAll, describe, expect, it, vi } from 'vitest';
import { runScheduledJobs } from '@/lib/automation/jobs';
import { optOutLead, optOutToken, runLeadOutreach } from '@/lib/lead-outreach';
import { submitLead } from '@/lib/leads';
import { sentLog, type Email, type SendResult } from '@/lib/mailer';
import { addClient, approveOutreach, closePool, makeOrg, testIp, uniq, withSystem, type TestOrg } from './helpers';

afterAll(closePool);

const ADDRESS = '12 Main St, Austin, TX 78701';
const REPLY = 'hello@agency.example.test';
type Agency = TestOrg & { slug: string; name: string };

/** A workspace the platform operator has approved for outreach (pass `approved: false` for one nobody has looked at yet, which is what sign-up gives). */
async function agency(label: string, settings: Record<string, unknown> | null = null, approved = true): Promise<Agency> {
  const o = await makeOrg(label);
  const r = (await withSystem((db) => db.row<{ slug: string; name: string }>('update public.organizations set settings = settings || $2::jsonb where id = $1 returning slug, name', [o.orgId, JSON.stringify(settings ?? {})])))!;
  if (approved) await approveOutreach(o.orgId);
  return { ...o, ...r };
}
/** Switched on a moment ago, with the postal and reply addresses saved. */
const ON = () => ({ lead_followup_enabled: true, lead_followup_since: new Date(Date.now() - 60_000).toISOString(), lead_mailing_address: ADDRESS, lead_reply_email: REPLY });

async function enquire(a: Agency, over: Record<string, unknown> = {}, src?: string) {
  const email = `lead-${uniq()}@example.test`;
  expect(await submitLead(a.slug, { fullName: 'Pat Lead', email, goal: 'home', language: 'en', consent: true, ...over }, { ip: testIp(), src })).toEqual({ ok: true });
  const c = (await withSystem((db) => db.row<{ id: string; source: string }>('select id, source from public.clients where org_id = $1 and email = $2', [a.orgId, email])))!;
  return { ...c, email };
}
/** A stand-in for a connected email service: records what would be delivered. */
function outbox(result: Partial<SendResult> = {}) {
  const mails: Email[] = [];
  const send = async (m: Email): Promise<SendResult> => { mails.push(m); return { ok: true, provider: 'resend', providerRef: `ref-${mails.length}`, ...result }; };
  return { mails, opts: { live: true, send } };
}
/** Moves an enquiry (and what was already sent for it) into the past, as if `days` had gone by. */
const age = (a: Agency, clientId: string, days: number) => withSystem(async (db) => {
  await db.run("update public.organizations set settings = settings || jsonb_build_object('lead_followup_since', (now() - interval '30 days')::text) where id = $1", [a.orgId]);
  await db.run("update public.clients set created_at = created_at - make_interval(days => $2) where id = $1", [clientId, days]);
  await db.run("update public.lead_outreach set sent_at = sent_at - make_interval(days => $2), created_at = created_at - make_interval(days => $2) where client_id = $1", [clientId, days]);
});
const steps = (clientId: string) => withSystem((db) => db.rows<{ step: string; status: string; attempts: number }>('select step, status, attempts from public.lead_outreach where client_id = $1 order by created_at', [clientId]));
const count = (sql: string, p: unknown[]) => withSystem((db) => db.row<{ n: number }>(sql, p as never[])).then((r) => r!.n);
const comms = (clientId: string) => count("select count(*)::int as n from public.communications where client_id = $1", [clientId]);

describe('automatic follow-up to leads', () => {
  it('is off by default: an enquiry and a scheduled run send and record nothing', async () => {
    const a = await agency('LeadsOff');
    const l = await enquire(a);
    const box = outbox();
    expect(await runLeadOutreach(a.orgId, box.opts)).toEqual({ sent: 0, failed: 0, blocked: 'off' });
    expect((await runScheduledJobs({ onlyOrgIds: [a.orgId] })).leadEmails).toBe(0);
    expect(box.mails).toEqual([]);
    expect(await steps(l.id)).toEqual([]);
    expect(await comms(l.id)).toBe(0);
  });

  it('sends nothing without a postal address or a reply address, even when switched on', async () => {
    const a = await agency('LeadsNoAddr', { ...ON(), lead_mailing_address: '' });
    const l = await enquire(a);
    const box = outbox();
    expect((await runLeadOutreach(a.orgId, box.opts)).blocked).toBe('no_address');
    await withSystem((db) => db.run("update public.organizations set settings = settings || $2::jsonb where id = $1", [a.orgId, JSON.stringify({ lead_mailing_address: ADDRESS, lead_reply_email: '' })]));
    expect((await runLeadOutreach(a.orgId, box.opts)).blocked).toBe('no_reply');
    expect(box.mails).toEqual([]);
    expect(await steps(l.id)).toEqual([]);
  });

  it('a saved "address" that is not shaped like a postal address counts as no address: nothing is sent until a real one is saved', async () => {
    // What the address field held before it was checked, or what was written straight to the settings: a sentence
    // with a link, or a message of the workspace's own, where the postal address is printed in every email.
    for (const text of ['Claim your refund today at chase-verify.example before it expires', 'Reply to this email and we will fix your credit fast', '45 Elm Road, Dallas']) {
      const a = await agency('LeadsBadAddr', { ...ON(), lead_mailing_address: text });
      const l = await enquire(a);
      const box = outbox();
      expect(await runLeadOutreach(a.orgId, box.opts), text).toEqual({ sent: 0, failed: 0, blocked: 'no_address' });
      expect((await runScheduledJobs({ onlyOrgIds: [a.orgId] })).leadEmails).toBe(0);
      expect(box.mails).toEqual([]);
      expect(await steps(l.id)).toEqual([]);
      expect(await comms(l.id)).toBe(0);
      // With a postal address in its place the welcome goes out, and that address is what the email shows.
      await withSystem((db) => db.run("update public.organizations set settings = settings || $2::jsonb where id = $1", [a.orgId, JSON.stringify({ lead_mailing_address: ADDRESS })]));
      expect(await runLeadOutreach(a.orgId, box.opts)).toEqual({ sent: 1, failed: 0, blocked: null });
      expect(box.mails[0]!.text).toContain(`${a.name} · ${ADDRESS}`);
      expect(box.mails[0]!.text).not.toContain(text);
    }
  });

  it('when email is not connected, nothing is sent and nothing is recorded as sent', async () => {
    const a = await agency('LeadsNoEmail', ON());
    const before = sentLog.length;
    const l = await enquire(a); // submitLead tries the welcome itself
    expect(await runLeadOutreach(a.orgId)).toEqual({ sent: 0, failed: 0, blocked: 'email_not_connected' });
    expect((await runScheduledJobs({ onlyOrgIds: [a.orgId] })).leadEmails).toBe(0);
    expect(sentLog.slice(before).filter((m) => m.to === l.email)).toEqual([]);
    expect(await steps(l.id)).toEqual([]);
    expect(await comms(l.id)).toBe(0);
  });

  it('a workspace the platform operator has not approved sends nothing, and neither does one renamed since', async () => {
    // Sign-up is open and the form takes any address: the name of a workspace nobody has looked at must not reach a stranger's inbox.
    const a = await agency('LeadsNotApproved', ON(), false);
    const l = await enquire(a); // submitLead tries the welcome itself
    const box = outbox();
    expect(await runLeadOutreach(a.orgId, box.opts)).toEqual({ sent: 0, failed: 0, blocked: 'not_approved' });
    expect((await runScheduledJobs({ onlyOrgIds: [a.orgId] })).leadEmails).toBe(0);
    expect(box.mails).toEqual([]);
    expect(await steps(l.id)).toEqual([]);
    expect(await comms(l.id)).toBe(0);
    // Approved, the welcome goes out under the name that was approved.
    await approveOutreach(a.orgId);
    expect(await runLeadOutreach(a.orgId, box.opts)).toEqual({ sent: 1, failed: 0, blocked: null });
    expect(box.mails[0]!.fromName).toBe(a.name);
    // The approval is for that name: after a rename nothing goes out until the operator approves again.
    const later = await enquire(a);
    await withSystem((db) => db.run("update public.organizations set name = 'URGENT your account is on hold, sign in at secure-verify.example' where id = $1", [a.orgId]));
    expect(await runLeadOutreach(a.orgId, box.opts)).toEqual({ sent: 0, failed: 0, blocked: 'not_approved' });
    expect(box.mails).toHaveLength(1);
    expect(await steps(later.id)).toEqual([]);
  });

  it('the approval, the switch and the addresses are read again with every claim: a change while a run is under way ends the run', async () => {
    const a = await agency('LeadsMidRun', ON());
    const [l1, l2] = [await enquire(a), await enquire(a)];
    const mails: Email[] = [];
    const send = async (m: Email): Promise<SendResult> => {
      mails.push(m);
      // While the first email is on its way, the workspace is renamed.
      await withSystem((db) => db.run("update public.organizations set name = name || ' Renamed' where id = $1", [a.orgId]));
      return { ok: true, provider: 'resend', providerRef: 'ref-1' };
    };
    expect(await runLeadOutreach(a.orgId, { live: true, send })).toEqual({ sent: 1, failed: 0, blocked: null, held: 'switched_off' });
    expect(mails.map((m) => m.fromName)).toEqual([a.name]);
    expect((await steps(l1.id)).length + (await steps(l2.id)).length).toBe(1);
    // The same for the switch itself, with the name approved again.
    await approveOutreach(a.orgId);
    const off = async (m: Email): Promise<SendResult> => {
      mails.push(m);
      await withSystem((db) => db.run("update public.organizations set settings = settings || '{\"lead_followup_enabled\": false}'::jsonb where id = $1", [a.orgId]));
      return { ok: true, provider: 'resend', providerRef: 'ref-2' };
    };
    const l3 = await enquire(a);
    expect(await runLeadOutreach(a.orgId, { live: true, send: off })).toEqual({ sent: 1, failed: 0, blocked: null, held: 'switched_off' });
    expect(mails).toHaveLength(2);
    expect(await steps(l3.id)).toEqual([]);
  });

  it('no answer from the email service: the email may have gone out, so that step is never sent again and the run hands nothing more over', async () => {
    const a = await agency('LeadsNoAnswer', ON());
    const [l1, l2] = [await enquire(a), await enquire(a)];
    const silent = outbox({ ok: false, error: 'The operation was aborted due to timeout', unconfirmed: true });
    expect(await runLeadOutreach(a.orgId, silent.opts)).toEqual({ sent: 0, failed: 0, blocked: null, held: 'no_answer' });
    expect(silent.mails).toHaveLength(1);
    const [first, second] = silent.mails[0]!.to === l1.email ? [l1, l2] : [l2, l1];
    expect(await steps(first.id)).toEqual([{ step: 'welcome', status: 'sending', attempts: 1 }]);
    expect(await steps(second.id)).toEqual([]);
    expect(await count("select count(*)::int as n from public.client_events where client_id = $1 and kind = 'lead_outreach_unconfirmed'", [first.id])).toBe(1);
    expect(await count("select count(*)::int as n from public.lead_outreach where client_id = $1 and error like '%timeout%'", [first.id])).toBe(1);
    // The service answers again. The unanswered step is never handed over a second time, and nothing goes out on top of it.
    const good = outbox();
    expect(await runLeadOutreach(a.orgId, good.opts)).toEqual({ sent: 1, failed: 0, blocked: null });
    await age(a, first.id, 3);
    expect((await runLeadOutreach(a.orgId, good.opts)).sent).toBe(0);
    await age(a, first.id, 4);
    expect((await runLeadOutreach(a.orgId, { ...good.opts, clientId: first.id })).sent).toBe(0);
    expect(good.mails.map((m) => m.to)).toEqual([second.email]);
    expect(await steps(first.id)).toEqual([{ step: 'welcome', status: 'sending', attempts: 1 }]);
    expect(await comms(first.id)).toBe(0);
    // A refusal the service did answer with is still a failure, and still tried again.
    const l3 = await enquire(a);
    expect(await runLeadOutreach(a.orgId, { ...outbox({ ok: false, error: 'domain not verified' }).opts, clientId: l3.id })).toEqual({ sent: 0, failed: 1, blocked: null });
    expect(await steps(l3.id)).toEqual([{ step: 'welcome', status: 'failed', attempts: 1 }]);
  });

  it('switched on with an address: each step goes out once, on schedule, and is recorded', async () => {
    const a = await agency('LeadsOn', ON());
    const l = await enquire(a);
    const es = await enquire(a, { language: 'es', fullName: 'Ana Prueba' });
    const box = outbox();

    // Two runs at the same moment and a retry still send one welcome per lead.
    const [r1, r2] = await Promise.all([runLeadOutreach(a.orgId, box.opts), runLeadOutreach(a.orgId, box.opts)]);
    expect(r1.sent + r2.sent).toBe(2);
    expect(await runLeadOutreach(a.orgId, box.opts)).toEqual({ sent: 0, failed: 0, blocked: null });
    expect(box.mails).toHaveLength(2);
    const welcome = box.mails.find((m) => m.to === l.email)!;
    expect(welcome.subject).toBe(`We received your enquiry — ${a.name}`);
    expect(welcome.replyTo).toBe(REPLY);
    expect(welcome.fromName).toBe(a.name); // the From line names the agency, not the platform
    expect(welcome.text).toContain('Hi Pat,');
    expect(welcome.text).toContain(`${a.name} · ${ADDRESS}`);
    expect(welcome.text).toContain(`/unsubscribe/${optOutToken(l.id)}`);
    expect(box.mails.find((m) => m.to === es.email)!.text).toContain('Hola Ana:');

    // One day later nothing is due; after 2 days the follow-up; after 6 the last note; then never again.
    await age(a, l.id, 1);
    expect((await runLeadOutreach(a.orgId, { ...box.opts, clientId: l.id })).sent).toBe(0);
    await age(a, l.id, 1);
    expect((await runLeadOutreach(a.orgId, { ...box.opts, clientId: l.id })).sent).toBe(1);
    expect((await runLeadOutreach(a.orgId, { ...box.opts, clientId: l.id })).sent).toBe(0);
    await age(a, l.id, 4);
    expect((await runLeadOutreach(a.orgId, { ...box.opts, clientId: l.id })).sent).toBe(1);
    await age(a, l.id, 5);
    expect((await runLeadOutreach(a.orgId, { ...box.opts, clientId: l.id })).sent).toBe(0);

    expect((await steps(l.id)).map((s) => `${s.step}:${s.status}`)).toEqual(['welcome:sent', 'followup:sent', 'final:sent']);
    expect(box.mails.filter((m) => m.to === l.email).map((m) => m.subject)).toEqual([`We received your enquiry — ${a.name}`, `Still interested? A quick note from ${a.name}`, `Last note from ${a.name} about your enquiry`]);
    expect(await count("select count(*)::int as n from public.communications where client_id = $1 and direction = 'outbound' and channel = 'email' and status = 'sent' and author_id is null", [l.id])).toBe(3);
    expect(await count("select count(*)::int as n from public.client_events where client_id = $1 and kind = 'lead_outreach'", [l.id])).toBe(3);
    // The Spanish-speaking lead was not touched by the single-lead runs.
    expect((await steps(es.id)).map((s) => s.step)).toEqual(['welcome']);
  });

  it('a failed send is recorded as failed, not as sent, and is retried', async () => {
    const a = await agency('LeadsFail', ON());
    const l = await enquire(a);
    const bad = outbox({ ok: false, error: 'domain not verified' });
    expect(await runLeadOutreach(a.orgId, bad.opts)).toEqual({ sent: 0, failed: 1, blocked: null });
    expect(await steps(l.id)).toEqual([{ step: 'welcome', status: 'failed', attempts: 1 }]);
    expect(await comms(l.id)).toBe(0);
    const good = outbox();
    expect((await runLeadOutreach(a.orgId, good.opts)).sent).toBe(1);
    expect(await steps(l.id)).toEqual([{ step: 'welcome', status: 'sent', attempts: 2 }]);
    expect(await comms(l.id)).toBe(1);
  });

  it('stops when the lead writes back, is contacted by the team, becomes a client or opts out', async () => {
    const a = await agency('LeadsStop', ON());
    const box = outbox();
    const [replied, contacted, converted, optedOut] = [await enquire(a), await enquire(a), await enquire(a), await enquire(a)];
    expect((await runLeadOutreach(a.orgId, box.opts)).sent).toBe(4);
    for (const l of [replied, contacted, converted, optedOut]) await age(a, l.id, 3);

    await withSystem(async (db) => {
      await db.run("insert into public.communications (org_id, client_id, direction, channel, body, status) values ($1, $2, 'inbound', 'email', 'Yes, call me Tuesday', 'received')", [a.orgId, replied.id]);
      await db.run("insert into public.communications (org_id, client_id, direction, channel, body, status, author_id) values ($1, $2, 'internal', 'call', 'Spoke on the phone', 'sent', $3)", [a.orgId, contacted.id, a.ownerId]);
      await db.run("update public.clients set status = 'onboarding' where id = $1", [converted.id]);
    });
    expect(await optOutLead('not-a-token')).toBeNull();
    expect(await optOutLead(optOutToken(optedOut.id).slice(0, -2) + 'xx')).toBeNull();
    expect(await optOutLead(optOutToken(optedOut.id))).toMatchObject({ orgId: a.orgId, orgName: a.name, lang: 'en' });
    await optOutLead(optOutToken(optedOut.id)); // opening the link twice changes nothing
    expect(await count("select count(*)::int as n from public.client_events where client_id = $1 and kind = 'lead_opt_out'", [optedOut.id])).toBe(1);
    expect(await count('select count(*)::int as n from public.clients where id = $1 and outreach_opt_out_at is not null', [optedOut.id])).toBe(1);

    expect(await runLeadOutreach(a.orgId, box.opts)).toEqual({ sent: 0, failed: 0, blocked: null });
    expect(box.mails).toHaveLength(4);
  });

  it('re-checks every stop condition at the moment of sending, not only when the run started', async () => {
    const a = await agency('LeadsRecheck', ON());
    const first = await enquire(a);
    const second = await enquire(a);
    const mails: Email[] = [];
    // While the first email is with the email service, someone on the team logs a call with the second lead.
    const send = async (m: Email): Promise<SendResult> => {
      mails.push(m);
      await withSystem((db) => db.run("insert into public.communications (org_id, client_id, direction, channel, body, status, author_id) values ($1, $2, 'internal', 'call', 'Spoke on the phone', 'sent', $3)", [a.orgId, second.id, a.ownerId]));
      return { ok: true, provider: 'resend', providerRef: 'ref' };
    };
    expect(await runLeadOutreach(a.orgId, { live: true, send })).toEqual({ sent: 1, failed: 0, blocked: null });
    expect(mails.map((m) => m.to)).toEqual([first.email]);
    expect(await steps(second.id)).toEqual([]);
  });

  it('an email the team tried to send but that was not delivered does not count as contact', async () => {
    const a = await agency('LeadsUndelivered', ON());
    const failed = await enquire(a);
    const queued = await enquire(a);
    await withSystem(async (db) => {
      await db.run("insert into public.communications (org_id, client_id, direction, channel, body, status, author_id) values ($1, $2, 'outbound', 'email', 'Hello', 'failed', $3)", [a.orgId, failed.id, a.ownerId]);
      await db.run("insert into public.communications (org_id, client_id, direction, channel, body, status, author_id) values ($1, $2, 'outbound', 'email', 'Hello', 'queued', $3)", [a.orgId, queued.id, a.ownerId]);
    });
    const box = outbox();
    expect((await runLeadOutreach(a.orgId, box.opts)).sent).toBe(2);
  });

  it('if the outcome of a send is never recorded, that step is not sent again and nothing follows it', async () => {
    const a = await agency('LeadsCrash', ON());
    const l = await enquire(a);
    // What a run leaves behind when the process dies after handing the email over and before writing the result.
    const mails: Email[] = [];
    await withSystem((db) => db.run("insert into public.lead_outreach (org_id, client_id, step, status) values ($1, $2, 'welcome', 'sending')", [a.orgId, l.id]));
    const send = async (m: Email): Promise<SendResult> => { mails.push(m); return { ok: true, provider: 'resend' }; };
    expect(await runLeadOutreach(a.orgId, { live: true, send })).toEqual({ sent: 0, failed: 0, blocked: null });
    await age(a, l.id, 7);
    expect(await runLeadOutreach(a.orgId, { live: true, send })).toEqual({ sent: 0, failed: 0, blocked: null });
    expect(mails).toEqual([]);
    expect(await steps(l.id)).toEqual([{ step: 'welcome', status: 'sending', attempts: 1 }]);
  });

  it('the claim is on record before the email is handed over, and no transaction is open during the send', async () => {
    const a = await agency('LeadsClaimFirst', ON());
    const l = await enquire(a);
    let seen: { step: string; status: string; attempts: number }[] = [];
    const send = async (): Promise<SendResult> => {
      seen = await steps(l.id); // a separate connection can already see the committed claim
      // …and can update the lead: the row is not locked while the email service is being called.
      await withSystem(async (db) => {
        await db.run("set local lock_timeout = '2s'");
        await db.run('update public.clients set last_activity_at = now() where id = $1', [l.id]);
      });
      return { ok: true, provider: 'resend', providerRef: 'r1' };
    };
    expect((await runLeadOutreach(a.orgId, { live: true, send })).sent).toBe(1);
    expect(seen).toEqual([{ step: 'welcome', status: 'sending', attempts: 1 }]);
    expect(await steps(l.id)).toEqual([{ step: 'welcome', status: 'sent', attempts: 1 }]);
  });

  it('nothing is claimed once the scheduled job’s deadline has passed: the email in flight is recorded, the rest goes out with the next run', async () => {
    const a = await agency('LeadsDeadline', ON());
    const leads = [await enquire(a), await enquire(a), await enquire(a)];
    const claimed = async () => (await Promise.all(leads.map((l) => steps(l.id)))).map((s) => s.map((x) => x.status).join()).sort();
    const mails: Email[] = [];
    // A deadline that has already passed: nothing is claimed, and the result says why.
    expect(await runLeadOutreach(a.orgId, { live: true, send: async (m) => { mails.push(m); return { ok: true, provider: 'resend' }; }, stopAt: Date.now() - 1 })).toEqual({ sent: 0, failed: 0, blocked: null, held: 'time' });
    expect(await claimed()).toEqual(['', '', '']);
    // The clock moves only when the test moves it: the deadline passes while the first email is with the email service.
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const stopAt = Date.now() + 5_000;
      const send = async (m: Email): Promise<SendResult> => { mails.push(m); vi.setSystemTime(stopAt + 1); return { ok: true, provider: 'resend', providerRef: 'ref' }; };
      expect(await runLeadOutreach(a.orgId, { live: true, send, stopAt })).toEqual({ sent: 1, failed: 0, blocked: null, held: 'time' });
    } finally { vi.useRealTimers(); }
    expect(mails).toHaveLength(1);
    expect(await claimed()).toEqual(['', '', 'sent']);
    // The next run sends the other two, and a run with nothing left to send is not "held".
    const box = outbox();
    expect(await runLeadOutreach(a.orgId, { ...box.opts, stopAt: Date.now() + 60_000 })).toEqual({ sent: 2, failed: 0, blocked: null });
    expect(await runLeadOutreach(a.orgId, { ...box.opts, stopAt: Date.now() - 1 })).toEqual({ sent: 0, failed: 0, blocked: null });
    expect(box.mails.map((m) => m.to).sort()).toEqual(leads.map((l) => l.email).filter((e) => e !== mails[0]!.to).sort());
  });

  it('never emails a lead the team typed in (no consent on file), and stores the source tag from the link', async () => {
    const a = await agency('LeadsConsent', ON());
    const manual = await addClient(a.orgId, 'Typed In', { status: 'lead' });
    const box = outbox();
    expect((await runLeadOutreach(a.orgId, box.opts)).sent).toBe(0);
    expect(await steps(manual)).toEqual([]);
    expect((await enquire(a, {}, 'Instagram')).source).toBe('instagram');
    expect((await enquire(a, {}, 'not a tag!')).source).toBe('Website form');
    expect((await enquire(a)).source).toBe('Website form');
  });

  it('another agency is unaffected', async () => {
    const a = await agency('LeadsA', ON());
    const b = await agency('LeadsB');
    const la = await enquire(a);
    const lb = await enquire(b);
    const box = outbox();
    expect((await runLeadOutreach(a.orgId, box.opts)).sent).toBe(1);
    expect((await runLeadOutreach(b.orgId, box.opts)).blocked).toBe('off');
    expect(box.mails.map((m) => m.to)).toEqual([la.email]);
    expect(await steps(lb.id)).toEqual([]);
    expect(await comms(lb.id)).toBe(0);
    // A token for agency A's lead only ever opts out that lead.
    await optOutLead(optOutToken(la.id));
    expect(await count('select count(*)::int as n from public.clients where id = $1 and outreach_opt_out_at is not null', [lb.id])).toBe(0);
  });
});
