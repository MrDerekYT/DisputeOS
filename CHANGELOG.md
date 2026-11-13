# Changelog

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
