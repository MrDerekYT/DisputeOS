#!/usr/bin/env node
// Platform operator tool: confirm an agency's custom domain after adding it at the hosting provider by hand.
//   npm run domain:verify -- <domain>
// Used when the app is not connected to the hosting provider's API (VERCEL_API_TOKEN / VERCEL_PROJECT_ID not set).
// It asks https://<domain>/api/domain-check which connected domain answers there and compares the id with the
// database. A match means DNS points at this deployment, the hosting provider serves it and the certificate is
// valid. Only then is the row marked verified; on any other answer nothing is changed.
// Uses DATABASE_URL (DATABASE_URL_TEST when APP_ENV=test).
import './load-env.mjs';
import pg from 'pg';
import { pgConnectionConfig } from './pg-config.mjs';

const domain = (process.argv[2] ?? '').trim().toLowerCase();
if (!/^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/.test(domain)) {
  console.error('Usage: npm run domain:verify -- <domain>\n  for example: npm run domain:verify -- www.youragency.com');
  process.exit(2);
}
const env = process.env.APP_ENV ?? process.env.NODE_ENV ?? 'development';
const url = (env === 'test' && process.env.DATABASE_URL_TEST) || process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL is not set.'); process.exit(1); }

const db = new pg.Client(pgConnectionConfig(url));
await db.connect();
let code = 1;
try {
  const row = (await db.query('select d.id, d.org_id, d.status, o.name from public.agency_domains d join public.organizations o on o.id = d.org_id where d.domain = $1', [domain])).rows[0];
  if (!row) {
    console.error(`No workspace has connected "${domain}". The agency saves it first, on its Website page. Nothing was changed.`);
  } else {
    let seen = null;
    let why = '';
    try {
      const res = await fetch(`https://${domain}/api/domain-check`, { redirect: 'manual', signal: AbortSignal.timeout(15_000) });
      if (res.ok) seen = (await res.json()).id ?? null;
      else why = `it answered HTTP ${res.status}`;
    } catch (e) {
      why = `it could not be reached (${e.cause?.code ?? e.message})`;
    }
    if (seen !== row.id) {
      console.error(`Not verified: https://${domain}/api/domain-check ${why || 'answered for a different domain'}.\nCheck that the domain is added to the hosting project, that its DNS records are in place and that the certificate has been issued. Nothing was changed.`);
    } else {
      await db.query('begin');
      await db.query(
        "update public.agency_domains set status = 'verified', verified_at = coalesce(verified_at, now()), verification = (verification - 'error') || jsonb_build_object('checkedAt', now()) where id = $1", [row.id]);
      await db.query(
        "insert into public.audit_logs (org_id, actor_label, action, entity_type, entity_id, metadata) values ($1, 'platform operator (domain:verify)', 'org.domain_verified', 'organization', $1, $2)",
        [row.org_id, JSON.stringify({ domain })]);
      await db.query('commit');
      console.log(`Verified: ${domain} now serves the website and client sign-in of "${row.name}". Running servers pick it up within a minute.`);
      code = 0;
    }
  }
} catch (e) {
  await db.query('rollback').catch(() => undefined);
  console.error(`Failed, nothing was changed: ${e.message}`);
} finally {
  await db.end();
}
process.exit(code);
