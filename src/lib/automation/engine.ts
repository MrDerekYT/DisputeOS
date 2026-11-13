import type { Db } from '../db';
import { assertNoBlockedClaims } from '../compliance/claims';

/**
 * Automation engine. Design rules (each is enforced here and covered by tests):
 *  1. Idempotent: one run per (automation, subject, cooldown bucket) — a duplicate message is impossible by construction
 *     (unique index on automation_runs + ON CONFLICT DO NOTHING).
 *  2. Human in the loop: client-facing actions wait in the Inbox for approval unless an admin explicitly turns that off.
 *  3. No mass sends: sweeps are capped per automation per run (max_subjects_per_run).
 *  4. Only admins configure automations (RLS + RBAC); automation text is checked against the blocked-claims guard.
 *  5. Everything leaves an audit trail (automation_runs + client timeline + notifications).
 */
export const TRIGGERS = {
  client_created: { label: 'A client is created', kind: 'event' },
  report_uploaded: { label: 'A credit report is uploaded', kind: 'event' },
  dispute_status_changed: { label: 'A dispute changes status', kind: 'event' },
  missing_documents: { label: 'Requested documents are still missing', kind: 'sweep' },
  dispute_deadline: { label: 'An investigation deadline is approaching', kind: 'sweep' },
  client_inactive: { label: 'A client has been inactive', kind: 'sweep' },
  weekly_digest: { label: 'Weekly summary', kind: 'sweep' },
} as const;
export type TriggerKey = keyof typeof TRIGGERS;

export const ACTION_TYPES = {
  create_task: { label: 'Create a task for the team', clientFacing: false },
  notify_staff: { label: 'Notify the assigned specialist (or admins)', clientFacing: false },
  portal_message: { label: 'Send a portal message to the client', clientFacing: true },
  request_document: { label: 'Request a document from the client', clientFacing: true },
} as const;
export type ActionType = keyof typeof ACTION_TYPES;

export interface ActionDef {
  type: ActionType;
  title?: string; // task / notification title
  body?: string; // message / detail
  kind?: string; // document kind
  dueInDays?: number;
}

export interface Conditions {
  days?: number; // client_inactive
  afterDays?: number; // missing_documents
  withinDays?: number; // dispute_deadline
  toStatus?: string; // dispute_status_changed
}

export interface AutomationRow {
  id: string; org_id: string; name: string; trigger: TriggerKey; conditions: Conditions; actions: ActionDef[];
  enabled: boolean; requires_approval: boolean; max_subjects_per_run: number; cooldown_days: number;
}

export interface Subject { type: 'client' | 'dispute' | 'org'; id: string }
export interface Actor { orgId: string; userId: string | null }

export const isClientFacing = (a: ActionDef) => ACTION_TYPES[a.type]?.clientFacing ?? false;

/** Only these placeholders exist; anything else renders empty rather than leaking data. */
const MERGE = /\{\{\s*(client_first_name|client_name|org_name|item|due_date|count)\s*\}\}/g;
export const render = (text: string, vars: Record<string, string>) => text.replace(MERGE, (_, k: string) => vars[k] ?? '');

export function validateActions(actions: ActionDef[]): string | null {
  if (!actions.length) return 'Add at least one action.';
  for (const a of actions) {
    if (!(a.type in ACTION_TYPES)) return `Unknown action: ${a.type}`;
    for (const t of [a.title, a.body]) {
      if (!t) continue;
      try { assertNoBlockedClaims(t); } catch (e) { return (e as Error).message; }
    }
    if (a.type === 'create_task' && !a.title) return 'A task needs a title.';
    if (a.type === 'notify_staff' && !a.title) return 'A notification needs a title.';
    if (a.type === 'portal_message' && !a.body) return 'A portal message needs text.';
    if (a.type === 'request_document' && !a.kind) return 'Choose which document to request.';
  }
  return null;
}

interface Resolved { clientId: string | null; clientName: string; assignedTo: string | null; item: string; due: string }

