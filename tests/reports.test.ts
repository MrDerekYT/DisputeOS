import { describe, expect, it } from "vitest";
import { fieldsNeedingReview, parseDate, parseMoney, parseReportText } from "@/lib/reports/parser";
import { diffReports } from "@/lib/reports/diff";
import { SAMPLE_REPORT } from "@/lib/reports/sample";

describe("value parsers", () => {
  it("parses money", () => {
    expect(parseMoney("$1,234")).toBe(1234);
    expect(parseMoney("$2,310.50")).toBe(2310.5);
    expect(parseMoney("($50)")).toBe(-50);
    expect(parseMoney("n/a")).toBeNull();
  });
  it("parses dates into ISO", () => {
    expect(parseDate("01/15/2019")).toBe("2019-01-15");
    expect(parseDate("11/2018")).toBe("2018-11-01");
    expect(parseDate("Mar 2021")).toBe("2021-03-01");
    expect(parseDate("2020-02-03")).toBe("2020-02-03");
    expect(parseDate("someday")).toBeNull();
  });
});

describe("parseReportText", () => {
  const r = parseReportText(SAMPLE_REPORT);
  it("detects bureau, accounts and inquiries", () => {
    expect(r.bureau).toBe("experian");
    expect(r.tradelines).toHaveLength(2);
    expect(r.inquiries).toEqual([
      expect.objectContaining({ name: "Chase Bank", date: "2025-06-12" }),
      expect.objectContaining({ name: "Sunrise Auto Finance", date: "2025-09-03" }),
    ]);
  });
  it("extracts fields with the source line as evidence", () => {
    const t = r.tradelines[0]!;
    expect(t.creditor.value).toBe("Capital One");
    expect(t.balance.value).toBe(1234);
    expect(t.balance.source).toBe("Balance: $1,234");
    expect(t.dateOpened.value).toBe("2019-01-15");
  });
  it("gives alias labels lower confidence and flags them for review", () => {
    const a = parseReportText("Account: Z\nPay Status: Late").tradelines[0]!;
    expect(a.paymentStatus.confidence).toBeLessThan(0.95);
    expect(fieldsNeedingReview(a)).toContain("paymentStatus");
  });
  it("does not let an alias label overwrite an exact one", () => {
    expect(r.tradelines[1]!.paymentStatus.value).toBe("Collection");
    expect(r.tradelines[1]!.paymentStatus.confidence).toBe(0.95);
  });
  it("leaves empty values null and warns on unreadable ones", () => {
    const t = r.tradelines[1]!;
    expect(t.originalCreditor.value).toBeNull();
    const bad = parseReportText("Account: X\nBalance: lots");
    expect(bad.warnings.join()).toMatch(/balance/);
    expect(fieldsNeedingReview(bad.tradelines[0]!)).toContain("balance");
  });
  it("warns when nothing parses", () => {
    expect(parseReportText("garbage").warnings[0]).toMatch(/No accounts/);
  });
});

describe("diffReports", () => {
  const prev = parseReportText(SAMPLE_REPORT);
  it("detects removed, updated, added, unchanged", () => {
    const next = parseReportText(
      SAMPLE_REPORT.replace(/Account: Midland[\s\S]*?(?=Inquiries)/, "")
        .replace("Balance: $1,234", "Balance: $900")
        .replace("Inquiries", "Account: Discover\nAccount Number: 6011000099990912\nBalance: $10\n\nInquiries"),
    );
    const d = diffReports(prev, next);
    expect(d.removed.map((t) => t.creditor.value)).toEqual(["Midland Credit Management"]);
    expect(d.added.map((t) => t.creditor.value)).toEqual(["Discover"]);
    expect(d.updated).toHaveLength(1);
    expect(d.updated[0]!.changes).toEqual([{ field: "balance", from: 1234, to: 900 }]);
  });
  it("reports no changes for identical reports", () => {
    const d = diffReports(prev, parseReportText(SAMPLE_REPORT));
    expect(d.unchanged).toBe(2);
    expect(d.removed.length + d.added.length + d.updated.length).toBe(0);
  });
});
