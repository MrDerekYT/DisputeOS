import { describe, expect, it } from 'vitest';
import { findBlockedClaims } from '@/lib/compliance/claims';
import {
  addBusinessDays, addDays, disputeClock, FEDERAL_HOLIDAYS, HOLIDAYS_THROUGH, holidayTableCovers, isBusinessDay, isFederalHoliday, procedureDescriptionDue, receivedDay,
  noResponseAfter, reinvestigationDue, resultsNoticeDue, toDay, withinOriginalPeriod, type Day,
} from '@/lib/disputes/clock';
import { complaintSummary, escalationBasis, escalationSteps, NO_RESPONSE_COPY, type ComplaintFacts, type EscalationInput } from '@/lib/disputes/next-steps';
import { nextSteps, OUTCOME_LABEL, OUTCOMES, responseDueDate } from '@/lib/disputes/workflow';
import { dayWindow, windowStart } from '@/lib/day-meter';
import { findGuideClaims } from '@/lib/guide/llm';
import { buildValues, mergeTemplate, unresolvedPlaceholders } from '@/lib/letters/render';
import { isConcreteReason, reasonInLetter, specificityIssues, statesEnclosures, type SpecificityInput } from '@/lib/letters/specificity';
import { KIND_LABEL, PROCEDURE_TEMPLATES, procedureTemplateKey, templateByKey, TEMPLATES } from '@/lib/letters/templates';
import { tr } from '@/lib/portal-i18n';

// ---------------------------------------------------------------- holidays, rebuilt from the rules in 5 U.S.C. § 6103
const iso = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10);
const weekday = (day: Day) => new Date(`${day}T00:00:00Z`).getUTCDay();
/** The n-th given weekday of a month (n = -1 for the last). */
function nth(y: number, m: number, wd: number, n: number): Day {
  if (n > 0) { const first = weekday(iso(y, m, 1)); return iso(y, m, 1 + ((wd - first + 7) % 7) + (n - 1) * 7); }
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return iso(y, m, last - ((weekday(iso(y, m, last)) - wd + 7) % 7));
}
/** A fixed-date holiday on the day it is observed: Saturday moves to Friday, Sunday to Monday. */
function observed(y: number, m: number, d: number): Day {
  const w = weekday(iso(y, m, d));
  return w === 6 ? addDays(iso(y, m, d), -1) : w === 0 ? addDays(iso(y, m, d), 1) : iso(y, m, d);
}
function holidaysByRule(y: number): Day[] {
  return [
    observed(y, 1, 1), nth(y, 1, 1, 3), nth(y, 2, 1, 3), nth(y, 5, 1, -1), observed(y, 6, 19), observed(y, 7, 4),
    nth(y, 9, 1, 1), nth(y, 10, 1, 2), observed(y, 11, 11), nth(y, 11, 4, 4), observed(y, 12, 25),
  ];
}

describe('federal holiday table', () => {
  it('matches the statutory rules for every year it covers, including days observed in the neighbouring year', () => {
    const years = Object.keys(FEDERAL_HOLIDAYS).map(Number);
    expect(years).toEqual([2025, 2026, 2027, 2028, 2029, 2030]);
    expect(HOLIDAYS_THROUGH).toBe(2030);
    const table = Object.values(FEDERAL_HOLIDAYS).flat().sort();
    // New Year's Day 2031 (a Wednesday) is not observed in 2030; New Year's Day 2028 (a Saturday) is observed on 2027-12-31.
    const ruled = [...years, 2031].flatMap(holidaysByRule).filter((d) => d >= '2025-01-01' && d <= '2030-12-31').sort();
    expect(table).toEqual(ruled);
    for (const [y, days] of Object.entries(FEDERAL_HOLIDAYS)) for (const d of days) expect(d.slice(0, 4), d).toBe(y);
    for (const d of table) expect(weekday(d) !== 0 && weekday(d) !== 6, d).toBe(true); // observed days are never a weekend
  });

  it('knows the awkward ones', () => {
    expect(isFederalHoliday('2026-07-03')).toBe(true);   // July 4, 2026 is a Saturday
    expect(isFederalHoliday('2026-07-04')).toBe(false);  // ...and is a weekend anyway
    expect(isFederalHoliday('2027-07-05')).toBe(true);   // July 4, 2027 is a Sunday
    expect(isFederalHoliday('2027-12-31')).toBe(true);   // New Year's Day 2028, observed
    expect(isFederalHoliday('2028-11-10')).toBe(true);   // Veterans Day 2028 is a Saturday
    expect(isFederalHoliday('2026-11-26')).toBe(true);   // Thanksgiving
    expect(isFederalHoliday('2026-11-27')).toBe(false);  // the day after is an ordinary business day
    expect(isBusinessDay('2026-11-28')).toBe(false);     // Saturday
    expect(holidayTableCovers('2030-12-31')).toBe(true);
    expect(holidayTableCovers('2031-01-02')).toBe(false);
  });
});

