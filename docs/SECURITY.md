# Security policy

Report vulnerabilities privately to the maintainers (GitHub Security Advisories). Do not open public issues for security bugs.

## Controls implemented (Phase 1)

- **Tenant isolation:** RLS enabled on every public table; `anon` has no privileges; automated cross-tenant tests (`scripts/test-rls.sh`) run in CI.
- **Authentication:** Supabase Auth, TOTP MFA enforced for dashboard access, open-redirect-safe callback.
- **Privilege escalation:** `users.role`/`org_id` are not client-updatable; sign-up ignores user-supplied roles.
- **Audit log:** append-only (trigger blocks update/delete/truncate even for superusers); actor cannot be spoofed.
- **PII:** SSN/DOB/account numbers encrypted with AES-256-GCM (versioned keys); display last-4 only; PII scrubbed from Sentry events and must never be logged.
- **Transport/headers:** HSTS, nonce-based CSP, X-Frame-Options DENY, nosniff, strict referrer policy.
- **Supply chain:** `npm audit` and gitleaks in CI.

## Rules for contributors

- Never log SSNs, report contents, or document contents. Use `lib/observability/scrub.ts` for any metadata.
- Service-role keys are server-only; never import them in client components.
- Every new table needs RLS, an `org_id` index, and a case in the tenant-isolation suite.
