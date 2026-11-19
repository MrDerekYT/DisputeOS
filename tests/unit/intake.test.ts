import { describe, expect, it } from 'vitest';
import { findBlockedClaims } from '@/lib/compliance/claims';
import { ADDRESS_PROOF_MAX_AGE_DAYS, INTAKE_ITEMS, INTAKE_OPTIONAL, INTAKE_REQUIRED, intakeStateLabel, intakeStatus, intakeSummary, type IntakeDoc } from '@/lib/intake';
import { buildPlan } from '@/lib/plan';
import { nextStep } from '@/lib/portal-next-step';
import { DOC_KINDS } from '@/lib/crm';
import { tr, type PortalKey } from '@/lib/portal-i18n';

const TODAY = '2026-11-19';
let n = 0;
const doc = (kind: string, over: Partial<IntakeDoc> = {}): IntakeDoc => ({
  id: `d${++n}`, kind, file_name: `${kind}.png`, review_status: 'pending_review', review_note: null, doc_date: null, expires_on: null, created_at: `2026-11-0${(n % 9) + 1}T10:00:00Z`, ...over,
});
const state = (docs: IntakeDoc[], key: string) => intakeStatus(docs, TODAY).find((s) => s.item.key === key)!;

describe('intake definition', () => {
  it('requires photo ID, proof of address and proof of SSN, and nothing else', () => {
    expect(INTAKE_REQUIRED.map((i) => i.key)).toEqual(['id', 'proof_of_address', 'ssn_proof']);
    expect(INTAKE_OPTIONAL.map((i) => i.key)).toEqual(['previous_address', 'name_change', 'ftc_report', 'police_report', 'power_of_attorney']);
  });

  it('stores every item under a real document kind, with English and Spanish text and a portal label', () => {
    for (const i of INTAKE_ITEMS) {
      expect(DOC_KINDS as readonly string[]).toContain(i.key);
      for (const text of [i.label, i.accepts, ...i.tips]) { expect(text.en.length).toBeGreaterThan(3); expect(text.es.length).toBeGreaterThan(3); }
      for (const lang of ['en', 'es'] as const) expect(tr(lang)(`kind_${i.key}` as PortalKey)).not.toBe(`kind_${i.key}`);
    }
  });

  it('makes no promise about results and says nothing the claims guard blocks', () => {
    for (const i of INTAKE_ITEMS) for (const text of [i.label.en, i.accepts.en, ...i.tips.map((t) => t.en), i.staffNote ?? '']) expect(findBlockedClaims(text)).toEqual([]);
    for (const k of ['ns_intake_t', 'ns_intake_b', 'ck_title', 'ck_intro', 'ck_done', 'ck_private'] as PortalKey[]) expect(findBlockedClaims(tr('en')(k))).toEqual([]);
  });

  it('tells staff the SSN document shows a full number', () => {
    expect(INTAKE_REQUIRED.find((i) => i.key === 'ssn_proof')!.staffNote).toMatch(/full Social Security number/);
  });
});

