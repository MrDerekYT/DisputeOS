import { BUREAU_LABEL, BUREAUS, money, type Bureau } from '../util';
import { FALL_OFF_RULE_TEXT, historyShowsLate, isNegative, tradelineFallOff } from '../credit/reporting-period';

/**
 * Cross-bureau comparison and discrepancy detection.
 *
 * Principles (from the product brief, enforced by tests):
 *  - A difference between bureaus is a reason to LOOK, never proof of inaccuracy. Findings say "differs" / "may warrant review".
 *  - Every finding lists the evidence behind it and labels each fact: reported (what a bureau shows), client (what the
 *    client or staff asserted), or derived (computed from reported dates).
 *  - Nothing here invents data. Missing fields are simply absent from the comparison.
 */
export interface AnalysisTradeline {
  id: string; bureau: Bureau; item_type: 'tradeline' | 'collection'; creditor_name: string; original_creditor: string | null;
  account_last4: string | null; account_status: string | null; payment_status: string | null; balance_cents: number | null;
  credit_limit_cents: number | null; date_opened: string | null; date_reported: string | null; date_of_first_delinquency: string | null;
  payment_history: string | null; user_provided: Record<string, unknown>;
  /** The bureau's own notes on the account. Read for a removal month the bureau itself prints (printedRemovalMonth) and for the account's label. */
  remarks?: string | null;
  /** For the account's label only (src/lib/credit/account-kind.ts): never compared between bureaus. */
  account_type?: string | null;
  kind_label?: unknown;
}
export interface AnalysisInquiry { id: string; bureau: Bureau; name: string; inquiry_date: string | null; kind: string }
export interface AnalysisPublicRecord { id: string; bureau: Bureau; kind: string; filed_date: string | null; status: string | null }
export interface AnalysisIdentity { bureau: Bureau; kind: 'name' | 'address' | 'employer'; value: string }

/** `record` is something written in the case file by staff (for example a recorded dispute outcome), as opposed to what a bureau reports. */
export interface Evidence { bureau?: Bureau; field: string; value: string; source: 'reported' | 'client' | 'derived' | 'record'; tradeline_id?: string }
export interface Finding {
  dedupe_key: string; category: FindingCategory; severity: 'info' | 'review' | 'strong'; title: string; explanation: string;
  evidence: Evidence[]; basis: 'verified_fact' | 'user_provided' | 'potential_discrepancy'; tradeline_ids: string[];
}

export const FINDING_CATEGORIES = {
  balance_mismatch: 'Balance differs between bureaus',
  status_mismatch: 'Status differs between bureaus',
  date_mismatch: 'Open date differs between bureaus',
  dofd_mismatch: 'Date of first delinquency differs or is missing',
  duplicate_account: 'Possible duplicate reporting',
  obsolete_item: 'Reported dates suggest an old item',
  missing_on_bureau: 'Not reported by every bureau',
  personal_info: 'Personal information differs',
  collection_validation: 'Collection account',
  negative_item: 'Late payments or charge-off reported',
  status_balance_conflict: 'Status and balance do not agree',
  removal_month_passed: 'Reported after the removal month the report prints',
  old_inquiry: 'Older inquiry',
  client_statement: 'Client statement conflicts with report',
  possible_reinsertion: 'Possible reinsertion',
  medical_collection: 'Medical collection and bureau policy',
  bankruptcy_reporting: 'Reporting after a bankruptcy discharge',
  collector_notice: 'Collector notice: validation period',
} as const;
export type FindingCategory = keyof typeof FINDING_CATEGORIES;

const NOISE = new Set(['bank', 'na', 'n', 'a', 'usa', 'us', 'llc', 'inc', 'corp', 'co', 'company', 'services', 'service', 'financial', 'finance', 'card', 'cards', 'credit', 'the', 'of', 'ltd', 'lp']);
export const normCreditor = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((w) => w && !NOISE.has(w)).join(' ');

