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
| Email | `log` driver (nothing sent) | `log` | `resend` | `resend` |
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
only by a handful of audited system paths: sign-in, sign-up, password reset, invitation acceptance, webhooks and
scheduled jobs (`withSystem` in `src/lib/db.ts`).

On a managed database where the app role lacks `CREATEROLE`, create the role once as an admin before migrating:

```sql
create role disputeos_rls nologin noinherit;
grant disputeos_rls to <your_app_role>;
```

## Staging / production checklist

1. Provision PostgreSQL 14+ with automated backups and encryption at rest (provider setting). Use TLS (`?sslmode=require`).
2. Generate secrets: `openssl rand -base64 32` for `PII_ENCRYPTION_KEY`; `openssl rand -hex 24` for `CRON_SECRET`.
   Store them in the host's secret manager. **Back up the encryption key separately — without it encrypted data is unrecoverable.**
3. Set `APP_ENV=production`, `APP_URL=https://…`, `EMAIL_DRIVER=resend` with a verified domain.
4. `npm run db:migrate` (never `db:reset`).
5. Put `STORAGE_DIR` on a persistent encrypted volume (documents are additionally AES-256-GCM encrypted by the app).
6. Schedule `POST /api/jobs/run` (every 15 min) with `authorization: Bearer $CRON_SECRET` for automations and deadline tracking.
7. Review `docs/INTEGRATIONS.md` for what each optional integration needs, and what has and has not been verified.

## Rotating the encryption key

Set `PII_ENCRYPTION_KEY` to the new key and `PII_ENCRYPTION_KEY_ID` to a new id; move the old values to
`PII_ENCRYPTION_KEY_PREVIOUS` / `_PREVIOUS_ID`. New writes use the new key; old rows and files still decrypt.
Remove the previous key only after re-encrypting (a re-encryption job is on the roadmap, not yet built).
