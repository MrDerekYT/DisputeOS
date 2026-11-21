/**
 * Database reads and writes behind the work statement, the charge-eligibility check and the chargeback evidence pack.
 * Every function takes a tenant `db`, so row-level security decides what is visible: staff see their organization,
 * a portal client sees their own record, anyone else sees nothing.
 */
import type { Db } from '../db';
import { audit } from '../audit';
import { logEvent } from '../crm';
import { UserError } from '../errors';
import { can, PermissionError, type Role } from '../rbac';
import { dayInZone } from '../util';
import { monthRange, type Day } from '../business-days';
import { contractPeriod, type ConsentRow } from '../compliance/disclosures';
import { chargeEligibility, type ChargeEligibility } from './eligibility';
import { buildStatement, type Statement, type StatementRows } from './statement';

export interface BActor { orgId: string; userId: string; role: Role; meta?: { ip?: string | null } }

// ------------------------------------------------------------------ work statement
export async function loadStatementRows(db: Db, clientId: string): Promise<StatementRows | null> {
  if (!(await db.row('select 1 from public.clients where id = $1', [clientId]))) return null;
  return {
    letters: await db.rows(
      `select title, recipient_name, status, approved_at, sent_on, sent_at, sent_method, tracking_number, delivery_source, carrier_delivered_at
         from public.letters where client_id = $1 order by created_at`, [clientId]),
    disputes: await db.rows('select item_label, recipient_name, status, due_at, response_at, outcome from public.disputes where client_id = $1 order by created_at', [clientId]),
    documentReviews: (await db.rows<{ ts: string }>('select r as ts from app.client_document_reviews($1) r', [clientId])).map((r) => r.ts),
    documentsPendingReview: (await db.row<{ n: number }>("select count(*)::int as n from public.documents where client_id = $1 and source = 'client' and review_status = 'pending_review'", [clientId]))?.n ?? 0,
    openRequests: await db.rows('select kind, created_at from public.document_requests where client_id = $1 and fulfilled_document_id is null order by created_at', [clientId]),
    messages: await db.rows("select direction, status, created_at from public.communications where client_id = $1 and direction in ('inbound', 'outbound')", [clientId]),
  };
}

/** The statement for one calendar month (YYYY-MM), or null when the caller cannot see the client. */
export async function loadStatement(db: Db, clientId: string, month: string, tz: string): Promise<Statement | null> {
  const rows = await loadStatementRows(db, clientId);
  return rows ? buildStatement(rows, monthRange(month), tz) : null;
}

// ------------------------------------------------------------------ charge eligibility
export interface ChargeCheck extends ChargeEligibility { month: string; chargeDate: Day; soldByPhone: boolean | null }

/**
 * The eligibility of a charge recorded today for work in `month`. Null when the caller cannot see the client. `tz` is
 * the zone the agency works in (agencyZone in src/lib/agreements.ts): the same day the cancellation period, the
 * client's Notice of Cancellation and the service gate are counted on.
 */
export async function loadChargeCheck(db: Db, clientId: string, month: string, tz: string, now = new Date()): Promise<ChargeCheck | null> {
  const c = await db.row<{ status: string; sold_by_phone: boolean | null }>('select status, sold_by_phone from public.clients where id = $1', [clientId]);
  if (!c) return null;
  const contracts = await db.rows<ConsentRow>(
    "select kind, signed_at, revoked_at, signed_on::text, cancellation_ends_on::text from public.client_consents where client_id = $1 and kind = 'croa_contract' order by signed_at desc", [clientId]);
  // The agreement's days as it counts them itself: the day signed and the last day of its period, with the days stored at signing.
  const inForce = contracts.find((r) => !r.revoked_at);
  const revoked = contracts.find((r) => r.revoked_at);
  const days = inForce ? contractPeriod(inForce, tz) : null;
  const sent = await db.rows<{ on: string }>("select coalesce(sent_on, (sent_at at time zone $2)::date) as on from public.letters where client_id = $1 and status = 'sent'", [clientId, tz]);
  const chargeDate = dayInZone(tz, now);
  const e = chargeEligibility({
    chargeDate, period: monthRange(month), clientStatus: c.status, soldByPhone: c.sold_by_phone,
    contractSignedOn: days?.signedOn ?? null,
    contractCancellationEndsOn: days?.endsOn ?? null,
    contractRevokedOn: !inForce && revoked?.revoked_at ? dayInZone(tz, new Date(revoked.revoked_at)) : null,
    lettersSentOn: sent.map((r) => r.on).filter(Boolean),
  });
  return { ...e, month, chargeDate, soldByPhone: c.sold_by_phone };
}

export interface NewPayment {
  clientId: string; amountCents: number; method: 'card' | 'ach' | 'cash' | 'check' | 'other'; note?: string; subscriptionId?: string | null;
  /** The month the payment is for (YYYY-MM). */
  month: string;
  /** The "already performed" confirmation every payment needs. */
  performed: boolean;
  /** Set when the person was shown the hold and its reasons and chose to record the payment anyway. */
  holdAcknowledged: boolean;
}

/**
 * Records a payment the agency collected elsewhere. The eligibility check is run again here, on the server: when it
 * says "hold", the payment is refused unless the hold was acknowledged, and the acknowledgement is written to the
 * audit log with the reasons (codes only; the audit log never holds personal data).
 */