describe('business-day arithmetic', () => {
  it('skips weekends and never counts the starting day', () => {
    expect(addBusinessDays('2026-03-02', 1)).toBe('2026-03-03'); // Monday → Tuesday
    expect(addBusinessDays('2026-03-06', 1)).toBe('2026-03-09'); // Friday → Monday
    expect(addBusinessDays('2026-03-07', 1)).toBe('2026-03-09'); // Saturday → Monday
    expect(addBusinessDays('2026-03-06', 5)).toBe('2026-03-13'); // a full week
    expect(addBusinessDays('2026-03-06', 0)).toBe('2026-03-06');
  });

  it('skips federal holidays, on the day they are observed', () => {
    expect(addBusinessDays('2026-11-25', 5)).toBe('2026-12-03'); // over Thanksgiving and a weekend
    expect(addBusinessDays('2026-07-01', 5)).toBe('2026-07-09'); // over Friday July 3 (observed) and a weekend
    expect(addBusinessDays('2027-12-28', 5)).toBe('2028-01-05'); // over December 31 (New Year's Day observed)
    expect(addBusinessDays('2026-12-24', 1)).toBe('2026-12-28'); // Christmas on a Friday, then the weekend
    expect(addBusinessDays('2026-01-16', 1)).toBe('2026-01-20'); // Martin Luther King Jr. Day
  });

  it('written results: 5 business days after the reinvestigation is completed, § 1681i(a)(6)(A)', () => {
    expect(resultsNoticeDue('2026-03-02')).toBe('2026-03-09');
    expect(resultsNoticeDue('2026-11-25')).toBe('2026-12-03');
    expect(resultsNoticeDue('2026-05-21')).toBe('2026-05-29'); // over Memorial Day
  });
});

describe('reinvestigation period, § 1681i(a)(1)', () => {
  it('is 30 days from receipt, 45 when extended', () => {
    expect(reinvestigationDue('2026-01-05', false)).toBe('2026-02-04');
    expect(reinvestigationDue('2026-01-05', true)).toBe('2026-02-19');
    expect(reinvestigationDue('2028-02-01', false)).toBe('2028-03-02'); // leap year
  });

  it('agrees with the deadline the service stores and with the window meter', () => {
    for (const extended of [false, true]) {
      const received = new Date('2026-01-05T12:00:00Z');
      const due = responseDueDate(received, extended);
      expect(toDay(due)).toBe(reinvestigationDue('2026-01-05', extended));
      expect(receivedDay(due.toISOString(), extended)).toBe('2026-01-05');
      expect(toDay(windowStart(due, extended)!)).toBe('2026-01-05');
      expect(dayWindow(windowStart(due, extended), due, received).totalDays).toBe(extended ? 45 : 30);
    }
  });

  it('only information sent during the first 30 days extends it', () => {
    expect(withinOriginalPeriod('2026-01-05', '2026-01-05')).toBe(true);
    expect(withinOriginalPeriod('2026-01-05', '2026-02-04')).toBe(true);
    expect(withinOriginalPeriod('2026-01-05', '2026-02-05')).toBe(false);
    expect(withinOriginalPeriod('2026-01-05', '2026-01-04')).toBe(false);
  });

  it('the description of the procedure is due 15 calendar days after the request is received, § 1681i(a)(7)', () => {
    expect(procedureDescriptionDue('2026-03-02')).toBe('2026-03-17');
    expect(procedureDescriptionDue('2026-12-20')).toBe('2027-01-04'); // calendar days: holidays and weekends count
  });
});

