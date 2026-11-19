import { describe, expect, it } from 'vitest';
import { buildStatement, OUTCOME_LINE, type StatementRows } from '@/lib/billing/statement';
import { monthRange } from '@/lib/business-days';
import { findBlockedClaims } from '@/lib/compliance/claims';
import { tr, type PortalKey } from '@/lib/portal-i18n';

const TZ = 'America/New_York';
const NOV = monthRange('2026-11');

const letter = (o: Partial<StatementRows['letters'][number]>): StatementRows['letters'][number] => ({
  title: 'Dispute letter', recipient_name: 'Experian', status: 'draft', approved_at: null, sent_on: null, sent_at: null, sent_method: null, tracking_number: null,
  delivery_source: 'staff_recorded', carrier_delivered_at: null, ...o,
});
const dispute = (o: Partial<StatementRows['disputes'][number]>): StatementRows['disputes'][number] => ({
  item_label: 'Acme Bank ••1234 (Experian)', recipient_name: 'Experian', status: 'draft', due_at: null, response_at: null, outcome: null, ...o,
});
const EMPTY: StatementRows = { letters: [], disputes: [], documentReviews: [], documentsPendingReview: 0, openRequests: [], messages: [] };

const FIXTURE: StatementRows = {
  letters: [
    letter({ title: 'Letter A', status: 'sent', approved_at: '2026-11-03T15:00:00.000Z', sent_on: '2026-11-05', sent_at: '2026-11-06T01:00:00.000Z', sent_method: 'certified_mail', tracking_number: '7016 0001' }),
    letter({ title: 'Letter B', recipient_name: 'Equifax', status: 'sent', approved_at: '2026-10-28T15:00:00.000Z', sent_on: '2026-11-02', delivery_source: 'carrier_confirmed', carrier_delivered_at: '2026-11-04T17:00:00.000Z' }),
    letter({ title: 'Letter C', status: 'approved', approved_at: '2026-11-20T15:00:00.000Z' }),
    letter({ title: 'Letter D', status: 'pending_approval' }),
    letter({ title: 'Letter E (October)', status: 'sent', approved_at: '2026-10-01T15:00:00.000Z', sent_on: '2026-10-02' }),
    letter({ title: 'Letter F (void)', status: 'void', approved_at: '2026-11-10T15:00:00.000Z' }),
    letter({ title: 'Letter G (draft)' }),
  ],
  disputes: [
    dispute({ item_label: 'Item 1', status: 'resolved', response_at: '2026-11-18T14:00:00.000Z', outcome: 'verified' }),
    dispute({ item_label: 'Item 2', status: 'response_received', response_at: '2026-11-19T14:00:00.000Z', outcome: null }),
    dispute({ item_label: 'Item 3', recipient_name: 'TransUnion', status: 'submitted', due_at: '2026-12-10T05:00:00.000Z' }),
    dispute({ item_label: 'Item 4', status: 'resolved', response_at: '2026-10-18T14:00:00.000Z', outcome: 'deleted' }),
  ],
  documentReviews: ['2026-11-04T15:00:00.000Z', '2026-11-04T15:05:00.000Z', '2026-10-30T15:00:00.000Z'],
  documentsPendingReview: 2,
  openRequests: [{ kind: 'proof_of_address', created_at: '2026-11-12T15:00:00.000Z' }],
  messages: [
    { direction: 'outbound', status: 'sent', created_at: '2026-11-02T15:00:00.000Z' },
    { direction: 'outbound', status: 'delivered', created_at: '2026-11-03T15:00:00.000Z' },
    { direction: 'outbound', status: 'draft', created_at: '2026-11-03T15:00:00.000Z' },
    { direction: 'outbound', status: 'failed', created_at: '2026-11-03T15:00:00.000Z' },
    { direction: 'inbound', status: 'received', created_at: '2026-11-07T15:00:00.000Z' },
    { direction: 'inbound', status: 'received', created_at: '2026-10-07T15:00:00.000Z' },
  ],
};

