import { last4Of } from "./parser";
import type { ParsedReport, ParsedTradeline } from "./types";

export interface Change {
  field: keyof ParsedTradeline;
  from: string | number | null;
  to: string | number | null;
}

export interface ReportDiff {
  /** Present in the old report, gone from the new one: candidate wins for the matching dispute. */
  removed: ParsedTradeline[];
  added: ParsedTradeline[];
  updated: { before: ParsedTradeline; after: ParsedTradeline; changes: Change[] }[];
  unchanged: number;
}

/** Stable identity for matching the same account across imports: creditor + last 4. */
export const tradelineKey = (t: ParsedTradeline): string =>
  `${(t.creditor.value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "")}|${last4Of(t.accountNumber.value)}`;

const COMPARED: (keyof ParsedTradeline)[] = [
  "accountStatus", "paymentStatus", "balance", "highCredit", "creditLimit", "dofd", "originalCreditor", "paymentHistory",
];

export function diffReports(prev: ParsedReport, next: ParsedReport): ReportDiff {
  const nextMap = new Map(next.tradelines.map((t) => [tradelineKey(t), t]));
  const prevMap = new Map(prev.tradelines.map((t) => [tradelineKey(t), t]));
  const diff: ReportDiff = { removed: [], added: [], updated: [], unchanged: 0 };

  for (const [key, before] of prevMap) {
    const after = nextMap.get(key);
    if (!after) { diff.removed.push(before); continue; }
    const changes: Change[] = COMPARED.flatMap((f) =>
      before[f].value !== after[f].value ? [{ field: f, from: before[f].value, to: after[f].value }] : [],
    );
    if (changes.length) diff.updated.push({ before, after, changes });
    else diff.unchanged++;
  }
  for (const [key, t] of nextMap) if (!prevMap.has(key)) diff.added.push(t);
  return diff;
}
