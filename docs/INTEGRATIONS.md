# Integrations — what is real and what is not

Settings → Integrations shows this live, derived from configuration. **"Verified" means exercised against the real
third-party service from this codebase. None of the paid third-party integrations below have been.**

| Integration | Status | Notes |
|---|---|---|
| PostgreSQL | **Active, verified** | Tested against PostgreSQL 16. Works on any managed Postgres that lets you create the `disputeos_rls` role (see ENVIRONMENTS.md). |
| Document storage | **Active, verified** | Encrypted files on a server volume (`STORAGE_DRIVER=disk`, `STORAGE_DIR`) or, for hosts with no persistent disk such as Vercel, encrypted rows in the database (`STORAGE_DRIVER=db`, table `stored_objects`). Both verified by tests. **S3-compatible storage is not built.** |
| Email — Resend | Implemented, **not verified live** | `EMAIL_DRIVER=resend` + `RESEND_API_KEY` + verified domain. The default `log` driver writes to `.storage/outbox/` and delivers nothing; the UI marks such messages "Not delivered". It is for development and test only: staging/production refuse to start unless `EMAIL_DRIVER=resend`. |
| Email — none (`EMAIL_DRIVER=disabled`) | **Manual**, verified by tests | The explicit way to run staging/production without an email provider. Nothing is sent or logged; invitations show a one-time link to pass on; client emails are recorded as not delivered; lead follow-up stays off; **password reset by email is unavailable** and the reset page says so. |
| AI — Anthropic / OpenAI-compatible | Implemented, **verified against a mocked API only** | `AI_PROVIDER=anthropic` + `ANTHROPIC_API_KEY` (model via `AI_MODEL`, default `claude-sonnet-5-5`), or `AI_PROVIDER=openai` + `AI_BASE_URL` + `AI_API_KEY` + `AI_MODEL`. The deterministic engine is complete without them. |
| AI credits (metering) | **Works, tested; buying online is not connected** | Every AI result that is returned costs credits from the workspace's balance (`src/lib/ai/credits.ts` holds the price list; ledger in `ai_credit_ledger`, migration 0012). A workspace with no credits, or with no AI provider, gets the standard non-AI wording. There is no checkout: the platform operator adds credits with `npm run credits:grant -- <org-slug> <amount> [note]`. Selling credits in the app needs a payment processor (e.g. Stripe), a checkout and a webhook that writes `purchase` rows. |
| SMS | **Manual** (no provider integration) | Staff log calls and texts by hand. An integration needs a provider (e.g. Twilio) and TCPA-compliant opt-in. |
| Payment processing (Stripe etc.) | **Manual** (no processor integration) | Payments are recorded manually; there are no Stripe settings. Also constrained by the CROA advance-fee rule. |
| Credit Connect (consent-gated import pipeline) | **Pipeline works, tested; no live provider** | Upload, inbound REST API, and an adapter framework with a dev-only sandbox. Nothing is imported automatically from a real provider, so Settings shows "Test stand-in only" in development and "Manual path in use" in staging/production. See `docs/CREDIT_CONNECT.md` |
| Public REST API + API keys | **Works, tested** | `/api/v1/*`, OpenAPI at `/api/v1/openapi.json` |
| Live provider adapters (Array, IDIQ, bureaus) | **Manual** (no adapter; needs partner approval) | Provider APIs are partner-gated and require a permissible purpose and client authorization; there is no legitimate unauthenticated access. Import by upload/CSV today. |
| Electronic signatures (external provider) | **Manual** (no provider integration) | Typed-name e-signature in the portal with timestamp/IP/text hash is provided. |
| Certified mail (Lob, etc.) | **Manual** (no provider integration) | The approved PDF is produced; a person mails it and records tracking. |
| External CRM sync | **Manual** (no sync integration) | Per-client JSON export exists. |
| Error monitoring (Sentry) | **Not wired** | A PII scrubber is ready (`src/lib/scrub.ts`). |

## Credit-monitoring referral link (not an integration)

