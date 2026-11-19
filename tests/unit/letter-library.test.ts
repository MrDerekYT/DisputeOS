import { describe, expect, it } from 'vitest';
import { protect } from '@/lib/ai/protected';
import { findBlockedClaims } from '@/lib/compliance/claims';
import { BANK_DETAILS, bankCollectionSteps, type BankCase } from '@/lib/credit/bank-collections';
import { specialtyReportStates } from '@/lib/credit/agencies';
import { personalInfoReason } from '@/lib/credit/personal-info';
import { CATEGORIES } from '@/lib/disputes/workflow';
import { draftReason, REASON_PROMPT, reasonIsClientsOwn } from '@/lib/disputes/reasons';
import { LETTER_LIBRARY, LIBRARY_GROUPS, libraryEntry, missingFacts, missingFactsForOwnTemplate, newInformationIn, renderLibraryLetter, templateForEntry, templateKeyForCategory } from '@/lib/letters/library';
import { editableWording } from '@/lib/letters/overlap';
import { buildValues, mergeTemplate, unresolvedPlaceholders, type LetterContext, type SituationFacts } from '@/lib/letters/render';
import { approvalBlockers } from '@/lib/letters/service';
import { contentIssues, isConcreteReason, SPECIFICITY_KINDS, specificityIssues } from '@/lib/letters/specificity';
import { letterTerms, REWORDABLE } from '@/lib/letters/tailor';
import { ALL_TEMPLATES, templateByKey, TEMPLATES } from '@/lib/letters/templates';

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
    expect(body('follow_up_no_response')).toMatch(/Re: Status of my dispute dated October 1, 2026 — [^\n]+\n\nTo whom it may concern:\n\nOn October 1, 2026 I sent you a dispute about the item above\. I have no record of receiving the results/);
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

  it('the letter to the creditor cites no statute and asks for no investigation: a letter this office prepared carries no such duty', () => {
    // 15 U.S.C. § 1681s-2(a)(8)(G) and 12 CFR 1022.43(b)(2): the direct-dispute duty does not apply to a dispute
    // prepared by a credit repair organization, so the letter must not claim it.
    const text = body('creditor_direct_dispute');
    expect(text).not.toMatch(/623|1681s-2|U\.S\.C\.|Fair Credit Reporting Act|investigat/i);
    expect(text).toContain('Re: Information you report about my account — Acme Bank ••1234');
    expect(text).toContain('I ask that you check it against your account records.');
    expect(text).toContain('Please review your account records and the information I have provided, and let me know in writing what you find.');
    expect(templateByKey('creditor_dispute_en')!.name).not.toMatch(/623|Direct dispute/);
  });

  it('a follow-up on a later round is about that round, not the one before it', () => {
    // Round 2 was sent on October 1; round 1 (sent August 3) was answered. The follow-up names October 1 everywhere.
    const r = render('follow_up_no_response', (c) => ({ ...c, facts: { ...c.facts, dueOn: '2026-10-31' }, dispute: { ...c.dispute!, round: 2, submitted_at: '2026-10-01', prior_submitted_at: '2026-08-03', response_at: null } }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.body).toContain('Re: Status of my dispute dated October 1, 2026 — Acme Bank ••1234 (Experian)');
    expect(r.body).toContain('On October 1, 2026 I sent you a dispute about the item above.');
    expect(r.body).not.toContain('August 3, 2026');
    // The re-dispute is the one letter that names the earlier round.
    expect(templateByKey('redispute_new_information_en')!.body).toContain('On {{prior_date}} I disputed the item below');
    for (const t of ALL_TEMPLATES.filter((x) => x.key !== 'redispute_new_information_en')) expect(t.body, t.key).not.toContain('{{prior_date}}');
  });

  it('a validation request cites the 30-day right only when a notice is on file and its period is open', () => {
    const open = body('debt_validation');
    expect(open).toContain('I am writing in response to your written notice about the debt referenced above, which I received on November 2, 2026. Under Section 809(b) of the Fair Debt Collection Practices Act (15 U.S.C. § 1692g(b)), I dispute this debt and request that you provide validation of it, including:');
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
    // A creditor or a collector is never sent either, unless the person drafting asked for the SSN digits.
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
    expect(dates).toContain('Please conduct a reasonable reinvestigation of the dates reported for this account,');
    expect(dates).not.toMatch(/payment history and dates|the payment history reported/);
    expect(say('incorrect_dates', [])).toContain('about the dates reported for the account below.');
    expect(say('incorrect_payment_history', ['Payment history'])).toContain('about the payment history reported for the account below.');
    expect(say('incorrect_payment_history', [])).not.toContain('dates reported');
    expect(say('incorrect_payment_history', ['Payment history', 'Dates'])).toContain('about the payment history and dates reported for the account below.');
    // Ticked fields win over the category: a "dates" dispute with the payment history ticked disputes that.
    expect(say('incorrect_dates', ['Payment history'])).toContain('about the payment history reported for the account below.');
    // Picked by hand for a dispute that names neither: neither is asserted.
    expect(say('other', ['Balance'])).toContain('about the payment history or dates reported for the account below.');
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
    expect(own('bankruptcy_included_en', 'bureau_dispute')({ ...balance, facts: { ...balance.facts, bankruptcy: null } })).toMatch(/No bankruptcy is recorded/);
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
    for (const category of ['identity_theft', 'bankruptcy_included', 'payment_update', 'goodwill', 'personal_info', 'unverifiable_collection']) {
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
      expect(text, category).toMatch(/verif/i);
      expect(findBlockedClaims(text), category).toEqual([]);
    }
    expect(draftReason({ category: 'not_mine', ...tl })).toMatch(/^I do not recognize Acme Bank \(account ending 1234\)\./);
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
