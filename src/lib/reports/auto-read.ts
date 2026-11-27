import { withSystem } from '../db';
import { queueClientUpdate } from '../client-updates/service';
import { readReportFile, ReportReadError } from './read-file';
import { storeParsedReport } from './service';

export interface AutoReadResult { reportIds: string[]; accounts: number; collections: number; error?: string }

/**
 * A credit report the client uploads in the portal is read right away, the same way staff would read it (the exact
 * Experian, Equifax and TransUnion readers first, AI for other layouts when it is on), and lands in the review queue as
 * "pending review": a person still approves it before anything is analysed or disputed. The client is told it was
 * received. If it cannot be read, the file stays in the vault and staff are told to look at it.
 */
export async function autoReadClientReport(a: {
  orgId: string; clientId: string; userId: string; documentId: string; bytes: Buffer; mime: string; name: string;
}): Promise<AutoReadResult> {
  let parsed;
  try {
    ({ parsed } = await readReportFile({ bytes: a.bytes, mime: a.mime, name: a.name }, { orgId: a.orgId, userId: a.userId }));
  } catch (e) {
    const error = e instanceof ReportReadError ? e.message : 'The file could not be read automatically.';
    if (!(e instanceof ReportReadError)) console.error('[auto-read] read failed', a.documentId, (e as Error).message);
    await withSystem((db) => queueClientUpdate(db, { orgId: a.orgId, clientId: a.clientId, event: 'report_received', subjectId: a.documentId })).catch(() => 0);
    return { reportIds: [], accounts: 0, collections: 0, error };
  }
  const found = parsed.tradelines.length + parsed.inquiries.length + parsed.publicRecords.length + parsed.identity.length;
  try {
    const reportIds = await withSystem(async (db) => {
      // Locked and checked: a file staff already read by hand is not read twice.
      const doc = await db.row<{ used: boolean }>(
        "select exists (select 1 from public.credit_reports r where r.document_id = d.id) as used from public.documents d where d.id = $1 and d.client_id = $2 for update of d",
        [a.documentId, a.clientId]);
      if (!doc || doc.used || !found) return [];
      await db.run("update public.documents set review_status = 'accepted' where id = $1 and review_status <> 'rejected'", [a.documentId]);
      const ids = await storeParsedReport(db, { orgId: a.orgId, userId: a.userId }, { clientId: a.clientId, parsed, documentId: a.documentId, source: 'upload' });
      await queueClientUpdate(db, { orgId: a.orgId, clientId: a.clientId, event: 'report_received', subjectId: a.documentId });
      return ids;
    });
    const collections = parsed.tradelines.filter((t) => t.item_type === 'collection').length;
    return { reportIds, accounts: parsed.tradelines.length - collections, collections, error: found ? undefined : 'Nothing could be read from this file.' };
  } catch (e) {
    console.error('[auto-read] store failed', a.documentId, (e as Error).message);
    return { reportIds: [], accounts: 0, collections: 0, error: 'The report was read but could not be saved automatically.' };
  }
}
