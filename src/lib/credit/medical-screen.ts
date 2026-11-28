/**
 * Medical collection screen: which reported medical collections fall under the three nationwide bureaus' own
 * announced reporting changes. Pure; nothing here says an item must come off a report.
 *
 * What is being compared against is VOLUNTARY BUREAU POLICY, NOT LAW:
 *  - Equifax, Experian and TransUnion, joint statement of March 18, 2022: from July 1, 2022 paid medical collection
 *    debt is no longer included on consumer credit reports, and the time before unpaid medical collection debt
 *    appears was increased from six months to one year.
 *  - Joint statement of April 11, 2023: medical collection debt with an initial reported balance of under $500 has
 *    been removed from consumer credit reports.
 *  (Both read on the bureaus' own newsrooms, November 2026: investor.equifax.com, newsroom.transunion.com.)
 *
 * The CFPB's January 2025 rule that would have kept medical debt off reports used by lenders is NOT in effect: on
 * July 11, 2025 the U.S. District Court for the Eastern District of Texas vacated it (Cornerstone Credit Union League
 * v. CFPB, 4:25-cv-00016), as the CFPB's own page for the rule states. State laws differ and are not modelled.
 *
 * So a finding here is a reason to check the dates and amounts against the client's records and, where they hold,
 * to ask the bureau to review the item. It is never a statement that the item is being reported unlawfully.
 */
import type { Evidence } from '../reports/analysis';
import { BUREAU_LABEL, money, type Bureau } from '../util';
import { isCollectorAccount, MEDICAL_WORDS } from './account-kind';
import { addYearsIso } from './reporting-period';

export const MEDICAL_CATEGORY = 'medical_collection';
export const MEDICAL_UNDER_CENTS = 500_00;
export const MEDICAL_POLICY_SOURCE = 'Equifax, Experian and TransUnion joint statements of March 18, 2022 and April 11, 2023';

export interface MedicalLine {
  id: string; bureau: Bureau; item_type: string; creditor_name: string; original_creditor: string | null; account_last4: string | null;
  account_type: string | null; account_status: string | null; payment_status: string | null; remarks: string | null;
  balance_cents: number | null; date_of_first_delinquency: string | null; match_key: string;
  /** Staff's own answer to "is this a medical debt?" (true / false), or null when nobody has said. */
  medical_flag: boolean | null;
  /** For telling a collector's account from another (./account-kind.ts isCollectorAccount). */
  payment_history?: string | null;
  kind_label?: unknown;
}

/** True when the report's own text says so: its account type, remarks or original creditor. Words: ./account-kind.ts MEDICAL_WORDS. */
export const reportSaysMedical = (t: Pick<MedicalLine, 'account_type' | 'remarks' | 'original_creditor'>): boolean =>
  MEDICAL_WORDS.test(`${t.account_type ?? ''} ${t.remarks ?? ''} ${t.original_creditor ?? ''}`) || (t.account_type ?? '').trim() === '90'; // Metro 2 account type 90: medical debt

/**
 * True when only the collector's own name says so ("VALLEY RADIOLOGY", "MEDICAL DATA SYSTEMS"). That is a guess, so it
 * is shown as a suggestion and starts nothing: no finding is made from it until staff tick the account.
 */
export const nameSaysMedical = (t: Pick<MedicalLine, 'creditor_name'>): boolean => MEDICAL_WORDS.test(t.creditor_name);

/** Staff's answer wins; otherwise what the report says; otherwise what the collector's name suggests (a suggestion only). */
export function medicalBasis(t: MedicalLine): 'staff' | 'report' | 'name' | null {
  if (t.medical_flag === true) return 'staff';
  if (t.medical_flag === false) return null;
  if (reportSaysMedical(t)) return 'report';
  return nameSaysMedical(t) ? 'name' : null;
}

const BASIS_TEXT = {
  staff: 'Staff marked this collection as a medical debt',
  report: 'The report describes this collection as medical',
} as const;

export type MedicalTest = 'paid' | 'under_500' | 'under_one_year';

