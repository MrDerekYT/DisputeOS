/**
 * What an account on a credit report is: a collection, a charge-off, late now, late in the past, in good standing.
 * Read from the words the bureau itself reports, so that every account can carry a plain label ("good" or "bad") and
 * the forms that need an account can fill themselves in. Pure: no database, no network.
 *
 * Where a label comes from, in this order:
 *  1. staff   a person said what the account is. A person always wins; when the report's words say something else,
 *             both are shown. Kept on the account and carried to the same account (same creditor and account number)
 *             on a later report.
 *  2. rules   the report's own words (this file). Most accounts are labelled here, for free.
 *  3. ai      for an account whose words the rules cannot read, an AI suggestion that names the words it rests on.
 *             A suggestion whose words are not in that account is never kept (./account-labels.ts).
 * Anything still unknown is left for a person: "Not labelled".
 *
 * A label is a reading of what the report says, never a statement that the report is right or wrong, and it says
 * nothing about a credit score. "Good standing" means the report's words say current, paid as agreed or never late;
 * "Nothing negative shown" means only neutral words (open, closed, paid) and no late payment or negative status.
 *
 * Sources. The kinds and the flags follow the classifier of the MIT-licensed Errata project
 * (github.com/wjwhitmire/errata, src/errata/model.py, `classify`): collection, charge-off, repossession, foreclosure,
 * bankruptcy, paid, transferred, disputed, medical, student loan, child support. The two-digit codes are the Metro 2
 * account status codes, whose list is in the Apache-2.0 moov-io/metro2 library (pkg/lib/constants.go); what each code
 * means is the Metro 2 format's own definition. R1 to R9 (and I, O, M, C) are the bureaus' older "manner of payment"
 * ratings. The code here is ours.
 */
import { historyShowsLate } from './reporting-period';

export const ACCOUNT_KINDS = ['collection', 'charge_off', 'foreclosure', 'repossession', 'bankruptcy', 'settled', 'late', 'was_late', 'negative', 'good', 'no_negative', 'unknown'] as const;
export type AccountKind = (typeof ACCOUNT_KINDS)[number];
export type KindTone = 'bad' | 'ok' | 'neutral';

/** `rank` orders the bad kinds from the most serious; the list on a client page shows them in this order. */
export const KIND_META: Record<AccountKind, { label: string; tone: KindTone; rank: number; hint: string }> = {
  collection: { label: 'Collection', tone: 'bad', rank: 0, hint: 'Placed with a collector or reported by one.' },
  charge_off: { label: 'Charge-off', tone: 'bad', rank: 1, hint: 'Written off by the creditor as a loss.' },
  foreclosure: { label: 'Foreclosure', tone: 'bad', rank: 2, hint: 'A foreclosure or a deed in lieu of foreclosure.' },
  repossession: { label: 'Repossession', tone: 'bad', rank: 3, hint: 'Repossessed or voluntarily surrendered.' },
  bankruptcy: { label: 'In bankruptcy', tone: 'bad', rank: 4, hint: 'Reported as included in a bankruptcy.' },
  settled: { label: 'Settled', tone: 'bad', rank: 5, hint: 'Reported as settled.' },
  late: { label: 'Late now', tone: 'bad', rank: 6, hint: 'Reported as past due now.' },
  was_late: { label: 'Late payments in the history', tone: 'bad', rank: 7, hint: 'Late payments reported in the past; the account may be current or closed now.' },
  negative: { label: 'Negative item', tone: 'bad', rank: 8, hint: 'Negative information that is none of the kinds above.' },
  good: { label: 'Good standing', tone: 'ok', rank: 9, hint: 'Reported as current, paid as agreed or never late.' },
  no_negative: { label: 'Nothing negative shown', tone: 'ok', rank: 10, hint: 'Only neutral words (open, closed, paid) and no late payment or negative status.' },
  unknown: { label: 'Not labelled', tone: 'neutral', rank: 11, hint: 'The report’s words do not say what this account is. Choose a label.' },
};

/** What a person may choose. Clearing their choice goes back to what the report's words say. */
export const STAFF_KINDS = ['collection', 'charge_off', 'foreclosure', 'repossession', 'bankruptcy', 'settled', 'late', 'was_late', 'negative', 'good'] as const satisfies readonly AccountKind[];
export type StaffKind = (typeof STAFF_KINDS)[number];
export const isStaffKind = (v: unknown): v is StaffKind => typeof v === 'string' && (STAFF_KINDS as readonly string[]).includes(v);

