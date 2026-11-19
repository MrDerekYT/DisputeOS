import { BUREAU_LABEL, BUREAUS, money, type Bureau } from '../util';

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
}
export interface AnalysisInquiry { id: string; bureau: Bureau; name: string; inquiry_date: string | null; kind: string }
export interface AnalysisPublicRecord { id: string; bureau: Bureau; kind: string; filed_date: string | null; status: string | null }
export interface AnalysisIdentity { bureau: Bureau; kind: 'name' | 'address' | 'employer'; value: string }

export interface Evidence { bureau?: Bureau; field: string; value: string; source: 'reported' | 'client' | 'derived'; tradeline_id?: string }
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
  old_inquiry: 'Older inquiry',
  client_statement: 'Client statement conflicts with report',
} as const;
export type FindingCategory = keyof typeof FINDING_CATEGORIES;

const NOISE = new Set(['bank', 'na', 'n', 'a', 'usa', 'us', 'llc', 'inc', 'corp', 'co', 'company', 'services', 'service', 'financial', 'finance', 'card', 'cards', 'credit', 'the', 'of', 'ltd', 'lp']);
export const normCreditor = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((w) => w && !NOISE.has(w)).join(' ');

const normText = (s: string | null) => (s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const ABBR: [RegExp, string][] = [[/\bstreet\b/g, 'st'], [/\bavenue\b/g, 'ave'], [/\bapartment\b/g, 'apt'], [/\broad\b/g, 'rd'], [/\bdrive\b/g, 'dr'], [/\bboulevard\b/g, 'blvd'], [/\blane\b/g, 'ln'], [/\bnorth\b/g, 'n'], [/\bsouth\b/g, 's'], [/\beast\b/g, 'e'], [/\bwest\b/g, 'w']];
const normAddress = (s: string) => ABBR.reduce((a, [re, r]) => a.replace(re, r), normText(s));

export interface AccountGroup {
  key: string; creditor: string; itemType: 'tradeline' | 'collection'; byBureau: Partial<Record<Bureau, AnalysisTradeline>>; bureauCount: number;
}

/** Same account across bureaus: normalised creditor + last 4 (falls back to creditor + open date when last 4 is absent). */
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
  return [...groups.values()].sort((a, b) => a.creditor.localeCompare(b.creditor));
}

export interface FieldDiff { field: keyof AnalysisTradeline; label: string; values: Partial<Record<Bureau, string>> }
const DIFF_FIELDS: { field: keyof AnalysisTradeline; label: string; fmt: (t: AnalysisTradeline) => string | null }[] = [
  { field: 'balance_cents', label: 'Balance', fmt: (t) => (t.balance_cents == null ? null : money(t.balance_cents)) },
  { field: 'account_status', label: 'Account status', fmt: (t) => t.account_status },
  { field: 'payment_status', label: 'Payment status', fmt: (t) => t.payment_status },
  { field: 'date_opened', label: 'Date opened', fmt: (t) => t.date_opened },
  { field: 'date_of_first_delinquency', label: 'Date of first delinquency', fmt: (t) => t.date_of_first_delinquency },
  { field: 'credit_limit_cents', label: 'Credit limit', fmt: (t) => (t.credit_limit_cents == null ? null : money(t.credit_limit_cents)) },
];

/** Fields that have a value on at least two bureaus where the values are not all equal. */
export function diffGroup(g: AccountGroup): FieldDiff[] {
  const out: FieldDiff[] = [];
  for (const f of DIFF_FIELDS) {
    const vals: Partial<Record<Bureau, string>> = {};
    for (const b of BUREAUS) { const t = g.byBureau[b]; const v = t ? f.fmt(t) : null; if (v) vals[b] = v; }
    const distinct = new Set(Object.values(vals).map((v) => normText(v)));
    if (Object.keys(vals).length >= 2 && distinct.size > 1) out.push({ field: f.field, label: f.label, values: vals });
  }
  return out;
}

const yearsSince = (iso: string, now: Date) => (now.getTime() - new Date(`${iso}T00:00:00Z`).getTime()) / (365.25 * 86_400_000);
const LATE = /\b(30|60|90|120|150|180)\b|late|delinq|charge.?off|collection|repo|foreclos|derog|past due/i;
const isNegative = (t: AnalysisTradeline) => t.item_type === 'collection' || LATE.test(`${t.payment_status ?? ''} ${t.account_status ?? ''}`) || /[3-9]0|CO|\bC\.O\./.test(t.payment_history?.replace(/C/g, '') ?? '');
const NOTE = 'This is a difference to investigate, not a conclusion that anything is inaccurate.';
const rep = (t: AnalysisTradeline, field: string, value: string): Evidence => ({ bureau: t.bureau, field, value, source: 'reported', tradeline_id: t.id });
const label = (g: { creditor: string }, last4: string | null | undefined) => `${g.creditor}${last4 ? ` (ending ${last4})` : ''}`;

