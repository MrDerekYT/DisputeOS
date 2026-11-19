/**
 * The letter library: one well-written English letter per situation, grouped by who it goes to, each with a one-line
 * "use when". This is what staff pick from, and what the rest of the app calls to draft a letter:
 *
 *   - LETTER_LIBRARY / libraryEntry(key)        the situations, for a picker
 *   - templateKeyForCategory(category)          the situation letter that fits a dispute category, if any
 *   - renderLibraryLetter(key, context)         PURE: the letter text, or the list of facts that are missing
 *   - createLetter(db, actor, { templateKey })  (./service.ts) the same thing through the normal pipeline: it loads the
 *                                               recorded facts itself and saves a DRAFT that still needs approval
 *
 * A situation letter is refused, never padded, when a fact it rests on is not on file: an identity theft block without
 * an accepted identity theft report and proof of identity, a re-dispute with nothing new, an "outdated" letter for an
 * item whose reported date does not put it past the reporting period. The app never supplies such a fact itself.
 * A letter is also refused for a dispute it was not written for: a bureau letter for a creditor, a goodwill request on
 * an item the client disputes, an identity theft block on a dispute that is not entered as identity theft. The same
 * rules hold for an agency's own copy of a letter (createLetter runs them against the letter it was copied from).
 */
import { specialtyAgency } from '../credit/agencies';
import { buildValues, longDate, mergeTemplate, type LetterContext } from './render';
import { specialtyTemplateKey, templateByKey, type LetterKind, type LetterTemplate } from './templates';

export type LibraryGroup = 'bureau' | 'collector' | 'creditor' | 'specialty';
export const LIBRARY_GROUPS: { key: LibraryGroup; label: string }[] = [
  { key: 'bureau', label: 'To a credit bureau' },
  { key: 'collector', label: 'To a debt collector' },
  { key: 'creditor', label: 'To the creditor' },
  { key: 'specialty', label: 'To a specialty agency' },
];

export interface LibraryEntry {
  key: string;
  group: LibraryGroup;
  /** The built-in template it drafts from. A specialty dispute resolves its own by the agency's kind of file. */
  templateKey: string;
  name: string;
  /** One line: when to use it. */
  useWhen: string;
  /** True when the letter is about one dispute and cannot be drafted standalone. */
  needsDispute: boolean;
}

/** Shown in the picker for a specialty dispute; createLetter swaps in the template for the agency's kind of file. */
export const SPECIALTY_PICK = specialtyTemplateKey('bank_account');