export const isBadKind = (k: AccountKind) => KIND_META[k].tone === 'bad';

/** The reported fields a label can rest on, and how a page names them. */
export type LabelField = 'account_status' | 'payment_status' | 'remarks' | 'account_type' | 'payment_history' | 'creditor_name' | 'original_creditor' | 'section';
export const LABEL_FIELD_NAME: Record<LabelField, string> = {
  account_status: 'Status', payment_status: 'Payment status', remarks: 'Remarks', account_type: 'Account type', payment_history: 'Payment history',
  creditor_name: 'Company name', original_creditor: 'Original creditor', section: 'Section',
};

export interface KindInput {
  item_type: string; creditor_name: string; original_creditor?: string | null; account_type?: string | null;
  account_status?: string | null; payment_status?: string | null; payment_history?: string | null; remarks?: string | null;
}

/** What the rules read: the kind, and the reported words it rests on (null for "listed under collections"). */
export interface KindReading { kind: AccountKind; field: LabelField | null; words: string | null }

// ------------------------------------------------------------------------------------------------- the words

const STATUS = ['account_status', 'payment_status'] as const satisfies readonly LabelField[];
const WORDS: LabelField[] = ['account_status', 'payment_status', 'remarks', 'account_type'];

const BANKRUPTCY = /bankrupt|\bchapter\s*(?:7|11|12|13)\b|\bBKL\b|wage[\s_-]+earner[\s_-]+plan/i;
const FORECLOSURE = /foreclos|deed[\s_-]+in[\s_-]+lieu/i;
const REPOSSESSION = /repossess|\brepo\b|voluntar(?:y|ily)[\s_-]+surrender/i;
const CHARGE_OFF = /charged?[\s_-]*off|profit[\s_]+(?:and|&)[\s_]+loss|written[\s_-]+off|write[\s_-]*off|bad[\s_]+debt|unpaid[\s_]+balance[\s_]+reported[\s_]+as[\s_]+a[\s_]+loss/i;
const COLLECTION = /collection|factoring|debt[\s_]+(?:buyer|purchaser)/i;
/** Placed with a collector or a debt buyer, as an account type says it (TransUnion's "COLLECTION AGENCY/ATTORNEY", "FACTORING COMPANY ACCOUNT"). */
const COLLECTOR_TYPE = /collection|factoring|debt[\s_]+(?:buyer|purchaser)/i;
/** Settled, including the Metro 2 wording "Account (legally) paid in full for less than the full balance". */
const SETTLED = /\bsettle(?:d|ment)\b|less[\s_]+than[\s_]+(?:the[\s_]+)?full[\s_]+balance/i;
/**
 * Negative information of no other kind. "Transferred to recovery" (or to an attorney) is negative, but the account is
 * still the creditor's: it is not a collector's account (src/lib/reports/analysis.ts NOT_SETTLED says the same).
 */
const NEGATIVE = /derog|\badverse\b|insurance[\s_]+claim|claim[\s_]+filed|government[\s_]+claim|seriously[\s_]+past|not[\s_]+(?:paid|paying|pays)[\s_]+as[\s_]+agreed|\bnot[\s_]+current\b|transferr?ed[\s_]+to[\s_]+(?:recovery|(?:an?[\s_]+)?attorney)/i;
/** TransUnion prints its estimate of the month an item will be removed only on accounts with negative information. */
const REMOVAL_MONTH = /Estimated month and year (?:that )?this item will be removed/i;
const GOOD = /pays?[\s_]+as[\s_]+agreed|paid[\s_]+(?:or[\s_]+paying[\s_]+)?as[\s_]+agreed|paying[\s_]+as[\s_]+agreed|never[\s_]+late|never[\s_]+delinquen\w*|\bcurrent\b|\bon[\s_]+time\b|in[\s_]+good[\s_]+standing/i;
const NEUTRAL = /\bopen(?:ed)?\b|\bclosed\b|\bpaid\b|transferr?ed|refinanc|\binactive\b|\bactive\b|\bsold\b/i;
const NOT_PAID = /\b(?:not|un)[\s_-]?paid\b/i;

