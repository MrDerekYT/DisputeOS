# Contributing

1. `npm ci` and copy `.env.example` to `.env.local`.
2. Before a PR: `npm run lint && npm run typecheck && npm run format:check && npm test && npm run build`.
3. Database changes: add a migration in `supabase/migrations/` (keep `supabase/schema.sql` in sync), enable RLS, index foreign keys, and extend `supabase/tests/rls_tenant_isolation.sql`. Run `scripts/test-rls.sh` (needs a local Postgres; set `PGHOST`/`PGUSER`).
4. All user-facing strings go in `messages/en.json` **and** `messages/es.json` (a test enforces parity).
5. Never log PII; never promise outcomes in UI copy or AI output.
6. Record notable choices in `docs/DECISIONS.md`.