/** Which of the three policy tests the reported values meet. `today` is a YYYY-MM-DD day. */
export function medicalTests(t: MedicalLine, today: string): MedicalTest[] {
  const out: MedicalTest[] = [];
  const status = `${t.account_status ?? ''} ${t.payment_status ?? ''}`;
  const paid = t.balance_cents === 0 || (/\bpaid\b/i.test(status) && !/\b(not|un)\s?paid\b/i.test(status));
  if (paid) out.push('paid');
  else if (t.balance_cents != null && t.balance_cents > 0 && t.balance_cents < MEDICAL_UNDER_CENTS) out.push('under_500');
  const oneYear = t.date_of_first_delinquency ? addYearsIso(t.date_of_first_delinquency, 1) : null;
  if (oneYear && today < oneYear) out.push('under_one_year');
  return out;
}

export interface MedicalFinding {
  dedupe_key: string; category: typeof MEDICAL_CATEGORY; severity: 'review'; basis: 'potential_discrepancy';
  title: string; explanation: string; evidence: Evidence[]; tradeline_ids: string[];
}

const TEST_TEXT: Record<MedicalTest, (t: MedicalLine) => string> = {
  paid: () => 'it is reported as paid or with a zero balance',
  under_500: (t) => `it is reported with a balance of ${money(t.balance_cents)}, under $500`,
  under_one_year: (t) => `its reported date of first delinquency (${t.date_of_first_delinquency}) is less than one year ago`,
};

/** One finding per reported medical collection that meets at least one test. Collections only; other accounts are never screened. */
export function medicalScreen(lines: MedicalLine[], today: string): MedicalFinding[] {
  const out: MedicalFinding[] = [];
  for (const t of lines) {
    if (!isCollectorAccount(t)) continue;
    const basis = medicalBasis(t);
    // A name alone is a guess: it is shown on the page for staff to confirm, and nothing is concluded from it here.
    if (!basis || basis === 'name') continue;
    const tests = medicalTests(t, today);
    if (!tests.length) continue;
    const name = `${t.creditor_name}${t.account_last4 ? ` (ending ${t.account_last4})` : ''}`;
    const bureau = BUREAU_LABEL[t.bureau];
    const rep = (field: string, value: string): Evidence => ({ bureau: t.bureau, field, value, source: 'reported', tradeline_id: t.id });
    out.push({
      // By account where the account number identifies it, so a newer report of the same account does not repeat the finding.
      dedupe_key: `medical:${t.bureau}:${/^[^|]+\|[^|]+$/.test(t.match_key) ? t.match_key : t.id}`,
      category: MEDICAL_CATEGORY, severity: 'review', basis: 'potential_discrepancy',
      title: `${name} on ${bureau}: medical collection worth checking against bureau policy`.slice(0, 200),
      explanation: `${BASIS_TEXT[basis]}, and ${tests.map((k) => TEST_TEXT[k](t)).join(', and ')}. `
        + 'The three nationwide bureaus have said they generally do not report medical collections that are paid, that had an initial reported balance under $500, or that are less than one year old '
        + `(${MEDICAL_POLICY_SOURCE}). This is the bureaus’ own policy, not a law: a federal rule on medical debt reporting was vacated by a court on July 11, 2025 and is not in effect. `
        + 'Check that the debt is medical, and check the dates and amounts against the client’s records (the policy looks at the initial balance, which may differ from the balance shown). '
        + 'If they hold, the bureau can be asked to review the item. This is a reason to look, not a conclusion that anything is reported wrongly.',
      evidence: [
        basis === 'staff' ? { field: 'Medical debt', value: 'Marked by staff', source: 'record', tradeline_id: t.id }
          : rep('Described as medical', [t.account_type, t.remarks, t.original_creditor].filter(Boolean).join(' · ').slice(0, 200)),
        ...(t.balance_cents != null ? [rep('Balance', money(t.balance_cents))] : []),
        ...(t.account_status || t.payment_status ? [rep('Status', [t.account_status, t.payment_status].filter(Boolean).join(' / '))] : []),
        ...(t.date_of_first_delinquency ? [rep('Date of first delinquency', t.date_of_first_delinquency)] : []),
        { field: 'Compared on', value: today, source: 'derived' },
      ],
      tradeline_ids: [t.id],
    });
  }
  return out;
}
