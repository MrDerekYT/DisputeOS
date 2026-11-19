import { describe, expect, it } from 'vitest';
import { aiUnapproved } from '@/components/staff-kit';

// The AI mark on a letter comes only from the recorded source of its current version, and comes off only when a
// person has approved that exact text.
describe('aiUnapproved', () => {
  it('marks an AI draft until a person approves it', () => {
    expect(aiUnapproved({ source: 'ai_draft', status: 'draft' })).toBe(true);
    expect(aiUnapproved({ source: 'ai_draft', status: 'pending_approval' })).toBe(true);
  });
  it('drops the mark once that text is approved or sent', () => {
    expect(aiUnapproved({ source: 'ai_draft', status: 'approved' })).toBe(false);
    expect(aiUnapproved({ source: 'ai_draft', status: 'sent' })).toBe(false);
  });
  it('never marks text a model did not write', () => {
    for (const status of ['draft', 'pending_approval', 'approved', 'sent', 'void']) {
      expect(aiUnapproved({ source: 'template', status })).toBe(false);
      expect(aiUnapproved({ source: 'manual_edit', status })).toBe(false);
      expect(aiUnapproved({ source: null, status })).toBe(false);
    }
  });
});
