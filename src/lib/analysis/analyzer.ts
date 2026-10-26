import { last4Of } from "../reports/parser";
import type { Bureau, ParsedReport, ParsedTradeline } from "../reports/types";
import type { CitationKey } from "./citations";

export type FindingKind =
  | "discrepancy"
  | "obsolete"
  | "missing_original_creditor"
  | "missing_dofd"
  | "status_balance_conflict"
  | "duplicate";

export type LetterType = "fcra_611" | "fcra_623" | "fdcpa_809" | "obsolete";

export interface Finding {
  id: string;
  kind: FindingKind;
  strength: number; // 0..100, higher = stronger basis to dispute
  creditor: string;
  account: string; // last 4 only
  bureaus: Bureau[];
  title: string;
  detail: string;
  evidence: string[];
  citations: CitationKey[];
  letter: LetterType;
}

const norm = (s: string | null) => (s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
const key = (t: ParsedTradeline) => `${norm(t.creditor.value)}|${last4Of(t.accountNumber.value)}`;
const BUREAU_LABEL: Record<string, string> = { equifax: "Equifax", experian: "Experian", transunion: "TransUnion" };
const label = (b: Bureau | null) => (b ? BUREAU_LABEL[b] : "Unknown bureau");
const isCollection = (t: ParsedTradeline) => /collection/i.test(`${t.accountType.value ?? ""} ${t.paymentStatus.value ?? ""}`);
const isNegative = (t: ParsedTradeline) => isCollection(t) || /charge|delinq|late|derog/i.test(t.paymentStatus.value ?? "");

const COMPARE: { f: keyof ParsedTradeline; name: string; strength: number }[] = [
  { f: "dofd", name: "Date of first delinquency", strength: 85 },
  { f: "accountStatus", name: "Account status", strength: 75 },
  { f: "paymentStatus", name: "Payment status", strength: 65 },
  { f: "balance", name: "Balance", strength: 60 },
  { f: "dateOpened", name: "Date opened", strength: 55 },
];

/** Adverse items expire 7 years + 180 days after the date of first delinquency (15 U.S.C. § 1681c(c)). */
export function obsoleteAfter(dofdIso: string): Date {
  const d = new Date(`${dofdIso}T00:00:00Z`);
  d.setUTCFullYear(d.getUTCFullYear() + 7);
  d.setUTCDate(d.getUTCDate() + 180);
  return d;
}

export function analyze(reports: ParsedReport[], now: Date = new Date()): Finding[] {
  const findings: Finding[] = [];
  const add = (f: Omit<Finding, "id">) => findings.push({ ...f, id: `${f.kind}:${norm(f.creditor)}:${f.account}:${f.title}`.slice(0, 120) });

  // Cross-bureau discrepancies
  const groups = new Map<string, { bureau: Bureau | null; t: ParsedTradeline }[]>();
  for (const r of reports)
    for (const t of r.tradelines) groups.set(key(t), [...(groups.get(key(t)) ?? []), { bureau: r.bureau, t }]);

  for (const [, members] of groups) {
    if (members.length < 2) continue;
    const first = members[0]!.t;
    const diffs = COMPARE.flatMap((c) => {
      const vals = members.filter((m) => m.t[c.f].value !== null);
      return new Set(vals.map((m) => String(m.t[c.f].value))).size > 1 ? [{ c, vals }] : [];
    });
    if (!diffs.length) continue;
    add({
      kind: "discrepancy",
      strength: Math.max(...diffs.map((d) => d.c.strength)),
      creditor: first.creditor.value ?? "Unknown",
      account: last4Of(first.accountNumber.value),
      bureaus: members.flatMap((m) => (m.bureau ? [m.bureau] : [])),
      title: `Bureaus disagree: ${diffs.map((d) => d.c.name.toLowerCase()).join(", ")}`,
      detail: "The same account is reported differently across bureaus, so at least one version is inaccurate.",
      evidence: diffs.flatMap((d) => d.vals.map((m) => `${label(m.bureau)}: ${d.c.name} = ${m.t[d.c.f].value}`)),
      citations: ["fcra_607b", "fcra_611", "fcra_623"],
      letter: "fcra_611",
    });
  }

  for (const r of reports) {
    const seen = new Map<string, ParsedTradeline>();
    for (const t of r.tradelines) {
      const creditor = t.creditor.value ?? "Unknown";
      const base = { creditor, account: last4Of(t.accountNumber.value), bureaus: r.bureau ? [r.bureau] : [] };

      if (t.dofd.value && isNegative(t)) {
        const expires = obsoleteAfter(t.dofd.value);
        if (now > expires)
          add({ ...base, kind: "obsolete", strength: 92, title: "Past the FCRA reporting limit",
            detail: `Date of first delinquency ${t.dofd.value}; reporting period ended ${expires.toISOString().slice(0, 10)}.`,
            evidence: [`${label(r.bureau)}: ${t.dofd.source ?? ""}`], citations: ["fcra_605", "fcra_611"], letter: "obsolete" });
      }
      if (isCollection(t) && !t.originalCreditor.value)
        add({ ...base, kind: "missing_original_creditor", strength: 70, title: "Collection without an original creditor",
          detail: "A collection must identify who the debt was originally owed to so it can be verified.",
          evidence: [`${label(r.bureau)}: Original creditor not reported`], citations: ["fdcpa_809", "fcra_611"], letter: "fdcpa_809" });
      if ((isCollection(t) || /charge/i.test(t.paymentStatus.value ?? "")) && !t.dofd.value)
        add({ ...base, kind: "missing_dofd", strength: 68, title: "Missing date of first delinquency",
          detail: "Without a DOFD the reporting period cannot be verified and the item may be re-aged.",
          evidence: [`${label(r.bureau)}: DOFD not reported`], citations: ["fcra_607b", "fcra_605"], letter: "fcra_611" });
      if (/closed|paid/i.test(t.accountStatus.value ?? "") && (t.balance.value ?? 0) > 0)
        add({ ...base, kind: "status_balance_conflict", strength: 72, title: "Closed/paid account still shows a balance",
          detail: "Status and balance contradict each other.",
          evidence: [`${label(r.bureau)}: ${t.accountStatus.source ?? ""}`, `${label(r.bureau)}: ${t.balance.source ?? ""}`],
          citations: ["fcra_607b", "fcra_611"], letter: "fcra_611" });

      const dupKey = `${norm(t.creditor.value)}|${t.balance.value}`;
      const prev = seen.get(dupKey);
      if (prev && t.balance.value !== null && key(prev) !== key(t))
        add({ ...base, kind: "duplicate", strength: 66, title: "Possible duplicate account",
          detail: "Two accounts share a creditor and balance but have different account numbers.",
          evidence: [`${label(r.bureau)}: ${prev.accountNumber.source ?? ""}`, `${label(r.bureau)}: ${t.accountNumber.source ?? ""}`],
          citations: ["fcra_607b", "fcra_611"], letter: "fcra_611" });
      seen.set(dupKey, t);
    }
  }
  return findings.sort((a, b) => b.strength - a.strength);
}

export const strengthLabel = (s: number): "strong" | "moderate" | "weak" => (s >= 80 ? "strong" : s >= 65 ? "moderate" : "weak");
