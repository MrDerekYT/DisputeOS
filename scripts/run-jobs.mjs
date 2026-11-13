#!/usr/bin/env node
// Runs the scheduled jobs once by calling the running app:  POST {APP_URL}/api/jobs/run  with the CRON_SECRET.
// The app must be running (npm run dev / npm start) and CRON_SECRET must be set for it; otherwise the endpoint is
// disabled and answers 404. Exits non-zero when the call fails or any organization's jobs failed, so a scheduler
// (cron, a platform's scheduled task) can alert on it. Safe to retry: a second run creates no duplicate actions.
import './load-env.mjs';

const base = (process.env.JOBS_URL ?? process.env.APP_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const secret = process.env.CRON_SECRET;
if (!secret) {
  console.error('CRON_SECRET is not set. Add it to your environment (at least 24 characters) for both the app and this command.');
  process.exit(2);
}
let res;
try {
  res = await fetch(`${base}/api/jobs/run`, { method: 'POST', headers: { authorization: `Bearer ${secret}` }, signal: AbortSignal.timeout(120_000) });
} catch (e) {
  console.error(`Could not reach ${base}/api/jobs/run (${e.message}). Is the app running?`);
  process.exit(1);
}
const text = await res.text();
if (!res.ok) {
  console.error(`Jobs endpoint answered HTTP ${res.status}${res.status === 404 ? ' — CRON_SECRET is not set for the running app' : res.status === 401 ? ' — CRON_SECRET does not match the running app' : ''}.`);
  process.exit(1);
}
const body = JSON.parse(text);
console.log(`Scheduled jobs: ${body.orgs} organization(s), ${body.executed} action(s) run, ${body.pending} waiting for approval, ${body.skipped} skipped (already done), ${body.failures} failure(s).`);
for (const f of body.failed ?? []) console.error(`  FAILED ${f.orgId}: ${f.error}`);
process.exit(body.failures > 0 ? 1 : 0);