async function resolveSubject(db: Db, orgId: string, s: Subject): Promise<Resolved | null> {
  if (s.type === 'client') {
    const c = await db.row<{ id: string; full_name: string; assigned_to: string | null }>('select id, full_name, assigned_to from public.clients where id = $1 and org_id = $2', [s.id, orgId]);
    return c ? { clientId: c.id, clientName: c.full_name, assignedTo: c.assigned_to, item: '', due: '' } : null;
  }
  if (s.type === 'dispute') {
    const d = await db.row<{ client_id: string; full_name: string; assigned_to: string | null; item_label: string; due_at: string | null }>(
      `select d.client_id, c.full_name, coalesce(d.assigned_to, c.assigned_to) as assigned_to, d.item_label, d.due_at
         from public.disputes d join public.clients c on c.id = d.client_id where d.id = $1 and d.org_id = $2`, [s.id, orgId]);
    return d ? { clientId: d.client_id, clientName: d.full_name, assignedTo: d.assigned_to, item: d.item_label, due: d.due_at ? d.due_at.slice(0, 10) : '' } : null;
  }
  return { clientId: null, clientName: '', assignedTo: null, item: '', due: '' };
}

async function recipients(db: Db, orgId: string, assignedTo: string | null): Promise<string[]> {
  if (assignedTo) return [assignedTo];
  return (await db.rows<{ user_id: string }>("select user_id from public.memberships where org_id = $1 and role in ('owner','admin')", [orgId])).map((r) => r.user_id);
}

async function performAction(db: Db, orgId: string, actorId: string | null, a: ActionDef, r: Resolved, s: Subject, dedupe: string, approver: string | null, extra: Record<string, string> = {}) {
  const vars = { client_first_name: r.clientName.split(' ')[0] ?? '', client_name: r.clientName, org_name: '', item: r.item, due_date: r.due, ...extra };
  const title = render(a.title ?? '', vars);
  const body = render(a.body ?? '', vars);
  switch (a.type) {
    case 'create_task': {
      await db.run(
        `insert into public.tasks (org_id, client_id, dispute_id, assignee_id, created_by, title, detail, kind, due_at, source, dedupe_key)
         values ($1, $2, $3, $4, $5, $6, $7, 'follow_up', now() + ($8 || ' days')::interval, 'automation', $9) on conflict do nothing`,
        [orgId, r.clientId, s.type === 'dispute' ? s.id : null, r.assignedTo, actorId, title, body || null, String(a.dueInDays ?? 2), `auto:${dedupe}`],
      );
      break;
    }
    case 'notify_staff': {
      for (const uid of await recipients(db, orgId, r.assignedTo)) {
        await db.run('insert into public.notifications (org_id, user_id, title, body, href) values ($1, $2, $3, $4, $5)',
          [orgId, uid, title, body || null, r.clientId ? `/app/clients/${r.clientId}` : '/app']);
      }
      break;
    }
    case 'portal_message': {
      if (!r.clientId) break;
      await db.run(
        `insert into public.communications (org_id, client_id, direction, channel, subject, body, status, author_id, approved_by)
         values ($1, $2, 'outbound', 'portal', $3, $4, 'sent', null, $5)`, [orgId, r.clientId, title || null, body, approver]);
      break;
    }
    case 'request_document': {
      if (!r.clientId || !a.kind) break;
      await db.run(
        `insert into public.document_requests (org_id, client_id, kind, note, created_by)
         select $1, $2, $3, $4, $5 where not exists (select 1 from public.document_requests where client_id = $2 and kind = $3 and fulfilled_document_id is null)`,
        [orgId, r.clientId, a.kind, body || null, approver]);
      break;
    }
  }
  if (r.clientId) {
    await db.run(`insert into public.client_events (org_id, client_id, actor_id, kind, summary, meta) values ($1, $2, $3, 'automation', $4, $5)`,
      [orgId, r.clientId, actorId, `Automation: ${(ACTION_TYPES[a.type]?.label ?? a.type)}`, JSON.stringify({ automation_dedupe: dedupe })]);
  }
}

export interface RunOutcome { status: 'completed' | 'pending_approval' | 'skipped'; runId?: string }

