# Deploying to Vercel with a Supabase database

This is the exact sequence for running DisputeOS on Vercel (serverless functions, no persistent disk) against a
Supabase-hosted PostgreSQL database reached through Supabase's connection pooler.

What is ready in the repository: database-backed document storage, verified TLS to the database, a small connection
pool on serverless, a build step that creates the schema, the cron schedule, and an upload limit that fits the platform.
What you supply: one connection string, one CA certificate, and a few values you generate yourself.

> **Not yet exercised against a real Supabase project or a real Vercel deployment.** Everything below was verified
> locally against PostgreSQL 16 as a non-superuser over certificate-verified TLS, and against the Supabase and Vercel
> documentation. See [What has not been verified](#what-has-not-been-verified) before you rely on it.

## 1. Create the Supabase project

1. Create a project. Choose a region and remember it (you will put Vercel's functions in the nearest one). Save the
   **database password** it shows you; you need it in step 3.
2. **Turn the Data API off**: Dashboard → Integrations → Data API → *Enable Data API* off. This app talks to PostgreSQL
   directly and never uses Supabase's REST/GraphQL API, Supabase Auth or Supabase Storage. (Migration 0014 also removes
   the table privileges of Supabase's `anon`, `authenticated` and `service_role` roles, so those APIs could not read the
   tables even if left on. Switching the API off is still the right setting.)
3. Download the database's CA certificate: Dashboard → Database → Settings → **SSL Configuration** → *Download
   certificate*. You will paste the contents of that file into `DATABASE_CA_CERT`.

## 2. Generate the secrets

From a copy of this repository:

```bash
npm run secrets:gen        # or: node scripts/gen-secrets.mjs
```

It prints `PII_ENCRYPTION_KEY`, `PII_ENCRYPTION_KEY_ID` and `CRON_SECRET` to the terminal and saves nothing. Put them in
a password manager **now**. `PII_ENCRYPTION_KEY` encrypts client identifiers and every stored document: if you lose it,
that data cannot be recovered, and if you replace it, existing data stops decrypting.

Without the repository, the same values come from `openssl rand -base64 32` (the key) and `openssl rand -hex 24` (the cron secret).

## 3. Copy the connection string

Supabase dashboard → **Connect** (top of the project page) → **Transaction pooler** (the Shared Pooler string on port
**6543**). It looks like this:

```
postgresql://postgres.abcdefghijklmnopqrst:[YOUR-PASSWORD]@aws-0-us-east-1.pooler.supabase.com:6543/postgres
```

- Replace `[YOUR-PASSWORD]` (brackets included) with the database password from step 1. If the password contains any
  of `@ : / ? # % &` or a space, percent-encode those characters (`@` → `%40`, `:` → `%3A`, `/` → `%2F`, `?` → `%3F`,
  `#` → `%23`, `%` → `%25`). The simplest way to avoid this is a password made of letters and digits only
  (Database → Settings → *Reset database password*).
- Keep the user name exactly as shown (`postgres.<project-ref>`): the pooler needs the project reference in it.
- Do **not** use the *Direct connection* string (`db.<ref>.supabase.co`). It is IPv6-only and Vercel cannot reach it.
- Do not add `sslmode` to it. A remote database is reached over TLS with the certificate verified
  (`scripts/pg-config.mjs`), and certificate verification cannot be switched off. The one thing the URL can do is
  turn TLS off entirely with `sslmode=disable`: that is only for a database on your own private network and must
  **never** be used with Supabase, because the password and all data would travel unencrypted. On Vercel the app and
  the build refuse a `DATABASE_URL` that contains it.

**Why transaction mode.** Supabase recommends it for serverless functions, which open many short-lived connections.
It does not support session state or named prepared statements, and this app uses neither: every query runs inside an
explicit transaction, the tenant role and user id are set with `SET LOCAL` / `set_config(..., true)`, the only advisory
locks are transaction-scoped, and there is no `LISTEN`, temp table or named prepared statement. The *Session pooler*
string (same host, port 5432) also works, but each open connection then holds a database connection of its own, so a
burst of serverless instances can exhaust the pooler; use it only if you have a reason to.

## 4. Create the Vercel project and set the environment variables

Import the repository in Vercel (framework preset: Next.js; leave the build command, output directory and install
command at their defaults). Before the first deploy, add these under Settings → Environment Variables, **for the
Production environment only** (see [Preview deployments](#preview-deployments)).

### Required

| Variable | Example shape | Where the value comes from | Secret? |
|---|---|---|---|
| `DATABASE_URL` | `postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:6543/postgres` | Step 3 (Supabase → Connect → Transaction pooler) | **Yes** |
| `DATABASE_CA_CERT` | `-----BEGIN CERTIFICATE-----` … `-----END CERTIFICATE-----` (the whole file, line breaks kept) | Step 1.3 (Supabase → Database → Settings → SSL Configuration) | No (it is a public certificate) |
| `APP_URL` | `https://app.your-domain.com` or `https://<project>.vercel.app` | The address people will use. Must be `https://`, no trailing slash. It is written into invitation, reset and unsubscribe links. | No |
| `PII_ENCRYPTION_KEY` | 44 characters of base64 (32 random bytes) | Step 2 (generated) | **Yes — and back it up** |
| `CRON_SECRET` | 48 hex characters (minimum 24 characters) | Step 2 (generated) | **Yes** |
| `STORAGE_DRIVER` | `db` | Type it. Vercel has no persistent disk, so documents are stored (encrypted) in the database. | No |
| `EMAIL_DRIVER` | `resend` or `disabled` | Type it. See [Email](#email-read-this-before-launch). The default (`log`) is refused in production. | No |
| `RESEND_API_KEY` | `re_…` | Only with `EMAIL_DRIVER=resend`: your Resend account | **Yes** |
| `EMAIL_FROM` | `Your Business <no-reply@your-domain.com>` | Only with `EMAIL_DRIVER=resend`: an address on a domain you verified in Resend | No |

`REQUIRE_STAFF_MFA` defaults to `false`: two-step verification is optional, and each user can turn it on for their own account. Set it to `true` to make it mandatory for staff, which is recommended once real client data is stored.

`APP_ENV` does not need to be set: Vercel sets `NODE_ENV=production`, which selects the production rules. Vercel sets
`VERCEL=1` itself; the app uses it to choose the small connection pool, the 4 MB upload limit and the Vercel-specific
checks.

### Optional

| Variable | Default | What it does | Secret? |
|---|---|---|---|
| `PII_ENCRYPTION_KEY_ID` | `1` | Label stored with each encrypted value; only changes when you rotate the key | No |
| `PII_ENCRYPTION_KEY_PREVIOUS`, `PII_ENCRYPTION_KEY_PREVIOUS_ID` | unset | The old key and its label during a key rotation (docs/ENVIRONMENTS.md) | **Yes** |
| `APP_TIMEZONE` | `America/New_York` | IANA timezone your business works in; decides what "today" is | No |
| `STAFF_IDLE_MINUTES` | `120` | Minutes of inactivity before staff are signed out (5–1440) | No |
| `TRUSTED_PROXY_HOPS` | `1` | Leave at 1 on Vercel | No |
| `MAX_UPLOAD_MB` | `4` on Vercel (10 elsewhere) | Largest upload. On Vercel it cannot be set above 4 | No |
| `DB_POOL_MAX` | `3` on Vercel (10 elsewhere) | Database connections one function instance may hold (1–50) | No |
| `AI_PROVIDER` | `rules` | `rules` (built-in, no AI service), `anthropic` or `openai` | No |
| `ANTHROPIC_API_KEY` | unset | With `AI_PROVIDER=anthropic` | **Yes** |
| `AI_BASE_URL`, `AI_API_KEY`, `AI_MODEL` | unset | With `AI_PROVIDER=openai` (any OpenAI-compatible endpoint); `AI_MODEL` also overrides the Anthropic model | `AI_API_KEY`: **Yes** |
| `STORAGE_DIR` | `.storage` | Not used on Vercel (`STORAGE_DRIVER=db`) | No |

### What production refuses to start with

The app checks its configuration when a server instance starts and on first use (`src/lib/env.ts`,
`src/instrumentation.ts`). With any of these wrong, every request fails and the function log shows
`Invalid environment configuration` or `Unsafe production configuration` followed by the exact list:

- `DATABASE_URL` missing; `APP_URL` missing, not a URL, or not `https://`
- `PII_ENCRYPTION_KEY` missing, not 32 bytes of base64, or equal to the development key
- `EMAIL_DRIVER` unset or `log`; or `resend` without `RESEND_API_KEY`
- `CRON_SECRET` shorter than 24 characters
- on Vercel only: `STORAGE_DRIVER` not `db`; `CRON_SECRET` missing; `MAX_UPLOAD_MB` above 4
- on Vercel only: `sslmode=disable` in `DATABASE_URL` (the build stops, and database queries fail, with
  `DATABASE_URL must not contain sslmode=disable on Vercel`)
- any value outside its allowed range (`STAFF_IDLE_MINUTES`, `TRUSTED_PROXY_HOPS`, `DB_POOL_MAX`, `APP_TIMEZONE`, …)

## 5. First deploy

1. Set the function region to the one nearest your Supabase region (Settings → Functions → Function Region).
2. Deploy to Production. Vercel runs the `vercel-build` script from `package.json`, which is
   `node scripts/migrate.mjs && next build`: it connects to the database, applies every migration in `db/migrations`
   that has not been applied yet (each in its own transaction, under a lock, so two builds cannot collide), then builds.
3. **Check the build log.** On the first deploy you should see `applied 0001_foundation.sql` … `applied
   0014_managed_db_and_stored_objects.sql` and `14 migration(s) applied`; on later deploys `database is up to date`.
   If the log shows neither, Vercel ran a different build command: set Settings → Build & Development → Build Command to
   `npm run vercel-build` and redeploy.
4. The build **fails on purpose**, before building anything, when:
   - `DATABASE_URL is not set, so the migrations cannot run…` — the variable is missing for this environment;
   - `Could not connect to the database: … Set DATABASE_CA_CERT…` — the CA certificate is missing or wrong;
   - `Could not connect to the database: password authentication failed…` — wrong or un-encoded password;
   - `FAILED 00NN_….sql: <reason>` — a migration failed. It was rolled back; earlier migrations stay applied. Fix the
     cause and redeploy.
5. Open `https://<your-app>/api/health`. `{"ok":true}` means the app reached the database and the row-level-security
   role exists. `{"ok":false}` (HTTP 503) means it could not: read the function log.
6. In Vercel → Settings → Cron Jobs, confirm `/api/jobs/run` is listed.

### Preview deployments

Only the Production build applies migrations. A Preview build (any other branch or a pull request; Vercel sets
`VERCEL_ENV=preview`) prints `Preview build: migrations are not applied; they run on the production deploy.` and goes
straight to `next build`, so an unreviewed branch cannot change a database's schema.

Still do not give Preview deployments the production database: a preview runs unreviewed code against whatever
`DATABASE_URL` it has. Either leave the variables set for Production only (a preview then has no database and its
requests fail, which is the safe outcome), switch preview deployments off, or give Preview
its own Supabase project and its own complete set of variables. A Preview with its own database is not migrated by
the build: migrate it by hand from your computer with that database's `DATABASE_URL` and `DATABASE_CA_CERT`, the same
way as the command in step 7 but ending in `npm run db:migrate`.

## 6. Create the first owner account

1. Open `https://<your-app>/signup`, enter your name, business name, email and a password (10+ characters), and choose
   "I run a credit repair business". This creates your workspace and makes you its **owner**.
2. You are taken straight to two-step verification: scan the code with an authenticator app (1Password, Google
   Authenticator, Authy) and enter the 6-digit code. Staff cannot use the app without it. **Keep the authenticator.**
3. Invite colleagues from Team, and clients from a client's page. With `EMAIL_DRIVER=disabled` the app shows you a
   one-time link to pass on yourself instead of sending an email.

Sign-up is open: anyone who knows the address can create their own, separate workspace. Workspaces cannot see each
other's data (PostgreSQL row-level security), but if you do not want strangers creating workspaces on your deployment,
that needs a code change; there is no switch for it today.

## 7. Grant AI credits

AI wording is optional and metered. With `AI_PROVIDER=rules` (the default) nothing needs credits. If you connect an AI
provider, add credits to a workspace from your own computer, with the repository checked out and `npm install` done:

```bash
DATABASE_URL='postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:6543/postgres' \
DATABASE_CA_CERT="$(cat prod-ca-2021.crt)" \
npm run credits:grant -- <workspace-slug> 500 "launch grant"
```

The workspace slug is the `org=` part of the client-portal sign-in link shown in the app
(`/portal/login?org=<slug>`), or `select name, slug from public.organizations;` in the Supabase SQL editor. The command
adds one row to the credit ledger and one to the audit log and prints the new balance. It takes no payment; no payment
processor is connected.

## 8. Known limits on Vercel

### Upload size: 4 MB
Vercel refuses any request body over about 4.5 MB before the app sees it, and the browser shows a generic failure. So
on Vercel the app's own limit is 4 MB (`MAX_UPLOAD_MB`, cannot be raised there): the file picker refuses a larger file
in the browser, the server checks again, and every message and help text shows the same number in English and Spanish.
A credit report PDF larger than 4 MB cannot be uploaded on Vercel; compress it or split it. The same platform limit
applies to reports pushed through the REST API. Raising it would need direct-to-storage uploads, which are not built.

### Documents live in the database
With `STORAGE_DRIVER=db` each uploaded file is one row in `public.stored_objects`, encrypted by the app with
`PII_ENCRYPTION_KEY` before it is written (AES-256-GCM, same format as on disk), and readable only by the app's system
connection. Files count toward your Supabase database size and are included in its backups. A database backup without
the encryption key cannot be read. Files uploaded under one storage driver are not visible to the other.

**The Supabase Free Plan is too small for this.** A Free Plan project becomes **read-only when its database size
passes 500 MB**, and a new project already uses about 40–60 MB. That leaves room for roughly 110 documents of the
full 4 MB (more if they are smaller). Once the database is read-only every write fails with `cannot execute INSERT in
a read-only transaction`, and signing in writes to the database too, so **nobody can sign in**: the whole app stops,
not only uploads. If you will store client documents, use a paid Supabase plan (its disk grows automatically), or at
the very least watch Database size in the Supabase dashboard (Database → Reports) and act well before 500 MB.
Supabase's "Understanding Database and Disk Size" guide explains how to leave read-only mode.

### Email (read this before launch)
Production will not start with the development email driver (`log`), by design: it delivers nothing. You have two
honest choices:

- `EMAIL_DRIVER=resend` with `RESEND_API_KEY` and `EMAIL_FROM` on a domain verified in Resend. Note: the Resend
  integration is written to Resend's documented API but has **not** been exercised against the live service from this
  codebase. Send yourself an invitation and a password reset before you rely on it.
- `EMAIL_DRIVER=disabled` to launch without an email provider. Nothing is ever sent and the app says so:
  invitations (team and client) show a one-time link for you to pass on; an email to a client is recorded as not
  delivered; automatic lead follow-up stays off; Settings → Integrations shows email as not connected.
  **Password reset by email is unavailable in this mode.** The reset page says so instead of offering a form, and
  there is no other self-service recovery: someone who forgets their password cannot get back in until you connect
  email. For a launch with one or two careful users this is workable; connect email before you onboard clients at scale.

### Scheduled jobs: once a day
`vercel.json` asks Vercel to call `GET /api/jobs/run` every day at 09:00 UTC. Vercel sends
`Authorization: Bearer <CRON_SECRET>` using the project's `CRON_SECRET` variable, and the route refuses anything else
(404 when no secret is configured, 401 when it does not match). The schedule is daily because Vercel's Hobby plan only
accepts cron jobs that run once a day, and may run them at any point within the hour. Consequences: automations that
react to deadlines, reminders and lead follow-ups act up to a day later than on a host that runs the jobs every 15
minutes. On a paid plan, change the schedule in `vercel.json` to `*/15 * * * *` and redeploy. Running the jobs more
than once is safe. Cron jobs only run for the production deployment.

To run the jobs by hand: `curl -H "Authorization: Bearer $CRON_SECRET" https://<your-app>/api/jobs/run`.

### Function duration
Pages and actions that parse reports or call an AI provider allow up to 60 seconds (`maxDuration = 60`), as does the
jobs route. A very large workspace count could outgrow one 60-second jobs run; the response lists what ran.

### Connections
Each function instance holds at most 3 database connections (`DB_POOL_MAX`) and releases idle ones after 5 seconds.

## What has not been verified

Verified locally: all 14 migrations apply as a non-superuser role with `CREATEROLE`/`CREATEDB` on a fresh PostgreSQL 16
cluster; the full database test suite passes as that role over TLS with the server certificate verified against a
private CA supplied through `DATABASE_CA_CERT`; a connection without the CA is refused; the Supabase Data API roles
lose their table privileges when they exist.

Not verified, because it needs the real services:

- PostgreSQL **17** (local testing used 16; nothing in the migrations is version-specific beyond PostgreSQL 14+).
- The real Supabase `postgres` role: that it may `grant usage on schema public`, create the `disputeos_rls` role and
  grant it to itself. PostgreSQL 16+ semantics say yes, and migration 0014 stops with the exact statement to run if not.
- The pooler itself: that Supavisor in transaction mode carries this app's traffic (the code was audited for everything
  the Supabase documentation lists as unsupported, but no transaction pooler was available to test against), and that
  the pooler's certificate is signed by the CA the dashboard lets you download.
- Vercel: that the `vercel-build` script is picked up without setting the build command, the exact body-size limit,
  the cron frequency allowed on your plan, and that multi-line `DATABASE_CA_CERT` survives the dashboard unchanged
  (a single line with `\n` in place of line breaks is also accepted).
- Resend delivery.
