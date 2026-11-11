# DisputeOS

The operating system for credit repair professionals: client CRM, three-bureau report analysis, a documented
dispute workflow, a letter center with approvals, an automation engine with safeguards, and a separate client portal.
Built so that compliance is part of the product, not a checklist next to it.

> **Not legal advice.** DisputeOS is software. It does not guarantee any deletion, correction or score change, and it
> does not replace an attorney. See [docs/SECURITY_AND_COMPLIANCE.md](docs/SECURITY_AND_COMPLIANCE.md).

## What is in the box

| Area | What it does |
|---|---|
| **Clients (CRM)** | Search, filters and saved segments; onboarding with a consent ledger; profile with timeline, notes, tasks, messages, encrypted document vault, billing |
| **Report analysis** | Upload a text-based PDF / HTML / text report or the CSV template; parsed with per-field confidence; **a person reviews and approves** before anything is analysed |
| **Three-bureau comparison** | Experian · Equifax · TransUnion side by side; differences become *findings* with the evidence behind them, labelled reported fact / client-provided / potential discrepancy. Nothing is ever called "inaccurate" automatically |
| **Dispute engine** | Draft → Ready for review → Approved → Submitted → Under investigation → Response received → Resolved (+ On hold / Cancelled). Rounds, FCRA 30/45-day clocks, evidence, outcomes, follow-up tasks, automatic audit trail. Another round requires *new* information. Several findings can be drafted into disputes at once; each stays a draft until reviewed and approved |
| **Letter center** | 11 templates (EN, with ES for the main letters), editable, live preview, PDF, version history, manager approval. Editing an approved letter returns it to draft |
| **AI assistant** | Modular providers (rules / Anthropic / OpenAI-compatible). Works with no LLM at all; an LLM may only reword, and its output is discarded if any fact changes |
| **Automations** | Triggers, caps, cooldowns, idempotency, and approval for anything client-facing |
| **Client portal** | Under the **agency's own name and colour** (branded sign-in link per agency; the software name is a small "Powered by" line). Opens with one clear next step computed from the client's real records, explains the current stage, shows progress, reported scores and the client's rights; uploads, approved letters, messaging, e-signing; app-style bottom navigation on phones; English and Spanish (including dates). Clients can only ever see their own records (database-enforced) |
| **Credit Connect** | Consent-gated automatic import: provider adapter framework (+ dev sandbox) and a public REST API with scoped API keys, OpenAPI spec and idempotent report push. Live provider adapters need partner access — see [docs/CREDIT_CONNECT.md](docs/CREDIT_CONNECT.md) |
| **Everyday speed** | Command palette (⌘K), reported-score history, white-label client portal colour |
| **Lead capture** | A public, branded enquiry form per agency (`/start/<slug>`): contact details only, consent required, rate limited; each enquiry becomes a lead with a follow-up task |
| **Client care** | Dashboard queues for clients waiting on the team: unanswered messages, client uploads to review, and active clients with no update in 14+ days |
| **Business** | Team & roles, client assignment, analytics from real data, service plans and manually-recorded payments, audit log, retention tools |

## Renaming the product

