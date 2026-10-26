# Changelog

## Unreleased — Phase 1

- Auth (sign-up/sign-in), TOTP MFA enforced in middleware, org/role model
- RLS on all tables with tenant-isolation test suite (CI)
- Field-level PII encryption with key rotation; PII scrubbing for Sentry
- Strict nonce CSP + security headers
- EN/ES i18n (next-intl), shadcn-style design system primitives
- CI (lint, typecheck, tests, RLS, build, audit, secret scan)
- CSV credit report import, dispute/letter primitives
