#!/usr/bin/env node
// DEVELOPMENT ONLY. Creates a clearly-labelled demo agency with fictional clients so you can click around.
// Refuses to run in staging/production. Safe to re-run: it removes and recreates the demo organization.
import './load-env.mjs';
import { randomBytes, scrypt } from 'node:crypto';
import pg from 'pg';

const env = process.env.APP_ENV ?? process.env.NODE_ENV ?? 'development';
if (env === 'production' || env === 'staging' || process.env.NODE_ENV === 'production') {
  console.error('Refusing to seed demo data outside development/test.');
  process.exit(1);
}
const url = (env === 'test' && process.env.DATABASE_URL_TEST) || process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL is not set.'); process.exit(1); }

const hash = (pw) => new Promise((res, rej) => {
  const salt = randomBytes(16);
  scrypt(pw.normalize('NFKC'), salt, 64, { N: 2 ** 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 }, (e, k) => (e ? rej(e) : res(`scrypt$32768$8$1$${salt.toString('base64')}$${k.toString('base64')}`)));
});

const PASSWORD = process.env.SEED_PASSWORD ?? 'Demo-Passw0rd-2026!';
const db = new pg.Client({ connectionString: url });
await db.connect();
const q = async (sql, p) => (await db.query(sql, p)).rows;
const one = async (sql, p) => (await q(sql, p))[0];