describe('the clock shown on a dispute', () => {
  const base = { dueAt: '2026-02-04T12:00:00.000Z', extended: false, moreInfoOn: null, completedOn: null, responseOn: null };

  it('is empty before submission and cites a section beside every date', () => {
    expect(disputeClock({ ...base, dueAt: null }, '2026-01-10')).toEqual([]);
    const rows = disputeClock(base, '2026-01-10');
    expect(rows.map((r) => [r.key, r.date, r.cite, r.state])).toEqual([
      ['received', '2026-01-05', '§ 1681i(a)(1)(A)', 'fact'], ['reinvestigation', '2026-02-04', '§ 1681i(a)(1)(A)', 'ahead'],
    ]);
    expect(rows[1]!.label).toBe('Reinvestigation period ends (30 days)');
  });

  it('shows the 45-day extension as such, with the date the client sent more information', () => {
    const rows = disputeClock({ ...base, dueAt: '2026-02-19T12:00:00.000Z', extended: true, moreInfoOn: '2026-01-20' }, '2026-01-25');
    expect(rows[0]!.date).toBe('2026-01-05'); // the receipt date does not move
    expect(rows[1]).toMatchObject({ date: '2026-02-19', cite: '§ 1681i(a)(1)(B)', label: 'Reinvestigation period ends (45 days)' });
    expect(rows[1]!.note).toMatch(/client sent more information on Jan 20, 2026/);
    // Ticked by hand at submission, with no date: said to be manual, and the free annual report is given as the example.
    // That 45-day period comes from § 1681j(a)(3), not from the more-information extension in § 1681i(a)(1)(B).
    const manual = disputeClock({ ...base, dueAt: '2026-02-19T12:00:00.000Z', extended: true }, '2026-01-25');
    expect(manual[1]!.note).toMatch(/^45 days from receipt\..*ticked when the submission was recorded.*free annual report/);
    expect(manual[1]!.note).not.toMatch(/15 more days/);
    expect(manual[1]!.cite).toBe('§ 1681j(a)(3)');
  });

  it('reads a stored timestamp as a day where the agency works, not in UTC', () => {
    // Recorded at 8:30 p.m. Eastern on Jan 5: already Jan 6 in UTC. The receipt day is Jan 5.
    const evening = { ...base, dueAt: '2026-02-05T01:30:00.000Z' };
    expect(disputeClock({ ...evening, tz: 'America/New_York' }, '2026-01-10').map((r) => r.date)).toEqual(['2026-01-05', '2026-02-04']);
    expect(disputeClock(evening, '2026-01-10').map((r) => r.date)).toEqual(['2026-01-06', '2026-02-05']); // what UTC would have said
    expect(toDay('2026-02-05T01:30:00.000Z', 'America/New_York')).toBe('2026-02-04');
    expect(toDay('2026-02-05T01:30:00.000Z', 'America/Los_Angeles')).toBe('2026-02-04');
    expect(toDay('2026-02-04T12:00:00.000Z', 'Pacific/Honolulu')).toBe('2026-02-04'); // a typed date (stored at noon UTC) is the same day everywhere in the US
    expect(toDay('2026-02-04', 'America/New_York')).toBe('2026-02-04');
    expect(receivedDay('2026-02-05T01:30:00.000Z', false, 'America/New_York')).toBe('2026-01-05');
  });

  it('adds the written-results date only once a completion date is recorded', () => {
    expect(disputeClock(base, '2026-01-30').some((r) => r.key === 'results')).toBe(false);
    const rows = disputeClock({ ...base, completedOn: '2026-01-28', responseOn: '2026-02-02' }, '2026-02-10');
    expect(rows.find((r) => r.key === 'results')).toMatchObject({ date: '2026-02-04', cite: '§ 1681i(a)(6)(A)', state: 'done' });
    expect(rows.find((r) => r.key === 'reinvestigation')!.state).toBe('done');
  });

  it('a date that passes with nothing recorded is "passed", and the wording never calls it late or a violation', () => {
    const rows = disputeClock({ ...base, completedOn: '2026-01-28' }, '2026-03-01');
    expect(rows.filter((r) => r.state === 'passed').map((r) => r.key)).toEqual(['reinvestigation', 'results']);
    for (const r of rows) expect(`${r.label} ${r.note}`).not.toMatch(/violat|late\b|missed|failed|illegal|breach/i);
  });

  it('runs the 15-day clock from the sent date until a receipt date is recorded', () => {
    const sent = { sentOn: '2026-03-02', receivedOn: null, replyDueOn: null, replyReceivedOn: null };
    const a = disputeClock({ ...base, responseOn: '2026-02-01', procedure: sent }, '2026-03-05').find((r) => r.key === 'procedure')!;
    expect(a).toMatchObject({ date: '2026-03-17', cite: '§ 1681i(a)(7)', state: 'ahead' });
    expect(a.note).toMatch(/counted from the day the request was sent/);
    const b = disputeClock({ ...base, responseOn: '2026-02-01', procedure: { ...sent, receivedOn: '2026-03-06', replyDueOn: '2026-03-21' } }, '2026-03-25').find((r) => r.key === 'procedure')!;
    expect(b).toMatchObject({ date: '2026-03-21', state: 'passed' });
    const c = disputeClock({ ...base, responseOn: '2026-02-01', procedure: { ...sent, replyReceivedOn: '2026-03-10' } }, '2026-03-25').find((r) => r.key === 'procedure')!;
    expect(c.state).toBe('done');
    expect(disputeClock({ ...base, procedure: { ...sent, sentOn: null } }, '2026-03-05').some((r) => r.key === 'procedure')).toBe(false);
  });
});

// ---------------------------------------------------------------- optional next steps
const verified: EscalationInput = { targetType: 'bureau', category: 'incorrect_balance', status: 'response_received', outcome: 'verified', dueAt: '2026-02-04T12:00:00Z', confirmedAccurate: false, hasTradeline: true };
const keys = (i: EscalationInput, today = '2026-02-10') => escalationSteps(i, today)?.steps.map((s) => s.key) ?? null;

