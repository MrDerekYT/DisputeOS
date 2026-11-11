import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clientCare } from '@/lib/client-care';
import { draftDisputesFromFindings, transitionDispute, type DActor } from '@/lib/disputes/service';
import { submitLead } from '@/lib/leads';
import { addClient, addMember, asUser, closePool, makeOrg, testIp, uniq, withSystem, type TestOrg } from './helpers';

let org: TestOrg;
let slug: string;
const owner = (): DActor => ({ orgId: org.orgId, userId: org.ownerId, role: 'owner' });
const lead = (over: Record<string, unknown> = {}) => ({ fullName: 'Pat Lead', email: `pat-${uniq()}@example.test`, phone: '555-0100', message: 'Two collections I do not recognise', goal: 'home', language: 'en', consent: true, ...over });

beforeAll(async () => {
  org = await makeOrg('Growth');
  slug = (await withSystem((db) => db.row<{ slug: string }>('select slug from public.organizations where id = $1', [org.orgId])))!.slug;
});
afterAll(closePool);

describe('public enquiry form', () => {
  it('creates a lead with a follow-up task, and it shows in client care', async () => {
    const input = lead();
    expect(await submitLead(slug, input, { ip: testIp() })).toEqual({ ok: true });
    const c = await withSystem((db) => db.row<{ id: string; status: string; source: string; goals: string }>('select id, status, source, goals from public.clients where org_id = $1 and email = $2', [org.orgId, input.email]));
    expect(c).toMatchObject({ status: 'lead', source: 'Website form', goals: 'Goal: Buying a home. Two collections I do not recognise' });
    const t = await withSystem((db) => db.rows<{ title: string }>('select title from public.tasks where client_id = $1', [c!.id]));
    expect(t.map((x) => x.title)).toEqual(['Contact new lead: Pat Lead']);
    const care = await asUser(org.ownerId, (db) => clientCare(db));
    expect(care.leads.map((l) => l.id)).toContain(c!.id);
  });

  it('gives the same answer for an email already on file and creates nothing new', async () => {
    const input = lead();
    await submitLead(slug, input, { ip: testIp() });
    expect(await submitLead(slug, { ...input, fullName: 'Someone Else' }, { ip: testIp() })).toEqual({ ok: true });
    const n = await withSystem((db) => db.row<{ n: number }>('select count(*)::int as n from public.clients where org_id = $1 and email = $2', [org.orgId, input.email]));
    expect(n!.n).toBe(1);
  });

  it('requires consent to be contacted and a valid email; ignores bots; refuses unknown or personal workspaces', async () => {
    expect((await submitLead(slug, lead({ consent: false }), { ip: testIp() })).ok).toBe(false);
    expect((await submitLead(slug, lead({ email: 'nope' }), { ip: testIp() })).ok).toBe(false);
    const bot = lead();
    expect(await submitLead(slug, bot, { ip: testIp(), honeypot: 'http://spam.example' })).toEqual({ ok: true });
    expect(await withSystem((db) => db.row('select 1 from public.clients where email = $1', [bot.email]))).toBeNull();
    expect((await submitLead('no-such-agency', lead(), { ip: testIp() })).ok).toBe(false);
    const personal = await makeOrg('Solo');
    const ps = (await withSystem((db) => db.row<{ slug: string }>("update public.organizations set mode = 'personal' where id = $1 returning slug", [personal.orgId])))!.slug;
    expect((await submitLead(ps, lead(), { ip: testIp() })).ok).toBe(false);
  });

  it('rate limits repeated submissions from one address', async () => {
    const ip = testIp();
    const results = [];
    for (let i = 0; i < 7; i++) results.push((await submitLead(slug, lead(), { ip })).ok);
    expect(results.slice(0, 5)).toEqual([true, true, true, true, true]);
    expect(results.slice(5)).toEqual([false, false]);
  });
});

