import { describe, expect, it } from "vitest";
import { blindIndex, decryptField, encryptField, last4 } from "@/lib/crypto";
import { scrubDeep, scrubPii } from "@/lib/scrub";
import { can, requiresMfa } from "@/lib/permissions";

const KEY = Buffer.alloc(32, 7).toString("base64");

describe("field encryption", () => {
  it("round-trips and uses a fresh IV each time", () => {
    const a = encryptField("123-45-6789", KEY);
    const b = encryptField("123-45-6789", KEY);
    expect(a).not.toBe(b);
    expect(decryptField(a, KEY)).toBe("123-45-6789");
  });
  it("rejects tampered ciphertext and wrong keys", () => {
    const c = encryptField("secret", KEY);
    expect(() => decryptField(c.slice(0, -2) + "AA", KEY)).toThrow();
    expect(() => decryptField(c, Buffer.alloc(32, 9).toString("base64"))).toThrow();
  });
  it("requires a 32-byte key", () => {
    expect(() => encryptField("x", "short")).toThrow();
  });
  it("blind index is stable and case-insensitive; last4 masks", () => {
    expect(blindIndex("A@B.com", KEY)).toBe(blindIndex(" a@b.com ", KEY));
    expect(last4("123-45-6789")).toBe("6789");
  });
});

describe("PII scrubbing", () => {
  it("removes SSNs, emails, account numbers", () => {
    const out = scrubPii("SSN 123-45-6789 mail a@b.com acct 4111 1111 1111 1111");
    expect(out).not.toMatch(/123-45-6789|a@b\.com|4111/);
  });
  it("scrubs nested objects", () => {
    expect(scrubDeep({ a: { b: ["987-65-4321"] } })).toEqual({ a: { b: ["[SSN]"] } });
  });
});

describe("permissions", () => {
  it("limits full PII and billing", () => {
    expect(can("staff", "pii:view_full")).toBe(false);
    expect(can("admin", "pii:view_full")).toBe(true);
    expect(can("admin", "billing:manage")).toBe(false);
    expect(can(undefined, "clients:read")).toBe(false);
  });
  it("requires MFA for staff but not clients", () => {
    expect(requiresMfa("staff")).toBe(true);
    expect(requiresMfa("client")).toBe(false);
  });
});