const normText = (s: string | null) => (s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const ABBR: [RegExp, string][] = [[/\bstreet\b/g, 'st'], [/\bavenue\b/g, 'ave'], [/\bapartment\b/g, 'apt'], [/\broad\b/g, 'rd'], [/\bdrive\b/g, 'dr'], [/\bboulevard\b/g, 'blvd'], [/\blane\b/g, 'ln'], [/\bnorth\b/g, 'n'], [/\bsouth\b/g, 's'], [/\beast\b/g, 'e'], [/\bwest\b/g, 'w']];
/** "MIAMI FL, 33196-4768" and "MIAMI, FL 33196" are the same address: punctuation and ZIP+4 are ignored. */
const normAddress = (s: string) => ABBR.reduce((a, [re, r]) => a.replace(re, r), normText(s.replace(/\b(\d{5})-?\d{4}\b/g, '$1')));

export interface AccountGroup {
  key: string; creditor: string; itemType: 'tradeline' | 'collection'; byBureau: Partial<Record<Bureau, AnalysisTradeline>>; bureauCount: number;
}

/**
 * Same account across bureaus. First by normalised creditor + last 4 (falls back to creditor + open date when last 4
 * is absent). Then accounts that one bureau names or numbers differently (e.g. "NISSAN MOTOR ACCEPTANCE" vs
 * "INFINITI MOTOR ACCEPTANCE CORP", "CB INDIGO/CCI" vs "CB INDIGO", a debt reported by two collectors) are paired when
 * their reported facts line up: the same open date, last 4 or original creditor, plus enough agreeing details. A
 * group never holds two accounts from the same bureau, and the best-matching pairs are joined first.
 */
export function groupAccounts(lines: AnalysisTradeline[]): AccountGroup[] {
  const groups = new Map<string, AccountGroup>();
  for (const t of lines) {
    const base = normCreditor(t.creditor_name);
    const key = `${t.item_type}|${base}|${t.account_last4 ?? `d:${t.date_opened ?? '?'}`}`;
    let g = groups.get(key);
    if (!g) { g = { key, creditor: t.creditor_name, itemType: t.item_type, byBureau: {}, bureauCount: 0 }; groups.set(key, g); }
    if (!g.byBureau[t.bureau]) g.bureauCount++;
    g.byBureau[t.bureau] = t;
  }
  const list = [...groups.values()];
  const lineOf = (g: AccountGroup) => Object.values(g.byBureau)[0]!;
  const pairs: { a: AccountGroup; b: AccountGroup; score: number }[] = [];
  for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
    const a = list[i]!, b = list[j]!;
    if (a.itemType !== b.itemType || BUREAUS.some((x) => a.byBureau[x] && b.byBureau[x])) continue;
    const score = sameAccountScore(lineOf(a), lineOf(b));
    if (score >= 4) pairs.push({ a, b, score });
  }
  pairs.sort((x, y) => y.score - x.score);
  const gone = new Set<AccountGroup>();
  for (const { a, b } of pairs) {
    if (gone.has(a) || gone.has(b) || BUREAUS.some((x) => a.byBureau[x] && b.byBureau[x])) continue;
    // Keep the key of the group identified by account number, so findings stay tied to the stronger identifier.
    const [keep, drop] = lineOf(b).account_last4 && !lineOf(a).account_last4 ? [b, a] : [a, b];
    for (const x of BUREAUS) if (drop.byBureau[x]) { keep.byBureau[x] = drop.byBureau[x]; keep.bureauCount++; }
    gone.add(drop);
  }
  return list.filter((g) => !gone.has(g)).sort((a, b) => a.creditor.localeCompare(b.creditor));
}

const closeMoney = (a: number | null, b: number | null) => a != null && b != null && Math.abs(a - b) <= Math.max(100, Math.abs(a) * 0.02);
const openState = (s: string | null) => (/closed|paid/i.test(s ?? '') ? 'closed' : /open/i.test(s ?? '') ? 'open' : null);

/** How strongly two lines from different bureaus look like one account. 0 unless an identifier lines up. */
export function sameAccountScore(a: AnalysisTradeline, b: AnalysisTradeline): number {
  const na = normCreditor(a.creditor_name), nb = normCreditor(b.creditor_name);
  const oa = normCreditor(a.original_creditor ?? ''), ob = normCreditor(b.original_creditor ?? '');
  // Two different account numbers are two accounts, however much else agrees.
  if (a.account_last4 && b.account_last4 && a.account_last4 !== b.account_last4) return 0;
  const sameLast4 = !!a.account_last4 && a.account_last4 === b.account_last4;
  const sameOpened = !!a.date_opened && a.date_opened === b.date_opened;
  const sameOriginal = !!oa && oa === ob;
  if (!sameLast4 && !sameOpened && !sameOriginal) return 0;
  let s = 0;
  if (sameLast4) s += 5;
  if (sameOpened) s += 3;
  if (sameOriginal) s += 3;
  if (na && na === nb) s += 3;
  else if (na.split(' ')[0] && na.split(' ')[0] === nb.split(' ')[0]) s += 1;
  if (closeMoney(a.balance_cents, b.balance_cents)) s += 2;
  if (closeMoney(a.credit_limit_cents, b.credit_limit_cents)) s += 1;
  const sa = openState(a.account_status), sb = openState(b.account_status);
  if (sa && sa === sb) s += 1;
  return s;
}

