# DisputeOS — Engineering Assessment (takeover)

Scope: everything Copilot produced before this takeover. `main` contains only a README and LICENSE; the real
work lives on two diverged branches. Both were installed and exercised with the real toolchain
(`tsc`, `eslint`, unit tests, `next build`, and — for Phase 1 — its Postgres RLS suite on PostgreSQL 16).

| Branch | What it is | Source size* |
|---|---|---|
| `copilot/disputeos-phase-1-scaffold-auth` | Next.js 15 + Supabase. Real data wiring, wide schema (disputes, rounds, letters, mail jobs), RLS suite, MFA, CSP, CI | ~3.9k lines |
| `mrderekyt-disputeos-preview` | Next.js 15 + next-intl (EN/ES). Many screens, analyzer, bilingual letters, mail/import adapters, signed portal links | ~4.5k lines |

\*excluding lockfiles. Both branches remain untouched on GitHub; nothing here rewrites their history.

## 1. What already works (verified)

| Item | Evidence |
|---|---|
| Phase-1 typecheck, lint, 23 unit tests, production build | all green |
| Preview typecheck, lint, 53 unit tests, production build | all green |
| Phase-1 **RLS tenant isolation** (cross-org reads/writes blocked, portal client sees only own rows, vault policies, audit log append-only) | `scripts/test-rls.sh` passes on real Postgres 16 |
| AES-256-GCM field encryption with key-id rotation (`lib/crypto.ts`) | unit tests |
| Upload hardening: magic-byte MIME sniffing, filename sanitising, size cap | unit tests |
| Rules-based report parser with per-field confidence + PII-masked snippets; CSV import; report diffing | unit tests |
| FCRA 30/45-day deadline maths, bureau mailing addresses | unit tests |
| CSP with per-request nonce, security headers, PII scrubber, HMAC invite/portal tokens | unit tests |
| Preview: bilingual (EN/ES) letter generation with a blocked-claims guard (`assertSafe`), mail adapter with human approver + idempotency key | unit tests |

These pieces are **kept and ported** into the new codebase rather than rewritten.

## 2. Partially implemented

- **Disputes (Phase-1):** create + list only. No pipeline, no rounds UI, no outcome recording, no evidence, no letter persistence. `letters` page renders one hard-coded sample for "Jane Doe".
- **Document vault (Phase-1):** upload + RLS-protected storage path, but depends on Supabase Storage, no malware scanning, no in-app viewer.
- **Report review (Phase-1):** parse → review → approve exists; no multi-bureau comparison, no discrepancy findings.
- **Client portal (Preview):** signed-link page exists but renders `DEMO_CLIENTS`; no login, uploads, or messaging.
- **Mail (Preview):** adapter + approver rules are good; nothing persists jobs, nothing is wired to a UI action that uses real data.
- **AI (Preview):** reply classifier is regex heuristics; "polish" calls an OpenAI-compatible endpoint but only for a canned update template.
- **MFA:** enforced in middleware and RLS (Phase-1), but depends on Supabase Auth which cannot run in this environment (see §5).

## 3. Broken / unsafe (defects found)

