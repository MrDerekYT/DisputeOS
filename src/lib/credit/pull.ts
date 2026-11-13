import type { Db } from '../db';
import { audit } from '../audit';
import { UserError } from '../errors';
import { can, PermissionError, type Role } from '../rbac';
import { storeParsedReport } from '../reports/service';
import { rateLimit } from '../auth/rate-limit';
import { getProvider } from './providers';
import { ingestBody, toParsed, type ReportInput } from './schema';

export class CreditError extends UserError {}

export interface CActor { orgId: string; userId: string; role: Role; label?: string; meta?: { ip?: string | null } }
type Tx = <T>(fn: (db: Db) => Promise<T>) => Promise<T>;

/**
 * FCRA: a report may be obtained only with a permissible purpose; for a credit repair business that means the consumer's
 * written authorization. We require a current, un-revoked `fcra_authorization` consent on file before ANY automatic
 * import — pulled or pushed — and record which consent was relied on.
 */
async function requireAuthorization(db: Db, clientId: string): Promise<{ consentId: string; client: { full_name: string; address: Record<string, string>; status: string } }> {
  const client = await db.row<{ full_name: string; address: Record<string, string>; status: string }>('select full_name, address, status from public.clients where id = $1', [clientId]);
  if (!client) throw new CreditError('Client not found.');
  if (client.status === 'cancelled') throw new CreditError('This client is cancelled; reports cannot be imported.');
  const consent = await db.row<{ id: string }>("select id from public.client_consents where client_id = $1 and kind = 'fcra_authorization' and revoked_at is null order by signed_at desc limit 1", [clientId]);
  if (!consent) throw new CreditError('Record the client’s written authorization to review their credit reports before importing one automatically.');
  return { consentId: consent.id, client };
}

async function importReports(db: Db, actor: CActor, clientId: string, reports: ReportInput[]): Promise<string[]> {
  const ids: string[] = [];
  for (const r of reports) ids.push(...(await storeParsedReport(db, actor, { clientId, parsed: toParsed(r), source: 'provider' })));
  return ids;
}

/** Ask a provider adapter for the client's reports. They land in "pending review" like any upload. */
export async function requestReportPull(tx: Tx, actor: CActor, input: { clientId: string; provider: string }): Promise<{ pullId: string; reportIds: string[] }> {
  if (!can(actor.role, 'reports:write')) throw new PermissionError('reports:write');
  const provider = getProvider(input.provider);
  if (!provider) throw new CreditError('That provider is not available. Providers that need partner approval cannot be used until an adapter is installed.');
  const rl = await rateLimit(`pull:client:${input.clientId}`, 5, 3600);
  if (!rl.allowed) throw new CreditError('This client already had several pulls this hour. Try again later.');

  const start = await tx(async (db) => {
    const { consentId, client } = await requireAuthorization(db, input.clientId);
    const p = await db.row<{ id: string }>(
      `insert into public.report_pulls (org_id, client_id, provider, mode, consent_id, requested_by, actor_label) values ($1,$2,$3,'pull',$4,$5,$6) returning id`,
      [actor.orgId, input.clientId, provider.key, consentId, actor.userId, actor.label ?? null]);
    return { pullId: p!.id, client };
  });

  let result;
  try {
    result = await provider.pull({ clientId: input.clientId, fullName: start.client.full_name, address: start.client.address });
    // Never trust an adapter's output: it must satisfy the same strict schema as the public API.
    const checked = ingestBody.safeParse({ external_ref: result.externalRef, reports: result.reports });
    if (!checked.success) throw new Error(`Provider returned invalid data: ${checked.error.issues[0]?.path.join('.')} ${checked.error.issues[0]?.message}`);
    result = { externalRef: result.externalRef, reports: checked.data.reports };
  } catch (e) {
    await tx((db) => db.run("update public.report_pulls set status = 'failed', error = $2, completed_at = now() where id = $1", [start.pullId, (e as Error).message.slice(0, 500)]));
    throw new CreditError(`The provider could not return a report: ${(e as Error).message.slice(0, 200)}`);
  }

  const reportIds = await tx(async (db) => {
    const ids = await importReports(db, actor, input.clientId, result.reports);
    await db.run("update public.report_pulls set status = 'imported', external_ref = $2, report_ids = $3, completed_at = now() where id = $1", [start.pullId, result.externalRef, ids]);
    await audit(db, { orgId: actor.orgId, actorId: actor.userId, actorLabel: actor.label, action: 'report.pulled', entityType: 'client', entityId: input.clientId, ip: actor.meta?.ip, meta: { provider: provider.key, reports: ids.length } });
    return ids;
  });
  return { pullId: start.pullId, reportIds };
}

/** Inbound push (REST API / Zapier / a partner's webhook). Same gate, same review queue. */
export async function ingestInbound(db: Db, actor: CActor, clientId: string, body: unknown): Promise<{ pullId: string; reportIds: string[] }> {
  if (!can(actor.role, 'reports:write')) throw new PermissionError('reports:write');
  const parsed = ingestBody.safeParse(body);
  if (!parsed.success) throw new CreditError(`Invalid report payload: ${parsed.error.issues[0]?.path.join('.') || 'body'} ${parsed.error.issues[0]?.message ?? ''}`.trim());
  const { consentId } = await requireAuthorization(db, clientId);
  if (parsed.data.external_ref) {
    const dup = await db.row('select 1 from public.report_pulls where client_id = $1 and external_ref = $2 and status = $3', [clientId, parsed.data.external_ref, 'imported']);
    if (dup) throw new CreditError('A report with this external_ref was already imported for this client.');
  }
  const ids = await importReports(db, actor, clientId, parsed.data.reports);
  const p = await db.row<{ id: string }>(
    `insert into public.report_pulls (org_id, client_id, provider, mode, status, consent_id, external_ref, report_ids, requested_by, actor_label, completed_at) values ($1,$2,$3,'inbound','imported',$4,$5,$6,$7,$8, now()) returning id`,
    [actor.orgId, clientId, actor.label ?? 'api', consentId, parsed.data.external_ref ?? null, ids, actor.userId, actor.label ?? null]);
  await audit(db, { orgId: actor.orgId, actorId: actor.userId, actorLabel: actor.label, action: 'report.ingested', entityType: 'client', entityId: clientId, ip: actor.meta?.ip, meta: { reports: ids.length } });
  return { pullId: p!.id, reportIds: ids };
}
