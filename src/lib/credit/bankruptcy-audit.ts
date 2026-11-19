/**
 * Bankruptcy discharge audit: for a client whose bankruptcy staff recorded (chapter, filing date, discharge date),
 * how each account that predates the filing is reported by each bureau. Pure. No court record is read, and nothing
 * here says an account was included in the bankruptcy or that anything is reported wrongly: only the debtor's
 * schedules and the discharge order show what was discharged.
 *
 * The general expectation these checks rest on: furnishers must report accurately and correct what they know is not
 * (15 U.S.C. § 1681s-2(a)), and CFPB examiners have repeatedly cited furnishers for "continuing to report accounts
 * that had been discharged in bankruptcy" and for not updating charged-off balances after a discharge (CFPB
 * Supervisory Highlights, Issue 37, Winter 2024, "Furnishing"; Issue 20, Fall 2019, § 2.3). An account discharged in
 * bankruptcy is generally expected to show a zero balance and a status that reflects the bankruptcy, with no new
 * delinquency dated after the filing. Debts that are generally not discharged (most student loans, support
 * obligations, many taxes) and debts the client reaffirmed or kept paying are legitimately reported otherwise, which
 * is why every result is "worth checking".
 *
 * Reporting period of the bankruptcy itself: 15 U.S.C. § 1681c(a)(1) generally allows a case under title 11 to be
 * reported for 10 years and makes no chapter distinction. Experian and TransUnion say on their own sites (read
 * November 2026) that they remove a Chapter 13 bankruptcy seven years after the filing date: that is bureau policy,
 * not the statute, and is labelled so.
 */
import type { Evidence } from '../reports/analysis';
import { BUREAU_LABEL, money, type Bureau } from '../util';
import { addYearsIso, BANKRUPTCY_YEARS, isNegative, SEVEN_YEARS } from './reporting-period';

export const BANKRUPTCY_CATEGORY = 'bankruptcy_reporting';
export const BANKRUPTCY_CHAPTERS = ['7', '13'] as const;
export type BankruptcyChapter = (typeof BANKRUPTCY_CHAPTERS)[number];

export interface Bankruptcy { chapter: BankruptcyChapter; filedOn: string; dischargedOn: string | null }

export interface BankruptcyLine {
  id: string; bureau: Bureau; item_type: string; creditor_name: string; account_last4: string | null;
  account_status: string | null; payment_status: string | null; payment_history: string | null; remarks: string | null;
  balance_cents: number | null; date_opened: string | null; date_of_first_delinquency: string | null; match_key: string;
}

/** Until when the bankruptcy itself is generally reportable. `policy` is the earlier date two bureaus publish for Chapter 13. */
export function bankruptcyFallOff(b: Pick<Bankruptcy, 'chapter' | 'filedOn'>): { statute: string; policy: string | null } | null {
  const statute = addYearsIso(b.filedOn, BANKRUPTCY_YEARS);
  if (!statute) return null;
  return { statute, policy: b.chapter === '13' ? addYearsIso(b.filedOn, SEVEN_YEARS) : null };
}

const SHOWS_BANKRUPTCY = /bankrupt|discharg|chapter\s*(7|11|12|13)\b|\bbk\b|included in/i;

export type AuditNote = 'balance' | 'status' | 'delinquency_after_filing';
export interface AuditRow {
  line: BankruptcyLine;
  /** 'checked': the account carries negative information or mentions the bankruptcy. 'not_checked': reported as an ordinary account in good standing, so it may simply not have been part of the bankruptcy. */
  result: 'checked' | 'not_checked';
  notes: AuditNote[];
}

/**
 * Accounts that predate the filing: opened before it, or a collection whose first delinquency is before it (a
 * collection's own "opened" date is when the collector received it). Accounts with no usable date are left out
 * rather than guessed at. Per-account checks run only once a discharge date is recorded.
 *
 * "Late after the filing" is tested with the one dated lateness a report states, the date of first delinquency;
 * the month-by-month payment history is stored without dates and is not used.
 */
