# Security & compliance

This application handles sensitive financial and identity information. This page says what is enforced, where, how it
was verified, and what is **not** done. It is engineering documentation, **not legal advice**.

## Security controls

| Control | Implementation | Verified by |
|---|---|---|
| Tenant isolation | PostgreSQL row-level security on every table; tenant requests run as role `disputeos_rls` | 24 RLS tests (cross-org read/write/reassign, role tiers, portal isolation, no-membership user, every table has RLS on); browser journey with a second business |
| Client sees only own records | RLS policies keyed to `portal_user_id`; column guard trigger limits portal edits to phone/address/language, plus date of birth and SSN written once while empty (never changed or shown back afterwards) | RLS tests; guard tests (`tests/db/portal-guard.test.ts`, `tests/db/welcome-intake.test.ts`); journey (client redirected away from `/app/*`) |
| Authentication | scrypt (N=2¹⁵), constant-time compare, dummy hash for unknown emails, lockout after 5 failures, per-IP and per-email rate limits | auth tests |
| Two-step verification | TOTP (RFC 6238), replay-proof; optional by default, **mandatory for staff when `REQUIRE_STAFF_MFA=true`** | RFC test vectors; auth tests; browser MFA setup |
| Sessions | random 256-bit token, only its hash stored; HttpOnly, SameSite=Lax, Secure on https; absolute + idle expiry; revoked on password change/reset | auth tests; journey (old cookie rejected after sign-out) |
| RBAC | owner/admin/manager/specialist/client permission map + DB role tiers; nobody can mint an owner; admins can't create admins | unit + RLS tests |
| Secrets & secret leakage | all secrets from env, validated at boot per environment; production rejects dev keys / http URLs; password hashes & TOTP secrets unreadable by tenant queries | env tests; RLS "secrets not reachable" tests; boot check |
| Encryption at rest | SSN/DOB/TOTP secrets and every stored file are AES-256-GCM encrypted with key rotation support; account numbers are never stored (last 4 only) | unit tests; on-disk inspection after a real upload |
| Encryption in transit | HSTS + `upgrade-insecure-requests`; the database connection uses TLS with the server certificate verified for any host that is not this machine (`DATABASE_CA_CERT` for a private CA); `sslmode=disable` turns it off and is only for a private-network database (refused on Vercel) | unit tests (`tests/unit/deploy.test.ts`); config |
| Upload safety | type from file **contents** (magic bytes), size cap (`MAX_UPLOAD_MB`: 10 MB by default, 4 MB on Vercel), sanitised names, extension/MIME ignored; download served `nosniff` + sandbox CSP | unit tests; journey (disguised executable rejected) |
| Web hardening | nonce-based CSP (no `unsafe-eval`), frame-ancestors none, nosniff, referrer & permissions policies; parameterised SQL everywhere; React escaping | production headers inspected |
| Audit log | append-only (trigger-enforced, even for the privileged connection); no FKs so user/org deletion never blocks it; no PII in metadata | RLS + offboarding tests |
| Rate limiting | Postgres-backed fixed windows (works across serverless instances) on sign-up, login, reset, MFA, invites | auth tests |
| Client invitations (welcome link) | single use, 7 days, only the token's hash stored; a new link ends the client's earlier unused ones; a link works only while it was made for the client's email as it is now (compared without case or surrounding spaces), so a link sent to an address staff corrected or cleared cannot be used, and the invitation page says so; an email that already has a client portal with another agency gets a plain, translated refusal and nothing is changed; the Welcome link card shows the address a live link was made for and, once the client joined, the email their portal account signs in with | `tests/db/welcome-intake.test.ts`, `tests/db/intake-gates.test.ts`, `tests/db/intake-portal.test.ts` |
| Data retention & deletion | per-client export (JSON) and hard delete with typed confirmation; retention report in Settings; a client whose signed Consumer Credit File Rights statement is less than 2 years old cannot be deleted (checked by the app and by a database trigger; mark the client cancelled instead; not in a personal workspace) | `tests/db/welcome-intake.test.ts`, `tests/db/intake-gates.test.ts`; manual/UI |