describe('optional next steps', () => {
  it('after "verified as reported": the four options, in order', () => {
    expect(escalationSteps(verified, '2026-02-10')!.basis).toBe('verified');
    expect(keys(verified)).toEqual(['procedure_request', 'consumer_statement', 'furnisher_dispute', 'cfpb_complaint']);
    expect(keys({ ...verified, status: 'resolved' })).toEqual(['procedure_request', 'consumer_statement', 'furnisher_dispute', 'cfpb_complaint']);
  });

  it('offers nothing for an item the client has confirmed is accurate', () => {
    expect(escalationSteps({ ...verified, confirmedAccurate: true }, '2026-02-10')).toBeNull();
    expect(escalationSteps({ ...verified, status: 'submitted', outcome: null, confirmedAccurate: true }, '2026-03-10')).toBeNull();
  });

  it('offers nothing for other results, other recipients, or while the period is still running', () => {
    for (const outcome of ['deleted', 'updated', 'unresolved', 'frivolous']) expect(keys({ ...verified, outcome }), outcome).toBeNull();
    for (const targetType of ['furnisher', 'collector']) expect(keys({ ...verified, targetType }), targetType).toBeNull();
    expect(keys({ ...verified, status: 'submitted', outcome: null }, '2026-02-04')).toBeNull(); // the last day of the period
    expect(keys({ ...verified, status: 'draft', outcome: null, dueAt: null })).toBeNull();
  });

  it('leaves the direct dispute out where Regulation V generally does not provide for one', () => {
    expect(keys({ ...verified, category: 'unauthorized_inquiry' })).toEqual(['procedure_request', 'consumer_statement', 'cfpb_complaint']);
    expect(keys({ ...verified, category: 'personal_info' })).toEqual(['procedure_request', 'consumer_statement', 'cfpb_complaint']);
    expect(keys({ ...verified, targetType: 'agency', category: 'specialty_item' })).toEqual(['procedure_request', 'consumer_statement', 'cfpb_complaint']);
    // 12 CFR 1022.43(b)(1)(iv): information derived from public records. A dispute with no account on the report
    // (an obsolete bankruptcy, say) has no furnisher to write to, whatever its category.
    expect(keys({ ...verified, category: 'obsolete', hasTradeline: false })).toEqual(['procedure_request', 'consumer_statement', 'cfpb_complaint']);
    expect(keys({ ...verified, status: 'resolved', outcome: 'no_response', hasTradeline: false })).toEqual(['results_request', 'cfpb_complaint']);
  });

  it('no response recorded by the deadline: ask for the results first, and never the steps that need a result', () => {
    const waiting: EscalationInput = { ...verified, status: 'under_investigation', outcome: null };
    // The period ended Wed Feb 4. The agency generally has 5 business days after completing its reinvestigation to
    // send written results (§ 1681i(a)(6)(A)): Feb 11. Plus 7 days for the mail: Feb 18. Nothing is said before Feb 19.
    expect(noResponseAfter('2026-02-04')).toBe('2026-02-18');
    for (const day of ['2026-02-05', '2026-02-11', '2026-02-18']) expect(escalationBasis(waiting, day), day).toBeNull();
    expect(escalationBasis(waiting, '2026-02-19')).toBe('no_response');
    expect(keys(waiting, '2026-02-19')).toEqual(['results_request', 'furnisher_dispute', 'cfpb_complaint']);
    // A federal holiday in the five business days pushes it out: period ends Fri Feb 13, Presidents Day is Mon Feb 16.
    expect(noResponseAfter('2026-02-13')).toBe('2026-03-02'); // Tue 17, Wed 18, Thu 19, Fri 20, Mon 23, then 7 days
    // A deadline stored on the evening of Feb 4 Eastern (Feb 5 in UTC) is still Feb 4.
    expect(escalationBasis({ ...waiting, dueAt: '2026-02-05T01:30:00Z', tz: 'America/New_York' }, '2026-02-19')).toBe('no_response');
    expect(escalationBasis({ ...waiting, dueAt: '2026-02-05T01:30:00Z' }, '2026-02-19')).toBeNull();
    expect(keys({ ...verified, status: 'resolved', outcome: 'no_response' })).toEqual(['results_request', 'furnisher_dispute', 'cfpb_complaint']);
    expect(NO_RESPONSE_COPY.title).toBe('No response recorded');
    expect(NO_RESPONSE_COPY.body).toMatch(/5 business days plus 7 days for the mail/);
    expect(NO_RESPONSE_COPY.body).toMatch(/Check the mail/);
    expect(`${NO_RESPONSE_COPY.title} ${NO_RESPONSE_COPY.body}`).not.toMatch(/violat|illegal|broke|failed to|missed|must now|entitled/i);
  });

  it('every option says what it is and is not, cites its source, and promises nothing', () => {
    const all = [...escalationSteps(verified, '2026-02-10')!.steps, ...escalationSteps({ ...verified, status: 'submitted', outcome: null }, '2026-03-01')!.steps];
    for (const s of all) {
      const text = `${s.title}. ${s.is} ${s.isNot}`;
      expect(findBlockedClaims(text), s.key).toEqual([]);
      expect(findGuideClaims(text), s.key).toEqual([]);
      expect(s.isNot, s.key).toMatch(/\bnot\b/);
      expect(s.cite.length, s.key).toBeGreaterThan(8);
      expect(text, s.key).not.toMatch(/violat|sue\b|lawsuit|damages|will be (deleted|removed|corrected)|must (delete|remove)|demand/i);
    }
    const byKey = Object.fromEntries(all.map((s) => [s.key, s]));
    expect(byKey.procedure_request!.isNot).toMatch(/request for information.*does not by itself change the report/);
    expect(byKey.procedure_request!.is).toMatch(/generally has 15 days/);
    expect(byKey.procedure_request!.cite).toBe('15 U.S.C. § 1681i(a)(6)(B)(iii) and (a)(7)');
    expect(byKey.consumer_statement!.cite).toMatch(/1681i\(b\)/);
    expect(byKey.furnisher_dispute!.cite).toMatch(/12 CFR § 1022\.43/);
    expect(byKey.furnisher_dispute!.isNot).toMatch(/generally need not investigate a dispute it reasonably believes was submitted by, prepared by, or sent on a form supplied by a credit repair organization/);
    expect(byKey.furnisher_dispute!.isNot).toMatch(/the client’s own, written, signed and sent by the client/);
    expect(byKey.cfpb_complaint!.isNot).toMatch(/the client files it themselves/);
  });

  it('the older one-line suggestions still cover every outcome', () => {
    for (const o of OUTCOMES) {
      expect(OUTCOME_LABEL[o]).toBeTruthy();
      expect(nextSteps({ status: 'resolved', round: 1, due_at: null, outcome: o, hasApprovedLetter: true, evidenceCount: 0 })).toHaveLength(1);
      // Once the client has confirmed the item is accurate, the one line offers nothing (15 U.S.C. § 1679b(a)(1)).
      const stopped = nextSteps({ status: 'resolved', round: 1, due_at: null, outcome: o, hasApprovedLetter: true, evidenceCount: 0, confirmedAccurate: true });
      expect(stopped).toHaveLength(1);
      expect(stopped[0]).toMatch(/confirmed this item is reported accurately\. No further letter or round/);
      expect(stopped[0]).not.toMatch(/another round if|method of verification/i);
      for (const lang of ['en', 'es'] as const) expect(tr(lang)(`o_${o}` as 'o_deleted'), `${lang} ${o}`).toMatch(/\S{3}/);
    }
  });
});