try {
  await db.query('begin');
  const old = await one("select id from public.organizations where slug = 'demo-agency'");
  if (old) {
    await db.query("delete from public.users where id in (select user_id from public.memberships where org_id = $1)", [old.id]);
    await db.query('delete from public.organizations where id = $1', [old.id]);
  }
  const org = await one("insert into public.organizations (name, slug, mode, state_code, trial_ends_at, settings) values ('Demo Agency (sample data)', 'demo-agency', 'agency', 'FL', now() + interval '14 days', '{\"retention_days\":2555,\"brand_color\":\"#4338ca\"}') returning id");
  const pw = await hash(PASSWORD);
  const mk = async (email, name, role) => {
    const u = await one('insert into public.users (email, password_hash, full_name, email_verified_at) values ($1,$2,$3,now()) returning id', [email, pw, name]);
    await db.query('insert into public.memberships (org_id, user_id, role) values ($1,$2,$3)', [org.id, u.id, role]);
    return u.id;
  };
  const owner = await mk('owner@demo.disputeos.test', 'Avery Morgan', 'owner');
  const manager = await mk('manager@demo.disputeos.test', 'Riley Chen', 'manager');
  const specialist = await mk('specialist@demo.disputeos.test', 'Sam Okafor', 'specialist');

  const consentKinds = ['croa_disclosure', 'croa_contract', 'fcra_authorization'];
  const people = [
    ['Jordan Rivera', 'jordan.rivera@example.test', 'active', 'disputing', specialist, true, 'en'],
    ['María Gómez', 'maria.gomez@example.test', 'active', 'analysis', specialist, true, 'es'],
    ['Devon Brooks', 'devon.brooks@example.test', 'active', 'disputing', manager, true, 'en'],
    ['Alicia Torres', 'alicia.torres@example.test', 'completed', 'graduated', manager, true, 'es'],
    ['Sam Lee', 'sam.lee@example.test', 'onboarding', 'intake', specialist, false, 'en'],
    ['Taylor Nguyen', 'taylor.nguyen@example.test', 'lead', 'intake', null, false, 'en'],
  ];
  const ids = {};
  for (const [name, email, status, stage, assigned, consents, lang] of people) {
    const c = await one(
      `insert into public.clients (org_id, assigned_to, full_name, email, phone, preferred_language, status, stage, source, address, last_activity_at)
       values ($1,$2,$3,$4,'813-555-0100',$5,$6,$7,'Sample data',$8, now() - ($9 || ' days')::interval) returning id`,
      [org.id, assigned, name, email, lang, status, stage, JSON.stringify({ line1: '123 Sample St', city: 'Tampa', state: 'FL', zip: '33602' }), String(Math.floor(Math.random() * 40))]);
    ids[name] = c.id;
    await db.query("insert into public.client_events (org_id, client_id, actor_id, kind, summary) values ($1,$2,$3,'client_created','Client created')", [org.id, c.id, owner]);
    if (consents) for (const k of consentKinds) await db.query("insert into public.client_consents (org_id, client_id, kind, version, signed_name, signed_at) values ($1,$2,$3,'seed',$4, now() - interval '20 days')", [org.id, c.id, k, name]);
  }

  // Portal logins for two clients (so you can see the client experience; sign in at /portal/login)
  for (const [name, email] of [['Jordan Rivera', 'jordan.rivera@example.test'], ['María Gómez', 'maria.gomez@example.test']]) {
    const u = await one('insert into public.users (email, password_hash, full_name, email_verified_at) values ($1,$2,$3,now()) returning id', [email, pw, name]);
    await db.query("insert into public.memberships (org_id, user_id, role) values ($1,$2,'client')", [org.id, u.id]);
    await db.query('update public.clients set portal_user_id = $2 where id = $1', [ids[name], u.id]);
  }

  // Reports for Jordan (pending review: approve them in the UI to see the bureau comparison and findings)
  const addReport = async (client, bureau, rows, scores = []) => {
    const r = await one("insert into public.credit_reports (org_id, client_id, bureau, source, status, report_date, created_by, approved_by) values ($1,$2,$3,'upload','approved', current_date, $4, $5) returning id", [org.id, client, bureau, specialist, manager]);
    // older reports (no accounts) so the score history has a trend; sample numbers for the demo agency only
    for (const [daysAgo, score] of scores) {
      const old = await one("insert into public.credit_reports (org_id, client_id, bureau, source, status, report_date, created_by, approved_by) values ($1,$2,$3,'upload','approved', current_date - $4::int, $5, $6) returning id", [org.id, client, bureau, daysAgo, specialist, manager]);
      await db.query("insert into public.credit_scores (org_id, client_id, report_id, bureau, model, score, scored_on) values ($1,$2,$3,$4,'VantageScore 3.0',$5, current_date - $6::int)", [org.id, client, old.id, bureau, score, daysAgo]);
    }
    for (const t of rows) {
      await db.query(
        `insert into public.tradelines (org_id, client_id, report_id, bureau, item_type, creditor_name, original_creditor, account_last4, account_type, account_status, payment_status, balance_cents, credit_limit_cents, date_opened, date_reported, date_of_first_delinquency, payment_history, match_key, confidence)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,1)`,
        [org.id, client, r.id, bureau, t.type ?? 'tradeline', t.name, t.oc ?? null, t.last4, t.kind ?? 'Revolving', t.status ?? 'Open', t.pay ?? 'Current', t.bal, t.limit ?? null, t.opened, '2026-01-02', t.dofd ?? null, t.hist ?? null, `${t.name.toLowerCase().replace(/[^a-z]/g, '')}|${t.last4}`]);
    }
  };
  const base = [
    { name: 'CAPITAL ONE BANK USA', last4: '1234', bal: 120000, limit: 500000, opened: '2018-03-01', hist: 'CCCC30CC' },
    { name: 'SYNCHRONY BANK', last4: '5521', bal: 45000, limit: 150000, opened: '2020-07-15', pay: 'Late 30 days', hist: 'CCC30CCC' },
  ];
  await addReport(ids['Jordan Rivera'], 'experian', [...base, { name: 'MIDLAND CREDIT MGMT', oc: 'CAPITAL ONE', last4: '7766', type: 'collection', kind: 'Collection', pay: 'Collection', bal: 98000, opened: '2021-02-01', dofd: '2016-02-14' }], [[120, 548], [60, 571], [14, 590]]);
  await addReport(ids['Jordan Rivera'], 'equifax', [{ ...base[0], bal: 90000 }, base[1]], [[120, 551], [60, 566], [14, 584]]);
  await addReport(ids['Jordan Rivera'], 'transunion', [base[0], { ...base[1], opened: '2020-08-01' }], [[120, 556], [60, 575], [14, 593]]);
  for (const [bu, sc] of [['experian', 603], ['equifax', 598], ['transunion', 607]]) {
    const rr = await one("select id from public.credit_reports where client_id = $1 and bureau = $2 and report_date = current_date", [ids['Jordan Rivera'], bu]);
    await db.query("insert into public.credit_scores (org_id, client_id, report_id, bureau, model, score, scored_on) values ($1,$2,$3,$4,'VantageScore 3.0',$5,current_date)", [org.id, ids['Jordan Rivera'], rr.id, bu, sc]);
  }

  // Disputes at several stages, each with a letter
  const disp = async (client, label, bureau, status, extra = {}) => {
    const d = await one(
      `insert into public.disputes (org_id, client_id, item_label, bureau, recipient_name, category, reason, status, round, submitted_at, due_at, outcome, response_at, assigned_to, created_by, approved_by, approved_at)
       values ($1,$2,$3,$4,$5,'incorrect_balance',$6,$7,$8,$9,$10,$11,$12,$13,$13,$14,$15) returning id`,
      [org.id, client, label, bureau, bureau[0].toUpperCase() + bureau.slice(1), 'Please verify the balance with the furnisher and correct it if it is not accurate.', status, extra.round ?? 1,
        extra.sub ?? null, extra.due ?? null, extra.outcome ?? null, extra.resp ?? null, specialist, ['approved', 'submitted', 'under_investigation', 'response_received', 'resolved'].includes(status) ? manager : null,
        ['approved', 'submitted', 'under_investigation', 'response_received', 'resolved'].includes(status) ? new Date() : null]);
    const l = await one(`insert into public.letters (org_id, client_id, dispute_id, kind, title, recipient_name, status, created_by) values ($1,$2,$3,'bureau_dispute',$4,$5,$6,$7) returning id`,
      [org.id, client, d.id, `Bureau dispute — ${label}`, bureau, ['submitted', 'under_investigation', 'response_received', 'resolved'].includes(status) ? 'sent' : status === 'approved' ? 'approved' : 'draft', specialist]);
    await db.query(`insert into public.letter_versions (org_id, letter_id, version, body, source, author_id) values ($1,$2,1,$3,'template',$4)`, [org.id, l.id, `Sample letter body for ${label}.\n\nThis is seeded demo content.`, specialist]);
    return d.id;
  };
  const day = (n) => new Date(Date.now() + n * 86400000);
  await disp(ids['Jordan Rivera'], 'Capital One ••1234 (Experian)', 'experian', 'ready_for_review');
  await disp(ids['Jordan Rivera'], 'Synchrony ••5521 (Equifax)', 'equifax', 'under_investigation', { sub: day(-12), due: day(18) });
  await disp(ids['Devon Brooks'], 'Verizon ••9001 (TransUnion)', 'transunion', 'submitted', { sub: day(-27), due: day(3) });
  await disp(ids['Devon Brooks'], 'Credit One ••4410 (Experian)', 'experian', 'submitted', { sub: day(-40), due: day(-6) });
  await disp(ids['Alicia Torres'], 'Cavalry SPV ••3300 (TransUnion)', 'transunion', 'resolved', { sub: day(-80), due: day(-50), outcome: 'deleted', resp: day(-55) });
  await disp(ids['Alicia Torres'], 'Ally ••1188 (Equifax)', 'equifax', 'resolved', { sub: day(-85), due: day(-55), outcome: 'updated', resp: day(-60) });
  await disp(ids['Alicia Torres'], 'Midland ••7000 (Experian)', 'experian', 'resolved', { sub: day(-85), due: day(-55), outcome: 'verified', resp: day(-58) });
  await disp(ids['María Gómez'], 'LVNV Funding ••2200 (Equifax)', 'equifax', 'draft');

  await db.query("insert into public.document_requests (org_id, client_id, kind, note, created_by, created_at) values ($1,$2,'id','A clear photo of your driver license',$3, now() - interval '5 days')", [org.id, ids['Sam Lee'], specialist]);
  await db.query("insert into public.tasks (org_id, client_id, assignee_id, created_by, title, kind, due_at) values ($1,$2,$3,$3,'Call Sam to collect ID and proof of address','follow_up', now() + interval '1 day')", [org.id, ids['Sam Lee'], specialist]);
  await db.query("insert into public.client_notes (org_id, client_id, author_id, body, pinned) values ($1,$2,$3,'Prefers email. Wants to qualify for an auto loan within a year (client’s words, not a target).', true)", [org.id, ids['Jordan Rivera'], specialist]);
  const plan = await one("insert into public.service_plans (org_id, name, price_cents, interval, description) values ($1,'Monthly service',9900,'month','Dispute management and monthly review') returning id", [org.id]);
  for (const n of ['Jordan Rivera', 'Devon Brooks']) {
    const s = await one('insert into public.client_subscriptions (org_id, client_id, plan_id) values ($1,$2,$3) returning id', [org.id, ids[n], plan.id]);
    await db.query("insert into public.payments (org_id, client_id, subscription_id, amount_cents, method, recorded_by, paid_at) values ($1,$2,$3,9900,'card',$4, now() - interval '12 days')", [org.id, ids[n], s.id, manager]);
  }
  await db.query('commit');
  console.log(`Seeded "Demo Agency (sample data)".\n  owner       owner@demo.disputeos.test\n  manager     manager@demo.disputeos.test\n  specialist  specialist@demo.disputeos.test\n  client portal  jordan.rivera@example.test  (and maria.gomez@example.test, Spanish)\n  password    ${PASSWORD}\nSet REQUIRE_STAFF_MFA=false in .env.local to skip two-step verification locally.`);
} catch (e) {
  await db.query('rollback').catch(() => {});
  console.error(e);
  process.exit(1);
} finally {
  await db.end();
}
