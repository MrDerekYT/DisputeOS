# Environments

DisputeOS runs in four environments, selected by `APP_ENV` (falls back to `NODE_ENV`). Configuration is validated
the first time it is needed; a bad configuration fails fast with a list of what is wrong (`src/lib/env.ts`).

| | development | test | staging | production |
|---|---|---|---|---|
| Purpose | day-to-day work | automated tests | production-like rehearsal | real customers |
| Database | `disputeos_dev` | `disputeos_test` (`DATABASE_URL_TEST`) | own managed DB | own managed DB |
| Encryption key | throwaway key allowed (warned) | throwaway key | **required**, dev key rejected | **required**, dev key rejected |
| `APP_URL` | http allowed | http allowed | **https required** | **https required** |
| Staff MFA | on (can be turned off locally) | on | **must be on** | **must be on** |
| Email | `log` driver (nothing sent) | `log` | `resend` or `disabled` | `resend` or `disabled` |
| Text messages (`SMS_DRIVER`) | `disabled`, or `log` (nothing sent) | `disabled`; the SMS tests switch to `log` | `disabled` or `twilio` | `disabled` or `twilio` |
| Seed data | `npm run db:seed` (demo agency) | per-test fixtures | never | never |
| `db:reset` | allowed | allowed | refused | **refused** |

## Local setup (this is what was used to build and verify the project)

```bash
npm install
npm run env:setup          # creates disputeos_dev + disputeos_test on your local Postgres and migrates both
cp .env.example .env.local # set DATABASE_URL (and DATABASE_URL_TEST) — see the file for every variable
npm run db:seed            # optional: a clearly-labelled demo agency (development only)
npm run dev
npm run check              # typecheck + lint + all tests + production build
```

No local Postgres? `docker compose up -d` starts one (`postgres://disputeos:disputeos@localhost:5432/disputeos_dev`).

## Database roles (important)

Tenant isolation is enforced by PostgreSQL row-level security. Application requests run as the NOLOGIN role
`disputeos_rls`, which can only see rows its policies allow. The role in `DATABASE_URL` (the table owner) is used
only by a handful of audited system paths: sign-in, sign-up, password reset, invitation acceptance, API-key authentication, the health check and
scheduled jobs (`withSystem` in `src/lib/db.ts`).

The owner role does not need to be a superuser. It needs `CREATEROLE` once (migration 0001 creates `disputeos_rls`,
migration 0014 grants it to the owner so `SET ROLE` works on PostgreSQL 16+). Where the app role lacks `CREATEROLE`,
create the role once as an admin before migrating; migration 0014 stops with this same statement if it is missing:

```sql
create role disputeos_rls nologin noinherit;
grant disputeos_rls to <your_app_role>;
```

The app works behind a transaction-mode connection pooler (PgBouncer, Supabase port 6543): every query runs in an
explicit transaction and all per-request state is transaction-local. Connections to a remote database always use TLS
with the certificate verified (`DATABASE_CA_CERT` for a private CA; `?sslmode=disable` only for a private network).

**Vercel + Supabase:** follow [DEPLOY-VERCEL.md](DEPLOY-VERCEL.md), which has the full variable table.

## Staging / production checklist

1. Provision PostgreSQL 14+ with automated backups and encryption at rest (provider setting). TLS with certificate
   verification is automatic for a remote database; set `DATABASE_CA_CERT` if its CA is private.
2. Generate secrets: `npm run secrets:gen` (or `openssl rand -base64 32` for `PII_ENCRYPTION_KEY`; `openssl rand -hex 24` for `CRON_SECRET`).
   Store them in the host's secret manager. **Back up the encryption key separately — without it encrypted data is unrecoverable.**
3. Set `APP_ENV=production`, `APP_URL=https://…`, `EMAIL_DRIVER=resend` with `RESEND_API_KEY` and a verified domain
   (staging/production refuse to start with the `log` driver; `EMAIL_DRIVER=disabled` is the explicit way to run
   without email: nothing is sent, the app says so, and password reset by email is unavailable). Set `APP_TIMEZONE` to your business timezone (default
   `America/New_York`): it decides what "today" is for sent-on dates, task due days and the overdue count. Set `TRUSTED_PROXY_HOPS` to the
   number of reverse proxies in front of the app (default 1) — see docs/SECURITY_AND_COMPLIANCE.md.
   Lines left blank in an env file (`CRON_SECRET=`) count as not set.
4. `npm run db:migrate` (never `db:reset`).
5. Put `STORAGE_DIR` on a persistent encrypted volume (documents are additionally AES-256-GCM encrypted by the app),
   or set `STORAGE_DRIVER=db` to keep them in the database on a host with no persistent disk.
6. Schedule `POST /api/jobs/run` (every 15 min) with `authorization: Bearer $CRON_SECRET` for automations and deadline tracking.
   From a machine with the repo and the same environment, `npm run jobs:run` makes that call and exits non-zero if the app is
   unreachable, the secret is wrong, or any organization's jobs failed. It is safe to retry. See docs/INTEGRATIONS.md.
7. Point your load balancer / uptime monitor at `GET /api/health`: unauthenticated, no side effects, answers
   `200 {"ok":true}` when the database is reachable and the `disputeos_rls` role exists, otherwise `503 {"ok":false}`.
   It returns no version, configuration or error details.
8. Review `docs/INTEGRATIONS.md` for what each optional integration needs, and what has and has not been verified.

## Rotating the encryption key

Set `PII_ENCRYPTION_KEY` to the new key and `PII_ENCRYPTION_KEY_ID` to a new id; move the old values to
`PII_ENCRYPTION_KEY_PREVIOUS` / `_PREVIOUS_ID`. New writes use the new key; old rows and files still decrypt.
Remove the previous key only after re-encrypting (a re-encryption job is on the roadmap, not yet built).
