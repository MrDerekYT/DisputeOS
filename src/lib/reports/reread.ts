/**
 * "Read the file again": the stored file of a report that is still waiting for review is read once more, with the
 * readers as they are now, and what the fresh reading holds for that report takes the place of what it held before.
 *
 * Why it exists. The readers improve (a bureau layout gets its own reader, a field gets fixed), and a row removed from
 * a reading by mistake cannot be put back by hand. In both cases the file is already in the vault, so nobody should
 * have to find it and upload it a second time.
 *
 * What it does and does not touch:
 *  - One report: the one the button is on. Its rows are replaced and it keeps its id, so the review link staff were
 *    sent still opens it. A file can hold several bureaus, each with its own report: the others are not touched,
 *    whatever their state, and each one still waiting for review has its own button.
 *  - Only a reading nobody has decided yet ("pending review"). An approved report is in use (flags, disputes and
 *    letters stand on it) and a rejected one was refused by a person: neither is changed or read again here.
 *  - Which part of the file: what the fresh reading files under this report's bureau. When the file is this one
 *    report, a row that names no bureau belongs to it, as it did at the first reading, and if the reader now names
 *    one other bureau on every row the report moves to that bureau: a first reading would have filed it there too.
 *    In a file with several reports, rows that name no bureau are not guessed at: the re-read is refused.
 *  - Corrections typed into the earlier reading, and what the client said about an account (tradelines.user_provided),
 *    go with its rows. The button says so before anything happens.
 *  - Nothing changes when the file cannot be read, when nothing is recognised in it, or when it holds nothing for this
 *    report's bureau: the earlier reading stays.
 *  - A reading with a dispute or a collector notice attached to one of its accounts is not replaced.
 *  - Who may read is the rule of the first reading: a file staff added needs the client's written authorization on
 *    file and not revoked; a file the client uploaded, and any file in a personal workspace, can be read at any time
 *    (src/lib/credit/authorization.ts).
 *  - The client is not told again and no automation runs: no new file arrived, and nothing here calls either.
 *  - Approving or rejecting checks that the reading is still the one that was on screen (readingMark in ./service.ts),
 *    so a reading someone else just swapped in is never decided unseen.
 *
 * The file is read outside any database transaction (a long PDF, or an AI read, holds no connection). Everything that
 * can be refused without reading the file is refused first, so an AI read is not paid for and then thrown away. The
 * write then locks the document, the report and its accounts, and checks everything again.
 */
import { staffReportRefusal } from '../credit/authorization';
import type { Ctx } from '../auth/context';
import { audit } from '../audit';
import { logEvent } from '../crm';
import type { Db } from '../db';
import { getObject } from '../storage';
import { BUREAU_LABEL, type Bureau } from '../util';
import { readReportFile, ReportReadError, type ReadResult } from './read-file';
import { bureauWord, groupByBureau, insertReadingRows, READING_TABLES, ReportError, type Actor } from './service';

export const REREAD_NOT_PENDING = 'Only a report that is still waiting for review can be read again. To read the file of an approved or rejected report again, upload it as a new report.';
export const REREAD_NO_FILE = 'This report has no stored file to read again.';
export const REREAD_DOCUMENT_REJECTED = 'This document was rejected, so it cannot be read as a report.';
export const REREAD_IN_USE = 'A dispute or a collector notice is attached to an account in this reading, so it cannot be replaced. Approve or reject the report instead.';
export const REREAD_NOTHING = 'Nothing could be read from this file. The earlier reading was kept.';
export const REREAD_UNLABELLED = 'Some rows in this file name no bureau, and the file holds more than one report, so it cannot be told which report they belong to. The earlier reading was kept. To read this file again, upload it as a new report.';
const bureauList = (b: readonly Bureau[]) => b.map((x) => BUREAU_LABEL[x]).join(' and ');
export const rereadNotInFile = (was: Bureau | null, found: readonly Bureau[]) =>
  `Read again, this file holds nothing for ${was ? BUREAU_LABEL[was] : 'this report'}: what was read belongs to ${bureauList(found)}. The earlier reading was kept.`;

export interface RereadResult {
  clientId: string;
  reportId: string;
  /** The bureau the report is filed under now, and the one it was under before when the fresh reading moved it. */
  bureau: Bureau;
  movedFrom: Bureau | null;
  /** What this report holds now. */
  accounts: number;
  collections: number;
  inquiries: number;
  publicRecords: number;
  /** Bureaus the file holds rows for besides this report's. Those rows are not part of this report. */
  alsoHolds: Bureau[];
  via: ReadResult['via'];
  pages?: number;
}

export interface RereadDeps { read?: typeof readReportFile; load?: typeof getObject }

/** A dispute or a collector notice points at one of the reading's accounts. Deleting the account would detach it without a word. */
const attached = (db: Db, reportId: string) => db.row(
  `select 1 from public.tradelines t where t.report_id = $1
      and (exists (select 1 from public.disputes d where d.tradeline_id = t.id) or exists (select 1 from public.collector_notices n where n.tradeline_id = t.id)) limit 1`, [reportId]);

