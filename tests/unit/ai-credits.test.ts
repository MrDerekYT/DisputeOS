import { describe, expect, it } from 'vitest';
import { AI_COSTS, AI_FEATURE_LABEL, AI_OFF, AI_REFUND_PENDING, ledgerLabel, notChargedNote, polishOffer } from '@/lib/ai/credits';

describe('AI credit price list', () => {
  it('charges a positive whole number of credits for every AI feature — nothing is free', () => {
    const costs = Object.values(AI_COSTS);
    expect(costs.length).toBeGreaterThan(0);
    for (const c of costs) {
      expect(Number.isInteger(c)).toBe(true);
      expect(c).toBeGreaterThanOrEqual(1);
      expect(c).toBeLessThanOrEqual(100);
    }
  });

  it('prices the letter suggestion above the note polish, and the note polish above a guide answer', () => {
    expect(AI_COSTS.letter_suggestion).toBeGreaterThan(AI_COSTS.progress_note);
    expect(AI_COSTS.progress_note).toBeGreaterThan(AI_COSTS.guide_answer);
  });

  it('has a plain label for every priced feature and never promises a credit result', () => {
    expect(Object.keys(AI_FEATURE_LABEL).sort()).toEqual(Object.keys(AI_COSTS).sort());
    for (const l of Object.values(AI_FEATURE_LABEL)) expect(l).not.toMatch(/guarantee|improve|boost|raise|remove/i);
  });

  it('describes ledger rows honestly', () => {
    expect(ledgerLabel({ reason: 'use', feature: 'letter_suggestion' })).toBe('Letter wording suggestion');
    expect(ledgerLabel({ reason: 'refund', feature: 'guide_answer' })).toMatch(/^Refund: .*not used/);
    expect(ledgerLabel({ reason: 'grant', feature: null })).toBe('Credits added by the platform operator');
  });
});

describe('progress note polish button', () => {
  it('stays on the page after the press that spent the last credits, so the polished text that was paid for is not discarded', () => {
    // Balance 2 or 3 before the press becomes 0 or 1 when the page refreshes: the button (which holds the text) must remain.
    for (const after of [0, 1]) {
      const offer = polishOffer(true, after);
      expect(offer.button).toBe(true);
      expect(offer.note).toContain(`AI credits: ${after}.`);
      expect(offer.note).toContain(AI_OFF.no_credits);
    }
    expect(polishOffer(true, AI_COSTS.progress_note)).toMatchObject({ button: true });
    expect(polishOffer(true, AI_COSTS.progress_note).note).not.toContain(AI_OFF.no_credits);
  });

  it('is not offered when no AI provider is connected', () => {
    expect(polishOffer(false, 50)).toEqual({ button: false, note: AI_OFF.no_provider });
  });
});

describe('what staff are told when no AI result was returned', () => {
  it('says no credits were used only when the refund was really written', () => {
    expect(notChargedNote({ status: 'refunded', cost: 0 })).toBe('No AI credits were used.');
    expect(notChargedNote({ status: 'refund_pending', cost: 5 })).toBe(AI_REFUND_PENDING);
  });
});
