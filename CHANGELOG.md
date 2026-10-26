# Changelog

## Unreleased — Phase 2

- Client profiles (list/create/detail), private document vault (storage RLS by org prefix, magic-byte type check, size limit)
- Rules-based text/HTML report parser with per-field confidence and masked source snippets
- Review screen (source next to editable value; low-confidence items unchecked), approve/reject with audit log
- Report diffing (removed / updated / new) between approved imports
- Migration `20260102000000_phase2_vault_imports.sql` + RLS tests for `report_imports` and vault

## Phase 1

- Auth (sign-up/sign-in), TOTP MFA enforced in middleware, org/role model
- RLS on all tables with tenant-isolation test suite (CI)
- Field-level PII encryption with key rotation; PII scrubbing for Sentry
- Strict nonce CSP + security headers
- EN/ES i18n (next-intl), shadcn-style design system primitives
- CI (lint, typecheck, tests, RLS, build, audit, secret scan)
- CSV credit report import, dispute/letter primitives
