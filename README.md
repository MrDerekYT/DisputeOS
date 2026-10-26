# DisputeOS

Modern credit repair platform with personal and agency modes. FCRA/FDCPA compliant, automated dispute management, and certified mail integration.

## Getting started

```bash
cp .env.example .env.local   # fill in Supabase keys; PII_ENCRYPTION_KEY via `openssl rand -base64 32`
npm install
npm run dev
```

Checks: `npm run lint && npm run typecheck && npm test && npm run build`.

## Layout

- `lib/disputes.ts` FCRA 30/45-day deadlines, bureau addresses, round logic
- `lib/letters.ts` template merge and §611 letter generation
- `lib/crypto.ts` AES-256-GCM field-level PII encryption (server-only)
- `lib/validation.ts` zod schemas for all user input
- `middleware.ts` session refresh and `/dashboard` route protection
- `supabase/` schema with RLS-ready org scoping

Not legal advice; users are responsible for FCRA/FDCPA compliance.

## Phase status

Phase 1 (foundation) is implemented; see `CHANGELOG.md`, `docs/DECISIONS.md`, `docs/SECURITY.md`, `docs/SOC2_CHECKLIST.md`.

## Tests

- `npm test` — unit tests
- `PGHOST=/var/run/postgresql scripts/test-rls.sh` — RLS tenant-isolation suite (needs Postgres)

## Compliance notes

- **Florida:** credit services organizations may need to register and post a surety bond. Verify requirements and amounts with an attorney before taking paying clients. (State rules engine is planned for Phase 6.)
- No result guarantees anywhere in UI, templates or AI output. CROA contract/cancellation flow is planned for Phase 6.
