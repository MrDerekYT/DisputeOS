import { describe, expect, it } from 'vitest';
import { autoAdvance, suggestProgress, type ProgressFacts } from '@/lib/client-progress';

const f = (o: Partial<ProgressFacts> = {}): ProgressFacts => ({ status: 'onboarding', stage: 'intake', contract: false, reports: 0, drafting: 0, open: 0, sent: 0, ...o });

describe('status and stage from the client’s file', () => {
  it('a new client: Onboarding, Intake', () => {
    expect(suggestProgress(f())).toMatchObject({ status: 'onboarding', stage: 'intake' });
  });
  it('a signed service agreement makes the client Active; a report moves them to Analysis', () => {
    expect(suggestProgress(f({ contract: true, reports: 2 }))).toMatchObject({ status: 'active', stage: 'analysis' });
  });
  it('an open dispute is Disputing; sent disputes with none open is Monitoring', () => {
    expect(suggestProgress(f({ contract: true, reports: 1, open: 1, sent: 1 })).stage).toBe('disputing');
    expect(suggestProgress(f({ contract: true, reports: 1, sent: 3 })).stage).toBe('monitoring');
  });
  it('Paused, Completed, Cancelled and Graduated are a person’s choice and are kept', () => {
    for (const status of ['paused', 'completed', 'cancelled'] as const) expect(suggestProgress(f({ status, contract: true })).status).toBe(status);
    expect(suggestProgress(f({ stage: 'graduated', open: 1 })).stage).toBe('graduated');
  });
  it('a Lead without an agreement stays a Lead', () => {
    expect(suggestProgress(f({ status: 'lead' })).status).toBe('lead');
  });
  it('says why, in plain words', () => {
    expect(suggestProgress(f({ contract: true, open: 2, sent: 2 })).why).toEqual(['Service agreement signed', '2 disputes with the bureaus or creditors']);
  });
});

describe('what the page changes on its own: forward only', () => {
  it('moves Onboarding → Active and Intake → Disputing', () => {
    const facts = f({ contract: true, open: 1, sent: 1 });
    expect(autoAdvance(facts, suggestProgress(facts))).toEqual({ status: 'active', stage: 'disputing' });
  });
  it('never moves back: Active without an agreement, or Disputing without disputes, stay as they are', () => {
    const facts = f({ status: 'active', stage: 'disputing' });
    expect(autoAdvance(facts, suggestProgress(facts))).toEqual({ status: null, stage: null });
  });
  it('never touches a Paused client', () => {
    const facts = f({ status: 'paused', contract: true });
    expect(autoAdvance(facts, suggestProgress(facts)).status).toBeNull();
  });
});
