# SOC 2 readiness checklist (living document)

- [x] Tenant isolation via RLS on every table, with SQL tests (`supabase/tests`)
- [x] MFA enforced for staff in the database (`staff_aal2`)
- [x] Append-only audit log (no update/delete grants)
- [x] Field-level encryption for SSN/DOB (AES-256-GCM)
- [x] Security headers (CSP, HSTS, nosniff, Referrer-Policy)
- [x] PII scrubbing utility for logs/telemetry/LLM prompts
- [x] CI: lint, typecheck, tests, `npm audit`, secret scanning
- [ ] Keys in Supabase Vault + rotation procedure
- [ ] Session timeout and device management
- [ ] Upload virus scanning, signed short-lived URLs (Phase 2)
- [ ] Access-reason prompt for full PII views
- [ ] Backup/restore runbook tested; incident response runbook
- [ ] Data retention and client export/delete policy
