# Changelog

## Vercel + Supabase readiness (unreleased, uncommitted)

Everything needed to run on Vercel (serverless, no persistent disk) against a Supabase database through its connection
pooler. Step-by-step guide and the full variable table: `docs/DEPLOY-VERCEL.md`. Not yet exercised against the real services.

- **Database-backed document storage** (`STORAGE_DRIVER=db`, migration 0014 `stored_objects`): same at-rest encryption and
  key format as the disk driver (still the default). The table has row-level security and no tenant grants or policies.
- **Non-superuser database owner.** Migration 0014 grants `disputeos_rls` to the owner (needed for `SET ROLE` on
  PostgreSQL 16+) and stops with the statement to run when it cannot. It also removes the table privileges Supabase
  gives its Data API roles (`anon`, `authenticated`, `service_role`).
- **Connections** (`scripts/pg-config.mjs`, used by the app and every script): a remote database is always reached over
  TLS with the certificate verified; `DATABASE_CA_CERT` supplies a private CA; `?sslmode=disable` is the only opt-out,
  for private networks, and is refused on Vercel. **Behaviour change:** a remote `DATABASE_URL` without TLS used to connect in plaintext and is
  now refused unless it says `sslmode=disable`. Pool size is `DB_POOL_MAX` (default 10; 3 on Vercel).
- **`npm run vercel-build`** migrates, then builds (a Vercel Preview build skips the migrations); it fails the build when `DATABASE_URL` is missing or a migration
  fails. Migrations now take a transaction-scoped lock so concurrent builds cannot collide. `build` is unchanged.
- **Scheduled jobs:** `vercel.json` schedules `GET /api/jobs/run` daily; the route now answers GET as well as POST, with
  the same `Authorization: Bearer <CRON_SECRET>` check.
- **Upload limit** is `MAX_UPLOAD_MB` (default 10; 4 on Vercel). The server check, the browser check (now also on the
  staff upload forms) and every message in English and Spanish use that one number.
- **`EMAIL_DRIVER=disabled`**: an explicit way to run production without an email provider. Nothing is sent and the app
  says so; password reset by email is unavailable in that mode. The `log` driver is still refused in production.
- **Production on Vercel refuses** disk storage, a missing `CRON_SECRET` and an upload limit above 4 MB.
- `npm run secrets:gen` prints fresh values for the generated secrets (writes no file).

## Night Desk redesign: review fixes (unreleased, uncommitted)

Fixes from the design, accessibility and accuracy review of the redesign. Presentation only, except where noted.

- **No sideways page scroll.** The dispute pipeline board and the dispute page no longer widen the page (2184px / 523px before). Every
  sideways scroller is now a positioned box so visually-hidden labels are clipped with it. On phones the dispute's seven-step
  pipeline is one line in words ("Step 4 of 7: Submitted") with a segmented bar.
- **Staff tables on phones** (`.table-stack` in `globals.css`): disputes, clients, letters, team, leads and a client's disputes
  and letters stack into rows below `sm` — title wrapping on its own line, then status, the investigation-window meter, date and
  the one action. The AI credit ledger is a plain list. Nothing important sits behind an unannounced scroll.
- **Investigation window counted from receipt.** "Day N of M" and the bar now start at the deadline minus its 30 (or 45) days
  (`windowStart` in `src/lib/day-meter.ts`), so M is always 30 or 45. It used to be measured from the mailing date, which read
  "Day 5 of 35" when a letter was recorded five days after it was sent. Days left and days overdue are unchanged. New unit tests.
- **Branded "not found" pages** (`src/app/not-found.tsx`, `src/app/app/not-found.tsx`). A damaged or expired unsubscribe link now
  explains itself in English and Spanish instead of a bare 404.
- **Client portal:** the credit-guide launcher is a round icon button (labelled for screen readers) so it no longer covers the
  rights text or forms; every page uses one left-aligned content column; the full legal note stays on Home, My items and Profile and
  the other pages carry one line linking to "Your rights"; "Sent —" is now "Sent, date not recorded" / "Enviada, fecha no registrada".
- **Raw values removed:** a letter's recipient shows as "Equifax", not `equifax`; report sources read "file upload", "CSV import".
- **Less clutter:** the report review is one divided list (four figures per account, the rest behind a disclosure); a client's
  Reports tab is grouped by bureau with earlier reports folded away; Settings has an in-page section nav and collapsible
  integration rows; Leads shows one status line for automatic follow-up with the detail behind "How it works" (opt-out and
  postal-address copy stay visible); AI credit refund rules sit behind a disclosure. With a short queue the dashboard figures
  move up beside the windows panel.