1. **Fabricated statistics (Preview).** `/dashboard` hard-codes "Score 612 · up 64 points in 6 months", "$41.20 spend", "60% resolved"; `/portal/*`, `/clients`, `/copilot` read `DEMO_CLIENTS`. This violates the "no fake data" rule and the headline is a CROA-risky score claim.
2. **Privilege bug (Preview, `src/lib/access.ts`).** `isAdmin()` returns `true` for *any* signed-in Supabase user, including a client. There is no role check at all.
3. **Single shared admin password (Preview).** Staff "login" is one `ADMIN_EMAIL`/`ADMIN_PASSWORD` pair in env vars; no per-user identity, no audit actor.
4. **Intake form drops data (Preview).** `/join/[token]` validates and consent-gates, then discards the submission (documented in DECISIONS #12). In production it refuses to run.
5. **Two incompatible schemas.** Different table/column names (`org_id` vs `organization_id`, `users` vs `memberships`, enum vs text-check), different layouts (`app/` vs `src/app/[locale]`), different test runners (jest vs vitest). They cannot be merged by git.
6. **Dashboard (Phase-1) is a bullet list of three bureau names.**
7. **No password-reset flow** in either branch; **no rate limiting / lockout** in either branch.
8. **Dispute rounds capped at 3 by a DB check constraint** — excludes legitimate later rounds and is not a legal rule.
9. **No audit writes** on most mutations (table exists, helper exists, rarely called).
10. **Duplicate account / duplicate logic:** two copies of `crypto`, `scrub`, `parser`, `diff`, `import`, `letters`, `disputes`.

## 4. Missing entirely (vs. the brief)

Client CRM (notes, tasks, reminders, timeline, communications, segmentation), employee management, role
permissions beyond owner/staff/client, dispute pipeline + rounds + evidence history, letter center
(templates, versions, approvals, PDF), three-bureau comparison, discrepancy findings with evidence,
modular AI assistant, automation engine, authenticated client portal (uploads, messages, letters),
billing/payments/subscriptions, analytics from real data, integrations status page, data-retention controls,
consent ledger UI, password reset, rate limiting, E2E tests, environment configuration.

## 5. Architecture assessment

**Decision: one codebase, Phase-1 as the base, best of Preview ported in; Postgres is kept, Supabase Auth is not.**

- *Kept:* Next.js 15 App Router, TypeScript strict, Tailwind, Zod, PostgreSQL, multi-tenant `org_id` + RLS as the
  isolation boundary, field-level encryption, CSP, the Phase-1 table design, the RLS test approach.
- *Changed — and why:* Supabase Auth/PostgREST/Storage cannot be started in this sandbox (no Docker daemon, GitHub
  release downloads blocked), so nothing that depends on them can be **verified**, and the brief forbids claiming
  unverified work. Data access therefore moves to direct `pg` with RLS enforced per transaction
  (`SET LOCAL ROLE` + `app.user_id`), and authentication is first-party (scrypt, DB-backed revocable sessions,
  TOTP MFA, reset tokens, rate limiting). This is portable: any managed Postgres (including Supabase's own database)
  works, and every layer is covered by real tests.
- *Dropped:* `@supabase/*`, `next-intl` (replaced by a small dictionary for portal/letters), `jest`/`ts-jest`,
  `@sentry/nextjs` (kept as a documented optional hook — no DSN exists), `tailwind-merge`/`clsx`/`cva`/radix.
- *Defense in depth:* RLS (database) + RBAC permission map (server actions) + tenant-scoped queries + audit log.
- *Secrets:* all from env, validated at boot per environment; production refuses dev defaults.

## 6. Compliance posture (design rules enforced in code)

- No score-increase or deletion guarantees anywhere; letters and AI output pass a blocked-claims guard
  (`lib/compliance/claims.ts`) and are labelled as drafts requiring human approval.
- CROA: disclosure + contract + 3-business-day cancellation tracked in the consent ledger; services cannot
  start until recorded.
- FCRA: disputes are tied to a specific reported item and reason; the app does not label an item "inaccurate"
  merely because bureaus differ — differences are surfaced as *potential discrepancies* to investigate.
- FDCPA: validation-request template restricted to collection accounts.
- Nothing is sent externally without a named human approver and an idempotency key.
- **State CSO/credit-services laws vary (e.g., registration/bonding). This product does not make legal
  determinations — operators must verify with counsel.**

## 7. Roadmap (executed in this order)

1. Foundation: scaffold, environments, schema + RLS, auth, RBAC, audit, rate limiting.
2. Design system, shell, landing.
3. CRM.
4. Report analysis + three-bureau comparison + findings.
5. Dispute engine + pipeline.
6. Letter center.
7. AI assistant + automations.
8. Client portal, team, analytics, billing, settings/integrations.
9. QA: automated tests, browser E2E, responsive screenshots, defect fixes.

Status of each phase and what was verified is tracked in `CHANGELOG.md` and `docs/INTEGRATIONS.md`.

## 8. Status after the takeover (what is done, verified, and still open)

**Verified:** `npm run check` (typecheck, lint, 180 tests, production build) passes from a clean state; the 25-step
Playwright journey passes against the production build with staff MFA enforced; boot refuses unsafe production
configuration; uploaded files on disk contain no plaintext. See README → Testing.

| Roadmap item | State |
|---|---|
| 1. Existing bugs / fabricated data | Removed; replaced by data-driven screens |
| 2. Security & DB architecture | Done and tested (RLS, auth, MFA, audit, encryption, rate limits, CSP) |
| 3. CRM | Done |
| 4. Report analysis | Done for text-based PDF / HTML / text / CSV. **No OCR, no live provider pulls** |
| 5. Dispute management | Done |
| 6. Letters & documents | Done (11 templates, PDF, versions, approval). Wording is not attorney-reviewed |
| 7. AI assistant | Done with a deterministic core; LLM adapters tested against mocks only |
| 8. Automation | Done (event + scheduled triggers, caps, idempotency, approvals) |
| 9. Client portal | Done (EN/ES). Clients can't self-enable MFA UI beyond a link to the shared setup page |
| 10. Business & analytics | Done. Payments are **manual records**, not processed |
| 11. Integrations & polish | Honest status page. **SMS, Stripe, e-sign, mail, report providers, S3 not built** |

**Still open (highest value first):** attorney review of consent/contract/letter text and state CSO rules; real report-provider
integration (needs partner approval); S3-compatible storage + malware scanning; OCR for scanned reports; Stripe Checkout +
webhook; e-signature provider; recovery codes for MFA; key re-encryption job; per-template approval policy editor; observability;
penetration test. Bureau report layouts vary widely — expect to extend `src/lib/reports/parser.ts` with real samples
(the review screen exists precisely because automatic reading is imperfect).