export async function recordPayment(db: Db, actor: BActor, p: NewPayment, tz: string, now = new Date()): Promise<{ id: string; check: ChargeCheck }> {
  if (!can(actor.role, 'billing:write')) throw new PermissionError('billing:write');
  if (!p.performed) throw new UserError('Confirm that this payment is for services already performed. Charging in advance of performance is prohibited for credit repair organizations.');
  const check = await loadChargeCheck(db, p.clientId, p.month, tz, now);
  if (!check) throw new UserError('Client not found.');
  const onHold = check.status === 'hold';
  if (onHold && !p.holdAcknowledged) throw new UserError(`This charge is on hold: ${check.reasons.map((r) => r.text).join(' ')} Review the reasons, then use “Record payment on hold” if you still need to record it.`);
  const row = await db.row<{ id: string }>(
    'insert into public.payments (org_id, client_id, subscription_id, amount_cents, method, note, recorded_by) values ($1,$2,$3,$4,$5,$6,$7) returning id',
    [actor.orgId, p.clientId, p.subscriptionId || null, p.amountCents, p.method, p.note ?? null, actor.userId]);
  await logEvent(db, actor, p.clientId, 'payment', `Payment recorded: $${(p.amountCents / 100).toFixed(2)}${onHold ? ' (charge check: on hold, acknowledged)' : ''}`);
  await audit(db, {
    orgId: actor.orgId, actorId: actor.userId, action: 'payment.recorded', entityType: 'payment', entityId: row!.id, ip: actor.meta?.ip,
    meta: { amount_cents: p.amountCents, services_performed_confirmed: true, period: p.month, charge_check: check.status, hold_acknowledged: onHold, hold_reasons: onHold ? check.reasons.map((r) => r.code).join(',') : null },
  });
  return { id: row!.id, check };
}

/** How the service was sold. Staff with billing rights only; every change is audited. */
export async function setSoldByPhone(db: Db, actor: BActor, clientId: string, soldByPhone: boolean | null): Promise<void> {
  if (!can(actor.role, 'billing:write')) throw new PermissionError('billing:write');
  const n = await db.run('update public.clients set sold_by_phone = $2 where id = $1 and sold_by_phone is distinct from $2', [clientId, soldByPhone]);
  if (n === 0) return;
  await logEvent(db, actor, clientId, 'sales_channel', soldByPhone == null ? 'How the client was sold: answer cleared' : soldByPhone ? 'Marked as sold by phone' : 'Marked as not sold by phone');
  await audit(db, { orgId: actor.orgId, actorId: actor.userId, action: 'client.sold_by_phone', entityType: 'client', entityId: clientId, ip: actor.meta?.ip, meta: { sold_by_phone: soldByPhone } });
}

// ------------------------------------------------------------------ chargeback evidence pack
export interface EvidencePack {
  client: { full_name: string; email: string | null; created_at: string; status: string; portal: boolean };
  /**
   * `has_text`: a text is stored with the signature (since migration 0031): for a portal signature the exact text the
   * client signed, for a paper signature (`recorded_by`, a staff member) the app's text on the recording day, not a copy
   * of the paper. `signed_on`: the day the client signed (the date written on the paper for a paper signature).
   * `cancellation_ends_on`: a service agreement's last day to cancel, fixed when it was signed.
   */
  consents: { id: string; kind: string; version: string; signed_name: string; signed_at: string; revoked_at: string | null; ip: string | null; user_agent: string | null; has_text: boolean; recorded_by: string | null; signed_on: string | null; cancellation_ends_on: string | null; revoked_reason: string | null }[];
  lettersSent: { title: string; recipient_name: string; sent_on: string | null; sent_at: string | null; sent_method: string | null; tracking_number: string | null; delivery_source: string; carrier_delivered_at: string | null }[];
  communications: { created_at: string; direction: string; channel: string; subject: string | null; status: string }[];
  communicationsTotal: number;
  signIns: string[];
  payments: { paid_at: string; amount_cents: number; method: string; status: string }[];
}

export const EVIDENCE_COMMS_LIMIT = 300;

/** Everything on the evidence page, from records only. Null when the caller cannot see the client. */
export async function loadEvidencePack(db: Db, clientId: string): Promise<EvidencePack | null> {
  const client = await db.row<EvidencePack['client']>('select full_name, email, created_at, status, portal_user_id is not null as portal from public.clients where id = $1', [clientId]);
  if (!client) return null;
  return {
    client,
    consents: await db.rows(
      `select id, kind, version, signed_name, signed_at, revoked_at, ip, user_agent, text_shown is not null as has_text, recorded_by, signed_on::text, cancellation_ends_on::text, revoked_reason
         from public.client_consents where client_id = $1 order by signed_at`, [clientId]),
    lettersSent: await db.rows(
      `select title, recipient_name, sent_on, sent_at, sent_method, tracking_number, delivery_source, carrier_delivered_at
         from public.letters where client_id = $1 and status = 'sent' order by coalesce(sent_on, sent_at::date), created_at`, [clientId]),
    communications: await db.rows(
      `select created_at, direction, channel, subject, status from public.communications
        where client_id = $1 and direction in ('inbound', 'outbound') and status in ('sent', 'delivered', 'received') order by created_at desc limit ${EVIDENCE_COMMS_LIMIT}`, [clientId]),
    communicationsTotal: (await db.row<{ n: number }>("select count(*)::int as n from public.communications where client_id = $1 and direction in ('inbound', 'outbound') and status in ('sent', 'delivered', 'received')", [clientId]))?.n ?? 0,
    signIns: (await db.rows<{ ts: string }>('select s as ts from app.client_portal_signins($1) s', [clientId])).map((r) => r.ts),
    payments: await db.rows('select paid_at, amount_cents, method, status from public.payments where client_id = $1 order by paid_at', [clientId]),
  };
}