export const LETTER_LIBRARY: LibraryEntry[] = [
  { key: 'bureau_dispute', group: 'bureau', templateKey: 'bureau_dispute_en', name: 'General dispute', useWhen: 'The issue does not fit a situation below. The reason carries everything.', needsDispute: false },
  { key: 'not_my_account', group: 'bureau', templateKey: 'not_my_account_en', name: 'Not my account', useWhen: 'The client does not recognize the account, and has not said it is identity theft.', needsDispute: true },
  { key: 'inaccurate_balance', group: 'bureau', templateKey: 'inaccurate_balance_en', name: 'Inaccurate balance', useWhen: 'The balance or amount differs from the client’s statements or records.', needsDispute: true },
  { key: 'inaccurate_history_dates', group: 'bureau', templateKey: 'inaccurate_history_dates_en', name: 'Inaccurate payment history or dates', useWhen: 'A late payment or a reported date does not match the client’s records.', needsDispute: true },
  { key: 'inaccurate_status', group: 'bureau', templateKey: 'inaccurate_status_en', name: 'Inaccurate account status', useWhen: 'For example paid but reported unpaid, or closed but reported open.', needsDispute: true },
  { key: 'duplicate_account', group: 'bureau', templateKey: 'duplicate_account_en', name: 'Duplicate account', useWhen: 'The same debt appears twice, or under two companies.', needsDispute: true },
  { key: 'outdated_item', group: 'bureau', templateKey: 'outdated_item_en', name: 'Outdated item', useWhen: 'By its reported date of first delinquency, the item appears to be past the reporting period.', needsDispute: true },
  { key: 'bankruptcy_included', group: 'bureau', templateKey: 'bankruptcy_included_en', name: 'Account included in bankruptcy', useWhen: 'The client says the account was part of their recorded bankruptcy and it is not reported that way.', needsDispute: true },
  { key: 'identity_theft_block', group: 'bureau', templateKey: 'identity_theft_block_en', name: 'Identity theft block request', useWhen: 'An identity theft dispute, with an accepted FTC or police report and an accepted photo ID in the client’s documents.', needsDispute: true },
  { key: 'personal_information', group: 'bureau', templateKey: 'personal_info_correction_en', name: 'Personal information correction', useWhen: 'A name, address, employer, phone number or date of birth on the report is wrong or not the client’s.', needsDispute: false },
  { key: 'redispute_new_information', group: 'bureau', templateKey: 'redispute_new_information_en', name: 'Re-dispute with new information', useWhen: 'After a “verified” result, and only when the client has something that was not in the earlier dispute.', needsDispute: true },
  { key: 'follow_up_no_response', group: 'bureau', templateKey: 'follow_up_en', name: 'Follow-up, no response recorded', useWhen: 'The reinvestigation period has ended and no response has been recorded.', needsDispute: false },
  { key: 'method_of_verification', group: 'bureau', templateKey: 'method_of_verification_en', name: 'Method of verification request', useWhen: 'After a “verified” result: asks how the information was verified. Not a new dispute.', needsDispute: true },
  { key: 'debt_validation', group: 'collector', templateKey: 'validation_request_en', name: 'Debt validation request', useWhen: 'A collection the client questions. The statute is cited only within 30 days of a collector’s notice that is on file.', needsDispute: false },
  { key: 'stop_communication', group: 'collector', templateKey: 'collector_communication_en', name: 'Request to stop communication', useWhen: 'The client wants the collector to stop contacting them. The debt itself is unchanged.', needsDispute: false },
  { key: 'creditor_direct_dispute', group: 'creditor', templateKey: 'creditor_dispute_en', name: 'Letter to the creditor', useWhen: 'Asks the creditor to check its records. It need not investigate a dispute this office prepared; the bureau dispute carries that duty.', needsDispute: false },
  { key: 'goodwill', group: 'creditor', templateKey: 'goodwill_en', name: 'Goodwill adjustment request', useWhen: 'The reporting is accurate (for example a late payment) and the client asks for a courtesy. Not a dispute.', needsDispute: false },
  { key: 'payment_update', group: 'creditor', templateKey: 'payment_update_en', name: 'Request to update a paid account', useWhen: 'The client has paid the account and the reporting does not show it yet.', needsDispute: false },
  { key: 'specialty_dispute', group: 'specialty', templateKey: SPECIALTY_PICK, name: 'Account-record dispute', useWhen: 'An item on a ChexSystems, Early Warning or other specialty disclosure, entered as a specialty dispute.', needsDispute: true },
];

export const libraryEntry = (key: string): LibraryEntry | undefined => LETTER_LIBRARY.find((e) => e.key === key);
export const libraryEntryForTemplate = (templateKey: string): LibraryEntry | undefined =>
  LETTER_LIBRARY.find((e) => e.templateKey === templateKey) ?? (templateKey.startsWith('specialty_') ? libraryEntry('specialty_dispute') : undefined);

/** Dispute category (src/lib/disputes/workflow.ts CATEGORIES) to the situation letter written for it. Others use the general template of their kind. */
const CATEGORY_TEMPLATE: Record<string, string> = {
  not_mine: 'not_my_account_en', incorrect_balance: 'inaccurate_balance_en', incorrect_payment_history: 'inaccurate_history_dates_en', incorrect_dates: 'inaccurate_history_dates_en',
  incorrect_status: 'inaccurate_status_en', duplicate: 'duplicate_account_en', obsolete: 'outdated_item_en', bankruptcy_included: 'bankruptcy_included_en',
  identity_theft: 'identity_theft_block_en', payment_update: 'payment_update_en',
};
export const templateKeyForCategory = (category: string): string | null => CATEGORY_TEMPLATE[category] ?? null;