export interface FieldDiff { field: keyof AnalysisTradeline; label: string; values: Partial<Record<Bureau, string>> }
/**
 * Bureaus word the same status differently ("Open/Never late." vs "Open", "$690 past due as of Oct 2026." vs
 * "30 - 59 Days Past Due"). Statuses are compared by what they mean, not by their wording.
 */
export function canonAccountStatus(s: string | null): string | null {
  const t = (s ?? '').toLowerCase();
  if (!t) return null;
  if (/collection/.test(t)) return 'collection';
  if (/charge[ds]?[ -]?off|charged off/.test(t)) return 'charged off';
  if (/closed|paid/.test(t)) return 'closed';
  if (/open|current|active/.test(t)) return 'open';
  return normText(t);
}
export function canonPaymentStatus(s: string | null): string | null {
  const t = (s ?? '').toLowerCase();
  if (!t) return null;
  if (/collection/.test(t)) return 'collection';
  if (/charge[ds]?[ -]?off|charged off/.test(t)) return 'charged off';
  if (/past due|late|delinquen|\d+\s*(?:-\s*\d+\s*)?days?/.test(t)) return 'past due';
  if (/pays as agreed|never late|current|on time|as agreed/.test(t)) return 'current';
  return normText(t);
}

const DIFF_FIELDS: { field: keyof AnalysisTradeline; label: string; fmt: (t: AnalysisTradeline) => string | null; same?: (t: AnalysisTradeline) => string | null }[] = [
  { field: 'balance_cents', label: 'Balance', fmt: (t) => (t.balance_cents == null ? null : money(t.balance_cents)) },
  { field: 'account_status', label: 'Account status', fmt: (t) => t.account_status, same: (t) => canonAccountStatus(t.account_status) },
  { field: 'payment_status', label: 'Payment status', fmt: (t) => t.payment_status, same: (t) => canonPaymentStatus(t.payment_status) },
  { field: 'date_opened', label: 'Date opened', fmt: (t) => t.date_opened },
  { field: 'date_of_first_delinquency', label: 'Date of first delinquency', fmt: (t) => t.date_of_first_delinquency },
  { field: 'credit_limit_cents', label: 'Credit limit', fmt: (t) => (t.credit_limit_cents == null ? null : money(t.credit_limit_cents)) },
];

/** Fields that have a value on at least two bureaus where the values are not all equal. */
export function diffGroup(g: AccountGroup): FieldDiff[] {
  const out: FieldDiff[] = [];
  for (const f of DIFF_FIELDS) {
    const vals: Partial<Record<Bureau, string>> = {};
    const canon: string[] = [];
    for (const b of BUREAUS) { const t = g.byBureau[b]; const v = t ? f.fmt(t) : null; if (v) { vals[b] = v; canon.push((f.same ? f.same(t!) : null) ?? normText(v)); } }
    const distinct = new Set(canon);
    if (Object.keys(vals).length >= 2 && distinct.size > 1) out.push({ field: f.field, label: f.label, values: vals });
  }
  return out;
}

/**
 * Wording that reads like "paid" but says the opposite, or says nothing about what is owed: "Pays as agreed" and
 * TransUnion's "Current; Paid or Paying as Agreed" are payment ratings of an open account, and an account "transferred
 * to recovery" (or to another office, an attorney, collections) is still owed to the same creditor.
 */
const NOT_SETTLED = /paid[\s_]+or[\s_]+paying[\s_]+as[\s_]+agreed|(?:paid|pays?|paying)[\s_]+as[\s_]+agreed|(?:not|never)[\s_]+paid|unpaid|transferr?ed to (?:recovery|another office|(?:an? )?attorney|collections?)/gi;
const SETTLED = /\b(paid|settled|transferr?ed|sold|purchased by another)\b/i;
/**
 * The words of a reported status that say nothing is owed to this creditor any more (paid, settled, sold, transferred
 * to another lender), or null. An account reported that way normally carries a zero balance: the idea for this check
 * comes from the "sold with balance" rule of the MIT-licensed Errata project (github.com/wjwhitmire/errata).
 */
