# Changelog

## Review fixes to the five new features (unreleased, uncommitted)

Twelve reviewer findings on client updates, the dispute clock, the charge check and fall-off dates; all twelve were
real. Migrations 0018, 0019 and 0020 (none of them deployed yet) were edited in place and stay additive and safe to
run again.

- **Confirmed accurate means closed** (15 U.S.C. 1679b(a)(1)). Ticking "the client has confirmed this item is reported
  accurately" now also refuses another round and any new letter for that dispute, in the service and on the page.
  Before, the page still offered "Start round N+1".
- **Stop words** (47 CFR 64.1200(a)(10)). A reply containing stop, quit, end, revoke, cancel, unsubscribe or "opt out"
  anywhere, or a plain refusal ("no more texts", "no más mensajes"), revokes consent. This errs towards stopping. Any
  other reply pauses texts to that client until staff have read it on the client's profile.
- **A STOP is the client's to undo.** Staff can no longer record a consent over a STOP reply: refused in the app, the
  form is hidden, and a trigger on `sms_consents` refuses it for every connection (0018).
- **Quiet hours where the client is.** A workspace has its own time zone (Settings → Client updates), and a text is
  held unless it is 8 a.m. to 9 p.m. there and in every time zone of the state on the client's address; with no state
  on file, Eastern and Pacific both apply.
- **Replies cannot be pulled away by another workspace.** A reply goes to the client whose consent is in force for the
  number, then to the one texted most recently. What stays ambiguous is counted in the scheduled job's result.
- **"No response recorded" waits for the mail.** The no-response steps, the complaint summary and the client message
  start after the period end + 5 business days (15 U.S.C. 1681i(a)(6)(A)) + 7 days, not the day after the period ends.
- **Dates are the agency's days, not UTC days.** The legal clock, the 30/45-day check, the complaint summary and the
  dates written into letters no longer run a day ahead for anything recorded on a US evening; a letter's "I sent you a
  dispute on" uses the sent date staff recorded.
- **Citations and scope.** A 45-day period ticked at submission cites 15 U.S.C. 1681j(a)(3), not 1681i(a)(1)(B). A
  direct dispute with the furnisher is offered only for a dispute about an account on a report (12 CFR 1022.43(b)(1)).
- **Charge check.** The badge reads "No hold found" (it described the record, not the law). "Sold by phone" is now a
  three-way answer and starts unanswered (`clients.sold_by_phone` is nullable); until answered, the check says the
  phone-sale rule (16 CFR 310.4(a)(2)) was not considered.
- **Fall-off dates.** For an account that is only late, the line reads "Late-payment information from <date> is
  generally reportable until ...": the account itself keeps being reported.
- **Letters drafted before this release** are not held to the new specificity check (`letters.checks_version`, null on
  existing rows, 0019). A template of your own without `{{enclosures}}` gets the enclosures section added at the end.
  **If you have custom bureau templates:** new letters from them are still checked for the account number and a
  concrete reason; add `{{account_text}}` and `{{enclosures}}` where you want them to appear.
- **Not done:** no automatic text confirming an opt-out worded in free text (Twilio only confirms its own keywords).
  Nothing was sent through live Twilio or Resend.

## Protect your file: freezes, fraud alerts and opt-outs the client places personally (unreleased, uncommitted)

Migration 0022 (additive, safe to run again, no superuser): `clients.file_protections` (jsonb, default `{}`) and a
trigger that lets only the client write it, and only as option -> day. No table, no policy change.

- **Registry** (`src/lib/credit/protections.ts`): security freezes, fraud alerts, opt-outs, consumer statements and
  file disclosures for Experian, Equifax, TransUnion, Innovis, ChexSystems, Early Warning, LexisNexis, NCTUE and
  OptOutPrescreen.com. Each says in one sentence what it does and what it does not do (a freeze does not remove or
  correct information; an opt-out does not delete records), and is always requested by the consumer. A link, phone
  number or "Free" mark is stored only with the official page it was read on and the day (all read 2026-11-19).
  Not confirmed, so not stored: an Early Warning freeze, a ChexSystems page for consumer statements, bureau phone numbers.