/** Words that say the opposite of late, removed before looking for lateness. */
const NOT_LATE = /never[\s_]+late|not[\s_]+late|no[\s_]+late[\s_]+payments?|(?:never|not|no)[\s_]+delinquen\w*|pays?[\s_]+as[\s_]+agreed|paid[\s_]+(?:or[\s_]+paying[\s_]+)?as[\s_]+agreed|paying[\s_]+as[\s_]+agreed|current[\s_]+account|\$0(?:\.00)?[\s_]+past[\s_]+due|\b0[\s_]+days?[\s_]+past[\s_]+due/gi;
/**
 * An amount of nothing is not a late payment or a charge-off: "Amount past due: $0", "Charge-off amount: $0.00",
 * "Past due: $0" (readers keep such lines as the bureau printed them). Taken out of every field before anything is read.
 */
const ZERO_AMOUNT = /(?:charge[\s_-]*off[\s_]+amount|amount[\s_]+past[\s_]+due|past[\s_]+due(?:[\s_]+amount)?)[\s_]*:?[\s_]*\$?\s?0(?:\.0{1,2})?(?![\d.,])/gi;
/** Experian's payment history summary ("30 days past due as of Mar 2024"): the latest late month, not the status today. */
const HISTORY_GUIDE = /^(?:\d+[\s_]+days[\s_]+past[\s_]+due|past[\s_]+due)\b[^;]*\bas[\s_]+of\b/i;
const DATES = /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b|\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}\/\d{4}\b/g;
const MONEY = /\$\s?[\d,]+(?:\.\d{2})?/g;
/** In a status, days late are written as numbers ("Late 30", "30 - 59 Days Past Due"). */
const LATE_STATUS = /\b(?:30|60|90|120|150|180)\b|\blate\b|delinquen|past[\s_-]*due|\bdelq\b/i;
/** In remarks only words count: a number there is usually a term ("for 36 months"). */
const LATE_WORDS = /\blate\b|delinquen|past[\s_-]*due/i;
/** "was 30 days past due", "previously late": what the account was, not what it is. */
const PAST_CLAUSE = /\b(?:was|were|previously|formerly|prior(?:ly)?)\b/i;

/** Letter codes in a month-by-month history: COL collection, CO or C/O charge-off, RPO or VS repossession, FC foreclosure. */
const HISTORY_KIND: [RegExp, AccountKind][] = [[/\bFC\b/, 'foreclosure'], [/\b(?:RPO|VS|vs)\b/, 'repossession'], [/\bC\/O\b|\bc\/o\b|\bCO\b|\bC\.O\./, 'charge_off'], [/\bCOL\b/, 'collection']];

/** Metro 2 account status codes, when a status is given as the bare code (some imports do). */
const METRO2: Record<string, AccountKind> = {
  '05': 'no_negative', '11': 'good', '13': 'no_negative',
  '61': 'repossession', '62': 'collection', '63': 'repossession', '64': 'charge_off', '65': 'foreclosure',
  '71': 'late', '78': 'late', '80': 'late', '82': 'late', '83': 'late', '84': 'late',
  '88': 'negative', '89': 'foreclosure', '93': 'collection', '94': 'foreclosure', '95': 'repossession', '96': 'repossession', '97': 'charge_off',
};
/** Metro 2 account type codes, when an account type is given as the bare code: 48 collection agency or attorney, 0C debt buyer. */
const METRO2_COLLECTION_TYPES = new Set(['48', '0C']);
/** Metro 2 account type 90: medical debt. */
const METRO2_MEDICAL_TYPE = '90';
/** Manner-of-payment ratings: R1 pays as agreed; 2 to 5 is 30 to 120+ days late; 7 a wage-earner (Chapter 13) plan; 8 repossession; 9 bad debt. */
const MOP: Record<string, AccountKind> = { '1': 'good', '2': 'late', '3': 'late', '4': 'late', '5': 'late', '7': 'bankruptcy', '8': 'repossession', '9': 'negative' };

const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();

const TEXT_FIELDS = ['account_status', 'payment_status', 'remarks', 'account_type', 'payment_history'] as const;
function withoutZeroAmounts(t: KindInput): KindInput {
  const out: KindInput = { ...t };
  for (const f of TEXT_FIELDS) { const v = t[f]; if (v) out[f] = v.replace(ZERO_AMOUNT, ' ').replace(/(?:\s*·\s*)+$/, '').trim() || null; }
  return out;
}