export async function rereadReport(tx: Ctx['tx'], actor: Actor, reportId: string, deps: RereadDeps = {}): Promise<RereadResult> {
  // 1. What is asked for, as the caller may see it (row-level security, and this workspace only), and every refusal
  //    that needs no reading of the file.
  const before = await tx(async (db) => {
    const r = await db.row<{ client_id: string; status: string; document_id: string | null; mime_type: string | null; storage_key: string | null; doc_status: string | null; doc_source: string | null }>(
      `select r.client_id, r.status, r.document_id, d.mime_type, d.storage_key, d.review_status as doc_status, d.source as doc_source
         from public.credit_reports r left join public.documents d on d.id = r.document_id where r.id = $1 and r.org_id = $2`, [reportId, actor.orgId]);
    if (!r) throw new ReportError('Report not found.');
    if (r.status !== 'pending_review') throw new ReportError(REREAD_NOT_PENDING);
    if (!r.document_id || !r.storage_key || !r.mime_type) throw new ReportError(REREAD_NO_FILE);
    if (r.doc_status === 'rejected') throw new ReportError(REREAD_DOCUMENT_REJECTED);
    if (r.doc_source !== 'client') {
      const refused = await staffReportRefusal(db, r.client_id);
      if (refused) throw new ReportError(refused);
    }
    if (await attached(db, reportId)) throw new ReportError(REREAD_IN_USE);
    return { clientId: r.client_id, documentId: r.document_id, mime: r.mime_type, key: r.storage_key };
  });

  // 2. The reading itself. A failure here leaves everything as it was.
  const bytes = await (deps.load ?? getObject)(before.key);
  let read: ReadResult;
  try {
    read = await (deps.read ?? readReportFile)({ bytes, mime: before.mime, name: '' }, { orgId: actor.orgId, userId: actor.userId });
  } catch (e) {
    if (e instanceof ReportReadError) throw new ReportError(e.message);
    throw e;
  }
  const { parsed } = read;
  if (!parsed.tradelines.length && !parsed.inquiries.length && !parsed.publicRecords.length && !parsed.identity.length)
    throw new ReportError(parsed.warnings[0] ?? REREAD_NOTHING);

  // 3. The swap. The document, then the report, then its accounts are locked, in the order a first reading and an
  //    approval take them; a report decided in the meantime is seen here and left alone.
  return tx(async (db) => {
    const doc = await db.row<{ review_status: string; source: string }>(
      'select review_status, source from public.documents where id = $1 and client_id = $2 and org_id = $3 for update', [before.documentId, before.clientId, actor.orgId]);
    if (!doc) throw new ReportError(REREAD_NO_FILE);
    if (doc.review_status === 'rejected') throw new ReportError(REREAD_DOCUMENT_REJECTED);
    const mine = await db.row<{ status: string; bureau: Bureau | null; siblings: number }>(
      `select r.status, r.bureau, (select count(*)::int from public.credit_reports o where o.document_id = r.document_id and o.id <> r.id) as siblings
         from public.credit_reports r where r.id = $1 and r.document_id = $2 and r.org_id = $3 for update of r`, [reportId, before.documentId, actor.orgId]);
    if (!mine) throw new ReportError('Report not found.');
    if (mine.status !== 'pending_review') throw new ReportError(REREAD_NOT_PENDING);
    if (doc.source !== 'client') {
      const refused = await staffReportRefusal(db, before.clientId);
      if (refused) throw new ReportError(refused);
    }
    // The accounts are locked before the look. A dispute or notice being attached at this moment is then either seen
    // here, or waits for this to finish and finds its account gone: it is never detached silently.
    await db.rows('select id from public.tradelines where report_id = $1 for update', [reportId]);
    if (await attached(db, reportId)) throw new ReportError(REREAD_IN_USE);

    // A row that names no bureau belongs to this report when the file is this report alone. In a file with several
    // reports nobody recorded which of them took those rows, so they are not guessed at.
    let grouped: ReturnType<typeof groupByBureau>;
    try { grouped = groupByBureau(parsed, mine.siblings === 0 ? mine.bureau : null); }
    catch (e) {
      if (e instanceof ReportError && mine.siblings > 0) throw new ReportError(REREAD_UNLABELLED);
      throw e;
    }
    const { byBureau, fallback } = grouped;
    const found = [...byBureau.keys()];
    const bureau = mine.bureau && byBureau.has(mine.bureau) ? mine.bureau : mine.siblings === 0 && found.length === 1 ? found[0]! : null;
    if (!bureau) throw new ReportError(rereadNotInFile(mine.bureau, found));
    const rows = byBureau.get(bureau)!;

    const held = await db.run("update public.credit_reports set bureau = $2, report_date = $3, warnings = $4 where id = $1 and status = 'pending_review'",
      [reportId, bureau, parsed.reportDate, JSON.stringify(parsed.warnings)]);
    if (held !== 1) throw new ReportError(REREAD_NOT_PENDING);
    for (const table of READING_TABLES) await db.run(`delete from public.${table} where report_id = $1`, [reportId]);
    await insertReadingRows(db, { orgId: actor.orgId, clientId: before.clientId, reportId, bureau, rows, parsed, fallback });

    const movedFrom = mine.bureau && mine.bureau !== bureau ? mine.bureau : null;
    await logEvent(db, actor, before.clientId, 'report_uploaded', `${bureauWord(bureau)} report read again (${rows.t.length} accounts) — awaiting review`);
    await audit(db, { orgId: actor.orgId, actorId: actor.userId, action: 'report.reread', entityType: 'credit_report', entityId: reportId, ip: actor.meta?.ip,
      meta: { bureau, accounts: rows.t.length, via: read.via, ...(movedFrom ? { moved_from: movedFrom } : {}) } });

    const collections = rows.t.filter((t) => t.item_type === 'collection').length;
    return {
      clientId: before.clientId, reportId, bureau, movedFrom,
      accounts: rows.t.length - collections, collections, inquiries: rows.i.length, publicRecords: rows.p.length,
      alsoHolds: found.filter((b) => b !== bureau), via: read.via, pages: read.pages,
    };
  });
}
