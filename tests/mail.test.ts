import { describe, expect, it } from "vitest";
import { MockMailAdapter, estimateCostCents, getMailAdapter, validateAddress, type MailRequest } from "../src/lib/mail";

const addr = { name: "Experian", line1: "PO Box 4500", city: "Allen", state: "TX", zip: "75013" };
const req = (o: Partial<MailRequest> = {}): MailRequest => ({
  idempotencyKey: "k1", to: addr, from: { ...addr, name: "Jordan Rivera" },
  mailClass: "certified", pages: 2, body: "hi", approvedBy: "staff-1", ...o,
});

describe("mail layer", () => {
  it("refuses unapproved letters", async () => {
    await expect(new MockMailAdapter().send(req({ approvedBy: null }))).rejects.toThrow(/approved/);
  });
  it("is idempotent", async () => {
    const m = new MockMailAdapter();
    const a = await m.send(req());
    const b = await m.send(req());
    expect(b.id).toBe(a.id);
    expect(b.duplicate).toBe(true);
  });
  it("rejects bad addresses", async () => {
    expect(validateAddress({ ...addr, zip: "7501" })).toContain("zip must be 5 or 9 digits");
    await expect(new MockMailAdapter().send(req({ to: { ...addr, state: "Texas" } }))).rejects.toThrow(/Invalid address/);
  });
  it("estimates cost with extra pages", () => {
    expect(estimateCostCents("first_class", 1)).toBe(105);
    expect(estimateCostCents("certified", 3)).toBe(745 + 16);
  });
  it("certified mail gets tracking; first class does not", async () => {
    const m = new MockMailAdapter();
    expect((await m.send(req())).trackingNumber).toMatch(/^9400/);
    expect((await m.send(req({ idempotencyKey: "k2", mailClass: "first_class" }))).trackingNumber).toBeNull();
  });
  it("defaults to the mock adapter without a key", () => {
    expect(getMailAdapter({}).name).toBe("mock");
    expect(getMailAdapter({ LOB_API_KEY: "x" }).name).toBe("lob");
  });
});