const short = (s: string) => (s.length > 120 ? `${s.slice(0, 117)}…` : s);
/** The piece of a long field (remarks, a history) that holds a match: one remark out of several, at most 120 characters. */
function piece(text: string, re: RegExp): string {
  const parts = text.split(/\s+·\s+|;\s+|\n/).map((p) => p.trim()).filter(Boolean);
  return short(parts.find((p) => re.test(p)) ?? text);
}
/** A status is shown whole ("Paid, Closed; was Paid as agreed"); remarks and a history only the part that matters. */
const wordsOf = (f: LabelField, v: string, re: RegExp) => (f === 'remarks' || f === 'payment_history' ? piece(v, re) : short(v));

function findIn(t: KindInput, fields: LabelField[], re: RegExp): { field: LabelField; words: string } | null {
  for (const f of fields) {
    const v = clean(t[f as keyof KindInput] as string | null | undefined);
    if (v && re.test(v)) return { field: f, words: wordsOf(f, v, re) };
  }
  return null;
}

/** Splits a status into what it says the account is now and what it says it was ("Paid, Closed; was 30 days past due"). */
function nowAndBefore(s: string): { now: string; before: string } {
  let now = '', before = '';
  for (const seg of s.split(/;|\.(?=\s|$)|,\s+(?=(?:was|previously|formerly)\b)/i)) {
    const m = PAST_CLAUSE.exec(seg);
    if (m) { now += ` ${seg.slice(0, m.index)}`; before += ` ${seg.slice(m.index)}`; } else now += ` ${seg}`;
  }
  return { now, before };
}
const scrub = (s: string) => s.replace(NOT_LATE, ' ').replace(MONEY, ' ').replace(DATES, ' ');

/**
 * What the report's own words say the account is. The checks run from the most serious kind down, so an account that
 * was charged off and is now paid reads as a charge-off, and one that is current but was late reads as late payments
 * in the history.
 */
export function readKind(input: KindInput): KindReading {
  const t = withoutZeroAmounts(input);
  // A status given as a bare code: Metro 2 ("97") or a manner-of-payment rating ("R9").
  for (const f of STATUS) {
    const v = clean(t[f]);
    if (METRO2[v]) return { kind: METRO2[v], field: f, words: v };
    const mop = /^[RIOMC]([0-9])$/i.exec(v);
    if (mop && MOP[mop[1]!]) return { kind: MOP[mop[1]!]!, field: f, words: v };
  }
  const history = clean(t.payment_history);
  const fromHistory = (kind: AccountKind) => {
    const hit = HISTORY_KIND.find(([, k]) => k === kind);
    return hit && hit[0].test(history) ? { kind, field: 'payment_history' as const, words: piece(history, hit[0]) } : null;
  };

  const bk = findIn(t, WORDS, BANKRUPTCY);
  if (bk) return { kind: 'bankruptcy', ...bk };
  const fc = findIn(t, WORDS, FORECLOSURE);
  if (fc) return { kind: 'foreclosure', ...fc };
  const hfc = fromHistory('foreclosure');
  if (hfc) return hfc;
  const repo = findIn(t, WORDS, REPOSSESSION);
  if (repo) return { kind: 'repossession', ...repo };
  const hrepo = fromHistory('repossession');
  if (hrepo) return hrepo;
  // Listed under collections: the report's own section says so, or a bare Metro 2 account type does.
  if (METRO2_COLLECTION_TYPES.has(clean(t.account_type).toUpperCase())) return { kind: 'collection', field: 'account_type', words: clean(t.account_type) };
  if (t.item_type === 'collection') {
    const w = findIn(t, WORDS, COLLECTION);
    return { kind: 'collection', field: w?.field ?? 'section', words: w?.words ?? null };
  }
  const co = findIn(t, WORDS, CHARGE_OFF);
  if (co) return { kind: 'charge_off', ...co };
  const hco = fromHistory('charge_off');
  if (hco) return hco;
  const col = findIn(t, WORDS, COLLECTION);
  if (col) return { kind: 'collection', ...col };
  const hcol = fromHistory('collection');
  if (hcol) return hcol;
  const st = findIn(t, WORDS, SETTLED);
  if (st) return { kind: 'settled', ...st };

  // Late now, or late before. Only the status says which; the history and the remarks only say "before".
  for (const f of STATUS) {
    const v = clean(t[f]);
    if (!v) continue;
    // Experian keeps its history summary as the payment status when the status itself says nothing about lateness.
    if (f === 'payment_status' && HISTORY_GUIDE.test(v) && !LATE_STATUS.test(scrub(clean(t.account_status)))) return { kind: 'was_late', field: f, words: short(v) };
    const { now, before } = nowAndBefore(v);
    if (LATE_STATUS.test(scrub(now))) return { kind: 'late', field: f, words: short(v) };
    if (LATE_STATUS.test(scrub(before))) return { kind: 'was_late', field: f, words: short(v) };
  }
  if (historyShowsLate(history)) {
    const entry = /[^;,]*\b(?:[3-9]0|120)\b[^;,]*/.exec(history.replace(/\b\d{1,2}\/\d{1,2}\/\d{4}\b/g, ' '))?.[0]?.trim();
    return { kind: 'was_late', field: 'payment_history', words: entry ? piece(entry, /./) : piece(history, /./) };
  }
  const remarksLate = findIn(t, ['remarks'], LATE_WORDS);
  if (remarksLate && LATE_WORDS.test(scrub(clean(t.remarks)))) return { kind: 'was_late', ...remarksLate };

  const neg = findIn(t, WORDS, NEGATIVE) ?? findIn(t, ['remarks'], REMOVAL_MONTH);
  if (neg) return { kind: 'negative', ...neg };

  const good = findIn(t, [...STATUS], GOOD);
  if (good) return { kind: 'good', ...good };
  for (const f of STATUS) {
    const v = clean(t[f]);
    if (v && NEUTRAL.test(v) && !NOT_PAID.test(v)) return { kind: 'no_negative', field: f, words: short(v) };
  }
  return { kind: 'unknown', field: null, words: null };
}

