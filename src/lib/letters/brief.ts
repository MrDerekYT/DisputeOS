/**
 * The letter brief: everything on file that one letter is built from, put together by a pure function.
 *
 *   loadBriefRecord (./brief-load.ts)    reads the rows, under the caller's row-level security
 *   buildBrief(record)                   PURE: the recipient, the account as that bureau reports it, what is disputed and
 *                                        why, what was sent before and what came back, what is enclosed, and the recorded
 *                                        circumstances (bankruptcy, identity theft report, a collector's notice)
 *   disputeLetterKey / recommendLetter   PURE: the letter that fits, with a one-line reason. Staff can pick another.
 *   contextFor(brief, template)          PURE: what that template merges from, with the optional paragraphs
 *
 * The brief decides which optional paragraphs a letter carries. Each states a recorded fact and is left out when the
 * fact is not on file: the reported-account line only for an account on a report, the earlier-round paragraph only
 * when an earlier round was sent, the enclosure sentence only for documents attached or accepted, the notice date only
 * when a collector's notice is recorded and its validation period is open. Nothing is supplied by the app, so two
 * clients' letters differ wherever their files differ.
 *
 * Two short lines are connective wording, not facts: a linking sentence after the opening and a closing courtesy. A
 * style seed worked out from the client's id picks them, so one client's letters keep one voice and another client's
 * read differently. They are the only sentences an AI wording suggestion may change (./tailor.ts).
 */
import { parseAgencyItem, specialtyAgency } from '../credit/agencies';
import { tradelineFallOff } from '../credit/reporting-period';
import { validationPeriod, type NoticeDateKind } from '../credit/validation-clock';
import { noResponseAfter, toDay } from '../disputes/clock';
import { BUREAU_ADDRESSES, CATEGORIES, OUTCOME_LABEL, type Outcome } from '../disputes/workflow';
import type { Evidence } from '../reports/analysis';
import { BUREAU_LABEL, money, type Bureau } from '../util';
import { factEnclosures, libraryEntryForTemplate, missingFacts, newInformationIn, templateKeyForCategory } from './library';
import { longDate, type LetterContext, type ParagraphField, type SituationFacts } from './render';
import { SPECIFICITY_KINDS } from './specificity';
import { kindForWorkflow, procedureTemplateKey, specialtyTemplateKey, templateByKey, templatesFor, type LetterKind } from './templates';

// ---------------------------------------------------------------- the rows a brief is built from

export interface BriefDisputeRow {
  id: string; item_label: string; target_type: string; bureau: string | null; recipient_name: string; recipient_address: string | null;
  category: string; workflow: string; reason: string; fields: string[]; round: number; status: string;
  submitted_at: string | null; response_at: string | null; due_at: string | null; outcome: string | null; client_confirmed_accurate: boolean;
  agency: string | null; agency_item: unknown; tradeline_id: string | null;
  /** The sent date staff recorded on this dispute's letter. It wins over the stored instant, which is only a fallback. */
  sent_on: string | null;
}
/** One account as one bureau reports it: the row read from that bureau's report. */
export interface BriefTradelineRow {
  creditor_name: string; original_creditor: string | null; account_last4: string | null; bureau: string; item_type: string;
  account_status: string | null; payment_status: string | null; payment_history: string | null; balance_cents: number | null;
  date_opened: string | null; date_of_first_delinquency: string | null;
  /** The date printed on the report the row came from, and whether a person has approved that report as read correctly. */
  report_date: string | null; report_status: string | null;
}
export interface BriefPriorRow { round: number; submitted_at: string | null; sent_on: string | null; response_at: string | null; outcome: string | null }

