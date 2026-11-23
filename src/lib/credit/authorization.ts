import type { Db } from '../db';

/**
 * The client's written authorization to review their credit reports (the `fcra_authorization` consent). Under the FCRA a
 * consumer report may be obtained and used only for a permissible purpose (15 U.S.C. § 1681b); for a credit repair
 * business that is the consumer's written instructions (§ 1681b(a)(2)). Every way staff bring a report into a client's
 * file needs it on file and not revoked: an automatic import pulled from a provider or pushed through the API
 * (src/lib/credit/pull.ts), a report staff upload, and a file staff uploaded and then read as a report.
 *
 * Two cases need none: a report the client uploads themselves in the portal (the consumer gives it to the agency;
 * nothing is obtained from a bureau), and a personal workspace, where the account holder works on their own file and
 * records the authorization only to use automatic import.
 */
export async function currentAuthorization(db: Db, clientId: string): Promise<{ id: string } | null> {
  return db.row<{ id: string }>(
    "select id from public.client_consents where client_id = $1 and kind = 'fcra_authorization' and revoked_at is null order by signed_at desc limit 1", [clientId]);
}

export const STAFF_REPORT_AUTHORIZATION_NEEDED =
  'Record the client’s written authorization to review their credit reports (Overview → Compliance record) before you add a credit report. A report the client uploads in their portal can still be read.';

/** Why staff may not add a credit report to this client's file right now, or null when they may. */
export async function staffReportRefusal(db: Db, clientId: string): Promise<string | null> {
  const row = await db.row<{ mode: string }>('select o.mode from public.clients c join public.organizations o on o.id = c.org_id where c.id = $1', [clientId]);
  if (!row) return 'Client not found.';
  if (row.mode === 'personal') return null;
  return (await currentAuthorization(db, clientId)) ? null : STAFF_REPORT_AUTHORIZATION_NEEDED;
}
