import type { Db } from './db';
import { withSystem } from './db';

export interface AuditInput {
  orgId: string | null;
  actorId?: string | null;
  actorLabel?: string;
  action: string;
  entityType?: string;
  entityId?: string | null;
  ip?: string | null;
  /** Never put PII, report contents or message bodies here. Ids, counts and status names only. */
  meta?: Record<string, string | number | boolean | null>;
}

const SQL = `insert into public.audit_logs (org_id, actor_id, actor_label, action, entity_type, entity_id, ip, metadata)
             values ($1, $2, $3, $4, $5, $6, $7, $8)`;

/** Inside a tenant transaction (RLS requires actor = current user and org membership). */
export async function audit(db: Db, a: AuditInput) {
  await db.run(SQL, [a.orgId, a.actorId ?? null, a.actorLabel ?? null, a.action, a.entityType ?? null, a.entityId ?? null, a.ip ?? null, JSON.stringify(a.meta ?? {})]);
}

/** Outside a user context (failed logins, webhooks, scheduled jobs). */
export async function auditSystem(a: AuditInput) {
  await withSystem((db) => audit(db, a));
}