/** startNextRound writes the new information under this marker (src/lib/disputes/service.ts). */
const NEW_INFO = /New information since my previous (?:request|dispute):\s*([\s\S]+)$/i;
/** What is new in a later round's reason, or null when it states nothing new. */
export function newInformationIn(reason: string): string | null {
  const m = NEW_INFO.exec(reason);
  const text = m?.[1]?.trim() ?? '';
  return text.length >= 15 ? text : null;
}

/** The recipient a letter of each group is written for, as disputes.target_type says it. */
const GROUP_TARGET: Record<LibraryGroup, string> = { bureau: 'bureau', collector: 'collector', creditor: 'furnisher', specialty: 'agency' };
const TARGET_SAYS: Record<string, string> = { bureau: 'a credit bureau', agency: 'a specialty agency', furnisher: 'the creditor that reports the account', collector: 'a debt collector' };
/** The group an agency's own template belongs to when it was not copied from a library letter: by its kind. */
const KIND_GROUP: Record<LetterKind, LibraryGroup> = {
  bureau_dispute: 'bureau', personal_info_correction: 'bureau', follow_up: 'bureau', investigation_response: 'bureau', method_of_verification: 'bureau',
  validation_request: 'collector', collector_communication: 'collector', creditor_dispute: 'creditor', goodwill: 'creditor', payment_update: 'creditor', specialty_dispute: 'specialty',
};
/** Bureau letters that are also sent to a specialty agency (the general dispute becomes that agency's own letter). */
const ALSO_FOR_AGENCY = new Set(['bureau_dispute_en', 'follow_up_en', 'method_of_verification_en', 'investigation_response_en']);
/** Categories in which the client accepts the reporting as accurate: nothing is disputed, only a courtesy or an update is asked for. */
const NOT_A_DISPUTE = new Set(['goodwill', 'payment_update']);
const COURTESY_LETTERS = new Set(['goodwill_en', 'payment_update_en']);

/** Why this letter is not written for whoever the dispute goes to, or null. A hand-built context without a target is not judged. */
function wrongRecipient(templateKey: string, group: LibraryGroup | undefined, d: NonNullable<LetterContext['dispute']>): string | null {
  const target = d.target_type ?? (d.agency ? 'agency' : d.bureau ? 'bureau' : null);
  if (!target || !group) return null;
  // The bureau situation letters are written for the three credit bureaus. A specialty agency's letter carries the item
  // as its disclosure prints it and the identification that agency asks for, so it has its own letter.
  if (target === 'agency' && group === 'bureau') {
    return ALSO_FOR_AGENCY.has(templateKey) ? null : 'This dispute is with a specialty agency. Use the account-record dispute, which carries the item from the disclosure and the identification that agency asks for.';
  }
  if (group === 'specialty') return target === 'agency' ? null : 'A specialty letter is drafted from a specialty agency dispute. Enter the item from the client’s disclosure first.';
  if (GROUP_TARGET[group] === target) return null;
  const fits = LIBRARY_GROUPS.find((g) => GROUP_TARGET[g.key] === target)?.label;
  return `This dispute goes to ${TARGET_SAYS[target] ?? 'someone else'}, and this letter is written for ${TARGET_SAYS[GROUP_TARGET[group]]}.${fits ? ` Choose a letter under “${fits}”.` : ''}`;
}

