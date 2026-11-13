import { describe, expect, it } from 'vitest';
import { findBlockedClaims } from '@/lib/compliance/claims';
import { CLIENT_VISIBLE_STATUSES, tr, type PortalKey } from '@/lib/portal-i18n';
import { nextStep } from '@/lib/portal-next-step';
import { PRODUCT, wordmarkParts } from '@/lib/product';
import { fmtDate, relTime, relTimeIn } from '@/lib/util';

describe('product name is configured in one place', () => {
  it('splits the wordmark only when the accent really is the end of the name', () => {
    expect(wordmarkParts('DisputeOS', 'OS')).toEqual(['Dispute', 'OS']);
    expect(wordmarkParts('Clearline', 'OS')).toEqual(['Clearline', '']);
    expect(wordmarkParts('Clearline', '')).toEqual(['Clearline', '']);
    expect(wordmarkParts('OS', 'OS')).toEqual(['OS', '']);
    expect(wordmarkParts().join('')).toBe(PRODUCT.name);
  });
});

describe('client portal copy', () => {
  const en = tr('en');
  const es = tr('es');

  it('has a label and an explanation for every status a client can see, in both languages', () => {
    for (const s of CLIENT_VISIBLE_STATUSES) {
      for (const t of [en, es]) {
        expect(t(`st_${s}` as PortalKey), `st_${s}`).toMatch(/\S/);
        expect(t(`m_${s}` as PortalKey), `m_${s}`).toMatch(/\S/);
      }
    }
  });

  it('every next-step message exists in both languages', () => {
    for (const k of ['sign', 'upload', 'review', 'wait', 'prep', 'done']) {
      for (const t of [en, es]) {
        expect(t(`ns_${k}_t` as PortalKey)).toMatch(/\S/);
        expect(t(`ns_${k}_b` as PortalKey)).toMatch(/\S/);
      }
    }
  });

  it('never promises an outcome (checked with the same guard used on letters)', () => {
    // ('disclaimer' is excluded: it says the specialist "cannot guarantee any result", which the word-level guard flags.)
    const keys: PortalKey[] = ['progressNote', 'scoresNote', 'r_free', 'r_diy', 'r_accurate', 'r_time', 'r_cancel',
      'ns_sign_b', 'ns_upload_b', 'ns_review_b', 'ns_wait_b', 'ns_prep_b', 'ns_done_b', 'sd_intake', 'sd_analysis', 'sd_disputing', 'sd_monitoring'];
    for (const k of keys) expect(findBlockedClaims(en(k)), k).toEqual([]);
  });
});

describe('next step for the client', () => {
  const base = { needSign: false, needDocs: false, reviewing: false, nextDue: null, stage: 'disputing' };
  it('puts what the client must do first', () => {
    expect(nextStep({ ...base, needSign: true, needDocs: true, reviewing: true })).toEqual({ key: 'sign', mine: true });
    expect(nextStep({ ...base, needDocs: true, reviewing: true })).toEqual({ key: 'upload', mine: true });
  });
  it('then explains what the team or the bureaus are doing', () => {
    expect(nextStep({ ...base, reviewing: true, nextDue: '2026-12-01' }).key).toBe('review');
    expect(nextStep({ ...base, nextDue: '2026-12-01' }).key).toBe('wait');
    expect(nextStep({ ...base, stage: 'analysis' }).key).toBe('prep');
    expect(nextStep({ ...base, stage: 'monitoring' })).toEqual({ key: 'done', mine: false });
  });
});

describe('dates in the client’s language', () => {
  it('formats dates and relative times in Spanish for Spanish-speaking clients', () => {
    expect(fmtDate('2026-03-03', 'en')).toBe('Mar 3, 2026');
    expect(fmtDate('2026-03-03', 'es')).toMatch(/^3 mar\.? 2026$/);
    const now = new Date('2026-03-10T12:00:00Z');
    expect(relTimeIn('2026-03-07T12:00:00Z', 'en', now)).toBe('3 days ago');
    expect(relTimeIn('2026-03-07T12:00:00Z', 'es', now)).toBe('hace 3 días');
  });
  it('treats anything within a minute as "just now", even a few milliseconds in the future', () => {
    const now = new Date('2026-03-10T12:00:00.000Z');
    expect(relTime('2026-03-10T12:00:00.400Z', now)).toBe('just now');
    expect(relTime('2026-03-10T11:59:30Z', now)).toBe('just now');
    expect(relTime('2026-03-10T11:57:00Z', now)).toBe('3m ago');
  });
});