describe('summary for the client’s own CFPB complaint', () => {
  const facts: ComplaintFacts = {
    company: 'Experian', item: 'Acme Bank ••1234 (Experian)', reason: 'Experian reports a balance of $1,200.00. My January statement shows $900.00.', sentOn: '2026-01-02', sentMethod: 'certified_mail', tracking: '7019 0001',
    receivedOn: '2026-01-05', periodDays: 30, periodEndsOn: '2026-02-04', responseOn: null, outcomeText: null, procedureRequestSentOn: null, procedureReplyOn: null, today: '2026-02-10',
  };

  it('lists the recorded dates and facts in English and Spanish and passes the claims guard', () => {
    const en = complaintSummary(facts, 'en');
    for (const s of ['Company: Experian', 'Dispute sent: January 2, 2026 (certified mail, reference 7019 0001)', 'Received by the company: January 5, 2026', 'End of the 30-day reinvestigation period counted from receipt: February 4, 2026', 'Response: none recorded as of February 10, 2026', facts.reason]) expect(en).toContain(s);
    const es = complaintSummary({ ...facts, responseOn: '2026-02-01', outcomeText: 'verificado tal como se informa', procedureRequestSentOn: '2026-02-08' }, 'es');
    for (const s of ['Empresa: Experian', 'Disputa enviada: 2 de enero de 2026 (correo certificado, referencia 7019 0001)', 'Respuesta recibida: 1 de febrero de 2026 (verificado tal como se informa)', 'Solicitud de la descripción del procedimiento de reinvestigación enviada: 8 de febrero de 2026', 'Descripción recibida: no registrada']) expect(es).toContain(s);
    for (const text of [en, es]) {
      expect(findBlockedClaims(text)).toEqual([]);
      expect(findGuideClaims(text)).toEqual([]);
      // Facts only: no conclusion about the company, no request for an outcome.
      expect(text).not.toMatch(/violat|illegal|failed|late\b|missed|must|demand|delete|remove|eliminar|borrar|incumpl|ilegal|exij/i);
    }
  });

  it('refuses to prepare a summary from wording the claims guard blocks', () => {
    expect(() => complaintSummary({ ...facts, reason: 'They are legally required to delete this.' })).toThrow(/prohibited claims/);
  });
});