describe('drafting several disputes from findings', () => {
  async function seed() {
    const clientId = await addClient(org.orgId, `Bulk ${uniq()}`);
    return withSystem(async (db) => {
      const rep = async (bureau: string, status: string) => (await db.row<{ id: string }>(
        "insert into public.credit_reports (org_id, client_id, bureau, status) values ($1, $2, $3, $4) returning id", [org.orgId, clientId, bureau, status]))!.id;
      const tl = async (reportId: string, bureau: string, name: string) => (await db.row<{ id: string }>(
        "insert into public.tradelines (org_id, client_id, report_id, bureau, creditor_name, account_last4) values ($1, $2, $3, $4, $5, '4410') returning id", [org.orgId, clientId, reportId, bureau, name]))!.id;
      const finding = async (category: string, tradelineIds: string[], status = 'suggested') => (await db.row<{ id: string }>(
        `insert into public.findings (org_id, client_id, category, severity, title, explanation, evidence, basis, status, tradeline_ids, dedupe_key)
         values ($1, $2, $3, 'review', $4, 'Balances differ between bureaus.', $5, 'potential_discrepancy', $6, $7, $8) returning id`,
        [org.orgId, clientId, category, `${category} finding`, JSON.stringify([{ bureau: 'experian', field: 'Balance', value: '$1,200', source: 'reported' }, { bureau: 'equifax', field: 'Balance', value: '$900', source: 'reported' }]), status, tradelineIds, uniq()]))!.id;
      const approved = await rep('experian', 'approved');
      const pending = await rep('equifax', 'pending_review');
      const t1 = await tl(approved, 'experian', 'Credit One');
      const t2 = await tl(pending, 'equifax', 'Unreviewed Bank');
      return { clientId, good: await finding('balance_mismatch', [t1]), unapproved: await finding('status_mismatch', [t2]), dismissed: await finding('date_mismatch', [t1], 'dismissed') };
    });
  }

  it('creates drafts only for usable findings, explains every skip, and never submits anything', async () => {
    const s = await seed();
    const r = await asUser(org.ownerId, (db) => draftDisputesFromFindings(db, owner(), s.clientId, [s.good, s.unapproved, s.dismissed]));
    expect(r.created.map((c) => c.findingId)).toEqual([s.good]);
    expect(r.skipped.map((x) => x.findingId).sort()).toEqual([s.unapproved, s.dismissed].sort());
    for (const x of r.skipped) expect(x.why).toMatch(/\S/);
    const d = await withSystem((db) => db.row<{ status: string; reason: string; item_label: string; submitted_at: string | null }>('select status, reason, item_label, submitted_at from public.disputes where id = $1', [r.created[0]!.id]));
    expect(d).toMatchObject({ status: 'draft', submitted_at: null, item_label: 'Credit One ••4410 (Experian)' });
    expect(d!.reason).toContain('Experian reports $1,200');
    expect(d!.reason).toMatch(/verified/i);
    // the usual gates still apply to a bulk draft: it cannot jump to "submitted"
    await expect(asUser(org.ownerId, (db) => transitionDispute(db, owner(), r.created[0]!.id, 'submitted', {}))).rejects.toThrow();
    // running it again does not create a second dispute for the same finding
    const again = await asUser(org.ownerId, (db) => draftDisputesFromFindings(db, owner(), s.clientId, [s.good]));
    expect(again.created).toEqual([]);
    expect(again.skipped[0]!.why).toMatch(/already/);
  });

  it('refuses findings from another client, empty selections and roles without permission', async () => {
    const a = await seed();
    const b = await seed();
    const r = await asUser(org.ownerId, (db) => draftDisputesFromFindings(db, owner(), a.clientId, [b.good]));
    expect(r.created).toEqual([]);
    await expect(asUser(org.ownerId, (db) => draftDisputesFromFindings(db, owner(), a.clientId, []))).rejects.toThrow(/at least one/);
    const portal = await addMember(org.orgId, 'client', 'c');
    await expect(asUser(org.ownerId, (db) => draftDisputesFromFindings(db, { orgId: org.orgId, userId: portal.id, role: 'client' }, a.clientId, [a.good]))).rejects.toThrow();
  });
});
