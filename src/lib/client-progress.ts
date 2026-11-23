/**
 * Where a client is, read from their own file: the status (Onboarding, Active…) and the stage of the journey (Intake,
 * Analysis, Disputing, Monitoring, Graduated). Rules over real records only, never a guess:
 *  - Active once a service agreement is in force; Onboarding before. Paused, Completed and Cancelled are a person's
 *    decision and are never suggested away.
 *  - Disputing while a dispute is with a bureau or creditor (sent, under investigation, answered); Monitoring once
 *    disputes were sent and none is still open; Analysis once there is a credit report or a dispute being drafted;
 *    Intake before. Graduated is a person's decision.
 *
 * The client page moves a client forward on its own (Onboarding → Active, Intake → … → Monitoring) when the file shows
 * it, never backward, and not over a choice a person made after the latest change in the file.
 */
import type { Db } from './db';
import { CLIENT_STAGES, CLIENT_STATUSES, logEvent, STAGE_LABEL } from './crm';

export type ClientStatus = (typeof CLIENT_STATUSES)[number];
export type ClientStage = (typeof CLIENT_STAGES)[number];

export interface ProgressFacts {
  status: ClientStatus;
  stage: ClientStage;
  /** A service agreement (croa_contract) signed and not revoked. */
  contract: boolean;
  /** Credit reports on file that were not rejected. */
  reports: number;
  /** Disputes being prepared (draft, ready for review, approved, on hold). */
  drafting: number;
  /** Disputes with a bureau or creditor now (submitted, under investigation, response received). */
  open: number;
  /** Disputes that were sent at some point (open ones and resolved ones). */
  sent: number;
}

export interface Suggestion { status: ClientStatus; stage: ClientStage; why: string[] }

const FIXED_STATUS: readonly ClientStatus[] = ['paused', 'completed', 'cancelled'];
export const STATUS_LABEL: Record<ClientStatus, string> = {
  lead: 'Lead', onboarding: 'Onboarding', active: 'Active', paused: 'Paused', completed: 'Completed', cancelled: 'Cancelled',
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** What the file says the status and stage should be, with the reasons in plain words. */
export function suggestProgress(f: ProgressFacts): Suggestion {
  const why: string[] = [];
  let status: ClientStatus = f.status;
  if (!FIXED_STATUS.includes(f.status)) {
    if (f.contract) { status = 'active'; why.push('Service agreement signed'); }
    else if (f.status !== 'lead') { status = 'onboarding'; why.push('No service agreement in force yet'); }
  }
  let stage: ClientStage;
  if (f.stage === 'graduated') stage = 'graduated';
  else if (f.open > 0) { stage = 'disputing'; why.push(`${plural(f.open, 'dispute')} with the bureaus or creditors`); }
  else if (f.sent > 0) { stage = 'monitoring'; why.push(`${plural(f.sent, 'dispute')} sent, none still open`); }
  else if (f.reports > 0 || f.drafting > 0) {
    stage = 'analysis';
    why.push([f.reports ? `${plural(f.reports, 'credit report')} on file` : '', f.drafting ? `${plural(f.drafting, 'dispute')} being prepared` : ''].filter(Boolean).join(', '));
  } else { stage = 'intake'; why.push('No credit report on file yet'); }
  return { status, stage, why };
}

const STATUS_RANK: Record<ClientStatus, number> = { lead: 0, onboarding: 1, active: 2, paused: -1, completed: -1, cancelled: -1 };

/** The forward-only part of a suggestion: what the page may change on its own. Null fields stay as they are. */
export function autoAdvance(f: ProgressFacts, s: Suggestion): { status: ClientStatus | null; stage: ClientStage | null } {
  const statusUp = STATUS_RANK[f.status] >= 0 && STATUS_RANK[s.status] > STATUS_RANK[f.status];
  const stageUp = CLIENT_STAGES.indexOf(s.stage) > CLIENT_STAGES.indexOf(f.stage) && s.stage !== 'graduated';
  return { status: statusUp ? s.status : null, stage: stageUp ? s.stage : null };
}

/** The facts for one client, read under the caller's row-level security. Null when the client is not visible. */
export async function loadProgressFacts(db: Db, clientId: string): Promise<(ProgressFacts & { manualAfterFile: boolean }) | null> {
  return db.row<ProgressFacts & { manualAfterFile: boolean }>(
    `select c.status, c.stage,
            exists (select 1 from public.client_consents k where k.client_id = c.id and k.kind = 'croa_contract' and k.revoked_at is null) as contract,
            (select count(*)::int from public.credit_reports r where r.client_id = c.id and r.status <> 'rejected') as reports,
            (select count(*)::int from public.disputes d where d.client_id = c.id and d.status in ('draft', 'ready_for_review', 'approved', 'on_hold')) as drafting,
            (select count(*)::int from public.disputes d where d.client_id = c.id and d.status in ('submitted', 'under_investigation', 'response_received')) as open,
            (select count(*)::int from public.disputes d where d.client_id = c.id and d.status in ('submitted', 'under_investigation', 'response_received', 'resolved')) as sent,
            coalesce((select max(e.created_at) from public.client_events e
                       where e.client_id = c.id and e.kind in ('status_changed', 'stage_changed') and coalesce((e.meta->>'auto')::boolean, false) = false)
                     > greatest((select max(r.created_at) from public.credit_reports r where r.client_id = c.id),
                                (select max(d.updated_at) from public.disputes d where d.client_id = c.id),
                                (select max(k.signed_at) from public.client_consents k where k.client_id = c.id),
                                c.created_at), false) as "manualAfterFile"
       from public.clients c where c.id = $1`, [clientId]);
}

/**
 * Moves the client forward when their file shows it (see autoAdvance), unless a person set the status or stage after
 * the latest change in the file. Logged on the timeline as an automatic update. Returns what changed.
 */
export async function syncClientProgress(db: Db, actor: { orgId: string; userId: string }, clientId: string): Promise<{ status: ClientStatus | null; stage: ClientStage | null }> {
  const f = await loadProgressFacts(db, clientId);
  const none = { status: null, stage: null };
  if (!f || f.manualAfterFile) return none;
  const up = autoAdvance(f, suggestProgress(f));
  if (!up.status && !up.stage) return none;
  await db.run('update public.clients set status = coalesce($2, status), stage = coalesce($3, stage) where id = $1', [clientId, up.status, up.stage]);
  if (up.status) await logEvent(db, actor, clientId, 'status_changed', `Status updated from the client’s file: ${STATUS_LABEL[f.status]} → ${STATUS_LABEL[up.status]}`, { auto: true });
  if (up.stage) await logEvent(db, actor, clientId, 'stage_changed', `Stage updated from the client’s file: ${STAGE_LABEL[f.stage]} → ${STAGE_LABEL[up.stage]}`, { auto: true });
  return up;
}