// ---------------------------------------------------------------- the request for the reinvestigation procedure
describe('method-of-verification template (English only)', () => {
  // The date of birth and SSN digits a bureau letter states are on this client's record.
  const client = { full_name: 'Jordan Rivera', address: { line1: '123 Main St', city: 'Tampa', state: 'FL', zip: '33602' }, ssn_last4: '4321', dob: '1985-03-03' };
  const dispute = { item_label: 'Acme Bank ••1234 (Experian)', bureau: 'experian', recipient_name: 'Experian', reason: 'Experian reports a balance of $1,200.00.', fields: ['Balance'], round: 1, submitted_at: '2026-01-02T12:00:00Z', response_at: '2026-02-01T12:00:00Z' };

  it('exists in English only, outside the general template list', () => {
    expect(PROCEDURE_TEMPLATES.map((x) => [x.key, x.language, x.kind])).toEqual([['method_of_verification_en', 'en', 'method_of_verification']]);
    expect(templateByKey(procedureTemplateKey())!.language).toBe('en');
    expect(templateByKey('method_of_verification_es')).toBeUndefined();
    expect(TEMPLATES.some((x) => x.kind === 'method_of_verification')).toBe(false);
    expect(KIND_LABEL.method_of_verification).toBe('Request for the reinvestigation procedure');
  });

  it('merge completely, cite the section, and ask for the description and nothing else', () => {
    for (const tpl of PROCEDURE_TEMPLATES) {
      const body = mergeTemplate(tpl.body, buildValues({ client, language: tpl.language, dispute, now: new Date('2026-02-10T12:00:00Z') }));
      expect(unresolvedPlaceholders(body), tpl.key).toEqual([]);
      expect(findBlockedClaims(body), tpl.key).toEqual([]);
      expect(findGuideClaims(body), tpl.key).toEqual([]);
      expect(body, tpl.key).toContain('15 U.S.C. § 1681i(a)(7)');
      expect(body, tpl.key).toContain('Acme Bank, account ending 1234'); // the item as a letter names it, not as a list on screen labels it
      expect(body, tpl.key).not.toMatch(/••|\(Experian\)/);
      expect(body, tpl.key).toContain('P.O. Box 4500, Allen, TX 75013');
      expect(body, tpl.key).toContain('Tampa, FL 33602\nDate of birth: March 3, 1985\nSSN (last 4): 4321\n\nExperian'); // identified the way the bureau asks
      // No demand, no threat, no deadline stated to the agency, no request to change the file, and the dispute reason is not repeated.
      expect(body, tpl.key).not.toMatch(/delet|remov|elimin|borr|correct|corrij|\b15\s+(days|d[ií]as)|\b(must|shall|demand|fail|otherwise|violat|lawsuit|attorney|sue)\b|\b(deben|exij|demand|de lo contrario|abogad)\w*/i);
      expect(body, tpl.key).not.toContain(dispute.reason);
    }
    const en = mergeTemplate(PROCEDURE_TEMPLATES[0]!.body, buildValues({ client, language: 'en', dispute }));
    expect(en).toMatch(/On January 2, 2026 I sent you a dispute about the item above\. Your results, which I received on February 1, 2026, state that the information was verified\./);
    expect(en).toMatch(/This letter is a request for that description\. It is not a new dispute\./);
  });

  it('leaves the dates for a person when they are not on record', () => {
    const body = mergeTemplate(PROCEDURE_TEMPLATES[0]!.body, buildValues({ client, language: 'en', dispute: { ...dispute, submitted_at: null, response_at: null } }));
    expect(unresolvedPlaceholders(body)).toEqual(['[DATE NEEDED]']);
  });
});