/** Plan + (conditionally) execute one automation for one subject. Safe to call repeatedly. */
export async function executeAutomation(db: Db, actor: Actor, a: AutomationRow, s: Subject, bucket: string, extra: Record<string, string> = {}, cooldownNow?: Date): Promise<RunOutcome> {
  const resolved = await resolveSubject(db, actor.orgId, s);
  if (!resolved) return { status: 'skipped' };
  // Rolling cooldown (sweeps): never touch the same subject again within `cooldown_days` of the previous run,
  // even if a calendar bucket boundary falls in between.
  if (cooldownNow && a.cooldown_days > 0) {
    const recent = await db.row(
      "select 1 from public.automation_runs where automation_id = $1 and subject_id = $2 and status <> 'cancelled' and created_at > $3::timestamptz - ($4 || ' days')::interval limit 1",
      [a.id, s.id, cooldownNow, String(a.cooldown_days)]);
    if (recent) return { status: 'skipped' };
  }
  const dedupe = `${s.id}:${bucket}`;
  const clientFacing = a.actions.filter(isClientFacing);
  const internal = a.actions.filter((x) => !isClientFacing(x));
  const needsApproval = clientFacing.length > 0 && a.requires_approval;

  const vars = { client_first_name: resolved.clientName.split(' ')[0] ?? '', client_name: resolved.clientName, org_name: '', item: resolved.item, due_date: resolved.due, ...extra };
  const planned = clientFacing.map((x) => ({ ...x, title: render(x.title ?? '', vars), body: render(x.body ?? '', vars) }));

  const run = await db.row<{ id: string }>(
    `insert into public.automation_runs (org_id, automation_id, dedupe_key, subject_type, subject_id, status, result)
     values ($1, $2, $3, $4, $5, $6, $7) on conflict (automation_id, dedupe_key) do nothing returning id`,
    [actor.orgId, a.id, dedupe, s.type, s.id, needsApproval ? 'pending_approval' : 'completed', JSON.stringify({ planned: needsApproval ? planned : [], client_id: resolved.clientId, client_name: resolved.clientName, automation: a.name })],
  );
  if (!run) return { status: 'skipped' }; // already ran for this subject in this window

  for (const x of internal) await performAction(db, actor.orgId, actor.userId, x, resolved, s, `${a.id}:${dedupe}:${x.type}`, null, extra);
  if (!needsApproval) for (const x of clientFacing) await performAction(db, actor.orgId, actor.userId, x, resolved, s, `${a.id}:${dedupe}:${x.type}`, null, extra);
  if (needsApproval) {
    for (const uid of await recipients(db, actor.orgId, resolved.assignedTo)) {
      await db.run('insert into public.notifications (org_id, user_id, title, body, href) values ($1, $2, $3, $4, $5)',
        [actor.orgId, uid, `Approval needed: ${a.name}`, `A message for ${resolved.clientName} is waiting for your review.`, '/app/inbox']);
    }
  }
  return { status: needsApproval ? 'pending_approval' : 'completed', runId: run.id };
}

/** Event triggers, fired inline by the action that caused them (same transaction, same user). */
export async function fireTrigger(db: Db, actor: { orgId: string; userId: string }, trigger: TriggerKey, subject: Subject, extra: { toStatus?: string } & Record<string, string | undefined> = {}) {
  const autos = await db.rows<AutomationRow>('select * from public.automations where org_id = $1 and enabled and trigger = $2', [actor.orgId, trigger]);
  for (const a of autos) {
    if (trigger === 'dispute_status_changed' && a.conditions.toStatus && a.conditions.toStatus !== extra.toStatus) continue;
    const ex = Object.fromEntries(Object.entries(extra).filter(([, v]) => v != null)) as Record<string, string>;
    await executeAutomation(db, actor, a, subject, extra.toStatus ?? 'once', ex);
  }
}

// ---------------------------------------------------------------- scheduled sweeps
export interface SweepSummary { automation: string; matched: number; executed: number; pending: number; skipped: number; capped: boolean }

async function findSubjects(db: Db, orgId: string, a: AutomationRow, limit: number): Promise<Subject[]> {
  const c = a.conditions;
  switch (a.trigger) {
    case 'missing_documents':
      return (await db.rows<{ id: string }>(
        `select c.id from public.clients c where c.org_id = $1 and c.status in ('lead','onboarding','active')
           and exists (select 1 from public.document_requests r where r.client_id = c.id and r.fulfilled_document_id is null and r.created_at < now() - ($2 || ' days')::interval)
         order by c.last_activity_at limit $3`, [orgId, String(c.afterDays ?? 3), limit + 1])).map((r) => ({ type: 'client', id: r.id }));
    case 'dispute_deadline':
      return (await db.rows<{ id: string }>(
        `select id from public.disputes where org_id = $1 and status in ('submitted','under_investigation') and due_at is not null
            and due_at < now() + ($2 || ' days')::interval order by due_at limit $3`, [orgId, String(c.withinDays ?? 5), limit + 1])).map((r) => ({ type: 'dispute', id: r.id }));
    case 'client_inactive':
      return (await db.rows<{ id: string }>(
        `select id from public.clients where org_id = $1 and status = 'active' and last_activity_at < now() - ($2 || ' days')::interval
         order by last_activity_at limit $3`, [orgId, String(c.days ?? 30), limit + 1])).map((r) => ({ type: 'client', id: r.id }));
    case 'weekly_digest':
      return [{ type: 'org', id: orgId }];
    default:
      return [];
  }
}