describe('intake status', () => {
  it('is missing with no documents, and other kinds do not count', () => {
    const all = intakeStatus([doc('credit_report'), doc('other')], TODAY);
    expect(all.map((s) => s.state)).toEqual(['missing', 'missing', 'missing']);
    expect(intakeSummary(all)).toMatchObject({ total: 3, accepted: 0, provided: 0, complete: false });
  });

  it('is awaiting review after an upload and accepted after review', () => {
    expect(state([doc('id')], 'id').state).toBe('pending');
    expect(state([doc('id', { review_status: 'accepted' })], 'id').state).toBe('accepted');
  });

  it('shows the reason when the newest upload was rejected, and moves on when the client sends another', () => {
    const rejected = doc('id', { review_status: 'rejected', review_note: 'Cut off at the bottom', created_at: '2026-11-10T10:00:00Z' });
    expect(state([rejected], 'id')).toMatchObject({ state: 'rejected', reason: 'Cut off at the bottom' });
    expect(state([rejected, doc('id', { created_at: '2026-11-11T10:00:00Z' })], 'id').state).toBe('pending');
  });

  it('keeps an accepted document accepted even when a later upload was rejected', () => {
    const ok = doc('ssn_proof', { review_status: 'accepted', created_at: '2026-11-01T10:00:00Z' });
    const bad = doc('ssn_proof', { review_status: 'rejected', created_at: '2026-11-05T10:00:00Z' });
    expect(state([bad, ok], 'ssn_proof')).toMatchObject({ state: 'accepted', doc: ok });
  });

  it('calls an ID expired only from a recorded expiry date', () => {
    expect(state([doc('id', { review_status: 'accepted', expires_on: '2026-11-18' })], 'id')).toMatchObject({ state: 'stale', why: 'expired' });
    expect(state([doc('id', { review_status: 'accepted', expires_on: TODAY })], 'id').state).toBe('accepted');
    expect(state([doc('id', { review_status: 'accepted' })], 'id').state).toBe('accepted'); // no date known: never guessed
  });

  it('calls a proof of address out of date only from a recorded document date older than two months', () => {
    expect(ADDRESS_PROOF_MAX_AGE_DAYS).toBe(60);
    const on = (d: string | null) => state([doc('proof_of_address', { review_status: 'accepted', doc_date: d })], 'proof_of_address');
    expect(on('2026-09-20')).toMatchObject({ state: 'accepted' }); // exactly 60 days
    expect(on('2026-09-19')).toMatchObject({ state: 'stale', why: 'old' });
    expect(on(null).state).toBe('accepted');
    expect(intakeStateLabel(on('2026-09-19'))).toBe('No longer recent');
  });

  it('a newer upload awaiting review replaces an expired document', () => {
    const old = doc('id', { review_status: 'accepted', expires_on: '2026-01-01', created_at: '2025-01-01T00:00:00Z' });
    expect(state([old, doc('id', { created_at: '2026-11-18T00:00:00Z' })], 'id').state).toBe('pending');
  });

  it('summarises what the client still has to send and what is not accepted yet', () => {
    const s = intakeSummary(intakeStatus([doc('id', { review_status: 'accepted' }), doc('proof_of_address')], TODAY));
    expect(s).toMatchObject({ total: 3, accepted: 1, provided: 2, complete: false });
    expect(s.needed.map((x) => x.item.key)).toEqual(['ssn_proof']);
    expect(s.notAccepted.map((x) => x.item.key)).toEqual(['proof_of_address', 'ssn_proof']);
    expect(intakeSummary(intakeStatus(['id', 'proof_of_address', 'ssn_proof'].map((k) => doc(k, { review_status: 'accepted' })), TODAY)).complete).toBe(true);
  });

  it('never counts optional items as missing', () => {
    const opt = intakeStatus([], TODAY, INTAKE_OPTIONAL);
    expect(intakeSummary(intakeStatus([], TODAY)).needed).toHaveLength(3);
    expect(opt).toHaveLength(5); // listed, but only the required three feed the summary used for warnings and next steps
  });
});

describe('where the checklist shows up', () => {
  const base = { needSign: false, needDocs: false, reviewing: false, nextDue: null, stage: 'intake' };
  it('portal next step: agreements first, then a named request, then the identity documents checklist', () => {
    expect(nextStep({ ...base, needSign: true, needDocs: true, needIntake: true })).toEqual({ key: 'sign', mine: true });
    expect(nextStep({ ...base, needDocs: true, needIntake: true })).toEqual({ key: 'upload', mine: true });
    expect(nextStep({ ...base, needIntake: true, reviewing: true, nextDue: '2026-12-01' })).toEqual({ key: 'intake', mine: true });
    expect(nextStep(base)).toEqual({ key: 'prep', mine: false });
  });

  it('client plan gains a "collect identity documents" step only when something is not accepted', () => {
    const p = { clientId: '11111111-1111-4111-8111-111111111111', firstName: 'Maria', reports: 1, reportsPendingReview: 0, missingConsents: [], findingsToReview: 0, collections: [], accounts: [], disputesOverdue: 0, disputesDueSoon: 0, lettersToSend: 0 };
    expect(buildPlan(p).map((s) => s.key)).toEqual(['caught-up']);
    const [step] = buildPlan({ ...p, missingIdentityDocs: ['Government-issued photo ID', 'Proof of current address'] });
    expect(step).toMatchObject({ key: 'identity-docs', title: 'Collect 2 identity documents', href: `/app/clients/${p.clientId}?tab=documents#intake` });
    expect(findBlockedClaims(step!.detail)).toEqual([]);
  });
});
