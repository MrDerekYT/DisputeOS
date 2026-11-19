#!/usr/bin/env node
// Platform operator tool: add AI credits to a workspace.
//   npm run credits:grant -- <org-slug> <amount> [note]
// Inserts one `grant` row in public.ai_credit_ledger through the system connection (tenant users cannot write that
// table), writes an audit entry, and prints the new balance. Uses DATABASE_URL (DATABASE_URL_TEST when APP_ENV=test).
// This records a grant only: it takes no payment. Collect payment separately; no payment processor is connected.
import './load-env.mjs';
import pg from 'pg';

const MAX = 100_000;
const usage = 'Usage: npm run credits:grant -- <org-slug> <amount> [note]\n  amount: a whole number from 1 to 100000';
const [slug, rawAmount, ...rest] = process.argv.slice(2);
const note = rest.join(' ').trim().slice(0, 200) || null;
if (!slug || !rawAmount) { console.error(usage); process.exit(2); }
if (!/^[1-9]\d{0,5}$/.test(rawAmount) || Number(rawAmount) > MAX) {
  console.error(`"${rawAmount}" is not a valid amount.\n${usage}`);
  process.exit(2);
}
const amount = Number(rawAmount);

const env = process.env.APP_ENV ?? process.env.NODE_ENV ?? 'development';
const url = (env === 'test' && process.env.DATABASE_URL_TEST) || process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL is not set.'); process.exit(1); }

const db = new pg.Client({ connectionString: url });
await db.connect();
let code = 0;
try {
  await db.query('begin');
  const org = (await db.query('select id, name from public.organizations where slug = $1', [slug])).rows[0];
  if (!org) {
    await db.query('rollback');
    console.error(`No workspace has the slug "${slug}". Nothing was changed.`);
    code = 1;
  } else {
    await db.query('select pg_advisory_xact_lock(hashtextextended($1, 12))', [org.id]); // same lock as spend()
    const row = (await db.query("insert into public.ai_credit_ledger (org_id, delta, reason, note) values ($1, $2, 'grant', $3) returning id", [org.id, amount, note])).rows[0];
    const balance = (await db.query('select coalesce(sum(delta), 0)::int as balance from public.ai_credit_ledger where org_id = $1', [org.id])).rows[0].balance;
    await db.query(
      "insert into public.audit_logs (org_id, actor_label, action, entity_type, metadata) values ($1, 'platform operator (credits:grant)', 'ai_credits.granted', 'ai_credit_ledger', $2)",
      [org.id, JSON.stringify({ ledger_id: Number(row.id), amount, balance_after: balance })]);
    await db.query('commit');
    console.log(`Granted ${amount} AI credits to "${org.name}" (${slug}). New balance: ${balance}.`);
  }
} catch (e) {
  await db.query('rollback').catch(() => undefined);
  console.error(`Grant failed, nothing was changed: ${e.message}`);
  code = 1;
} finally {
  await db.end();
}
process.exit(code);