- **Portal** (`/portal/protect`, English and Spanish, linked from the portal home): the options by agency with the
  official links and a tick "I placed this on <date>". The agency never submits these and no agency login, PIN or
  password is collected (a freeze is requested directly by the consumer, 15 U.S.C. 1681c-1(i)(2)).
- **Staff**: "Freezes, alerts and opt-outs" on the client's Reports tab shows the client's ticks, read-only. The
  database refuses a tick from staff.
- **Credit guide**: the freeze and fraud alert entries now say what they do not do and link to the page; new entries
  for the prescreen opt-out (15 U.S.C. 1681b(e)) and for freeze vs fraud alert vs opt-out vs dispute.

## Work statement, charge check and evidence pack (unreleased, uncommitted)

Migration 0020 (additive, safe to run again, no superuser): `clients.sold_by_phone` (nullable = not answered, staff-only by
trigger) and two narrow read functions, `app.client_document_reviews` and `app.client_portal_signins`. No table, no
policy change. The statement is never stored; it is built on request from existing records.

- **Work statement** (`src/lib/billing/statement.ts`): per client and month, from records only: letters sent (date,
  recipient, method, tracking reference, "recorded by staff" or "confirmed by carrier"), letters approved, responses
  with the outcome as recorded, documents reviewed, messages sent and received, and what is waiting on whom today.
  Staff: "Work statement" on the client record (`/app/clients/[id]/statement`, prints cleanly). Client: "What we did
  for you" in the portal (`/portal/statement`, English and Spanish), linked from the portal home. A month with no
  records says "No work is recorded for this month."
- **Charge check** (`src/lib/billing/eligibility.ts`, pure): "Eligible to charge" only when a signed service agreement
  is in force and its 3-business-day cancellation period has ended (15 U.S.C. § 1679e(a)), at least one letter is
  recorded as sent in the work period on or before the charge date (15 U.S.C. § 1679b(b)), and the client is not
  cancelled. Otherwise "Hold" with the reasons. Shown on the client's Billing tab above "Record a payment". Recording
  a payment on hold needs a confirmation; the acknowledgement and the reason codes go to the audit log
  (`payment.recorded`). The server re-runs the check, so a stale page cannot skip it.
- **Sold by phone**: a checkbox on the Billing tab. It adds a caution citing the Telemarketing Sales Rule
  (16 CFR 310.4(a)(2)) to review with counsel. It is not a legal determination.
- **Evidence pack** (`/app/clients/[id]/evidence`, settings or billing access, prints cleanly): signed agreements and
  disclosures with timestamp, typed signature and IP; the cancellation notice acknowledgement if one is on record;
  letters sent; the communications log; portal sign-in dates; payments recorded.
- **Business days** (`src/lib/business-days.ts`): the one import point for business-day arithmetic. It re-exports the
  holiday table and helpers from `src/lib/disputes/clock.ts`, so there is still a single table.
- **Changed**: the new-plan form on Billing no longer preselects "Monthly"; the person chooses. Billing states that
  pricing and billing practices are the agency's responsibility. No fee model is built or recommended.

## Reinsertion watch, date-of-first-delinquency check and fall-off dates (unreleased, uncommitted)

No migration: the existing `findings`, `tradelines` and `public_records` columns hold everything (0021 is unused).

- **Reinsertion watch** (`src/lib/disputes/reinsertion.ts`): when findings are regenerated (a report is approved, a
  line is edited, or "Re-run analysis"), the newest approved report of each bureau is checked against bureau disputes
  recorded as deleted. A finding "Possible reinsertion" is created when the same client, same bureau and exact match
  key (creditor plus account last 4) appears on a report dated after the response was recorded. It states both facts
  and asks staff to check whether the client received the written notice (15 U.S.C. § 1681i(a)(5)(B)). It does not
  say a violation occurred. One finding per deleted dispute; "Start dispute" works as for any finding.
