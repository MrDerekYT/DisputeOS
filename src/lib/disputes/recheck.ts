/**
 * Compares a disputed account with the same account on a NEWER approved report from the same bureau.
 * It only reports what the newer report shows. It never records an outcome: a person reads the result,
 * checks it against any letter received, and records the response themselves.
 */
export interface ReportedAccount { matchKey: string; balanceCents: number | null; accountStatus: string | null; paymentStatus: string | null; dateOfFirstDelinquency: string | null }
export type Recheck =
  | { kind: 'no_newer_report' }
  | { kind: 'not_on_newer_report'; reportDate: string | null }
  | { kind: 'changed'; reportDate: string | null; changes: { field: string; before: string; after: string }[] }
  | { kind: 'unchanged'; reportDate: string | null };

const money = (c: number | null) => (c == null ? 'not reported' : `$${(c / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}`);
const text = (s: string | null) => (s && s.trim() ? s.trim() : 'not reported');

export function recheck(disputed: ReportedAccount, newer: { reportDate: string | null; accounts: ReportedAccount[] } | null): Recheck {
  if (!newer) return { kind: 'no_newer_report' };
  const now = disputed.matchKey ? newer.accounts.find((a) => a.matchKey === disputed.matchKey) : undefined;
  if (!now) return { kind: 'not_on_newer_report', reportDate: newer.reportDate };
  const changes: { field: string; before: string; after: string }[] = [];
  if (disputed.balanceCents !== now.balanceCents) changes.push({ field: 'Balance', before: money(disputed.balanceCents), after: money(now.balanceCents) });
  if (text(disputed.accountStatus).toLowerCase() !== text(now.accountStatus).toLowerCase()) changes.push({ field: 'Account status', before: text(disputed.accountStatus), after: text(now.accountStatus) });
  if (text(disputed.paymentStatus).toLowerCase() !== text(now.paymentStatus).toLowerCase()) changes.push({ field: 'Payment status', before: text(disputed.paymentStatus), after: text(now.paymentStatus) });
  if ((disputed.dateOfFirstDelinquency ?? '') !== (now.dateOfFirstDelinquency ?? '')) changes.push({ field: 'Date of first delinquency', before: text(disputed.dateOfFirstDelinquency), after: text(now.dateOfFirstDelinquency) });
  return changes.length ? { kind: 'changed', reportDate: newer.reportDate, changes } : { kind: 'unchanged', reportDate: newer.reportDate };
}
