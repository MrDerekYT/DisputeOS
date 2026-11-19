/**
 * The work statement: what was done for one client in one period, taken from records only. A pure function over rows
 * the caller loaded (see records.ts). Nothing is estimated and nothing is described: every line is a record with its
 * date. The only results language is the outcome exactly as staff recorded it from the response.
 *
 * Why it exists: CROA § 404(b) (15 U.S.C. § 1679b(b)) allows payment only after the service is fully performed, so
 * the client and the agency both need to see, per period, what was performed.
 */
import { dayInZone } from '../util';
import type { Day } from '../business-days';

/** The one sentence about results that every statement carries. */
export const OUTCOME_LINE = 'Outcomes depend on what the credit bureaus and the companies reporting the information find after investigation.';

export interface StatementRows {
  letters: {
    title: string; recipient_name: string; status: string; approved_at: string | null; sent_on: string | null; sent_at: string | null;
    sent_method: string | null; tracking_number: string | null; delivery_source: string; carrier_delivered_at: string | null;
  }[];
  disputes: { item_label: string; recipient_name: string; status: string; due_at: string | null; response_at: string | null; outcome: string | null }[];
  /** When staff reviewed a document of the client's (one timestamp per review). */
  documentReviews: string[];
  /** Documents the client sent that nobody has reviewed yet. */
  documentsPendingReview: number;
  /** Document requests the client has not answered yet. */
  openRequests: { kind: string; created_at: string }[];
  messages: { direction: string; status: string; created_at: string }[];
}

export type WaitingOn = 'client' | 'recipient' | 'agency';
export type WaitingKind = 'document_request' | 'investigation' | 'response_review' | 'letter_approval' | 'letter_to_send' | 'document_review';

export interface Statement {
  period: { from: Day; to: Day };
  lettersApproved: { title: string; recipient: string; on: Day }[];
  lettersSent: { title: string; recipient: string; on: Day; method: string | null; tracking: string | null; delivery: 'staff_recorded' | 'carrier_confirmed'; carrierDeliveredOn: Day | null }[];
  responses: { item: string; from: string; on: Day; outcome: string | null }[];
  documentsReviewed: number;
  messages: { sent: number; received: number };
  /** As of the day the statement is opened, not of the period. */
  waiting: { on: WaitingOn; kind: WaitingKind; label: string; day: Day | null; count?: number }[];
  /** True when nothing at all is recorded for the period. */
  empty: boolean;
}

/** Messages that actually went out or came in. Drafts, queued, failed and internal notes are not "exchanged". */
const EXCHANGED = new Set(['sent', 'delivered', 'received']);

export function buildStatement(rows: StatementRows, period: { from: Day; to: Day }, tz: string): Statement {
  const day = (v: string | null): Day | null => (v ? (/^\d{4}-\d{2}-\d{2}$/.test(v) ? v : dayInZone(tz, new Date(v))) : null);
  const inPeriod = (d: Day | null): d is Day => !!d && d >= period.from && d <= period.to;
  const byDay = <T extends { on: Day }>(a: T, b: T) => a.on.localeCompare(b.on);

  const lettersApproved = rows.letters
    .filter((l) => l.status !== 'void' && inPeriod(day(l.approved_at)))
    .map((l) => ({ title: l.title, recipient: l.recipient_name, on: day(l.approved_at)! })).sort(byDay);

  const lettersSent = rows.letters
    .filter((l) => l.status === 'sent' && inPeriod(day(l.sent_on ?? l.sent_at)))
    .map((l) => {
      const carrier = l.delivery_source === 'carrier_confirmed';
      return {
        title: l.title, recipient: l.recipient_name, on: day(l.sent_on ?? l.sent_at)!, method: l.sent_method, tracking: l.tracking_number,
        delivery: carrier ? 'carrier_confirmed' as const : 'staff_recorded' as const, carrierDeliveredOn: carrier ? day(l.carrier_delivered_at) : null,
      };
    }).sort(byDay);

  const responses = rows.disputes
    .filter((d) => inPeriod(day(d.response_at)))
    .map((d) => ({ item: d.item_label, from: d.recipient_name, on: day(d.response_at)!, outcome: d.outcome })).sort(byDay);

  const documentsReviewed = rows.documentReviews.filter((v) => inPeriod(day(v))).length;

  const exchanged = rows.messages.filter((m) => EXCHANGED.has(m.status) && inPeriod(day(m.created_at)));
  const messages = { sent: exchanged.filter((m) => m.direction === 'outbound').length, received: exchanged.filter((m) => m.direction === 'inbound').length };

  const waiting: Statement['waiting'] = [];
  for (const r of rows.openRequests) waiting.push({ on: 'client', kind: 'document_request', label: r.kind, day: day(r.created_at) });
  for (const d of rows.disputes) {
    if (d.status === 'submitted' || d.status === 'under_investigation') waiting.push({ on: 'recipient', kind: 'investigation', label: `${d.item_label} · ${d.recipient_name}`, day: day(d.due_at) });
    else if (d.status === 'response_received') waiting.push({ on: 'agency', kind: 'response_review', label: d.item_label, day: day(d.response_at) });
  }
  for (const l of rows.letters) {
    if (l.status === 'pending_approval') waiting.push({ on: 'agency', kind: 'letter_approval', label: l.title, day: null });
    else if (l.status === 'approved') waiting.push({ on: 'agency', kind: 'letter_to_send', label: l.title, day: day(l.approved_at) });
  }
  if (rows.documentsPendingReview > 0) waiting.push({ on: 'agency', kind: 'document_review', label: '', day: null, count: rows.documentsPendingReview });

  const empty = lettersApproved.length + lettersSent.length + responses.length + documentsReviewed + messages.sent + messages.received === 0;
  return { period, lettersApproved, lettersSent, responses, documentsReviewed, messages, waiting, empty };
}
