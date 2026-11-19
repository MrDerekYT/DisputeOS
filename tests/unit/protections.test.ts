import { describe, expect, it } from 'vitest';
import { agencyByKey } from '@/lib/credit/agencies';
import {
  OFFICIAL_HOSTS, PROTECTION_GROUPS, PROTECTION_KIND_LABEL, PROTECTION_KINDS, PROTECTION_OPTIONS, protectionByKey, protectionTicks, ProtectionError, setProtectionTick,
} from '@/lib/credit/protections';
import { entryById, resolveLink } from '@/lib/guide/knowledge';
import { findGuideClaims } from '@/lib/guide/llm';
import { tr, type PortalKey } from '@/lib/portal-i18n';

const LANGS = ['en', 'es'] as const;
const official = (url: string) => {
  const u = new URL(url);
  expect(u.protocol, url).toBe('https:');
  expect(OFFICIAL_HOSTS as readonly string[], url).toContain(u.hostname);
};
const dated = (s: { sourceUrl: string; readOn: string }) => {
  official(s.sourceUrl);
  expect(s.readOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(Number.isNaN(new Date(`${s.readOn}T00:00:00Z`).getTime())).toBe(false);
};

describe('self-service protections registry', () => {
  it('stores a link, phone number or "free" only with the official page it was read on and the day', () => {
    expect(PROTECTION_OPTIONS.length).toBeGreaterThanOrEqual(15);
    for (const o of PROTECTION_OPTIONS) {
      if (o.link) { official(o.link.url); dated(o.link); }
      if (o.phone) { dated(o.phone); expect(o.phone.number, o.key).toMatch(/^1?-?\d{3}-\d{3}-\d{4}$/); }
      if (o.free) dated(o.free);
      // A phone number never stands in for a page nobody read.
      if (!o.link) expect(o.phone, o.key).toBeNull();
    }
  });

  it('has unique storable keys, a known organisation and kind, and is always requested by the consumer', () => {
    expect(new Set(PROTECTION_OPTIONS.map((o) => o.key)).size).toBe(PROTECTION_OPTIONS.length);
    for (const o of PROTECTION_OPTIONS) {
      expect(o.key).toMatch(/^[a-z0-9_]{3,60}$/); // the same shape the database trigger accepts (0022)
      expect(PROTECTION_KINDS).toContain(o.kind);
      expect(o.requestedBy).toBe('consumer');
      expect(agencyByKey(o.org) || o.org === 'optoutprescreen', o.key).toBeTruthy();
    }
    expect(PROTECTION_GROUPS.flatMap((g) => g.options)).toHaveLength(PROTECTION_OPTIONS.length);
    for (const g of PROTECTION_GROUPS) expect(g.name.length).toBeGreaterThan(2);
  });

  it('covers what the research confirmed, and lists nothing that was not confirmed', () => {
    for (const b of ['experian', 'equifax', 'transunion']) {
      expect(protectionByKey(`${b}_freeze`)!.free).not.toBeNull();
      expect(protectionByKey(`${b}_fraud_alert`)!.who).toBeDefined();
    }
    for (const k of ['chexsystems_freeze', 'lexisnexis_freeze', 'innovis_freeze', 'nctue_freeze', 'lexisnexis_disclosure', 'lexisnexis_marketing_opt_out', 'optoutprescreen']) expect(protectionByKey(k), k).toBeDefined();
    // No Early Warning page about a freeze was found, and no ChexSystems page about adding a statement.
    expect(PROTECTION_OPTIONS.some((o) => o.org === 'early_warning' && o.kind === 'freeze')).toBe(false);
    expect(protectionByKey('chexsystems_statement')!.link).toBeNull();
    // The safety suppression is limited to the people LexisNexis names; the entry must say who.
    expect(protectionByKey('lexisnexis_safety_suppression')!.who!.en).toMatch(/officials[\s\S]*personal safety[\s\S]*decides/);
  });

  it('says in one honest sentence what each option does and does not do, in both languages, with no promise', () => {
    for (const o of PROTECTION_OPTIONS) for (const l of LANGS) {
      for (const text of [o.does[l], o.doesNot[l], o.who?.[l] ?? '']) {
        expect(findGuideClaims(text), `${o.key} ${l}: ${text}`).toEqual([]);
        expect(text.length, `${o.key} ${l}`).toBeLessThanOrEqual(330);
      }
      expect(o.does[l].length, o.key).toBeGreaterThan(40);
      expect(o.doesNot[l].length, o.key).toBeGreaterThan(40);
    }
    for (const o of PROTECTION_OPTIONS.filter((x) => x.kind === 'freeze')) {
      expect(o.doesNot.en, o.key).toMatch(/does not remove or correct/);
      expect(o.doesNot.es, o.key).toMatch(/No elimina ni corrige/);
    }
    for (const o of PROTECTION_OPTIONS.filter((x) => x.kind === 'opt_out')) expect(o.doesNot.en, o.key).toMatch(/does not (delete|change)/);
    for (const k of PROTECTION_KINDS) for (const l of LANGS) expect(PROTECTION_KIND_LABEL[k][l].length).toBeGreaterThan(5);
  });

  it('reads ticks defensively and validates what it writes', async () => {
    expect(protectionTicks(null)).toEqual({});
    expect(protectionTicks({ experian_freeze: '2026-11-01', nope: '2026-11-01', equifax_freeze: 'yesterday', nctue_freeze: 5 })).toEqual({ experian_freeze: '2026-11-01' });
    const calls: unknown[][] = [];
    const db = { run: async (_sql: string, params?: unknown[]) => { calls.push(params ?? []); return 1; } };
    await expect(setProtectionTick(db, 'c1', 'not_an_option', '2026-11-01', '2026-11-19')).rejects.toThrow(ProtectionError);
    await expect(setProtectionTick(db, 'c1', 'experian_freeze', '2026-11-20', '2026-11-19')).rejects.toThrow(ProtectionError);
    await expect(setProtectionTick(db, 'c1', 'experian_freeze', '2026-13-45', '2026-11-19')).rejects.toThrow(ProtectionError);
    expect(calls).toEqual([]);
    await setProtectionTick(db, 'c1', 'experian_freeze', '2026-11-19', '2026-11-19');
    await setProtectionTick(db, 'c1', 'experian_freeze', null, '2026-11-19');
    expect(calls).toEqual([['c1', 'experian_freeze', '2026-11-19'], ['c1', 'experian_freeze']]);
  });
});

describe('portal copy and guide entries for protections', () => {
  const KEYS: PortalKey[] = ['pf_title', 'pf_link', 'pf_sub', 'pf_mineTitle', 'pf_mine', 'pf_notDispute', 'pf_count', 'pf_free', 'pf_done', 'pf_does', 'pf_doesNot', 'pf_who', 'pf_open', 'pf_call', 'pf_noLink', 'pf_placed', 'pf_save', 'pf_clear', 'pf_badDate', 'pf_sources'];

  it('has every portal string in English and Spanish, passing the claims guard', () => {
    for (const k of KEYS) {
      const en = tr('en')(k);
      const es = tr('es')(k);
      expect(en.length, k).toBeGreaterThan(2);
      expect(es.length, k).toBeGreaterThan(2);
      if (k !== 'pf_free') expect(es, k).not.toBe(en);
      expect(findGuideClaims(en), k).toEqual([]);
      expect(findGuideClaims(es), k).toEqual([]);
    }
    // The page says plainly who does these, and that we never collect agency credentials.
    expect(tr('en')('pf_mine')).toMatch(/requested by you, directly with the agency[\s\S]*never place one for you[\s\S]*never ask for your login, PIN or password[\s\S]*free under federal law/);
    expect(tr('es')('pf_mine')).toMatch(/lo solicita usted[\s\S]*Nunca solicitamos ninguno en su nombre[\s\S]*nunca le pedimos su usuario, PIN o contraseña[\s\S]*gratuitos por ley federal/);
    expect(tr('en')('pf_notDispute')).toMatch(/None of these removes or corrects/);
  });

  it('explains freeze, fraud alert, opt-out and dispute in the guide without a promise, in both languages', () => {
    for (const id of ['credit-freeze', 'fraud-alert', 'prescreen-opt-out', 'freeze-alert-optout-dispute']) {
      const e = entryById(id)!;
      expect(e, id).toBeDefined();
      for (const l of LANGS) {
        expect(findGuideClaims(e.answer[l]), `${id} ${l}`).toEqual([]);
        expect(findGuideClaims(e.question[l]), `${id} ${l}`).toEqual([]);
        expect(e.answer[l].length, `${id} ${l}`).toBeLessThanOrEqual(900);
      }
      expect(e.answer.en, id).toMatch(/generally/);
      expect(e.answer.es, id).toMatch(/generalmente/);
      expect(e.links!.map((x) => resolveLink(x, 'portal', 'en')?.href)).toContain('/portal/protect');
      // Staff have no such screen: the link is simply absent for them.
      expect(e.links!.map((x) => resolveLink(x, 'app', 'en')?.href)).not.toContain('/portal/protect');
    }
    expect(entryById('credit-freeze')!.answer.en).toMatch(/does not remove or correct anything[\s\S]*/);
    expect(entryById('credit-freeze')!.answer.en).toMatch(/we cannot place it for you/);
    expect(entryById('prescreen-opt-out')!.answer.en).toMatch(/does not change or delete anything on your credit reports/);
    const cmp = entryById('freeze-alert-optout-dispute')!.answer.en;
    expect(cmp).toMatch(/None of those three changes what a report says/);
    expect(cmp).toMatch(/inaccurate, incomplete or unverifiable, and the agency decides/);
  });
});