export function analyze(input: {
  tradelines: AnalysisTradeline[]; inquiries: AnalysisInquiry[]; publicRecords: AnalysisPublicRecord[]; identity: AnalysisIdentity[];
  clientName?: string; clientAddress?: string; now?: Date;
}): Finding[] {
  const now = input.now ?? new Date();
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
      const reportedOn = present.map((b) => `${BUREAU_LABEL[b]}: ${g.byBureau[b]!.date_reported ?? 'date not shown'}`).join('; ');
      add({
        dedupe_key: `${cat}:${g.key}:${d.field}`, category: cat, severity: cat === 'balance_mismatch' ? 'info' : 'review',
        title: `${d.label} differs for ${name}`,
        explanation: `${(Object.entries(d.values) as [Bureau, string][]).map(([b, v]) => `${BUREAU_LABEL[b]} shows ${v}`).join(', ')}. ${d.field === 'balance_cents' ? `Balances can legitimately differ when bureaus received data on different dates (${reportedOn}). ` : ''}${NOTE}`,
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
        const age = t.date_of_first_delinquency ? yearsSince(t.date_of_first_delinquency, now) : null;
        if (age != null && age > 7) {
          add({
            dedupe_key: `obsolete:${t.id}`, category: 'obsolete_item', severity: 'strong',
            title: `${name} on ${BUREAU_LABEL[b]} has a first-delinquency date over 7 years ago`,
            explanation: `${BUREAU_LABEL[b]} reports a date of first delinquency of ${t.date_of_first_delinquency} (${age.toFixed(1)} years ago). Negative information generally stops being reportable 7 years after the date of first delinquency (FCRA § 605). Confirm the date is correct before disputing — if it is accurate, the item may be past the reporting period; if it was re-aged, the date itself may be the issue.`,
            evidence: [rep(t, 'Date of first delinquency', t.date_of_first_delinquency!), { field: 'Age at report review', value: `${age.toFixed(1)} years`, source: 'derived' }],
            basis: 'potential_discrepancy', tradeline_ids: [t.id],
          });
        } else if (t.item_type === 'collection' && !t.date_of_first_delinquency) {
          add({
            dedupe_key: `dofd:${t.id}`, category: 'dofd_mismatch', severity: 'review', title: `${name} on ${BUREAU_LABEL[b]} shows no date of first delinquency`,
            explanation: 'Collection accounts normally report a date of first delinquency, which controls how long the item may remain. It is not shown here — worth asking the furnisher to verify it.',
            evidence: [rep(t, 'Date of first delinquency', 'not reported')], basis: 'verified_fact', tradeline_ids: [t.id],
          });
        }
      }
      if (t.item_type === 'collection') {
        add({
          dedupe_key: `collection:${t.id}`, category: 'collection_validation', severity: 'info',
          title: `${name} is a collection account on ${BUREAU_LABEL[b]}`,
          explanation: 'A written validation request to the collector (FDCPA § 809(b)) is a standard first step; it must be sent within 30 days of the collector’s first written notice to preserve the right to dispute that way. Check the date of that notice with the client.',
          evidence: [rep(t, 'Account type', 'Collection'), ...(t.balance_cents != null ? [rep(t, 'Balance', money(t.balance_cents))] : [])], basis: 'verified_fact', tradeline_ids: [t.id],
        });
      }
      // Client assertions are kept distinct from reported facts.
      const up = t.user_provided ?? {};
      if (up.not_mine === true) {
        add({
          dedupe_key: `client-not-mine:${t.id}`, category: 'client_statement', severity: 'review', title: `Client does not recognise ${name} (${BUREAU_LABEL[b]})`,
          explanation: 'The client told us they do not recognise this account. Gather what they remember (when they last saw it, any related mail) before disputing. This product will not assert identity theft unless the client provides an identity theft report.',
          evidence: [{ field: 'Client statement', value: 'Does not recognise this account', source: 'client', tradeline_id: t.id }, rep(t, 'Creditor', t.creditor_name)], basis: 'user_provided', tradeline_ids: [t.id],
        });
      }
      if (up.never_late === true && t.payment_history && /(30|60|90|120)/.test(t.payment_history)) {
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