describe('work statement', () => {
  const s = buildStatement(FIXTURE, NOV, TZ);

  it('lists letters sent in the period with the date, recipient and delivery record', () => {
    expect(s.lettersSent).toEqual([
      { title: 'Letter B', recipient: 'Equifax', on: '2026-11-02', method: null, tracking: null, delivery: 'carrier_confirmed', carrierDeliveredOn: '2026-11-04' },
      { title: 'Letter A', recipient: 'Experian', on: '2026-11-05', method: 'certified_mail', tracking: '7016 0001', delivery: 'staff_recorded', carrierDeliveredOn: null },
    ]);
  });

  it('lists letters approved in the period, never a void one', () => {
    expect(s.lettersApproved.map((l) => [l.title, l.on])).toEqual([['Letter A', '2026-11-03'], ['Letter C', '2026-11-20']]);
  });

  it('lists responses with the outcome exactly as recorded, or none', () => {
    expect(s.responses).toEqual([
      { item: 'Item 1', from: 'Experian', on: '2026-11-18', outcome: 'verified' },
      { item: 'Item 2', from: 'Experian', on: '2026-11-19', outcome: null },
    ]);
  });

  it('counts document reviews and exchanged messages in the period only', () => {
    expect(s.documentsReviewed).toBe(2);
    expect(s.messages).toEqual({ sent: 2, received: 1 }); // drafts and failed sends are not "exchanged"
  });

  it('says what is waiting on whom, as of now', () => {
    expect(s.waiting).toEqual([
      { on: 'client', kind: 'document_request', label: 'proof_of_address', day: '2026-11-12' },
      { on: 'agency', kind: 'response_review', label: 'Item 2', day: '2026-11-19' },
      { on: 'recipient', kind: 'investigation', label: 'Item 3 · TransUnion', day: '2026-12-10' },
      { on: 'agency', kind: 'letter_to_send', label: 'Letter C', day: '2026-11-20' },
      { on: 'agency', kind: 'letter_approval', label: 'Letter D', day: null },
      { on: 'agency', kind: 'document_review', label: '', day: null, count: 2 },
    ]);
    expect(s.empty).toBe(false);
  });

  it('a timestamp belongs to the day it was where the agency works, not the UTC day', () => {
    // 01:30 UTC on December 1 is still November 30 in New York.
    const late = buildStatement({ ...EMPTY, messages: [{ direction: 'outbound', status: 'sent', created_at: '2026-12-01T01:30:00.000Z' }] }, NOV, TZ);
    expect(late.messages.sent).toBe(1);
    expect(buildStatement({ ...EMPTY, messages: [{ direction: 'outbound', status: 'sent', created_at: '2026-12-01T01:30:00.000Z' }] }, NOV, 'UTC').messages.sent).toBe(0);
  });

  it('an empty month says so, and still reports what is waiting', () => {
    const sep = buildStatement(FIXTURE, monthRange('2026-09'), TZ);
    expect(sep).toMatchObject({ empty: true, lettersSent: [], lettersApproved: [], responses: [], documentsReviewed: 0, messages: { sent: 0, received: 0 } });
    expect(sep.waiting).toHaveLength(6);
    expect(buildStatement(EMPTY, NOV, TZ)).toMatchObject({ empty: true, waiting: [] });
  });

  it('adds nothing that is not a record', () => {
    expect(Object.keys(s).sort()).toEqual(['documentsReviewed', 'empty', 'lettersApproved', 'lettersSent', 'messages', 'period', 'responses', 'waiting']);
  });
});

describe('work statement wording', () => {
  const en = tr('en');
  const es = tr('es');
  const all = ['ws_title', 'ws_sub', 'ws_link', 'ws_month', 'ws_show', 'ws_print', 'ws_empty', 'ws_none', 'ws_sent', 'ws_approved', 'ws_responses', 'ws_documents', 'ws_messages', 'ws_to', 'ws_tracking',
    'ws_staffRecorded', 'ws_carrier', 'ws_carrierOn', 'ws_mt_certified_mail', 'ws_mt_first_class_mail', 'ws_mt_portal', 'ws_mt_manual', 'ws_from', 'ws_outcome', 'ws_noOutcome', 'ws_docCount', 'ws_msgCount',
    'ws_waiting', 'ws_waitingAsOf', 'ws_nothingWaiting', 'ws_onClient', 'ws_onRecipient', 'ws_onAgency', 'ws_w_document_request', 'ws_w_investigation', 'ws_w_investigationNoDate', 'ws_w_response_review',
    'ws_w_letter_approval', 'ws_w_letter_to_send', 'ws_w_document_review', 'ws_outcomeLine'] as PortalKey[];

  it('every string exists in English and Spanish and makes no prohibited claim', () => {
    for (const k of all) {
      expect(en(k), k).toBeTruthy();
      expect(es(k), k).toBeTruthy();
      expect(es(k), k).not.toBe(en(k));
      expect(findBlockedClaims(en(k)), k).toEqual([]);
      expect(findBlockedClaims(es(k)), k).toEqual([]);
    }
  });

  it('carries the standard line about who decides outcomes, and no praise', () => {
    expect(en('ws_outcomeLine')).toBe(OUTCOME_LINE);
    expect(findBlockedClaims(OUTCOME_LINE)).toEqual([]);
    for (const k of all) expect(en(k), k).not.toMatch(/\b(great|successful(ly)?|excellent|improv\w+|best|hard work|win|won)\b/i);
  });
});
