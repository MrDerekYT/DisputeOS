# SOC 2 readiness checklist

Legend: ✅ done · 🟡 partial · ⬜ planned (phase)

## Security (CC6/CC7)

- ✅ Logical access: RLS multi-tenant isolation + CI tests
- 🟡 MFA: TOTP enforced; passkeys ⬜ (see DECISIONS #3)
- ✅ Encryption of sensitive fields at rest (app-level AES-GCM), TLS in transit (HSTS)
- ⬜ Document virus scanning, signed short-lived URLs (Phase 2)
- ⬜ "Access reason" prompt for full-PII views (Phase 2)
- ✅ Dependency + secret scanning in CI
- ⬜ Rate limiting (Upstash) (Phase 5)
- ✅ Immutable audit log; ⬜ audit coverage of all actions (ongoing)

## Availability (A1)

- ⬜ Nightly backups + PITR + restore runbook (Phase 8; Supabase PITR to be enabled)

## Confidentiality / Privacy (C1/P)

- ⬜ Data retention & deletion policy, client export/delete (Phase 6/8)
- ✅ PII scrubbing for error reporting

## Change management (CC8)

- ✅ CI: lint, typecheck, unit, RLS, build, audit; ⬜ e2e + Lighthouse (Phase 8)
- ✅ Decisions log

## Incident response (CC7.3-7.5)

- ⬜ Runbook (Phase 8)