Settings → Organization lets an agency set one optional https link to a paid monitoring service (for example an affiliate
link) plus a display name. It is **only a link**: no data flows to or from that service, nothing is imported through it, and
reports still arrive by upload (or the REST API) exactly as before. Clients see it in the portal under Documents, below the
free AnnualCreditReport.com instructions, marked optional; unless the agency unticks "I may earn a commission from this
link", the client is told the agency may earn a commission. Stored in `organizations.settings` (`monitoring_url`,
`monitoring_label`, `monitoring_paid`) and re-validated on every read (`src/lib/monitoring.ts`).

## What each status means

Settings → Integrations labels every integration by what happens **in the configured environment**:

| Label | Meaning |
|---|---|
| Active | Connected and in use |
| Test stand-in only | A development substitute is in use (a log file, synthetic data). Nothing real happens |
| Needs credentials | Built and switched on, but missing the credentials it needs |
| Manual path in use | No provider is connected. A person completes the step through the documented manual path |
| Not built | No integration and no manual path (no row uses this today) |

## Pilot workflow: the manual path and the exact remaining dependency

| Step | Status today | Supported manual path | Exact remaining dependency |
|---|---|---|---|
| Live credit pulls | Development/test: sandbox with SYNTHETIC data only. Staging/production: manual | Upload the report (PDF, HTML, text, CSV template) or push it through `POST /api/v1/clients/{id}/reports`. Needs the client's FCRA authorization; a person approves every report | Signed partner/reseller agreement and issued API credentials from a report provider; then one adapter file (docs/CREDIT_CONNECT.md) |
| Certified mail | Manual | Download the approved PDF, mail it, record method + date sent + optional tracking. Stored as `delivery_source = staff_recorded` and shown as "Recorded by staff" | A print-and-mail account (e.g. Lob), API key, sender address, and an integration that sends approved letters and reads delivery events. Only that integration may set `carrier_confirmed` |
| Payments | Manual | Record payments collected elsewhere on the client's Billing tab (requires the CROA "service already performed" confirmation) | Stripe (or similar) account, API keys, webhook secret, Checkout + webhook integration |
| SMS | Manual | Text/call from your own phone and log it on the client's Messages tab ("nothing is sent") | SMS provider account with a registered number, TCPA opt-in per client, and the integration |
| External e-signature | Manual | Typed-name signature in the portal (name, time, IP, hash of the text shown), or staff record a paper consent | Only if counsel requires a third-party signing service: an account with it and the integration |

## Leads follow-up and the credit guide: what they need

| Feature | Works with nothing connected | Needs | What is not there |
| --- | --- | --- | --- |
| Leads page, enquiry form, tagged links, counts | Yes | Nothing | — |
| Automatic follow-up email to leads | **No.** With the `log` driver nothing is sent and nothing is recorded as sent; the Leads page says "Email is not connected" | `EMAIL_DRIVER=resend` + `RESEND_API_KEY` + a verified sending domain for `EMAIL_FROM`; the agency's postal address and reply address saved on the Leads page; the switch on. The welcome is sent right after the enquiry; the follow-up and last note need the scheduled job below to be running | **Replies are not read.** They go to the agency's reply address; staff press "They replied" or "Asked to stop". Reading them needs an inbound-email webhook, which does not exist. The From line is `"<Agency name>" <address from EMAIL_FROM>`; the Resend driver, including this, is not verified against the live service. A step whose result was never recorded stays "not confirmed" and is not re-sent |
| Credit guide (chat box) | Yes — answers come from the vetted knowledge base by keyword match | Nothing. Optional: `AI_PROVIDER` (same settings as the AI row above) lets a model re-phrase the retrieved entries | With AI on, the question (names, numbers, amounts and addresses masked) is sent to the provider. Output is discarded and the vetted text shown when a pattern rule matches a promise, an unknown number or web address, or a prompt marker; the rules are patterns, not a proof. Tested against a fake provider only |

## Scheduled jobs

One code path (`src/lib/automation/jobs.ts`) runs the automation sweeps for every active organization and cleans expired
sessions, reset tokens, invites and rate-limit rows. Two ways to invoke it:

- `POST /api/jobs/run` with `Authorization: Bearer $CRON_SECRET` (404 when `CRON_SECRET` is unset, 401 when it is wrong).
- `npm run jobs:run` — makes exactly that call against `APP_URL` (or `JOBS_URL`). The app must be running. Exit code 0 = ran
  with no failures; 1 = unreachable, wrong secret, or at least one organization failed; 2 = `CRON_SECRET` not set.

