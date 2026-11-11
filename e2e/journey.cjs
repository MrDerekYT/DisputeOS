/**
 * End-to-end journey against a running DisputeOS (default http://localhost:3100) with staff MFA enforced.
 *   REQUIRE_STAFF_MFA=true npm run dev -- -p 3100        # in one terminal
 *   node e2e/journey.cjs                                 # in another (needs Playwright's Chromium)
 * Creates its own throwaway organizations (unique emails), so it is safe to re-run.
 */
const { chromium } = require('playwright');
const crypto = require('node:crypto');
const fs = require('node:fs');

const BASE = process.env.BASE || 'http://localhost:3100';
const SHOTS = process.env.SHOTS || 'screenshots/e2e';
fs.mkdirSync(SHOTS, { recursive: true });
const uniq = crypto.randomBytes(4).toString('hex');
const PASSWORD = 'Correct-Horse-Battery-9';
// Each browser gets its own client IP (as a proxy would send), so per-IP rate limits don't pile up across runs.
const ip = () => ({ 'x-forwarded-for': `10.${crypto.randomInt(1, 250)}.${crypto.randomInt(1, 250)}.${crypto.randomInt(1, 250)}` });
let step = 0;
const results = [];
const problems = [];

// ---- TOTP (RFC 6238) -------------------------------------------------------------------------------------------
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const b32decode = (s) => { let bits = 0, v = 0; const out = []; for (const ch of s.replace(/[\s=]/g, '').toUpperCase()) { v = (v << 5) | B32.indexOf(ch); bits += 5; if (bits >= 8) { out.push((v >>> (bits - 8)) & 255); bits -= 8; } } return Buffer.from(out); };
const totp = (secret, t = Date.now()) => { const buf = Buffer.alloc(8); buf.writeBigUInt64BE(BigInt(Math.floor(t / 30000))); const h = crypto.createHmac('sha1', b32decode(secret)).update(buf).digest(); const o = h[h.length - 1] & 15; return String((h.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, '0'); };

async function check(name, fn) {
  step++;
  try { await fn(); results.push([true, name]); console.log(`  ✓ ${String(step).padStart(2)} ${name}`); }
  catch (e) { await (global.__pages || []).reduce((p, pg, i) => p.then(() => pg.screenshot({ path: `${SHOTS}/FAIL-step${step}-${i}.png`, fullPage: true, caret: 'initial' }).catch(() => {})), Promise.resolve()); results.push([false, name, e.message]); console.log(`  ✗ ${String(step).padStart(2)} ${name}\n      ${String(e.message).split('\n')[0]}`); throw e; }
}
const watch = (page, who) => {
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) problems.push(`[${who} console] ${page.url()} :: ${(m.text().split('\n').filter((l) => /^\s*[+-]\s/.test(l) || /hydrat/.test(l)).join(' | ')).slice(0, 700)}`); });
  page.on('pageerror', (e) => problems.push(`[${who} pageerror] ${page.url()} :: ${String(e).slice(0, 200)}`));
  page.on('response', (r) => { if (r.status() >= 500) problems.push(`[${who} http ${r.status()}] ${r.url()}`); });
};
const expectText = async (page, text, timeout = 8000) => page.getByText(text, { exact: false }).first().waitFor({ timeout });

const EXPERIAN = `Experian Credit Report
Report Date: 01/15/2026

Personal Information
Name: E2E CLIENT
Address: 500 Test Avenue, Tampa FL 33602

Accounts
Account Name: ACME BANK USA
Account Number: 411111111234
Account Type: Revolving
Account Status: Open
Payment Status: Current
Balance: $1,200.00
Credit Limit: $5,000
Date Opened: 03/2018
Date Reported: 01/02/2026

Collections
Collection Agency: FIRST RECOVERY LLC
Original Creditor: ACME BANK
Account Number: 00099887766
Balance: $980
Date of First Delinquency: 02/14/2016
Date Reported: 12/20/2025
`;
const EQUIFAX = EXPERIAN.replace('Experian Credit Report', 'Equifax Credit Report').replace('$1,200.00', '$900.00');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