export interface BriefRecord {
  /** Today where the agency works (YYYY-MM-DD), and its zone: a stored instant is read as a day there. */
  today: string; tz: string;
  /** `dob` is the date of birth on the client's record as a day (YYYY-MM-DD), read by the loader; absent when none is on file. */
  client: { id: string; full_name: string; address: LetterContext['client']['address']; ssn_last4: string | null; dob?: string | null; bankruptcy_chapter: string | null; bankruptcy_filed_on: string | null; bankruptcy_discharged_on: string | null };
  dispute: BriefDisputeRow | null;
  tradeline: BriefTradelineRow | null;
  /** The round before this one. */
  prior: BriefPriorRow | null;
  /** The finding the dispute was started from. */
  finding: { title: string; basis: string; evidence: Evidence[] } | null;
  /** Labels of the evidence attached to the dispute, in the order it was added. */
  evidence: string[];
  /** Identity documents that are accepted and still good today. */
  identityDocs: { key: string; label: string }[];
  /** Identity theft reports in the client's documents that a person has accepted, by what they are. */
  identityTheftReports: string[];
  /** Collector notices recorded for the client, newest first. */
  notices: { collector_name: string; date_kind: NoticeDateKind; notice_date: string; tradeline_id: string | null }[];
  /** Letters already on this dispute that are not void. */
  letters: { template_key: string | null; kind: string; status: string }[];
}

/** What the person drafting typed over the file for this one letter. */
export interface BriefOptions { reasonOverride?: string; recipientName?: string; recipientAddress?: string; includeSsnLast4?: boolean; orgName?: string; now?: Date }

// ---------------------------------------------------------------- the brief

export type ReportedKey = 'opened' | 'original_creditor' | 'balance' | 'account_status' | 'payment_status' | 'dofd';
export interface ReportedValue { key: ReportedKey; text: string }

export interface LetterBrief {
  today: string;
  /** Picks the connective wording. Worked out from the client's id and never sent anywhere. */
  seed: number;
  recipient: { kind: string | null; name: string | null };
  /** The account as that bureau reports it. Null when the dispute is not about an account on a report. */
  account: { creditor: string; last4: string | null; bureau: string; bureauLabel: string; reportDate: string | null; isCollection: boolean; reported: ReportedValue[] } | null;
  /** Exactly what is disputed and why, as entered on the dispute. */
  disputed: { category: string; label: string; workflow: string; fields: string[]; reason: string; newInformation: string | null; finding: { title: string; basis: string; evidence: string[] } | null } | null;
  /** What was sent and what came back: this round and the one before it. Days are YYYY-MM-DD where the agency works. */
  history: {
    round: number; status: string; sentOn: string | null; dueOn: string | null; responseOn: string | null; outcome: string | null;
    prior: { round: number; sentOn: string | null; responseOn: string | null; outcome: string | null } | null;
    letters: BriefRecord['letters'];
  } | null;
  enclosures: { evidence: string[]; identity: { key: string; label: string }[] };
  circumstances: {
    bankruptcy: SituationFacts['bankruptcy'] | null;
    identityTheftReports: string[];
    /** The collector's notice recorded for this account or collector, with its validation period (12 CFR 1006.34(b)(5)). */
    notice: { kind: NoticeDateKind; date: string; endsOn: string; daysLeft: number; open: boolean } | null;
    confirmedAccurate: boolean;
  };
  /** The facts every template merges from. What is enclosed and the optional paragraphs depend on the letter: contextFor. */
  context: LetterContext;
}