The product name lives in one file: [`src/lib/product.ts`](src/lib/product.ts) (`name`, the two-tone logo `accent`, `tagline`,
`description`, and whether agencies' portals show "Powered by"). Change it there and every page title, email, authenticator label,
PDF producer tag and the logo follow. Internal identifiers (the `disputeos_rls` database role, cookie and storage keys, the
`package.json` name) are deliberately independent, so a rename never needs a migration. Docs still say "DisputeOS" — a find-and-replace.

## Quick start

```bash
npm install
npm run env:setup                 # creates disputeos_dev + disputeos_test on a local PostgreSQL 14+ and migrates both
cp .env.example .env.local        # set DATABASE_URL (and DATABASE_URL_TEST); see docs/ENVIRONMENTS.md
npm run db:seed                   # optional demo agency (development only; clearly labelled sample data)
npm run dev                       # http://localhost:3000
```

No local PostgreSQL? `docker compose up -d`, then use the URL in `docker-compose.yml`.

Demo logins after seeding (password `Demo-Passw0rd-2026!`): `owner@` / `manager@` / `specialist@demo.disputeos.test`;
client portal at `/portal/login` as `jordan.rivera@example.test` (English) or `maria.gomez@example.test` (Spanish).
Set `REQUIRE_STAFF_MFA=false` in `.env.local` to skip two-step verification locally; it is mandatory in staging/production.

## Commands

| | |
|---|---|
| `npm run check` | typecheck + lint + all tests + production build |
| `npm test` | unit + database tests (needs `DATABASE_URL_TEST`) |
| `node e2e/journey.cjs` | 28-step browser journey against a running server (see below) |
| `npm run db:migrate` / `db:reset` / `db:seed` | migrations / drop-and-recreate (refused in production) / demo data |

## Architecture

- **Next.js 15** (App Router, server actions) · TypeScript strict · Tailwind · Zod · `pg` · no UI/charting framework
- **PostgreSQL is the security boundary.** Every tenant request runs as the `disputeos_rls` role with `app.user_id` set, so row-level security — not just application code — isolates businesses and clients. See `db/migrations/0005_rls.sql`.
- **First-party auth:** scrypt passwords, revocable DB-backed sessions, TOTP two-step verification, lockout, rate limits, single-use reset links, invitations.
- **Defence in depth:** RLS → RBAC permission map (`src/lib/rbac.ts`) → validated inputs → append-only audit log.
- **Domain logic is framework-free** (`src/lib/…`) and tested directly against a real database.

```
db/migrations/   schema + RLS            src/lib/reports/    parser, PDF text, cross-bureau analysis
src/lib/auth/    sessions, MFA, limits   src/lib/disputes/   workflow rules, services, reason drafting
src/lib/letters/ templates, PDF, flow    src/lib/automation/ engine, presets
src/lib/ai/      provider interface      src/lib/compliance/ claims guard, consent documents
src/app/app/     staff app               src/app/portal/     client portal
```

## Testing (what was actually run)

- **229 automated tests**, all passing: security primitives (TOTP against the RFC 4226/6238 vectors), PostgreSQL row-level-security isolation, auth flows, report parsing / PDF round-trip, dispute → letter → approval → submission workflow, automation safeguards, AI safety guard, form parsing, client-portal copy (every client-visible status has plain-language text in both languages; no outcome promises), branded sign-in privacy, client-care queues.
- **Browser end-to-end** (`e2e/journey.cjs`, Playwright + Chromium) against the **production build** with MFA enforced: sign-up + MFA, client creation, report upload/review/approval, comparison, dispute, letter approval + PDF, submission, outcome, portal invite (branded), the portal's next-step card and rights, client upload and messaging, the staff client-care queue, tenant isolation, phone/tablet layouts with bottom navigation, branded sign-out, dark mode, session revocation — the public enquiry form and bulk dispute drafting — **33 steps**. Run with:
  `REQUIRE_STAFF_MFA=true npx next start -p 3100` then `node e2e/journey.cjs` (needs Playwright's Chromium).
- The end-to-end run found real defects that unit tests missed (e.g. unchecked checkboxes failing every form); each is fixed with a regression test.

## Honest limitations

Read [docs/INTEGRATIONS.md](docs/INTEGRATIONS.md) for the full list. In short: **no live credit-report pulls, card processing, SMS, e-signature provider or certified-mail integration exists** — those need third-party accounts and approvals, and they are marked "Not built" in Settings rather than faked. Email, AI and Resend adapters are implemented to the providers' documented APIs but have not been run against the live services. Scanned (image-only) reports are not read (no OCR). No malware scanning of uploads. Compliance documents are reference drafts that your attorney must review.

## Docs

[Engineering assessment](docs/ENGINEERING_ASSESSMENT.md) · [Environments](docs/ENVIRONMENTS.md) · [Security & compliance](docs/SECURITY_AND_COMPLIANCE.md) · [Integrations](docs/INTEGRATIONS.md) · [Credit Connect](docs/CREDIT_CONNECT.md) · [Changelog](CHANGELOG.md)