Call it every 15–60 minutes from your host's scheduler.

- **Retries are safe.** Each automation run is unique per automation, subject and cooldown window, so running twice creates
  no duplicate tasks, messages or notifications (tested).
- **Failures are visible.** Each organization runs in its own transaction; a failure is rolled back, written to `job_runs`
  (Automations → Scheduled checks), and the organization's owners/admins get one in-app notification per day while it lasts.
  Other organizations still run (tested).

## AI credits

AI wording is metered so the platform operator can charge for it. Nothing about AI is free.

- **Prices** (one place: `AI_COSTS` in `src/lib/ai/credits.ts`): letter wording suggestion 5, client progress note polish 2,
  credit guide answer worded by AI 1. These are credits, not money; what a credit costs is the operator's decision and is
  not stored in the app.
- **When credits are taken.** At the moment the model is called, and only kept if an AI result passes the safety checks and
  is returned. If the provider fails, or its output is discarded, the same amount is written back as a `refund` row that
  points at its charge (`ref_id`; the database allows one refund per charge). A letter suggestion is charged when it is
  shown, whether or not staff then accept it.
- **Interrupted requests.** A charge is a reservation until its outcome is recorded (`settled_at` on the `use` row, or a
  refund row). If the request is killed between the charge and the result (host time limit, deploy, crash), or the refund
  cannot be written, the scheduled jobs (`POST /api/jobs/run`, see above) refund every charge that has had no outcome for
  10 minutes; the response reports the count as `aiRefunds`. **This needs the scheduler to be running** (`CRON_SECRET` set
  and the host calling the route). Without it such a charge stays until `npm run jobs:run` is run by hand. The staff
  and portal layouts set `maxDuration = 60`, above the 30 s provider timeout; the host plan must allow 60 s functions.
- **Paid results are kept.** A letter suggestion is stored for the letter version it was made from (`letter_suggestions`,
  migration 0013) and shown again from the letter page, so a reload or a lost response does not lose it and asking again for
  the same version is not charged again. It is not shown once the letter has a newer version; that is not refunded. The
  polished progress note is **not** stored: if its response is lost, pressing the button again is charged again.
- **With no credits or no provider** the app behaves exactly as it does without AI: the deterministic text is used. Staff see
  "AI wording is off: no AI credits left" or "…no AI provider connected". Portal clients see the normal vetted answer and
  nothing about credits.
- **Portal clients and the agency's credits.** Off by default: portal guide questions get the vetted knowledge-base
  answer, the model is not called and nothing is charged. An owner or admin can turn it on under AI assistant → AI credits
  (stored as `settings.portal_ai_guide`, audited). When on, each client is limited to 10 AI-worded answers in any 24 hours
  (`PORTAL_GUIDE_DAILY_CAP`), then gets the vetted answer. There is no per-workspace cap: the ceiling is 10 credits per
  portal client per day. Identical repeated questions are not cached and count toward the cap.
- **Ledger.** `ai_credit_ledger` is append-only (a trigger blocks UPDATE and DELETE, including for the system role; the one
  permitted change is setting `settled_at` once on a `use` row; rows go only when their organization is deleted). The balance is `sum(delta)` — there is no balance column. Tenant requests can
  only read it (staff of the organization); nobody can insert through the tenant connection.
- **Adding credits.** `npm run credits:grant -- <org-slug> <amount> [note]` on the server, with `DATABASE_URL` set. Amount is
  a whole number from 1 to 100000. It writes a `grant` row and an `ai_credits.granted` audit entry and prints the new
  balance. It does not take payment. New workspaces start at 0; the demo seed gives the demo agency 100 labelled sample credits.
- **Where staff see it.** AI assistant page → "AI credits": balance and price list for all staff, the last 20 ledger
  entries for owners and admins. The balance is also shown beside "Suggest better wording" on a letter.
- **Not built.** Online purchase, invoices, a money price per credit, low-balance alerts, caps for staff or per workspace, and a
  cross-workspace usage report for the operator (query `ai_credit_ledger` directly for now). The provider's own bill is
  not reconciled against credits. Not exercised against a live AI provider — fake provider in tests only.
