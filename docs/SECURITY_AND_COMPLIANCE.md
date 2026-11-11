# Security & compliance

This application handles sensitive financial and identity information. This page says what is enforced, where, how it
was verified, and what is **not** done. It is engineering documentation, **not legal advice**.

## Security controls

| Control | Implementation | Verified by |
|---|---|---|
| Tenant isolation | PostgreSQL row-level security on every table; tenant requests run as role `disputeos_rls` | 24 RLS tests (cross-org read/write/reassign, role tiers, portal isolation, no-membership user, every table has RLS on); browser journey with a second business |
| Client sees only own records | RLS policies keyed to `portal_user_id`; column guard trigger limits portal edits to phone/address/language | RLS tests; journey (client redirected away from `/app/*`) |
| Authentication | scrypt (N=2¹⁵), constant-time compare, dummy hash for unknown emails, lockout after 5 failures, per-IP and per-email rate limits | auth tests |
| Two-step verification | TOTP (RFC 6238), replay-proof; **mandatory for staff in staging/production** (`REQUIRE_STAFF_MFA`) | RFC test vectors; auth tests; browser MFA setup |
| Sessions | random 256-bit token, only its hash stored; HttpOnly, SameSite=Lax, Secure on https; absolute + idle expiry; revoked on password change/reset | auth tests; journey (old cookie rejected after sign-out) |
| RBAC | owner/admin/manager/specialist/client permission map + DB role tiers; nobody can mint an owner; admins can't create admins | unit + RLS tests |
| Secrets & secret leakage | all secrets from env, validated at boot per environment; production rejects dev keys / http URLs; password hashes & TOTP secrets unreadable by tenant queries | env tests; RLS "secrets not reachable" tests; boot check |
| Encryption at rest | SSN/DOB/TOTP secrets and every stored file are AES-256-GCM encrypted with key rotation support; account numbers are never stored (last 4 only) | unit tests; on-disk inspection after a real upload |
| Encryption in transit | HSTS + `upgrade-insecure-requests`; TLS terminates at your host/DB (`sslmode=require`) | config |
| Upload safety | type from file **contents** (magic bytes), 10 MB cap, sanitised names, extension/MIME ignored; download served `nosniff` + sandbox CSP | unit tests; journey (disguised executable rejected) |
| Web hardening | nonce-based CSP (no `unsafe-eval`), frame-ancestors none, nosniff, referrer & permissions policies; parameterised SQL everywhere; React escaping | production headers inspected |
| Audit log | append-only (trigger-enforced, even for the privileged connection); no FKs so user/org deletion never blocks it; no PII in metadata | RLS + offboarding tests |
| Rate limiting | Postgres-backed fixed windows (works across serverless instances) on sign-up, login, reset, MFA, invites | auth tests |
| Data retention & deletion | per-client export (JSON) and hard delete with typed confirmation; retention report in Settings | manual/UI |

**Operational requirements you must meet:** put the app behind a TLS-terminating proxy that sets `x-forwarded-for`
(rate limits key on it); keep `PII_ENCRYPTION_KEY` in a secret manager and back it up separately; use a persistent,
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
| **CROA** (15 U.S.C. § 1679) | Consent ledger for the disclosure, contract and authorization (version + hash of text, IP, timestamp); disputes **cannot be submitted** until all three are on file; warns inside the 3-business-day cancellation window; payments require confirming services were already performed (no advance fees) | Attorney-approved disclosure/contract text (the shipped text is a **reference draft**); a compliant contract |
| **FCRA** (15 U.S.C. § 1681) | Disputes are tied to a specific item and reason; 30-/45-day investigation clocks counted from receipt; findings say "differs / may warrant review", never "inaccurate"; round 2+ requires new information (frivolous-dispute guard) | Truthful disputes only; permissible purpose for any report pull |
| **FDCPA** (15 U.S.C. § 1692) | Validation-request template restricted to collection accounts; explains the 30-day window; cease-communication template notes it does not erase a debt | Applies to collectors; confirm applicability |
| **State CSO / credit-services laws** | Operator state captured; sign-up and settings remind about registration/bonding | Registration, surety bond, state-specific contract terms (e.g. Florida) |
| **Privacy / consumer protection** | Minimised storage (last-4 only, encrypted identifiers), data export & deletion, role-based access, audit trail | Privacy policy, state privacy-law obligations, breach-notification process |
| **FTC Act / advertising** | A blocked-claims guard rejects guarantees, promised deletions, score promises, "new credit identity/CPN" language in AI output, automations and templates, and warns on staff-written text | Your own marketing must comply too |
| **TCPA** | SMS is not implemented; consent kind `communications` exists for email/portal | Separate express written consent before any SMS |

**Human approval before external communication:** letters need a manager's approval of the exact text (edits void the
approval); automations that message clients wait in the Inbox; the system never mails or emails a dispute itself — a person
sends it and records that they did.

**The AI never fabricates:** it works only from stored report data; an LLM may reword but its output is discarded if any
number/date changes or a prohibited claim appears; personal identifiers are stripped before any text leaves the server;
it does not assert identity theft; every output is an editable draft with its supporting evidence shown.