export function settledWording(t: Pick<AnalysisTradeline, 'account_status' | 'payment_status'>): string | null {
  for (const s of [t.account_status, t.payment_status]) {
    // Underscores read as spaces: a status kept as a code ("PAID_AND_CLOSED") says the same as its words.
    if (s && SETTLED.test(s.replace(/_/g, ' ').replace(NOT_SETTLED, ' '))) return s.trim();
  }
  return null;
}

/**
 * The month a bureau itself prints as the estimated end of reporting for an account, as "YYYY-MM", or null.
 * TransUnion prints "Estimated month and year this item will be removed" on adverse accounts in place of a date of
 * first delinquency; its reader keeps that line in the account's remarks, word for word.
 */
export function printedRemovalMonth(t: Pick<AnalysisTradeline, 'remarks'>): string | null {
  const m = /Estimated month and year (?:that )?this item will be removed:?\s*(0[1-9]|1[0-2])\/(\d{4})/i.exec(t.remarks ?? '');
  return m ? `${m[2]}-${m[1]}` : null;
}
const sayMonth = (ym: string) => `${ym.slice(5)}/${ym.slice(0, 4)}`;

const yearsSince = (iso: string, now: Date) => (now.getTime() - new Date(`${iso}T00:00:00Z`).getTime()) / (365.25 * 86_400_000);
const NOTE = 'This is a difference to investigate, not a conclusion that anything is inaccurate.';
/** Why a date-of-first-delinquency difference matters, without saying which date (if either) is wrong. 15 U.S.C. § 1681c. */
const DOFD_NOTE = 'This date generally controls how long the item may be reported (15 U.S.C. § 1681c), and it generally stays the same when a debt is sold or placed for collection. The dates differ and should be checked against the client’s records.';
const rep = (t: AnalysisTradeline, field: string, value: string): Evidence => ({ bureau: t.bureau, field, value, source: 'reported', tradeline_id: t.id });
const label = (g: { creditor: string }, last4: string | null | undefined) => `${g.creditor}${last4 ? ` (ending ${last4})` : ''}`;

