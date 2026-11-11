# Integrations — what is real and what is not

Settings → Integrations shows this live, derived from configuration. **"Verified" means exercised against the real
third-party service from this codebase. None of the paid third-party integrations below have been.**

| Integration | Status | Notes |
|---|---|---|
| PostgreSQL | **Active, verified** | Tested against PostgreSQL 16. Works on any managed Postgres that lets you create the `disputeos_rls` role (see ENVIRONMENTS.md). |
| Document storage | **Active, verified** | Encrypted files on a server volume (`STORAGE_DIR`). **S3-compatible storage is not built.** |
| Email — Resend | Implemented, **not verified live** | `EMAIL_DRIVER=resend` + `RESEND_API_KEY` + verified domain. The default `log` driver writes to `.storage/outbox/` and delivers nothing; the UI marks such messages "Not delivered". |
| AI — Anthropic / OpenAI-compatible | Implemented, **verified against a mocked API only** | `AI_PROVIDER=anthropic` + `ANTHROPIC_API_KEY` (model via `AI_MODEL`, default `claude-sonnet-5-5`), or `AI_PROVIDER=openai` + `AI_BASE_URL` + `AI_API_KEY` + `AI_MODEL`. The deterministic engine is complete without them. |
| SMS | **Not built** | Needs a provider (e.g. Twilio) and TCPA-compliant opt-in. |
| Payment processing (Stripe etc.) | **Not built** | Payments are recorded manually. Also constrained by the CROA advance-fee rule. |
| Credit Connect (consent-gated import) | **Works, tested** | Upload, inbound REST API, and an adapter framework with a dev-only sandbox. See `docs/CREDIT_CONNECT.md` |
| Public REST API + API keys | **Works, tested** | `/api/v1/*`, OpenAPI at `/api/v1/openapi.json` |
| Live provider adapters (Array, IDIQ, bureaus) | **Not built — needs partner approval** | Provider APIs are partner-gated and require a permissible purpose and client authorization; there is no legitimate unauthenticated access. Import by upload/CSV today. |
| Electronic signatures | **Not built** | Typed-name e-signature in the portal with timestamp/IP/text hash is provided. |
| Certified mail (Lob, etc.) | **Not built** | The approved PDF is produced; a person mails it and records tracking. |
| External CRM sync | **Not built** | Per-client JSON export exists. |
| Error monitoring (Sentry) | **Not wired** | A PII scrubber is ready (`src/lib/scrub.ts`). |

## Scheduled jobs

`POST /api/jobs/run` with `Authorization: Bearer $CRON_SECRET` runs automation sweeps for every active organization and
cleans expired sessions/reset tokens/invites/rate-limit rows. It returns 404 when `CRON_SECRET` is unset. Call it every
15–60 minutes from your host's scheduler.
