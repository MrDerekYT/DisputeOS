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
