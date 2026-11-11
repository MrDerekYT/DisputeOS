import { createHash } from 'node:crypto';
import { getEnv } from '../env';
import type { ReportInput } from './schema';
import type { Bureau } from '../util';

/**
 * Credit Connect provider registry.
 *
 * HONESTY RULE: an adapter appears as "available" only if real code exists for it AND it can run in this environment.
 * The major reporting providers gate their APIs behind partner agreements (Array's developer docs are
 * password-protected; IDIQ publishes no public API docs; the bureaus' direct interfaces need contracts and
 * certificates). We do NOT guess endpoints or scrape consumer logins. To add a real provider, implement `CreditProvider`
 * from its documented API once you hold partner access — see docs/CREDIT_CONNECT.md. Until then those providers are
 * listed with what is needed, and any of them (or Zapier, or your own system) can already push reports through the
 * authenticated REST API (POST /api/v1/clients/{id}/reports).
 */
export interface PullInput {
  clientId: string;
  fullName: string;
  address: { line1?: string; line2?: string; city?: string; state?: string; zip?: string };
}
export interface PullResult { externalRef: string; reports: ReportInput[] }
export interface CreditProvider { key: string; name: string; pull(input: PullInput): Promise<PullResult> }

export type ProviderStatus = 'available' | 'sandbox_unavailable' | 'needs_partner_approval';
export interface ProviderEntry { key: string; name: string; status: ProviderStatus; detail: string; needs?: string }

// ------------------------------------------------------------------ sandbox (development / test only)
function rng(seed: string) {
  let a = createHash('sha256').update(seed).digest().readUInt32LE(0);
  return () => ((a = (Math.imul(a ^ (a >>> 15), 2246822507) + 0x9e3779b9) >>> 0) / 4294967296);
}

/** Deterministic, obviously synthetic data so the whole automatic-import flow can be demonstrated without a provider account. */
export function sandboxReports(clientId: string, now = new Date()): ReportInput[] {
  const r = rng(clientId);
  const today = now.toISOString().slice(0, 10);
  const pick = (lo: number, hi: number) => Math.round(lo + r() * (hi - lo));
  const base = pick(1000, 2400) * 100;
  const history = ['CCCCCCCCCCCC', 'CCCC30CCCCCC', 'CCCCCCCC30CC'][pick(0, 2)]!;
  const bureaus: Bureau[] = ['experian', 'equifax', 'transunion'];
  const differing = bureaus[pick(0, 2)]!;
  return bureaus.map((bureau) => ({
    bureau,
    report_date: today,
    scores: [{ model: 'VantageScore 3.0', score: pick(560, 690), date: today }],
    tradelines: [
      { creditor_name: 'SANDBOX BANK ONE', account_number: '5178055500001234', item_type: 'tradeline' as const, account_type: 'Revolving', account_status: 'Open', payment_status: bureau === differing ? 'Late 30 days' : 'Current',
        balance_cents: bureau === differing ? base - pick(10, 30) * 100 : base, credit_limit_cents: 500000, date_opened: '2019-04-01', date_reported: today, payment_history: bureau === differing ? history : 'CCCCCCCCCCCC', remarks: 'SANDBOX SYNTHETIC DATA' },
      { creditor_name: 'SAMPLE AUTO FINANCE', account_number: '77001155', item_type: 'tradeline' as const, account_type: 'Installment', account_status: 'Open', payment_status: 'Current', balance_cents: 1_450_000, date_opened: '2022-01-15', date_reported: today, payment_history: 'CCCCCCCCCCCC', remarks: 'SANDBOX SYNTHETIC DATA' },
      ...(bureau !== 'transunion' ? [{ creditor_name: 'EXAMPLE RECOVERY SERVICES', account_number: '00099887766', item_type: 'collection' as const, original_creditor: 'SANDBOX UTILITY', account_type: 'Collection', account_status: 'Open', payment_status: 'Collection', balance_cents: 41_200, date_opened: '2021-03-01', date_reported: today, date_of_first_delinquency: '2020-09-12', remarks: 'SANDBOX SYNTHETIC DATA' }] : []),
    ],
    inquiries: [{ name: 'SAMPLE LENDER', date: '2025-08-02' }],
    public_records: [],
    identity: [{ kind: 'name' as const, value: 'SANDBOX CLIENT' }],
  }));
}

const sandbox: CreditProvider = {
  key: 'sandbox',
  name: 'Sandbox (synthetic data)',
  async pull({ clientId }) {
    return { externalRef: `sandbox-${clientId.slice(0, 8)}-${Date.now().toString(36)}`, reports: sandboxReports(clientId) };
  },
};

// ------------------------------------------------------------------ registry
const sandboxAllowed = () => ['development', 'test'].includes(getEnv().APP_ENV);

const GATED: ProviderEntry[] = [
  { key: 'array', name: 'Array', status: 'needs_partner_approval', detail: 'Array offers credit report and score APIs, but its developer documentation is password-protected, so no adapter can be written or verified without partner access.', needs: 'An Array developer account and API credentials; then an adapter implementing CreditProvider (docs/CREDIT_CONNECT.md)' },
  { key: 'idiq', name: 'IDIQ / IdentityIQ', status: 'needs_partner_approval', detail: 'No public API documentation was found; access is through IDIQ’s partner program.', needs: 'A partner agreement and documented API access from IDIQ' },
  { key: 'smartcredit', name: 'SmartCredit / MyFreeScoreNow', status: 'needs_partner_approval', detail: 'Not verified — confirm with the provider whether a partner API exists. Scraping consumer logins is not supported (it breaks provider terms and puts client credentials at risk).', needs: 'Written confirmation of an official partner API' },
  { key: 'bureau-direct', name: 'Direct bureau interfaces (Experian / Equifax / TransUnion)', status: 'needs_partner_approval', detail: 'Direct access requires a contract, a permissible purpose, and issued credentials or certificates.', needs: 'Bureau contracts, permissible-purpose review, and security onboarding' },
];

export function listProviders(): ProviderEntry[] {
  return [
    sandboxAllowed()
      ? { key: 'sandbox', name: sandbox.name, status: 'available', detail: 'Synthetic, clearly-labelled data for trying the automatic-import flow. Only exists in development and test — it is disabled in staging/production.' }
      : { key: 'sandbox', name: sandbox.name, status: 'sandbox_unavailable', detail: 'Disabled in staging/production so synthetic data can never reach real clients.' },
    ...GATED,
  ];
}

export function getProvider(key: string): CreditProvider | null {
  if (key === 'sandbox' && sandboxAllowed()) return sandbox;
  return null;
}
