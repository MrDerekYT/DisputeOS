import { describe, expect, it } from 'vitest';
import { protect } from '@/lib/ai/protected';
import { findBlockedClaims } from '@/lib/compliance/claims';
import { BANK_DETAILS, bankCollectionSteps, type BankCase } from '@/lib/credit/bank-collections';
import { specialtyReportStates } from '@/lib/credit/agencies';
import { personalInfoReason } from '@/lib/credit/personal-info';
import { CATEGORIES, categoryForFinding, mustNameAccount, typedItemLabel } from '@/lib/disputes/workflow';
import { draftReason, REASON_PROMPT, reasonIsClientsOwn, reportedFor, type ReportedRow } from '@/lib/disputes/reasons';
import { LETTER_LIBRARY, LIBRARY_GROUPS, libraryEntry, missingFacts, missingFactsForOwnTemplate, newInformationIn, OLD_CREDITOR_WORDING, OLD_OUTDATED_WORDING, OLD_VALIDATION_WORDING, renderLibraryLetter, templateForEntry, templateKeyForCategory } from '@/lib/letters/library';
import { editableWording } from '@/lib/letters/overlap';
import { buildValues, mergeTemplate, unresolvedPlaceholders, type LetterContext, type SituationFacts } from '@/lib/letters/render';
import { approvalBlockers } from '@/lib/letters/service';
import { contentIssues, isConcreteReason, SPECIFICITY_KINDS, specificityIssues } from '@/lib/letters/specificity';
import { letterTerms, REWORDABLE } from '@/lib/letters/tailor';
import { ALL_TEMPLATES, templateByKey, TEMPLATES } from '@/lib/letters/templates';
import { analyze, type AnalysisTradeline } from '@/lib/reports/analysis';

// The date of birth and the SSN digits are on this client's record, as they are for a client whose intake is complete.
const client = { full_name: 'Jordan Rivera', address: { line1: '123 Main St', city: 'Tampa', state: 'FL', zip: '33602' }, ssn_last4: '4321', dob: '1985-03-03' };
const REASON = 'Experian reports a balance of $1,200.00. My January 2026 statement shows a balance of $900.00.';
const NEW = 'New information since my previous request: the creditor’s letter dated February 3, 2026 confirms the balance is $900.00.';
const tradeline = { creditor_name: 'Acme Bank', account_last4: '1234' };
const bureauDispute = { item_label: 'Acme Bank ••1234 (Experian)', bureau: 'experian', recipient_name: 'Experian', reason: REASON, fields: ['Balance'], round: 1, tradeline, category: 'incorrect_balance', target_type: 'bureau' };
const FACTS: SituationFacts = {
  today: '2026-11-19', fallOff: { kind: 'date', date: '2026-01-10', rule: 'seven_years_plus_180_days', from: '2018-07-14' },
  bankruptcy: { chapter: '7', filedOn: '2024-02-01', dischargedOn: '2024-06-03' }, identityTheftReports: ['FTC identity theft report'], identityProof: ['id', 'proof_of_address'],
  priorOutcome: 'verified', outcome: null, dueOn: null, isCollection: true,
};
const NOTICE_REASON = 'Your notice dated November 2, 2026 states a balance of $640.00. I do not recognize this amount.';
const PI_REASON = personalInfoReason([
  { kind: 'address', value: '12 OAK ST, MIAMI, FL 33101', issue: 'not_mine', correctValue: null },
  { kind: 'name', value: 'JORDON RIVERA', issue: 'incorrect', correctValue: 'Jordan Rivera' },
]);

/** A complete, truthful context for each situation: what createLetter would load from the file. */
function fixture(key: string): LetterContext {
  const base: LetterContext = { client, now: new Date('2026-11-19T12:00:00Z'), enclosures: ['January 2026 statement', 'Copy: Government-issued photo ID'], enclosuresNone: true, facts: { ...FACTS }, dispute: { ...bureauDispute } };
  switch (key) {
    case 'personal_information':
      return { ...base, dispute: { ...bureauDispute, category: 'personal_info', item_label: 'Personal information (Experian)', reason: PI_REASON, fields: ['Personal information'], tradeline: null } };
    case 'identity_theft_block':
      return { ...base, dispute: { ...bureauDispute, category: 'identity_theft', reason: 'I did not open this account and did not authorize anyone to open it. I learned of it on October 30, 2026.' } };
    // A letter that states the client's position is drafted only for a dispute entered with that position.
    case 'not_my_account': return { ...base, dispute: { ...bureauDispute, category: 'not_mine' } };
    case 'duplicate_account': return { ...base, dispute: { ...bureauDispute, category: 'duplicate' } };
    // A letter about one reported value is drafted only for a dispute about that value.
    case 'inaccurate_status': return { ...base, dispute: { ...bureauDispute, category: 'incorrect_status' } };
    case 'inaccurate_history_dates': return { ...base, dispute: { ...bureauDispute, category: 'incorrect_payment_history' } };
    case 'bankruptcy_included': return { ...base, dispute: { ...bureauDispute, category: 'bankruptcy_included' } };
    case 'redispute_new_information':
      return { ...base, dispute: { ...bureauDispute, round: 2, reason: `${REASON}\n\n${NEW}`, prior_submitted_at: '2026-01-05' } };
    case 'follow_up_no_response':
      return { ...base, facts: { ...FACTS, dueOn: '2026-11-01' }, dispute: { ...bureauDispute, submitted_at: '2026-10-01', response_at: null } };
    case 'method_of_verification':
      return { ...base, facts: { ...FACTS, outcome: 'verified' }, dispute: { ...bureauDispute, submitted_at: '2026-10-01', response_at: '2026-10-28T12:00:00Z' } };
    case 'debt_validation': case 'stop_communication':
      // A collector whose written notice is on file, received 17 days before "today": the validation period is open.
      return { ...base, recipientAddress: 'PO Box 9, Anytown, ST 00000', facts: { ...FACTS, notice: { kind: 'received', date: '2026-11-02', open: true } }, dispute: { ...bureauDispute, category: 'unverifiable_collection', target_type: 'collector', item_label: 'Northstar Recovery ••5521', bureau: null, recipient_name: 'Northstar Recovery', reason: NOTICE_REASON, tradeline: { creditor_name: 'Northstar Recovery', account_last4: '5521' } } };
    case 'creditor_direct_dispute': case 'goodwill': case 'payment_update':
      return { ...base, recipientAddress: 'PO Box 1, Anytown, ST 00000', dispute: { ...bureauDispute, category: key === 'creditor_direct_dispute' ? 'furnisher_direct' : key, target_type: 'furnisher', item_label: 'Acme Bank ••1234', bureau: null, recipient_name: 'Acme Bank', reason: key === 'payment_update' ? 'I paid the balance of $900.00 in full on March 3, 2026. My bank statement shows the payment.' : key === 'goodwill' ? 'My payment for March 2025 was 30 days late while I was in the hospital. Every payment since has been on time.' : REASON } };
    case 'specialty_dispute':
      return { ...base, dispute: { item_label: 'First Coast Bank · xxxx4321 (LexisNexis)', bureau: null, recipient_name: 'LexisNexis Risk Solutions Consumer Center', category: 'specialty_item', target_type: 'agency', reason: 'The disclosure lists an unpaid balance of $312.40. My bank statement dated 04/02/2024 shows the account was paid in full.', fields: [], round: 1, agency: 'lexisnexis', agency_item: { name: 'First Coast Bank', reference: 'xxxx4321', amount: '$312.40' }, recipient_address: 'PO Box 1\nAnytown, ST 00000' } };
    default: return base;
  }
}
const render = (key: string, over: (c: LetterContext) => LetterContext = (c) => c) => renderLibraryLetter(key, over(fixture(key)));
const body = (key: string) => { const r = render(key); if (!r.ok) throw new Error(`${key}: ${r.missing.join(' ')}`); return r.body; };