// ------------------------------------------------------------------------------------------------- flags

export type AccountTag = 'medical' | 'student_loan' | 'child_support' | 'authorized_user' | 'disputed' | 'transferred';
export const TAG_LABEL: Record<AccountTag, string> = {
  medical: 'medical', student_loan: 'student loan', child_support: 'child support', authorized_user: 'authorized user',
  disputed: 'a dispute is noted on the report', transferred: 'transferred or sold',
};

/**
 * Words a report uses for a medical account. Looked for in the account type, the remarks, the original creditor and,
 * for the "worth checking" screen, the company's own name (./medical-screen.ts).
 */
export const MEDICAL_WORDS = /\b(medical|health(?:\s?care)?|hospitals?|clinics?|physicians?|anesthes\w*|patholog\w*|radiolog\w*|ambulance|dental|dentist|orthoped\w*|pediatrics?|surg(?:ery|ical|eons?)|laborator(?:y|ies)|urgent care|emergency (?:room|physicians?|services?))\b/i;
const STUDENT = /\bstudent\b|\beducation(?:al)?\b|dept\.? of ed|department of education|\bnelnet\b|\bmohela\b|aidvantage|edfinancial|navient|great lakes|fedloan/i;
const SUPPORT = /child support|support enforcement|family support/i;
const AUTHORIZED = /authori[sz]ed user/i;
const DISPUTED = /disput|\bXB\b/i;
const TRANSFERRED = /transferr?ed|\bsold\b|purchased by another/i;

export function accountTags(t: KindInput): AccountTag[] {
  const names = `${t.creditor_name} ${t.original_creditor ?? ''} ${t.account_type ?? ''}`;
  const words = `${t.account_status ?? ''} ${t.payment_status ?? ''} ${t.remarks ?? ''}`;
  const out: AccountTag[] = [];
  if (MEDICAL_WORDS.test(`${names} ${t.remarks ?? ''}`) || clean(t.account_type) === METRO2_MEDICAL_TYPE) out.push('medical');
  if (STUDENT.test(names)) out.push('student_loan');
  if (SUPPORT.test(names)) out.push('child_support');
  if (AUTHORIZED.test(`${t.account_type ?? ''} ${t.remarks ?? ''}`)) out.push('authorized_user');
  if (DISPUTED.test(words)) out.push('disputed');
  if (TRANSFERRED.test(words) && !COLLECTION.test(words) && !/transferr?ed[\s_]+to[\s_]+(?:recovery|(?:an?[\s_]+)?attorney)/i.test(words)) out.push('transferred');
  return out;
}

