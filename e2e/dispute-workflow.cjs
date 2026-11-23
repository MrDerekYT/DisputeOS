/**
 * Full dispute workflow in a real browser, with synthetic data only:
 *   report upload → staff review → discrepancy checked against its source → evidence → letter approval →
 *   recorded delivery (method, sent date, tracking) → bureau response → client portal update,
 * plus access checks: another agency's staff and the client in the portal can reach only what they are allowed to.
 *
 *   REQUIRE_STAFF_MFA=true npx next start -p 3100     # production build, in one terminal
 *   node e2e/dispute-workflow.cjs                     # in another (needs Playwright's Chromium)
 * Creates its own throwaway agencies (unique emails), so it is safe to re-run.
 */
const { chromium } = require('playwright');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Client: PgClient } = require('pg');

const BASE = process.env.BASE || 'http://localhost:3100';
const SHOTS = process.env.SHOTS || 'screenshots/e2e-workflow';
fs.mkdirSync(SHOTS, { recursive: true });
const uniq = crypto.randomBytes(4).toString('hex');
const PASSWORD = 'Correct-Horse-Battery-9';
const ip = () => ({ 'x-forwarded-for': `10.${crypto.randomInt(1, 250)}.${crypto.randomInt(1, 250)}.${crypto.randomInt(1, 250)}` });
const results = []; const problems = []; let step = 0; const pages = [];

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const b32decode = (s) => { let bits = 0, v = 0; const out = []; for (const ch of s.replace(/[\s=]/g, '').toUpperCase()) { v = (v << 5) | B32.indexOf(ch); bits += 5; if (bits >= 8) { out.push((v >>> (bits - 8)) & 255); bits -= 8; } } return Buffer.from(out); };
const totp = (secret, t = Date.now()) => { const buf = Buffer.alloc(8); buf.writeBigUInt64BE(BigInt(Math.floor(t / 30000))); const h = crypto.createHmac('sha1', b32decode(secret)).update(buf).digest(); const o = h[h.length - 1] & 15; return String((h.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, '0'); };

async function check(name, fn) {
  step++;
  try { await fn(); results.push(true); console.log(`  ✓ ${String(step).padStart(2)} ${name}`); }
  catch (e) { for (const [i, pg] of pages.entries()) await pg.screenshot({ path: `${SHOTS}/FAIL-step${step}-${i}.png`, fullPage: true, caret: 'initial' }).catch(() => {}); results.push(false); console.log(`  ✗ ${String(step).padStart(2)} ${name}\n      ${String(e.message).split('\n')[0]}`); throw e; }
}
const watch = (page, who) => {
  pages.push(page);
  page.on('pageerror', (e) => problems.push(`[${who} pageerror] ${page.url()} :: ${String(e).slice(0, 200)}`));
  page.on('response', (r) => { if (r.status() >= 500) problems.push(`[${who} http ${r.status()}] ${r.url()}`); });
};
const see = (page, text, timeout = 10000) => page.getByText(text, { exact: false }).first().waitFor({ timeout });

/**
 * No dispute can be recorded as submitted while the client's 3-business-day cancellation period runs (15 U.S.C.
 * § 1679d(a)(2)), and nothing in the app can date a signature in the past. So, after checking that the app refuses,
 * the test client's agreements are dated 10 days back directly in the database the server uses: E2E_DATABASE_URL, or
 * DATABASE_URL (from the environment, or read from .env.local as the dev server does).
 */
function e2eDatabaseUrl() {
  if (!process.env.E2E_DATABASE_URL && !process.env.DATABASE_URL && fs.existsSync('.env.local')) process.loadEnvFile('.env.local');
  const url = process.env.E2E_DATABASE_URL || process.env.DATABASE_URL;
  if (!url) throw new Error('Set E2E_DATABASE_URL to the database the server under test uses (needed to date the test agreements before the cancellation period)');
  return url;
}
async function backdateAgreements(clientId, days = 10) {
  const db = new PgClient({ connectionString: e2eDatabaseUrl() });
  await db.connect();
  try {
    // The days stored with each signature move back with it: the day the client signed (the paper's date) and the last day
    // of the cancellation period fixed when the agreement was signed, which a recount never shortens.
    const r = await db.query("update public.client_consents set signed_at = signed_at - make_interval(days => $2::int), signed_on = signed_on - $2::int, cancellation_ends_on = cancellation_ends_on - $2::int where client_id = $1", [clientId, days]);
    if (!r.rowCount) throw new Error('no agreements found to date back');
  } finally { await db.end(); }
}
const isoDaysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
const usDate = (iso) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

// Synthetic reports: the same account with different balances at two bureaus. No real person or account.
const EXPERIAN = `Experian Credit Report
Report Date: 01/15/2026

Personal Information
Name: WORKFLOW CLIENT
Address: 700 Sample Road, Tampa FL 33602

Accounts
Account Name: SYNTHETIC BANK NA
Account Number: 400000000001
Account Type: Revolving
Account Status: Open
Payment Status: Current
Balance: $2,450.00
Credit Limit: $6,000
Date Opened: 05/2019
Date Reported: 01/02/2026
`;
const EQUIFAX = EXPERIAN.replace('Experian Credit Report', 'Equifax Credit Report').replace('$2,450.00', '$1,975.00');

async function signUpAgency(browser, label) {
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 }, extraHTTPHeaders: ip() });
  const p = await ctx.newPage(); watch(p, label);
  await p.goto(BASE + '/signup');
  await p.getByLabel('Your name').fill(`${label} Owner`);
  await p.getByLabel('Business name').fill(`${label} Agency ${uniq}`);
  await p.getByLabel('Work email').fill(`${label.toLowerCase()}-${uniq}@example.test`);
  await p.getByLabel(/^Password/).fill(PASSWORD);
  await p.getByLabel(/I understand .* is software/).check();
  await p.getByRole('button', { name: 'Create workspace' }).click();
  await p.waitForURL('**/mfa/setup');
  const secret = (await p.getByTestId('totp-secret').innerText()).replace(/\s/g, '');
  await p.getByLabel('6-digit code').fill(totp(secret));
  await p.getByRole('button', { name: /Turn on two-step/ }).click();
  await p.waitForURL('**/app', { timeout: 15000 });
  return { ctx, p };
}