describe('letter library', () => {
  it('lists one letter per situation, grouped by recipient, each with a one-line “use when”', () => {
    expect(LETTER_LIBRARY.map((e) => e.key)).toEqual([
      'bureau_dispute', 'not_my_account', 'inaccurate_balance', 'inaccurate_history_dates', 'inaccurate_status', 'duplicate_account', 'outdated_item', 'bankruptcy_included',
      'identity_theft_block', 'personal_information', 'redispute_new_information', 'follow_up_no_response', 'method_of_verification',
      'debt_validation', 'stop_communication', 'creditor_direct_dispute', 'goodwill', 'payment_update', 'specialty_dispute',
    ]);
    for (const e of LETTER_LIBRARY) {
      expect(LIBRARY_GROUPS.some((g) => g.key === e.group), e.key).toBe(true);
      expect(templateByKey(e.templateKey), e.key).toBeDefined();
      expect(e.useWhen.length, e.key).toBeGreaterThan(20);
      expect(e.useWhen.length, e.key).toBeLessThan(140);
      expect(e.useWhen, e.key).not.toContain('\n');
      expect(findBlockedClaims(`${e.name} ${e.useWhen}`), e.key).toEqual([]);
    }
    expect(new Set(LETTER_LIBRARY.map((e) => e.key)).size).toBe(LETTER_LIBRARY.length);
    // Every general template shown on the Templates tab is one of the picker's letters, so its "Use" link preselects it.
    for (const t of TEMPLATES) expect(LETTER_LIBRARY.some((e) => e.templateKey === t.key), t.key).toBe(true);
    // The creditor letter says plainly that it carries no duty to investigate, and "pay for delete" is not offered under any name.
    expect(libraryEntry('creditor_direct_dispute')!.useWhen).toMatch(/need not investigate a dispute this office prepared; the bureau dispute carries that duty/);
    expect(templateByKey('creditor_dispute_en')!.description).toMatch(/not required to investigate a dispute prepared by a credit repair company \(15 U\.S\.C\. § 1681s-2\(a\)\(8\)\(G\)\)/);
    expect(JSON.stringify(LETTER_LIBRARY)).not.toMatch(/pay[\s-]+for[\s-]+delet|client’s own letter|signed and sent by the client/i);
  });

  it('fits a dispute category to its situation letter', () => {
    expect(templateKeyForCategory('not_mine')).toBe('not_my_account_en');
    expect(templateKeyForCategory('incorrect_balance')).toBe('inaccurate_balance_en');
    expect(templateKeyForCategory('obsolete')).toBe('outdated_item_en');
    expect(templateKeyForCategory('other')).toBeNull();
    for (const k of ['not_mine', 'incorrect_balance', 'incorrect_payment_history', 'incorrect_dates', 'incorrect_status', 'duplicate', 'obsolete', 'bankruptcy_included', 'identity_theft', 'payment_update']) {
      expect(CATEGORIES[k], k).toBeDefined();
      expect(templateByKey(templateKeyForCategory(k)!), k).toBeDefined();
    }
  });

  it('every letter renders from fixture facts, complete, and passes the claims guard and the approval check', () => {
    for (const e of LETTER_LIBRARY) {
      const r = render(e.key);
      expect(r.ok, `${e.key}: ${r.ok ? '' : r.missing.join(' ')}`).toBe(true);
      if (!r.ok) continue;
      expect(unresolvedPlaceholders(r.body), e.key).toEqual([]);
      expect(findBlockedClaims(r.body), e.key).toEqual([]);
      expect(approvalBlockers(r.body), e.key).toEqual([]);
      // The same frame everywhere: date, sender, a reference line, a salutation and the signature block.
      expect(r.body.startsWith('November 19, 2026\n\nJordan Rivera\n123 Main St\nTampa, FL 33602\n'), e.key).toBe(true);
      expect(r.body, e.key).toMatch(/\nRe: .+\n\n(To whom it may concern|Dear .+):\n/);
      expect(r.body.trimEnd().endsWith('Sincerely,\n\nJordan Rivera'), e.key).toBe(true);
      expect(r.body.split('\n').length, e.key).toBeLessThan(48); // one page
    }
  });

  it('every letter to a bureau or a specialty agency passes the specificity check', () => {
    for (const e of LETTER_LIBRARY) {
      const c = fixture(e.key);
      const r = renderLibraryLetter(e.key, c);
      if (!r.ok || !(SPECIFICITY_KINDS.includes(r.kind) || r.kind === 'personal_info_correction')) continue;
      const d = c.dispute!;
      const category = e.key === 'personal_information' ? 'personal_info' : e.key === 'specialty_dispute' ? 'specialty_item' : 'incorrect_balance';
      const account = d.agency_item ? { name: d.agency_item.name, reference: d.agency_item.reference ?? null } : d.tradeline ? { name: d.tradeline.creditor_name, reference: d.tradeline.account_last4 } : null;
      expect(specificityIssues({ body: r.body, category, reason: d.reason, fields: d.fields, account }), e.key).toEqual([]);
    }
    // A stock reason is still caught in a situation letter: the fixed wording never stands in for the client's facts.
    const stock = 'Please verify this item with the furnisher.';
    const weak = renderLibraryLetter('inaccurate_balance', { ...fixture('inaccurate_balance'), dispute: { ...bureauDispute, reason: stock } });
    expect(weak.ok && specificityIssues({ body: weak.body, category: 'incorrect_balance', reason: stock, fields: ['Balance'], account: { name: 'Acme Bank', reference: '1234' } }).map((i) => i.key)).toEqual(['reason']);
  });

  it('contains no Spanish, no deletion demand, no threat, no deadline of its own and no result promise', () => {
    expect(ALL_TEMPLATES.every((t) => t.language === 'en' && !/_es$/.test(t.key))).toBe(true);
    for (const t of ALL_TEMPLATES) {
      expect(t.body, t.key).not.toMatch(/[áéíóúñ¿¡]|\b(atentamente|a quien corresponda|asunto|anexos?|adjuntos?|les escribo|solicito|disputa|cuenta|expediente|informe|deuda)\b/i);
      expect(findBlockedClaims(t.body), t.key).toEqual([]);
    }
    for (const e of LETTER_LIBRARY) {
      const text = `${templateForEntry(e, fixture(e.key))!.body}\n${body(e.key)}`;
      expect(text, e.key).not.toMatch(/\b(delet\w*|remov\w*|eras\w*|expung\w*|wip(e|ed|ing))\b/i);
      expect(text, e.key).not.toMatch(/\b(demand\w*|must|shall|failure|fail(s|ed)? to|otherwise|lawsuit|sue|attorney|legal action|court|complaint|damages|violat\w*|penalt\w*)\b/i);
      expect(text, e.key).not.toMatch(/\b(within|in|no later than)\s+\d+\s+(business\s+|calendar\s+)?days\b/i); // sets the recipient no deadline of its own
      expect(text, e.key).not.toMatch(/\b(will|is going to|are going to)\s+(be\s+)?(corrected|updated|blocked|approved|improve\w*|increase\w*|raise\w*)\b|\bguarant\w*|\bscore\b/i);
    }
  });

  it('keeps every request, heading and recorded fact out of reach of an AI wording suggestion', () => {
    // A drafted letter is locked by position (src/lib/letters/tailor.ts letterTerms): every line is hidden from the
    // model except the standard salutation, the voice lines and the sign-off, whatever the line says.
    const FIXED = /Please|Reason for my request|Reported entries I am asking|My correct current details|Details of the payment|The item, as it appears|Specific information|I ask that you|I would be grateful|I understand that|I request|I dispute|appears to|bankruptcy|identity theft|not a new dispute|I have no record|I am not disputing|which I have paid|was verified|do not recognize|Attn:|Enclosures|Re:/;
    for (const e of LETTER_LIBRARY) {
      const c = fixture(e.key);
      const text = body(e.key);
      const terms = letterTerms({ clientName: 'Jordan Rivera', address: client.address, body: text, templateBody: templateForEntry(e, c)!.body, names: [c.dispute!.recipient_name, c.dispute!.tradeline?.creditor_name, c.dispute!.item_label] });
      const masked = protect(text, terms).masked.replace(/\[\[LOCKED_\d+\]\]/g, '▮');
      expect(masked.replace(/Please write to me at the address above/g, ''), e.key).not.toMatch(FIXED); // one voice line is an invitation to write back
      expect(masked, e.key).not.toMatch(/\d|\$|§|Experian|Jordan/); // no amount, date, citation, bureau or name is editable
      for (const line of c.dispute!.reason.split('\n').filter((l) => l.trim())) expect(masked, `${e.key}: ${line}`).not.toContain(line.trim());
      // What is left for the model is, sentence for sentence, the wording this app wrote as courtesy and nothing else.
      for (const line of editableWording(text, terms).split('\n').filter(Boolean)) {
        for (const sentence of line.split(/(?<=[.!?])\s+/)) expect(REWORDABLE.has(sentence), `${e.key}: “${sentence}” is editable`).toBe(true);
      }
    }
    // The lines the standing vocabulary rules alone would have left open: a field list with no lock word, an agency
    // address line with no digit, a heading, a fixed courtesy sentence, and a body written in Spanish.
    const lockedByPosition = (text: string, line: string) => expect(protect(text, letterTerms({ clientName: 'Jordan Rivera', body: text })).masked, line).not.toContain(line);
    const dates = render('inaccurate_history_dates', (c) => ({ ...c, dispute: { ...c.dispute!, category: 'incorrect_payment_history', fields: ['Payment history', 'Dates'] } }));
    expect(dates.ok && dates.body).toContain('Specific information I am asking you to review: Payment history, Dates.');
    expect(protect('Specific information I am asking you to review: Payment history, Dates.').locked).toEqual([]); // the standing rules alone would have sent it
    if (dates.ok) lockedByPosition(dates.body, 'Specific information I am asking you to review: Payment history, Dates.');
    const chex = render('specialty_dispute', (c) => ({ ...c, dispute: { ...c.dispute!, agency: 'chexsystems', recipient_name: 'Chex Systems, Inc.' } }));
    expect(chex.ok && chex.body).toContain('\nAttn: Consumer Relations\n');
    expect(protect('Attn: Consumer Relations').locked).toEqual([]);
    if (chex.ok) for (const line of ['Attn: Consumer Relations', 'The item, as it appears on my disclosure:']) lockedByPosition(chex.body, line);
    lockedByPosition(body('goodwill'), 'I understand that this is a courtesy and that the decision is yours.');
    lockedByPosition(body('payment_update'), 'Details of the payment:');
    const spanish = 'A quien corresponda:\n\nLes pido que realicen una reinvestigación razonable de esta partida y me envíen los resultados por escrito.\n\nAtentamente,\n\nJordan Rivera\n';
    expect(editableWording(spanish, letterTerms({ clientName: 'Jordan Rivera', body: spanish }))).toBe('');
  });

  it('words each situation as the brief requires', () => {
    expect(body('outdated_item')).toMatch(/The date of first delinquency reported for this account is July 14, 2018\. The reporting period is generally 7 years, starting 180 days after the date of first delinquency, so the reporting period for this item appears to have ended on January 10, 2026\./);
    expect(body('outdated_item')).toMatch(/appears to be past the period/);
    expect(body('bankruptcy_included')).toContain('I filed a Chapter 7 bankruptcy case on February 1, 2024, and a discharge was entered on June 3, 2024.');
    const theft = body('identity_theft_block');
    expect(theft).toContain('15 U.S.C. § 1681c-2');
    expect(theft).toContain('A copy of my identity theft report is enclosed.');
    expect(theft).toContain('  - Copy: FTC identity theft report');
    const pi = body('personal_information');
    expect(pi).toContain('- Address shown as “12 OAK ST, MIAMI, FL 33101”: this entry is not mine.');
    expect(pi).toContain('- Name shown as “JORDON RIVERA”: this entry is not correct. The correct name is “Jordan Rivera”.');
    expect(pi).toContain('My correct current details:\n  Name: Jordan Rivera\n  Address: 123 Main St, Tampa, FL 33602');
    expect(pi).toContain('  - Copy: Government-issued photo ID');
    const again = body('redispute_new_information');
    expect(again).toMatch(/On January 5, 2026 I disputed the item below, and your results state that the information was verified\./);
    expect(again).toContain('the creditor’s letter dated February 3, 2026 confirms the balance is $900.00.');
    expect(again).toContain('— request 2');
    expect(body('follow_up_no_response')).toMatch(/Re: Status of the dispute I sent on October 1, 2026 — [^\n]+\n\nTo whom it may concern:\n\nOn October 1, 2026 I sent you a dispute about the item above\. I have no record of receiving the results/);
    expect(body('method_of_verification')).toMatch(/This letter is a request for that description\. It is not a new dispute\./);
    // Goodwill: clearly a request. It concedes only what the client's own reason describes, claims no error and encloses nothing.
    const goodwill = body('goodwill');
    expect(goodwill).toContain('I am writing about the account above. I am not disputing what I describe below; I am asking for your consideration.\n\nMy payment for March 2025 was 30 days late');
    expect(goodwill).toMatch(/I would be grateful if you would consider a goodwill adjustment[\s\S]*the decision is yours/);
    expect(goodwill).not.toMatch(/inaccura|incorrect|error|dispute this|U\.S\.C\.|I accept that the information is correct|any late payment shown|accuracy of what is reported/i);
    // Paid account: an accurate update, never "pay for delete".
    const paid = body('payment_update');
    expect(paid).toMatch(/update the information you report to the consumer reporting agencies so that it accurately reflects the payment/);
    expect(body('specialty_dispute')).toContain('the public record and background information in my consumer file');
  });

  it('an outdated-item letter about an account that is only late is about that late payment information, never the account', () => {
    // 15 U.S.C. § 1681c(a)(5) ages each adverse item from its own date: an account that was late once stays reportable.
    const late = render('outdated_item', (c) => ({ ...c, facts: { ...c.facts, fallOff: { kind: 'date', date: '2026-03-10', rule: 'seven_years', from: '2019-03-10' } } }));
    expect(late.ok).toBe(true);
    if (!late.ok) return;
    expect(late.body).toContain('Re: Late payment information that appears to be past its reporting period — Acme Bank, account ending 1234\n');
    expect(late.body).toContain('about late payment information in my credit file that appears to be past the period in which it may be reported (15 U.S.C. § 1681c).');
    expect(late.body).toContain('so the reporting period for the late payment information from that date appears to have ended on March 10, 2026.');
    expect(late.body).toContain('Please conduct a reasonable reinvestigation of the date of first delinquency reported for this item and, if the reporting period for that late payment information has ended, update my file accordingly.');
    expect(late.body).not.toMatch(/Item that appears to be past|an item in my credit file|its reporting period has ended|reporting period for this item/);
    expect(unresolvedPlaceholders(late.body)).toEqual([]);
    // A collection or a charge-off ages off as a whole, and its letter still says so.
    const whole = body('outdated_item');
    expect(whole).toContain('Re: Item that appears to be past the reporting period — Acme Bank, account ending 1234\n');
    expect(whole).toContain('about an item in my credit file that appears to be past the period in which it may be reported');
    expect(whole).toContain('and, if its reporting period has ended, update my file accordingly.');
    expect(whole).not.toMatch(/late payment information/i);
  });

  it('the finding that leads to that letter says what has aged: the late payment information, not the account', () => {
    const row = (o: Partial<AnalysisTradeline> = {}): AnalysisTradeline => ({
      id: 't-1', bureau: 'experian', item_type: 'tradeline', creditor_name: 'City Card', original_creditor: null, account_last4: '5566', account_status: 'Open', payment_status: '30 days late',
      balance_cents: 12000, credit_limit_cents: null, date_opened: '2015-01-10', date_reported: '2026-10-01', date_of_first_delinquency: '2019-03-10', payment_history: null, user_provided: {}, ...o,
    });
    const old = (o: Partial<AnalysisTradeline> = {}) => analyze({ tradelines: [row(o)], inquiries: [], publicRecords: [], identity: [], now: new Date('2026-11-19T00:00:00Z') }).find((f) => f.category === 'obsolete_item')!;
    // An open card that was late once, more than seven years ago.
    expect(old().explanation).toMatch(/generally 7 years from the reported date of first delinquency \(15 U\.S\.C\. § 1681c\), which works out to 2026-03-10\./);
    expect(old().explanation).toMatch(/if it is accurate, the late payment information from that date may be past its reporting period, while the account itself keeps being reported; if it was re-aged, the date itself may be the issue\.$/);
    expect(old().explanation).not.toMatch(/the item may be past/);
    // A collection ages off as a whole, and its finding still says so.
    expect(old({ item_type: 'collection', account_status: 'Collection', payment_status: null, date_of_first_delinquency: '2018-06-15' }).explanation)
      .toMatch(/if it is accurate, the item may be past the reporting period; if it was re-aged, the date itself may be the issue\.$/);
  });

  it('a follow-up to a specialty agency carries the identification that agency asks for, and asks for a copy of the file, not a credit report', () => {
    const specialty = fixture('specialty_dispute').dispute!;
    const sent = { ...fixture('follow_up_no_response'), dispute: { ...specialty, agency: 'chexsystems', item_label: 'First Coast Bank · xxxx4321 (ChexSystems)', recipient_name: 'Chex Systems, Inc.', submitted_at: '2026-10-01', response_at: null } };
    expect(missingFacts('follow_up_en', sent)).toEqual([]);
    const text = mergeTemplate(templateByKey('follow_up_en')!.body, buildValues(sent));
    // ChexSystems says correspondence must include the date of birth and the Social Security number: the same lines as its dispute letter.
    expect(text).toContain('Tampa, FL 33602\nDate of birth: March 3, 1985\nSocial Security number: [SOCIAL SECURITY NUMBER NEEDED]\n\nChex Systems, Inc.\n');
    expect(approvalBlockers(text)).toEqual(['Fill in or remove: [SOCIAL SECURITY NUMBER NEEDED]']);
    expect(text).toContain('Re: Status of the dispute I sent on October 1, 2026 — First Coast Bank · xxxx4321\n');
    expect(text).toContain('along with an updated copy of my file if it changed.');
    expect(text).not.toMatch(/credit report|\(ChexSystems\)/);
    // To a credit bureau the heading is what it was: the date of birth and the SSN digits, and nothing added.
    const bureau = body('follow_up_no_response');
    expect(bureau).toContain('Tampa, FL 33602\nDate of birth: March 3, 1985\nSSN (last 4): 4321\n\nExperian\n');
    expect(bureau).not.toMatch(/credit report/);
  });

  it('a specialty letter names the item without the agency it is addressed to', () => {
    const text = body('specialty_dispute');
    expect(text).toContain('Re: Dispute of information in my file — First Coast Bank · xxxx4321\n');
    expect(text).not.toContain('(LexisNexis)');
    expect(text).toContain('  Company or account name: First Coast Bank\n  Reference or masked number: xxxx4321\n'); // the item itself is still printed in full below
  });

  it('the letter to the creditor cites no statute and asks for no investigation: a letter this office prepared carries no such duty', () => {
    // 15 U.S.C. § 1681s-2(a)(8)(G) and 12 CFR 1022.43(b)(2): the direct-dispute duty does not apply to a dispute
    // prepared by a credit repair organization, so the letter must not claim it.
    const text = body('creditor_direct_dispute');
    expect(text).not.toMatch(/623|1681s-2|U\.S\.C\.|Fair Credit Reporting Act|investigat/i);
    expect(text).toContain('Re: Information you report about my account — Acme Bank, account ending 1234\n');
    expect(text).toContain('Account: Acme Bank, account ending 1234\n');
    expect(text).toContain('I ask that you check it against your account records.');
    expect(text).toContain('Please review your account records and the information I have provided, and let me know in writing what you find.');
    expect(templateByKey('creditor_dispute_en')!.name).not.toMatch(/623|Direct dispute/);
  });

  it('a follow-up on a later round is about that round, not the one before it', () => {
    // Round 2 was sent on October 1; round 1 (sent August 3) was answered. The follow-up names October 1 everywhere.
    const r = render('follow_up_no_response', (c) => ({ ...c, facts: { ...c.facts, dueOn: '2026-10-31' }, dispute: { ...c.dispute!, round: 2, submitted_at: '2026-10-01', prior_submitted_at: '2026-08-03', response_at: null } }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.body).toContain('Re: Status of the dispute I sent on October 1, 2026 — Acme Bank, account ending 1234\n');
    expect(r.body).toContain('On October 1, 2026 I sent you a dispute about the item above.');
    expect(r.body).not.toContain('August 3, 2026');
    // The re-dispute is the one letter that names the earlier round.
    expect(templateByKey('redispute_new_information_en')!.body).toContain('On {{prior_date}} I disputed the item below');
    for (const t of ALL_TEMPLATES.filter((x) => x.key !== 'redispute_new_information_en')) expect(t.body, t.key).not.toContain('{{prior_date}}');
  });

  it('a validation request cites the 30-day right only when a notice is on file and its period is open', () => {
    const open = body('debt_validation');
    expect(open).toContain('I am writing in response to your written notice about the debt referenced above, which I received on November 2, 2026. Under Section 809(b) of the Fair Debt Collection Practices Act (15 U.S.C. § 1692g(b)), I dispute this debt. I ask that you provide validation of it. Please include:');
    expect(open).toContain('Until you mail me verification of the debt, I ask that you cease collection of it, as the statute provides.');
    const sent = render('debt_validation', (c) => ({ ...c, facts: { ...c.facts, notice: { kind: 'sent', date: '2026-11-02', open: true } } }));
    expect(sent.ok && sent.body).toContain('your written notice about the debt referenced above, which was sent on November 2, 2026.');
    for (const notice of [{ kind: 'received' as const, date: '2026-08-02', open: false }, null]) {
      const r = render('debt_validation', (c) => ({ ...c, facts: { ...c.facts, notice } }));
      expect(r.ok).toBe(true);
      if (!r.ok) continue;
      // Past the 30 days, or with no notice on file, nothing is claimed: the letter disputes the debt and asks.
      expect(r.body).not.toMatch(/809\(b\)|1692g|as the statute provides|cease collection|which I received on|August 2/);
      expect(r.body).toContain(notice ? 'I am writing in response to your written notice about the debt referenced above. I dispute this debt and ask that you provide validation of it, including:' : 'I am writing about the debt referenced above. I dispute this debt and ask that you provide validation of it, including:');
      expect(r.body).not.toContain('in response to your communication');
      expect(r.body).toContain('Until you have sent me that information, I ask that you pause collection of this debt. Please also note this debt as disputed');
      expect(approvalBlockers(r.body)).toEqual([]);
    }
  });

  it('a letter to a credit bureau identifies the consumer by date of birth and SSN digits, or marks them for a person', () => {
    const head = (text: string) => text.slice(0, text.indexOf('Experian'));
    expect(head(body('inaccurate_balance'))).toBe('November 19, 2026\n\nJordan Rivera\n123 Main St\nTampa, FL 33602\nDate of birth: March 3, 1985\nSSN (last 4): 4321\n\n');
    for (const key of ['bureau_dispute', 'personal_information', 'follow_up_no_response', 'method_of_verification', 'identity_theft_block']) expect(body(key), key).toContain('\nDate of birth: March 3, 1985\nSSN (last 4): 4321\n');
    // Not on the record: a marked line that blocks approval until someone fills it in or takes it out. Nothing is guessed.
    const bare = render('inaccurate_balance', (c) => ({ ...c, client: { full_name: 'Jordan Rivera', address: client.address } }));
    expect(bare.ok && bare.body).toContain('\nDate of birth: [DATE OF BIRTH NEEDED]\nSSN (last 4): [SOCIAL SECURITY NUMBER NEEDED]\n');
    expect(bare.ok && approvalBlockers(bare.body)).toEqual(['Fill in or remove: [DATE OF BIRTH NEEDED], [SOCIAL SECURITY NUMBER NEEDED]']);
    // The person drafting can leave the SSN digits out; the date of birth line stays.
    const noSsn = render('inaccurate_balance', (c) => ({ ...c, includeSsnLast4: false }));
    expect(noSsn.ok && noSsn.body).toContain('\nDate of birth: March 3, 1985\n\nExperian\n');
    // A creditor or a collector is sent neither by default. A creditor gets the SSN digits when the person drafting
    // asked for them; a collector never does (createLetter clears the line: tests/db/dispute-letter-rules.test.ts).
    for (const key of ['creditor_direct_dispute', 'goodwill', 'payment_update', 'debt_validation', 'stop_communication']) expect(body(key), key).not.toMatch(/Date of birth|SSN/);
    const asked = render('goodwill', (c) => ({ ...c, includeSsnLast4: true }));
    expect(asked.ok && asked.body).toContain('\nSSN (last 4): 4321\n');
    expect(asked.ok && asked.body).not.toContain('Date of birth');
    // A specialty agency that asks for the date of birth gets it from the record too; a full SSN is still typed by a person.
    const chex = render('specialty_dispute', (c) => ({ ...c, dispute: { ...c.dispute!, agency: 'chexsystems' } }));
    expect(chex.ok && chex.body).toContain('\nDate of birth: March 3, 1985\nSocial Security number: [SOCIAL SECURITY NUMBER NEEDED]\n');
  });

  it('a dispute about payment history or dates names only what the client disputes', () => {
    const say = (category: string, fields: string[]) => { const r = render('inaccurate_history_dates', (c) => ({ ...c, dispute: { ...c.dispute!, category, fields } })); return r.ok ? r.body : ''; };
    const dates = say('incorrect_dates', ['Dates']);
    expect(dates).toContain('about the dates reported for the account below.');
    expect(dates).toContain('Re: Dispute of the dates reported — Acme Bank, account ending 1234\n'); // the subject line names the same thing
    expect(dates).toContain('Please conduct a reasonable reinvestigation of the dates reported for this account,');
    expect(dates).not.toMatch(/payment history and dates|the payment history reported/);
    expect(say('incorrect_dates', [])).toContain('about the dates reported for the account below.');
    expect(say('incorrect_payment_history', ['Payment history'])).toContain('about the payment history reported for the account below.');
    expect(say('incorrect_payment_history', [])).not.toContain('dates reported');
    expect(say('incorrect_payment_history', ['Payment history', 'Dates'])).toContain('about the payment history and dates reported for the account below.');
    expect(say('incorrect_payment_history', ['Payment history'])).toContain('Re: Dispute of the payment history reported — Acme Bank, account ending 1234\n');
    // Ticked fields win over the category: a "dates" dispute with the payment history ticked disputes that.
    expect(say('incorrect_dates', ['Payment history'])).toContain('about the payment history reported for the account below.');
    // Picked by hand for a dispute that names neither: it is not drafted (tests/unit/letter-wording.test.ts).
    expect(say('other', ['Balance'])).toBe('');
    expect(unresolvedPlaceholders(dates)).toEqual([]);
  });

  it('refuses to render when a fact the letter rests on is missing', () => {
    const missing = (key: string, over: (c: LetterContext) => LetterContext) => { const r = render(key, over); return r.ok ? '' : r.missing.join(' '); };
    const facts = (f: Partial<SituationFacts>) => (c: LetterContext): LetterContext => ({ ...c, facts: { ...c.facts, ...f } });
    // Identity theft: never without an identity theft report on file.
    expect(missing('identity_theft_block', facts({ identityTheftReports: [] }))).toMatch(/needs an identity theft report/);
    expect(missing('identity_theft_block', facts({ identityTheftReports: undefined }))).toMatch(/needs an identity theft report/);
    // Re-dispute: never without something new, and only after a "verified" result on an earlier round.
    expect(missing('redispute_new_information', (c) => ({ ...c, dispute: { ...c.dispute!, reason: REASON } }))).toMatch(/Nothing new is on file/);
    expect(missing('redispute_new_information', (c) => ({ ...c, dispute: { ...c.dispute!, reason: `${REASON}\n\nNew information since my previous request: none` } }))).toMatch(/Nothing new is on file/);
    expect(missing('redispute_new_information', facts({ priorOutcome: 'deleted' }))).toMatch(/verified as reported/);
    expect(missing('redispute_new_information', (c) => ({ ...c, dispute: { ...c.dispute!, round: 1, prior_submitted_at: null } }))).toMatch(/follows an earlier dispute/);
    expect(newInformationIn(REASON)).toBeNull();
    // Outdated: only when the reported date puts the item past the period. No date is never estimated.
    expect(missing('outdated_item', facts({ fallOff: { kind: 'not_available' } }))).toMatch(/no date of first delinquency/);
    expect(missing('outdated_item', facts({ fallOff: { kind: 'date', date: '2027-03-01', rule: 'seven_years_plus_180_days', from: '2019-09-02' } }))).toMatch(/runs until March 1, 2027\. It is not past the reporting period/);
    expect(missing('outdated_item', facts({ fallOff: null }))).toMatch(/not reported with negative information/);
    expect(missing('bankruptcy_included', facts({ bankruptcy: null }))).toMatch(/No bankruptcy is recorded/);
    // Follow-up: only after the period, with no response recorded.
    expect(missing('follow_up_no_response', facts({ dueOn: '2026-12-01' }))).toMatch(/has not ended yet/);
    expect(missing('follow_up_no_response', (c) => ({ ...c, dispute: { ...c.dispute!, response_at: '2026-10-20T12:00:00Z' } }))).toMatch(/A response is recorded/);
    expect(missing('follow_up_no_response', (c) => ({ ...c, dispute: { ...c.dispute!, submitted_at: null } }))).toMatch(/not been recorded as sent/);
    expect(missing('method_of_verification', facts({ outcome: 'deleted' }))).toMatch(/verified as reported/);
    expect(missing('debt_validation', facts({ isCollection: false }))).toMatch(/apply to collections only[\s\S]*record the collector’s notice/);
    // A notice that is already recorded under another name, or for another account, is why: the refusal says so.
    expect(missing('debt_validation', facts({ isCollection: false }))).toMatch(/A notice recorded by name counts when the name matches the company this dispute is addressed to, and a notice recorded for another account does not count\./);
    // Identity theft: also never without accepted proof of the client's identity (15 U.S.C. § 1681c-2(a)(1)).
    expect(missing('identity_theft_block', facts({ identityProof: [] }))).toMatch(/also needs proof of the client’s identity/);
    expect(missing('identity_theft_block', facts({ identityProof: ['proof_of_address'] }))).toMatch(/government-issued photo ID/);
    expect(missing('identity_theft_block', facts({ identityProof: undefined, identityTheftReports: [] }))).toMatch(/needs an identity theft report[\s\S]*also needs proof of the client’s identity/);
    expect(missing('specialty_dispute', (c) => ({ ...c, dispute: { ...bureauDispute } }))).toMatch(/specialty agency dispute/);
    // A bureau situation letter is not drafted for a specialty agency's dispute: that agency has its own letter.
    const specialty = fixture('specialty_dispute').dispute!;
    for (const key of ['not_my_account', 'inaccurate_balance', 'identity_theft_block', 'outdated_item']) expect(missing(key, (c) => ({ ...c, dispute: specialty })), key).toMatch(/Use the account-record dispute/);
    expect(render('bureau_dispute', (c) => ({ ...c, dispute: specialty }))).toMatchObject({ ok: true, templateKey: 'specialty_public_records_en', kind: 'specialty_dispute' });
    for (const e of LETTER_LIBRARY.filter((x) => x.needsDispute)) expect(missing(e.key, (c) => ({ ...c, dispute: null })), e.key).toMatch(/Choose the related dispute/);
    expect(renderLibraryLetter('no_such_letter', fixture('bureau_dispute'))).toEqual({ ok: false, missing: ['Unknown letter.'] });
  });
});

describe('a letter is drafted only for the dispute it was written for', () => {
  const why = (key: string, over: (c: LetterContext) => LetterContext = (c) => c, from = 'inaccurate_balance') => {
    const r = renderLibraryLetter(key, over(fixture(from)));
    return r.ok ? '' : r.missing.join(' ');
  };
  const creditorItem = (category: string) => (c: LetterContext): LetterContext => ({ ...c, recipientAddress: 'PO Box 1, Anytown, ST 00000', dispute: { ...c.dispute!, category, target_type: 'furnisher', bureau: null, recipient_name: 'Acme Bank', item_label: 'Acme Bank ••1234' } });

  it('refuses a letter written for another kind of recipient', () => {
    // A bureau dispute about a collection: no FDCPA letter to Experian.
    expect(why('debt_validation')).toMatch(/goes to a credit bureau, and this letter is written for a debt collector\. Choose a letter under “To a credit bureau”\./);
    expect(why('stop_communication')).toMatch(/written for a debt collector/);
    expect(why('goodwill')).toMatch(/written for the creditor that reports the account/);
    expect(why('creditor_direct_dispute')).toMatch(/written for the creditor that reports the account/);
    // An item sent to the creditor: no § 611 reinvestigation letter, no collector letter, no follow-up about a reinvestigation.
    for (const key of ['inaccurate_balance', 'bureau_dispute', 'not_my_account', 'follow_up_no_response', 'method_of_verification', 'personal_information']) expect(why(key, creditorItem('furnisher_direct')), key).toMatch(/goes to the creditor that reports the account, and this letter is written for a credit bureau/);
    expect(why('stop_communication', creditorItem('furnisher_direct'))).toMatch(/written for a debt collector\. Choose a letter under “To the creditor”/);
    // A collector's item: no bureau or creditor letter.
    const collector = (c: LetterContext): LetterContext => ({ ...c, dispute: { ...c.dispute!, category: 'unverifiable_collection', target_type: 'collector', bureau: null, recipient_name: 'Northstar Recovery' } });
    expect(why('inaccurate_balance', collector)).toMatch(/goes to a debt collector, and this letter is written for a credit bureau/);
    expect(why('goodwill', collector)).toMatch(/goes to a debt collector/);
    // The letters that fit still render.
    expect(why('inaccurate_balance')).toBe('');
    expect(why('creditor_direct_dispute', (c) => c, 'creditor_direct_dispute')).toBe('');
    expect(why('debt_validation', (c) => c, 'debt_validation')).toBe('');
    // A general dispute, a follow-up and a method-of-verification request also go to a specialty agency.
    const specialty = fixture('specialty_dispute').dispute!;
    expect(missingFacts('follow_up_en', { ...fixture('follow_up_no_response'), dispute: { ...specialty, submitted_at: '2026-10-01', response_at: null } })).toEqual([]);
    expect(missingFacts('personal_info_correction_en', { ...fixture('personal_information'), dispute: specialty })).toEqual([expect.stringMatching(/Use the account-record dispute/)]);
  });

  it('refuses the identity theft block unless the dispute is entered as identity theft', () => {
    expect(why('identity_theft_block', (c) => ({ ...c, dispute: { ...c.dispute!, category: 'incorrect_balance' } }), 'identity_theft_block')).toMatch(/not entered as identity theft, so the request is not drafted for it/);
    expect(why('identity_theft_block', (c) => ({ ...c, dispute: { ...c.dispute!, category: 'not_mine' } }), 'identity_theft_block')).toMatch(/not entered as identity theft/);
    expect(why('identity_theft_block', (c) => c, 'identity_theft_block')).toBe('');
  });

  it('keeps a goodwill request and a dispute apart, both ways', () => {
    // The client accepts the reporting: no dispute, no letter that asks the creditor to find an error.
    expect(why('creditor_direct_dispute', creditorItem('goodwill'))).toMatch(/The client accepts how this item is reported, so no dispute or follow-up letter is drafted for it/);
    expect(why('creditor_direct_dispute', creditorItem('payment_update'))).toMatch(/The client accepts how this item is reported/);
    expect(why('goodwill', creditorItem('goodwill'))).toBe('');
    expect(why('payment_update', creditorItem('payment_update'))).toBe('');
    // The client disputes the reporting: a letter that accepts it as accurate is not drafted on the same item.
    expect(why('goodwill', creditorItem('furnisher_direct'))).toMatch(/A goodwill request accepts the reporting as accurate, and this dispute says it is not/);
  });

  it('a letter that states the client’s position is drafted only for a dispute entered with that position', () => {
    // "which I have paid" on a goodwill item or a creditor dispute that records no payment.
    expect(why('payment_update', creditorItem('goodwill'))).toBe('This letter says the client has paid the account. This item is not entered that way, so the letter is not drafted for it. If that is what the client says, start a new dispute for the account and choose the type “Paid account — request to update”.');
    expect(why('payment_update', creditorItem('furnisher_direct'))).toMatch(/says the client has paid the account\. This dispute is not entered that way/);
    // "that I do not recognize as mine", "reported more than once" and "following my bankruptcy" on a balance dispute,
    // even for a client who has a bankruptcy on file.
    expect(why('not_my_account')).toMatch(/says the client does not recognize the account\. This dispute is not entered that way[\s\S]*choose the type “Client does not recognize the account”/);
    expect(why('duplicate_account')).toMatch(/says the account is reported more than once[\s\S]*choose the type “Possible duplicate reporting”/);
    expect(fixture('inaccurate_balance').facts!.bankruptcy).toBeTruthy();
    expect(why('bankruptcy_included')).toMatch(/says the account was part of the client’s bankruptcy[\s\S]*choose the type “Account included in bankruptcy”/);
    // An identity theft dispute without its report is not answered with the not-my-account letter either.
    expect(why('not_my_account', (c) => c, 'identity_theft_block')).toMatch(/says the client does not recognize the account/);
    // Each one still drafts for its own kind of dispute, and the letters that state no position are not affected.
    for (const key of ['not_my_account', 'duplicate_account', 'bankruptcy_included']) expect(why(key, (c) => c, key), key).toBe('');
    expect(why('payment_update', creditorItem('payment_update'))).toBe('');
    for (const key of ['bureau_dispute', 'inaccurate_balance', 'inaccurate_status', 'inaccurate_history_dates']) expect(why(key, (c) => c, key), key).toBe('');
    // What is left for an item the client accepts as reported is named by its kind.
    expect(why('creditor_direct_dispute', creditorItem('goodwill'))).toMatch(/Use the goodwill request\.$/);
    expect(why('creditor_direct_dispute', creditorItem('payment_update'))).toMatch(/Use the request to update a paid account or the goodwill request\.$/);
  });

  it('an agency’s own template is refused while its own text claims a right the built-in letters no longer claim', () => {
    const own = (kind: Parameters<typeof missingFactsForOwnTemplate>[0]['kind'], baseKey: string | null, text: string) =>
      (c: LetterContext) => missingFactsForOwnTemplate({ baseKey, fallbackKey: `${kind}_en`, kind, body: text }, c);
    // The creditor letter as it was worded before: a creditor need not investigate a dispute this office prepared
    // (15 U.S.C. § 1681s-2(a)(8)(G)), so a copy that still cites the direct-dispute right is not drafted from.
    const oldCreditor = 'Re: Direct dispute — {{item_label}}\n\nUnder Section 623(a)(8) of the Fair Credit Reporting Act (15 U.S.C. § 1681s-2(a)(8)), I ask that you investigate the information below.\n\n{{reason}}\n\nSincerely,\n{{client_name}}';
    const creditor = fixture('creditor_direct_dispute');
    expect(own('creditor_dispute', 'creditor_dispute_en', oldCreditor)(creditor)).toEqual([OLD_CREDITOR_WORDING]);
    expect(own('creditor_dispute', null, 'I dispute this under 15 U.S.C. § 1681s-2(a)(8).\n\n{{reason}}')(creditor)).toEqual([OLD_CREDITOR_WORDING]);
    expect(OLD_CREDITOR_WORDING).toMatch(/not required to investigate a dispute that a credit repair company prepared[\s\S]*take the citation out, or customize the current letter to the creditor again/);
    expect(own('creditor_dispute', 'creditor_dispute_en', templateByKey('creditor_dispute_en')!.body)(creditor)).toEqual([]);
    // The validation letter as it was worded before states the 30-day right whatever is on file. It is drafted only
    // while a notice with an open validation period is on file for the debt (15 U.S.C. § 1692g(b)).
    const oldValidation = 'Re: Request for validation of debt — {{item_label}}\n\nUnder Section 809(b) of the Fair Debt Collection Practices Act (15 U.S.C. § 1692g(b)), I dispute this debt and request validation.\n\n{{reason}}\n\nUntil you provide validation, I ask that you cease collection of it, as the statute provides.\n\nSincerely,\n{{client_name}}';
    const collector = fixture('debt_validation');
    expect(own('validation_request', 'validation_request_en', oldValidation)(collector)).toEqual([]); // notice received 17 days ago: open
    expect(own('validation_request', 'validation_request_en', oldValidation)({ ...collector, facts: { ...collector.facts, notice: { kind: 'received', date: '2026-08-02', open: false } } })).toEqual([OLD_VALIDATION_WORDING]);
    expect(own('validation_request', 'validation_request_en', oldValidation)({ ...collector, facts: { ...collector.facts, notice: null } })).toEqual([OLD_VALIDATION_WORDING]);
    expect(OLD_VALIDATION_WORDING).toMatch(/no notice with an open validation period is on file for this debt/);
    // The current built-in letter states the right through a merge field, so a copy of it is never caught by this.
    expect(templateByKey('validation_request_en')!.body).not.toMatch(/809|1692g/);
    expect(own('validation_request', 'validation_request_en', templateByKey('validation_request_en')!.body)({ ...collector, facts: { ...collector.facts, notice: null } })).toEqual([]);
    // "as the statute provides" alone is not the claim: the identity theft block says it about its own statute.
    const theft = fixture('identity_theft_block');
    expect(own('bureau_dispute', 'identity_theft_block_en', templateByKey('identity_theft_block_en')!.body)(theft)).toEqual([]);
  });

  it('an agency’s own copy of the earlier outdated-item letter is not drafted for an account that is only late', () => {
    // The letter as it was worded before: the subject and the opening call the account an item past its reporting period.
    const oldOutdated = 'Re: Item that appears to be past the reporting period — {{item_label}}\n\nTo whom it may concern:\n\nI am writing about an item in my credit file that appears to be past the period in which it may be reported (15 U.S.C. § 1681c).\n\n{{obsolete_text}}\n\n{{reason}}\n\nSincerely,\n{{client_name}}';
    const own = (text: string) => (c: LetterContext) => missingFactsForOwnTemplate({ baseKey: 'outdated_item_en', fallbackKey: 'bureau_dispute_en', kind: 'bureau_dispute', body: text }, c);
    const whole = fixture('outdated_item');
    const lateOnly: LetterContext = { ...whole, facts: { ...whole.facts, fallOff: { kind: 'date', date: '2026-03-10', rule: 'seven_years', from: '2019-03-10' } } };
    // A collection or a charge-off ages off as a whole, so the earlier wording is true of it.
    expect(whole.facts?.fallOff).toMatchObject({ kind: 'date' });
    expect(whole.facts?.fallOff).not.toMatchObject({ rule: 'seven_years' });
    expect(own(oldOutdated)(whole)).toEqual([]);
    // An account that is only late stays reportable (15 U.S.C. § 1681c(a)(5)): the copy is refused, with what to do.
    expect(own(oldOutdated)(lateOnly)).toEqual([OLD_OUTDATED_WORDING]);
    expect(OLD_OUTDATED_WORDING).toMatch(/This account is only late[\s\S]*the account itself stays reportable\. Use the built-in outdated item letter, or customize it again/);
    // A copy of the current letter names what it is about through merge fields, so it is drafted for both.
    expect(templateByKey('outdated_item_en')!.body).not.toMatch(/item (in my credit file )?that appears to be past/i);
    expect(own(templateByKey('outdated_item_en')!.body)(lateOnly)).toEqual([]);
    expect(own(templateByKey('outdated_item_en')!.body)(whole)).toEqual([]);
  });

  it('keeps personal information and account letters apart', () => {
    expect(why('personal_information')).toMatch(/lists personal information entries, and this dispute is about an account/);
    expect(why('inaccurate_balance', (c) => c, 'personal_information')).toMatch(/about personal information, not an account\. Use the personal information correction/);
    expect(why('bureau_dispute', (c) => c, 'personal_information')).toBe('');
  });

  it('holds an agency’s own copy of a letter to the facts of the letter it was copied from', () => {
    const own = (baseKey: string | null, kind: Parameters<typeof missingFactsForOwnTemplate>[0]['kind'], body = 'Dear {{recipient_name}}:\n\n{{reason}}\n\nSincerely,\n{{client_name}}') =>
      (c: LetterContext) => missingFactsForOwnTemplate({ baseKey, fallbackKey: `${kind === 'bureau_dispute' ? 'bureau_dispute' : kind}_en`, kind, body }, c).join(' ');
    const balance = fixture('inaccurate_balance');
    const theft = fixture('identity_theft_block');
    // A copy of the identity theft block: no report, no letter, even with the report field edited out of the copy.
    expect(own('identity_theft_block_en', 'bureau_dispute')({ ...theft, facts: { ...theft.facts, identityTheftReports: [] } })).toMatch(/needs an identity theft report/);
    expect(own('identity_theft_block_en', 'bureau_dispute')(balance)).toMatch(/not entered as identity theft/);
    expect(own('identity_theft_block_en', 'bureau_dispute')(theft)).toBe('');
    // A copy of the re-dispute: only after "verified", only with something new.
    const again = fixture('redispute_new_information');
    expect(own('redispute_new_information_en', 'bureau_dispute')({ ...again, facts: { ...again.facts, priorOutcome: 'no_response' } })).toMatch(/verified as reported/);
    expect(own('redispute_new_information_en', 'bureau_dispute')({ ...again, dispute: { ...again.dispute!, reason: REASON } })).toMatch(/Nothing new is on file/);
    expect(own('redispute_new_information_en', 'bureau_dispute')(again)).toBe('');
    // A copy of the outdated-item letter: not while the reporting period still runs.
    expect(own('outdated_item_en', 'bureau_dispute')({ ...balance, facts: { ...balance.facts, fallOff: { kind: 'date', date: '2030-01-10', rule: 'seven_years_plus_180_days', from: '2022-07-14' } } })).toMatch(/runs until January 10, 2030\. It is not past the reporting period/);
    const bk = fixture('bankruptcy_included');
    expect(own('bankruptcy_included_en', 'bureau_dispute')({ ...bk, facts: { ...bk.facts, bankruptcy: null } })).toMatch(/No bankruptcy is recorded/);
    expect(own('bankruptcy_included_en', 'bureau_dispute')(bk)).toBe('');
    // And to the kind of dispute it was written for: a copy of a letter that states a position is not drafted on a balance dispute.
    expect(own('bankruptcy_included_en', 'bureau_dispute')(balance)).toMatch(/says the account was part of the client’s bankruptcy\. This dispute is not entered that way/);
    expect(own('not_my_account_en', 'bureau_dispute')(balance)).toMatch(/says the client does not recognize the account/);
    // A template written from scratch that prints a situation field is held to that field's facts: no marked line, no future date.
    const scratch = (field: string) => own(null, 'bureau_dispute', `Dear {{recipient_name}}:\n\n{{ ${field} }}\n\n{{reason}}\n\nSincerely,`);
    expect(scratch('identity_theft_text')({ ...theft, facts: { ...theft.facts, identityTheftReports: [] } })).toMatch(/needs an identity theft report/);
    expect(scratch('obsolete_text')({ ...balance, facts: { ...balance.facts, fallOff: { kind: 'not_available' } } })).toMatch(/no date of first delinquency/);
    expect(scratch('bankruptcy_text')({ ...balance, facts: { ...balance.facts, bankruptcy: null } })).toMatch(/No bankruptcy is recorded/);
    expect(scratch('bankruptcy_text')(balance)).toBe('');
    // And to the same recipient rule: a goodwill template of the agency's own is not drafted on a bureau dispute.
    expect(own(null, 'goodwill')(balance)).toMatch(/written for the creditor that reports the account/);
    expect(own(null, 'validation_request')({ ...fixture('debt_validation'), facts: { ...FACTS, isCollection: false } })).toMatch(/apply to collections only/);
    expect(own(null, 'bureau_dispute')(balance)).toBe('');
  });
});

describe('the reason is the client’s own facts', () => {
  const tl = { creditor: 'Acme Bank', last4: '1234', bureau: 'experian' as const };

  it('drafts no reason where only the client can supply one, and gives a prompt that is not letter text', () => {
    for (const category of ['identity_theft', 'bankruptcy_included', 'payment_update', 'goodwill', 'personal_info', 'unverifiable_collection', 'incorrect_payment_history', 'unauthorized_inquiry', 'furnisher_direct']) {
      expect(draftReason({ category, ...tl }), category).toBe('');
      expect(reasonIsClientsOwn(category), category).toBe(true);
      expect(REASON_PROMPT[category]!.length, category).toBeGreaterThan(40);
      expect(CATEGORIES[category], category).toBeDefined();
    }
    expect(draftReason({ category: 'goodwill', ...tl, clientNote: 'anything' })).toBe('');
    for (const category of ['incorrect_balance', 'not_mine', 'other']) expect(reasonIsClientsOwn(category)).toBe(false);
  });

  it('what it does draft is American English, asks to verify, never asks for removal and passes the claims guard', () => {
    const evidence = [{ bureau: 'experian' as const, field: 'Balance', value: '$1,200.00', source: 'reported' as const }, { bureau: 'equifax' as const, field: 'Balance', value: '$900.00', source: 'reported' as const }];
    for (const category of Object.keys(CATEGORIES).filter((c) => !reasonIsClientsOwn(c) && c !== 'specialty_item')) {
      const text = draftReason({ category, ...tl, evidence });
      expect(text.length, category).toBeGreaterThan(40);
      expect(text, category).not.toMatch(/\b(recognis\w*|authoris\w*)\b/i);
      expect(text, category).not.toMatch(/\b(delet\w*|remov\w*|eras\w*|expung\w*)\b/i);
      // Every one asks to verify, except the client's own statement that the account is not theirs.
      if (category !== 'not_mine') expect(text, category).toMatch(/verif/i);
      expect(findBlockedClaims(text), category).toEqual([]);
    }
    expect(draftReason({ category: 'not_mine', ...tl })).toBe('I do not recognize Acme Bank (account ending 1234) as my account.');
  });

  it('a drafted reason states what the reports show, and nothing they do not: no difference without two values, no empty brackets', () => {
    const rep = (bureau: 'experian' | 'equifax' | 'transunion', field: string, value: string) => ({ bureau, field, value, source: 'reported' as const });
    // Two bureaus report different balances: the reason says so, with both figures.
    expect(draftReason({ category: 'incorrect_balance', ...tl, evidence: [rep('experian', 'Balance', '$1,200.00'), rep('equifax', 'Balance', '$900.00'), rep('transunion', 'Balance', '$1,200.00')] }))
      .toBe('The balance reported for Acme Bank (account ending 1234) differs between the credit reporting agencies (Experian reports $1,200.00; Equifax reports $900.00; TransUnion reports $1,200.00). Please verify the balance with the furnisher and correct it if it is not accurate or cannot be verified.');
    // One bureau, or several that agree: there is nothing to set side by side, so no difference is claimed and the one
    // figure is not restated (the letter prints the balance as the report shows it). The reason is a request to verify.
    const bareBalance = 'Please verify the balance reported for Acme Bank (account ending 1234) with the furnisher and correct it if it is not accurate or cannot be verified.';
    expect(draftReason({ category: 'incorrect_balance', ...tl, evidence: [rep('experian', 'Balance', '$980.00')] })).toBe(bareBalance);
    expect(draftReason({ category: 'incorrect_balance', ...tl, evidence: [rep('experian', 'Balance', '$450.00'), rep('equifax', 'Balance', '$450.00'), rep('transunion', 'Balance', '$450.00')] })).toBe(bareBalance);
    expect(draftReason({ category: 'incorrect_balance', ...tl })).toBe(bareBalance);
    // The reported date of first delinquency is stated as it is; whether the period has ended is the letter's to work out.
    expect(draftReason({ category: 'obsolete', ...tl, evidence: [rep('experian', 'Date of first delinquency', 'February 14, 2016')] }))
      .toBe('My Experian credit report shows a date of first delinquency of February 14, 2016 for Acme Bank (account ending 1234). Please verify that date with the furnisher.');
    // With nothing from a report, no sentence has an empty bracket, a "see enclosed" or a claim that the bureaus differ.
    for (const category of ['incorrect_balance', 'incorrect_status', 'incorrect_dates', 'duplicate', 'obsolete', 'other']) {
      const bare = draftReason({ category, ...tl });
      expect(bare, category).not.toMatch(/\(\)|see enclosed|differs between|do not match across|not consistent across|more than seven years/);
      expect(bare, category).toContain('Acme Bank (account ending 1234)');
      expect(bare, category).toMatch(/verif/i);
    }
    // The date in question is named; the date of first delinquency is asked about only when the evidence is about it.
    expect(draftReason({ category: 'incorrect_dates', ...tl, evidence: [rep('experian', 'Date opened', 'July 15, 2020'), rep('transunion', 'Date opened', 'August 1, 2020')] }))
      .toMatch(/^The date opened reported for Acme Bank \(account ending 1234\) differs between the credit reporting agencies \(Experian reports July 15, 2020; TransUnion reports August 1, 2020\)\./);
    expect(draftReason({ category: 'incorrect_dates', ...tl, evidence: [rep('experian', 'Date opened', 'July 15, 2020'), rep('equifax', 'Date opened', 'July 15, 2020')] }))
      .toBe('Please verify the date opened reported for Acme Bank (account ending 1234) with the furnisher and correct it if needed.');
  });

  it('says the agencies differ only when two different bureaus report different values', () => {
    const rep = (bureau: 'experian' | 'equifax' | 'transunion', field: string, value: string) => ({ bureau, field, value, source: 'reported' as const });
    // Two values from ONE bureau (an older and a newer report, or two entries) are not a difference between agencies.
    const sameBureau = draftReason({ category: 'incorrect_balance', ...tl, evidence: [rep('experian', 'Balance', '$700.00'), rep('experian', 'Balance', '$640.00')] });
    expect(sameBureau).toBe('Please verify the balance reported for Acme Bank (account ending 1234) with the furnisher and correct it if it is not accurate or cannot be verified.');
    expect(draftReason({ category: 'incorrect_dates', ...tl, evidence: [rep('experian', 'Date opened', 'March 5, 2019'), rep('experian', 'Date opened', 'April 9, 2019')] })).not.toMatch(/do not match across/);
    // The same value from the same bureau twice is one value: nothing to list.
    expect(draftReason({ category: 'incorrect_dates', ...tl, evidence: [rep('experian', 'Date opened', 'March 5, 2019'), rep('experian', 'Date opened', 'March 5, 2019')] }))
      .toBe('Please verify the date opened reported for Acme Bank (account ending 1234) with the furnisher and correct it if needed.');
    // A report that carries no date at all gives the reason nothing to restate (it used to read “Experian reports not reported”).
    expect(draftReason({ category: 'incorrect_dates', ...tl, evidence: [rep('experian', 'Date of first delinquency', 'not reported')] }))
      .toBe('Please verify the date of first delinquency reported for Acme Bank (account ending 1234) with the furnisher and correct it if needed.');
    expect(draftReason({ category: 'incorrect_status', ...tl, evidence: [rep('equifax', 'Account status', 'Open'), rep('equifax', 'Account status', 'Closed')] })).not.toMatch(/not consistent across/);
    expect(draftReason({ category: 'incorrect_dates', ...tl, evidence: [rep('experian', 'Date opened', 'March 5, 2019'), rep('equifax', 'Date of first delinquency', 'April 9, 2021')] })).not.toMatch(/do not match across/); // two kinds of date
    // With a second bureau that does differ, the difference is real and is stated.
    expect(draftReason({ category: 'incorrect_balance', ...tl, evidence: [rep('experian', 'Balance', '$700.00'), rep('experian', 'Balance', '$640.00'), rep('equifax', 'Balance', '$700.00')] })).toMatch(/differs between the credit reporting agencies/);
    // A finding within one bureau's report that carries several values: the dates are listed, each with whose it is and
    // written out, the creditor's name is not listed among them, and no difference between agencies is claimed.
    const reAged = draftReason({ category: 'incorrect_dates', ...tl, evidence: [rep('experian', 'Date of first delinquency (collection)', '2021-06-01'), rep('experian', 'Date of first delinquency (original creditor)', '2020-01-15'), rep('experian', 'Original creditor named', 'ACME BANK')] });
    expect(reAged).toBe('Please verify the date of first delinquency reported for Acme Bank (account ending 1234) (Experian reports June 1, 2021 for the collection; Experian reports January 15, 2020 for the original creditor) with the furnisher and correct it if needed.');
    expect(draftReason({ category: 'duplicate', ...tl, evidence: [rep('experian', 'Account ending', '1234'), rep('experian', 'Account ending', '5678')] }))
      .toBe('Acme Bank (account ending 1234) appears to be reported more than once or by more than one company for the same debt (Experian reports account ending 1234; Experian reports account ending 5678). Please verify whether these are separate obligations and, if they are the same one, make sure the debt is not reported as owed twice.');
  });

  it('for an account picked on the form, states one value per bureau, from that bureau’s newest approved report', () => {
    const row = (id: string, bureau: ReportedRow['bureau'], balance: number, newest: boolean, o: Partial<ReportedRow> = {}): ReportedRow =>
      ({ id, bureau, creditor_name: 'ACME BANK', account_last4: '1234', balance_cents: balance, date_opened: '2019-03-05', date_of_first_delinquency: null, newest, ...o });
    // A monthly refresh: two approved Experian reports (September and October), and one Equifax report.
    const older = row('exp-sep', 'experian', 70000, false);
    const newer = row('exp-oct', 'experian', 64000, true);
    const equifax = row('eqf-oct', 'equifax', 65000, true);
    const all = [older, newer, equifax, row('other', 'equifax', 100, true, { creditor_name: 'OTHER LENDER', account_last4: '9999' })];
    const values = (category: string, picked: ReportedRow, rows = all) => reportedFor(category, picked, rows).map((e) => `${e.bureau} ${e.value}`);
    // The newest row is compared with the other bureau's newest row, and never with its own bureau's older report.
    expect(values('incorrect_balance', newer)).toEqual(['experian $640.00', 'equifax $650.00']);
    expect(draftReason({ category: 'incorrect_balance', creditor: 'ACME BANK', last4: '1234', evidence: reportedFor('incorrect_balance', newer, all) }))
      .toMatch(/differs between the credit reporting agencies \(Experian reports \$640\.00; Equifax reports \$650\.00\)/);
    // With only the two Experian reports on file nothing differs "between the agencies": the one value is stated.
    expect(values('incorrect_balance', newer, [older, newer])).toEqual(['experian $640.00']);
    const one = draftReason({ category: 'incorrect_balance', creditor: 'ACME BANK', last4: '1234', evidence: reportedFor('incorrect_balance', newer, [older, newer]) });
    expect(one).toBe('Please verify the balance reported for ACME BANK (account ending 1234) with the furnisher and correct it if it is not accurate or cannot be verified.');
    expect(one).not.toMatch(/differs|\$700|\$640/);
    // A row picked from an older report stands alone: it is not compared with anything.
    expect(values('incorrect_balance', older)).toEqual(['experian $700.00']);
    expect(values('incorrect_dates', newer, [older, newer])).toEqual(['experian March 5, 2019']); // once, not once per report
    // Two rows for the account on one bureau's newest report still give one value for that bureau.
    expect(values('incorrect_balance', newer, [newer, equifax, row('eqf-dup', 'equifax', 99900, true)])).toEqual(['experian $640.00', 'equifax $650.00']);
    // Without account digits the account cannot be matched across reports, so only the chosen row is used.
    const noDigits = row('exp-x', 'experian', 5000, true, { account_last4: null });
    expect(values('incorrect_balance', noDigits, [noDigits, row('eqf-x', 'equifax', 6000, true, { account_last4: null })])).toEqual(['experian $50.00']);
    expect(reportedFor('obsolete', row('c', 'experian', 0, true, { date_of_first_delinquency: '2018-01-10' }), all).map((e) => `${e.field}: ${e.value}`)).toEqual(['Date of first delinquency: January 10, 2018']);
    expect(reportedFor('incorrect_balance', undefined, all)).toEqual([]);
    expect(reportedFor('not_mine', newer, all)).toEqual([]);
  });

  it('a bare request to verify is held until a person adds the client’s own facts', () => {
    const account = { name: 'Acme Bank', reference: '1234' };
    // With nothing from a report, every drafted reason is a request to verify and nothing else: the specificity check holds it.
    for (const category of ['incorrect_balance', 'incorrect_status', 'incorrect_dates', 'duplicate', 'obsolete', 'other']) {
      const bare = draftReason({ category, ...tl });
      expect(bare, category).toMatch(/^Please verify /);
      expect(isConcreteReason(bare, account), category).toBe(false);
      expect(isConcreteReason(draftReason({ category, creditor: '' })), `${category}, account not named`).toBe(false);
    }
    // In the letter: an account typed by staff, balance dispute, the pre-filled reason left as it was.
    const typed = { ...bureauDispute, tradeline: null, item_label: 'Summit Finance ••4410 (Equifax)', bureau: 'equifax', reason: draftReason({ category: 'incorrect_balance', creditor: '' }) };
    const weak = renderLibraryLetter('inaccurate_balance', { ...fixture('inaccurate_balance'), dispute: typed });
    expect(weak.ok && weak.body).toContain('Reason for my request:\nPlease verify the balance reported for this account with the furnisher and correct it if it is not accurate or cannot be verified.\n');
    expect(weak.ok && specificityIssues({ body: weak.body, category: 'incorrect_balance', reason: typed.reason, fields: ['Balance'], account: null }).map((i) => i.key)).toEqual(['reason']);
    // A late payment the client disputes has no drafted reason at all: nobody recorded that it "does not match my records".
    expect(draftReason({ category: 'incorrect_payment_history', ...tl })).toBe('');
    expect(REASON_PROMPT.incorrect_payment_history).toMatch(/Which late payment the client disputes[\s\S]*what the client’s own records show/);
    // One reported value does not change that: restating the bureau's own figure or date is not a reason.
    const rep = (bureau: 'experian' | 'equifax', field: string, value: string) => ({ bureau, field, value, source: 'reported' as const });
    expect(isConcreteReason(draftReason({ category: 'incorrect_balance', ...tl, evidence: [rep('experian', 'Balance', '$980.00')] }), account)).toBe(false);
    expect(isConcreteReason(draftReason({ category: 'incorrect_dates', ...tl, evidence: [rep('experian', 'Date opened', 'March 5, 2019')] }), account)).toBe(false);
    // What stands on its own: a difference the client's reports show, the reported date an outdated-item letter rests
    // on, and the client's own statement that the account is not theirs.
    expect(isConcreteReason(draftReason({ category: 'incorrect_balance', ...tl, evidence: [rep('experian', 'Balance', '$980.00'), rep('equifax', 'Balance', '$900.00')] }), account)).toBe(true);
    expect(isConcreteReason(draftReason({ category: 'obsolete', ...tl, evidence: [rep('experian', 'Date of first delinquency', 'February 14, 2016')] }), account)).toBe(true);
    expect(isConcreteReason(draftReason({ category: 'not_mine', ...tl }), account)).toBe(true);
  });

  it('with no account name on hand, a drafted reason says “this account” and still reads as a sentence', () => {
    // The new dispute form drafts before the person has typed the account's name (it used to pass "the account").
    const say = (category: string, evidence?: Parameters<typeof draftReason>[0]['evidence']) => draftReason({ category, creditor: '', evidence });
    expect(say('duplicate')).toBe('Please verify whether this account is reported more than once, or by more than one company for the same debt, and if it is, make sure the debt is not reported as owed twice.');
    expect(say('duplicate', [{ bureau: 'experian', field: 'Account ending', value: '1234', source: 'reported' }])).toMatch(/^This account appears to be reported more than once/);
    // An inquiry has no drafted reason at all any more: “I do not recall authorizing the inquiry” was also pre-filled
    // for a finding that only says the inquiry is more than two years old, which is not something the client said.
    expect(say('unauthorized_inquiry')).toBe('');
    expect(draftReason({ category: 'unauthorized_inquiry', ...tl })).toBe('');
    expect(categoryForFinding({ category: 'old_inquiry' })).toBe('unauthorized_inquiry');
    expect(REASON_PROMPT.unauthorized_inquiry).toMatch(/What the client says about this inquiry[\s\S]*inquiry’s date as the report shows it/);
    expect(say('not_mine')).toBe('I do not recognize this account as mine.');
    expect(say('incorrect_balance')).toBe('Please verify the balance reported for this account with the furnisher and correct it if it is not accurate or cannot be verified.');
    for (const category of Object.keys(CATEGORIES).filter((c) => !reasonIsClientsOwn(c) && c !== 'specialty_item')) {
      expect(say(category), category).toMatch(/^[A-Z]/);
      expect(say(category), category).not.toMatch(/the account appears|inquiry by the account|\(\)|  /);
    }
    // Named, the account is named.
    expect(draftReason({ category: 'not_mine', ...tl })).toBe('I do not recognize Acme Bank (account ending 1234) as my account.');
  });

  it('a finding starts the dispute that matches what it says, and a bureau dispute about an account on no report has to name it', () => {
    // "Client says payments were never late" is a payment-history dispute. It used to start a "not my account" one.
    expect(categoryForFinding({ category: 'client_statement', dedupe_key: 'client-never-late:8a188ba6' })).toBe('incorrect_payment_history');
    expect(categoryForFinding({ category: 'client_statement', dedupe_key: 'client-not-mine:8a188ba6' })).toBe('not_mine');
    expect(categoryForFinding({ category: 'client_statement' })).toBe('not_mine');
    expect(categoryForFinding({ category: 'balance_mismatch', dedupe_key: 'client-never-late:odd' })).toBe('incorrect_balance');
    expect(categoryForFinding({ category: 'no_such_finding' })).toBeUndefined();
    // No drafted reason for it, so bulk drafting leaves it to a person.
    expect(reasonIsClientsOwn('incorrect_payment_history')).toBe(true);
    // The account's name is required for a bureau dispute with no report account, and for nothing else.
    for (const category of ['incorrect_balance', 'not_mine', 'unauthorized_inquiry', 'other']) expect(mustNameAccount(category, false), category).toBe(true);
    expect(mustNameAccount('incorrect_balance', true)).toBe(false);
    for (const category of ['personal_info', 'goodwill', 'unverifiable_collection', 'furnisher_direct', 'specialty_item']) expect(mustNameAccount(category, false), category).toBe(false);
    // What the form then labels the item: the typed name and digits, never a bare “Item” for personal information.
    expect(typedItemLabel({ category: 'incorrect_balance', hasReportAccount: false, accountName: 'Summit Finance', accountLast4: '4410' })).toBe('Summit Finance ••4410');
    expect(typedItemLabel({ category: 'unauthorized_inquiry', hasReportAccount: false, accountName: 'Capital One', accountLast4: '' })).toBe('Capital One');
    expect(typedItemLabel({ category: 'goodwill', hasReportAccount: false, recipientName: 'Acme Bank', accountLast4: '1234' })).toBe('Acme Bank ••1234');
    expect(typedItemLabel({ category: 'goodwill', hasReportAccount: false, recipientName: 'Acme Bank' })).toBeUndefined(); // the recipient alone is already the label
    expect(typedItemLabel({ category: 'personal_info', hasReportAccount: false })).toBe('Personal information');
    expect(typedItemLabel({ category: 'incorrect_balance', hasReportAccount: true, accountName: 'Ignored' })).toBeUndefined();
  });

  it('naming the account is not a reason: its own name and number never make a stock sentence concrete', () => {
    const account = { name: 'Acme Bank', reference: '1234' };
    const stock = 'Please verify the information reported for Acme Bank (account ending 1234) with the furnisher and correct it if it cannot be verified.';
    expect(isConcreteReason(stock, account)).toBe(false); // its four digits used to make it "concrete"
    expect(isConcreteReason(stock)).toBe(false); // "account ending 1234" is recognized as a reference even with no account passed
    expect(isConcreteReason('Please verify the information reported for Acme Bank 1234 and correct it.')).toBe(true); // a bare number is only known to be the account's when the account is passed
    expect(isConcreteReason('Please verify the information reported for Acme Bank 1234 and correct it.', account)).toBe(false);
    expect(isConcreteReason('Please verify Acme Bank, acct # xxxx1234.', account)).toBe(false);
    expect(isConcreteReason(REASON, account)).toBe(true);
    expect(isConcreteReason('Acme Bank account ending 1234 shows a balance of $1234.56 but I paid it off.', account)).toBe(true);
    // In a letter: the identity theft block with that stock sentence as its reason is held at the reason check.
    const theft = renderLibraryLetter('identity_theft_block', { ...fixture('identity_theft_block'), dispute: { ...fixture('identity_theft_block').dispute!, reason: stock } });
    expect(theft.ok && specificityIssues({ body: theft.body, category: 'identity_theft', reason: stock, fields: [], account }).map((i) => i.key)).toEqual(['reason']);
  });

  it('a paid-account request has to state the payment, and a personal information correction has to list entries', () => {
    const paid = (reason: string) => { const c = fixture('payment_update'); const r = renderLibraryLetter('payment_update', { ...c, dispute: { ...c.dispute!, reason } }); return r.ok ? contentIssues({ kind: 'payment_update', body: r.body, reason, account: { name: 'Acme Bank', reference: '1234' } }).map((i) => i.message) : ['not rendered']; };
    expect(paid('I paid the balance of $900.00 in full on March 3, 2026.')).toEqual([]);
    expect(paid('Please update this account because it has been paid.')).toEqual([expect.stringMatching(/State the payment in the letter: when it was made and how much/)]);
    expect(paid('Please verify the information reported for Acme Bank (account ending 1234) and correct it.')).toEqual([expect.stringMatching(/State the payment/)]);
    const entries = (reason: string) => { const c = fixture('personal_information'); const r = renderLibraryLetter('personal_information', { ...c, dispute: { ...c.dispute!, reason } }); return r.ok ? contentIssues({ kind: 'personal_info_correction', body: r.body, reason }).map((i) => i.message) : ['not rendered']; };
    expect(entries(PI_REASON)).toEqual([]);
    expect(entries('Please verify the personal information listed in my file.')).toEqual([expect.stringMatching(/List the entries in the letter/)]);
    // Other kinds of letter are not judged here.
    expect(contentIssues({ kind: 'goodwill', body: body('goodwill'), reason: '' })).toEqual([]);
    expect(contentIssues({ kind: 'bureau_dispute', body: body('inaccurate_balance'), reason: REASON })).toEqual([]);
  });

  it('an agency’s own follow-up template that prints the earlier wording still gets this dispute’s date', () => {
    // {{prior_date}} is the round before; {{dispute_date}} is this one. createLetter gives a follow-up the latter for both.
    const c = fixture('follow_up_no_response');
    const values = buildValues({ ...c, dispute: { ...c.dispute!, round: 2, submitted_at: '2026-10-01', prior_submitted_at: '2026-08-03' } });
    expect(values.prior_date).toBe('August 3, 2026');
    expect(values.dispute_date).toBe('October 1, 2026');
    expect(mergeTemplate('On {{dispute_date}} I wrote.', values)).toBe('On October 1, 2026 I wrote.\n');
  });
});

describe('bank account sent to collections', () => {
  const reports = specialtyReportStates(null);
  const base: BankCase = { id: 'x', bankName: 'First Coast Bank', chargeAccurate: 'yes', inaccurateDetails: [], paid: 'yes', onCreditReports: 'yes' };
  const steps = (over: Partial<BankCase>, r = reports) => bankCollectionSteps({ ...base, ...over }, { clientId: 'c1', reports: r });
  const keys = (over: Partial<BankCase>) => steps(over).steps.map((s) => s.key);
  const text = (over: Partial<BankCase>) => steps(over).steps.map((s) => `${s.title} ${s.body}`).join('\n');

  it('always starts with the specialty reports and the collector’s notice', () => {
    expect(keys({}).slice(0, 2)).toEqual(['reports', 'notice']);
    expect(steps({}).steps[0]!.title).toBe('Request the ChexSystems and Early Warning reports');
    const received = specialtyReportStates({ chexsystems: { status: 'received', on: '2026-11-01' }, early_warning: { status: 'received', on: '2026-11-02' } });
    expect(steps({}, received).steps[0]!.title).toBe('The ChexSystems and Early Warning reports are on file');
  });

  it('when the client says everything is accurate, says so and offers no dispute: only the request, goodwill and the statement', () => {
    const s = steps({ chargeAccurate: 'yes', inaccurateDetails: ['amount'] });
    expect(s.accurate).toBe(true);
    expect(s.steps.map((x) => x.key)).toEqual(['reports', 'notice', 'accurate', 'update', 'goodwill', 'statement', 'period']);
    expect(text({})).toMatch(/Accurate information is not disputed, and no dispute is offered for this account/);
    expect(s.steps.flatMap((x) => x.links ?? []).some((l) => l.href.includes('/disputes/new'))).toBe(false);
    // No validation request about a debt the client agrees with: that letter says "I dispute this debt".
    expect(s.steps.find((x) => x.key === 'notice')!.body).toMatch(/The client says this debt is accurate, so no validation request is sent about it/);
    expect(s.steps.find((x) => x.key === 'notice')!.body).not.toMatch(/validation request (is|can be) drafted/);
    // The statement step points at the client's freezes and statements, not at the monthly work statement, and does
    // not offer a statement of dispute as a right where nothing is disputed (15 U.S.C. § 1681i(b)).
    const statement = s.steps.find((x) => x.key === 'statement')!;
    expect(statement.links).toEqual([{ href: '/app/clients/c1?tab=reports#protections', label: 'Freezes, alerts and opt-outs' }]);
    expect(statement.body).toMatch(/when a reinvestigation did not resolve a dispute\. Nothing is disputed here, so that does not apply/);
    expect(statement.body).toMatch(/the client can ask ChexSystems or Early Warning whether it does/);
    expect(statement.body).not.toMatch(/shown with the record|those who read the report/);
    expect(s.steps.flatMap((x) => x.links ?? []).some((l) => /\/statement$/.test(l.href))).toBe(false);
    expect(s.steps.find((x) => x.key === 'update')!.links![0]!.href).toContain('templateKey=payment_update_en');
    expect(steps({ paid: 'no' }).steps.find((x) => x.key === 'update')!.links).toBeUndefined();
    expect(text({ paid: 'no' })).toMatch(/Whether to pay is the client’s decision/);
  });

  it('says a closed bank account may be reported, and does not say the agencies publish how long they keep it', () => {
    // The registry says only that these agencies report accounts a bank closed and reported, and records no retention period.
    const reports = steps({}).steps.find((x) => x.key === 'reports')!;
    expect(reports.body).toMatch(/^A closed or overdrawn bank account may be reported to a bank-account reporting agency,/);
    expect(reports.body).not.toMatch(/generally reported/);
    const period = steps({}).steps.find((x) => x.key === 'period')!;
    expect(period.body).toMatch(/^How long ChexSystems and Early Warning keep a closed-account record is not stated here because it has not been confirmed at its source\. Ask the agency, or look on its own site or on the disclosure itself\./);
    expect(period.body).not.toMatch(/publish/);
  });

  it('states a retention period only where the registry records its source', () => {
    const period = steps({}).steps.find((x) => x.key === 'period')!;
    expect(period.body).not.toMatch(/five years|5 years/i); // no source is recorded for ChexSystems or Early Warning
    expect(period.body).toMatch(/not stated here because it has not been confirmed at its source/);
    expect(period.body).toMatch(/generally reported for 7 years, starting 180 days after the reported date of first delinquency/);
    expect(period.links!.map((l) => l.label)).toEqual(['ChexSystems site', 'Early Warning site', 'Aging off']);
  });

  it('disputes only the details the client says are inaccurate, with whoever reports them', () => {
    expect(keys({ chargeAccurate: 'no', inaccurateDetails: ['amount', 'paid_status'] })).toEqual(['reports', 'notice', 'bureau', 'specialty']);
    const t = text({ chargeAccurate: 'no', inaccurateDetails: ['amount', 'paid_status'] });
    expect(t).toMatch(/Dispute only what the client says is inaccurate \(the amount and whether it is shown as paid\)/);
    expect(t).toMatch(/“Inaccurate balance” and “Inaccurate account status”/);
    expect(t).not.toMatch(/Not my account|dates/i);
    expect(keys({ chargeAccurate: 'no', inaccurateDetails: ['dates'], onCreditReports: 'no' })).toEqual(['reports', 'notice', 'specialty']);
    expect(keys({ chargeAccurate: 'no', inaccurateDetails: [] })).toEqual(['reports', 'notice', 'which']);
    // The client questions the debt: the validation request does not wait for the collection to reach a credit report.
    expect(steps({ chargeAccurate: 'no', inaccurateDetails: ['amount'] }).steps.find((x) => x.key === 'notice')!.body).toMatch(/a validation request can be drafted as soon as the notice is recorded, whether or not the collection is on a credit report yet/);
    expect(keys({ chargeAccurate: 'unsure', inaccurateDetails: [] })).toEqual(['reports', 'notice', 'confirm']);
  });

  it('promises nothing in any combination of answers', () => {
    for (const chargeAccurate of ['yes', 'no', 'unsure'] as const) for (const paid of ['yes', 'no'] as const) for (const onCreditReports of ['yes', 'no', 'unsure'] as const) {
      for (const inaccurateDetails of [[], [...BANK_DETAILS]]) {
        const t = text({ chargeAccurate, paid, onCreditReports, inaccurateDetails });
        expect(findBlockedClaims(t), t).toEqual([]);
        expect(t).not.toMatch(/\b(will|can) be (removed|deleted)|pay[\s-]+for[\s-]+delet/i);
      }
    }
  });
});
