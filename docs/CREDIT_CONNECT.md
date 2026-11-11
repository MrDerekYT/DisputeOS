# Credit Connect — bringing credit reports in automatically

Credit Connect is the pipeline that turns "a report exists somewhere" into "a reviewed report in DisputeOS". It has three
entry points that all end in the same place — the **pending review** queue:

| Entry point | Status | Use it when |
|---|---|---|
| **Upload** (PDF / HTML / text / CSV) | Works today | You have the report as a file |
| **Inbound REST API** `POST /api/v1/clients/{id}/reports` | **Works today, tested** | A provider webhook, Zapier/Make, or your own system can send normalized JSON |
| **Provider adapter** ("Pull reports" button) | Framework + sandbox work today; **live providers need partner access** | You hold a contract/API credentials with a provider |

## The rules the pipeline enforces (in code, with tests)

1. **No import without written authorization.** Pulled *or* pushed, a current un-revoked `fcra_authorization` consent must exist
   for the client. The consent used is recorded on the pull. Revoke it and automatic import stops.
2. **A person reviews every import.** Reports arrive as `pending_review`; nothing is analysed, compared or disputed until someone approves.
3. **Strict validation.** Provider output and API bodies must satisfy the same schema (`src/lib/credit/schema.ts`). Anything else is rejected.
4. **Data minimisation.** Full account numbers are accepted only to be cut to their last four characters; they are never stored or logged.
5. **Idempotent retries.** Re-sending the same `external_ref` for a client is rejected, so webhook retries cannot duplicate reports.
6. **Rate limited.** 120 requests/minute per key; 5 pulls/hour per client.
7. **Audited.** Every pull/push is a `report_pulls` row plus an audit-log entry showing which key or user did it.
8. **No synthetic data outside development.** The sandbox provider is disabled in staging/production (tested).

## Why there is no "Array adapter" yet

We researched the real providers rather than guessing:

- **Array** — developer documentation is password-protected; no one can write or verify an adapter without partner access.
- **IDIQ / IdentityIQ** — no public API documentation was found; access is via its partner program.
- **SmartCredit / MyFreeScoreNow** — not verified; confirm with the provider.
- **Experian / Equifax / TransUnion direct** — contracts, permissible-purpose review and issued credentials/certificates.

We will not scrape consumer logins or invent endpoints: it violates provider terms, endangers client credentials, and would be a
fake integration. Those providers appear in **Settings → Developers & connections** as "Needs partner approval" with what is required.

## Pushing reports through the API

Create a key in **Settings → Developers** (permission `reports:write`), then:

```bash
curl -X POST https://YOUR_HOST/api/v1/clients/<CLIENT_ID>/reports \
  -H "Authorization: Bearer dosk_xxxxxxxx_…" -H "Content-Type: application/json" \
  -d '{"external_ref":"pull-001","reports":[{"bureau":"experian","report_date":"2026-03-01",
       "scores":[{"model":"VantageScore 3.0","score":612}],
       "tradelines":[{"creditor_name":"ACME BANK","account_number":"4111111111111234","balance_cents":120000}]}]}'
```

Response `201` → `{ pull_id, report_ids, status: "pending_review", review_urls }`. Errors are JSON `{ error: { code, message } }`:
`401` bad/revoked key · `403` missing scope · `404` unknown client · `422` invalid payload or authorization missing · `429` rate limited.
Full schema: `GET /api/v1/openapi.json`. Other endpoints: `GET/POST /api/v1/clients`, `GET /api/v1/clients/{id}`, `GET /api/v1/disputes`.

**Key security:** keys look like `dosk_<8 chars>_<secret>`; only a SHA-256 is stored; shown once; scoped; revocable; they act as the
admin who created them *inside that user's row-level security* (so tenant isolation applies even to the API) and stop working the moment
that user leaves the organization or the organization is suspended.

## Adding a real provider adapter (once you have partner access)

1. Implement `CreditProvider` from `src/lib/credit/providers.ts` in a new file, e.g. `src/lib/credit/providers/array.ts`:
   ```ts
   export const array: CreditProvider = {
     key: 'array', name: 'Array',
     async pull({ clientId, fullName, address }) {
       // call the provider's DOCUMENTED API with credentials from env (never hard-code or log them)
       // map its response to ReportInput[] (src/lib/credit/schema.ts)
       return { externalRef: '<provider order id>', reports: [/* ReportInput */] };
     },
   };
   ```
2. Register it in `getProvider()` / `listProviders()` and flip its entry from `needs_partner_approval` to `available` **only when it works**.
3. Add a test with mocked HTTP (see `tests/unit/ai.test.ts` for the pattern) and, once you have a provider sandbox, a live verification step.
4. Add credentials to `.env.example`, validate them in `src/lib/env.ts`, and update `docs/INTEGRATIONS.md` with what was and was not verified live.

You do **not** need to write the consent gate, validation, review queue, deduplication, rate limiting, score storage or audit —
`requestReportPull()` does all of that around your adapter, and rejects adapter output that fails the schema.
