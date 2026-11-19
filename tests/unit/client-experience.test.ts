import { describe, expect, it } from 'vitest';
import { findBlockedClaims } from '@/lib/compliance/claims';
import { CONSENT_DOCS } from '@/lib/compliance/disclosures';
import { DOC_KINDS } from '@/lib/crm';
import { LEAD_GOALS } from '@/lib/leads';
import { CLIENT_VISIBLE_STATUSES, fill, parseLang, portalMessage, qs, tr, type PortalKey } from '@/lib/portal-i18n';
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

describe('client-facing messages follow the client’s language', () => {
  it('translates the messages shared server code produces, taken from the real sources', async () => {
    const { passwordProblem } = await import('@/lib/auth/password');
    const { readUpload, UploadError } = await import('@/lib/upload');
    const uploadMessage = async (file: File | null) => {
      try { await readUpload(file, ['application/pdf', 'image/png', 'image/jpeg']); } catch (e) { if (e instanceof UploadError) return e.message; throw e; }
      throw new Error('expected the upload to be refused');
    };
    const sources = [
      passwordProblem('short')!, passwordProblem('aaaaaaaaaaaa')!, passwordProblem('ababababababab')!, passwordProblem('janedoe-Correct-7', 'janedoe@example.com')!,
      await uploadMessage(null), await uploadMessage(new File(['plain text'], 'notes.txt')),
      await uploadMessage({ size: 11 * 1024 * 1024, name: 'big.pdf' } as File),
      'Something went wrong. Please try again.', 'Incorrect email or password.', 'Too many attempts. Try again in 3 minute(s).',
    ];
    for (const m of sources) {
      expect(m, 'source message').toMatch(/\S/);
      const es = portalMessage('es', m);
      expect(es, m).not.toBe(m);
      expect(es, m).not.toMatch(/^[a-z]+: /);
    }
    expect(portalMessage('es', 'Too many attempts. Try again in 3 minute(s).')).toContain('3');
    expect(portalMessage('en', 'That file is larger than 10 MB.')).toBe('That file is larger than 10 MB.');
  });

  it('drops the internal field name from a validation message, in both languages', () => {
    expect(portalMessage('en', 'zip: Use a 5-digit ZIP')).toBe('Use a 5-digit ZIP');
    expect(portalMessage('es', 'zip: Use a 5-digit ZIP')).toBe(tr('es')('e_zip'));
    expect(portalMessage('en', 'body: required')).toBe(tr('en')('e_required'));
    expect(portalMessage('es', 'kind: Invalid option')).toBe(tr('es')('e_checkForm'));
    // A message it does not know is passed through untouched rather than replaced.
    expect(portalMessage('es', 'Unrecognised message')).toBe('Unrecognised message');
  });

  it('has a Spanish title for every agreement and every document type, and English titles match the documents', () => {
    for (const d of CONSENT_DOCS) {
      expect(tr('en')(`consent_${d.kind}_title` as PortalKey)).toBe(d.title);
      expect(tr('es')(`consent_${d.kind}_title` as PortalKey)).toMatch(/\S/);
    }
    for (const k of DOC_KINDS) expect(tr('es')(`kind_${k}` as PortalKey), k).toMatch(/\S/);
    for (const g of Object.keys(LEAD_GOALS)) {
      expect(tr('en')(`goal_${g}` as PortalKey)).toBe(LEAD_GOALS[g as keyof typeof LEAD_GOALS]);
      expect(tr('es')(`goal_${g}` as PortalKey), g).toMatch(/\S/);
    }
  });

  it('new public copy never promises an outcome', () => {
    for (const k of ['lead_title', 'lead_sub', 'al_tagline', 'al_p1', 'li_subBrand', 'err_body'] as PortalKey[]) expect(findBlockedClaims(tr('en')(k)), k).toEqual([]);
  });

  it('builds links and fills placeholders safely', () => {
    expect(parseLang('es')).toBe('es');
    expect(parseLang('fr')).toBe('en');
    expect(parseLang(undefined)).toBe('en');
    expect(qs({ org: 'acme', lang: false, x: undefined })).toBe('?org=acme');
    expect(qs({ lang: false })).toBe('');
    expect(fill(tr('es')('inv_sub'), { org: 'Acme & Co' })).toContain('Acme & Co');
    expect(fill('{a} {b}', { a: 1 })).toBe('1 {b}');
  });
});
