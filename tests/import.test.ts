import { describe, expect, it } from "vitest";
import { importClientsCsv, parseCsv } from "../src/lib/import/csv";
import { MockReportProvider, getReportProvider, type ConsentRecord } from "../src/lib/import/provider";
import { parseReportText } from "../src/lib/reports/parser";

const consent: ConsentRecord = { clientId: "c1", grantedAt: "2026-10-26T12:00:00Z", purpose: "credit_repair_dispute_review" };

describe("client CSV import", () => {
  it("handles quotes, commas and aliases", () => {
    expect(parseCsv('a,b\n"x, y","say ""hi"""')).toEqual([["a", "b"], ["x, y", 'say "hi"']]);
    const r = importClientsCsv('Full Name,E-mail,Cell,Street\n"Rivera, Jordan",J@X.com,(512) 555-0100,"1 Main St, Austin"\n');
    expect(r.rows[0]).toMatchObject({ name: "Rivera, Jordan", email: "j@x.com", phone: "5125550100" });
  });
  it("flags bad rows and drops duplicates", () => {
    const r = importClientsCsv("name,email,phone\nA,a@x.com,5125550100\nA2,a@x.com,5125550101\nB,bad,5125550102\n,c@x.com,\nD,d@x.com,123\n");
    expect(r.rows).toHaveLength(1);
    expect(r.duplicates).toBe(1);
    expect(r.errors.map((e) => e.line)).toEqual([4, 5, 6]);
  });
  it("neutralises formula prefixes and requires a name column", () => {
    expect(importClientsCsv("name\n=CMD()\n").rows[0]!.name).toBe("CMD()");
    expect(importClientsCsv("email\na@x.com\n").errors[0]!.message).toMatch(/name/);
  });
});

describe("report provider", () => {
  it("requires matching documented consent", async () => {
    const p = new MockReportProvider();
    await expect(p.pullReport("c1", { ...consent, clientId: "c2" })).rejects.toThrow(/consent/i);
    await expect(p.pullReport("c1", { ...consent, grantedAt: "" })).rejects.toThrow(/consent/i);
  });
  it("returns text the parser can read", async () => {
    const pull = await new MockReportProvider().pullReport("c1", consent);
    expect(parseReportText(pull.text).tradelines.length).toBeGreaterThan(0);
  });
  it("selects provider from env", () => {
    expect(getReportProvider({}).name).toBe("mock");
    expect(getReportProvider({ ARRAY_APP_KEY: "k", ARRAY_BASE_URL: "https://x" }).name).toBe("array");
  });
});