- **Empty states** have no dashed box: a display-face title, one sentence and one action.
- **AI mark on the dashboard:** letters awaiting approval whose current text is an AI draft carry the spark, as on the letters list.
- **Marketing accuracy:** removed the claim (and the hero picture) that AI suggestions cite their source fields; the copy now
  describes what exists: the suggestion beside the current text with changed lines marked, discarded if a number or date changes.
- **Pricing structured data** no longer publishes the proposed prices as schema.org offers; billing is not connected.
- **Portal colour:** the picker starts from the product colour (#3b49d1) and submits nothing until a colour is actually chosen, so
  saving another setting cannot quietly store a brand colour. "Use the standard colour" clears a chosen one.

## 0.2.0 — Product takeover (unreleased, uncommitted)

Consolidates the two diverged Copilot branches (`copilot/disputeos-phase-1-scaffold-auth`, `mrderekyt-disputeos-preview`)
into one codebase. Both branches are untouched. See `docs/ENGINEERING_ASSESSMENT.md` for the audit.

### Replaced / removed (with reasons)
- Supabase Auth/PostgREST/Storage → first-party auth + direct PostgreSQL with RLS (Supabase's stack cannot run in the build
  environment, so nothing depending on it could be verified). The database still runs on Supabase's Postgres if you wish.
- Preview branch demo data (`DEMO_CLIENTS`, fabricated score/spend figures) and the "any signed-in user is admin" check.
- `next-intl`, jest/ts-jest, `@sentry/nextjs`, radix/cva/clsx/tailwind-merge.

### Added
- Multi-tenant schema (6 migrations) with row-level security on every table; append-only audit log; portal triggers.
- Auth: sign-up, login, lockout, rate limits, TOTP MFA, password reset, change password, staff & client invitations, revocable sessions.
- CRM, document vault (encrypted), consent ledger, tasks, notes, messaging, timeline, segments, export & delete.
- Report import (PDF/HTML/text/CSV), parser with confidence, review & approval, three-bureau comparison, discrepancy findings.
- Dispute pipeline with rounds, deadlines, evidence, audit trail; letter center with 11 templates (EN, with ES for the main letters), PDF, versions, approvals.
- AI assistant (modular providers, fact-preservation guard), claims guard, automation engine with safeguards.
- Client portal (EN/ES), team management, analytics, billing records, settings, integrations status, audit viewer.
- dev/test/staging/production configuration with boot-time validation; CI workflow; docker-compose.
- 180 automated tests + a 25-step browser journey.

### Added after the takeover audit (Credit Connect & differentiators)
- **Credit Connect:** consent-gated automatic import (provider adapter framework + dev-only sandbox) and a public REST API with
  scoped, hashed, revocable API keys (`POST /api/v1/clients/{id}/reports`, clients, disputes, OpenAPI). Live providers (Array, IDIQ,
  bureaus) are listed honestly as needing partner access — see `docs/CREDIT_CONNECT.md`.
- Reported-score history (real values only) for staff and the client portal; command palette (⌘K); white-label portal colour with
  guaranteed contrast.
- 30 more tests (210 total) and a 28-step browser journey.

### Client-first pass
- **Rename-ready:** the product name is defined once in `src/lib/product.ts`; the ~30 hard-coded occurrences across 25 files now read from it.
- **The portal belongs to the agency:** agency name + monogram + colour in the portal header; branded sign-in page at
  `/portal/login?org=<slug>` (link shown in Settings and included in every invitation; sign-out returns there); client invitation
  page branded too. Personal workspaces are never discoverable by slug. Software name reduced to a "Powered by" line.
- **Portal home:** one "Your next step" card (sign / upload / response under review / investigation under way with the real expected
  date / we're working on it / nothing waiting), the current stage explained, a "Your rights" card (free weekly reports, disputing for
  free, accurate information can't be removed, 30/45-day investigations, 3-day cancellation), message-your-specialist call to action.
- **Phones:** app-style bottom navigation; icon sign-out; wider State field.
- **Spanish:** dates and relative times are now localised (they were English).
- **Staff dashboard:** "Client care" queues — unanswered client messages, client uploads to review, clients with no update in 14+ days.
- **Landing page:** "Client experience" section with a clearly labelled sample-data illustration.
- 13 more tests (223 total); browser journey extended to 31 steps.

### Pilot-readiness pass
- **AI letter polishing rebuilt.** The old check compared sets of numbers and accepted a rewrite that swapped the Experian and
  Equifax balances, and another that renamed the creditor. Fact-bearing sentences (names, amounts, dates, account references,
  bureau names, citations, dispute statements) are now replaced by opaque markers before anything is sent to the model and
  restored server-side; a missing, repeated, reordered, altered or moved marker — or any factual wording added by the model —
  discards the rewrite and keeps the original. Staff see a before/after preview; nothing is saved until they accept, the
  accepted text is re-validated on the server, and it is saved as a draft that still needs approval.
- **`npm run jobs:run` works** (it pointed at a missing file). Scheduled jobs share one code path with `/api/jobs/run`, record
  every run in `job_runs`, roll back and report a failing organization without stopping the others, and are safe to retry.
- **Delivery records.** Submission captures method, date sent and an optional tracking reference, stored as a staff record and
  shown as "Recorded by staff"; "Confirmed by carrier" is reserved for a mail integration and cannot be set by hand.
- **Dashboard and navigation.** Overdue deadlines, letters awaiting approval and unanswered messages come first; one
  "New client" button; navigation grouped into Daily work / Tools / Business.
- **Integration status** is labelled by what works in the configured environment, with the manual path and the exact remaining
  dependency for live credit pulls, certified mail, payments, SMS and external e-signature.
- **Fixed:** portal clients got "not found" when downloading their own approved/sent letter (missing row-level policy).
- **Fixed:** the "Record submission" form was offered before a letter was approved or consents were recorded.
- New browser test `e2e/dispute-workflow.cjs` (11 steps, synthetic data) and 19 more automated tests (248 total).

### Client plan, monitoring link, read-as-report and audit fixes
- **Client plan:** a short action plan on the client profile, built only from that client's own records (reports, consents,
  findings, disputes, reported balances and limits). No AI and no score or outcome predictions.
- **Monitoring referral link:** an agency can set an https link to a paid credit-monitoring service in Settings; clients see it
  in the portal as a paid option, with the note that the agency may earn a commission. It is only a link — nothing is imported.
- **Read an uploaded document as a report:** a credit-report file already in the client's vault (for example one the client
  uploaded in the portal) can be read as a report without uploading it again. It goes through the same review and approval.
