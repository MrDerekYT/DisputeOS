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