- **Fall-off date** (`src/lib/credit/reporting-period.ts`, 15 U.S.C. § 1681c): 7 years from the reported date of first
  delinquency; for collections and charge-offs the 7 years start 180 days after it; bankruptcies 10 years from the
  filing date. Shown as "Generally reportable until <date>" on negative items in the report review and the
  three-bureau comparison, or "Fall-off date not available" when the report gives no date. The client's Reports tab
  lists "Aging off within 12 months" (hidden when empty). No score is predicted anywhere.
- **Date mismatch**: the cross-bureau date-of-first-delinquency finding now needs the account's last 4 and says the
  dates differ and should be checked against the client's records. New: a collection whose date of first delinquency
  is later than the one on the original creditor's account (same bureau, exactly one candidate account).
- **Changed**: the "older than 7 years" finding now uses the same arithmetic, so a collection or charge-off is flagged
  only after 7 years plus 180 days. "Charged off" (with a d) is now recognised as negative.

## Legal clock, optional next steps and letter specificity check (unreleased, uncommitted)

Every deadline on a dispute with a credit bureau or specialty agency is now computed in one pure module with its
section of 15 U.S.C. § 1681i beside it. Migration 0019 (additive, safe to run again, no superuser): outcome
`frivolous`; `disputes.more_info_on`, `investigation_completed_on`, `frivolous_missing`, `client_confirmed_accurate`;
`letters.received_on`, `reply_due_on`, `reply_received_on`.

- **Legal clock** (`src/lib/disputes/clock.ts`, shown on the dispute): 30 days from receipt; up to 45 when staff record
  "client sent more information on <date>" (only a date inside the first 30 days); written results due 5 business days
  after a recorded completion date. Business days skip weekends and the federal holidays for 2025 to 2030 (OPM). The
  45-day tick at submission stays as the manual choice (for example a dispute that follows a free annual report).
- **Optional next steps** after "verified as reported": a request for the description of the reinvestigation
  procedure (a normal draft letter, English and Spanish, with a 15-day clock once it is recorded as sent), a consumer
  statement, the client's own direct dispute with the furnisher, and the client's own CFPB complaint with a plain
  summary of recorded dates. Each says what it is and is not. Nothing is automatic, and nothing is offered once staff
  record that the client confirmed the item is accurate.
- **No response recorded by the deadline**: the same block asks staff to check the mail and portal first, then offers a
  follow-up for the results, the direct dispute and the complaint. It describes the record and asserts nothing else.
- **Specificity check**: a bureau or specialty dispute letter cannot be sent for approval, or approved, until it names
  the account with a masked number or reference, states what is disputed, gives a concrete reason and lists its
  enclosures or says "none". The letter page lists what is missing. Drafted letters now list accepted identity
  documents as enclosures, or "Enclosures: none".
- **Frivolous or irrelevant notice**: staff type what the agency said was missing; that becomes a task and a document
  request the client sees. Portal outcome text added in English and Spanish.

## Client updates by text message and email (unreleased, uncommitted)

Clients can be told by text and by email that there is something new in their portal. Off everywhere until switched on.
Migration 0018 (additive, safe to run again, no superuser): `sms_consents`, `client_updates`, `sms_inbound`, an index
on client phone digits, and the inbound-message trigger now says "text message" for a text.

- **SMS driver** (`src/lib/sms.ts`): `SMS_DRIVER` = `disabled` (default), `twilio`, or `log` (development and test
  only; refused in staging and production). Twilio is called with `fetch`; no new dependency. It never throws.
- **Consent.** A client turns texts on or off in Portal → Profile (English and Spanish). The exact wording shown, the
  number, the time and the source are stored. Staff can record a verbal consent only with a note, and it is labelled
  "Recorded by staff". Records are revoked, never edited. No consent in force for the number on file: no text.
- **Six events**, each with a text and an email in both languages: dispute sent, response recorded, document needed,
  document rejected, investigation window passed with no response, new message from the team. A text never names an
  account, an amount or a result. Settings → Client updates has a switch per event and channel; a channel that is not
  connected shows why and cannot be switched on.