(async () => {
  const browser = await chromium.launch();
  let clientUrl = '', disputeUrl = '', letterUrl = '', reportUrl = '', inviteLink = '';
  const sentOn = isoDaysAgo(3), receivedOn = isoDaysAgo(1);
  console.log(`\nDispute workflow (synthetic data) → ${BASE}\n`);
  try {
    let staff, staffCtx;
    await check('an agency signs up with two-step verification, saves its client agreement terms and onboards a client with consents', async () => {
      ({ ctx: staffCtx, p: staff } = await signUpAgency(browser, 'Alpha'));
      // The service agreement is built from the agency's own terms (Settings → Client agreement); none, no contract.
      await staff.goto(BASE + '/app/settings#agreement');
      await staff.getByLabel('Principal business address').fill('700 Sample Road, Suite 4, Tampa, FL 33602');
      await staff.locator('textarea[name=services]').fill('We review your credit reports with you, prepare dispute letters for the items you choose, follow each investigation and report every response in your portal.');
      await staff.locator('textarea[name=paymentTerms]').fill('A monthly fee, charged after the work of each month is fully performed.');
      await staff.getByLabel('Total of all payments (USD)').fill('450.00');
      await staff.getByLabel('How long the services should take').fill('About 5 months from the date you sign.');
      await staff.getByRole('button', { name: 'Save client agreement' }).click();
      await see(staff, 'Client agreement saved');
      await staff.goto(BASE + '/app/clients/new?manual=1'); // the full form; New client itself opens on the quick invite
      await staff.getByLabel('Full legal name').fill('Workflow Client');
      await staff.getByLabel('Email', { exact: true }).fill(`wf-client-${uniq}@example.test`);
      await staff.getByLabel('Street').fill('700 Sample Road'); await staff.getByLabel('City').fill('Tampa');
      await staff.getByLabel('State', { exact: true }).fill('FL'); await staff.getByLabel('ZIP').fill('33602');
      // A letter to a credit bureau states the date of birth and the last four digits of the SSN (synthetic values).
      await staff.getByLabel('Date of birth').fill('1985-03-03'); await staff.getByLabel('Social Security number').fill('000-00-4321');
      await staff.check('input[name=consentDisclosure]'); await staff.check('input[name=consentContract]'); await staff.check('input[name=consentAuthorization]');
      await staff.getByLabel('Name the client signed with').fill('Workflow Client');
      // Paper signatures are recorded with the date written on the paper (today, in UTC: never in the future for the app).
      await staff.getByLabel('Date written on the signed paper').fill(isoDaysAgo(0));
      await staff.getByRole('button', { name: 'Create client' }).click();
      await staff.waitForURL(/\/app\/clients\/[0-9a-f-]{36}$/);
      clientUrl = staff.url();
    });

    await check('reports are uploaded, read, reviewed by a person and approved', async () => {
      for (const [name, text, bureau] of [['experian.txt', EXPERIAN, 'Experian'], ['equifax.txt', EQUIFAX, 'Equifax']]) {
        await staff.goto(clientUrl + '?tab=reports');
        await staff.setInputFiles('input[name=file]', { name, mimeType: 'text/plain', buffer: Buffer.from(text) });
        await staff.getByRole('button', { name: 'Upload & read' }).click();
        await staff.waitForURL(/\/app\/reports\//, { timeout: 20000 });
        await see(staff, `${bureau} report`); await see(staff, 'Review before this is used');
        if (bureau === 'Experian') reportUrl = staff.url();
        await staff.getByRole('button', { name: 'Approve report' }).click();
        await staff.waitForURL('**/compare', { timeout: 20000 });
      }
    });

    await check('the discrepancy can be verified against its source: evidence lists each bureau’s value and the report shows the same figure', async () => {
      const finding = staff.locator('li', { hasText: 'Balance differs for SYNTHETIC BANK NA' });
      await finding.getByText('Potential discrepancy').waitFor();
      await finding.locator('summary').click();
      const evidence = await finding.locator('details').innerText();
      if (!/Experian[\s\S]*\$2,450\.00/.test(evidence) || !/Equifax[\s\S]*\$1,975\.00/.test(evidence) || !/as reported/.test(evidence)) throw new Error('evidence does not show both reported values: ' + evidence);
      await staff.screenshot({ path: `${SHOTS}/01-evidence.png`, fullPage: true, caret: 'initial' });
      await staff.goto(reportUrl); // the reviewed source record for the Experian value
      await see(staff, 'SYNTHETIC BANK NA');
      const src = await staff.locator('main').innerText();
      if (!/2,450\.00/.test(src)) throw new Error('the Experian report page does not show the $2,450.00 the finding cites');
      if (/1,975\.00/.test(src)) throw new Error('the Experian report page shows the Equifax balance');
      await staff.goBack();
    });

    await check('a dispute is drafted from the finding and evidence is attached', async () => {
      await staff.locator('li', { hasText: 'Balance differs for SYNTHETIC BANK NA' }).getByRole('link', { name: /Start dispute/ }).click();
      await staff.waitForURL(/disputes\/new/);
      const reason = await staff.getByLabel('Reason').inputValue();
      if (!/Experian reports \$2,450\.00/.test(reason) || !/Equifax reports \$1,975\.00/.test(reason)) throw new Error('reason not drafted from the evidence: ' + reason);
      await staff.getByRole('button', { name: 'Create dispute draft' }).click();
      await staff.waitForURL(/\/app\/disputes\/[0-9a-f-]{36}$/);
      disputeUrl = staff.url();
      await staff.getByLabel('Label').fill('January statement showing the balance');
      await staff.getByLabel('Note', { exact: true }).fill('Synthetic statement provided by the client.');
      await staff.getByRole('button', { name: 'Add evidence' }).click();
      await see(staff, 'Evidence (1)');
      await see(staff, 'January statement showing the balance');
    });

    await check('the dispute and its letter both need approval; the letter PDF is the approved text', async () => {
      await staff.getByRole('button', { name: 'Send for review' }).click(); await see(staff, 'Ready for review');
      await staff.getByRole('button', { name: 'Approve dispute' }).click(); await see(staff, 'Approve a letter for this dispute first');
      if (await staff.getByRole('button', { name: 'Record submission' }).count()) throw new Error('submission offered before a letter was approved');
      await staff.locator('aside').getByRole('link', { name: /Inaccurate balance/ }).click();
      await staff.waitForURL(/\/app\/letters\//); letterUrl = staff.url();
      const body = await staff.locator('textarea[name=body]').inputValue();
      if (!/SYNTHETIC BANK NA/.test(body) || !/\$2,450\.00/.test(body)) throw new Error('letter does not carry the disputed account and amount');
      if (!/Date of birth: March 3, 1985\nSSN \(last 4\): 4321\n/.test(body)) throw new Error('the bureau letter does not identify the client by date of birth and SSN digits: ' + body.slice(0, 300));
      if (/NEEDED\]/.test(body)) throw new Error('the letter has a line left to complete: ' + body.match(/\[[A-Z ]+NEEDED\]/)[0]);
      await see(staff, 'AI wording help'); // the suggest step exists; no provider is configured in this environment
      await staff.getByRole('button', { name: 'Suggest better wording' }).click();
      await see(staff, 'AI wording is off: no AI provider connected. The letter is unchanged.');
      if ((await staff.locator('textarea[name=body]').inputValue()) !== body) throw new Error('letter text changed without an accepted suggestion');
      await staff.getByRole('button', { name: 'Send for approval' }).click();
      await staff.getByRole('button', { name: /Approve this exact text/ }).click();
      await see(staff, 'Approved by');
      const dl = await staff.request.get(letterUrl.replace('/app/letters/', '/api/letters/') + '/pdf');
      if (dl.status() !== 200 || !(await dl.body()).subarray(0, 5).toString().startsWith('%PDF')) throw new Error('approved letter PDF not available');
    });

    await check('nothing is recorded as sent while the client can still cancel; once the period is over it can be', async () => {
      await staff.goto(disputeUrl);
      await see(staff, 'can cancel their service agreement without penalty through');
      if (await staff.getByRole('button', { name: 'Record submission' }).count()) throw new Error('submission offered inside the cancellation period');
      await backdateAgreements(clientUrl.split('/').pop()); // the agreements were signed 10 days ago: the period is over
    });

    await check('delivery is recorded with method, sent date and tracking, and shown as a staff record — not carrier-confirmed', async () => {
      await staff.goto(disputeUrl);
      await staff.getByLabel('How was it sent?').selectOption('first_class_mail');
      await staff.getByLabel('Date sent').fill(sentOn);
      await staff.getByLabel('Tracking reference').fill('WF-TRACK-0001');
      await staff.getByLabel('Send without the identity documents').check(); // no identity documents on file yet: an explicit yes is required
      await staff.getByRole('button', { name: 'Record submission' }).click();
      await staff.getByRole('button', { name: 'Mark as under investigation' }).waitFor();
      await staff.reload();
      const rec = staff.locator('[data-delivery-source]').first();
      await rec.waitFor();
      const t = await rec.innerText();
      if ((await rec.getAttribute('data-delivery-source')) !== 'staff_recorded') throw new Error('delivery source is not staff_recorded');
      for (const want of ['Recorded by staff', `Sent ${usDate(sentOn)}`, 'First-class mail', 'WF-TRACK-0001', 'not confirmed by a carrier', 'Alpha Owner']) if (!t.includes(want)) throw new Error(`delivery record is missing “${want}”: ${t}`);
      if (/Confirmed by carrier/.test(t)) throw new Error('a staff record is shown as carrier-confirmed');
      await see(staff, '30-day investigation window');
      await staff.screenshot({ path: `${SHOTS}/02-delivery-record.png`, fullPage: true, caret: 'initial' });
      await staff.goto(letterUrl);
      await see(staff, 'Recorded by staff'); await see(staff, 'WF-TRACK-0001');
    });

    await check('the bureau response is recorded with its date and the dispute is resolved', async () => {
      await staff.goto(disputeUrl);
      await staff.getByLabel('Outcome').selectOption('updated');
      await staff.getByLabel('Date response received').fill(receivedOn);
      await staff.getByLabel('Notes').fill('Synthetic reply: the balance was updated.');
      await staff.getByRole('button', { name: 'Record response' }).click();
      await see(staff, 'Response recorded');
      await staff.reload();
      await staff.getByRole('button', { name: 'Mark resolved' }).click();
      await see(staff, 'Confirm the change on the next report pull');
      await staff.reload();
      for (const s of ['Submitted', 'Response received', 'Resolved', 'Updated / corrected']) await see(staff, s);
    });

    let client, clientCtx;
    await check('the client is invited, signs in to the portal and sees the outcome and the delivery record in plain language', async () => {
      await staff.goto(clientUrl);
      await staff.getByRole('button', { name: 'Copy welcome link' }).click();
      await see(staff, 'Share this one-time link');
      inviteLink = ((await staff.locator('main').innerText()).match(/https?:\/\/\S+\/invite\/\S+/) || [])[0];
      if (!inviteLink) throw new Error('no welcome link shown');
      clientCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, extraHTTPHeaders: ip() });
      client = await clientCtx.newPage(); watch(client, 'client');
      await client.goto(inviteLink.replace(/^https?:\/\/[^/]+/, BASE));
      await client.getByLabel(/^Password/).fill(PASSWORD);
      await client.getByLabel('Confirm password').fill(PASSWORD);
      await client.getByRole('button', { name: 'Accept invitation' }).click();
      await client.waitForURL('**/portal/welcome', { timeout: 15000 }); // a new client starts in the guided welcome
      await see(client, 'Welcome, Workflow');
      await client.goto(BASE + '/portal');
      await see(client, 'Hello, Workflow');
      await client.goto(BASE + '/portal/disputes');
      await see(client, 'SYNTHETIC BANK NA'); await see(client, 'Corrected'); await see(client, 'cannot guarantee any result');
      await client.goto(BASE + '/portal/letters');
      await see(client, 'recorded by your specialist');
      if (await client.getByText('confirmed by the mail carrier').count()) throw new Error('portal shows a carrier confirmation that never happened');
      await client.screenshot({ path: `${SHOTS}/03-portal-letters.png`, fullPage: true, caret: 'initial' });
    });

    await check('staff update the client through the portal, the client replies, and the reply is first on the staff dashboard', async () => {
      await staff.goto(clientUrl + '?tab=messages');
      await staff.getByLabel('Message').fill('Synthetic update: Experian replied and updated the balance on this account.');
      await staff.getByRole('button', { name: 'Send' }).click();
      // Wait until the message is saved before the client opens the portal: the page is read once, not reloaded.
      await see(staff, 'Message sent to the client portal');
      await client.goto(BASE + '/portal');
      await see(client, 'Synthetic update: Experian replied and updated the balance');
      await client.goto(BASE + '/portal/messages');
      await client.getByLabel('Write a message').fill('Thank you. What happens next?');
      await client.getByRole('button', { name: 'Send' }).click();
      await see(client, 'Message sent');
      await staff.goto(BASE + '/app');
      const first = staff.locator('section', { has: staff.getByRole('heading', { name: 'Do these first' }) });
      for (const h of ['Overdue deadlines', 'Letters awaiting approval', 'Unanswered messages']) await first.getByRole('heading', { name: h }).waitFor();
      await first.getByText('Thank you. What happens next?').waitFor();
      if ((await staff.getByRole('link', { name: 'New client' }).count()) !== 1) throw new Error('expected exactly one “New client” button on the dashboard');
      await staff.screenshot({ path: `${SHOTS}/04-dashboard.png`, fullPage: true, caret: 'initial' });
    });

    await check('free-report path: the client uploads a report PDF in the portal and staff read it into the review queue in one click', async () => {
      // a text-based PDF like the one a bureau site produces with "Save as PDF" (synthetic content)
      const pdfPage = await clientCtx.newPage();
      await pdfPage.setContent(`<pre style="font:12px monospace">${EXPERIAN.replace('Experian Credit Report', 'TransUnion Credit Report').replace('$2,450.00', '$2,450.00')}</pre>`);
      const pdf = await pdfPage.pdf({ format: 'Letter' }); await pdfPage.close();
      await client.goto(BASE + '/portal/documents');
      await see(client, 'Send us your free credit reports'); await see(client, 'AnnualCreditReport.com');
      await client.getByLabel('What is it?').selectOption('credit_report');
      await client.setInputFiles('input[name=file]', { name: 'transunion-report.pdf', mimeType: 'application/pdf', buffer: pdf });
      await client.getByRole('button', { name: 'Upload' }).click();
      await client.waitForURL('**/portal/documents?uploaded=1');
      await staff.goto(clientUrl + '?tab=documents');
      const row = staff.locator('li', { hasText: 'transunion-report.pdf' });
      await row.getByText('uploaded by client').waitFor();
      await row.getByRole('button', { name: 'Read as credit report' }).click();
      await staff.waitForURL(/\/app\/reports\//, { timeout: 20000 });
      await see(staff, 'TransUnion report'); await see(staff, 'Review before this is used'); await see(staff, 'SYNTHETIC BANK NA');
      if (!/2,450\.00/.test(await staff.locator('main').innerText())) throw new Error('the balance was not read from the PDF');
      await staff.goto(clientUrl + '?tab=documents');
      const again = staff.locator('li', { hasText: 'transunion-report.pdf' });
      await again.getByRole('link', { name: 'Open report' }).waitFor();
      if (await again.getByRole('button', { name: 'Read as credit report' }).count()) throw new Error('the same file can be imported twice');
    });

    await check('access: the client can open only their own portal and letter; staff pages and the staff API are closed to them', async () => {
      const ids = { client: clientUrl.split('/').pop(), dispute: disputeUrl.split('/').pop(), letter: letterUrl.split('/').pop(), report: reportUrl.split('/').pop() };
      const own = await client.request.get(`${BASE}/api/letters/${ids.letter}/pdf`);
      if (own.status() !== 200) throw new Error('client cannot download their own sent letter: ' + own.status());
      for (const p of [`/app`, `/app/clients/${ids.client}`, `/app/disputes/${ids.dispute}`, `/app/letters/${ids.letter}`, `/app/reports/${ids.report}`, '/app/settings']) {
        await client.goto(BASE + p);
        if (!/\/portal(\/|$|\?)/.test(new URL(client.url()).pathname + '/')) throw new Error(`client reached ${p} (${client.url()})`);
      }
      const exp = await client.request.get(`${BASE}/api/clients/${ids.client}/export`);
      if (exp.status() === 200) throw new Error('client could export the staff record');
      const search = await client.request.get(`${BASE}/api/search?q=Workflow`);
      if (search.status() === 200 && /Workflow Client/.test(await search.text())) throw new Error('client could use staff search');
    });

    await check('access: staff of a second agency get “not found” for the first agency’s client, report, dispute, letter, PDF and export', async () => {
      const { p: other } = await signUpAgency(browser, 'Beta');
      const ids = { client: clientUrl.split('/').pop(), dispute: disputeUrl.split('/').pop(), letter: letterUrl.split('/').pop(), report: reportUrl.split('/').pop() };
      for (const p of [`/app/clients/${ids.client}`, `/app/clients/${ids.client}/compare`, `/app/clients/${ids.client}/what-if`, `/app/reports/${ids.report}`, `/app/disputes/${ids.dispute}`, `/app/letters/${ids.letter}`]) {
        const r = await other.goto(BASE + p);
        if (r.status() !== 404) throw new Error(`${p} returned ${r.status()} for another agency`);
      }
      for (const p of [`/api/letters/${ids.letter}/pdf`, `/api/clients/${ids.client}/export`]) {
        const r = await other.request.get(BASE + p);
        if (r.status() !== 404) throw new Error(`${p} returned ${r.status()} for another agency`);
      }
      const s = await other.request.get(`${BASE}/api/search?q=Workflow`);
      if (/Workflow Client|SYNTHETIC BANK/.test(await s.text())) throw new Error('search leaked another agency’s records');
      await other.goto(BASE + '/app/disputes?view=table');
      if (await other.getByText('SYNTHETIC BANK NA').count()) throw new Error('another agency’s dispute is listed');
      await other.goto(BASE + '/app');
      const first = other.locator('section', { has: other.getByRole('heading', { name: 'Do these first' }) });
      if (await first.getByText('Thank you. What happens next?').count()) throw new Error('another agency’s client message is on the dashboard');
    });
  } catch { /* failure already recorded */ }

  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} steps passed`);
  console.log(problems.length ? `Browser problems:\n  ${[...new Set(problems)].join('\n  ')}` : 'No page errors or 5xx responses in any browser.');
  await browser.close();
  process.exit(passed === results.length && results.length > 0 && problems.length === 0 ? 0 : 1);
})();
