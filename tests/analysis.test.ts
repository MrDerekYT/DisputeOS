import { describe, expect, it } from "vitest";
import { analyze, obsoleteAfter } from "@/lib/analysis/analyzer";
import { assertSafe, writeLetter } from "@/lib/analysis/letters";
import { SAMPLE_REPORTS } from "@/lib/analysis/sample";
import { CITATIONS } from "@/lib/analysis/citations";

const NOW = new Date("2026-10-26T00:00:00Z");
const findings = analyze(SAMPLE_REPORTS, NOW);
const kinds = (c: string) => findings.filter((f) => f.creditor === c).map((f) => f.kind);

describe("analyzer", () => {
  it("computes the reporting limit as 7 years + 180 days from DOFD", () => {
    expect(obsoleteAfter("2016-02-01").toISOString().slice(0, 10)).toBe("2023-07-31");
  });
  it("flags cross-bureau discrepancies including DOFD mismatch (re-aging risk)", () => {
    const m = findings.find((f) => f.kind === "discrepancy" && f.creditor === "Midland Credit Management")!;
    expect(m.strength).toBe(85);
    expect(m.bureaus.sort()).toEqual(["equifax", "experian"]);
    expect(m.evidence.some((e) => e.includes("Experian") && e.includes("2018-11-01"))).toBe(true);
    expect(kinds("Capital One")).toContain("discrepancy");
  });
  it("flags obsolete items, missing original creditor, and status/balance conflicts", () => {
    expect(kinds("Old Furniture Co")).toContain("obsolete");
    expect(kinds("Midland Credit Management")).toContain("missing_original_creditor");
    expect(kinds("Synchrony")).toContain("status_balance_conflict");
  });
  it("does not flag a clean, consistent account", () => {
    const clean = SAMPLE_REPORTS.map((r) => ({ ...r, tradelines: r.tradelines.filter((t) => t.creditor.value === "Capital One").map((t) => ({ ...t, balance: { ...t.balance, value: 1 } })) }));
    expect(analyze(clean, NOW)).toEqual([]);
  });
  it("ranks strongest first", () => {
    const s = findings.map((f) => f.strength);
    expect(s).toEqual([...s].sort((a, b) => b - a));
  });
});

describe("letters", () => {
  const f = findings.find((x) => x.kind === "obsolete")!;
  const from = { name: "Jordan Rivera", address: "123 Main St, Austin, TX" };
  it("uses only vetted citations, in both languages", () => {
    for (const lang of ["en", "es"] as const) {
      const text = writeLetter(f, from, lang, NOW);
      for (const k of f.citations) expect(text).toContain(CITATIONS[k].cite);
      expect(text).toContain("Jordan Rivera");
      expect(text).toContain(f.evidence[0]!);
    }
  });
  it("makes no outcome promises and blocks CPN/new-identity terms", () => {
    expect(() => assertSafe("we guarantee deletion")).toThrow();
    expect(() => assertSafe("get a CPN")).toThrow();
    for (const x of findings) expect(() => writeLetter(x, from, "en", NOW)).not.toThrow();
  });
  it("is personalized per client", () => {
    const a = writeLetter(f, from, "en", NOW);
    const b = writeLetter(f, { name: "Priya Shah", address: "9 Oak Ave" }, "en", NOW);
    expect(a).not.toBe(b);
  });
});