- **Rules.** One message per client, event, subject and channel; 3 texts and 6 emails a day per client; texts held from
  9 p.m. to 8 a.m. (`APP_TIMEZONE`); sent after the triggering request finishes or by the scheduled job. Every attempt is
  on the client's Messages tab with its status and provider id; failures are listed in Settings.
- **Twilio webhook** `POST /api/webhooks/twilio`: signature-verified, rate limited. STOP revokes consent; START does not
  restore it; other replies are saved on the matching client or kept unmatched for review.
- **Scheduled jobs** now run twice a day on Vercel (09:00 and 17:00 UTC), because the 09:00 run is inside quiet hours.
- **Docs:** Twilio and Resend setup steps in `docs/INTEGRATIONS.md` and `docs/DEPLOY-VERCEL.md`. No calls, no dialer.
- **Not verified:** nothing was sent through the live Twilio or Resend services. The Twilio request, signature and
  keywords follow its documentation (signature checked against the documented example). Delivery right after a request
  (Next.js `after`) was not exercised in a running server; the scheduled job path is covered by tests.

## Review fixes for agency websites, intake documents and specialty agencies (unreleased, uncommitted)

- **Website claims check rewritten.** It no longer deletes text before checking. A guarantee word (English, Spanish,
  and the "guarentee" misspelling) passes only when a negation directly governs it ("no result is guaranteed", "we
  cannot guarantee", "nadie puede garantizar"). Removal claims are matched as a removal verb near a negative item, in
  either order. Added: improve/better/higher score wording, "within / as few as / N-day" results, promises and
  money-back offers, no-cost wording, "qualify for", tradelines for sale. "Free credit consultation" and "Free
  15-minute call" are now accepted. It is still a safety net, not a legal review.
- **Business name** is checked when a site is published, and renaming to a prohibited claim is refused while it is.
- **Unpublish** is a direct write that validates nothing and never rewrites the saved text.
- **Database backstops.** 0015: a client's own upload must start unreviewed (`documents_self_insert`). 0017: the portal
  guard trigger also covers `clients.banking_concern` and `specialty_reports`. 0015 now widens the kind lists instead of
  rewriting them, so it is safe to run again after 0017.
- **Specialty letters.** ChexSystems, NCTUE and Early Warning: what each agency's page says a mailed dispute must carry
  is quoted on the new-dispute step, the dispute and the letter, with the page and date. The letter has marked lines
  for date of birth and Social Security number (ChexSystems, NCTUE) or the consumer ID (Early Warning, a new optional
  item field); the app never fills these in and the letter cannot be approved until a person does. The
  identity-document warning and the "Enclose with this letter" list now apply to specialty disputes too.
- **Addresses.** LexisNexis no longer has a stored dispute address (its page could not be opened in review), so staff
  type it. TransUnion now cites its dispute-by-mail page; Equifax cites the Experian page that prints its address.
- **Not confirmed:** nobody re-opened the TransUnion page behind the "two months" proof-of-address advice; it is marked
  as such in `src/lib/intake.ts`. The agency pages could not be opened from the build environment at all, so the
  ChexSystems, Early Warning and NCTUE addresses and quotations rest on the review, not on a second reading.

## Specialty reporting agencies (unreleased, uncommitted)

Disputes are no longer limited to the three credit bureaus. Migration 0017 (additive): `disputes.agency`, `agency_item`
and `recipient_address`; `agency` added to the dispute target types and `specialty` to the workflows;
`clients.banking_concern` and `specialty_reports`; document kind `specialty_report`. The `disputes.bureau` column and its
three-bureau check are unchanged, so every existing dispute, report, comparison and count behaves as before.

- **Registry** (`src/lib/credit/agencies.ts`): the three bureaus plus ChexSystems, Early Warning, LexisNexis, Innovis,
  NCTUE, TeleCheck and Clarity Services: what each reports, how to request the free disclosure, and the dispute address.
  An address is stored only with the official page it was read on and the date; where the agency's page does not state
  one, none is stored and staff type it in. Nothing is prefilled from memory.
- **Staff:** New dispute gains "Enter a specialty agency item": agency, the item as it appears on the disclosure, and a
  required reason. It then runs through the same draft, review, approval, letter, submission, 30-day window and outcome.
- **Letters:** one specialty template per kind of agency, in English and Spanish. It states only what was entered, refers
  to the right to dispute under the FCRA in general terms and asks for a reinvestigation and a written result.
- **Client record:** a "Specialty reports" block on the Reports tab (how to request each free report, a status staff set,
  the received file) and a "banking or background-screening concern" tick box. These reports are not read by the system.
- **Portal and guide:** specialty items appear in the client's items list with the same statuses and day meter and a
  one-line "About" for the agency; the guide gains entries on ChexSystems / Early Warning and LexisNexis (EN/ES). The
  client plan suggests requesting the ChexSystems and LexisNexis reports only when the concern box is ticked.
- No data feed from any of these agencies exists; see docs/INTEGRATIONS.md.

## Identity document intake (unreleased, uncommitted)

The identity documents a credit bureau normally asks for with a mailed dispute are collected from day one. Migration
0015 (additive): `documents.review_note`, `doc_date`, `expires_on`, and three more document kinds (`previous_address`,
`name_change`, `power_of_attorney`).

- **One definition** (`src/lib/intake.ts`): photo ID, proof of current address, proof of Social Security number, each
  with what counts and plain tips in English and Spanish; five "only if this applies" items that are never required.
  The bureaus' own instructions are cited in the file. Status per client is computed from real documents: missing,
  awaiting review, accepted, rejected (with the reason), expired or no longer recent (only from a date a reviewer recorded).
- **Portal:** "Your documents checklist" at the top of Documents, with progress and one upload button per item that opens
  the existing upload form with the type chosen. The portal home next step points to it after agreements and named requests.
- **Staff:** an "Intake documents" block on the client's Documents tab: accept (optionally recording the expiry or
  document date), reject with a reason the client sees, and "Ask the client for the missing ones" (ordinary document
  requests; no email is sent). The client plan gains "Collect identity documents".
