/**
 * Which specialty agency reports a client has asked for and received, and whether the agency has flagged a banking or
 * background-screening concern. Recorded by staff; nothing here contacts an agency or reads a report.
 */
import { audit } from '../audit';
import { logEvent } from '../crm';
import type { Db } from '../db';
import { UserError } from '../errors';
import { businessToday } from '../letters/service';
import { can, PermissionError, type Role } from '../rbac';
import { specialtyAgency, specialtyReportStates, type SpecialtyReportState, type SpecialtyReportStatus } from './agencies';

export interface SActor { orgId: string; userId: string; role: Role; meta?: { ip?: string | null } }

export async function loadSpecialty(db: Db, clientId: string): Promise<{ bankingConcern: boolean; states: Record<string, SpecialtyReportState> } | null> {
  const c = await db.row<{ banking_concern: boolean; specialty_reports: unknown }>('select banking_concern, specialty_reports from public.clients where id = $1', [clientId]);
  return c ? { bankingConcern: c.banking_concern, states: specialtyReportStates(c.specialty_reports) } : null;
}

export async function setSpecialtyReport(
  db: Db, actor: SActor, clientId: string, agencyKey: string, input: { status: SpecialtyReportStatus; on?: string | null; documentId?: string | null },
): Promise<void> {
  if (!can(actor.role, 'clients:write')) throw new PermissionError('clients:write');
  const agency = specialtyAgency(agencyKey);
  if (!agency) throw new UserError('Choose the reporting agency.');
  const client = await db.row<{ id: string }>('select id from public.clients where id = $1 for update', [clientId]);
  if (!client) throw new UserError('Client not found.');

  if (input.status === 'not_requested') {
    await db.run('update public.clients set specialty_reports = specialty_reports - $2 where id = $1', [clientId, agency.key]);
    await logEvent(db, actor, clientId, 'specialty_report', `${agency.shortName} report: marked as not requested`, { agency: agency.key });
    return;
  }
  const today = businessToday();
  const on = input.on || today;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(on) || Number.isNaN(new Date(`${on}T00:00:00Z`).getTime())) throw new UserError('Enter a valid date.');
  if (on > today && on > new Date().toISOString().slice(0, 10)) throw new UserError('The date cannot be in the future.');
  let documentId: string | null = null;
  if (input.status === 'received' && input.documentId) {
    const doc = await db.row<{ client_id: string; kind: string }>('select client_id, kind from public.documents where id = $1', [input.documentId]);
    if (!doc || doc.client_id !== clientId) throw new UserError('That document does not belong to this client.');
    if (doc.kind !== 'specialty_report') throw new UserError('Attach a document saved as “Specialty report”.');
    documentId = input.documentId;
  }
  await db.run('update public.clients set specialty_reports = specialty_reports || jsonb_build_object($2::text, $3::jsonb) where id = $1',
    [clientId, agency.key, JSON.stringify({ status: input.status, on, document_id: documentId })]);
  await logEvent(db, actor, clientId, 'specialty_report', `${agency.shortName} report: ${input.status} on ${on}`, { agency: agency.key });
  await audit(db, { orgId: actor.orgId, actorId: actor.userId, action: 'client.specialty_report', entityType: 'client', entityId: clientId, ip: actor.meta?.ip, meta: { agency: agency.key, status: input.status } });
}

export async function setBankingConcern(db: Db, actor: SActor, clientId: string, value: boolean): Promise<void> {
  if (!can(actor.role, 'clients:write')) throw new PermissionError('clients:write');
  const before = await db.row<{ banking_concern: boolean }>('select banking_concern from public.clients where id = $1 for update', [clientId]);
  if (!before) throw new UserError('Client not found.');
  if (before.banking_concern === value) return;
  await db.run('update public.clients set banking_concern = $2 where id = $1', [clientId, value]);
  await logEvent(db, actor, clientId, 'specialty_report', value ? 'Banking or background concern noted' : 'Banking or background concern cleared');
}
