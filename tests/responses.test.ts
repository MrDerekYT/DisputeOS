import { describe, expect, it } from "vitest";
import { decide, followUpLetter } from "@/lib/responses";

const base = { clientId: "x", creditor: "Acme", bureau: "Equifax", daysSinceSent: 20 };
const from = { name: "Jo", address: "1 Main St" };

describe("response automation", () => {
  it("marks deletions removed with no approval needed", () => {
    expect(decide({ ...base, outcome: "deleted" })).toMatchObject({ status: "removed", needsApproval: false });
  });
  it("verified outcomes queue a method-of-verification letter for approval", () => {
    const r = { ...base, outcome: "verified" as const };
    expect(decide(r).next).toBe("methodOfVerification");
    expect(followUpLetter(r, from)).toContain("1681i(a)(7)");
  });
  it("only escalates silence after the 45-day extended window", () => {
    expect(decide({ ...base, outcome: "noResponse", daysSinceSent: 40 }).next).toBe("celebrate");
    expect(decide({ ...base, outcome: "noResponse", daysSinceSent: 46 }).next).toBe("escalateNoResponse");
  });
  it("writes Spanish letters", () => {
    expect(followUpLetter({ ...base, outcome: "verified" }, from, "es")).toContain("Solicitud");
  });
  it("has no letter when nothing needs sending", () => {
    expect(followUpLetter({ ...base, outcome: "deleted" }, from)).toBeNull();
  });
});