- **Sending:** recording a bureau dispute as sent without accepted identity documents shows a warning and needs
  "Send without the identity documents" ticked. It is a confirmation, not a block, and is noted on the dispute.
  The consent and approved-letter gates are unchanged.
- **Letters:** an approved letter to a bureau lists "Enclose with this letter" from the accepted documents. Nothing is
  attached to the PDF.
- e2e: `journey.cjs` and `dispute-workflow.cjs` tick the new confirmation before "Record submission".

## Agency websites (unreleased, uncommitted)

Every agency workspace can publish its own public website, hosted by the app at `/a/<workspace-slug>`. No migration:
the content is one key (`website`) in `organizations.settings`, so the existing tenant policies decide who may edit it.

- **Public site** (`src/app/a/[slug]`): the agency's name, mark and brand colour; hero, services, the fixed "how it
  works" steps, about, questions, contact details and the enquiry form (same `submitLead` checks; source `website`);
  a "Client sign in" link; and a fixed footer with the required notices, the agency's name and mailing address.
  English, or Spanish with `?lang=es` (fixed copy is translated; the agency's own text is shown as written).
- **Editor** at `/app/website` (owners and admins, agency workspaces): plain text with length limits, starter text,
  publish/unpublish. An unpublished site answers "page not found".
- **Claims check on save** (`findMarketingClaims` in `src/lib/compliance/claims.ts`): promises of results or removal,
  quoted scores, timed results, approval promises and "free" offers other than a first consultation are refused, in
  English and Spanish, with the field and the reason. The existing guard for system-generated text is unchanged.
- **SEO**: per-site title, description, canonical and Open Graph; `ProfessionalService` and FAQ structured data with
  only the fields provided; published sites listed in `/a/sitemap.xml`, which `robots.txt` now names next to
  `/sitemap.xml`.
- **Leads page** offers the published site first; the enquiry-form links stay. `/start/<slug>` links back to the site.
- **Not built:** custom domains (listed as manual under Settings → Integrations) and a per-agency link-preview image
  (previews use the app's default image).

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