// ------------------------------------------------------------------------------------------------- the label shown

/**
 * A label stored on an account (tradelines.kind_label): a person's choice, or an AI suggestion. An AI answer of good
 * standing is never a label: it is kept as kind "unknown" with `hint`, shown as a suggestion for a person to confirm.
 */
export interface StoredLabel { kind: AccountKind; by: 'staff' | 'ai'; words?: string | null; field?: LabelField | null; at?: string; carried?: boolean; hint?: AccountKind | null }

export function storedLabel(v: unknown): StoredLabel | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (!(ACCOUNT_KINDS as readonly string[]).includes(o.kind as string) || (o.by !== 'staff' && o.by !== 'ai')) return null;
  return { kind: o.kind as AccountKind, by: o.by, words: typeof o.words === 'string' ? o.words : null, field: typeof o.field === 'string' ? o.field as LabelField : null,
    at: typeof o.at === 'string' ? o.at : undefined, carried: o.carried === true,
    hint: (ACCOUNT_KINDS as readonly string[]).includes(o.hint as string) ? o.hint as AccountKind : null };
}

export interface AccountLabel extends KindReading {
  by: 'staff' | 'rules' | 'ai';
  tags: AccountTag[];
  /** What the report's words say, when a person chose something else. */
  reported?: KindReading;
  /** The person's choice was made on an earlier report of the same account. */
  carried?: boolean;
  /** AI was asked about this account and could not tell either. */
  aiTried?: boolean;
  /** AI read good standing (or nothing negative) in these words: shown for a person to confirm, never applied. */
  aiHint?: { kind: AccountKind; words: string | null };
}

export type LabelInput = KindInput & { kind_label?: unknown };

export function accountLabel(t: LabelInput): AccountLabel {
  const rules = readKind(t);
  const tags = accountTags(t);
  const s = storedLabel(t.kind_label);
  if (s?.by === 'staff') {
    return { kind: s.kind, field: null, words: null, by: 'staff', tags, carried: s.carried, ...(rules.kind !== s.kind && rules.kind !== 'unknown' ? { reported: rules } : {}) };
  }
  if (rules.kind !== 'unknown') return { ...rules, by: 'rules', tags };
  if (s?.by === 'ai' && s.kind !== 'unknown') return { kind: s.kind, field: s.field ?? null, words: s.words ?? null, by: 'ai', tags };
  return { ...rules, by: 'rules', tags, aiTried: s?.by === 'ai', ...(s?.by === 'ai' && s.hint ? { aiHint: { kind: s.hint, words: s.words ?? null } } : {}) };
}

/**
 * The label things are done with: a person's, else the report's words. An AI suggestion is shown (accountLabel) but
 * starts nothing (no finding, no pre-chosen notice, no suggested dispute) until a person confirms it.
 */
export function confirmedLabel(t: LabelInput): AccountLabel {
  const l = accountLabel(t);
  return l.by === 'ai' ? { ...readKind(t), by: 'rules', tags: l.tags } : l;
}

/**
 * A collector's (or debt buyer's) account, which is what the collector-notice and medical-collection tools are for:
 * listed under collections, an account type that names a collector, factoring company or debt buyer (or the Metro 2
 * types 48 and 0C), or labelled a collection by a person. A creditor's own account that is "in collection" or
 * "transferred to recovery" is negative, but it is not one: the creditor is not a debt collector.
 */
export function isCollectorAccount(t: LabelInput): boolean {
  const s = storedLabel(t.kind_label);
  if (s?.by === 'staff' && s.kind === 'collection') return true;
  const type = clean(t.account_type);
  return t.item_type === 'collection' || COLLECTOR_TYPE.test(type) || METRO2_COLLECTION_TYPES.has(type.toUpperCase());
}

/**
 * Whether words an AI quoted can support the kind it gave (./account-labels.ts checks first that they are whole words of
 * that field, not negated). A company name can show only a collection. Late needs words of lateness, or late codes in
 * a history. Good standing (kept only as a hint) needs a status or a history whose words say nothing negative. A
 * negative kind cannot rest on words that say the opposite ("never late", "paid as agreed").
 */