export function analyze(input: {
  tradelines: AnalysisTradeline[]; inquiries: AnalysisInquiry[]; publicRecords: AnalysisPublicRecord[]; identity: AnalysisIdentity[];
  clientName?: string; clientAddress?: string; now?: Date;
}): Finding[] {
  const now = input.now ?? new Date();
  const today = now.toISOString().slice(0, 10);
  const findings: Finding[] = [];
  const add = (f: Finding) => findings.push(f);
  const groups = groupAccounts(input.tradelines);
  const bureausWithData = new Set(input.tradelines.map((t) => t.bureau));

  for (const g of groups) {
    const present = BUREAUS.filter((b) => g.byBureau[b]);
    const any = g.byBureau[present[0]!]!;
    const ids = present.map((b) => g.byBureau[b]!.id);
    const name = label(g, any.account_last4);

    for (const d of diffGroup(g)) {
      const cat: FindingCategory | null = d.field === 'balance_cents' ? 'balance_mismatch' : d.field === 'account_status' || d.field === 'payment_status' ? 'status_mismatch'
        : d.field === 'date_opened' ? 'date_mismatch' : d.field === 'date_of_first_delinquency' ? 'dofd_mismatch' : null;
      if (!cat) continue;
      // Re-aging check: only when the account is identified by its number (the exact match key), never by the creditor-and-open-date fallback.
      if (cat === 'dofd_mismatch' && !any.account_last4) continue;
      const reportedOn = present.map((b) => `${BUREAU_LABEL[b]}: ${g.byBureau[b]!.date_reported ?? 'date not shown'}`).join('; ');
      add({
        dedupe_key: `${cat}:${g.key}:${d.field}`, category: cat, severity: cat === 'balance_mismatch' ? 'info' : 'review',
        title: `${d.label} differs for ${name}`,
        explanation: `${(Object.entries(d.values) as [Bureau, string][]).map(([b, v]) => `${BUREAU_LABEL[b]} shows ${v}`).join(', ')}. ${d.field === 'balance_cents' ? `Balances can legitimately differ when bureaus received data on different dates (${reportedOn}). ` : ''}${cat === 'dofd_mismatch' ? `${DOFD_NOTE} ` : ''}${NOTE}`,
        evidence: (Object.entries(d.values) as [Bureau, string][]).map(([b, v]) => rep(g.byBureau[b]!, d.label, v)),
        basis: 'potential_discrepancy', tradeline_ids: ids,
      });
    }

    if (bureausWithData.size >= 2 && present.length < bureausWithData.size) {
      const missing = [...bureausWithData].filter((b) => !g.byBureau[b]);
      add({
        dedupe_key: `missing:${g.key}`, category: 'missing_on_bureau', severity: 'info',
        title: `${name} is not on ${missing.map((b) => BUREAU_LABEL[b]).join(' / ')}`,
        explanation: `Reported by ${present.map((b) => BUREAU_LABEL[b]).join(', ')} but not by ${missing.map((b) => BUREAU_LABEL[b]).join(', ')}. Creditors are not required to report to every bureau, so this is informational — it matters mainly if the client expected the account to appear (or not appear) somewhere.`,
        evidence: present.map((b) => rep(g.byBureau[b]!, 'Reported', 'yes')), basis: 'verified_fact', tradeline_ids: ids,
      });
    }

    for (const b of present) {
      const t = g.byBureau[b]!;
      if (isNegative(t)) {
        // Past the reporting period only once the computed date has passed: 7 years, counted from 180 days after the
        // date of first delinquency for a collection or charge-off (15 U.S.C. § 1681c(a)(4), (c)(1)).
        const off = tradelineFallOff(t);
        const age = t.date_of_first_delinquency ? yearsSince(t.date_of_first_delinquency, now) : null;
        const printed = printedRemovalMonth(t);
        if (off?.kind === 'date' && age != null && off.date < today) {
          // A collection or a charge-off ages off as a whole. An account that is only late does not: what has aged is
          // the late payment information from that date, and the account keeps being reported (§ 1681c(a)(5)).
          const pastWhat = off.rule === 'seven_years'
            ? 'the late payment information from that date may be past its reporting period, while the account itself keeps being reported'
            : 'the item may be past the reporting period';
          add({
            dedupe_key: `obsolete:${t.id}`, category: 'obsolete_item', severity: 'strong',
            title: `${name} on ${BUREAU_LABEL[b]} has a first-delinquency date over 7 years ago`,
            explanation: `${BUREAU_LABEL[b]} reports a date of first delinquency of ${t.date_of_first_delinquency} (${age.toFixed(1)} years ago). The reporting period for negative information of this kind is generally ${FALL_OFF_RULE_TEXT[off.rule]} (15 U.S.C. § 1681c), which works out to ${off.date}. Confirm the date is correct before disputing — if it is accurate, ${pastWhat}; if it was re-aged, the date itself may be the issue.`,
            evidence: [rep(t, 'Date of first delinquency', t.date_of_first_delinquency!), { field: 'Age at report review', value: `${age.toFixed(1)} years`, source: 'derived' }, { field: 'Reporting period generally ends', value: off.date, source: 'derived' }],
            basis: 'potential_discrepancy', tradeline_ids: [t.id],
          });
        } else if (printed && t.date_reported && printed < t.date_reported.slice(0, 7)) {
          // The bureau's own estimate, set against its own "updated" date on the same account: both as printed.
          add({
            dedupe_key: `removal:${t.id}`, category: 'removal_month_passed', severity: 'strong',
            title: `${name} on ${BUREAU_LABEL[b]} was still reported after the removal month the report prints`,
            explanation: `${BUREAU_LABEL[b]} prints an estimated removal month of ${sayMonth(printed)} for this account, and shows the account as updated on ${t.date_reported}, after that month. Check both against the original report before disputing. If they are as printed, ask ${BUREAU_LABEL[b]} to review why the item is still reported. ${NOTE}`,
            evidence: [rep(t, 'Estimated removal month, as printed', sayMonth(printed)), rep(t, 'Date updated', t.date_reported)],
            basis: 'potential_discrepancy', tradeline_ids: [t.id],
          });
        } else if (t.item_type === 'collection' && !t.date_of_first_delinquency && !printed) {
          // (Not said of an account whose report prints a removal month instead: that layout has no such date to show.)
          add({
            dedupe_key: `dofd:${t.id}`, category: 'dofd_mismatch', severity: 'review', title: `${name} on ${BUREAU_LABEL[b]} shows no date of first delinquency`,
            explanation: 'Collection accounts normally report a date of first delinquency, which controls how long the item may remain. It is not shown here — worth asking the furnisher to verify it.',
            evidence: [rep(t, 'Date of first delinquency', 'not reported')], basis: 'verified_fact', tradeline_ids: [t.id],
          });
        }
      }
      if (t.item_type !== 'collection' && isNegative(t)) {
        const chargedOff = /charge[ds]?[ -]?off|charged off/i.test(`${t.account_status ?? ''} ${t.payment_status ?? ''}`);
        const what = chargedOff ? 'a charge-off' : 'late payments';
        add({
          dedupe_key: `negative:${t.id}`, category: 'negative_item', severity: chargedOff ? 'strong' : 'review',
          title: `${name} on ${BUREAU_LABEL[b]} reports ${what}`,
          explanation: `${BUREAU_LABEL[b]} reports ${what} on this account. Check every late month and amount against the client’s statements: a late payment that the records show was on time, a wrong date or amount, or a missing dispute notation is a reason to dispute. If the reporting is accurate, a goodwill request to the creditor is the usual next step.`,
          evidence: [
            ...(t.payment_status ? [rep(t, 'Payment status', t.payment_status)] : []),
            ...(t.account_status ? [rep(t, 'Account status', t.account_status)] : []),
            ...(t.payment_history ? [rep(t, 'Payment history', t.payment_history)] : []),
            ...(t.balance_cents != null ? [rep(t, 'Balance', money(t.balance_cents))] : []),
          ],
          basis: 'verified_fact', tradeline_ids: [t.id],
        });
      }
      if (t.item_type === 'collection') {
        // Whether the report names the original creditor is part of what the finding rests on: the validation letter
        // asks the collector for that name and address either way (FDCPA § 809(a)(5), (b)).
        const oc = t.original_creditor?.trim();
        add({
          dedupe_key: `collection:${t.id}`, category: 'collection_validation', severity: 'strong',
          title: `${name} is a collection account on ${BUREAU_LABEL[b]}`,
          explanation: `A written validation request to the collector (FDCPA § 809(b)) is a standard first step; it must be sent within 30 days of the collector’s first written notice to preserve the right to dispute that way. Check the date of that notice with the client.${oc ? '' : ` ${BUREAU_LABEL[b]} does not name the original creditor for this account; the validation request asks the collector for it.`}`,
          evidence: [rep(t, 'Account type', 'Collection'), ...(t.balance_cents != null ? [rep(t, 'Balance', money(t.balance_cents))] : []), rep(t, 'Original creditor', oc || 'not shown')], basis: 'verified_fact', tradeline_ids: [t.id],
        });
      }
      // One bureau's own entry that does not agree with itself: reported as paid, settled, sold or transferred, and
      // still carrying a balance. Both values are shown as reported; which one is out of date is for a person to check.
      const settled = (t.balance_cents ?? 0) > 0 ? settledWording(t) : null;
      if (settled) {
        add({
          dedupe_key: `status-balance:${t.id}`, category: 'status_balance_conflict', severity: 'review',
          title: `${name} on ${BUREAU_LABEL[b]} is reported as “${settled.slice(0, 60)}” with a balance of ${money(t.balance_cents)}`,
          explanation: `${BUREAU_LABEL[b]} reports this account as “${settled}” and also reports a balance of ${money(t.balance_cents)}. An account that was paid, settled, sold or transferred to another lender normally reports a zero balance, so one of the two may be out of date. Check the client’s records (a payoff letter, a final statement, a notice that the account was sold) before disputing. ${NOTE}`,
          evidence: [rep(t, t.account_status?.trim() === settled ? 'Account status' : 'Payment status', settled), rep(t, 'Balance', money(t.balance_cents))],
          basis: 'potential_discrepancy', tradeline_ids: [t.id],
        });
      }
      // Client assertions are kept distinct from reported facts. The two share a category; the start of the key says
      // which statement it is, and the dispute each one starts is chosen by it (disputes/workflow.ts categoryForFinding).
      const up = t.user_provided ?? {};
      if (up.not_mine === true) {
        add({
          dedupe_key: `client-not-mine:${t.id}`, category: 'client_statement', severity: 'review', title: `Client does not recognise ${name} (${BUREAU_LABEL[b]})`,
          explanation: 'The client told us they do not recognise this account. Gather what they remember (when they last saw it, any related mail) before disputing. This product will not assert identity theft unless the client provides an identity theft report.',
          evidence: [{ field: 'Client statement', value: 'Does not recognise this account', source: 'client', tradeline_id: t.id }, rep(t, 'Creditor', t.creditor_name)], basis: 'user_provided', tradeline_ids: [t.id],
        });
      }
      if (up.never_late === true && t.payment_history && historyShowsLate(t.payment_history)) {
        add({
          dedupe_key: `client-never-late:${t.id}`, category: 'client_statement', severity: 'review', title: `Client says payments were never late — ${name} (${BUREAU_LABEL[b]})`,
          explanation: 'The report’s payment history includes late-payment codes, but the client states every payment was on time. Ask the client for statements or bank records for the months in question.',
          evidence: [{ field: 'Client statement', value: 'Payments were always on time', source: 'client', tradeline_id: t.id }, rep(t, 'Payment history', t.payment_history)], basis: 'user_provided', tradeline_ids: [t.id],
        });
      }
    }
  }

  // Duplicates within one bureau: collector + original creditor both carrying a balance, or the same account twice.
  for (const b of BUREAUS) {
    const own = input.tradelines.filter((t) => t.bureau === b);
    for (const c of own.filter((t) => t.item_type === 'collection' && t.original_creditor)) {
      const oc = normCreditor(c.original_creditor!);
      const twin = own.find((t) => t.id !== c.id && t.item_type === 'tradeline' && normCreditor(t.creditor_name) === oc && (t.balance_cents ?? 0) > 0);
      if (twin && (c.balance_cents ?? 0) > 0) {
        add({
          dedupe_key: `dup-oc:${c.id}:${twin.id}`, category: 'duplicate_account', severity: 'review',
          title: `${BUREAU_LABEL[b]}: ${c.creditor_name} and ${twin.creditor_name} may be reporting the same debt`,
          explanation: `The collector lists ${twin.creditor_name} as the original creditor, and ${twin.creditor_name} also reports an account with a balance. A debt can be sold and reported by the buyer, but the original creditor should then show a zero balance. ${NOTE}`,
          evidence: [rep(c, 'Collector balance', money(c.balance_cents)), rep(twin, 'Original creditor balance', money(twin.balance_cents)), rep(c, 'Original creditor named', c.original_creditor!)],
          basis: 'potential_discrepancy', tradeline_ids: [c.id, twin.id],
        });
      }
    }
    // Re-aging check: a collection whose date of first delinquency is LATER than the one on the original creditor's
    // account. Only when both dates are reported and exactly one account from that creditor could be the original.
    for (const c of own.filter((t) => t.item_type === 'collection' && t.original_creditor && t.date_of_first_delinquency)) {
      const oc = normCreditor(c.original_creditor!);
      const originals = oc ? own.filter((t) => t.id !== c.id && t.item_type === 'tradeline' && normCreditor(t.creditor_name) === oc) : [];
      const orig = originals.length === 1 ? originals[0]! : null;
      if (!orig?.date_of_first_delinquency || c.date_of_first_delinquency! <= orig.date_of_first_delinquency) continue;
      add({
        dedupe_key: `reage-oc:${b}:${normCreditor(c.creditor_name)}|${c.account_last4 ?? ''}:${oc}|${orig.account_last4 ?? ''}`, category: 'dofd_mismatch', severity: 'review',
        title: `${BUREAU_LABEL[b]}: ${c.creditor_name} shows a later date of first delinquency than ${orig.creditor_name}`,
        explanation: `The collection account reports a date of first delinquency of ${c.date_of_first_delinquency}. ${orig.creditor_name}, which it names as the original creditor, reports ${orig.date_of_first_delinquency}. ${DOFD_NOTE} ${NOTE}`,
        evidence: [rep(c, 'Date of first delinquency (collection)', c.date_of_first_delinquency!), rep(orig, 'Date of first delinquency (original creditor)', orig.date_of_first_delinquency), rep(c, 'Original creditor named', c.original_creditor!)],
        basis: 'potential_discrepancy', tradeline_ids: [c.id, orig.id],
      });
    }
    const seen = new Map<string, AnalysisTradeline>();
    for (const t of own) {
      const sig = `${normCreditor(t.creditor_name)}|${t.balance_cents}|${t.date_opened}`;
      const prev = seen.get(sig);
      if (prev && prev.account_last4 !== t.account_last4 && t.date_opened && t.balance_cents != null) {
        add({
          dedupe_key: `dup-same:${[prev.id, t.id].sort().join(':')}`, category: 'duplicate_account', severity: 'review',
          title: `${BUREAU_LABEL[b]}: two ${t.creditor_name} entries look alike`,
          explanation: `Two entries share a creditor, balance (${money(t.balance_cents)}) and open date (${t.date_opened}) but have different account numbers. They may be separate accounts or one account listed twice. ${NOTE}`,
          evidence: [rep(prev, 'Account ending', prev.account_last4 ?? '—'), rep(t, 'Account ending', t.account_last4 ?? '—')], basis: 'potential_discrepancy', tradeline_ids: [prev.id, t.id],
        });
      }
      seen.set(sig, t);
    }
  }

  for (const q of input.inquiries) {
    if (q.kind === 'hard' && q.inquiry_date && yearsSince(q.inquiry_date, now) > 2) {
      add({
        dedupe_key: `inquiry:${q.id}`, category: 'old_inquiry', severity: 'review', title: `${q.name} inquiry (${q.inquiry_date}) is older than two years`,
        explanation: `${BUREAU_LABEL[q.bureau]} still lists this hard inquiry. Hard inquiries are generally reported for two years. Confirm the date, then consider asking the bureau to review it.`,
        evidence: [{ bureau: q.bureau, field: 'Inquiry date', value: q.inquiry_date, source: 'reported' }, { field: 'Age', value: `${yearsSince(q.inquiry_date, now).toFixed(1)} years`, source: 'derived' }],
        basis: 'potential_discrepancy', tradeline_ids: [],
      });
    }
  }

  for (const r of input.publicRecords) {
    const limit = /bankruptcy/i.test(r.kind) ? 10 : 7;
    if (r.filed_date && yearsSince(r.filed_date, now) > limit) {
      add({
        dedupe_key: `pr:${r.id}`, category: 'obsolete_item', severity: 'strong', title: `${BUREAU_LABEL[r.bureau]}: ${r.kind} filed ${r.filed_date} is older than ${limit} years`,
        explanation: `Public records of this type are generally reportable for about ${limit} years from filing (FCRA § 605). Confirm the filing date before asking the bureau to review it.`,
        evidence: [{ bureau: r.bureau, field: 'Date filed', value: r.filed_date, source: 'reported' }], basis: 'potential_discrepancy', tradeline_ids: [],
      });
    }
  }

  // Personal information: values reported by some bureaus but not others, or not matching the client's profile.
  const idBureaus = new Set(input.identity.map((i) => i.bureau));
  for (const kind of ['name', 'address', 'employer'] as const) {
    const items = input.identity.filter((i) => i.kind === kind);
    const norm = (v: string) => (kind === 'address' ? normAddress(v) : normText(v));
    const byValue = new Map<string, { display: string; bureaus: Set<Bureau> }>();
    for (const i of items) {
      const k = norm(i.value);
      const e = byValue.get(k) ?? { display: i.value, bureaus: new Set<Bureau>() };
      e.bureaus.add(i.bureau);
      byValue.set(k, e);
    }
    const mine = kind === 'name' ? normText(input.clientName ?? '') : kind === 'address' ? normAddress(input.clientAddress ?? '') : '';
    for (const [k, e] of byValue) {
      const onAll = e.bureaus.size === idBureaus.size && idBureaus.size > 1;
      const matchesClient = mine && (kind === 'name' ? mine.split(' ').every((w) => k.includes(w)) : k.includes(mine) || mine.includes(k));
      if (onAll || matchesClient || kind === 'employer' && e.bureaus.size === idBureaus.size) continue;
      const where = [...e.bureaus].map((b) => BUREAU_LABEL[b]).join(' / ');
      add({
        dedupe_key: `identity:${kind}:${k}`, category: 'personal_info', severity: 'info', title: `${kind === 'name' ? 'Name' : kind === 'address' ? 'Address' : 'Employer'} “${e.display}” appears on ${where} only`,
        explanation: `${mine ? 'It does not match the client’s profile, and ' : ''}other bureaus do not list it. It may be a former ${kind}, a variation, or a mistake — ask the client whether it is theirs, then correct or remove it if not.`,
        evidence: [...e.bureaus].map((b) => ({ bureau: b, field: kind, value: e.display, source: 'reported' as const })), basis: 'potential_discrepancy', tradeline_ids: [],
      });
    }
  }
  return findings;
}

export const SEVERITY_ORDER = { strong: 0, review: 1, info: 2 } as const;

/**
 * How far the stored flags are behind what the approved reports say now: flags the analysis would raise that are not
 * stored yet, plus stored suggestions it no longer raises. A flag a person has reviewed (kept, dismissed, disputed) is
 * never counted as stale, and nor is one another check made (reinsertion, medical, bankruptcy): only the rules' own
 * open suggestions are compared, the same rows regenerating would replace.
 */
export function flagsBehind(fresh: Iterable<string>, stored: { dedupe_key: string; status: string; generated_by: string }[]): number {
  const now = new Set(fresh);
  const have = new Set(stored.map((f) => f.dedupe_key));
  const missing = [...now].filter((k) => !have.has(k)).length;
  const gone = stored.filter((f) => f.status === 'suggested' && f.generated_by === 'rules' && !now.has(f.dedupe_key)).length;
  return missing + gone;
}