export async function runSweeps(db: Db, actor: Actor, now = new Date()): Promise<SweepSummary[]> {
  const autos = await db.rows<AutomationRow>("select * from public.automations where org_id = $1 and enabled and trigger in ('missing_documents','dispute_deadline','client_inactive','weekly_digest')", [actor.orgId]);
  const out: SweepSummary[] = [];
  for (const a of autos) {
    const cap = a.max_subjects_per_run;
    const subjects = await findSubjects(db, actor.orgId, a, cap);
    const capped = subjects.length > cap;
    const bucket = `w${Math.floor(now.getTime() / 86_400_000 / Math.max(a.cooldown_days, 1))}`;
    const sum: SweepSummary = { automation: a.name, matched: subjects.length, executed: 0, pending: 0, skipped: 0, capped };
    for (const s of subjects.slice(0, cap)) {
      if (a.trigger === 'weekly_digest') {
        const stats = await db.row<{ open_tasks: number; due_soon: number; clients: number }>(
          `select (select count(*)::int from public.tasks where org_id = $1 and status = 'open') as open_tasks,
                  (select count(*)::int from public.disputes where org_id = $1 and status in ('submitted','under_investigation') and due_at < now() + interval '7 days') as due_soon,
                  (select count(*)::int from public.clients where org_id = $1 and status = 'active') as clients`, [actor.orgId]);
        const body = `${stats?.clients ?? 0} active clients · ${stats?.open_tasks ?? 0} open tasks · ${stats?.due_soon ?? 0} investigation deadlines in the next 7 days.`;
        const run = await db.row<{ id: string }>(
          `insert into public.automation_runs (org_id, automation_id, dedupe_key, subject_type, subject_id, status, result) values ($1, $2, $3, 'org', $1, 'completed', $4)
           on conflict (automation_id, dedupe_key) do nothing returning id`, [actor.orgId, a.id, `${s.id}:${bucket}`, JSON.stringify({ digest: body })]);
        if (!run) { sum.skipped++; continue; }
        for (const uid of await recipients(db, actor.orgId, null))
          await db.run('insert into public.notifications (org_id, user_id, title, body, href) values ($1, $2, $3, $4, $5)', [actor.orgId, uid, 'Your weekly summary', body, '/app/analytics']);
        sum.executed++;
        continue;
      }
      const r = await executeAutomation(db, actor, a, s, bucket, {}, now);
      if (r.status === 'completed') sum.executed++;
      else if (r.status === 'pending_approval') sum.pending++;
      else sum.skipped++;
    }
    if (capped) {
      for (const uid of await recipients(db, actor.orgId, null))
        await db.run('insert into public.notifications (org_id, user_id, title, body, href) values ($1, $2, $3, $4, $5)',
          [actor.orgId, uid, `Automation capped: ${a.name}`, `More than ${cap} items matched. Only the first ${cap} were processed this run; the rest follow on later runs.`, '/app/automations']);
    }
    out.push(sum);
  }
  return out;
}

/** Approve or cancel a pending run. Approving performs exactly the text that was shown to the reviewer. */
export async function decideRun(db: Db, actor: { orgId: string; userId: string }, runId: string, decision: 'approve' | 'cancel'): Promise<boolean> {
  const run = await db.row<{ id: string; automation_id: string; subject_type: Subject['type']; subject_id: string; result: { planned?: ActionDef[] } }>(
    "select id, automation_id, subject_type, subject_id, result from public.automation_runs where id = $1 and org_id = $2 and status = 'pending_approval' for update", [runId, actor.orgId]);
  if (!run) return false;
  if (decision === 'approve') {
    const resolved = await resolveSubject(db, actor.orgId, { type: run.subject_type, id: run.subject_id });
    if (resolved) for (const x of run.result.planned ?? []) await performAction(db, actor.orgId, actor.userId, x, resolved, { type: run.subject_type, id: run.subject_id }, `${run.automation_id}:${run.subject_id}:approved:${x.type}:${runId}`, actor.userId);
  }
  await db.run('update public.automation_runs set status = $2, decided_by = $3 where id = $1', [runId, decision === 'approve' ? 'completed' : 'cancelled', actor.userId]);
  return true;
}