**Operational requirements you must meet:** put the app behind a TLS-terminating reverse proxy that **appends
the connecting address to (or overwrites) `x-forwarded-for`** — nginx `$proxy_add_x_forwarded_for`, AWS ALB, Vercel,
Fly and most load balancers do. Per-IP rate limits and audit-log IPs use the entry that proxy wrote: counting from the
right, entry number `TRUSTED_PROXY_HOPS` (default `1` = one proxy; use `2` for CDN → load balancer → app). The leftmost
value, which the browser controls, is never trusted. Setting the number higher than the real number of proxies lets a
caller choose their own "IP", so do not guess; never expose the app port directly to the internet (without a proxy the
header is whatever the caller sends). `x-real-ip` is only read when there is no `x-forwarded-for`. Route-handler
downloads and search (`/api/documents`, `/api/letters/*/pdf`, `/api/consents/*/pdf`, `/api/clients/*/export`, `/api/search`) require a session
that has completed two-step verification, the same as pages; keep `PII_ENCRYPTION_KEY` in a secret manager and back it up separately; use a persistent,
access-controlled volume for `STORAGE_DIR`; enable database backups and encryption at rest at your provider.

**Known gaps:** no malware scanning of uploads; no OCR; the `fs` storage backend only (no S3); recovery codes for
lost authenticators (an admin can reset a teammate's factor, owners cannot be reset); key re-encryption job after
rotation is not built; no Sentry/observability wiring (a PII scrubber exists in `src/lib/scrub.ts`); no formal
penetration test or SOC 2 audit has been done.

## Legal & regulatory posture (design, not determination)

DisputeOS enforces *workflow* rules that follow from these laws. It cannot determine whether your business is
compliant; state requirements vary and change. **Consult a consumer-finance attorney before onboarding real clients.**

| Law | What the product does | What you still need |
|---|---|---|
| **CROA** (15 U.S.C. § 1679) | The § 1679c statement, the § 1679d(b)(4) statement and the § 1679e(b) Notice of Cancellation are the statute's wording, tested word for word against the U.S. Code text; the statement is its own document and is signed before the contract; the contract is built from the agency's saved terms (§ 1679d(b): payment terms and the total, a full description of the services, a time estimate, name and principal address) and cannot be signed until they are saved; every portal signature stores the exact text shown and its SHA-256, and a paper signature recorded by staff the date on the paper and the app's text on the recording day, labelled as such (see below); **no dispute can be recorded as submitted and no letter as sent** unless the statement, the contract and the authorization are in force (a contract the client cancelled is not), the 3-business-day cancellation period is over, and the sent date is after it; clients can cancel from the portal while it runs; the signed statement is kept 2 years; payments require confirming services were already performed (no advance fees). A personal workspace (someone repairing their own credit) is no credit repair organization: none of these CROA steps apply there | Attorney review of the whole agreement and of your terms; state rules (registration, bonding, a longer cancellation period, required wording) |
| **FCRA** (15 U.S.C. § 1681) | Disputes are tied to a specific item and reason; 30-/45-day investigation clocks counted from receipt; findings say "differs / may warrant review", never "inaccurate"; round 2+ requires new information (frivolous-dispute guard) | Truthful disputes only; permissible purpose for any report pull |
| **FDCPA** (15 U.S.C. § 1692) | Validation-request template restricted to collection accounts; explains the 30-day window; cease-communication template notes it does not erase a debt | Applies to collectors; confirm applicability |
| **State CSO / credit-services laws** | Operator state captured; sign-up and settings remind about registration/bonding | Registration, surety bond, state-specific contract terms (e.g. Florida) |
| **Privacy / consumer protection** | Minimised storage (last-4 only, encrypted identifiers), data export & deletion, role-based access, audit trail | Privacy policy, state privacy-law obligations, breach-notification process |
| **FTC Act / advertising** | A blocked-claims guard rejects guarantees, promised deletions, score promises, "new credit identity/CPN" language in AI output, automations and templates, and warns on staff-written text | Your own marketing must comply too |
| **TCPA** | Texts go only to a US number with the client's own consent in force (the exact wording shown, the number, time and IP are stored; staff may record a consent given outside the portal only with a note); STOP is honoured and only the client can undo it; quiet hours; consent kind `communications` covers email and the portal | Attorney review of the consent wording; carrier registration of the sending number |

### Client agreements: what is signed, what is recorded

- **The documents, in the order the server enforces in the portal:** (1) consent to electronic records and signatures,
  with the disclosures of 15 U.S.C. § 7001(c)(1) (which records, free paper copies and how to ask, withdrawing consent
  and what follows, keeping the email address up to date, what hardware and software is needed); the client confirms
  they can read the page and opened its PDF copy; (2) the "Consumer Credit File Rights Under State and Federal Law"
  statement (§ 1679c), acknowledged as received and read; (3) the service agreement; (4) the authorization to review
  reports and dispute, naming the agency. Two optional consents (communications, data use) can be signed any time.
  Staff can record a signature the client gave on paper, with the date written on the paper (required; not in the
  future, not more than a year back): the statement → contract → authorization order still applies; paper needs no
  consent to electronic records, and staff can never record that consent (the app and a database constraint refuse it:
  § 7001(c)(1)(C)(ii) asks for the client's own electronic consent). Withdrawing that consent does not stop the service
  (paper from then on).
- **The signing order counts only current signatures where it matters:** a statement counts only in its current version
  with its text stored, and the consent to electronic records only in its current version, given by the client in the
  portal. So a client whose service agreement was signed on the 2026-01 reference drafts (a placeholder without terms or
  a Notice of Cancellation; the old statement was not the full statutory text) is asked for the current statement before
  a new agreement. Staff see such signatures flagged on the client page and the Welcome link card, with what to do:
  revoke them, then have the client sign the current ones (welcome link, portal, or a new paper signature). The one
  function for the order is `agreementProgress` in `src/lib/agreements.ts`; the portal's welcome steps use it too.
  While the statement, the service agreement and the authorization are in force (any version), the portal asks for
  what is left (the consent to electronic records, or the current statement) without saying that work cannot start, an
  investigation under way keeps the first card of the portal home, and a consent to electronic records the client
  withdrew is not asked for again (`src/lib/onboarding.ts`).
- **The service agreement** carries the parties, the date, the agency's services, payment terms with the total of all
  payments, the time estimate, a fixed no-guarantee paragraph (no promise of removal or of a score change; accurate,
  current and verifiable information cannot be removed), a sentence that no payment is asked for or accepted before the
  service is fully performed (§ 1679b(b)), the agency's additional terms, then in bold the § 1679d(b)(4) statement right
  above the signature and the Notice of Cancellation with the agency's name, address and the last day filled in. The
  principal business address is meant to be the street address of the agency's main place of business; a PO Box is
  accepted, and the Settings hint asks the agency's attorney to confirm its state's rules.
- **The agency's terms are checked when saved** (`termsIssue`, `src/lib/compliance/agreement-terms.ts`): every field goes
  through a claims check for contracts (`findContractClaims`: promises of removal or deletion, counts of items removed,
  removal or results in a set time, a "clean" report, guarantees, score promises and numbers, loan approval, tradelines,
  new credit identities, offers to dispute accurate information) and an advance-fee check (`findAdvanceFee`, § 1679b(b):
  a deposit, retainer, prepayment or setup, enrollment or sign-up fee; payment at signing, on the day or at the time of
  signing, within hours or days of signing or of the effective date, on the effective date, today, up front or in
  advance; payment before the work starts or before the first letters are sent; billing at the start of a month for that
  month's work). An honest negation, disclaimer or request passes ("we cannot guarantee that any item will be deleted", "we
  ask the bureaus to correct or delete information that cannot be verified", "there is no setup fee", "charged at the end
  of each month for the work fully performed that month"). The removal rules count only when what is removed is on a
  credit report (negative items, collections, accounts or items on a credit report, anything "from your credit report"),
  so the agency can state how it deletes its own records ("when you close your account, we delete your documents within
  30 days"). Both checks are lists of rules that catch the common wordings, not a legal review; the Settings hints say
  so. Terms saved before a check existed no longer build an agreement, and Settings says what to change.
- **A client's own payment terms and total** (`clients.agreement_payment_terms`, `agreement_total_cents`, migration
  0031): for an agency with several plans, an owner, admin or manager sets them on the client page (Agreement payment
  terms) before the client signs, and that client's agreement states them instead of the agency's (§ 1679d(b)(1)). They
  are checked like the agency's payment terms. The card shows staff the figures the client will see (and the billing
  plan, for those who can see billing), then, once signed, the figures read from the stored agreement. They cannot
  change while a service agreement is in force: the app and a database trigger refuse it (staff revoke the agreement,
  set the new figures and the client signs again), and a portal client can never change them.
- **What is recorded with each signature** (`client_consents`, migration 0031): a text (title and body as one
  string), its full SHA-256 (the database checks that it is the hash of that text), the language of the page, the
  typed name, the time, the IP address and browser, the day the client signed (`signed_on`) and, for a service
  agreement, the last day of its cancellation period as its Notice states it (`cancellation_ends_on`). For a portal
  signature the text is exactly what the client was shown: the signing page posts the hash of the text it displayed;
  the server builds the text again and refuses when it differs ("This agreement changed since you opened it"), which
  also covers terms edited meanwhile and a date that rolled over at midnight. For a paper signature recorded by staff,
  `signed_on` is the date written on the paper, `recorded_by` the staff member, and the stored text is **the app's text
  of the document on the day it was recorded, not a copy of the paper the client signed**, dated with the date on the
  paper (a service agreement's date line and the last day its Notice of Cancellation states are counted from it): keep
  the signed paper (or upload a scan under Documents). In a personal workspace the account holder gives their own
  authorization in the app: no paper date is asked for, and the record, its PDF and the evidence pack say it was given
  by the account holder, with no paper wording. A revoked row says why (`revoked_reason`: `client_cancelled` from the
  portal, `staff` from the client page). Signatures made before this change keep their version string and have no
  stored text.
- **Copies:** `/api/consents/<id>/pdf` (staff of the agency and the client, under row-level security) prints the stored
  text and the signature block; for the contract the Notice of Cancellation follows twice, each on its own page
  (§ 1679e(b) "in duplicate"), and the § 1679d(b)(4) statement and the notice are set in bold. A portal signature's copy
  is titled a signed copy. A paper signature's is titled and introduced as the app's text when the paper signature was
  recorded, not a copy of the paper, with the date written on the paper; the evidence pack labels it the same way, and
  so does the client's portal (the welcome page lists such documents under "Signed on paper", apart from the copies of
  what the client e-signed, and Profile calls each the app's text of the paper agreement recorded on its day, in English
  and Spanish). The
  PDF uses the standard Helvetica font, which cannot print some characters (a name such as "Nguyễn Thị Hương", or "→" and
  "™" in the agency's terms): they appear as "?", and the copy (and the reading copy before signing) then says so at the
  top. The fingerprint is always labelled as the SHA-256 of the stored text, which is exact.
- **The cancellation period** runs through the 3rd business day after the day of signing, weekends and federal
  holidays skipped (the 5 U.S.C. § 6103 holidays on their observed days, computed by rule for any year, the same rule the
  dispute clock uses), on the agency's own calendar day (Settings → Client updates → time zone). For a paper agreement it
  runs from the date written on the paper, as § 1679e(a) counts it from the date of the transaction, however late staff
  record it: an existing client's agreement signed months ago has no cancellation period left, and a letter really sent
  after the paper's 3 business days can be recorded with its true date. Its last day is stored when the agreement is
  signed, and the app always uses the later of that day and the day counted again, so a later change of the agency's
  time zone never ends it before the day the client's Notice states. The evidence pack and the charge check count on
  the agency's day too.
- **No service without an agreement in force** (§ 1679d(a)): a dispute cannot be recorded as submitted, and no letter
  (a stand-alone letter, or a follow-up or method-of-verification letter on a submitted dispute) can be recorded as
  sent, unless the statement, the service agreement and the authorization are in force and the cancellation period is
  over; a sent date before the agreement was signed, or on or before the last day of its period, is refused with the
  dates named, asking for the date it was really sent.
- **Cancelling:** while the period runs the client can press "Cancel my agreement" in the portal: their written notice
  ("I hereby cancel this transaction", the date and their typed name) is posted to their specialist and the contract is
  revoked by the database function `app.cancel_own_contract()` (it can only touch the caller's own agreement), which also
  records `revoked_reason = 'client_cancelled'`, sets the client's status to Cancelled and notifies the agency's owners,
  admins and the assigned specialist. From then on nothing is recorded as sent for the client unless they sign a new
  agreement. The client is then taken to their portal home, which (like the welcome page, Profile and the staff Welcome
  link card) shows, from the records, the day they cancelled, that their notice was sent to the agency, and the copy of
  the cancelled agreement. Nothing more is asked of them as a next step; signing a new agreement stays possible from
  Profile. After the period only a message to the specialist is offered. When a client who cancelled signs a new
  service agreement (in the portal, or on paper recorded by staff), the database function `app.client_signed_again()`
  sets their status back to Active (unless staff set another status since), adds a line to the timeline and notifies
  the owners, admins and the assigned specialist (not the staff member who recorded it); the new agreement's own
  cancellation period then applies.
- **Retention:** a signed statement is kept 2 years (§ 1679c(c)); deleting the client before then is refused with the
  date it becomes possible (not in a personal workspace, which has no such duty).
- **Personal workspaces** ("I am repairing my own credit"): there is no credit repair organization and no contract with
  oneself, so disputes and letters are not gated by these documents, there is no cancellation period and no 2-year
  deletion block, Settings has no Client agreement card, the client page has no Welcome link or Agreement payment terms
  card and asks for no CROA document (nor does New dispute, and a statement or agreement on file from the 2026-01 drafts
  is not flagged), and the statement and service agreement cannot be recorded there. The person records their own
  authorization (for automatic report import) with no paper date, labelled as given by the account holder.

**Human approval before external communication:** letters need a manager's approval of the exact text (edits void the
approval); the facts a letter rests on (a recorded response, a collector's 30-day period, accepted documents, the client
confirming an item is accurate) are checked again when it is sent for approval and when it is approved, and a letter
whose facts changed must be drafted again; automations that message clients wait in the Inbox; the system never mails or
emails a dispute itself — a person sends it and records that they did.

**The AI never fabricates:** it works only from stored report data; an LLM may reword but its output is discarded if any
number/date changes or the claims check finds a prohibited claim. A polished progress note is also discarded, and not
charged, unless its two reworded courtesy sentences use only words from a fixed list of courtesy words, none of which
names a result, a score, an approval, a prediction or a feeling (the list is in docs/INTEGRATIONS.md). A credit-guide
answer worded by AI is discarded, and the vetted entry shown, when a pattern rule finds a promise or a prediction of a
result: a pattern match, not a proof. The AI does not assert identity theft; every output is an editable draft with its
supporting evidence shown. What leaves the server for the AI provider: a letter's connective lines only (every
line with a name, address, account, amount, date or dispute statement is replaced by a marker), a progress note's
connective sentences only (never the client's name or the counts), and a credit-guide question with these masked: the
client's own address lines, city, ZIP code, SSN last four and date of birth as they are on file; the names the app
knows; and, by pattern, email addresses, phone numbers, Social Security numbers (9 digits, or 3-2-4 groups split by
spaces, dashes or dots), card and account numbers, dates, street addresses written with a common street type,
city-state-ZIP lines and amounts. Masking works by matching, so other words typed into a question are sent as written: an address,
name or city the app does not hold and that is written another way (an address with no street type, for example), or
in the client portal a creditor's name. Details: docs/INTEGRATIONS.md, "AI provider (Claude)".
