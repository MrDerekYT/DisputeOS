import { readFileSync } from 'node:fs';
import path from 'node:path';
import * as React from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { sequenceLine } from '@/app/app/partners/sequence';
import { LeadFields } from '@/components/lead-form';
import { findBlockedClaims, findMarketingClaims } from '@/lib/compliance/claims';
import { SMS_MAX_CHARS } from '@/lib/client-updates/templates';
import { decideLeadText, leadSmsConsentText, leadText, LEAD_SMS_NEEDS_PHONE, LEAD_TEXT_STEPS, type LeadTextState } from '@/lib/lead-texts';
import {
  decidePartnerStep, isPlainCity, PARTNER_CATEGORIES, PARTNER_CATEGORY_LABEL, PARTNER_DAILY_CAP, PARTNER_NAME_MAX,
  PARTNER_PER_RUN_CAP, PARTNER_STATUSES, PARTNER_STATUS_LABEL, PARTNER_STEPS, partnerCityIssue, partnerEmail, partnerEmailIssue, partnerPlace, partnerWordingIssue, type PartnerEmailVars, type PartnerState,
} from '@/lib/partner-emails';
import { detectDelimiter, parseDelimited, parsePartnerList, PARTNER_ATTESTATION, PARTNER_IMPORT_MAX_ROWS, partnerCategoryFrom, partnerSchema } from '@/lib/partner-import';
import { getEnv, resetEnvCache } from '@/lib/env';
import { optOutToken, verifyOptOutToken } from '@/lib/lead-outreach';
import { partnerBlocker, partnerOptOutToken, partnerOptOutUrl, partnerSettings, verifyPartnerOptOutToken } from '@/lib/partner-outreach';

// The test runner compiles JSX to React.createElement, so React has to be in scope when a component renders.
vi.stubGlobal('React', React);

const ORG = 'Bright Path Credit';
const ADDRESS = '12 Main St, Austin, TX 78701';
const OPT_OUT = 'https://app.example.test/unsubscribe/partner/abc';
const vars = (over: Partial<PartnerEmailVars> = {}): PartnerEmailVars => ({
  contactName: 'Dana Whitfield', category: 'real_estate_agent', city: 'Austin', state: 'TX', orgName: ORG, address: ADDRESS, optOutUrl: OPT_OUT, siteUrl: null, ...over,
});