/** Why this letter does not fit what the dispute says about the item, or null. A hand-built context without a category is not judged. */
function wrongKindOfItem(templateKey: string, d: NonNullable<LetterContext['dispute']>): string | null {
  const category = d.category;
  if (!category) return null;
  if (templateKey === 'identity_theft_block_en' && category !== 'identity_theft') {
    return 'A block request says the information does not come from any transaction the client made. This dispute is not entered as identity theft, so the request is not drafted for it. If that is what the client reports, start an identity theft dispute for the item.';
  }
  if (NOT_A_DISPUTE.has(category) && !COURTESY_LETTERS.has(templateKey)) {
    return 'The client accepts how this item is reported, so no dispute or follow-up letter is drafted for it. Use the goodwill request or the request to update a paid account.';
  }
  if (templateKey === 'goodwill_en' && !NOT_A_DISPUTE.has(category)) {
    return 'A goodwill request accepts the reporting as accurate, and this dispute says it is not. Start a goodwill request as an item of its own.';
  }
  if (templateKey === 'personal_info_correction_en' && category !== 'personal_info') {
    return 'This letter lists personal information entries, and this dispute is about an account. Use a letter written for the account.';
  }
  if (category === 'personal_info' && templateByKey(templateKey)?.kind === 'bureau_dispute' && templateKey !== 'bureau_dispute_en') {
    return 'This dispute is about personal information, not an account. Use the personal information correction.';
  }
  return null;
}

/**
 * The recorded facts a template rests on that are not on file, and the reasons a letter does not fit the dispute, as
 * sentences for the person drafting. Empty = it can be drafted. Templates with no situation of their own (the general
 * ones) need no recorded fact: what they lack shows in the draft as a marked [… NEEDED] line, which blocks approval.
 * `kind` places a template that is not in the library (an agency's own, written from scratch).
 */
export function missingFacts(templateKey: string, c: LetterContext, kind?: LetterKind): string[] {
  const d = c.dispute ?? null;
  const f = c.facts ?? {};
  const out: string[] = [];
  const entry = libraryEntryForTemplate(templateKey);
  const tplKind = templateByKey(templateKey)?.kind ?? kind;
  if (entry?.needsDispute && !d) return ['This letter is about one dispute. Choose the related dispute first.'];
  if (d) {
    const unfit = wrongRecipient(templateKey, entry?.group ?? (tplKind ? KIND_GROUP[tplKind] : undefined), d) ?? wrongKindOfItem(templateKey, d);
    if (unfit) return [unfit];
  }
  switch (templateKey) {
    case 'outdated_item_en':
      if (!f.fallOff) out.push('This account is not reported with negative information, so there is no reporting period to state.');
      else if (f.fallOff.kind !== 'date') out.push('The report shows no date of first delinquency for this account, so the end of its reporting period cannot be worked out. Use the general dispute and ask for the date to be verified.');
      else if (!f.today || f.fallOff.date >= f.today) out.push(`By the reported date of first delinquency, this item’s reporting period runs until ${longDate(new Date(`${f.fallOff.date}T00:00:00Z`))}. It is not past the reporting period.`);
      break;
    case 'bankruptcy_included_en':
      if (!f.bankruptcy) out.push('No bankruptcy is recorded for this client. Enter the chapter and filing date under “Collections and bankruptcy” first.');
      break;
    case 'identity_theft_block_en':
      // 15 U.S.C. § 1681c-2(a): the block follows receipt of proof of the consumer's identity and a copy of an identity
      // theft report. Only documents a person has accepted count; an upload nobody has looked at is not on file yet.
      if (!f.identityTheftReports?.length) out.push('An identity theft block needs an identity theft report. Add the client’s FTC identity theft report or police report to their documents and accept it first.');
      if (!f.identityProof?.includes('id')) out.push('An identity theft block also needs proof of the client’s identity. Add a copy of their government-issued photo ID to their documents and accept it first.');
      break;
    case 'redispute_new_information_en':
      if (!d || d.round < 2 || !d.prior_submitted_at) out.push('This letter follows an earlier dispute of the same item. Start the next round from the resolved dispute.');
      else if (f.priorOutcome !== 'verified') out.push('This letter follows a recorded result of “verified as reported” on the earlier dispute.');
      if (d && !newInformationIn(d.reason)) out.push('Nothing new is on file. State the new information or evidence the client has since the earlier dispute; the same dispute is not sent again without it.');
      break;
    case 'follow_up_en':
      // Standalone (no dispute linked) it is a plain letter a person completes: its date shows as a marked line.
      if (!d) break;
      if (!d.submitted_at) out.push('This dispute has not been recorded as sent.');
      else if (d.response_at && f.outcome !== 'no_response') out.push('A response is recorded for this dispute, so a follow-up for no response does not apply.');
      else if (!f.dueOn || !f.today || f.today <= f.dueOn) out.push('The reinvestigation period has not ended yet.');
      break;
    case 'method_of_verification_en': case 'investigation_response_en':
      if (f.outcome !== 'verified' || !d?.response_at) out.push('This request follows a recorded result of “verified as reported”.');
      break;
    case 'validation_request_en':
      if (d && f.isCollection === false) out.push('Debt validation requests apply to collections only, and nothing on file shows this item is one. Start the dispute from the collection account on an approved report, or record the collector’s notice under “Collections and bankruptcy” first.');
      break;
    default:
      if (templateKey.startsWith('specialty_') && !d?.agency_item) out.push('A specialty letter is drafted from a specialty agency dispute. Enter the item from the client’s disclosure first.');
  }
  return out;
}

