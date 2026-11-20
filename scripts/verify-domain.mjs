#!/usr/bin/env node
// Platform operator tool: confirm an agency's custom domain after adding it at the hosting provider by hand.
//   npm run domain:verify -- <domain>
// Used when the app is not connected to the hosting provider's API (VERCEL_API_TOKEN / VERCEL_PROJECT_ID not set).
// It first prints the workspace that holds the domain, then makes two checks:
//   1. https://<domain>/api/domain-check answers with the id of this row. That means DNS points at this deployment,
//      the hosting provider serves it and the certificate is valid. It is true whichever workspace holds the row.
//   2. The TXT record _disputeos.<domain without "www."> holds this workspace's value, the one its Website page shows.
//      Only someone who manages the domain's DNS can create it, so it is what says the domain is this workspace's.
//      The value is a keyed hash made exactly as src/lib/agency-domains.ts makes it, so this needs the app's key.
// Only when both pass is the row marked verified; on any other answer nothing is changed.
// Uses DATABASE_URL (DATABASE_URL_TEST when APP_ENV=test), PII_ENCRYPTION_KEY and, when set, PII_ENCRYPTION_KEY_PREVIOUS.
import './load-env.mjs';
import { createHmac } from 'node:crypto';
import { Resolver } from 'node:dns/promises';
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
const keys = [process.env.PII_ENCRYPTION_KEY, process.env.PII_ENCRYPTION_KEY_PREVIOUS].filter((k) => k?.trim());
if (!process.env.PII_ENCRYPTION_KEY?.trim()) {
  console.error('PII_ENCRYPTION_KEY is not set. The TXT record that ties a domain to its workspace is made with the key the app runs with, so this check cannot be made without it. Set it to the same value as the app and run this again. Nothing was changed.');
  process.exit(1);
}
if (keys.some((k) => Buffer.from(k, 'base64').length !== 32)) {
  console.error('PII_ENCRYPTION_KEY (or PII_ENCRYPTION_KEY_PREVIOUS) is not 32 bytes in base64, so it is not a key the app runs with. Nothing was changed.');
  process.exit(1);
}

const bare = domain.replace(/^www\./, '');
const txtName = `_disputeos.${bare}`;
// The same value as ownershipValue() in src/lib/agency-domains.ts (tests/db/agency-domains.test.ts holds the two together).
const valueFor = (key, orgId) => createHmac('sha256', Buffer.from(key, 'base64')).update(`domain-owner:${orgId}:${bare}`).digest('base64url');

const db = new pg.Client(pgConnectionConfig(url));
await db.connect();
let code = 1;
try {
  const row = (await db.query('select d.id, d.org_id, d.status, o.name, o.slug from public.agency_domains d join public.organizations o on o.id = d.org_id where d.domain = $1', [domain])).rows[0];
  if (!row) {
    console.error(`No workspace has connected "${domain}". The agency saves it first, on its Website page. Nothing was changed.`);
  } else {
    const who = `"${row.name}" (${row.slug})`;
    console.log(`Checking ${domain} for the workspace ${who}.`);
    const problems = [];

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
      problems.push(`https://${domain}/api/domain-check ${why || 'answered for a different domain'}. Check that the domain is added to the hosting project, that its DNS records are in place and that the certificate has been issued.`);
    }

    let found = [];
    let dnsError = '';
    try {
      found = (await new Resolver({ timeout: 5000, tries: 2 }).resolveTxt(txtName)).map((chunks) => chunks.join('').trim());
    } catch (e) {
      if (e.code !== 'ENODATA' && e.code !== 'ENOTFOUND') dnsError = e.code ?? e.message;
    }
    if (dnsError) {
      problems.push(`The TXT record ${txtName} could not be looked up (${dnsError}). Try again in a few minutes.`);
    } else if (!keys.some((k) => found.includes(valueFor(k, row.org_id)))) {
      const want = `the value of ${who}, which is ${valueFor(keys[0], row.org_id)}`;
      problems.push(found.length
        ? `The TXT record ${txtName} is there, but it does not hold ${want}. It was made for another workspace or copied wrongly. Whoever manages the domain's DNS has not connected it to this workspace.`
        : `The TXT record ${txtName} was not found. It has to hold ${want}. The agency sees it on its Website page and creates it where it manages the domain's DNS.`);
    }

    if (problems.length) {
      console.error(`Not verified. Nothing was changed.\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    } else {
      await db.query('begin');
      const marked = await db.query(
        "update public.agency_domains set status = 'verified', verified_at = coalesce(verified_at, now()), verification = (verification - 'error') || jsonb_build_object('checkedAt', now()) where id = $1", [row.id]);
      if (!marked.rowCount) {
        // The row that was checked is gone: the workspace removed the domain, or another one took the name over.
        await db.query('rollback');
        console.error(`Not verified: ${domain} was removed from ${who} while it was being checked. Nothing was changed.`);
      } else {
        await db.query(
          "insert into public.audit_logs (org_id, actor_label, action, entity_type, entity_id, metadata) values ($1, 'platform operator (domain:verify)', 'org.domain_verified', 'organization', $1, $2)",
          [row.org_id, JSON.stringify({ domain })]);
        await db.query('commit');
        console.log(`Verified: ${domain} now serves the website and client sign-in of ${who}. Running servers pick it up within a minute.`);
        code = 0;
      }
    }
  }
} catch (e) {
  await db.query('rollback').catch(() => undefined);
  console.error(`Failed, nothing was changed: ${e.message}`);
} finally {
  await db.end();
}
process.exit(code);
