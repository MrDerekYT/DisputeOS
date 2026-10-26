# Decisions log

| # | Decision | Why |
|---|----------|-----|
| 1 | Field encryption is AES-256-GCM in the app layer (`src/lib/crypto.ts`), key from env now. | Works without Supabase Vault in dev. **Next step:** load the key from Supabase Vault in production and add key rotation (ciphertext is already versioned `v1:`). |
| 2 | Staff RLS requires `aal2` JWT claim (MFA) via `staff_aal2()`. | Enforces MFA in the database, not just the UI. |
| 3 | Passkeys: login form advertises WebAuthn autofill; full passkey enrollment ships once Supabase passkey support is enabled for the project. | Not GA in all Supabase tiers; avoids a fake implementation. |
| 4 | Sentry: PII scrubber (`src/lib/scrub.ts`) is ready and tested; the Sentry SDK is wired in once a DSN exists. | No DSN available yet. |
| 5 | Original static demo kept in `/prototype` for reference only. | It was the first preview; not part of the product. |
| 6 | shadcn/ui is deferred to Phase 2 when real screens need components; Tailwind tokens are set up now. | Avoids shipping unused components. |
| 7 | Florida credit services organization registration and surety bond requirements **must be verified with an attorney** before taking paying clients. | Not legal advice; state rules engine is Phase 6. |
| 8 | No image-generation tool or API key was available, so UI art is inline SVG/CSS. | Provide `OPENAI_API_KEY` and ask for the CLI fallback to add bitmap art. |
| 9 | Phase 3 ships analyzer + bilingual letters + print-to-PDF; LLM strategist, template versioning and enclosure builder are deferred. | Letters use only vetted citations and the report's own facts. |
| 10 | Mail layer (`src/lib/mail`) uses an adapter: Mock by default, Lob when `LOB_API_KEY` is set. Letters require a named human approver and an idempotency key. | Prevents unreviewed or duplicate mailings. Rates are estimates only. |
| 11 | Import layer (`src/lib/import`): report-provider adapter (Mock default, Array when `ARRAY_APP_KEY`+`ARRAY_BASE_URL` set) and client CSV import. Pulls require documented client consent. | SmartCredit/IdentityIQ/MFSN have no public API (partner-only); no credential scraping. Array endpoint must be confirmed after partner access; FCRA permissible purpose needs attorney review. |
| 12 | Client sign-up links are HMAC-signed, expiring (14 days) tokens (`src/lib/invite.ts`, needs `INVITE_SECRET` in prod). The public `/join/[token]` form validates and requires CROA-disclosure and report-pull consent. **Submissions are not stored yet** (needs Supabase); production refuses to accept them unless `INTAKE_PREVIEW=1`. | Never silently drop client data. Next: persist to `clients` with consent record, then notify the agency. |

## 13. Admin preview auth
Env-configured staff login with an HMAC-signed, 8h cookie; falls back to Supabase + MFA when unset. Every Shell page requires admin.

## 14. Signed portal tokens
Client portal URLs are /portal/<id>.<hmac>; plain ids 404 and the portal shows no admin links.

## 15. Case Copilot
Heuristic bilingual reply classifier plus template update writer. Optional LLM polish strips the client name and PII first and falls back to the template on failure.