- **Audit fixes:**
  - One definition of "today": `APP_TIMEZONE` (default `America/New_York`) now decides sent-on dates, the "Date sent" default
    on the dispute and letter pages, task Overdue/Today grouping and the analytics overdue count. A sent date that is not in
    the past is recorded as now, never as a future time.
  - `x-forwarded-for` is read from the right (`TRUSTED_PROXY_HOPS`); staging/production refuse the `log` email driver;
    `/api/health` probe; error pages for the app and the portal.
  - A specialist's ordinary action no longer fails when it fires an automation (migration `0010`). The new insert policy is
    limited to the specialist's own organization's automations, undecided runs and the two states the engine writes.
    A specialist can still, at the database level, log a pending run that a manager must approve — approval remains the gate.
  - Refusals after a redirect (Team page, restoring a letter version) use fixed messages chosen by a short code; text from
    the URL is no longer shown. `?page=` on Disputes and Letters is limited to a whole number from 1 to 100,000.
  - Portal messages reach clients in their saved language; changing the language confirms in the new one.
- 302 automated tests in 21 files.

### Finishing pass
- **Enquiry form for new leads:** each agency gets a public, branded form at `/start/<slug>` (link in Settings). A submission becomes
  a lead with a follow-up task and appears under "New leads to contact" on the dashboard. Contact details only; consent to be
  contacted required; rate limited; honeypot; identical reply for emails already on file; personal workspaces excluded.
- **Draft several disputes at once:** tick findings on the three-bureau comparison and draft one dispute per finding, each with its
  reason written from that finding's evidence. They are drafts: review, approval and an approved letter are still required. Findings
  that cannot be drafted safely are skipped with the reason shown.
- **Fixed:** every form lost what the person had typed when it came back with an error (found by the browser journey).
- **Fixed:** score cards squeezed their dates into a narrow column on the client profile.
- 6 more tests (229 total); browser journey extended to 33 steps.

