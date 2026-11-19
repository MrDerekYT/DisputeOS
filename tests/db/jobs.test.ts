import { afterAll, describe, expect, it } from 'vitest';
import { runSweeps } from '@/lib/automation/engine';
import { runScheduledJobs } from '@/lib/automation/jobs';
import { transitionDispute } from '@/lib/disputes/service';
import { checkSentOn, markSent } from '@/lib/letters/service';
import { recordConsentRows } from './consents';
import { addClient, addDispute, addMember, addPortalClient, asUser, closePool, makeOrg, withSystem } from './helpers';

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
  const today = new Date().toISOString().slice(0, 10);
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
