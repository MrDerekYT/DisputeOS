import { describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }) }));
vi.mock("@/i18n/routing", () => ({ redirect: () => {} }));
vi.mock("@/lib/supabase-server", () => ({ supabaseServer: async () => ({}) }));

import { classifyReply } from "@/lib/copilot";
import { clientUpdateText } from "@/lib/ai";
import { DEMO_CLIENTS } from "@/lib/demo";
import { credentialsMatch, signPortal, verifyPortal } from "@/lib/access";

describe("reply classifier", () => {
  it("reads deletions, verifications and updates", () => {
    expect(classifyReply("The item has been removed from your report.")).toBe("deleted");
    expect(classifyReply("The information was verified as accurate.")).toBe("verified");
    expect(classifyReply("The account was updated with new details.")).toBe("updated");
    expect(classifyReply("La cuenta fue eliminada de su reporte.")).toBe("deleted");
  });
  it("treats negated deletion as verified, and unclear text as null", () => {
    expect(classifyReply("The item cannot be removed at this time.")).toBe("verified");
    expect(classifyReply("Thanks for writing to us today")).toBeNull();
  });
});

describe("client update text", () => {
  it("states that results vary and is accepted by the claims filter", () => {
    for (const c of DEMO_CLIENTS) expect(clientUpdateText(c, c.lang)).toMatch(/vary|varían/i);
  });
});

describe("access", () => {
  it("portal tokens are bound to one client", () => {
    process.env.INVITE_SECRET = "test-secret";
    const t = signPortal("jordan-rivera");
    expect(verifyPortal(t)).toBe("jordan-rivera");
    expect(verifyPortal(t.replace("jordan-rivera", "maria-gomez"))).toBeNull();
    expect(verifyPortal("jordan-rivera")).toBeNull();
  });
  it("admin credentials require both env vars", () => {
    delete process.env.ADMIN_EMAIL;
    delete process.env.ADMIN_PASSWORD;
    expect(credentialsMatch("a@b.c", "x")).toBe(false);
    process.env.ADMIN_EMAIL = "a@b.c";
    process.env.ADMIN_PASSWORD = "pw-123";
    expect(credentialsMatch("A@B.C", "pw-123")).toBe(true);
    expect(credentialsMatch("a@b.c", "nope")).toBe(false);
  });
});