// ================================================================ opt-out links
describe('opt-out links keep working', () => {
  it('a link is signed for one partner or lead, cannot be altered, and survives a rotation of the signing key', () => {
    const id = '3f2a8c1e-5b7d-4e9a-8c6f-1a2b3c4d5e6f';
    const before = { ...process.env };
    try {
      const partnerToken = partnerOptOutToken(id);
      const leadToken = optOutToken(id);
      expect(verifyPartnerOptOutToken(partnerToken)).toBe(id);
      expect(verifyOptOutToken(leadToken)).toBe(id);
      // A link for a lead is not a link for a partner, and the other way round; a changed link verifies as nothing.
      expect(verifyPartnerOptOutToken(leadToken)).toBeNull();
      expect(verifyOptOutToken(partnerToken)).toBeNull();
      expect(verifyPartnerOptOutToken(`${partnerToken.slice(0, -1)}${partnerToken.endsWith('A') ? 'B' : 'A'}`)).toBeNull();
      expect(verifyPartnerOptOutToken(partnerToken.replace(id, '3f2a8c1e-5b7d-4e9a-8c6f-1a2b3c4d5e60'))).toBeNull();
      for (const bad of ['', 'nonsense', id, `${id}-`]) expect(verifyPartnerOptOutToken(bad)).toBeNull();
      expect(partnerOptOutUrl(id)).toBe(`http://localhost:3000/unsubscribe/partner/${partnerToken}`);

      // The key is rotated: emails already sent carry links signed with the old key, which is kept as "previous".
      const oldKey = getEnv().PII_ENCRYPTION_KEY;
      Object.assign(process.env, { PII_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64'), PII_ENCRYPTION_KEY_ID: '2', PII_ENCRYPTION_KEY_PREVIOUS: oldKey, PII_ENCRYPTION_KEY_PREVIOUS_ID: '1' });
      resetEnvCache();
      expect(partnerOptOutToken(id)).not.toBe(partnerToken);
      expect(verifyPartnerOptOutToken(partnerToken)).toBe(id);
      expect(verifyPartnerOptOutToken(partnerOptOutToken(id))).toBe(id);
      expect(verifyOptOutToken(leadToken)).toBe(id);
      // Once the previous key is dropped too, the old link no longer verifies.
      delete process.env.PII_ENCRYPTION_KEY_PREVIOUS;
      delete process.env.PII_ENCRYPTION_KEY_PREVIOUS_ID;
      resetEnvCache();
      expect(verifyPartnerOptOutToken(partnerToken)).toBeNull();
    } finally { process.env = before; resetEnvCache(); }
  });
});

// ================================================================ timing
describe('partner sequence: which email is due (business days)', () => {
  const partner = (over: Partial<PartnerState> = {}): PartnerState => ({ status: 'new', paused: false, outreach: [], ...over });
  const sent = (step: string, on: string) => ({ step, status: 'sent', attempts: 1, sentOn: on });
  // 2026-03-02 is a Monday.
  it('introduction at once, follow-up 4 business days later, last note 9 business days after the introduction', () => {
    expect(decidePartnerStep(partner(), '2026-03-02')).toEqual({ kind: 'send', step: 'intro' });
    const one = partner({ status: 'in_sequence', outreach: [sent('intro', '2026-03-02')] });
    expect(decidePartnerStep(one, '2026-03-05')).toEqual({ kind: 'wait', step: 'followup', dueOn: '2026-03-06' });
    expect(decidePartnerStep(one, '2026-03-06')).toEqual({ kind: 'send', step: 'followup' });
    const two = partner({ status: 'in_sequence', outreach: [sent('intro', '2026-03-02'), sent('followup', '2026-03-06')] });
    expect(decidePartnerStep(two, '2026-03-12')).toEqual({ kind: 'wait', step: 'final', dueOn: '2026-03-13' });
    expect(decidePartnerStep(two, '2026-03-13')).toEqual({ kind: 'send', step: 'final' });
    expect(PARTNER_STEPS.map((s) => [s.key, s.afterBusinessDays])).toEqual([['intro', 0], ['followup', 4], ['final', 9]]);
  });

  it('weekends and federal holidays are not counted and nothing is sent on them', () => {
    // A new partner on a Saturday and a Sunday waits for Monday.
    expect(decidePartnerStep(partner(), '2026-03-07')).toEqual({ kind: 'wait', step: 'intro', dueOn: '2026-03-09' });
    expect(decidePartnerStep(partner(), '2026-03-08')).toEqual({ kind: 'wait', step: 'intro', dueOn: '2026-03-09' });
    // Introduction on Friday 20 November 2026: Thanksgiving (Thursday 26) is skipped, so the follow-up is due Friday 27.
    const one = partner({ status: 'in_sequence', outreach: [sent('intro', '2026-11-20')] });
    expect(decidePartnerStep(one, '2026-11-25')).toEqual({ kind: 'wait', step: 'followup', dueOn: '2026-11-27' });
    expect(decidePartnerStep(one, '2026-11-26')).toEqual({ kind: 'wait', step: 'followup', dueOn: '2026-11-27' });
    expect(decidePartnerStep(one, '2026-11-27')).toEqual({ kind: 'send', step: 'followup' });
    // On the holiday itself a new partner waits for the next business day.
    expect(decidePartnerStep(partner(), '2026-11-26')).toEqual({ kind: 'wait', step: 'intro', dueOn: '2026-11-27' });
    // A step that fell due on a Saturday goes out the following Monday.
    const late = partner({ status: 'in_sequence', outreach: [sent('intro', '2026-03-02'), sent('followup', '2026-03-06')] });
    expect(decidePartnerStep(late, '2026-03-14')).toEqual({ kind: 'wait', step: 'final', dueOn: '2026-03-16' });
  });

  it('never sends two emails within 3 business days of each other, even when the schedule ran late', () => {
    // The follow-up went out late, on Thursday 12 March: the last note waits until Tuesday 17, not Friday 13.
    const late = partner({ status: 'in_sequence', outreach: [sent('intro', '2026-03-02'), sent('followup', '2026-03-12')] });
    expect(decidePartnerStep(late, '2026-03-13')).toEqual({ kind: 'wait', step: 'final', dueOn: '2026-03-17' });
    expect(decidePartnerStep(late, '2026-03-17')).toEqual({ kind: 'send', step: 'final' });
  });

  it('stops on an opt-out, a recorded reply, interested, not interested, a bounce, a pause and when all three were sent', () => {
    const reason = (over: Partial<PartnerState>) => { const d = decidePartnerStep(partner(over), '2026-03-02'); return d.kind === 'stop' ? d.reason : d.kind; };
    expect(reason({ status: 'opted_out' })).toBe('opted_out');
    expect(reason({ status: 'replied' })).toBe('replied');
    expect(reason({ status: 'interested' })).toBe('interested');
    expect(reason({ status: 'not_interested' })).toBe('not_interested');
    expect(reason({ status: 'bounced' })).toBe('bounced');
    expect(reason({ status: 'finished' })).toBe('finished');
    expect(reason({ status: 'something_else' })).toBe('finished');
    expect(reason({ paused: true })).toBe('paused');
    expect(reason({ status: 'in_sequence', outreach: [sent('intro', '2026-02-02'), sent('followup', '2026-02-06'), sent('final', '2026-02-13')] })).toBe('finished');
  });

  it('a failed send stops the sequence; a try a person asked for is sent, at most three attempts in all', () => {
    const failed = (status: string, attempts: number) => partner({ outreach: [{ step: 'intro', status, attempts, sentOn: '2026-03-02' }] });
    expect(decidePartnerStep(failed('failed', 1), '2026-03-03')).toEqual({ kind: 'stop', reason: 'failed' });
    expect(decidePartnerStep(failed('retry', 1), '2026-03-03')).toEqual({ kind: 'send', step: 'intro' });
    expect(decidePartnerStep(failed('retry', 2), '2026-03-03')).toEqual({ kind: 'send', step: 'intro' });
    expect(decidePartnerStep(failed('retry', 3), '2026-03-03')).toEqual({ kind: 'stop', reason: 'failed' });
    // A failed follow-up stops what comes after it too.
    expect(decidePartnerStep(partner({ status: 'in_sequence', outreach: [sent('intro', '2026-03-02'), { step: 'followup', status: 'failed', attempts: 1, sentOn: '2026-03-06' }] }), '2026-03-20')).toEqual({ kind: 'stop', reason: 'failed' });
  });

  it('never re-sends a step whose delivery was not confirmed, and sends nothing after it', () => {
    const stuck = partner({ status: 'in_sequence', outreach: [sent('intro', '2026-03-02'), { step: 'followup', status: 'sending', attempts: 1, sentOn: '2026-03-06' }] });
    expect(decidePartnerStep(stuck, '2026-03-06')).toEqual({ kind: 'stop', reason: 'unconfirmed' });
    expect(decidePartnerStep(stuck, '2026-04-06')).toEqual({ kind: 'stop', reason: 'unconfirmed' });
  });

  it('the one-line status on the Partners pages says the same thing as the rule', () => {
    const line = (p: PartnerState, today: string, sending = true) => sequenceLine(decidePartnerStep(p, today), sending, p.outreach.filter((o) => o.status === 'sent').length).text;
    expect(line(partner(), '2026-03-02')).toBe('0 of 3 sent. Introduction goes out with the next scheduled run');
    expect(line(partner(), '2026-03-02', false)).toBe('Nothing sent. The sequence is not running');
    const one = partner({ status: 'in_sequence', outreach: [sent('intro', '2026-03-02')] });
    expect(line(one, '2026-03-03')).toBe('1 of 3 sent. Follow-up due Mar 6, 2026');
    expect(line(one, '2026-03-03', false)).toBe('1 of 3 sent. The sequence is not running');
    expect(line(partner({ status: 'opted_out' }), '2026-03-03')).toBe('Opted out: never emailed again');
    expect(line(partner({ status: 'replied' }), '2026-03-03', false)).toBe('Stopped: a reply is on file');
    expect(line(partner({ status: 'finished', outreach: [sent('intro', '2026-02-02'), sent('followup', '2026-02-06'), sent('final', '2026-02-13')] }), '2026-03-03')).toBe('All 3 emails sent, no reply recorded');
    expect(line(partner({ paused: true, status: 'in_sequence', outreach: [sent('intro', '2026-03-02')] }), '2026-03-09')).toBe('1 of 3 sent, paused');
  });

  it('sends a sensible number a day, in small batches', () => {
    expect(PARTNER_DAILY_CAP).toBeLessThanOrEqual(50);
    expect(PARTNER_PER_RUN_CAP).toBeLessThan(PARTNER_DAILY_CAP);
    expect(Object.keys(PARTNER_STATUS_LABEL).sort()).toEqual([...PARTNER_STATUSES].sort());
  });
});

// ================================================================ wording
describe('partner emails: wording', () => {
  for (const lang of ['en', 'es'] as const) {
    for (const category of PARTNER_CATEGORIES) {
      for (const { key } of PARTNER_STEPS) {
        it(`${key} for ${category} (${lang}) passes both claims guards and carries the agency name, postal address and opt-out link`, () => {
          for (const v of [vars({ category }), vars({ category, contactName: null, city: null, state: null }), vars({ category, siteUrl: 'https://brightpath.example.test' })]) {
            const m = partnerEmail(key, lang, v);
            expect(findMarketingClaims(`${m.subject}\n${m.body}`)).toEqual([]);
            expect(findMarketingClaims(m.text.replace(ADDRESS, ''))).toEqual([]);
            expect(findBlockedClaims(m.text)).toEqual([]);
            // Which is the guard the sender holds the email to just before it leaves.
            expect(partnerEmailIssue(m)).toBeUndefined();
            // Footer: what it is, who sent it and from where, and the opt-out link.
            expect(m.text).toContain(`${ORG} · ${ADDRESS}`);
            expect(m.text).toContain(OPT_OUT);
            expect(m.footer).toMatch(lang === 'es' ? /oferta comercial de Bright Path Credit/ : /business solicitation from Bright Path Credit/);
            expect(m.footer).toMatch(lang === 'es' ? /Dejar de recibir estos correos: https/ : /Stop these emails: https/);
            expect(m.text.endsWith(m.footer)).toBe(true);
            expect(m.text).toBe(`${m.body}\n\n${m.footer}`);
            expect(m.text).not.toMatch(/\{\w+\}/);
            // Never a number of points, a time frame or a price (only the postal address has digits).
            expect(m.text.replace(ADDRESS, '')).not.toMatch(/\d/);
            expect(m.body.length).toBeLessThan(1800);
            // It says who is writing and signs with the agency's name.
            expect(m.body).toContain(ORG);
            expect(m.body.trimEnd().endsWith(`— ${ORG}`)).toBe(true);
          }
        });
      }
    }
  }

  it('subject lines say what the email is: the agency is named, and nothing pretends to be a reply or urgent', () => {
    for (const lang of ['en', 'es'] as const) for (const category of PARTNER_CATEGORIES) for (const { key } of PARTNER_STEPS) {
      const { subject } = partnerEmail(key, lang, vars({ category }));
      expect(subject).toContain(ORG);
      expect(subject).not.toMatch(/^\s*(re|fwd?|fw|rv)\s*:/i);
      expect(subject).not.toMatch(/!|urgent|urgente|act now|last chance|free|gratis|\$|%/i);
      expect(subject).not.toMatch(/\n/);
      expect(subject.length).toBeLessThanOrEqual(200);
    }
    expect(partnerEmail('intro', 'en', vars()).subject).toBe('Introducing Bright Path Credit: credit report help for your buyers');
    expect(partnerEmail('followup', 'en', vars({ category: 'tax_preparer' })).subject).toBe('Following up: Bright Path Credit and your clients');
    expect(partnerEmail('final', 'es', vars()).subject).toBe('Última nota de Bright Path Credit');
  });

  it('describes what the agency actually does and says plainly what it cannot promise', () => {
    const en = partnerEmail('intro', 'en', vars()).body;
    expect(en).toMatch(/help them read their credit reports and dispute, in writing, information they believe is inaccurate/);
    expect(en).toMatch(/we cannot promise a result, a particular credit score or a loan approval for anyone/);
    expect(en).toMatch(/accurate information stays on a credit report/);
    expect(en).toMatch(/Consumers also have the right to dispute inaccurate information with the credit bureaus on their own/);
    const es = partnerEmail('intro', 'es', vars()).body;
    expect(es).toMatch(/no podemos prometer un resultado, un puntaje de crédito en particular ni la aprobación de un préstamo/);
    expect(partnerEmail('followup', 'en', vars()).body).toMatch(/We do not promise results, and we tell them so/);
    for (const lang of ['en', 'es'] as const) for (const category of PARTNER_CATEGORIES) for (const { key } of PARTNER_STEPS) {
      const text = partnerEmail(key, lang, vars({ category })).text;
      expect(text).not.toMatch(/\b(raise|boost|increase|improve|higher|better)\b|\b(sub\w+|mejor\w*|aument\w+)\s+(su|el|tu)\s+puntaje/i);
      expect(text).not.toMatch(/guarant|garant|approved|aprobad|qualif|califi|pre-?approv|remov|delet|elimin|borr|quit|\bfix|arregl/i);
      expect(text).not.toMatch(/\b(text|call|llam\w+)\b you|\bwe will (text|call)\b/i);
    }
  });

  it('uses only the fields on the record: a plain first name, the category and a plain place name', () => {
    const m = partnerEmail('intro', 'en', vars());
    expect(m.body.startsWith('Hello Dana,\n\n')).toBe(true);
    expect(m.body).toContain('I am contacting you because you work as a real estate agent in Austin, TX.');
    expect(partnerEmail('intro', 'es', vars()).body).toContain('Me comunico con usted porque trabaja como agente de bienes raíces en Austin, TX.');
    expect(partnerEmail('intro', 'en', vars({ category: 'car_dealership', state: null })).body).toContain('because you work at a car dealership in Austin.');
    expect(partnerEmail('intro', 'en', vars({ city: null })).body).toContain('because you work as a real estate agent.');
    // The business name, the email address and the phone number are never put in the body.
    expect(partnerEmail('intro', 'en', vars({ contactName: null })).body.startsWith('Hello,\n\n')).toBe(true);
    // Anything that is not a plain name or place is left out rather than repeated to a stranger.
    for (const bad of ['https://evil.example/claim', 'Dana123', '<b>Dana</b>', 'Claim:$500 now']) {
      const b = partnerEmail('intro', 'en', vars({ contactName: bad })).body;
      expect(b.startsWith('Hello,\n\n')).toBe(true);
      expect(b).not.toMatch(/evil|500|<b>/);
    }
    expect(partnerPlace('Austin', 'TX')).toBe('Austin, TX');
    expect(partnerPlace('St. Louis', 'MO')).toBe('St. Louis, MO');
    expect(partnerPlace('Austin', 'Texas')).toBe('Austin');
    for (const bad of ['Austin: visit evil.example/x', 'Austin 78701', 'http://evil.example', '', null, 'x'.repeat(61)]) expect(partnerPlace(bad, 'TX')).toBe('');
    expect(partnerEmail('intro', 'en', vars({ city: 'visit evil.example/x now' })).body).not.toMatch(/evil/);
    // A city is one to four words of letters. A sentence, a bare domain or a note typed into the wrong column is not one.
    for (const city of ['Austin', 'St. Louis', 'Ft. Worth', 'Mt. Vernon', 'Port St. Lucie', 'Winston-Salem', 'Coeur d’Alene', "O'Fallon", 'Truth or Consequences', 'San José']) expect(isPlainCity(city), city).toBe(true);
    for (const notCity of ['Austin. We met at the expo and most local agents use us', 'Austin. Visit best-credit-fix.example for our offer', 'best-credit-fix.example', 'Austin.', 'Dr. Phillips', 'Austin, TX',
      'We met at the big expo', 'Austin (north side)', 'x'.repeat(41), '  ']) {
      expect(isPlainCity(notCity), notCity).toBe(false);
      expect(partnerPlace(notCity, 'TX'), notCity).toBe('');
      // It is refused when the partner is added, not dropped quietly when the email is built.
      expect(partnerSchema.safeParse({ businessName: 'A', category: 'other', email: 'a@b.example', city: notCity }).success || !notCity.trim(), notCity).toBe(!notCity.trim());
    }
    expect(partnerEmail('intro', 'en', vars({ city: 'Austin. We met at the expo and most local agents use us' })).body).toContain('because you work as a real estate agent.');
    const bad = parsePartnerList('business,email,category,city\nHill Realty,c@hill.example,Realtor,Austin. We met at the expo\nOak Realty,d@oak.example,Realtor,Round Rock', null);
    expect(bad.rows.map((r) => r.city)).toEqual(['Round Rock']);
    expect(bad.issues).toEqual([{ line: 2, message: 'city: Enter the city name only, for example “Austin” or “St. Louis”' }]);
  });

  it('links to the agency website only when one is given', () => {
    expect(partnerEmail('intro', 'en', vars()).body).not.toMatch(/https?:/);
    expect(partnerEmail('intro', 'en', vars({ siteUrl: 'https://brightpath.example.test' })).body).toContain('You can read about us here: https://brightpath.example.test');
    expect(partnerEmail('followup', 'es', vars({ siteUrl: 'https://brightpath.example.test' })).body).toContain('Puede leer sobre nosotros aquí: https://brightpath.example.test');
    expect(partnerEmail('final', 'en', vars({ siteUrl: 'https://brightpath.example.test' })).body).not.toMatch(/https?:/);
  });

  it('keeps a multi-line agency name or address on one line', () => {
    const m = partnerEmail('final', 'en', vars({ orgName: 'Bright\nPath', address: '12 Main St\nAustin, TX' }));
    expect(m.text).toContain('Bright Path · 12 Main St Austin, TX');
    expect(m.subject).toBe('Last note from Bright Path');
  });

  it('an agency name that makes a promise is caught before anything is sent', () => {
    expect(partnerWordingIssue(ORG)).toBeNull();
    // A name that carries a web address, or is long enough to be a message of its own, cannot go in a subject and a From line.
    expect(partnerWordingIssue('URGENT - your escrow account is on hold, sign in at secure-escrow-verify.example')).toMatchObject({ part: 'name', excerpt: 'secure-escrow-verify.example' });
    expect(partnerWordingIssue('Chase Fraud Dept chase-verify.example')).toMatchObject({ why: expect.stringMatching(/web address/) });
    expect(partnerWordingIssue('Visit www.fix-it-now.test today')).not.toBeNull();
    expect(partnerWordingIssue(`${'Very Long Credit Company Name '.repeat(3)}LLC`)).toMatchObject({ part: 'name', why: `A business name longer than ${PARTNER_NAME_MAX} characters cannot be used in a subject line.` });
    for (const fine of ['St. Mary Credit Services', 'A.B. Smith & Co.', 'Bright Path Credit, Inc.', 'J. P. Rivera Credit Repair LLC']) expect(partnerWordingIssue(fine), fine).toBeNull();
    expect(partnerWordingIssue('Guaranteed Credit Fix')).toMatchObject({ part: 'name', why: 'Results cannot be guaranteed.' });
    expect(partnerWordingIssue('Boost Your Score Fast')).not.toBeNull();
    // The check is the guard the sender applies, not a part of it. The marketing rules read over subject and body accept
    // a negated guarantee; the base rules read over the whole text do not, and the sender would refuse every email.
    expect(findMarketingClaims('Introducing No Guarantee Credit Help: credit report help for your buyers')).toEqual([]);
    expect(partnerEmailIssue(partnerEmail('intro', 'en', vars({ orgName: 'No Guarantee Credit Help' })))).toMatchObject({ why: 'Results cannot be guaranteed.' });
    expect(partnerWordingIssue('No Guarantee Credit Help')).toMatchObject({ part: 'name', why: 'Results cannot be guaranteed.' });
    expect(Object.keys(PARTNER_CATEGORY_LABEL).sort()).toEqual([...PARTNER_CATEGORIES].sort());
  });

  it('the website address and the mailing address are in every email of an agency, so they are checked with the name', () => {
    const FREE = 'Only a first consultation may be called free. Do not call credit repair, reports, scores or results free.';
    // A name that passes by itself, and with an address of its site that says nothing.
    expect(partnerWordingIssue('Hill Credit')).toBeNull();
    expect(partnerWordingIssue('Hill Credit', { siteUrl: 'https://app.example.com/a/hill-credit-a1b', address: ADDRESS })).toBeNull();
    // The platform address keeps the name the workspace signed up with, and an agency's own domain is its own choice.
    for (const [siteUrl, why] of [['https://app.example.com/a/free-credit-help-a1b', FREE], ['https://boost-your-score.com', 'Do not promise a higher credit score.'], ['https://live-debt-free.com', FREE]] as const) {
      expect(partnerWordingIssue('Hill Credit', { siteUrl, address: ADDRESS }), siteUrl).toMatchObject({ part: 'website', why });
      // It is the email the sender would build and refuse: the introduction and the follow-up carry the link.
      expect(partnerEmailIssue(partnerEmail('intro', 'en', vars({ orgName: 'Hill Credit', siteUrl })))?.why, siteUrl).toBe(why);
      expect(partnerEmailIssue(partnerEmail('followup', 'es', vars({ orgName: 'Hill Credit', siteUrl }))), siteUrl).toBeDefined();
    }
    // The mailing address is printed under every email, where the base rules read it.
    expect(partnerWordingIssue('Hill Credit', { address: '100 Guarantee Blvd, Tampa, FL 33606' })).toMatchObject({ part: 'address', why: 'Results cannot be guaranteed.', excerpt: 'Guarantee' });
    expect(partnerWordingIssue('Hill Credit', { siteUrl: 'https://hillcredit.example', address: '100 Guarantee Blvd, Tampa, FL 33606' })).toMatchObject({ part: 'address' });
    // With more than one in the way, the name is named first, then the website.
    expect(partnerWordingIssue('Guaranteed Credit Fix', { siteUrl: 'https://live-debt-free.com', address: '100 Guarantee Blvd, Tampa, FL 33606' })).toMatchObject({ part: 'name' });
    expect(partnerWordingIssue('Hill Credit', { siteUrl: 'https://live-debt-free.com', address: '100 Guarantee Blvd, Tampa, FL 33606' })).toMatchObject({ part: 'website' });

    // The blocker the job and the pages read names which of the three it is, so the page can say what to change.
    const approved = { name: 'Hill Credit', outreach_approved_at: '2026-01-05T00:00:00Z', outreach_approved_name: 'Hill Credit' };
    const on = (address: string) => partnerSettings({ partner_outreach_enabled: true, lead_mailing_address: address, lead_reply_email: 'hello@hillcredit.example' });
    expect(partnerBlocker(on(ADDRESS), true, approved)).toBeNull();
    expect(partnerBlocker(on(ADDRESS), true, approved, 'https://app.example.com/a/hill-credit-a1b')).toBeNull();
    expect(partnerBlocker(on(ADDRESS), true, approved, 'https://app.example.com/a/free-credit-help-a1b')).toBe('site_claim');
    expect(partnerBlocker(on('100 Guarantee Blvd, Tampa, FL 33606'), true, approved)).toBe('address_claim');
    expect(partnerBlocker(on(ADDRESS), true, { ...approved, name: 'Guaranteed Credit Fix', outreach_approved_name: 'Guaranteed Credit Fix' }, 'https://live-debt-free.com')).toBe('name_claim');
    // Whatever is in the way first is still reported first.
    expect(partnerBlocker(on(ADDRESS), false, approved, 'https://live-debt-free.com')).toBe('email_not_connected');
  });

  it('a city whose name reads as a claim is refused when the partner is added, not when the email is sent', () => {
    for (const [city, word] of [['Free Soil', 'Free'], ['Guaranteed Approval', 'Guaranteed']] as const) {
      expect(isPlainCity(city)).toBe(true); // a place name like any other, and Free Soil is a real one
      // The introduction would print it, and the sender's guard would refuse that email.
      expect(partnerEmailIssue(partnerEmail('intro', 'en', vars({ city }))), city).toBeDefined();
      expect(partnerCityIssue(city)).toMatchObject({ excerpt: word });
      const r = partnerSchema.safeParse({ businessName: 'A', category: 'other', email: 'a@b.example', city });
      expect(r.success).toBe(false);
      expect(r.error?.issues.map((i) => i.message)).toEqual([`This city cannot be printed in the emails: “${word}” would read as a claim they may not make. Leave the city empty for this partner.`]);
      // Without the city the same partner is accepted, and the email no longer names a place.
      expect(partnerSchema.safeParse({ businessName: 'A', category: 'other', email: 'a@b.example' }).success).toBe(true);
    }
    // Every city the schema accepts gives an introduction the guard lets through, in every category and both languages.
    for (const city of ['Austin', 'St. Louis', 'Winston-Salem', 'Truth or Consequences', 'Freeport', 'Liberty', 'Hope', 'Normal', 'San José', 'Coeur d’Alene']) {
      expect(partnerCityIssue(city), city).toBeNull();
      expect(partnerSchema.safeParse({ businessName: 'A', category: 'other', email: 'a@b.example', city }).success, city).toBe(true);
      for (const lang of ['en', 'es'] as const) for (const category of PARTNER_CATEGORIES) expect(partnerEmailIssue(partnerEmail('intro', lang, vars({ category, city }))), `${city} ${category} ${lang}`).toBeUndefined();
    }
    // A sentence in the city column still gets the message about city names, and only that one.
    expect(partnerSchema.safeParse({ businessName: 'A', category: 'other', email: 'a@b.example', city: 'Free credit help. Call now' }).error?.issues.map((i) => i.message)).toEqual(['Enter the city name only, for example “Austin” or “St. Louis”']);
    // In a list the row is left out and named, like any other row that cannot be used.
    const list = parsePartnerList('business,email,category,city,state\nSoil Realty,a@soil.example,Realtor,Free Soil,MI\nOak Realty,d@oak.example,Realtor,Round Rock,TX', null);
    expect(list.rows.map((r) => r.city)).toEqual(['Round Rock']);
    expect(list.issues).toEqual([{ line: 2, message: 'city: This city cannot be printed in the emails: “Free” would read as a claim they may not make. Leave the city empty for this partner.' }]);
  });
});

// ================================================================ the mailing address
describe('the mailing address printed under every partner email', () => {
  const approved = { name: ORG, outreach_approved_at: '2026-01-05T00:00:00Z', outreach_approved_name: ORG };
  const saved = (address: unknown) => partnerSettings({ partner_outreach_enabled: true, lead_mailing_address: address, lead_reply_email: 'hello@brightpath.example' });

  it('saved text that is not shaped like a postal address reads as no address, and nothing is sent', () => {
    for (const junk of ['x', 'n/a', 'URGENT: your escrow account is on hold. Sign in at https://secure-escrow-verify.example/login today or the closing is cancelled.',
      'P.S. As we discussed at the expo, most local agents already use us.', 'Unsubscribe here instead: https://evil.example/u', '12 Main St, Austin, TX', 42, null]) {
      const s = saved(junk);
      expect(s.address, String(junk)).toBe('');
      expect(partnerBlocker(s, true, approved), String(junk)).toBe('no_address');
      // The blocker reads the address itself too, whoever built the settings it is given.
      expect(partnerBlocker({ enabled: true, address: String(junk), replyTo: 'hello@brightpath.example' }, true, approved), String(junk)).toBe('no_address');
    }
    expect(saved(`  ${ADDRESS} `)).toEqual({ enabled: true, address: ADDRESS, replyTo: 'hello@brightpath.example' });
    expect(partnerBlocker(saved(ADDRESS), true, approved)).toBeNull();
  });

  it('both forms check what is typed with the shared rule, and the operator’s command prints what is saved before it approves', () => {
    const read = (file: string) => readFileSync(path.join(process.cwd(), file), 'utf8');
    for (const file of ['src/app/app/partners/actions.ts', 'src/app/app/leads/actions.ts']) {
      expect(read(file), file).toMatch(/addressIssue = address \? mailingAddressIssue\(address\) : null/);
      expect(read(file), file).toMatch(/if \(addressIssue\) throw new UserError\(addressIssue\)/);
    }
    const script = read('scripts/approve-outreach.mjs');
    const printed = script.indexOf('Mailing address: ');
    expect(printed).toBeGreaterThan(0);
    expect(script.indexOf('Reply address: ')).toBeGreaterThan(printed);
    expect(printed).toBeLessThan(script.indexOf("'update public.organizations set outreach_approved_at"));
  });
});

// ================================================================ no model on the partner path
describe('nothing a model writes can reach a partner', () => {
  it('the partner code imports no AI code, the old setting is not read, and no page offers or shows AI wording', () => {
    const read = (file: string) => readFileSync(path.join(process.cwd(), file), 'utf8');
    for (const file of ['src/lib/partner-outreach.ts', 'src/lib/partner-emails.ts', 'src/lib/partner-import.ts', 'src/lib/partners.ts']) {
      expect(read(file), file).not.toMatch(/from '\.\/ai\/|rewriteSafely|getProvider|withAiCredits|acceptPersonalised|personalisationGoal|findFamiliarityClaims|protectedTerms|settings\.ai\b/);
    }
    expect(partnerSettings({ partner_outreach_enabled: true, partner_outreach_ai: true, lead_mailing_address: ADDRESS, lead_reply_email: 'a@b.example' })).toEqual({ enabled: true, address: ADDRESS, replyTo: 'a@b.example' });
    const list = read('src/app/app/partners/page.tsx');
    expect(list).not.toMatch(/name="ai"|AI_COSTS|providerStatus/);
    expect(read('src/app/app/partners/[id]/page.tsx')).not.toMatch(/Reworded by AI|ai_used/);
    // The page says what the emails take from the records, which is more than the category and the city.
    expect(list).toContain('From your records it takes each partner’s category, city and state and the contact’s first name, and from you your business name, your mailing address and a link to your website when it is published.');
    expect(list).not.toMatch(/uses only the category and city you entered/);
    // An email carries exactly these four parts, and nothing a rewording step would need.
    expect(Object.keys(partnerEmail('intro', 'en', vars())).sort()).toEqual(['body', 'footer', 'subject', 'text']);
  });
});

// ================================================================ adding a list
describe('partner list import', () => {
  const HEADER = 'Business name,Contact name,Email,Category,City,State,Phone,Source';
  it('reads a comma list with quoted cells, and a list pasted from a spreadsheet (tabs)', () => {
    const r = parsePartnerList(`﻿${HEADER}\r\n"Hill, Dale & Co",Dana Hill,DANA@HillDale.example,Realtor,Austin,tx,(512) 555-0134,Chamber directory\r\nKey Motors,,sales@keymotors.example,car dealer,Round Rock,TX,,\r\n`, null);
    expect(r.error).toBeUndefined();
    expect(r.issues).toEqual([]);
    expect(r.rows).toEqual([
      { businessName: 'Hill, Dale & Co', contactName: 'Dana Hill', category: 'real_estate_agent', email: 'dana@hilldale.example', phone: '(512) 555-0134', city: 'Austin', state: 'TX', language: 'en', sourceNote: 'Chamber directory' },
      { businessName: 'Key Motors', contactName: null, category: 'car_dealership', email: 'sales@keymotors.example', phone: null, city: 'Round Rock', state: 'TX', language: 'en', sourceNote: null },
    ]);
    const tabs = parsePartnerList('company\tname\te-mail\tlanguage\nCasa Linda Realty\tAna Ruiz\tana@casalinda.example\tEspañol', 'real_estate_agent');
    expect(tabs.rows).toEqual([{ businessName: 'Casa Linda Realty', contactName: 'Ana Ruiz', category: 'real_estate_agent', email: 'ana@casalinda.example', phone: null, city: null, state: null, language: 'es', sourceNote: null }]);
    expect(detectDelimiter('a;b;c\n1;2;3')).toBe(';');
    expect(parseDelimited('a,"b ""quoted"" and\nsecond line",c\n\n1,2,3', ',')).toEqual([['a', 'b "quoted" and\nsecond line', 'c'], ['1', '2', '3']]);
  });

  it('leaves out rows that are not valid and says which line and why', () => {
    const r = parsePartnerList([HEADER, 'Good Realty,,good@realty.example,real estate agent,,,,', 'No Email Co,,,loan officer,,,,', 'Bad Email Co,,not-an-email,loan officer,,,,', 'Odd Co,,odd@co.example,astronaut,,,,', '<b>Tag</b>,,tag@co.example,other,,,,'].join('\n'), null);
    expect(r.rows.map((x) => x.email)).toEqual(['good@realty.example']);
    expect(r.issues).toEqual([
      { line: 3, message: 'email: Enter a valid email address' },
      { line: 4, message: 'email: Enter a valid email address' },
      { line: 5, message: 'category “astronaut” is not one of the categories' },
      { line: 6, message: 'business name: Use plain text on one line' },
    ]);
  });

  it('a row with no category takes the chosen one, and is left out when none was chosen', () => {
    const list = 'business,email\nNorth Tax,hello@northtax.example';
    expect(parsePartnerList(list, 'tax_preparer').rows).toMatchObject([{ category: 'tax_preparer' }]);
    expect(parsePartnerList(list, null)).toMatchObject({ rows: [], issues: [{ line: 2, message: 'no category' }] });
    // With no business column, the contact name stands in for it.
    expect(parsePartnerList('name,email\nDana Hill,dana@hill.example', 'other').rows).toMatchObject([{ businessName: 'Dana Hill', contactName: 'Dana Hill' }]);
  });

  it('keeps the first of a repeated address, whatever its capitals', () => {
    const r = parsePartnerList('business,email,category\nA,one@a.example,other\nB,ONE@a.example,other\nC,two@a.example,other\nD,one@A.example ,other', null);
    expect(r.rows.map((x) => [x.businessName, x.email])).toEqual([['A', 'one@a.example'], ['C', 'two@a.example']]);
    expect(r.repeated).toBe(2);
  });

  it('refuses a list with no header, no email column or more rows than one import allows', () => {
    expect(parsePartnerList('', 'other').error).toMatch(/header line/);
    expect(parsePartnerList('only one line,email', 'other').error).toMatch(/header line/);
    expect(parsePartnerList('business,category\nA,other', 'other').error).toMatch(/must be "email"/);
    const many = ['business,email', ...Array.from({ length: PARTNER_IMPORT_MAX_ROWS + 1 }, (_, i) => `Co ${i},p${i}@list.example`)].join('\n');
    expect(parsePartnerList(many, 'other')).toMatchObject({ rows: [], error: `A list can have at most ${PARTNER_IMPORT_MAX_ROWS} rows per import. This one has ${PARTNER_IMPORT_MAX_ROWS + 1}; import it in parts.` });
    expect(parsePartnerList(many.split('\n').slice(0, PARTNER_IMPORT_MAX_ROWS + 1).join('\n'), 'other').rows).toHaveLength(PARTNER_IMPORT_MAX_ROWS);
    expect(parsePartnerList('x'.repeat(200_001), 'other').error).toMatch(/too large/);
  });

  it('recognises categories as people type them, and nothing else', () => {
    expect(partnerCategoryFrom('Realtor')).toBe('real_estate_agent');
    expect(partnerCategoryFrom('Real Estate Agent')).toBe('real_estate_agent');
    expect(partnerCategoryFrom('loan officer')).toBe('loan_officer');
    expect(partnerCategoryFrom('Mortgage Broker')).toBe('mortgage_broker');
    expect(partnerCategoryFrom('Car dealership')).toBe('car_dealership');
    expect(partnerCategoryFrom('car dealer')).toBe('car_dealership');
    expect(partnerCategoryFrom('Auto Dealer')).toBe('car_dealership');
    expect(partnerCategoryFrom('Tax preparer')).toBe('tax_preparer');
    expect(partnerCategoryFrom('Property Manager')).toBe('property_manager');
    expect(partnerCategoryFrom('Real-estate broker')).toBe('real_estate_agent');
    expect(partnerCategoryFrom('Loan Originator')).toBe('loan_officer');
    expect(partnerCategoryFrom('agente de bienes raíces')).toBe('real_estate_agent');
    expect(partnerCategoryFrom('real_estate_agent')).toBe('real_estate_agent');
    expect(partnerCategoryFrom('other')).toBe('other');
    for (const no of ['', 'astronaut', 'carpenter', 'scar tissue clinic']) expect(partnerCategoryFrom(no), no).toBeNull();
    // The whole cell has to be a category: a cell that only contains a familiar word is somebody else's job, and the
    // first email would tell them "you work as a real estate agent" (or at a car dealership, or in property management).
    for (const other of ['Real estate attorney', 'Real estate appraiser', 'Auto insurance agent', 'Art dealer', 'Boat dealer', 'Car wash', 'Auto body shop', 'Accountant', 'Tax attorney', 'CPA / tax preparer',
      'HR administrator', 'School administration', 'Mortgage servicer collections', 'Mortgage', 'Dealer', 'Leasing consultant', 'Loan officer assistant']) {
      expect(partnerCategoryFrom(other), other).toBeNull();
    }
    const list = parsePartnerList('business,email,category\nLaw Co,a@law.example,Real estate attorney\nShine,b@wash.example,Car wash\nHill Realty,c@hill.example,Realtor', null);
    expect(list.rows.map((r) => [r.businessName, r.category])).toEqual([['Hill Realty', 'real_estate_agent']]);
    expect(list.issues).toEqual([{ line: 2, message: 'category “Real estate attorney” is not one of the categories' }, { line: 3, message: 'category “Car wash” is not one of the categories' }]);
  });

  it('one partner: a business email address and a category are required, and text is plain', () => {
    const ok = partnerSchema.safeParse({ businessName: ' Key Motors ', category: 'car_dealership', email: ' Sales@KeyMotors.example ', state: 'tx', phone: '512-555-0134' });
    expect(ok.success && ok.data).toEqual({ businessName: 'Key Motors', contactName: null, category: 'car_dealership', email: 'sales@keymotors.example', phone: '512-555-0134', city: null, state: 'TX', language: 'en', sourceNote: null });
    for (const bad of [{ businessName: '', category: 'other', email: 'a@b.example' }, { businessName: 'A', category: 'astronaut', email: 'a@b.example' }, { businessName: 'A', category: 'other', email: 'nope' },
      { businessName: 'A', category: 'other', email: 'a@b.example', state: 'Texas' }, { businessName: 'A', category: 'other', email: 'a@b.example', phone: 'call me' }, { businessName: 'A', category: 'other', email: 'a@b.example', sourceNote: '<script>' }]) {
      expect(partnerSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
    expect(PARTNER_ATTESTATION).toMatch(/public business contact details and my own business contacts/);
    expect(PARTNER_ATTESTATION).toMatch(/none came from a bought, rented or scraped list/);
  });
});

// ================================================================ one mailbox, one partner
describe('one mailbox is one partner', () => {
  const read = (file: string) => readFileSync(path.join(process.cwd(), file), 'utf8');

  it('the unique key of a partner reads the address as the opt-out list does, and a database with the earlier key is brought forward', () => {
    const migration = read('db/migrations/0028_partner_outreach.sql');
    const key = 'create unique index if not exists partners_org_email_norm_idx on public.partners (org_id, app.email_norm(email));';
    expect(migration).toContain(key);
    // The function has to exist before the index that uses it.
    expect(migration.indexOf('create or replace function app.email_norm(addr text)')).toBeLessThan(migration.indexOf(key));
    // The key on the literal address is no longer created, and is dropped only once the new one is there.
    expect(migration).not.toMatch(/create unique index[^;]*partners_org_email_idx/);
    expect(migration).toMatch(/if to_regclass\('public\.partners_org_email_norm_idx'\) is not null then\s+drop index if exists public\.partners_org_email_idx;/);
    expect(migration.indexOf(key)).toBeLessThan(migration.indexOf('drop index if exists public.partners_org_email_idx;'));
  });

  it('adding partners skips a row that is already on the list, whichever unique key says so', () => {
    const sender = read('src/lib/partner-outreach.ts');
    expect(sender).toMatch(/on conflict do nothing returning id/);
    expect(sender).not.toMatch(/on conflict \(org_id, email\)/);
  });
});

// ================================================================ text follow-up for people who sent the enquiry form
describe('lead text follow-up: consent wording and messages', () => {
  it('the consent box names the business, says the texts are automated and optional, and how to stop', () => {
    const en = leadSmsConsentText('en', ORG);
    for (const re of [/automated text messages from Bright Path Credit/, /the mobile number I entered above/, /not a condition of buying anything/, /Message frequency varies/, /Message and data rates may apply/, /Reply STOP to stop, HELP for help/]) expect(en).toMatch(re);
    const es = leadSmsConsentText('es', ORG);
    for (const re of [/mensajes de texto automatizados de Bright Path Credit/, /no es una condición para comprar nada/, /Responda STOP/, /HELP para ayuda/]) expect(es).toMatch(re);
    for (const t of [en, es]) { expect(t.length).toBeGreaterThan(20); expect(t.length).toBeLessThan(2000); expect(findBlockedClaims(t)).toEqual([]); }
    // It is worded apart from the "you may contact me" box, so the two can never be mistaken for one another.
    expect(en).not.toMatch(/may contact me/);
    expect(LEAD_SMS_NEEDS_PHONE.en).toMatch(/untick the text message box/);
  });

  it('every text names the sender, says how to stop, stays short and promises nothing', () => {
    for (const lang of ['en', 'es'] as const) for (const { key } of LEAD_TEXT_STEPS) {
      const t = leadText(key, lang, { orgName: ORG });
      expect(t.startsWith(`${ORG}: `)).toBe(true);
      expect(t).toMatch(lang === 'es' ? /Responda STOP para no recibir más mensajes, HELP para ayuda\.$/ : /Reply STOP to stop, HELP for help\.$/);
      expect(findBlockedClaims(t)).toEqual([]);
      expect(findMarketingClaims(t)).toEqual([]);
      expect(t).not.toMatch(/\d|https?:|score|puntaje|report|informe/i);
      expect(leadText(key, lang, { orgName: 'A very long business name that goes on and on and on and on' }).length).toBeLessThanOrEqual(SMS_MAX_CHARS);
    }
  });

  it('the enquiry form shows the text box only when texts are offered: separate, optional and never ticked for the person', () => {
    const form = (offerTexts: boolean, lang: 'en' | 'es' = 'en') => renderToStaticMarkup(createElement(LeadFields, { slug: 'bright-path', orgName: ORG, lang, offerTexts }));
    const off = form(false);
    expect(off).toContain('name="consent"');
    expect(off).not.toContain('smsConsent');
    expect(off).not.toMatch(/text messages/i);
    const on = form(true);
    expect(on.match(/type="checkbox"/g)).toHaveLength(2);
    expect(on).toContain('name="consent"');
    expect(on).toContain('name="smsConsent"');
    expect(on).not.toMatch(/checked/); // neither box is ever pre-ticked
    expect(on).not.toMatch(/name="smsConsent"[^>]*required/); // and the text box is optional
    // The wording beside the box is exactly the wording stored with the consent.
    expect(on.replace(/&#x27;/g, "'")).toContain(leadSmsConsentText('en', ORG));
    expect(form(true, 'es')).toContain(leadSmsConsentText('es', ORG));
    // Only the "you may contact me" box carries those words, so nothing that selects on them can pick the wrong box.
    expect(on.match(/may contact me/g)).toHaveLength(1);
  });

  const DAY = 86_400_000;
  const T0 = new Date('2026-03-02T15:00:00Z');
  const at = (days: number) => new Date(T0.getTime() + days * DAY);
  const PHONE = '+15125550134';
  const lead = (over: Partial<LeadTextState> = {}): LeadTextState => ({
    status: 'lead', consented: true, optedOut: false, replied: false, contacted: false, consentPhone: PHONE, phone: PHONE, receivedAt: T0, eligibleFrom: at(-1), texts: [], ...over,
  });
  const sent = (step: string, day: number) => ({ step, status: 'sent', at: at(day) });

  it('no text consent from the enquiry form means no text, whatever else is true', () => {
    expect(decideLeadText(lead({ consentPhone: null }), at(0))).toEqual({ kind: 'stop', reason: 'no_consent' });
    expect(decideLeadText(lead({ consented: false }), at(0))).toEqual({ kind: 'stop', reason: 'no_consent' });
    // The consent is for one number: a different or unreadable number on the record stops the text.
    expect(decideLeadText(lead({ phone: '+15125550199' }), at(0))).toEqual({ kind: 'stop', reason: 'number_changed' });
    expect(decideLeadText(lead({ phone: null }), at(0))).toEqual({ kind: 'stop', reason: 'number_changed' });
  });

  it('with consent: a welcome text at once, a follow-up after 3 days, then nothing', () => {
    expect(decideLeadText(lead(), at(0))).toEqual({ kind: 'send', step: 'text_welcome' });
    expect(decideLeadText(lead({ texts: [sent('text_welcome', 0)] }), at(2))).toEqual({ kind: 'wait', step: 'text_followup', dueAt: at(3) });
    expect(decideLeadText(lead({ texts: [sent('text_welcome', 0)] }), at(3))).toEqual({ kind: 'send', step: 'text_followup' });
    expect(decideLeadText(lead({ texts: [sent('text_welcome', 0), sent('text_followup', 3)] }), at(5))).toEqual({ kind: 'stop', reason: 'done' });
    // A welcome held back by quiet hours or a late run still leaves two days before the next text.
    expect(decideLeadText(lead({ texts: [sent('text_welcome', 2)] }), at(3))).toEqual({ kind: 'wait', step: 'text_followup', dueAt: at(4) });
  });

  it('stops for the same reasons as the emails, and a failed or unconfirmed text is never sent again', () => {
    const reason = (over: Partial<LeadTextState>, day = 1) => { const d = decideLeadText(lead(over), at(day)); return d.kind === 'stop' ? d.reason : d.kind; };
    expect(reason({ status: 'onboarding' })).toBe('not_lead');
    expect(reason({ optedOut: true })).toBe('opted_out');
    expect(reason({ replied: true })).toBe('replied');
    expect(reason({ contacted: true })).toBe('contacted');
    expect(reason({ eligibleFrom: null })).toBe('before_switch');
    expect(reason({ eligibleFrom: at(1) })).toBe('before_switch');
    expect(reason({ texts: [{ step: 'text_welcome', status: 'failed', at: at(0) }] })).toBe('failed');
    expect(reason({ texts: [{ step: 'text_welcome', status: 'sending', at: at(0) }] })).toBe('unconfirmed');
    expect(reason({ texts: [sent('text_welcome', 0)] }, 15)).toBe('expired');
  });
});