// ---------------------------------------------------------------- specificity check
describe('specificity check', () => {
  const client = { full_name: 'Jordan Rivera', address: { line1: '123 Main St', city: 'Tampa', state: 'FL', zip: '33602' } };
  const reason = 'Experian reports a balance of $1,200.00. My January statement shows a balance of $900.00.';
  const letter = (_lang: 'en', over: Partial<{ label: string; reason: string; fields: string[]; enclosures: string[]; none: boolean }> = {}) =>
    mergeTemplate(templateByKey('bureau_dispute_en')!.body, buildValues({
      client, enclosures: over.enclosures ?? [], enclosuresNone: over.none ?? true,
      dispute: { item_label: over.label ?? 'Acme Bank ••1234 (Experian)', bureau: 'experian', recipient_name: 'Experian', reason: over.reason ?? reason, fields: over.fields ?? ['Balance'], round: 1 },
    }));
  const input = (over: Partial<SpecificityInput> = {}): SpecificityInput => ({ body: letter('en'), category: 'incorrect_balance', reason, fields: ['Balance'], account: { name: 'Acme Bank', reference: '1234' }, ...over });
  const found = (over: Partial<SpecificityInput> = {}) => specificityIssues(input(over)).map((i) => i.key);

  it('passes the letter the app drafts from a complete dispute, in English', () => {
    expect(specificityIssues(input())).toEqual([]);
    expect(templateByKey('bureau_dispute_es')).toBeUndefined();
    expect(letter('en')).toContain('Enclosures: none');
    expect(letter('en')).not.toMatch(/Anexos|Atentamente|Asunto/);
    expect(specificityIssues(input({ body: letter('en', { enclosures: ['Copy: Government-issued photo ID', 'January statement'] }) }))).toEqual([]);
  });

  it('account: needs the name and a masked number or reference in the letter', () => {
    expect(found({ body: letter('en', { label: 'Item (Experian)' }) })).toEqual(['account', 'account']);
    const noRef = specificityIssues(input({ body: letter('en', { label: 'Item (Experian)' }), account: null }));
    expect(noRef.map((i) => i.key)).toEqual(['account']);
    expect(noRef[0]!.message).toMatch(/last digits of the account number, or a reference number/);
    // Staff fix it in the letter and retry.
    expect(found({ body: letter('en', { label: 'Item (Experian)' }).replace('Item: Item\n', 'Item: Acme Bank, account ending 1234\n'), account: null })).toEqual([]);
    expect(found({ body: letter('en', { label: 'Item (Experian)' }).replace('Item: Item\n', 'Cuenta: Acme Bank, cuenta terminada en 1234\n'), account: null })).toEqual([]);
    // An amount in the reason is not an account reference.
    expect(found({ body: letter('en', { label: 'Item (Experian)', reason: 'The account balance is $1,200.00 but my statement shows $900.00.' }), account: null })).toEqual(['account']);
    // A specialty item is identified by its name and reference as typed from the disclosure.
    expect(found({ category: 'specialty_item', account: { name: 'First Coast Bank', reference: 'xxxx4321' } })).toEqual(['account', 'account']);
    expect(found({ category: 'specialty_item', body: `${letter('en')}\nCompany or account name: First Coast Bank\nReference or masked number: xxxx4321`, account: { name: 'First Coast Bank', reference: 'xxxx4321' } })).toEqual([]);
  });

  it('account: personal information has none, and an inquiry is identified by its date', () => {
    expect(found({ category: 'personal_info', body: letter('en', { label: 'Item (Experian)' }), account: null })).toEqual([]);
    expect(found({ category: 'unauthorized_inquiry', body: letter('en', { label: 'Item (Experian)', reason: 'I did not apply for credit with this company and do not recognise this inquiry.' }), reason: 'I did not apply for credit with this company and do not recognise this inquiry.', account: null })).toEqual(['account']);
    expect(found({ category: 'unauthorized_inquiry', body: letter('en', { label: 'Item (Experian)', reason: 'I did not apply for credit with Acme Bank on 03/14/2026.' }), reason: 'I did not apply for credit with Acme Bank on 03/14/2026.', account: null })).toEqual([]);
  });

  it('specific information: a ticked field, a category that names it, or the reason naming it', () => {
    const vague = 'The creditor told me in writing that this entry belongs to another customer.';
    const dated = 'The date opened is shown as 2019 but I opened this account in 2021.';
    expect(found({ category: 'other', fields: [], reason: vague, body: letter('en', { reason: vague, fields: [] }) })).toEqual(['information']);
    expect(found({ category: 'other', fields: ['Other'], reason: vague, body: letter('en', { reason: vague, fields: ['Other'] }) })).toEqual(['information']);
    expect(found({ category: 'other', fields: ['Dates'], reason: vague, body: letter('en', { reason: vague, fields: ['Dates'] }) })).toEqual([]);
    expect(found({ category: 'other', fields: [], reason: dated, body: letter('en', { reason: dated, fields: [] }) })).toEqual([]);
    expect(found({ category: 'incorrect_status', fields: [] })).toEqual([]);
  });

  it('reason: stock sentences are not a reason; the client’s facts are', () => {
    for (const vague of ['This account is not accurate and should be investigated.', 'Please verify this item with the furnisher.', 'Not mine. Please remove.', 'This information is inaccurate. Please delete it.', 'Esta cuenta es inexacta. Por favor verifiquen esta cuenta.', 'Inaccurate information']) {
      expect(isConcreteReason(vague), vague).toBe(false);
    }
    for (const concrete of [reason, 'Balance differs from my statement', 'I closed this account in March and the bank confirmed it by letter.', 'Pagué esta cuenta por completo y el banco me envió una carta de confirmación.', 'I have never had an account with this company and do not recognise it.']) {
      expect(isConcreteReason(concrete), concrete).toBe(true);
    }
    const stock = 'Please verify this item with the furnisher.';
    const issues = specificityIssues(input({ reason: stock, body: letter('en', { reason: stock }) }));
    expect(issues.map((i) => i.key)).toEqual(['reason']);
    // The dispute's reason cannot be edited, the letter can: what is checked is the reason as the letter states it.
    expect(reasonInLetter(letter('en', { reason: stock }), stock)).toBe(stock);
    expect(reasonInLetter(letter('en'), reason)).toBe(reason);
    expect(found({ reason: stock, body: letter('en', { reason: stock }).replace(stock, reason) })).toEqual([]);
    expect(found({ body: letter('en').replace(reason, stock) })).toEqual(['reason']);
    expect(reasonInLetter(`Dear Sir,\n\n${reason}\n\nSincerely`, reason)).toBe(reason); // no heading: the dispute's reason, when the letter carries it
    // The message asks for the client's own facts; it never offers a reason to use.
    expect(issues[0]!.message).toMatch(/Use only what the client has told you/);
    expect(issues[0]!.message).not.toMatch(/for example|such as|try/i);
  });

  it('enclosures: listed, or an explicit "none"', () => {
    expect(found({ body: letter('en', { none: false }) })).toEqual(['enclosures']);
    for (const ok of ['Enclosures: none', 'Enclosures:\n  - Copy of photo ID\n  - Utility bill', 'Anexos: ninguno', 'Enclosure: copy of my driver’s license', 'Anexos:\n1. Copia de identificación']) expect(statesEnclosures(`Dear Sir\n\n${ok}\n\nSincerely`), ok).toBe(true);
    for (const bad of ['Sincerely', 'Enclosures:', 'Enclosures:\n\nSincerely,', 'I have enclosures for you']) expect(statesEnclosures(bad), bad).toBe(false);
    expect(specificityIssues(input({ body: letter('en', { none: false }) }))[0]!.message).toMatch(/identity documents.*or write “Enclosures: none”/);
  });

  it('reports everything that is missing at once, as a clear list', () => {
    const issues = specificityIssues({ body: 'To whom it may concern:\n\nPlease remove this.\n\nSincerely', category: 'other', reason: 'Please remove this.', fields: [], account: null });
    expect(issues.map((i) => i.key)).toEqual(['account', 'information', 'reason', 'enclosures']);
    for (const i of issues) { expect(i.message.length).toBeGreaterThan(20); expect(findBlockedClaims(i.message)).toEqual([]); }
  });
});