### Leads and automatic follow-up
- **Leads page** (`/app/leads`, in Daily work): the enquiry-form link plus ready-made tagged links (`?src=instagram`, facebook, tiktok,
  google, flyer, referral); counts from the database (enquiries this week, waiting for first contact, contacted, became clients) and
  by source; the list of open leads with search by name, 25 per page, "Convert to client" and "Mark not interested".
- **Source tracking:** `/start/<slug>?src=<tag>` stores a sanitised tag (`[a-z0-9-]{1,30}`) as the lead's source; without it the
  source stays "Website form".
- **Automatic follow-up email** to people who sent the form and agreed to be contacted: welcome, a follow-up after 2 days, a last
  note after 6. Off by default; an owner or admin switches it on and must save a postal address and a reply address first. It stops
  when the team messages the lead or logs a call, when staff press "They replied" or "Asked to stop" on the lead, when the lead
  becomes a client, or when they use the opt-out link in every email (`/unsubscribe/<signed token>`, no sign-in). **Email replies
  are not read by the system:** they go to the agency's reply address, so a reply stops the emails only once someone records it. Fixed EN/ES wording, checked by the claims guard. Each (lead, step) is sent once
  (`lead_outreach`, migration 0011); each send is recorded in Messages and the timeline.
- **Not connected means not sent:** with the `log` email driver nothing is sent and nothing is recorded as sent, and the Leads page
  says so. No SMS, no purchased lists, no scraping.
- The public enquiry form now has a title and description with the agency's name, so shared links preview as theirs.
- `sendEmail` accepts an optional `replyTo`. The dashboard's "New leads to contact" no longer drops a lead just because an
  automatic email went out.

- **Review fixes (same release):**
  - The page and every email no longer imply that replying stops the emails. Each email's footer says a reply reaches the team
    but does not stop the automatic emails, and the link does. New "They replied" (logs an inbound message) and "Asked to stop"
    (same effect as the opt-out link) buttons on each lead.
  - Sending is now claim → send → record: the step is committed as `sending` first, the email is sent with no transaction or row
    lock open, and the result is written afterwards. If the result is never written (crash, lost connection) the step stays
    `sending`, is shown as "not confirmed" and is **not** sent again, and nothing later is sent to that lead — one email can be
    lost, none duplicated. All stop conditions are re-checked under a row lock immediately before each claim.
  - The greeting uses only a plain first name (letters, apostrophes, hyphens, 30 characters); anything else typed into the public
    form becomes "Hi there". The From line shows the agency's name with the platform's sending address.
  - The welcome email is no longer sent inside the enquiry request (it runs after the response via Next's `after`; the scheduled
    job sends it if that is lost), so response time does not reveal whether an address was already on file.
  - A staff email that failed, or was only written to the log because no email service is connected, no longer counts as
    "contacted" and no longer stops follow-up.
  - A Leads page past the last page redirects to the last page with leads instead of showing "No open leads yet".
  - Not done: reading replies automatically (needs an inbound-email webhook). The Resend driver, including the new From name, is
    still untested against the live service.

### Credit guide (chat box)
- **Ask the credit guide** button at the bottom right of the client portal (above the phone bottom bar) and the staff app. It
  explains credit reports, disputes, timelines, collections, identity theft, CROA rights and where things are, in plain language
  (EN/ES in the portal), from a vetted knowledge base of 38 entries in `src/lib/guide/knowledge.ts`.
- Each reply has three parts: the knowledge-base answer; "For you right now" — up to three steps from the asker's own records
  (portal: only their client record; staff: the plan of the client page being viewed), loaded under row-level security; and links
  to existing screens. The guide explains and links; it performs no account action and stores no conversation.
- Works with no AI configured (deterministic keyword matcher; unknown questions get "I am not sure" plus topics). With
  `AI_PROVIDER` configured, the model may only re-phrase the retrieved entries: the question is sent as untrusted text with names,
  numbers, amounts and addresses masked; step text is replaced by generic labels; output is discarded for prohibited claims
  (English guard plus Spanish rules), any number or web address not in the entries, prompt markers, or excess length. Like the
  other adapters, this path is tested against a fake provider only, not a live service.
- Limits: 500 characters per question; 20 (portal) / 30 (staff) questions per 5 minutes per user. No new tables.
- **Review fixes:** AI-written wording is now also checked by stricter rules that need no number — any future-tense or promise
  wording about a score, a removal or an approval, and any suggestion to dispute accurate information, in English and Spanish
  ("this will raise your score", "su puntaje subirá", "even if it is accurate"). They are pattern rules, not a proof: they catch
  the phrasings tested, and a miss is still possible. A match only means the vetted text is shown instead. In the staff app the
  guide button is a 48px circle with no label, and the report review bar leaves room for it, so it no longer sits on "Approve
  report" (checked from the layout classes, not in a browser).

