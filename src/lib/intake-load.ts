import type { Db } from './db';
import { UserError } from './errors';
import { businessToday } from './letters/service';
import { INTAKE_ITEMS, INTAKE_REQUIRED, intakeStatus, intakeSummary, type IntakeDoc, type IntakeItem, type IntakeStatus } from './intake';

const COLS = "id, kind, file_name, review_status, review_note, to_char(doc_date, 'YYYY-MM-DD') as doc_date, to_char(expires_on, 'YYYY-MM-DD') as expires_on, created_at";

/**
 * One client's intake documents. Run inside the caller's tenant transaction: row-level security limits the rows to the
 * caller's organization (staff) or to the client's own documents (portal), so no other client's files can be read here.
 */
export async function loadIntakeDocs(db: Db, clientId: string): Promise<IntakeDoc[]> {
  return db.rows<IntakeDoc>(`select ${COLS} from public.documents where client_id = $1 and kind = any($2) order by created_at desc`, [clientId, INTAKE_ITEMS.map((i) => i.key)]);
}

export async function loadIntake(db: Db, clientId: string, items: IntakeItem[] = INTAKE_REQUIRED): Promise<IntakeStatus[]> {
  return intakeStatus(await loadIntakeDocs(db, clientId), businessToday(), items);
}

/** Thrown when a bureau or specialty agency dispute is about to be recorded as sent without accepted identity documents and nobody confirmed it. */
export class IdentityDocsNotConfirmed extends UserError {}

/**
 * The check before a dispute is recorded as sent. It never blocks for good: a consumer may dispute without identity
 * documents and the recipient may simply ask for them, so `sendAnyway` is all it takes. Disputes addressed to a credit
 * bureau or a specialty agency are checked; letters to a creditor or collector are not. Returns the labels of the items that were not accepted (empty when there is nothing to note),
 * and leaves a note on the dispute when it was sent anyway. The consent and approved-letter gates are separate and
 * unchanged (transitionDispute).
 */
export async function confirmIdentityDocs(db: Db, actor: { orgId: string; userId: string }, disputeId: string, sendAnyway: boolean): Promise<string[]> {
  const d = await db.row<{ client_id: string; target_type: string }>('select client_id, target_type from public.disputes where id = $1', [disputeId]);
  if (!d || (d.target_type !== 'bureau' && d.target_type !== 'agency')) return [];
  const missing = intakeSummary(await loadIntake(db, d.client_id)).notAccepted.map((s) => s.item.label.en);
  if (missing.length === 0) return [];
  if (!sendAnyway) {
    throw new IdentityDocsNotConfirmed(`Identity documents not accepted yet: ${missing.join(', ')}. ${d.target_type === 'agency' ? 'The agency' : 'The bureau'} may ask for them. Tick “Send without the identity documents” to record the submission anyway.`);
  }
  await db.run('insert into public.dispute_events (org_id, dispute_id, actor_id, kind, note) values ($1, $2, $3, $4, $5)',
    [actor.orgId, disputeId, actor.userId, 'note', `Sent without accepted identity documents: ${missing.join(', ')}.`]);
  return missing;
}
