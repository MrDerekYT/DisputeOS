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
| `OUTREACH_EMAIL_FROM`, `OUTREACH_RESEND_API_KEY` | `Your Business <partners@outreach.your-domain.com>`, `re_…` | Optional, recommended if agencies use the partner email sequence: a separate sending address (own subdomain) and key for it, so cold business email cannot hurt the address that carries password resets | Key: **Yes** |
| `RESEND_WEBHOOK_SECRET` | `whsec_…` | Optional: the signing secret of a Resend webhook for `email.bounced` and `email.complained` pointing at `/api/webhooks/resend` (docs/INTEGRATIONS.md) | **Yes** |
| `OUTREACH_PLATFORM_DAILY_EMAILS`, `OUTREACH_PLATFORM_DAILY_TEXTS` | `500`, `300` (the defaults) | Most partner emails and lead follow-up texts the whole deployment sends in 24 hours, across all workspaces. `0` sends none | No |

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
| `AI_PROVIDER` | `rules` | `rules` (built-in, no AI service), `anthropic` or `openai`. See [Connect AI](#8-connect-ai-optional-and-grant-ai-credits) | No |
| `ANTHROPIC_API_KEY` | unset | With `AI_PROVIDER=anthropic`. Mark it **Sensitive** | **Yes** |
| `AI_MODEL` | `claude-opus-5-5` with `anthropic` | The Claude model. Cheaper: `claude-sonnet-5-5` or `claude-haiku-5-5`. Required with `openai` | No |
| `AI_EFFORT` | `low` | With `anthropic`: how hard the model thinks, `low`, `medium` or `high`. Higher costs more and takes longer | No |
| `AI_BASE_URL`, `AI_API_KEY` | unset | With `AI_PROVIDER=openai` (any OpenAI-compatible endpoint, with `AI_MODEL`) | `AI_API_KEY`: **Yes** |
| `STORAGE_DIR` | `.storage` | Not used on Vercel (`STORAGE_DRIVER=db`) | No |
| `SMS_DRIVER` | `disabled` | `twilio` to send client updates by text. See [Text messages](#text-messages-twilio). `log` is refused in production | No |
| `TWILIO_ACCOUNT_SID` | unset | With `SMS_DRIVER=twilio`: `AC…` from the Twilio Console | No |
| `TWILIO_AUTH_TOKEN` | unset | With `SMS_DRIVER=twilio`: the primary Auth Token. Also verifies Twilio's webhooks | **Yes** |
| `TWILIO_MESSAGING_SERVICE_SID` | unset | With `SMS_DRIVER=twilio`: `MG…` of the Messaging Service (recommended) | No |
| `TWILIO_FROM_NUMBER` | unset | Only without a Messaging Service: the sending number as `+15551234567` | No |
| `VERCEL_API_TOKEN` | unset | Lets agencies connect their own domain without you. See [Custom domains for agencies](#custom-domains-for-agencies) | **Yes** |
| `VERCEL_PROJECT_ID` | unset | With `VERCEL_API_TOKEN`: this project's ID (Project Settings → General) | No |
| `VERCEL_TEAM_ID` | unset | With `VERCEL_API_TOKEN`, when the project belongs to a team: the team's ID (Team Settings → General) | No |

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
6. In Vercel → Settings → Cron Jobs, confirm `/api/jobs/run` is listed (twice: 09:00 and 20:00 UTC).

### Preview deployments

Only the Production build applies migrations. A Preview build (any other branch or a pull request; Vercel sets
`VERCEL_ENV=preview`) prints `Preview build: migrations are not applied; they run on the production deploy.` and goes
straight to `next build`, so an unreviewed branch cannot change a database's schema.

Still do not give Preview deployments the production database: a preview runs unreviewed code against whatever
`DATABASE_URL` it has. Either leave the variables set for Production only (a preview then has no database and its
requests fail, which is the safe outcome), switch preview deployments off, or give Preview
its own Supabase project and its own complete set of variables. A Preview with its own database is not migrated by
the build: migrate it by hand from your computer with that database's `DATABASE_URL` and `DATABASE_CA_CERT`, the same
way as the command in step 8 but ending in `npm run db:migrate`.

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

## 7. Approve a workspace for outreach (before it emails leads or partners, or sends any text)

A workspace can switch on its follow-up emails and texts to leads, the email sequence to referral partners and client
updates by text, but nothing of that is sent until you, the operator, have approved it. Sign-up is open, the enquiry
form takes any email address and any number, and every workspace sends through your one email service and your one
text number. So look at the workspace first: a real business, a name that is its own, a partner list it compiled
itself. Then, from your own computer:

```bash
DATABASE_URL='postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:6543/postgres' \
DATABASE_CA_CERT="$(cat prod-ca-2021.crt)" \
npm run outreach:approve -- <workspace-slug>            # or: ... -- <workspace-slug> --revoke
```

Before it approves, the command prints the mailing address and the reply address the workspace has saved: they are
what its automatic emails carry besides the name. If they are not what you expect of that business, withdraw the
approval with `--revoke`.

The same thing without a terminal, in the Supabase dashboard (SQL Editor). The slug is the last part of the workspace's
enquiry form address (`/start/<workspace-slug>`):

```sql
-- 1. Look first: the name, and the two addresses its emails will carry.
select name, slug, settings->>'lead_mailing_address' as mailing_address, settings->>'lead_reply_email' as reply_address
  from public.organizations where slug = '<workspace-slug>';

-- 2. Approve it under the name it has now, and leave the same audit entry the command leaves.
with approved as (
  update public.organizations set outreach_approved_at = now(), outreach_approved_name = name
   where slug = '<workspace-slug>' and mode = 'agency' and status = 'active'
  returning id, name
)
insert into public.audit_logs (org_id, actor_label, action, entity_type, entity_id, metadata)
select id, 'platform operator (SQL editor)', 'outreach.approved', 'organization', id, jsonb_build_object('name', name) from approved
returning org_id;   -- one row back means it is approved; none means the slug is wrong or the workspace is not an active agency

-- To withdraw the approval: nothing more is sent. It leaves the same audit entry the command's --revoke leaves.
with withdrawn as (
  update public.organizations set outreach_approved_at = null, outreach_approved_name = null
   where slug = '<workspace-slug>' and outreach_approved_at is not null
  returning id
)
insert into public.audit_logs (org_id, actor_label, action, entity_type, entity_id, metadata)
select id, 'platform operator (SQL editor)', 'outreach.approval_withdrawn', 'organization', id, '{}'::jsonb from withdrawn
returning org_id;   -- one row back means it is withdrawn; none means it was not approved, or the slug is wrong
```

The approval is for the business name shown; if the workspace is renamed, nothing is sent until you approve it again.
A newly approved workspace sends at most 10 partner emails a day for its first 14 days. What needs the approval: the
follow-up emails and texts to leads, the partner emails, client updates by text and the test text on the Get set up
page. A workspace you have not approved emails no lead and no partner and texts no one. What does not need it: emails
to the workspace's own team and clients (invitations, sign-in emails, client updates by email). Details:
docs/INTEGRATIONS.md.

## 8. Connect AI (optional) and grant AI credits

AI wording is optional and metered. With `AI_PROVIDER=rules` (the default) no AI service is called and nothing needs
credits. The Claude connection is built to the current Anthropic API with the official SDK; it is proven live only once
`npm run ai:prove` has passed with a real key (docs/INTEGRATIONS.md, "AI provider (Claude)"). To connect it:

1. Create an API key in the Anthropic Console (console.anthropic.com → API keys). Setting a monthly spend limit on the
   Anthropic side is wise: the provider's bill is not reconciled against the app's credits. Once the account reaches a
   monthly spending limit, every AI call is refused until the limit resets or is raised in the Anthropic Console: the
   app keeps its standard wording, gives the credits back, and says "the AI account has reached its monthly spending
   limit" (the `[ai]` log line shows `code=enforced_spend_limit_reached`).
2. Vercel → the project → Settings → Environment Variables, for Production (and Preview if you test there):
   - `AI_PROVIDER` = `anthropic`
   - `ANTHROPIC_API_KEY` = the key, marked **Sensitive** (it can then not be read back from the dashboard)
   - optional `AI_MODEL`: `claude-opus-5-5` is the default; `claude-sonnet-5-5` ($2 / $10 per million input / output
     tokens) and `claude-haiku-5-5` ($0.10 / $0.50) are cheaper than Opus 5.5 ($4 / $20). Write the id exactly so.
   - optional `AI_EFFORT`: `low` (default), `medium` or `high`.

   Do not set `ANTHROPIC_LOG`; `AI_BASE_URL` and `AI_API_KEY` are only for the OpenAI-compatible option.
3. Redeploy (Deployments → the latest → Redeploy): environment variables are read when the app starts.
4. Sign in as an owner or admin, open **Get set up** (Settings → Get set up) and press **Test the AI connection** under
   "Agency basics". It sends one fixed request with no client data, costs no credits, and shows what the provider
   answered. The AI step is ticked only after it passes. If it fails, the message says why and what to check ("the AI
   key was refused", "the AI model … was not found", "the AI service rejected the request (HTTP 400)", "the AI account
   has reached its monthly spending limit…", "the AI service is busy, try again in a minute"); the Vercel function logs
   show a line starting with `[ai]` for every call, with the request id and any error code, never the text. For a
   rejected request, the live proof below prints the service's own explanation.
5. Grant credits to each workspace that should use AI (below). Every workspace starts at 0, and with 0 credits the
   model is not called.

Add credits to a workspace from your own computer, with the repository checked out and `npm install` done:

```bash
DATABASE_URL='postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:6543/postgres' \
DATABASE_CA_CERT="$(cat prod-ca-2021.crt)" \
npm run credits:grant -- <workspace-slug> 500 "launch grant"
```

The workspace slug is the `org=` part of the client-portal sign-in link shown in the app
(`/portal/login?org=<slug>`), or `select name, slug from public.organizations;` in the Supabase SQL editor. The command
adds one row to the credit ledger and one to the audit log and prints the new balance. It takes no payment; no payment
processor is connected.

To prove the connection with real calls before relying on it, run the live proof once from your own computer (it
needs the local test database, `npm run env:setup`, and costs a few cents):

```bash
AI_PROVIDER=anthropic ANTHROPIC_API_KEY=<key> AI_MODEL=claude-opus-5-5 npm run ai:prove
```

It makes one real call per AI feature on a made-up client and prints each request and reply (and, for a call that
failed, the service's own explanation); it fails if any call does not finish or if any of that client's personal
details appear in a request.

## 9. Known limits on Vercel

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
  codebase. Send yourself an invitation and a password reset before you rely on it. When Resend gives no answer (a
  timeout, a dropped connection, or an HTTP 5xx from a gateway in front of it) the app does not know whether the email
  went out: an automatic email to a lead or a partner is then never sent again, and the screens say "may or may not
  have arrived" rather than "failed".
- `EMAIL_DRIVER=disabled` to launch without an email provider. Nothing is ever sent and the app says so:
  invitations (team and client) show a one-time link for you to pass on; an email to a client is recorded as not
  delivered; automatic lead follow-up stays off; Settings → Integrations shows email as not connected.
  **Password reset by email is unavailable in this mode.** The reset page says so instead of offering a form, and
  there is no other self-service recovery: someone who forgets their password cannot get back in until you connect
  email. For a launch with one or two careful users this is workable; connect email before you onboard clients at scale.

### Text messages (Twilio)
Off by default: with `SMS_DRIVER` unset no text is ever sent and Settings → Client updates says “Not connected”.
To turn it on:

1. Twilio account, a number with SMS, and the carrier registration (**A2P 10DLC** brand and campaign for a ten-digit
   number, or toll-free verification). Allow several days; unregistered traffic to US numbers is blocked.
2. A Messaging Service with that number, linked to the approved campaign.
3. In the Messaging Service → Integration, “Send a webhook”, Request URL
   `https://<your-app-domain>/api/webhooks/twilio`, HTTP POST. The domain must be the one in `APP_URL`.
4. In Vercel → Settings → Environment Variables (Production): `SMS_DRIVER=twilio`, `TWILIO_ACCOUNT_SID`,
   `TWILIO_AUTH_TOKEN` (mark it Sensitive), `TWILIO_MESSAGING_SERVICE_SID`. Redeploy.
5. Settings → Client updates should show “Text messages: Connected”. Switch on the events you want; each client must
   also agree to texts in their portal profile.

The full steps, what is and is not sent, the consent record and the Resend DNS records are in
[docs/INTEGRATIONS.md](INTEGRATIONS.md#client-updates-by-text-message-and-email). Setting `SMS_DRIVER=twilio` without
the other values does not stop the app from starting: it reads as “Not connected” and lists what is missing.
The webhook only works on the production domain; preview deployments have a different URL, so Twilio's signature does
not match there and the request is refused.

### Scheduled jobs: twice a day
`vercel.json` asks Vercel to call `GET /api/jobs/run` every day at 09:00 and at 20:00 UTC. The second run exists for
text messages: 09:00 UTC is night-time across the US, when texts are held, so they need a daytime run to go out, and
20:00 UTC is the one hour that is daytime from Puerto Rico to Hawaii (3 or 4 p.m. Eastern, 10 a.m. in Honolulu). It was
17:00 UTC before, which is 7 a.m. in Hawaii and 8 a.m. in Alaska. A run stops starting new work after 40 seconds, so it
always finishes inside the route's 60; organizations it did not reach come first in the next run. Vercel sends
`Authorization: Bearer <CRON_SECRET>` using the project's `CRON_SECRET` variable, and the route refuses anything else
(404 when no secret is configured, 401 when it does not match). Each schedule is daily because Vercel's Hobby plan only
accepts cron jobs that run once a day, and may run them at any point within the hour. Consequences: automations that
react to deadlines, reminders and lead follow-ups act up to a day later than on a host that runs the jobs every 15
minutes. On a paid plan, replace both entries in `vercel.json` with one on `*/15 * * * *` and redeploy. Running the jobs more
than once is safe. Cron jobs only run for the production deployment. The run's result counts what it could not
finish: `notReached` (organizations it did not get to), `unfinished` (lead emails or client updates left for the next
run) and `unanswered` (lead or partner email runs that stopped because the email service did not answer). A run that
keeps reporting `unanswered` points at the email service, not at the app.

To run the jobs by hand: `curl -H "Authorization: Bearer $CRON_SECRET" https://<your-app>/api/jobs/run`.

### Function duration
Pages and actions that parse reports or call an AI provider allow up to 60 seconds (`maxDuration = 60`), as does the
jobs route. One AI call is stopped after 45 seconds, its retry included, so its credits are settled or refunded in time. A very large workspace count could outgrow one 60-second jobs run; the response lists what ran.

### Connections
Each function instance holds at most 3 database connections (`DB_POOL_MAX`) and releases idle ones after 5 seconds.

## The platform's own domain

To serve the app from your own domain (for example `disputeos.com`) instead of `<project>.vercel.app`:

1. Vercel → the project → Settings → Domains → add the domain, and create the DNS records Vercel shows at your
   registrar. Add both `disputeos.com` and `www.disputeos.com` and let Vercel redirect one to the other.
2. Set `APP_URL` to the address people should use (`https://disputeos.com`, no trailing slash), for Production.
3. Redeploy. Environment variables only reach a new deployment.

Do the three steps together. `APP_URL` is what tells the app which host is the platform: its host (with or without
`www.`), `*.vercel.app` deployment addresses and `localhost` are the platform, and **any other host is treated as an
agency's domain**. So a new domain that is in Vercel but not yet in `APP_URL` shows "page not found" at `/` and sends
`/login` to the old address until you finish step 2 and 3. The `<project>.vercel.app` address keeps working.

What else follows `APP_URL`, and must be updated when it changes:

- **Twilio webhook.** The inbound-message and status address is `APP_URL` + `/api/webhooks/twilio`, and Twilio's
  signature is checked against exactly that address. Change it in the Twilio Console (Messaging Service → Integration,
  or the number's Messaging settings) to the new domain, or text replies (including STOP) are refused.
- **Links in email and text messages**: invitations, password resets, unsubscribe links and the portal link in client
  updates are written with `APP_URL`. Links already sent keep the old host, which still works as long as the old
  address stays on the project.
- **Canonical addresses, the sitemap and robots.txt** of the product's own pages and of agency sites without their
  own domain.
- **Sessions are per host.** Nobody is signed out on the old address, but signing in on the new one is a new session.
- Email sending is separate: the sending domain is whatever you verified in Resend (`EMAIL_FROM`), not `APP_URL`.

## Custom domains for agencies

An agency can use a domain it already owns for its public website (`https://www.youragency.com/`), its enquiry form
(`/start`) and its clients' sign-in (`/portal/login`). Its address on the platform (`/a/<workspace>`) keeps working.
Staff tools stay on the platform: `/app`, `/login`, `/signup` and every other path on an agency's domain redirect to
`APP_URL`. Buying a domain is not built in, and email is not sent from the agency's domain.

A domain serves an agency only when its row in `agency_domains` is `verified`. Two things have to be true before a
row becomes verified, whichever of the two ways below connects it:

- **The DNS points at this deployment.** Vercel says so, or your own check does. Every workspace is given the same
  DNS target, so this alone says nothing about which workspace the domain belongs to.
- **The workspace's ownership record is in the domain's DNS.** It is a `TXT` record named `_disputeos` in front of
  the domain without a leading `www.`: `_disputeos.youragency.com` for both `youragency.com` and
  `www.youragency.com`, `_disputeos.clients.youragency.com` for `clients.youragency.com`. Its value is different for
  every workspace and every domain (a keyed hash of the two, made with `PII_ENCRYPTION_KEY`), and the agency's
  Website page shows it with the other records. Only someone who manages the domain's DNS can create it, so it is
  what ties the domain to that workspace. Another workspace that enters the same name is shown a different value, and
  the records the first one created never verify it.

The record is asked for when a domain becomes verified, not again afterwards: a verified domain stays verified until
the agency removes it or **Check now** finds that its DNS no longer points here. If you rotate `PII_ENCRYPTION_KEY`
the values change. Records made with the previous key still count while `PII_ENCRYPTION_KEY_PREVIOUS` is set; after
that, a domain that is not verified yet needs the new value from its Website page. Verified domains are not affected.

### Automatic (recommended)

Set `VERCEL_API_TOKEN` (Account Settings → Tokens; scope it to the team that owns the project) and
`VERCEL_PROJECT_ID`, plus `VERCEL_TEAM_ID` when the project belongs to a team, then redeploy. Settings → Integrations
then lists custom domains as connected. From then on, on the agency's **Website** page:

1. The agency types its domain and presses **Connect domain**. The app adds it to this Vercel project
   (`POST /v10/projects/{id}/domains`).
2. The page shows the DNS records to create at the registrar. The pointing record uses the values Vercel recommends
   for this project: an `A` record on `@` for a root domain (Vercel's general value is `76.76.21.21`), or a `CNAME`
   for a subdomain such as `www` (general value `cname.vercel-dns.com`). Next to it is the workspace's `TXT` record
   on `_disputeos`. If the domain is already in use on another Vercel account, Vercel also asks for a `TXT` record on
   `_vercel`, and the page shows that too.
3. **Check now** asks Vercel again and looks up the `_disputeos` record. The domain is marked connected only when
   Vercel reports it verified (ownership) and not misconfigured (DNS points at Vercel and a certificate can be
   issued), and the `TXT` record holds this workspace's value. Vercel issues the certificate itself. If the lookup
   itself fails, nothing is marked and the page says the domain's DNS could not be read.
4. **Remove domain** removes it from the Vercel project too. The DNS records stay at the agency's registrar until the
   agency deletes them; left in place, they verify the domain for nobody else.

Who may hold a name:

- A verified domain, and its `www` twin, cannot be connected by another workspace until the workspace that has it
  removes it.
- A domain that is saved but not verified is held for its workspace for 24 hours. After that the next workspace that
  enters the name takes it over. Before it is handed over it is checked with Vercel one last time, and if its DNS has
  become good with its holder's own `TXT` record in place, it is verified for its holder instead.
- A workspace whose `TXT` record is already in the domain's DNS does not have to wait out another workspace's 24
  hours. The refusal it gets names the record to create; with that record in place, **Connect domain** gives it the
  name at once.
- Taking a name over never verifies it. The new holder needs its own `TXT` record like anyone else.

A domain that is already on the project but was not added by the app (for example your own) is refused. Only the
exact name is connected; the page tells the agency to forward the other form (`youragency.com` →
`www.youragency.com`) at its registrar.

### By hand (no API token)

Without the token the agency can still save its domain; the page says plainly that it is not live until you add it.
Who may hold a name is decided as above, except that there is no last check with Vercel before a name changes hands.

1. The agency saves the domain on its Website page (it shows as "Not connected yet") and creates the `TXT` record on
   `_disputeos` that the page shows.
2. You add the domain in Vercel → the project → Settings → Domains, and send the agency the pointing record Vercel
   shows (the page shows Vercel's general value for it).
3. When Vercel shows the domain as valid, run, with the production `DATABASE_URL` and the app's
   `PII_ENCRYPTION_KEY` in your environment (and `PII_ENCRYPTION_KEY_PREVIOUS`, if the app has one):

   ```
   npm run domain:verify -- www.youragency.com
   ```

   It first prints the workspace that holds the domain. Check that it is the agency you are doing this for: a name
   that was saved more than a day ago and never verified may have been taken over by another workspace since. It
   then requests `https://www.youragency.com/api/domain-check` and looks up the `TXT` record, and marks the domain
   verified only if this deployment answers there for that domain over a valid certificate and the record holds
   that workspace's value. Otherwise it says what it found and changes nothing. Without `PII_ENCRYPTION_KEY` it
   stops before checking anything: it cannot work out the value the record has to hold.
4. To disconnect: the agency presses **Remove domain**, and you remove the domain in Vercel.

Running servers pick up a newly verified or removed domain within a minute.

Not verified here: the number of domains a project may hold on your Vercel plan (see Vercel's limits page);
wildcard domains, which this feature does not use; and the `TXT` lookup against live DNS from Vercel's runtime (it
is tested against a stand-in for DNS only).

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
- The Claude connection: built to the current Anthropic API with the official SDK and tested against a mocked API and
  a local stand-in only. It is proven live once `npm run ai:prove` has passed with a real key, and from a deployment by
  the Get set up page's "Test the AI connection".
- Custom domains: the Vercel domains API (adding, verifying, removing) is implemented to its documentation and tested
  against a mocked API only; routing by `Host` is tested as a pure function and against the database, not behind
  Vercel's edge with a real domain. Check the first agency domain by hand after connecting it.
- Twilio: sending, delivery reports and the inbound webhook. Tested against a mocked API and Twilio's documented
  signature example only. Also not verified: that your Vercel plan accepts two cron entries for the same path.