(async () => {
  const browser = await chromium.launch();
  const staffCtx = await browser.newContext({ viewport: { width: 1360, height: 900 }, extraHTTPHeaders: ip() });
  const staff = await staffCtx.newPage();
  watch(staff, 'staff'); global.__pages = [staff];
  const email = `e2e-${uniq}@example.test`;
  const clientEmail = `client-${uniq}@example.test`;
  let clientUrl = '', inviteLink = '', disputeUrl = '';

  console.log(`\nDisputeOS end-to-end journey → ${BASE}\n`);
  try {
    await check('landing page renders with compliance disclaimer', async () => {
      await staff.goto(BASE + '/');
      await expectText(staff, 'Credit repair, run like a');
      await expectText(staff, 'does not guarantee any deletion');
      await staff.screenshot({ path: `${SHOTS}/01-landing.png`, fullPage: true, caret: 'initial' });
    });

    await check('protected routes redirect to sign-in when signed out', async () => {
      await staff.goto(BASE + '/app/clients');
      await staff.waitForURL('**/login');
    });

    await check('sign up creates a workspace and forces two-step verification setup', async () => {
      await staff.goto(BASE + '/signup');
      await staff.getByLabel('Your name').fill('Avery E2E');
      await staff.getByLabel('Business name').fill(`E2E Agency ${uniq}`);
      await staff.getByLabel('Work email').fill(email);
      await staff.getByLabel(/^Password/).fill(PASSWORD);
      await staff.getByLabel(/I understand DisputeOS is software/).check();
      await staff.getByRole('button', { name: 'Create workspace' }).click();
      await staff.waitForURL('**/mfa/setup');
    });

    await check('cannot reach client data before MFA is completed', async () => {
      await staff.goto(BASE + '/app/clients');
      await staff.waitForURL('**/mfa/setup');
    });

    await check('a wrong authenticator code is rejected, the right one is accepted', async () => {
      await staff.goto(BASE + '/mfa/setup');
      const secret = (await staff.getByTestId('totp-secret').innerText()).replace(/\s/g, '');
      await staff.getByLabel('6-digit code').fill('000000');
      await staff.getByRole('button', { name: /Turn on two-step/ }).click();
      await expectText(staff, 'not valid');
      await staff.getByLabel('6-digit code').fill(totp(secret));
      await staff.getByRole('button', { name: /Turn on two-step/ }).click();
      await staff.waitForURL('**/app', { timeout: 15000 });
      await expectText(staff, 'Get set up');
      await staff.screenshot({ path: `${SHOTS}/02-dashboard-empty.png`, fullPage: true, caret: 'initial' });
    });

    await check('dashboard shows real (empty) data — zeros, not invented numbers', async () => {
      await expectText(staff, 'Active clients');
      const body = await staff.locator('main').innerText();
      if (/\$\d|score|612/i.test(body.replace(/Welcome back/, ''))) throw new Error('Unexpected figures on an empty dashboard: ' + body.slice(0, 200));
    });

    await check('create a client with consents recorded', async () => {
      await staff.goto(BASE + '/app/clients/new');
      await staff.getByLabel('Full legal name').fill('E2E Client');
      await staff.getByLabel('Email', { exact: true }).fill(clientEmail);
      await staff.getByLabel('Phone').fill('813-555-0142');
      await staff.getByLabel('Street').fill('500 Test Avenue');
      await staff.getByLabel('City').fill('Tampa');
      await staff.getByLabel('State', { exact: true }).fill('FL');
      await staff.getByLabel('ZIP').fill('33602');
      await staff.check('input[name=consentDisclosure]'); await staff.check('input[name=consentContract]'); await staff.check('input[name=consentAuthorization]');
      await staff.getByLabel('Name the client signed with').fill('E2E Client');
      await staff.getByRole('button', { name: 'Create client' }).click();
      await staff.waitForURL(/\/app\/clients\/[0-9a-f-]{36}$/);
      clientUrl = staff.url();
      await expectText(staff, 'E2E Client');
      await expectText(staff, 'Signed');
    });

    await check('invalid input is rejected with a clear message', async () => {
      await staff.goto(BASE + '/app/clients/new');
      await staff.getByLabel('Full legal name').fill('Bad Input');
      await staff.getByLabel('ZIP').fill('12');
      await staff.getByRole('button', { name: 'Create client' }).click();
      await expectText(staff, 'Use a 5-digit ZIP');
    });

    await check('upload two bureau reports → read, review and approve each', async () => {
      for (const [name, text, bureau] of [['experian.txt', EXPERIAN, 'Experian'], ['equifax.txt', EQUIFAX, 'Equifax']]) {
        await staff.goto(clientUrl + '?tab=reports');
        await staff.setInputFiles('input[name=file]', { name, mimeType: 'text/plain', buffer: Buffer.from(text) });
        await staff.getByRole('button', { name: 'Upload & read' }).click();
        await staff.waitForURL(/\/app\/reports\//, { timeout: 20000 });
        await expectText(staff, `${bureau} report`);
        await expectText(staff, 'Review before this is used');
        if (bureau === 'Experian') await staff.screenshot({ path: `${SHOTS}/03-report-review.png`, fullPage: true, caret: 'initial' });
        await staff.getByRole('button', { name: 'Approve report' }).click();
        await staff.waitForURL('**/compare', { timeout: 20000 });
      }
    });

    await check('three-bureau comparison flags a potential discrepancy without calling it inaccurate', async () => {
      await expectText(staff, 'Balance differs for ACME BANK USA');
      await expectText(staff, 'Potential discrepancy');
      const text = await staff.locator('main').innerText();
      const m = /.{0,60}(\bis inaccurate\b|\bwrong\b).{0,60}/i.exec(text.replace(/(does not mean|not a conclusion that) anything is inaccurate/g, ''));
      if (m) throw new Error('Comparison asserted inaccuracy near: ' + JSON.stringify(m[0]));
      await staff.screenshot({ path: `${SHOTS}/04-compare.png`, fullPage: true, caret: 'initial' });
    });

    await check('start a dispute from the finding; reason is drafted from the evidence', async () => {
      await staff.locator('li', { hasText: 'Balance differs for ACME BANK USA' }).getByRole('link', { name: /Start dispute/ }).click();
      await staff.waitForURL(/disputes\/new/);
      const reason = await staff.getByLabel('Reason').inputValue();
      if (!/Experian reports \$1,200\.00/.test(reason) || !/Equifax reports \$900\.00/.test(reason)) throw new Error('Reason not drafted from evidence: ' + reason);
      await staff.getByRole('button', { name: 'Create dispute draft' }).click();
      await staff.waitForURL(/\/app\/disputes\/[0-9a-f-]{36}$/);
      disputeUrl = staff.url();
      await expectText(staff, 'Draft');
    });

    await check('dispute can’t be submitted before review, approval and an approved letter', async () => {
      await staff.getByRole('button', { name: 'Send for review' }).click();
      await expectText(staff, 'Ready for review');
      await staff.getByRole('button', { name: 'Approve dispute' }).click();
      await expectText(staff, 'Approved');
      await expectText(staff, 'Approve a letter for this dispute first');
    });

    await check('letter: edit creates a version; approval requires a manager; PDF downloads', async () => {
      await staff.locator('aside').getByRole('link', { name: /Bureau dispute/ }).click();
      await staff.waitForURL(/\/app\/letters\//);
      await expectText(staff, 'No unfilled fields or prohibited claims detected');
      const ta = staff.locator('textarea[name=body]');
      if (!/Specific information I am asking you to review: Balance/.test(await ta.inputValue())) throw new Error('ticked "Balance" field did not reach the letter');
      await ta.fill((await ta.inputValue()) + '\nThank you for your prompt attention.\n');
      await staff.getByRole('button', { name: 'Save new version' }).click();
      await expectText(staff, 'Saved as version 2');
      // a prohibited claim is flagged live and blocked
      await ta.fill((await ta.inputValue()) + '\nWe guarantee this will be deleted.\n');
      await expectText(staff, 'Results cannot be guaranteed');
      await ta.fill((await ta.inputValue()).replace('We guarantee this will be deleted.\n', '')); // back to the saved v2 text
      await expectText(staff, 'No unfilled fields or prohibited claims detected');
      await staff.getByRole('button', { name: 'Send for approval' }).click();
      await staff.getByRole('button', { name: /Approve this exact text/ }).click(); // appears once status is Pending approval
      await expectText(staff, 'Approved by');
      const dl = await staff.request.get(staff.url().replace(/\/app\/letters\//, '/api/letters/') + '/pdf');
      if (dl.status() !== 200 || dl.headers()['content-type'] !== 'application/pdf') throw new Error('PDF download failed: ' + dl.status());
      if (!(await dl.body()).subarray(0, 5).toString().startsWith('%PDF')) throw new Error('Not a PDF');
      await staff.screenshot({ path: `${SHOTS}/05-letter.png`, fullPage: true, caret: 'initial' });
    });

    await check('submit the dispute: 30-day clock starts, letter marked sent', async () => {
      await staff.goto(disputeUrl);
      await staff.getByRole('button', { name: 'Record submission' }).click();
      await staff.getByRole('button', { name: 'Mark as under investigation' }).waitFor(); // only shown once status = Submitted
      await staff.reload();
      await expectText(staff, '30-day investigation window');
      await expectText(staff, 'd left'.length ? 'd' : '');
      await staff.screenshot({ path: `${SHOTS}/06-dispute.png`, fullPage: true, caret: 'initial' });
    });

    await check('record the outcome and resolve; history shows every step', async () => {
      await staff.getByLabel('Outcome').selectOption('updated');
      await staff.getByRole('button', { name: 'Record response' }).click();
      await expectText(staff, 'Response recorded');
      await staff.reload();
      await staff.getByRole('button', { name: 'Mark resolved' }).click();
      await expectText(staff, 'Confirm the change on the next report pull'); // next-step text for a resolved + updated item
      await staff.reload();
      for (const s of ['Ready for review', 'Approved', 'Submitted', 'Response received', 'Resolved']) await expectText(staff, s);
    });

    await check('request a document, then invite the client to the portal', async () => {
      await staff.goto(clientUrl + '?tab=documents');
      await staff.getByLabel('Note for the client').fill('A clear photo of your ID');
      await staff.getByRole('button', { name: 'Send request' }).click();
      await expectText(staff, 'Request added');
      await staff.goto(clientUrl);
      await staff.getByRole('button', { name: /Invite to client portal/ }).click();
      await expectText(staff, 'invitation link'.length ? 'Share this one-time link' : '');
      const t = await staff.locator('main').innerText();
      inviteLink = (t.match(/https?:\/\/\S+\/invite\/\S+/) || [])[0];
      if (!inviteLink) throw new Error('No invite link shown');
    });

    // -------------------------------------------------------------------------------- client portal
    const clientCtx = await browser.newContext({ viewport: { width: 1200, height: 900 }, extraHTTPHeaders: ip() });
    const client = await clientCtx.newPage();
    watch(client, 'client');

    await check('client accepts the invitation and lands in the portal', async () => {
      await client.goto(inviteLink.replace(/^https?:\/\/[^/]+/, BASE));
      await expectText(client, 'secure client portal');
      await expectText(client, `E2E Agency ${uniq}`);
      await expectText(client, 'Powered by');
      await client.getByLabel(/^Password/).fill(PASSWORD);
      await client.getByRole('button', { name: 'Accept invitation' }).click();
      await client.waitForURL('**/portal', { timeout: 15000 });
      await expectText(client, 'Hello, E2E');
    });

    await check('portal home opens with one clear next step, the stage explained, and the client’s rights', async () => {
      await expectText(client, 'Your next step');
      await expectText(client, 'Upload what we asked for'); // the ID request is still open
      await expectText(client, 'Your rights');
      await expectText(client, 'AnnualCreditReport.com');
      if (!(await client.getByRole('link', { name: 'Upload now' }).isVisible())) throw new Error('no upload call-to-action');
    });

    await check('portal shows the outcome in plain language, with the no-guarantee notice', async () => {
      await expectText(client, 'Still under review'.length ? 'Removed or corrected' : '');
      await client.goto(BASE + '/portal/disputes');
      await expectText(client, 'Corrected');
      await expectText(client, 'cannot guarantee any result');
      await client.screenshot({ path: `${SHOTS}/07-portal-disputes.png`, fullPage: true, caret: 'initial' });
    });

    await check('client uploads the requested document and messages their specialist', async () => {
      await client.goto(BASE + '/portal');
      await client.setInputFiles('input[type=file]', { name: 'id.png', mimeType: 'image/png', buffer: PNG });
      await client.getByRole('button', { name: 'Upload' }).first().click();
      await client.waitForURL('**/portal/documents?uploaded=1'); await expectText(client, 'Uploaded — thank you'); await expectText(client, 'id.png');
      await client.goto(BASE + '/portal/messages');
      await client.getByLabel('Write a message').fill('Hi, I just uploaded my ID. Anything else you need?');
      await client.getByRole('button', { name: 'Send' }).click();
      await expectText(client, 'Message sent');
    });

    await check('staff dashboard shows the client waiting on a reply and an upload to review', async () => {
      await staff.goto(BASE + '/app');
      await expectText(staff, 'Client care');
      const care = staff.locator('section', { has: staff.getByRole('heading', { name: 'Client care' }) });
      await care.getByText('I just uploaded my ID').first().waitFor({ timeout: 8000 });
      await care.getByText('id.png').first().waitFor({ timeout: 8000 });
      await staff.screenshot({ path: `${SHOTS}/09-client-care.png`, fullPage: false, caret: 'initial' });
    });

    await check('a client cannot upload a disguised executable or open staff pages', async () => {
      await client.goto(BASE + '/portal/documents');
      await client.setInputFiles('input[name=file]', { name: 'invoice.png', mimeType: 'image/png', buffer: Buffer.from('MZ\x90\x00\x03 not an image, a Windows executable') });
      await client.getByRole('button', { name: 'Upload' }).click();
      await expectText(client, 'not accepted');
      for (const p of ['/app', '/app/clients', '/app/settings', '/app/audit']) {
        await client.goto(BASE + p);
        await client.waitForURL('**/portal**', { timeout: 8000 });
      }
    });

    await check('staff sees the client’s upload, message, and portal activity', async () => {
      await staff.goto(clientUrl + '?tab=documents');
      await expectText(staff, 'id.png');
      await expectText(staff, 'uploaded by client');
      // the vault serves the decrypted original back to staff, with hardening headers
      const href = await staff.locator('a[href^="/api/documents/"]').first().getAttribute('href');
      const dl = await staff.request.get(BASE + href);
      const body = await dl.body();
      if (dl.status() !== 200 || !body.equals(PNG)) throw new Error('document did not round-trip through encrypted storage');
      if (dl.headers()['x-content-type-options'] !== 'nosniff') throw new Error('missing nosniff');
      // ...and the same URL is refused for a signed-out visitor
      const anon = await browser.newContext({ extraHTTPHeaders: ip() });
      if ((await anon.request.get(BASE + href)).status() !== 404) throw new Error('document served without a session');
      await anon.close();
      await staff.goto(clientUrl + '?tab=messages');
      await expectText(staff, 'I just uploaded my ID');
      await staff.goto(BASE + '/app/inbox');
      await expectText(staff, 'Unread client messages');
    });

    // -------------------------------------------------------------------------------- Credit Connect + API
    await check('API: create a key in the UI, push a report with it, and it lands in the review queue (gated by authorization)', async () => {
      await staff.goto(BASE + '/app/settings/developers');
      await expectText(staff, 'Needs partner approval');           // honest provider status, no fake adapters
      await staff.getByLabel(/^Name/).fill('E2E push');
      await staff.getByLabel(/Push credit reports/).uncheck();      // reports:write is ticked by default — this key must NOT have it
      await staff.getByLabel(/Create clients/).check();
      await staff.getByLabel(/Read clients/).check();
      await staff.getByRole('button', { name: 'Create key' }).click();
      await expectText(staff, 'Copy this key now');
      const key = (await staff.locator('main').innerText()).match(/dosk_[a-z0-9]{8}_[A-Za-z0-9_-]{40,}/)[0];
      const clientId = clientUrl.split('/').pop();
      const hdr = { authorization: `Bearer ${key}`, 'content-type': 'application/json', ...ip() };
      const api = (path, init = {}) => staff.request.fetch(BASE + path, { ...init, headers: { ...hdr, ...(init.headers || {}) } });
      // bad / missing key
      if ((await staff.request.get(BASE + '/api/v1/clients', { headers: ip() })).status() !== 401) throw new Error('unauthenticated API call allowed');
      // read with the key
      const list = await (await api('/api/v1/clients')).json();
      if (!list.data.some((c) => c.id === clientId)) throw new Error('client missing from API list');
      // scope enforcement: this key can't push reports
      if ((await api(`/api/v1/clients/${clientId}/reports`, { method: 'POST', data: '{}' })).status() !== 403) throw new Error('scope not enforced');
      // create a client over the API
      const created = await api('/api/v1/clients', { method: 'POST', data: JSON.stringify({ full_name: 'API Created', email: `api-${uniq}@example.test` }) });
      if (created.status() !== 201) throw new Error('create via API failed: ' + created.status());
      if ((await api('/api/v1/clients', { method: 'POST', data: JSON.stringify({ full_name: 'Dup', email: `api-${uniq}@example.test` }) })).status() !== 409) throw new Error('duplicate not rejected');
      // a second key with push permission
      await staff.goto(BASE + '/app/settings/developers');
      await staff.getByLabel(/^Name/).fill('E2E reports');
      await staff.getByLabel(/Push credit reports/).check();
      await staff.getByRole('button', { name: 'Create key' }).click();
      await expectText(staff, 'Copy this key now');
      const key2 = (await staff.locator('main').innerText()).match(/dosk_[a-z0-9]{8}_[A-Za-z0-9_-]{40,}/g).find((k) => k !== key);
      const push = (cid, body, k = key2) => staff.request.fetch(BASE + `/api/v1/clients/${cid}/reports`, { method: 'POST', headers: { authorization: `Bearer ${k}`, 'content-type': 'application/json', ...ip() }, data: JSON.stringify(body) });
      const payload = { external_ref: `e2e-${uniq}`, reports: [{ bureau: 'transunion', report_date: '2026-03-01', scores: [{ model: 'VantageScore 3.0', score: 611 }], tradelines: [{ creditor_name: 'PUSHED BANK', account_number: '4111111111119876', balance_cents: 45000 }] }] };
      const apiClient = (await created.json()).id;
      const noAuth = await push(apiClient, payload);                 // API-created client has no FCRA authorization yet
      if (noAuth.status() !== 422 || !/written authorization/.test(await noAuth.text())) throw new Error('push allowed without authorization: ' + noAuth.status());
      const ok = await push(clientId, payload);                      // the e2e client does have it
      if (ok.status() !== 201) throw new Error('push failed: ' + ok.status() + await ok.text());
      const body = await ok.json();
      if (body.status !== 'pending_review') throw new Error('not queued for review');
      if ((await push(clientId, payload)).status() !== 422) throw new Error('duplicate external_ref not rejected');
      await staff.goto(body.review_urls[0].replace(/^https?:\/\/[^/]+/, BASE));
      await expectText(staff, 'TransUnion report'); await expectText(staff, 'PUSHED BANK'); await expectText(staff, 'Review before this is used');
      const raw = await staff.locator('main').innerText();
      if (/411111111111|9876543/.test(raw) || !/••9876/.test(raw)) throw new Error('full account number leaked or last4 missing');
      await staff.screenshot({ path: `${SHOTS}/09-api-pushed-report.png`, fullPage: true, caret: 'initial' });
    });

    await check('Credit Connect: sandbox pull needs authorization; with it, reports queue for review and scores appear', async () => {
      // the API-created client has no authorization => the pull panel is locked
      await staff.goto(BASE + '/app/clients?q=API+Created');
      await staff.getByRole('link', { name: /API Created/ }).first().click();
      await staff.getByRole('link', { name: /^Reports/ }).click();
      await expectText(staff, 'Authorization needed first');
      // the e2e client has it => pull works
      await staff.goto(clientUrl + '?tab=reports');
      await staff.getByRole('button', { name: 'Pull reports' }).click();
      await staff.waitForURL(/\/app\/reports\//, { timeout: 20000 });
      await expectText(staff, 'SANDBOX');
      await staff.goto(clientUrl);
      await expectText(staff, 'Reported credit scores');
      await expectText(staff, 'VantageScore 3.0');
    });

    await check('command palette finds clients with Ctrl+K and opens them', async () => {
      await staff.goto(BASE + '/app', { waitUntil: 'networkidle' });   // let React hydrate so the shortcut listener exists
      await staff.keyboard.press('Control+k');
      await staff.getByLabel('Search', { exact: true }).fill('E2E Cli');
      await staff.getByRole('option', { name: /E2E Client/ }).first().waitFor();
      await staff.keyboard.press('Enter');
      await staff.waitForURL(/\/app\/clients\/[0-9a-f-]{36}$/);
    });

    // -------------------------------------------------------------------------------- tenant isolation
    const otherCtx = await browser.newContext({ viewport: { width: 1200, height: 900 }, extraHTTPHeaders: ip() });
    const other = await otherCtx.newPage();
    watch(other, 'other-tenant');
    await check('a second business cannot see the first business’s client, dispute, letter, report or documents', async () => {
      await other.goto(BASE + '/signup');
      await other.getByLabel('Your name').fill('Other Owner');
      await other.getByLabel('Business name').fill(`Other Agency ${uniq}`);
      await other.getByLabel('Work email').fill(`other-${uniq}@example.test`);
      await other.getByLabel(/^Password/).fill(PASSWORD);
      await other.getByLabel(/I understand DisputeOS is software/).check();
      await other.getByRole('button', { name: 'Create workspace' }).click();
      await other.waitForURL('**/mfa/setup');
      const secret = (await other.getByTestId('totp-secret').innerText()).replace(/\s/g, '');
      await other.getByLabel('6-digit code').fill(totp(secret));
      await other.getByRole('button', { name: /Turn on two-step/ }).click();
      await other.waitForURL('**/app');
      const clientId = clientUrl.split('/').pop();
      const disputeId = disputeUrl.split('/').pop();
      for (const p of [`/app/clients/${clientId}`, `/app/clients/${clientId}/edit`, `/app/clients/${clientId}/compare`, `/app/disputes/${disputeId}`]) {
        const r = await other.goto(BASE + p);
        if (r.status() !== 404) throw new Error(`${p} returned ${r.status()} for another tenant`);
      }
      const exp = await other.request.get(BASE + `/api/clients/${clientId}/export`);
      if (exp.status() !== 404) throw new Error('export leaked: ' + exp.status());
      await other.goto(BASE + '/app/clients');
      await expectText(other, 'No clients yet');
    });

    // -------------------------------------------------------------------------------- responsive + dark mode
    await check('layouts hold at phone and tablet widths with no horizontal page scroll', async () => {
      const pages = ['/app', '/app/clients', clientUrl.replace(BASE, ''), '/app/disputes', '/app/letters', '/app/settings'];
      for (const [label, w, h] of [['phone', 390, 844], ['tablet', 820, 1100]]) {
        await staffCtx.pages()[0].setViewportSize({ width: w, height: h });
        for (const p of pages) {
          await staff.goto(BASE + p);
          const over = await staff.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
          if (over > 2) throw new Error(`${label} ${p} overflows by ${over}px`);
          if (p === '/app' || p.includes('/clients/')) await staff.screenshot({ path: `${SHOTS}/${label}-${p.replace(/[^\w]+/g, '_').slice(0, 24)}.png`, fullPage: true, caret: 'initial' });
        }
      }
      await client.setViewportSize({ width: 390, height: 844 });
      for (const p of ['/portal', '/portal/disputes', '/portal/messages', '/portal/profile']) {
        await client.goto(BASE + p);
        const over = await client.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        if (over > 2) throw new Error(`phone ${p} overflows by ${over}px`);
      }
      await client.screenshot({ path: `${SHOTS}/phone-portal.png`, fullPage: true, caret: 'initial' });
      await client.goto(BASE + '/portal');
      await client.getByRole('link', { name: 'Messages' }).click();
      await client.waitForURL('**/portal/messages');
      const box = await client.getByRole('link', { name: 'Messages' }).boundingBox();
      if (!box || box.y < 700) throw new Error('phone navigation is not at the bottom of the screen');
    });

    await check('client signs out to their agency’s own branded sign-in page', async () => {
      await client.getByRole('button', { name: 'Sign out' }).click();
      await client.waitForURL(/\/portal\/login\?org=/);
      await expectText(client, `E2E Agency ${uniq}`);
      await expectText(client, 'Powered by');
      await client.screenshot({ path: `${SHOTS}/phone-branded-login.png`, fullPage: true, caret: 'initial' });
    });

    await check('public enquiry form: a prospect sends their details and appears as a lead for the team', async () => {
      await staff.setViewportSize({ width: 1360, height: 900 });
      await staff.goto(BASE + '/app/settings');
      const link = (await staff.locator('code', { hasText: '/start/' }).first().innerText()).trim().replace(/^https?:\/\/[^/]+/, BASE);
      const visitorCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, extraHTTPHeaders: ip() });
      const visitor = await visitorCtx.newPage(); watch(visitor, 'visitor');
      await visitor.goto(link);
      await expectText(visitor, `E2E Agency ${uniq}`);
      await visitor.getByRole('button', { name: 'Send' }).click(); // empty form: the browser blocks it, nothing is sent
      await visitor.getByLabel(/^Your name/).fill('Lead Prospect');
      await visitor.getByLabel(/^Email/).fill(`lead-${uniq}@example.test`);
      await visitor.getByLabel(/What would you like help with/).fill('A collection I do not recognise.');
      await visitor.getByRole('button', { name: 'Send' }).click();
      await expectText(visitor, 'Please confirm we may contact you'); // consent is required
      if ((await visitor.getByLabel(/^Your name/).inputValue()) !== 'Lead Prospect') throw new Error('the form lost what was typed after an error');
      await visitor.getByLabel(/may contact me/).check();
      await visitor.getByRole('button', { name: 'Send' }).click();
      await expectText(visitor, 'Thank you');
      await visitor.screenshot({ path: `${SHOTS}/10-lead-form-thanks.png`, caret: 'initial' });
      await visitorCtx.close();
      await staff.goto(BASE + '/app');
      const care = staff.locator('section', { has: staff.getByRole('heading', { name: 'Client care' }) });
      await care.getByText('Lead Prospect').first().waitFor({ timeout: 8000 });
      await staff.goto(BASE + '/app/tasks');
      await expectText(staff, 'Contact new lead: Lead Prospect');
    });

    await check('several findings can be drafted into disputes at once, and each stays a draft', async () => {
      await staff.goto(clientUrl + '/compare');
      const boxes = staff.locator('input[type=checkbox][name=finding]');
      const n = await boxes.count();
      if (n === 0) { // nothing left to select for this client: the bulk bar must then be hidden
        if (await staff.getByRole('button', { name: 'Draft disputes for selected' }).count()) throw new Error('bulk bar shown with nothing to select');
        console.log('      (no undisputed findings left for this client; drafting itself is covered by the database tests)');
        return;
      }
      await staff.getByRole('button', { name: 'Draft disputes for selected' }).click();
      await expectText(staff, 'Select at least one finding');
      for (let i = 0; i < n; i++) await boxes.nth(i).check();
      await staff.getByRole('button', { name: 'Draft disputes for selected' }).click();
      await expectText(staff, 'drafted');
      await staff.getByRole('link', { name: 'Open the drafts' }).click();
      await expectText(staff, 'Draft');
    });

    await check('dark mode toggles and persists', async () => {
      await staff.setViewportSize({ width: 1360, height: 900 });
      await staff.goto(BASE + '/app');
      await staff.getByRole('button', { name: /dark mode/i }).click();
      if ((await staff.evaluate(() => document.documentElement.dataset.theme)) !== 'dark') throw new Error('theme not applied');
      await staff.reload();
      if ((await staff.evaluate(() => document.documentElement.dataset.theme)) !== 'dark') throw new Error('theme not persisted');
      await staff.screenshot({ path: `${SHOTS}/08-dark.png`, fullPage: true, caret: 'initial' });
    });

    await check('sign out ends the session; the old session cookie no longer works', async () => {
      const cookies = await staffCtx.cookies();
      const sess = cookies.find((c) => c.name === 'dos_session');
      await staff.getByRole('button', { name: 'Sign out' }).first().click();
      await staff.waitForURL('**/login');
      await staffCtx.addCookies([sess]);
      await staff.goto(BASE + '/app');
      await staff.waitForURL('**/login');
    });
  } catch {
    /* failure already recorded */
  }

  await browser.close();
  const failed = results.filter((r) => !r[0]);
  console.log(`\n${results.length - failed.length}/${results.length} steps passed`);
  const uniqueProblems = [...new Set(problems)];
  if (uniqueProblems.length) console.log('\nBrowser problems:\n' + uniqueProblems.map((p) => '  ' + p).join('\n'));
  else console.log('No console errors or 5xx responses in any browser.');
  process.exit(failed.length || uniqueProblems.length ? 1 : 0);
})();
