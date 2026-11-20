#!/usr/bin/env node
// Platform operator tool: approve a workspace for automatic outreach (the follow-up emails and texts to leads, the
// email sequence to referral partners, and client updates by text), or withdraw the approval.
//   npm run outreach:approve -- <org-slug>            approve under the business name it has now
//   npm run outreach:approve -- <org-slug> --revoke   withdraw: nothing more is sent
// Why a person does this: sign-up is open and unverified, and every workspace sends through this deployment's one email
// service and one text number. Look at the workspace first: is it a real credit repair business, is its name its own,
// where does its partner list come from. Before it approves, the command prints the mailing address and the reply
// address the workspace has saved: they are what its automatic emails carry besides the name. The approval is for the
// business name shown; if the workspace is renamed later, nothing is sent until it is approved again. Approving again
// also restarts the bounce count that can put a sequence on hold. Writes through the system connection (tenant users
// cannot write these columns) and leaves an audit entry. Uses DATABASE_URL (DATABASE_URL_TEST when APP_ENV=test).
import './load-env.mjs';
import pg from 'pg';
import { pgConnectionConfig } from './pg-config.mjs';

const usage = 'Usage: npm run outreach:approve -- <org-slug> [--revoke]';
const args = process.argv.slice(2);
const revoke = args.includes('--revoke');
const slug = args.find((a) => !a.startsWith('--'));
if (!slug) { console.error(usage); process.exit(2); }

const env = process.env.APP_ENV ?? process.env.NODE_ENV ?? 'development';
const url = (env === 'test' && process.env.DATABASE_URL_TEST) || process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL is not set.'); process.exit(1); }

const db = new pg.Client(pgConnectionConfig(url));
await db.connect();
let code = 0;
try {
  await db.query('begin');
  const org = (await db.query("select id, name, mode, status, settings, outreach_approved_at, outreach_approved_name from public.organizations where slug = $1 for update", [slug])).rows[0];
  if (!org) {
    await db.query('rollback');
    console.error(`No workspace has the slug "${slug}". Nothing was changed.`);
    code = 1;
  } else if (!revoke && (org.mode !== 'agency' || org.status !== 'active')) {
    await db.query('rollback');
    console.error(`"${org.name}" (${slug}) is ${org.status === 'active' ? 'a personal workspace' : 'suspended'}: outreach is for active agency workspaces. Nothing was changed.`);
    code = 1;
  } else {
    if (!revoke) {
      // Shown before the approval is recorded: the workspace typed both, and can change them later without a new approval.
      const saved = (v) => (typeof v === 'string' && v.trim() ? JSON.stringify(v.trim()) : 'none saved');
      console.log(`"${org.name}" (${slug}) has saved, for its automatic emails:`);
      console.log(`  Mailing address: ${saved(org.settings?.lead_mailing_address)}`);
      console.log(`  Reply address:   ${saved(org.settings?.lead_reply_email)}`);
    }
    await db.query('update public.organizations set outreach_approved_at = $2, outreach_approved_name = $3 where id = $1', [org.id, revoke ? null : new Date(), revoke ? null : org.name]);
    await db.query(
      "insert into public.audit_logs (org_id, actor_label, action, entity_type, entity_id, metadata) values ($1, 'platform operator (outreach:approve)', $2, 'organization', $1, $3)",
      [org.id, revoke ? 'outreach.approval_withdrawn' : 'outreach.approved', JSON.stringify(revoke ? {} : { name: org.name })]);
    await db.query('commit');
    console.log(revoke
      ? `Approval withdrawn for "${org.name}" (${slug}). No automatic email to leads or partners, and no text, is sent for it.`
      : `Approved "${org.name}" (${slug}) for automatic outreach under that name. Its automatic emails and texts still need the workspace's own switches, its addresses and a connected email or text service. If the two addresses above are not what you expect of this business, withdraw the approval with --revoke.`);
  }
} catch (e) {
  await db.query('rollback').catch(() => undefined);
  console.error(`Nothing was changed: ${e.message}`);
  code = 1;
} finally {
  await db.end();
}
process.exit(code);