/** The built-in letter each situation field belongs to: an agency's own template that prints the field is held to that letter's facts. */
const FIELD_GATE: Record<string, string> = { identity_theft_text: 'identity_theft_block_en', obsolete_text: 'outdated_item_en', bankruptcy_text: 'bankruptcy_included_en' };

/**
 * missingFacts for an agency's own template. It is held to the letter it was copied from (`baseKey`), or to the general
 * letter of its kind (`fallbackKey`) when it was written from scratch, and to the facts behind every situation field
 * its text prints: a copy of the identity theft block is not drafted without the report, whatever was edited out of it,
 * and a template that prints {{obsolete_text}} is not drafted with a marked line or a date that has not passed.
 */
export function missingFactsForOwnTemplate(t: { baseKey: string | null; fallbackKey: string; kind: LetterKind; body: string }, c: LetterContext): string[] {
  const gate = t.baseKey && templateByKey(t.baseKey) ? t.baseKey : t.fallbackKey;
  const out = missingFacts(gate, c, t.kind);
  for (const [field, key] of Object.entries(FIELD_GATE)) {
    if (key === gate || !new RegExp(`\\{\\{\\s*${field}\\s*\\}\\}`).test(t.body)) continue;
    for (const m of missingFacts(key, c)) if (!out.includes(m)) out.push(m);
  }
  return out;
}

/** Documents a situation letter encloses because it rests on them, added to whatever else is enclosed. */
export function factEnclosures(templateKey: string, c: LetterContext): string[] {
  return templateKey === 'identity_theft_block_en' ? (c.facts?.identityTheftReports ?? []).map((l) => `Copy: ${l}`) : [];
}

/**
 * The template a library entry drafts from for this context. A dispute with a specialty agency gets the letter for
 * that agency's kind of file, whether the specialty entry or the general dispute was picked (createLetter does the same).
 */
export function templateForEntry(entry: LibraryEntry, c: LetterContext): LetterTemplate | undefined {
  const agency = specialtyAgency(c.dispute?.agency);
  if (agency && (entry.key === 'specialty_dispute' || entry.key === 'bureau_dispute')) return templateByKey(specialtyTemplateKey(agency.kind));
  return templateByKey(entry.templateKey);
}

export type RenderedLetter = { ok: true; body: string; templateKey: string; kind: LetterKind } | { ok: false; missing: string[] };

/**
 * Pick a situation and render it from recorded facts. Pure: no database, nothing saved. Returns the letter text, or
 * `ok: false` with what is missing. The text still goes through approvalBlockers / specificityIssues before approval.
 */
export function renderLibraryLetter(key: string, c: LetterContext): RenderedLetter {
  const entry = libraryEntry(key);
  const tpl = entry ? templateForEntry(entry, c) : undefined;
  if (!entry || !tpl) return { ok: false, missing: ['Unknown letter.'] };
  const missing = missingFacts(tpl.key, c);
  if (missing.length) return { ok: false, missing };
  const enclosures = [...(c.enclosures ?? []), ...factEnclosures(tpl.key, c).filter((e) => !(c.enclosures ?? []).includes(e))];
  return { ok: true, body: mergeTemplate(tpl.body, buildValues({ ...c, enclosures })), templateKey: tpl.key, kind: tpl.kind };
}
