import { describe, expect, it } from "vitest";
import { inviteFor, signInvite, validateIntake, verifyInvite } from "../src/lib/invite";

const env = { INVITE_SECRET: "s3cret" };

describe("invite links", () => {
  it("round-trips a valid token", () => {
    const t = signInvite(inviteFor("org1", "Jordan"), env);
    expect(verifyInvite(t, env)).toMatchObject({ org: "org1", name: "Jordan" });
  });
  it("rejects tampering, wrong secret, expiry and junk", () => {
    const t = signInvite(inviteFor("org1"), env);
    const [b, s] = t.split(".");
    const forged = Buffer.from(JSON.stringify({ org: "org2", exp: 9e9 })).toString("base64url");
    expect(verifyInvite(`${forged}.${s}`, env)).toBeNull();
    expect(verifyInvite(t, { INVITE_SECRET: "other" })).toBeNull();
    expect(verifyInvite(`${b}.${s}`, env, 4_000_000_000)).toBeNull();
    expect(verifyInvite("garbage", env)).toBeNull();
    expect(verifyInvite("a.b.c", env)).toBeNull();
  });
  it("requires a secret in production", () => {
    expect(() => signInvite(inviteFor("o"), { NODE_ENV: "production" })).toThrow(/INVITE_SECRET/);
  });
});

describe("intake validation", () => {
  const good = { name: "Jordan Rivera", email: "J@X.com", phone: "(512) 555-0100", address: "123 Main St, Austin", consentCroa: "on", consentReports: "on" };
  it("accepts and normalizes", () => {
    const r = validateIntake(good);
    expect(r.ok && r.data).toMatchObject({ email: "j@x.com", phone: "5125550100" });
  });
  it("requires both consents and valid fields", () => {
    const r = validateIntake({ ...good, consentReports: null, email: "bad", phone: "1" });
    expect(!r.ok && Object.keys(r.errors).sort()).toEqual(["consentReports", "email", "phone"]);
  });
});