### AI credits (metered AI)
- **Nothing about AI is free.** Each AI result that is returned costs credits from the workspace's balance: letter wording
  suggestion 5, progress note polish 2, AI-worded guide answer 1 (`AI_COSTS`, `src/lib/ai/credits.ts`). With no credits, or
  no AI provider, the app uses its existing non-AI wording and tells staff why; portal clients just get the vetted answer.
- Migration 0012: `ai_credit_ledger`, append-only, balance = `sum(delta)`. Staff of the organization may read it; only the
  system connection can write. Credits are taken when the model is called (race-safe, per-organization lock) and given back
  if the call fails or its output is discarded by the safety checks.
- Wired into every model call: letter suggestion, staff and portal credit guide (portal questions use the agency's credits),
  and the progress note.
- **Changed:** the client progress note no longer calls the model when the Messages tab loads. The draft is built from the
  dispute data for free, and "Polish wording with AI (2 credits)" is a separate button — a page reload can never charge.
- AI assistant page: balance, price list, last 20 ledger entries (owners/admins). Balance shown beside "Suggest better wording".
- `npm run credits:grant -- <org-slug> <amount> [note]` for the platform operator (validated, audited). New workspaces start
  at 0. The demo seed adds 100 labelled sample credits.
- **Not connected:** buying credits online. The app says so, and Settings → Integrations lists it as a manual path.
- 24 new tests (`tests/unit/ai-credits.test.ts`, `tests/db/ai-credits.test.ts`): spend, refusal, concurrent spends,
  refunds, append-only, row-level security, the letter path with a fake provider, the guide on credits, the operator script.
- **Fixed after review (migration 0013):**
  - The press that spent the last credits on a progress note polish could lose the polished text, because the refreshed
    page removed the button that held it. The button now stays whenever a provider is connected.
  - A charge whose request died before a result, or whose refund could not be written, stayed charged. Charges are now
    reservations with a recorded outcome; the scheduled jobs refund any without one after 10 minutes, and a failed refund
    no longer hides the original error or claims "no credits were used". Staff and portal layouts set `maxDuration = 60`.
  - A paid letter suggestion existed only in the browser. It is now stored per letter version, shown again after a reload,
    and not charged twice for the same version. (The polished progress note is still not stored.)
  - Portal clients could spend the agency's balance with only a rate limit. AI wording in the portal guide is now off
    until an owner or admin turns it on (AI assistant → AI credits), and capped at 10 AI-worded answers per client per 24 hours.
  - 13 more tests for the above.

### Defects found and fixed in the client-first pass
- Disputes that were approved-but-not-mailed or on hold showed a **blank status** to clients (no portal text for those statuses); now
  covered by a test that every client-visible status has text in both languages.
- The portal's "Items sent" counted approved letters that had not been mailed; it now counts only items actually submitted.
- "Response expected by" showed for items that already had a response.
- Relative times showed "in <1m" for something created a moment ago (app/database clock skew).
- The new phone navigation bar was pinned to the header because the header's backdrop blur creates a containing block for
  fixed elements (caught by the browser journey; the bar now renders outside the header).
- Empty event lists rendered an orphan divider on dispute cards.

### Defects found and fixed during verification
- Checkboxes without a `value` submitted `"on"`: API-key permissions failed, and a dispute's "specific information to review" selection was silently dropped.
- Unchecked checkboxes failed validation on every form (found by the browser journey).
- `'use server'` files re-exporting constants crashed two pages (found by the browser smoke test).
- Audit-log immutability blocked deleting any user/organization (schema fix; offboarding test added).
- Cooldown windows could be violated across calendar-bucket boundaries (now a rolling window).
- Timestamps returned as `Date` objects contradicted the row types (driver now returns ISO strings).
- Audit events in one transaction shared a timestamp (now `clock_timestamp()`).
- Blocked-claims guard missed "we can remove accurate information".
- "Dispute progress" counted unsubmitted disputes.
- Parallel queries on one connection triggered a `pg` deprecation (queries are now serialised per transaction).
- Client portal upload gave no confirmation after the request row disappeared.