export function auditAccounts(b: Bankruptcy, lines: BankruptcyLine[]): AuditRow[] {
  if (!b.dischargedOn) return [];
  const rows: AuditRow[] = [];
  for (const t of lines) {
    const predates = (t.date_opened != null && t.date_opened < b.filedOn)
      || (t.item_type === 'collection' && t.date_of_first_delinquency != null && t.date_of_first_delinquency < b.filedOn);
    if (!predates) continue;
    const shows = SHOWS_BANKRUPTCY.test(`${t.account_status ?? ''} ${t.payment_status ?? ''} ${t.remarks ?? ''}`);
    if (!shows && !isNegative(t)) { rows.push({ line: t, result: 'not_checked', notes: [] }); continue; }
    const notes: AuditNote[] = [];
    if (t.balance_cents != null && t.balance_cents > 0) notes.push('balance');
    if (!shows) notes.push('status');
    if (t.date_of_first_delinquency != null && t.date_of_first_delinquency > b.filedOn) notes.push('delinquency_after_filing');
    rows.push({ line: t, result: 'checked', notes });
  }
  return rows.sort((x, y) => x.line.creditor_name.localeCompare(y.line.creditor_name) || x.line.bureau.localeCompare(y.line.bureau));
}

export const AUDIT_NOTE_TEXT: Record<AuditNote, (t: BankruptcyLine) => string> = {
  balance: (t) => `reports a balance of ${money(t.balance_cents)}`,
  status: (t) => `shows a status of “${[t.account_status, t.payment_status].filter(Boolean).join(' / ') || 'not shown'}” with no mention of the bankruptcy`,
  delinquency_after_filing: (t) => `reports a date of first delinquency of ${t.date_of_first_delinquency}, after the filing date`,
};

export interface BankruptcyFinding {
  dedupe_key: string; category: typeof BANKRUPTCY_CATEGORY; severity: 'review'; basis: 'potential_discrepancy';
  title: string; explanation: string; evidence: Evidence[]; tradeline_ids: string[];
}

/** One "worth checking" finding per reported account that has at least one note. */
export function bankruptcyFindings(b: Bankruptcy, lines: BankruptcyLine[]): BankruptcyFinding[] {
  return auditAccounts(b, lines).filter((r) => r.notes.length > 0).map(({ line: t, notes }) => {
    const name = `${t.creditor_name}${t.account_last4 ? ` (ending ${t.account_last4})` : ''}`;
    const bureau = BUREAU_LABEL[t.bureau];
    const rep = (field: string, value: string): Evidence => ({ bureau: t.bureau, field, value, source: 'reported', tradeline_id: t.id });
    return {
      dedupe_key: `bankruptcy:${t.bureau}:${/^[^|]+\|[^|]+$/.test(t.match_key) ? t.match_key : t.id}`,
      category: BANKRUPTCY_CATEGORY, severity: 'review' as const, basis: 'potential_discrepancy' as const,
      title: `${name} on ${bureau}: worth checking against the bankruptcy discharge`.slice(0, 200),
      explanation: `The client’s Chapter ${b.chapter} bankruptcy was recorded as filed on ${b.filedOn} and discharged on ${b.dischargedOn}. This account predates the filing, and ${bureau} ${notes.map((k) => AUDIT_NOTE_TEXT[k](t)).join(', and ')}. `
        + 'An account that was discharged in bankruptcy is generally expected to show a zero balance and a status that reflects the bankruptcy, with no new delinquency after the filing; CFPB examiners have cited furnishers for continuing to report discharged accounts (Supervisory Highlights, Issue 37, Winter 2024). '
        + 'First confirm with the client’s bankruptcy papers that this debt was included and discharged: some debts generally are not (most student loans, support obligations, many taxes), and a debt the client reaffirmed or kept paying is reported differently. '
        + 'This states what the report shows; it is not a conclusion that anything is reported wrongly.',
      evidence: [
        { field: 'Bankruptcy', value: `Chapter ${b.chapter}, filed ${b.filedOn}, discharged ${b.dischargedOn}`, source: 'record' as const },
        ...(t.date_opened ? [rep('Date opened', t.date_opened)] : []),
        ...(t.balance_cents != null ? [rep('Balance', money(t.balance_cents))] : []),
        rep('Status', [t.account_status, t.payment_status].filter(Boolean).join(' / ') || 'not shown'),
        ...(t.remarks ? [rep('Remarks', t.remarks)] : []),
        ...(t.date_of_first_delinquency ? [rep('Date of first delinquency', t.date_of_first_delinquency)] : []),
      ],
      tradeline_ids: [t.id],
    };
  });
}
