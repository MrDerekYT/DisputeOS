# Integrations — what is real and what is not

Settings → Integrations shows this live, derived from configuration. **"Verified" means exercised against the real
third-party service from this codebase. None of the paid third-party integrations below have been.**

| Integration | Status | Notes |
|---|---|---|
| PostgreSQL | **Active, verified** | Tested against PostgreSQL 16. Works on any managed Postgres that lets you create the `disputeos_rls` role (see ENVIRONMENTS.md). |
| Document storage | **Active, verified** | Encrypted files on a server volume (`STORAGE_DIR`). **S3-compatible storage is not built.** |
| Email — Resend | Implemented, **not verified live** | `EMAIL_DRIVER=resend` + `RESEND_API_KEY` + verified domain. The default `log` driver writes to `.storage/outbox/` and delivers nothing; the UI marks such messages "Not delivered". It is for development and test only: staging/production refuse to start unless `EMAIL_DRIVER=resend`. |
| AI — Anthropic / OpenAI-compatible | Implemented, **verified against a mocked API only** | `AI_PROVIDER=anthropic` + `ANTHROPIC_API_KEY` (model via `AI_MODEL`, default `claude-sonnet-5-5`), or `AI_PROVIDER=openai` + `AI_BASE_URL` + `AI_API_KEY` + `AI_MODEL`. The deterministic engine is complete without them. |
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