/** A number worked out from the client's id (FNV-1a). The same client always gets the same one. */
export function styleSeed(clientId: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < clientId.length; i++) { h ^= clientId.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

const say = (day: string) => longDate(new Date(`${day}T00:00:00Z`));
const tidy = (s: string) => s.replace(/\s+/g, ' ').trim();
const same = (a: string, b: string) => tidy(a).toLowerCase() === tidy(b).toLowerCase();

/** Which reported values identify the entry in dispute: by the fields ticked on the dispute, then by its category. */
const FIELD_SHOWS: Record<string, ReportedKey[]> = { Balance: ['balance'], 'Account status': ['account_status', 'payment_status'], 'Payment history': ['payment_status'], Dates: ['dofd'] };
const CATEGORY_SHOWS: Record<string, ReportedKey[]> = {
  incorrect_balance: ['balance'], incorrect_status: ['account_status', 'payment_status'], incorrect_payment_history: ['payment_status'], incorrect_dates: ['dofd'],
  bankruptcy_included: ['account_status', 'balance'], payment_update: ['balance', 'account_status'], unverifiable_collection: ['original_creditor', 'balance'],
};
const REPORTED_ORDER: ReportedKey[] = ['opened', 'original_creditor', 'balance', 'account_status', 'payment_status', 'dofd'];

/**
 * The reported values a letter restates so the recipient can find the entry: always the date opened, then the values
 * the dispute is about (the balance when nothing more specific was chosen). Each is what the report shows, said as it
 * is; a value the report does not carry is left out, never filled in.
 */
export function reportedValues(t: BriefTradelineRow, category: string, fields: string[]): ReportedValue[] {
  const wanted = new Set<ReportedKey>([...fields.flatMap((f) => FIELD_SHOWS[f] ?? []), ...(CATEGORY_SHOWS[category] ?? [])]);
  if (wanted.size === 0) wanted.add('balance');
  wanted.add('opened');
  const text: Record<ReportedKey, string | null> = {
    opened: t.date_opened ? `date opened ${say(t.date_opened)}` : null,
    original_creditor: t.original_creditor?.trim() ? `original creditor ${tidy(t.original_creditor)}` : null,
    balance: t.balance_cents == null ? null : `balance ${money(t.balance_cents)}`,
    account_status: t.account_status?.trim() ? `account status “${tidy(t.account_status)}”` : null,
    payment_status: t.payment_status?.trim() ? `payment status “${tidy(t.payment_status)}”` : null,
    dofd: t.date_of_first_delinquency ? `date of first delinquency ${say(t.date_of_first_delinquency)}` : null,
  };
  return REPORTED_ORDER.filter((k) => wanted.has(k) && text[k]).map((k) => ({ key: k, text: text[k]! }));
}

/**
 * Assembles the brief from the rows on file. Pure: no database, no clock (today comes in on the record). The same
 * record always gives the same brief.
 */
export function buildBrief(r: BriefRecord, o: BriefOptions = {}): LetterBrief {
  const d = r.dispute;
  const tl = d ? r.tradeline : null;
  const day = (v: string | null | undefined) => (v ? toDay(v, r.tz) : null);
  const bankruptcy = r.client.bankruptcy_chapter && r.client.bankruptcy_filed_on
    ? { chapter: r.client.bankruptcy_chapter, filedOn: r.client.bankruptcy_filed_on, dischargedOn: r.client.bankruptcy_discharged_on } : null;
  const facts: SituationFacts = { today: r.today, bankruptcy, identityTheftReports: r.identityTheftReports, identityProof: r.identityDocs.map((x) => x.key) };
  // A collector's notice belongs to this letter when it was recorded for the same account, or for the same collector by name.
  const notice = d && d.target_type === 'collector'
    ? r.notices.find((n) => (!!d.tradeline_id && n.tradeline_id === d.tradeline_id) || same(n.collector_name, d.recipient_name)) ?? null : null;
  const period = notice ? validationPeriod({ kind: notice.date_kind, date: notice.notice_date }, r.today) : null;
  let dispute: LetterContext['dispute'] = null;
  if (d) {
    dispute = {
      item_label: d.item_label, bureau: d.bureau, recipient_name: o.recipientName || d.recipient_name, reason: o.reasonOverride ?? d.reason, fields: d.fields, round: d.round, tradeline: tl,
      category: d.category, target_type: d.target_type,
      prior_submitted_at: r.prior ? r.prior.sent_on ?? r.prior.submitted_at : null,
      agency: d.agency, agency_item: parseAgencyItem(d.agency_item), recipient_address: d.recipient_address,
      submitted_at: d.sent_on ?? d.submitted_at, response_at: d.response_at,
    };
    facts.fallOff = tl ? tradelineFallOff(tl) : null;
    facts.priorOutcome = r.prior?.outcome ?? null;
    facts.outcome = d.outcome;
    facts.dueOn = day(d.due_at);
    // A collection is an account a report lists as one, or a debt a collector has written to the client about: a notice
    // can arrive, and its 30 days can run out, before the collection ever appears on a report.
    facts.isCollection = tl?.item_type === 'collection' || (d.target_type === 'collector' && !!notice);
    facts.notice = notice && period ? { kind: notice.date_kind, date: notice.notice_date, open: period.open } : null;
  }
  const context: LetterContext = { client: r.client, dispute, includeSsnLast4: o.includeSsnLast4, orgName: o.orgName, recipientAddress: o.recipientAddress, tz: r.tz, facts, ...(o.now ? { now: o.now } : {}) };

  // The reported values are restated only for the bureau whose report they were read from, and only from a report a
  // person has approved: an import still awaiting review may have been misread.
  const asReported = !!tl && !!d && (!d.bureau || d.bureau === tl.bureau) && tl.report_status === 'approved';

  return {
    today: r.today, seed: styleSeed(r.client.id),
    recipient: { kind: d?.target_type ?? null, name: d ? (d.bureau ? BUREAU_ADDRESSES[d.bureau]?.name ?? d.recipient_name : dispute!.recipient_name) : o.recipientName ?? null },
    account: tl && d ? {
      creditor: tl.creditor_name, last4: tl.account_last4, bureau: tl.bureau, bureauLabel: BUREAU_LABEL[tl.bureau as Bureau] ?? tl.bureau, reportDate: tl.report_date,
      isCollection: tl.item_type === 'collection', reported: asReported ? reportedValues(tl, d.category, d.fields) : [],
    } : null,
    disputed: d ? {
      category: d.category, label: CATEGORIES[d.category]?.label ?? d.category, workflow: d.workflow, fields: d.fields, reason: dispute!.reason, newInformation: newInformationIn(dispute!.reason),
      finding: r.finding ? { title: r.finding.title, basis: r.finding.basis, evidence: r.finding.evidence.map((e) => `${e.bureau ? BUREAU_LABEL[e.bureau] : e.source}: ${e.field} ${e.value}`) } : null,
    } : null,
    history: d ? {
      round: d.round, status: d.status, sentOn: day(d.sent_on ?? d.submitted_at), dueOn: facts.dueOn ?? null, responseOn: day(d.response_at), outcome: d.outcome,
      prior: r.prior ? { round: r.prior.round, sentOn: day(r.prior.sent_on ?? r.prior.submitted_at), responseOn: day(r.prior.response_at), outcome: r.prior.outcome } : null,
      letters: r.letters,
    } : null,
    enclosures: { evidence: r.evidence, identity: r.identityDocs },
    circumstances: {
      bankruptcy, identityTheftReports: r.identityTheftReports,
      notice: notice && period ? { kind: notice.date_kind, date: notice.notice_date, endsOn: period.endsOn, daysLeft: period.daysLeft, open: period.open } : null,
      confirmedAccurate: d?.client_confirmed_accurate ?? false,
    },
    context,
  };
}

// ---------------------------------------------------------------- connective wording (the voice)

/**
 * The only wording in a letter that carries no fact and asks for nothing. Every line here is courteous, sets no
 * deadline, promises nothing and warns of nothing (enforced by tests/unit/letter-brief.test.ts), and none of them
 * contains a word the protected-rewriting rules lock, so an AI wording suggestion can reword them and nothing else.
 */
const LEAD_INS = ['', 'The details follow.', 'The specifics are as follows.', 'I have set out the details in this letter.', 'Here are the details.'] as const;
const CONTACTS = ['', 'If you need anything further from me, please write to me at the address above.', 'Please write to me at the address above if you have any questions.', 'You can reach me by mail at the address above.'] as const;
const THANKS = ['Thank you for your time and attention.', 'Thank you for looking into this.', 'I appreciate your help with this matter.', 'Thank you for your assistance.', 'Thank you for your careful review.', 'Thank you in advance for your help.'] as const;
/** How an AI wording suggestion is asked to write for this client. Fixed phrases: nothing about the client is in them. */
const TONES = ['plain and direct', 'courteous and measured', 'formal and businesslike', 'warm but brief', 'matter-of-fact'] as const;
const HABITS = ['Use short sentences.', 'Prefer everyday words.', 'Do not use contractions.', 'Keep it brief.'] as const;
export const VOICE_LINES: string[] = [...LEAD_INS, ...CONTACTS, ...THANKS].filter(Boolean);

export interface Voice { leadIn: string; contact: string; thanks: string; tone: string; habit: string }

/** The voice a seed selects. Each choice uses its own part of the number, so the lines vary independently. */
export function voiceFor(seed: number): Voice {
  let n = seed >>> 0;
  const take = <T>(list: readonly T[]): T => { const v = list[n % list.length]!; n = Math.floor(n / list.length); return v; };
  return { leadIn: take(LEAD_INS), contact: take(CONTACTS), thanks: take(THANKS), tone: take(TONES), habit: take(HABITS) };
}

// ---------------------------------------------------------------- the optional paragraphs

const ID_PHRASE: Record<string, string> = { id: 'a copy of my government-issued photo ID', proof_of_address: 'proof of my current address', ssn_proof: 'proof of my Social Security number' };
const listOf = (items: string[]) => (items.length < 3 ? items.join(' and ') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);

/**
 * The paragraphs the brief adds to a letter, as merge values. Every sentence but the two voice lines states a recorded
 * fact; with nothing on file its value is empty and the letter simply does not carry it. `identityDocs` says whether
 * this letter encloses the client's identity documents (a dispute letter to a bureau or a specialty agency does).
 */
export function briefParagraphs(b: LetterBrief, o: { identityDocs: boolean }): Record<ParagraphField, string> {
  const a = b.account;
  const h = b.history;
  const p = h?.prior ?? null;
  const n = b.circumstances.notice;
  const voice = voiceFor(b.seed);

  const reported = a && a.reported.length
    ? `As it appears on my ${a.bureauLabel} credit report${a.reportDate ? ` dated ${say(a.reportDate)}` : ''}: ${a.reported.map((v) => v.text).join('; ')}.\n` : '';

  // The round before this one: when it was sent and what came back. Only outcomes that leave the item in dispute are
  // restated. "Previously", not "first": the file knows the round before, not everything the client ever sent.
  let history = '';
  if (h && h.round > 1 && p?.sentOn) {
    const got = p.responseOn ? `, which I received on ${say(p.responseOn)},` : '';
    const cameBack = p.outcome === 'verified' ? ` Your results${got} stated that the information was verified.`
      : p.outcome === 'no_response' ? ' I have no record of receiving the results of that dispute.'
      : p.outcome === 'frivolous' ? ` Your notice${got} said that you needed more information before you would investigate.`
      : p.outcome === 'unresolved' ? ` Your results${got} did not resolve my dispute.` : '';
    history = `I previously disputed this item on ${say(p.sentOn)}.${cameBack}\n`;
  }

  const evidence = b.enclosures.evidence.map((l) => tidy(l).replace(/[.;:,]+$/, '')).filter(Boolean);
  const identity = o.identityDocs ? b.enclosures.identity.map((i) => ID_PHRASE[i.key] ?? `a copy of my ${i.label.toLowerCase()}`) : [];
  const enclosed = [
    evidence.length ? `I have enclosed ${evidence.length === 1 ? 'the following document' : 'the following documents'}: ${evidence.join('; ')}.` : '',
    identity.length ? `To confirm my identity, I have ${evidence.length ? 'also ' : ''}enclosed ${listOf(identity)}.` : '',
  ].filter(Boolean).join(' ');

  // For an agency's own older validation template. The built-in letter states the notice date itself (validation_intro
  // in ./render.ts), and like it only while the validation period is open: the date is then what makes the request timely.
  const notice = n?.open ? (n.kind === 'received' ? ` I received your written notice about this debt on ${say(n.date)}.` : ` Your written notice about this debt was sent on ${say(n.date)}.`) : '';

  return {
    reported_text: reported, history_text: history, enclosed_text: enclosed, notice_text: notice,
    lead_in: voice.leadIn ? ` ${voice.leadIn}` : '', courtesy: [voice.contact, voice.thanks].filter(Boolean).join(' '),
  };
}

/**
 * What one template merges from: the facts, what is enclosed with THIS letter, and the optional paragraphs. A dispute
 * letter to a bureau or a specialty agency always says what is in the envelope (see ./specificity.ts): the evidence on
 * the dispute, any report the letter rests on, then copies of the identity documents that are accepted and on file, or
 * an explicit "none". A personal information correction carries the same identity documents.
 */
export function contextFor(b: LetterBrief, tpl: { key: string; kind: LetterKind }): LetterContext {
  const toAgency = b.recipient.kind === 'bureau' || b.recipient.kind === 'agency';
  const disputeLetter = toAgency && (SPECIFICITY_KINDS.includes(tpl.kind) || tpl.kind === 'personal_info_correction');
  const evidence = b.enclosures.evidence;
  const enclosures = [
    ...evidence, ...factEnclosures(tpl.key, b.context).filter((e) => !evidence.includes(e)),
    ...(disputeLetter ? b.enclosures.identity.map((x) => `Copy: ${x.label}`) : []),
  ];
  return { ...b.context, enclosures, enclosuresNone: disputeLetter, paragraphs: briefParagraphs(b, { identityDocs: disputeLetter }) };
}

// ---------------------------------------------------------------- which letter fits

/**
 * The letter written for a dispute that has not been sent yet: what createLetter drafts when no template is named. A
 * specialty agency gets the letter for its kind of file; a later round that follows a "verified" result with something
 * new gets the re-dispute; otherwise the letter written for the dispute's category when the facts it rests on are on
 * file, and the general letter of the dispute's kind when they are not. Identity theft and bankruptcy are never
 * drafted as a general letter with the fact left out: their own letter is returned, and it is refused until the fact
 * is on file.
 */
export function disputeLetterKey(b: LetterBrief): string | null {
  const d = b.context.dispute;
  if (!d || !b.disputed) return null;
  const kind = kindForWorkflow(b.disputed.workflow);
  const agency = specialtyAgency(d.agency);
  if (agency && kind === 'specialty_dispute') return specialtyTemplateKey(agency.kind);
  const category = b.disputed.category;
  const fits = [d.round > 1 && kind === 'bureau_dispute' ? 'redispute_new_information_en' : null, templateKeyForCategory(category)]
    .find((k) => !!k && !!templateByKey(k) && missingFacts(k, b.context).length === 0);
  if (fits) return fits;
  if (category === 'identity_theft' || category === 'bankruptcy_included') return templateKeyForCategory(category);
  return templatesFor(kind)?.key ?? null;
}

export interface Recommendation {
  /** The template to draft from, or null when no letter fits right now. */
  templateKey: string | null;
  /** The letter's name as the picker shows it. */
  name: string | null;
  /** One line: why this letter, or why none. */
  reason: string;
  /** Recorded facts the letter still needs before it can be drafted. */
  missing: string[];
  /** A letter of this kind is already on the dispute. */
  exists: boolean;
}

const quoteOutcome = (o: string) => `“${(OUTCOME_LABEL[o as Outcome] ?? o).toLowerCase()}”`;

/** One line on why a letter fits this dispute. Every figure and date in it is one on file. */
function whyThisLetter(b: LetterBrief, key: string): string {
  const a = b.account;
  const bureau = a?.bureauLabel ?? null;
  const shown = (k: ReportedKey) => a?.reported.find((v) => v.key === k)?.text.replace(/^(balance|account status|payment status) /, '') ?? null;
  const f = b.context.facts ?? {};
  const n = b.circumstances.notice;
  if (key.startsWith('specialty_')) return `This dispute is with ${specialtyAgency(b.context.dispute?.agency)?.shortName ?? 'a specialty agency'}, so the letter carries the item from the disclosure and the identification that agency asks for.`;
  switch (key) {
    case 'redispute_new_information_en': return `Round ${b.history?.round ?? 2} follows a result of “verified as reported”${b.history?.prior?.responseOn ? ` received on ${say(b.history.prior.responseOn)}` : ''}, and new information is on file for it.`;
    case 'not_my_account_en': return 'The client does not recognize this account, and it is not entered as identity theft.';
    case 'inaccurate_balance_en': return `The dispute is about the balance${bureau ? ` ${bureau} reports` : ''}${shown('balance') ? ` (${shown('balance')})` : ''}.`;
    case 'inaccurate_history_dates_en': return `The dispute is about the payment history or dates${bureau ? ` ${bureau} reports` : ''}.`;
    case 'inaccurate_status_en': return `The dispute is about the status${bureau ? ` ${bureau} reports` : ''}${shown('account_status') ? ` (${shown('account_status')})` : ''}.`;
    case 'duplicate_account_en': return 'The dispute says the same debt is reported more than once.';
    case 'outdated_item_en': return f.fallOff?.kind === 'date' ? `By the reported date of first delinquency, the reporting period appears to have ended on ${say(f.fallOff.date)}.` : 'The dispute says the item is past its reporting period.';
    case 'bankruptcy_included_en': return f.bankruptcy ? `A Chapter ${f.bankruptcy.chapter} bankruptcy filed on ${say(f.bankruptcy.filedOn)} is recorded for this client.` : 'The dispute says the account was part of the client’s bankruptcy.';
    case 'identity_theft_block_en': return f.identityTheftReports?.length ? `An identity theft report is on file (${f.identityTheftReports.join(', ')}).` : 'The dispute is entered as identity theft.';
    case 'payment_update_en': return 'The client paid this account and asks that the reporting show it.';
    case 'creditor_dispute_en': return 'Asks the company that reports the account to check its records. A creditor is not required to investigate a dispute prepared by a credit repair company (15 U.S.C. § 1681s-2(a)(8)(G); 12 CFR 1022.43(b)(2)), so the dispute with the bureau is the route that carries a duty.';
    case 'personal_info_correction_en': return 'The dispute lists personal information entries for the bureau to review.';
    case 'goodwill_en': return 'A courtesy request about reporting the client accepts as accurate. It is not a dispute.';
    case 'validation_request_en':
      if (!n) return 'A collection account. No collector notice is recorded, so the letter disputes the debt and asks for validation without citing the 30-day right. Record the notice first if the client has one.';
      return n.open ? `A collector notice ${n.kind === 'received' ? 'received' : 'sent'} on ${say(n.date)} is recorded. The validation period generally ends on ${say(n.endsOn)}.`
        : `The validation period for the notice ${n.kind === 'received' ? 'received' : 'sent'} on ${say(n.date)} generally ended on ${say(n.endsOn)}. A request can still be sent; the collector is generally not required to answer it in the same way, so the letter asks without citing that right.`;
    case 'bureau_dispute_en': {
      // The category has a letter of its own that cannot be drafted from what is on file: say why the general one is used.
      const own = templateKeyForCategory(b.disputed?.category ?? '');
      const lacking = own ? missingFacts(own, b.context)[0] : undefined;
      return lacking ?? 'No letter is written for this kind of dispute, so the general dispute carries the reason as entered.';
    }
    default: return libraryEntryForTemplate(key)?.useWhen ?? '';
  }
}

/**
 * The letter that fits a dispute as it stands today, with a one-line reason, or no letter and why. Advice for the
 * person drafting: they can pick any other letter, nothing is drafted or sent from here, and no letter is offered for
 * an item the client has confirmed is reported accurately.
 */
export function recommendLetter(b: LetterBrief): Recommendation {
  const none = (reason: string): Recommendation => ({ templateKey: null, name: null, reason, missing: [], exists: false });
  const pick = (key: string, reason?: string): Recommendation => {
    const tpl = templateByKey(key);
    if (!tpl) return none('No letter fits this dispute.');
    return {
      templateKey: key, name: libraryEntryForTemplate(key)?.name ?? tpl.name.split(' — ')[0]!, reason: reason ?? whyThisLetter(b, key),
      missing: missingFacts(tpl.kind === 'validation_request' ? 'validation_request_en' : key, b.context), exists: !!b.history?.letters.some((l) => l.kind === tpl.kind),
    };
  };
  const h = b.history;
  if (!h || !b.disputed) return none('Link a dispute to see the letter that fits it.');
  if (b.circumstances.confirmedAccurate) return none('The client confirmed this item is reported accurately, so no letter is offered for it.');
  if (h.status === 'cancelled') return none('This dispute was cancelled.');
  const toAgency = b.recipient.kind === 'bureau' || b.recipient.kind === 'agency';
  const sent = h.sentOn && ['submitted', 'under_investigation', 'response_received', 'resolved', 'on_hold'].includes(h.status);
  if (!sent) {
    const key = disputeLetterKey(b);
    return key ? pick(key) : none('No letter fits this dispute.');
  }
  // The dispute letter has gone out: what fits now depends on what came back.
  switch (h.outcome) {
    case 'verified':
      return toAgency ? pick(procedureTemplateKey(), `A result of “verified as reported” was recorded${h.responseOn ? ` on ${say(h.responseOn)}` : ''}. This asks how the information was verified; it is not a new dispute.`)
        : none('The recorded result is “verified as reported”. Another round needs new information or evidence.');
    case 'frivolous': return none(`${b.recipient.name ?? 'The agency'} asked for more information before it investigates. When the client has it, start the next round: that round’s letter includes it.`);
    case 'deleted': case 'updated': return none(`The recorded result is ${quoteOutcome(h.outcome)}. No further letter fits this dispute.`);
    case 'unresolved': return none('The recorded result is “unresolved”. Another round needs new information or evidence.');
    default: break;
  }
  // No response recorded (or staff recorded that none came).
  if (!toAgency || !h.dueOn) return none(`The letter for this dispute was sent on ${say(h.sentOn!)}.`);
  if (b.today > noResponseAfter(h.dueOn)) return pick('follow_up_en', `No response is recorded and the reinvestigation period ended on ${say(h.dueOn)}. Check the mail and the client’s messages first; this asks for the results in writing.`);
  if (b.today > h.dueOn) return none(`The reinvestigation period ended on ${say(h.dueOn)}. Written results generally follow within 5 business days, so allow for the mail before following up.`);
  return none(`This dispute was sent on ${say(h.sentOn!)} and the reinvestigation period runs until ${say(h.dueOn)}. No further letter fits until a response is recorded or the period ends.`);
}

/** The letter a dispute of this category starts with, before any dispute exists: shown where a finding becomes a dispute. */
export function letterForCategory(category: string): { name: string; useWhen: string } | null {
  const cat = CATEGORIES[category];
  if (!cat) return null;
  const key = templateKeyForCategory(category) ?? templatesFor(kindForWorkflow(cat.workflow))?.key;
  const entry = key ? libraryEntryForTemplate(key) : undefined;
  return entry ? { name: entry.name, useWhen: entry.useWhen } : null;
}
