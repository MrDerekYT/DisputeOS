import { describe, expect, it } from 'vitest';
import { protect, restore } from '@/lib/ai/protected';
import { findBlockedClaims } from '@/lib/compliance/claims';
import {
  addressBlock, AGENCIES, agencyIdentityLines, AGENCY_KINDS, agencyByKey, agencyItemLines, parseAgencyItem, SPECIALTY_AGENCIES, SPECIALTY_KEYS, specialtyAgency, specialtyReportStates,
} from '@/lib/credit/agencies';
import { BUREAU_ADDRESSES, CATEGORIES, SPECIALTY_CATEGORY } from '@/lib/disputes/workflow';
import { entryById } from '@/lib/guide/knowledge';
import { findGuideClaims } from '@/lib/guide/llm';
import { approvalBlockers } from '@/lib/letters/service';
import { buildValues, mergeTemplate, unresolvedPlaceholders } from '@/lib/letters/render';
import { kindForWorkflow, SPECIALTY_TEMPLATES, specialtyTemplateKey, templateByKey, TEMPLATES } from '@/lib/letters/templates';
import { buildPlan, type PlanInput } from '@/lib/plan';
import { BUREAUS } from '@/lib/util';

const LANGS = ['en', 'es'] as const;
const OFFICIAL = /^https:\/\/([a-z0-9-]+\.)*(chexsystems\.com|earlywarning\.com|lexisnexis\.com|innovis\.com|nctue\.com|telecheck\.com|clarityservices\.com|experian\.com|equifax\.com|transunion\.com|consumerfinance\.gov)\//;