export function wordsSupport(kind: AccountKind, words: string, field: LabelField): boolean {
  if (field === 'creditor_name' || field === 'original_creditor') return kind === 'collection';
  const bad = KIND_META[kind].tone === 'bad';
  const saysGood = GOOD.test(words) || words.replace(NOT_LATE, '') !== words;
  if (bad && saysGood) return false;
  if (kind === 'late' || kind === 'was_late') {
    return LATE_WORDS.test(scrub(words)) || (field === 'payment_history' && historyShowsLate(words)) || ((field === 'account_status' || field === 'payment_status') && LATE_STATUS.test(scrub(words)));
  }
  if (kind === 'good' || kind === 'no_negative') {
    if (field !== 'account_status' && field !== 'payment_status' && field !== 'payment_history') return false;
    const negative = [BANKRUPTCY, FORECLOSURE, REPOSSESSION, CHARGE_OFF, COLLECTION, SETTLED, NEGATIVE, NOT_PAID].some((re) => re.test(words)) || LATE_STATUS.test(scrub(words));
    return !negative;
  }
  // Each negative kind needs words of its own family, written any way (an abbreviation, a typo the rules miss): "CHRG
  // OFF" can show a charge-off, "Unrated" can show nothing.
  return bad && (AI_VOCAB[kind]?.test(words) ?? false);
}

/** The words each negative kind can rest on in an AI answer: looser than the rules, never empty. */
const AI_VOCAB: Partial<Record<AccountKind, RegExp>> = {
  collection: /coll?ect|recover|factor|debt|agency|assign/i,
  charge_off: /charg|chrg|write|writ|written|loss|bad[\s_]+debt|\bc\/?o\b/i,
  foreclosure: /forecl|deed/i,
  repossession: /repo|reposs|surrender/i,
  bankruptcy: /bankr|chapter|\bbk|discharg|petition/i,
  settled: /settl|less[\s_]+than|compromis|partial/i,
  negative: /derog|advers|claim|delinq|default|bad|loss|unpaid|not[\s_]+paid|recovery|attorney|judg|lien|serious/i,
};

/**
 * One account as several bureaus report it. The account is bad when any bureau reports something negative (that entry
 * is on that bureau's report); otherwise good when one of them says so; otherwise not labelled.
 */
export function groupLabel<T extends LabelInput>(lines: T[]): { label: AccountLabel; line: T; each: { line: T; label: AccountLabel }[]; differs: boolean } {
  const each = lines.map((line) => ({ line, label: accountLabel(line) }));
  const pick = [...each].sort((a, b) => {
    const r = (k: AccountKind) => (k === 'unknown' ? 99 : KIND_META[k].rank);
    return r(a.label.kind) - r(b.label.kind);
  })[0]!;
  const differs = new Set(each.map((e) => KIND_META[e.label.kind].tone)).size > 1 || (isBadKind(pick.label.kind) && new Set(each.map((e) => e.label.kind)).size > 1);
  return { label: pick.label, line: pick.line, each, differs };
}

/** Sorts accounts for a list: bad ones first (most serious first), then those not labelled, then the good ones. */
export const labelOrder = (k: AccountKind): number => (isBadKind(k) ? KIND_META[k].rank : k === 'unknown' ? 50 : 50 + KIND_META[k].rank);

/** One plain sentence: what the label rests on. */
export function labelBasis(l: AccountLabel): string {
  if (l.by === 'staff') return `Labelled by staff${l.carried ? ' on an earlier report of this account' : ''}${l.reported ? `. The report says ${KIND_META[l.reported.kind].label.toLowerCase()}${l.reported.words ? ` (“${l.reported.words}”)` : ''}` : ''}.`;
  const where = l.field === 'section' ? 'Listed under collections' : l.field ? `${LABEL_FIELD_NAME[l.field]}${l.words ? `: “${l.words}”` : ''}` : null;
  if (l.by === 'ai') return `AI suggestion${l.field === 'creditor_name' || l.field === 'original_creditor' ? ', from the company name' : ''}${where ? `. ${where}` : ''}. Nothing is done with it until a person confirms it.`;
  if (l.kind === 'unknown' && l.aiHint) return `AI reads ${KIND_META[l.aiHint.kind].label.toLowerCase()}${l.aiHint.words ? ` in “${l.aiHint.words}”` : ''}. Only the report’s own words or a person mark an account good: confirm it if the report says so.`;
  if (l.kind === 'unknown') return l.aiTried ? 'AI could not tell either. Choose a label.' : 'The report’s words do not say. Choose a label.';
  return `${where ?? 'From the report'}.`;
}
