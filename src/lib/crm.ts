import type { Db } from './db';
import type { Ctx } from './auth/context';

export const CLIENT_STATUSES = ['lead', 'onboarding', 'active', 'paused', 'completed', 'cancelled'] as const;
export const CLIENT_STAGES = ['intake', 'analysis', 'disputing', 'monitoring', 'graduated'] as const;
export const STAGE_LABEL: Record<(typeof CLIENT_STAGES)[number], string> = {
  intake: 'Intake', analysis: 'Analysis', disputing: 'Disputing', monitoring: 'Monitoring', graduated: 'Graduated',
};
export const DOC_KINDS = ['id', 'proof_of_address', 'ssn_proof', 'credit_report', 'bureau_response', 'ftc_report', 'police_report', 'contract', 'evidence', 'other'] as const;
export const DOC_KIND_LABEL: Record<string, string> = {
  id: 'Photo ID', proof_of_address: 'Proof of address', ssn_proof: 'Proof of SSN', credit_report: 'Credit report',
  bureau_response: 'Bureau response', ftc_report: 'FTC identity theft report', police_report: 'Police report',
  contract: 'Contract', evidence: 'Supporting evidence', other: 'Other',
};

export const SEGMENTS = [
  { key: 'all', label: 'All clients' },
  { key: 'mine', label: 'Assigned to me' },
  { key: 'onboarding', label: 'Onboarding' },
  { key: 'needs_docs', label: 'Needs documents' },
  { key: 'active_disputes', label: 'Active disputes' },
  { key: 'inactive', label: 'Inactive 30+ days' },
  { key: 'unassigned', label: 'Unassigned' },
] as const;
export type SegmentKey = (typeof SEGMENTS)[number]['key'];

export interface ClientListRow {
  id: string; full_name: string; email: string | null; phone: string | null; status: string; stage: string; tags: string[];
  last_activity_at: string; created_at: string; assigned_to: string | null; assignee_name: string | null;
  active_disputes: number; open_requests: number;
}

export interface ClientQuery {
  q?: string; status?: string; segment?: string; assignee?: string; page?: number; pageSize?: number; userId: string;
}

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (m) => `\\${m}`);

export async function listClients(db: Db, f: ClientQuery): Promise<{ rows: ClientListRow[]; total: number }> {
  const where: string[] = [];
  const p: (string | number)[] = [];
  const add = (v: string | number) => { p.push(v); return `$${p.length}`; };

  if (f.q?.trim()) {
    const like = `%${escapeLike(f.q.trim().slice(0, 80))}%`;
    const n = add(like);
    where.push(`(c.full_name ilike ${n} or c.email ilike ${n} or c.phone ilike ${n})`);
  }
  if (f.status && (CLIENT_STATUSES as readonly string[]).includes(f.status)) where.push(`c.status = ${add(f.status)}`);
  if (f.assignee === 'none') where.push('c.assigned_to is null');
  else if (f.assignee && /^[0-9a-f-]{36}$/i.test(f.assignee)) where.push(`c.assigned_to = ${add(f.assignee)}`);
  switch (f.segment) {
    case 'mine': where.push(`c.assigned_to = ${add(f.userId)}`); break;
    case 'unassigned': where.push('c.assigned_to is null'); break;
    case 'onboarding': where.push("c.status in ('lead', 'onboarding')"); break;
    case 'needs_docs': where.push('exists (select 1 from public.document_requests r where r.client_id = c.id and r.fulfilled_document_id is null)'); break;
    case 'active_disputes': where.push("exists (select 1 from public.disputes d where d.client_id = c.id and d.status in ('submitted', 'under_investigation', 'response_received'))"); break;
    case 'inactive': where.push("c.status = 'active' and c.last_activity_at < now() - interval '30 days'"); break;
  }
  const w = where.length ? `where ${where.join(' and ')}` : '';
  const size = Math.min(Math.max(f.pageSize ?? 25, 1), 100);
  const offset = (Math.max(f.page ?? 1, 1) - 1) * size;

  const total = (await db.row<{ n: number }>(`select count(*)::int as n from public.clients c ${w}`, p))?.n ?? 0;
  const rows = await db.rows<ClientListRow>(
    `select c.id, c.full_name, c.email, c.phone, c.status, c.stage, c.tags, c.last_activity_at, c.created_at, c.assigned_to,
            u.full_name as assignee_name,
            (select count(*)::int from public.disputes d where d.client_id = c.id and d.status in ('submitted', 'under_investigation', 'response_received')) as active_disputes,
            (select count(*)::int from public.document_requests r where r.client_id = c.id and r.fulfilled_document_id is null) as open_requests
       from public.clients c left join public.users u on u.id = c.assigned_to
       ${w} order by c.last_activity_at desc, c.created_at desc limit ${size} offset ${offset}`,
    p,
  );
  return { rows, total };
}

/** Writes to the client's activity timeline and bumps last_activity_at. */
export async function logEvent(db: Db, ctx: Pick<Ctx, 'orgId' | 'userId'>, clientId: string, kind: string, summary: string, meta: Record<string, unknown> = {}) {
  await db.run(
    'insert into public.client_events (org_id, client_id, actor_id, kind, summary, meta) values ($1, $2, $3, $4, $5, $6)',
    [ctx.orgId, clientId, ctx.userId, kind, summary.slice(0, 300), JSON.stringify(meta)],
  );
  await db.run('update public.clients set last_activity_at = now() where id = $1', [clientId]);
}

export async function staffMembers(db: Db) {
  return db.rows<{ id: string; full_name: string; email: string; role: string }>(
    `select u.id, u.full_name, u.email, m.role from public.memberships m join public.users u on u.id = m.user_id
      where m.role <> 'client' order by u.full_name, u.email`,
  );
}

export const memberLabel = (m: { full_name: string; email: string }) => m.full_name || m.email;
