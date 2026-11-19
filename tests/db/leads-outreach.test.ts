import { afterAll, describe, expect, it } from 'vitest';
import { runScheduledJobs } from '@/lib/automation/jobs';
import { optOutLead, optOutToken, runLeadOutreach } from '@/lib/lead-outreach';
import { submitLead } from '@/lib/leads';
import { sentLog, type Email, type SendResult } from '@/lib/mailer';
import { addClient, closePool, makeOrg, testIp, uniq, withSystem, type TestOrg } from './helpers';

afterAll(closePool);

const ADDRESS = '12 Main St, Austin, TX 78701';
const REPLY = 'hello@agency.example.test';
type Agency = TestOrg & { slug: string; name: string };

async function agency(label: string, settings: Record<string, unknown> | null = null): Promise<Agency> {
  const o = await makeOrg(label);
  const r = (await withSystem((db) => db.row<{ slug: string; name: string }>('update public.organizations set settings = settings || $2::jsonb where id = $1 returning slug, name', [o.orgId, JSON.stringify(settings ?? {})])))!;
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
