import { SAMPLE_REPORT } from "../reports/sample";

export interface ConsentRecord {
  clientId: string;
  /** Who gave consent and when; required before any bureau data is pulled. */
  grantedAt: string;
  purpose: "credit_repair_dispute_review";
  ipAddress?: string;
}

export interface ReportPull {
  provider: string;
  pulledAt: string;
  /** Plain report text, fed into the existing parser. */
  text: string;
}

export interface ReportProvider {
  readonly name: string;
  pullReport(clientId: string, consent: ConsentRecord): Promise<ReportPull>;
}

export function assertConsent(c: ConsentRecord | null | undefined, clientId: string): asserts c is ConsentRecord {
  if (!c || c.clientId !== clientId || !c.grantedAt || Number.isNaN(Date.parse(c.grantedAt))) {
    throw new Error("Documented client consent is required before pulling a credit report");
  }
  if (c.purpose !== "credit_repair_dispute_review") throw new Error("Unsupported consent purpose");
}

/** Dev/test provider: returns the bundled sample report. */
export class MockReportProvider implements ReportProvider {
  readonly name = "mock";
  async pullReport(clientId: string, consent: ConsentRecord): Promise<ReportPull> {
    assertConsent(consent, clientId);
    return { provider: this.name, pulledAt: new Date().toISOString(), text: SAMPLE_REPORT };
  }
}

/**
 * Array adapter. Endpoint path and payload follow the vendor's partner docs and must be
 * confirmed once partner access is granted; not exercised in tests (no live calls).
 */
export class ArrayReportProvider implements ReportProvider {
  readonly name = "array";
  constructor(private appKey: string, private baseUrl: string, private fetcher: typeof fetch = fetch) {}

  async pullReport(clientId: string, consent: ConsentRecord): Promise<ReportPull> {
    assertConsent(consent, clientId);
    const res = await this.fetcher(`${this.baseUrl}/reports`, {
      method: "POST",
      headers: { "x-api-key": this.appKey, "Content-Type": "application/json" },
      body: JSON.stringify({ clientReference: clientId, consentGrantedAt: consent.grantedAt }),
    });
    if (!res.ok) throw new Error(`Report provider error ${res.status}`);
    const j = (await res.json()) as { reportText?: string };
    if (!j.reportText) throw new Error("Provider returned no report text");
    return { provider: this.name, pulledAt: new Date().toISOString(), text: j.reportText };
  }
}

export function getReportProvider(env: Record<string, string | undefined> = process.env): ReportProvider {
  return env.ARRAY_APP_KEY && env.ARRAY_BASE_URL
    ? new ArrayReportProvider(env.ARRAY_APP_KEY, env.ARRAY_BASE_URL)
    : new MockReportProvider();
}