describe('dates written into a letter', () => {
  const client = { full_name: 'Jordan Rivera', address: { line1: '1 Main St', city: 'Tampa', state: 'FL', zip: '33602' } };
  const d = { item_label: 'Acme (Experian)', bureau: 'experian', recipient_name: 'Experian', reason: 'x', fields: [], round: 1 };
  it('are days where the agency works: a submission recorded on a US evening is not dated the next day', () => {
    // Recorded at 8:30 p.m. Eastern on November 19 (01:30 UTC on the 20th); the response the same way on December 14.
    const v = buildValues({ client, language: 'en', tz: 'America/New_York', now: new Date('2026-11-20T01:30:00Z'), dispute: { ...d, submitted_at: '2026-11-20T01:30:00Z', response_at: '2026-12-15T02:10:00Z' } });
    expect([v.date, v.dispute_date, v.prior_date, v.response_date]).toEqual(['November 19, 2026', 'November 19, 2026', 'November 19, 2026', 'December 14, 2026']);
    const west = buildValues({ client, tz: 'America/Los_Angeles', now: new Date('2026-11-20T01:30:00Z'), dispute: { ...d, submitted_at: '2026-11-20T01:30:00Z', response_at: '2026-12-15T02:10:00Z' } });
    expect([west.date, west.dispute_date, west.response_date]).toEqual(['November 19, 2026', 'November 19, 2026', 'December 14, 2026']);
  });
  it('use the sent date staff recorded on the letter, as it is, when one is given', () => {
    const v = buildValues({ client, language: 'en', tz: 'America/New_York', dispute: { ...d, submitted_at: '2026-11-19', prior_submitted_at: '2026-10-01', response_at: '2026-12-14T17:00:00Z' } });
    expect([v.dispute_date, v.prior_date, v.response_date]).toEqual(['November 19, 2026', 'October 1, 2026', 'December 14, 2026']);
  });
});
