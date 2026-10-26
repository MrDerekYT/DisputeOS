export interface DiffItem {
  bureau: string;
  creditor_name: string;
  account_last4: string | null;
  balance_cents: number | null;
  account_status: string | null;
}

export const fingerprint = (
  i: Pick<DiffItem, 'bureau' | 'creditor_name' | 'account_last4'>,
): string =>
  [i.bureau, i.creditor_name.toLowerCase().replace(/[^a-z0-9]/g, ''), i.account_last4 ?? ''].join(
    '|',
  );

export interface ReportDiff<T extends DiffItem> {
  deleted: T[]; // present before, gone now => potential win
  added: T[]; // new item
  updated: { before: T; after: T; changes: string[] }[];
  unchanged: T[];
}

/** Compare two imports of the same client. Items are matched by bureau + creditor + last4. */
export function diffReports<T extends DiffItem>(previous: T[], current: T[]): ReportDiff<T> {
  const prev = new Map(previous.map((i) => [fingerprint(i), i]));
  const cur = new Map(current.map((i) => [fingerprint(i), i]));
  const out: ReportDiff<T> = { deleted: [], added: [], updated: [], unchanged: [] };
  for (const [k, before] of prev) {
    const after = cur.get(k);
    if (!after) {
      out.deleted.push(before);
      continue;
    }
    const changes: string[] = [];
    if (before.balance_cents !== after.balance_cents) changes.push('balance');
    if ((before.account_status ?? '') !== (after.account_status ?? '')) changes.push('status');
    if (changes.length) out.updated.push({ before, after, changes });
    else out.unchanged.push(after);
  }
  for (const [k, after] of cur) if (!prev.has(k)) out.added.push(after);
  return out;
}
