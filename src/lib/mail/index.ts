export type MailClass = "first_class" | "certified" | "certified_return_receipt";

export interface Address {
  name: string;
  line1: string;
  line2?: string;
  city: string;
  state: string;
  zip: string;
}

export interface MailRequest {
  /** Stable key so a retried job never double-mails. */
  idempotencyKey: string;
  to: Address;
  from: Address;
  mailClass: MailClass;
  pages: number;
  body: string;
  /** A human must approve every letter before it is mailed. */
  approvedBy: string | null;
}

export interface MailResult {
  id: string;
  trackingNumber: string | null;
  costCents: number;
  expectedDelivery: string;
  duplicate: boolean;
}

export interface MailAdapter {
  readonly name: string;
  send(req: MailRequest): Promise<MailResult>;
}

// Placeholder rates for estimates only; the provider's invoice is the source of truth.
const BASE_CENTS: Record<MailClass, number> = { first_class: 105, certified: 745, certified_return_receipt: 1015 };
const PER_EXTRA_PAGE_CENTS = 8;

export const estimateCostCents = (mailClass: MailClass, pages: number): number =>
  BASE_CENTS[mailClass] + Math.max(0, pages - 1) * PER_EXTRA_PAGE_CENTS;

export function validateAddress(a: Address): string[] {
  const errs: string[] = [];
  if (!a.name.trim()) errs.push("name required");
  if (!a.line1.trim()) errs.push("line1 required");
  if (!a.city.trim()) errs.push("city required");
  if (!/^[A-Za-z]{2}$/.test(a.state)) errs.push("state must be a 2-letter code");
  if (!/^\d{5}(-\d{4})?$/.test(a.zip)) errs.push("zip must be 5 or 9 digits");
  return errs;
}

export function assertMailable(req: MailRequest): void {
  if (!req.approvedBy) throw new Error("Letter has not been approved by a person");
  if (!req.idempotencyKey) throw new Error("idempotencyKey required");
  if (req.pages < 1 || req.pages > 60) throw new Error("pages out of range");
  const errs = [...validateAddress(req.to), ...validateAddress(req.from)];
  if (errs.length) throw new Error(`Invalid address: ${errs.join(", ")}`);
}

/** In-memory adapter for dev and tests. Never contacts a provider. */
export class MockMailAdapter implements MailAdapter {
  readonly name = "mock";
  private sent = new Map<string, MailResult>();

  async send(req: MailRequest): Promise<MailResult> {
    assertMailable(req);
    const prior = this.sent.get(req.idempotencyKey);
    if (prior) return { ...prior, duplicate: true };
    const n = this.sent.size + 1;
    const days = req.mailClass === "first_class" ? 5 : 4;
    const result: MailResult = {
      id: `mock_${n}`,
      trackingNumber: req.mailClass === "first_class" ? null : `9400MOCK${String(n).padStart(8, "0")}`,
      costCents: estimateCostCents(req.mailClass, req.pages),
      expectedDelivery: new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10),
      duplicate: false,
    };
    this.sent.set(req.idempotencyKey, result);
    return result;
  }
}

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Lob adapter. Needs LOB_API_KEY; not exercised in tests (no live calls). */
export class LobMailAdapter implements MailAdapter {
  readonly name = "lob";
  constructor(private apiKey: string, private fetcher: typeof fetch = fetch) {}

  async send(req: MailRequest): Promise<MailResult> {
    assertMailable(req);
    const addr = (a: Address) => ({
      name: a.name, address_line1: a.line1, address_line2: a.line2,
      address_city: a.city, address_state: a.state.toUpperCase(), address_zip: a.zip,
    });
    const res = await this.fetcher("https://api.lob.com/v1/letters", {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${this.apiKey}:`).toString("base64")}`,
        "Content-Type": "application/json",
        "Idempotency-Key": req.idempotencyKey,
      },
      body: JSON.stringify({
        to: addr(req.to),
        from: addr(req.from),
        file: `<html><body style="font-family:serif;white-space:pre-wrap">${escapeHtml(req.body)}</body></html>`,
        color: false,
        extra_service: req.mailClass === "first_class" ? undefined : "certified",
        return_envelope: req.mailClass === "certified_return_receipt",
      }),
    });
    if (!res.ok) throw new Error(`Lob error ${res.status}`);
    const j = (await res.json()) as { id: string; tracking_number?: string; expected_delivery_date?: string };
    return {
      id: j.id,
      trackingNumber: j.tracking_number ?? null,
      costCents: estimateCostCents(req.mailClass, req.pages),
      expectedDelivery: j.expected_delivery_date ?? "",
      duplicate: false,
    };
  }
}

export function getMailAdapter(env: Record<string, string | undefined> = process.env): MailAdapter {
  return env.LOB_API_KEY ? new LobMailAdapter(env.LOB_API_KEY) : new MockMailAdapter();
}