describe('reporting agency registry', () => {
  it('lists the three bureaus unchanged, plus the specialty agencies the owner asked for', () => {
    expect(AGENCIES.filter((a) => a.nationwide).map((a) => a.key)).toEqual([...BUREAUS]);
    for (const b of BUREAUS) {
      const a = agencyByKey(b)!;
      expect(a.name).toBe(BUREAU_ADDRESSES[b]!.name);
      // The same address the bureau letters have always used, only split into lines.
      expect(a.disputeAddress!.lines.join(', ')).toBe(BUREAU_ADDRESSES[b]!.address);
    }
    expect(SPECIALTY_KEYS).toEqual(expect.arrayContaining(['chexsystems', 'early_warning', 'lexisnexis', 'innovis', 'nctue', 'telecheck', 'clarity']));
    expect(new Set(AGENCIES.map((a) => a.key)).size).toBe(AGENCIES.length);
    expect(specialtyAgency('experian')).toBeUndefined(); // a bureau is never a specialty agency
  });

  it('stores an address only with the page it was read on and the date, and only from an official site', () => {
    for (const a of AGENCIES) {
      const addr = a.disputeAddress;
      if (!addr) { expect(addressBlock(a), a.key).toBeNull(); continue; }
      expect(addr.sourceUrl, a.key).toMatch(OFFICIAL);
      expect(addr.verifiedOn, a.key).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(Number.isNaN(new Date(`${addr.verifiedOn}T00:00:00Z`).getTime()), a.key).toBe(false);
      expect(addr.verifiedOn <= new Date().toISOString().slice(0, 10), a.key).toBe(true);
      expect(addr.lines.length, a.key).toBeGreaterThanOrEqual(2);
      expect(addr.lines.at(-1), a.key).toMatch(/\b\d{5}(-\d{4})?$/); // ends in a ZIP code
      for (const l of addr.lines) expect(l.trim(), a.key).toBe(l);
    }
    // Only the agencies whose own page was opened in review carry an address, each citing that page.
    expect(Object.fromEntries(SPECIALTY_AGENCIES.filter((a) => a.disputeAddress).map((a) => [a.key, a.disputeAddress!.sourceUrl]))).toEqual({
      chexsystems: 'https://www.chexsystems.com/dispute', early_warning: 'https://www.earlywarning.com/dispute-file-disclosure', nctue: 'https://nctue.com/consumer/',
    });
    // Everything else carries none, LexisNexis included (its page could not be opened in review): staff must type it.
    for (const k of ['lexisnexis', 'innovis', 'telecheck', 'clarity']) expect(agencyByKey(k)!.disputeAddress, k).toBeNull();
    // No bureau entry cites a page nobody could open: TransUnion cites its own dispute-by-mail page, Equifax the Experian page that prints its address.
    expect(agencyByKey('transunion')!.disputeAddress!.sourceUrl).toBe('https://www.transunion.com/credit-disputes/dispute-your-credit/mail-or-phone');
    expect(agencyByKey('equifax')!.disputeAddress!.sourceUrl).toBe(agencyByKey('experian')!.disputeAddress!.sourceUrl);
    for (const a of AGENCIES) expect(a.disputeAddress?.sourceUrl ?? '', a.key).not.toMatch(/Dispute\.pdf|legal\/public-records/);
  });

  it('quotes what an agency asks for by mail only with its page and date, and marks what the letter must state', () => {
    for (const a of AGENCIES) {
      const m = a.mailRequirements;
      if (!m) { expect(a.letterNeeds, a.key).toEqual([]); continue; }
      expect(m.sourceUrl, a.key).toMatch(OFFICIAL);
      expect(m.verifiedOn, a.key).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(m.text, a.key).toMatch(/“[^”]{20,}”/); // a quotation, not a paraphrase from memory
      expect(findBlockedClaims(m.text), a.key).toEqual([]);
    }
    expect(Object.fromEntries(AGENCIES.filter((a) => a.letterNeeds.length).map((a) => [a.key, a.letterNeeds]))).toEqual({ chexsystems: ['dob', 'ssn'], early_warning: ['consumer_id'], nctue: ['dob', 'ssn'] });
    expect(agencyIdentityLines(agencyByKey('chexsystems'), null, 'en')).toEqual(['Date of birth: [DATE OF BIRTH NEEDED]', 'Social Security number: [SOCIAL SECURITY NUMBER NEEDED]']);
    expect(agencyIdentityLines(agencyByKey('early_warning'), { name: 'X' }, 'es')).toEqual(['Número de identificación del consumidor o de expediente: [CONSUMER ID NEEDED]']);
    expect(agencyIdentityLines(agencyByKey('early_warning'), { name: 'X', consumerId: 'EWS-123' }, 'en')).toEqual(['Consumer ID or file number: EWS-123']);
    expect(agencyIdentityLines(agencyByKey('innovis'), { name: 'X', consumerId: 'F-9' }, 'en')).toEqual(['Consumer ID or file number: F-9']);
    expect(agencyIdentityLines(agencyByKey('innovis'), { name: 'X' }, 'en')).toEqual([]);
    expect(agencyIdentityLines(undefined, { name: 'X', consumerId: 'F-9' }, 'en')).toEqual([]);
  });

  it('describes every agency in both languages, links to its own site, and invents no agency-specific deadline', () => {
    for (const a of AGENCIES) {
      expect(AGENCY_KINDS).toContain(a.kind);
      expect(a.reinvestigationDays).toBe(30);
      expect(a.disclosure.url, a.key).toMatch(/^https:\/\//);
      if (a.onlineDisputeUrl) expect(a.onlineDisputeUrl, a.key).toMatch(OFFICIAL);
      for (const l of LANGS) {
        expect(a.reports[l].length, `${a.key} ${l}`).toBeGreaterThan(30);
        expect(a.disclosure.how[l].length, `${a.key} ${l}`).toBeGreaterThan(20);
        expect(findGuideClaims(`${a.reports[l]} ${a.disclosure.how[l]}`), `${a.key} ${l}`).toEqual([]);
      }
    }
    for (const a of SPECIALTY_AGENCIES) expect(a.disclosure.url, a.key).toMatch(OFFICIAL);
  });

  it('reads the item and the report statuses defensively', () => {
    expect(parseAgencyItem(null)).toBeNull();
    expect(parseAgencyItem({ name: '  ' })).toBeNull();
    expect(parseAgencyItem({ name: 'First Bank', reference: 'xxxx4321', amount: '', junk: 1 })).toEqual({ name: 'First Bank', reference: 'xxxx4321', date: null, amount: null, consumerId: null });
    expect(agencyItemLines({ name: 'First Bank', amount: '$312.40' }, 'en')).toEqual(['  Company or account name: First Bank', '  Amount shown: $312.40']);
    const s = specialtyReportStates({ chexsystems: { status: 'received', on: '2026-10-01', document_id: 'abc' }, lexisnexis: { status: 'requested', on: 'soon' }, experian: { status: 'received' }, nctue: 'x' });
    expect(s.chexsystems).toEqual({ status: 'received', on: '2026-10-01', documentId: 'abc' });
    expect(s.lexisnexis).toEqual({ status: 'requested', on: null, documentId: null });
    expect(s.nctue!.status).toBe('not_requested');
    expect(s.experian).toBeUndefined();
    expect(Object.keys(specialtyReportStates(undefined))).toEqual(SPECIALTY_KEYS);
  });
});

const client = { full_name: 'Jordan Rivera', address: { line1: '123 Main St', city: 'Tampa', state: 'FL', zip: '33602' }, ssn_last4: '6789' };
const ITEM = { name: 'First Coast Bank', reference: 'xxxx4321', date: '03/14/2024', amount: '$312.40' };
const REASON = 'The disclosure lists an unpaid balance of $312.40. My bank statement dated 04/02/2024 shows the account was paid in full and closed by me.';
/** What a person types over the marked lines before approving. Synthetic values. */
const filled = (body: string) => body.replace('[DATE OF BIRTH NEEDED]', '01/02/1990').replace('[SOCIAL SECURITY NUMBER NEEDED]', '000-00-6789').replace('[CONSUMER ID NEEDED]', 'EWS-000123');
const letter = (agency: string, lang: 'en' | 'es', over: { recipient_address?: string | null } = {}) => {
  const a = specialtyAgency(agency)!;
  const tpl = templateByKey(specialtyTemplateKey(a.kind, lang))!;
  const values = buildValues({
    client, language: lang, now: new Date('2026-11-19T12:00:00Z'), enclosures: ['Bank statement dated 04/02/2024'],
    dispute: { item_label: `${ITEM.name} · ${ITEM.reference} (${a.shortName})`, bureau: null, recipient_name: a.name, reason: REASON, fields: [], round: 1, agency: a.key, agency_item: ITEM, recipient_address: over.recipient_address ?? null },
  });
  return mergeTemplate(tpl.body, values);
};

describe('specialty dispute letters', () => {
  it('has one template per kind of agency in English and Spanish, kept out of the template pickers', () => {
    expect(SPECIALTY_TEMPLATES).toHaveLength(AGENCY_KINDS.length * 2);
    for (const k of AGENCY_KINDS) for (const l of LANGS) {
      const t = templateByKey(specialtyTemplateKey(k, l))!;
      expect(t).toMatchObject({ kind: 'specialty_dispute', language: l, recipient: 'agency' });
    }
    expect(TEMPLATES.some((t) => t.kind === 'specialty_dispute')).toBe(false);
    expect(kindForWorkflow('specialty')).toBe('specialty_dispute');
    expect(CATEGORIES[SPECIALTY_CATEGORY]).toMatchObject({ workflow: 'specialty', target: 'agency' });
  });

  it('passes the claims guard and the approval check for every agency, in both languages', () => {
    for (const a of SPECIALTY_AGENCIES) for (const l of LANGS) {
      const body = letter(a.key, l, { recipient_address: a.disputeAddress ? null : 'PO Box 1\nAnytown, ST 00000' });
      expect(findBlockedClaims(body), `${a.key} ${l}`).toEqual([]);
      expect(findGuideClaims(body), `${a.key} ${l}`).toEqual([]);
      // What the agency's page says the letter must state is left as a marked line, and the letter cannot be approved until a person has typed each one.
      expect(approvalBlockers(body).length > 0, `${a.key} ${l}`).toBe(a.letterNeeds.length > 0);
      for (const mark of unresolvedPlaceholders(body)) expect(approvalBlockers(body).join(' '), `${a.key} ${l}`).toContain(mark);
      expect(approvalBlockers(filled(body)), `${a.key} ${l}`).toEqual([]);
    }
    const chex = letter('chexsystems', 'en');
    expect(chex).toContain('Tampa, FL 33602\nDate of birth: [DATE OF BIRTH NEEDED]\nSocial Security number: [SOCIAL SECURITY NUMBER NEEDED]\n\nChex Systems, Inc.');
    expect(unresolvedPlaceholders(letter('early_warning', 'en'))).toEqual(['[CONSUMER ID NEEDED]']);
    expect(letter('nctue', 'es')).toContain('Fecha de nacimiento: [DATE OF BIRTH NEEDED]\nNúmero de Seguro Social: [SOCIAL SECURITY NUMBER NEEDED]');
    for (const t of SPECIALTY_TEMPLATES) expect(findGuideClaims(t.body), t.key).toEqual([]);
  });

  it('asks for a reinvestigation and a written result, and nothing else: no deletion demand and no threat', () => {
    for (const t of SPECIALTY_TEMPLATES) {
      expect(t.body, t.key).not.toMatch(/\b(delet\w*|remov\w*|eras\w*|expung\w*|elimin\w*|borr\w+|quit\w+|suprim\w+)\b/i);
      expect(t.body, t.key).not.toMatch(/\b(demand\w*|must|failure|fail to|lawsuit|sue|attorney|legal action|court|complaint|damages|violat\w*|exij\w+|deber[aá]n?|demanda\w*|abogad\w+|tribunal|queja|da[nñ]os|infracci[oó]n)\b/i);
      expect(t.body, t.key).not.toMatch(/\b(within|en un plazo de|dentro de)\s+\d+/i); // sets no deadline of its own
      expect(t.body, t.key).not.toMatch(/§|U\.S\.C\.|Section \d|Secci[oó]n \d/); // the right to dispute, in general terms only
    }
    expect(letter('chexsystems', 'en')).toMatch(/Fair Credit Reporting Act gives me the right to dispute/);
    expect(letter('chexsystems', 'en')).toMatch(/reasonable reinvestigation[\s\S]*results in writing/);
    expect(letter('lexisnexis', 'es')).toMatch(/Ley de Informes de Crédito Justos \(FCRA\) me da el derecho de disputar/);
    expect(letter('lexisnexis', 'es')).toMatch(/reinvestigación razonable[\s\S]*resultados por escrito/);
  });

  it('states only the facts that were entered, and lists the enclosures', () => {
    const en = letter('chexsystems', 'en');
    for (const fact of [ITEM.name, ITEM.reference, ITEM.date, ITEM.amount, REASON, 'Bank statement dated 04/02/2024', 'Jordan Rivera']) expect(en).toContain(fact);
    expect(en).toContain('Enclosures:');
    expect(en).toContain('the checking and savings account information in my consumer file');
    expect(letter('lexisnexis', 'en')).toContain('the public record and background information in my consumer file');
    expect(letter('chexsystems', 'es')).toContain('Anexos:');
    // A field left blank is left out, not filled with a placeholder or a guess.
    const a = specialtyAgency('innovis')!;
    const sparse = mergeTemplate(templateByKey(specialtyTemplateKey(a.kind, 'en'))!.body, buildValues({
      client, language: 'en', dispute: { item_label: 'First Coast Bank (Innovis)', bureau: null, recipient_name: a.name, reason: REASON, fields: [], round: 1, agency: a.key, agency_item: { name: 'First Coast Bank' }, recipient_address: 'PO Box 1\nAnytown, ST 00000' },
    }));
    expect(sparse).not.toMatch(/Reference or masked number|Date shown|Amount shown|Consumer ID|Date of birth|Social Security/);
    expect(unresolvedPlaceholders(sparse)).toEqual([]);
  });

  it('addresses the letter from the registry when an address is verified, and never guesses one when it is not', () => {
    const chex = letter('chexsystems', 'en');
    expect(chex).toContain('Chex Systems, Inc.\nAttn: Consumer Relations\nPO Box 583399\nMinneapolis, MN 55458');
    expect(letter('nctue', 'en')).toContain('National Consumer Telecom & Utilities Exchange (NCTUE)\nDisputes & Fraud\nExchange Service Center – NCTUE\nP.O. Box 105398\nAtlanta, GA 30348');
    // LexisNexis has no confirmed address, so its letter carries only what staff typed.
    expect(letter('lexisnexis', 'en', { recipient_address: 'PO Box 1\nAnytown, ST 00000' })).toContain('LexisNexis Risk Solutions Consumer Center\nPO Box 1\nAnytown, ST 00000');
    expect(letter('lexisnexis', 'en')).toContain('[RECIPIENT ADDRESS NEEDED]');
    // The registry address wins even if something else was typed.
    expect(letter('chexsystems', 'en', { recipient_address: 'Somewhere Else' })).not.toContain('Somewhere Else');
    // No verified address: a typed one is used as typed; with none, the letter cannot be approved.
    expect(letter('innovis', 'en', { recipient_address: 'PO Box 1\nAnytown, ST 00000' })).toContain('Innovis\nPO Box 1\nAnytown, ST 00000');
    const none = letter('innovis', 'en');
    expect(none).toContain('[RECIPIENT ADDRESS NEEDED]');
    expect(approvalBlockers(none).join(' ')).toContain('[RECIPIENT ADDRESS NEEDED]');
  });

  it('keeps every entered fact locked when the wording is sent for AI polishing (protected-AI rules unchanged)', () => {
    const en = letter('chexsystems', 'en').trimEnd();
    const p = protect(en, ['Jordan Rivera', ITEM.name, 'Chex Systems, Inc.']);
    for (const fact of [ITEM.name, 'xxxx4321', '312.40', '03/14/2024', 'Jordan Rivera', '583399', 'Fair Credit Reporting Act', 'reinvestigation']) expect(p.masked, fact).not.toContain(fact);
    expect(restore(p, p.masked, ['Jordan Rivera', ITEM.name, 'Chex Systems, Inc.'])).toEqual({ ok: true, text: en });
  });
});

describe('specialty reports in the guide and the plan', () => {
  it('explains ChexSystems, Early Warning and LexisNexis with hedged facts and no promise', () => {
    const bank = entryById('bank-reports')!;
    const lexis = entryById('lexisnexis')!;
    expect(bank.answer.en).toMatch(/ChexSystems says its current practice is to keep a reported record for five years/);
    expect(bank.answer.en).toMatch(/not credit bureaus/);
    expect(bank.answer.es).toMatch(/cinco años/);
    expect(lexis.answer.en).toMatch(/liens, judgments and bankruptcies/);
    for (const e of [bank, lexis]) {
      expect(e.answer.en, e.id).toMatch(/generally|typically/);
      expect(e.answer.es, e.id).toMatch(/generalmente|normalmente/);
      expect(e.answer.en, e.id).toMatch(/request your free report/);
      expect(e.answer.en, e.id).toMatch(/nothing to dispute/);
      expect(e.answer.es, e.id).toMatch(/no hay nada que disputar/);
      for (const l of LANGS) expect(findGuideClaims(e.answer[l]), `${e.id} ${l}`).toEqual([]);
      for (const link of e.links ?? []) if (typeof link.href === 'string') expect(link.href).toMatch(OFFICIAL);
    }
  });

  const ID = '11111111-1111-4111-8111-111111111111';
  const base = (over: Partial<PlanInput> = {}): PlanInput => ({
    clientId: ID, firstName: 'Maria', reports: 1, reportsPendingReview: 0, missingConsents: [], findingsToReview: 0, collections: [], accounts: [], accountsBureau: 'experian',
    disputesOverdue: 0, disputesDueSoon: 0, lettersToSend: 0, ...over,
  });
  it('suggests the ChexSystems and LexisNexis reports only when the agency marked the concern', () => {
    expect(buildPlan(base()).map((s) => s.key)).toEqual(['caught-up']);
    expect(buildPlan(base({ specialtyToRequest: [] })).map((s) => s.key)).toEqual(['caught-up']);
    const [s] = buildPlan(base({ specialtyToRequest: ['ChexSystems', 'LexisNexis'] }));
    expect(s).toMatchObject({ key: 'specialty-reports', tone: 'info', href: `/app/clients/${ID}?tab=reports#specialty`, title: 'Request the ChexSystems and LexisNexis reports' });
    expect(findBlockedClaims(`${s!.title} ${s!.detail}`)).toEqual([]);
    expect(buildPlan(base({ specialtyToRequest: ['LexisNexis'] }))[0]!.title).toBe('Request the LexisNexis report');
  });
});
