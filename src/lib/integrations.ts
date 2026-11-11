import { getEnv } from './env';
import { providerStatus } from './ai/provider';
import { PRODUCT } from './product';

/**
 * What is actually connected, derived from configuration — not from marketing. `verified` means the integration has
 * been exercised against the real third-party service from this codebase; none of the paid third-party ones have been.
 */
export type IntegrationStatus = 'active' | 'dev_only' | 'needs_credentials' | 'not_built';
export interface Integration { key: string; name: string; status: IntegrationStatus; verified: boolean; detail: string; needs?: string }

export function integrationStatus(): Integration[] {
  const env = getEnv();
  const ai = providerStatus();
  const emailLive = env.EMAIL_DRIVER === 'resend' && !!env.RESEND_API_KEY;
  return [
    { key: 'db', name: 'PostgreSQL database', status: 'active', verified: true, detail: 'Row-level security enforces tenant isolation. Verified by the automated test suite against PostgreSQL 16.' },
    { key: 'storage', name: 'Document storage', status: 'active', verified: true, detail: 'Encrypted (AES-256-GCM) files on the server volume. Put STORAGE_DIR on a persistent, access-controlled disk. An S3-compatible backend is not built yet.' },
    { key: 'email', name: 'Email (Resend)', status: emailLive ? 'active' : env.EMAIL_DRIVER === 'log' ? 'dev_only' : 'needs_credentials', verified: false,
      detail: emailLive ? 'Configured. Implemented to the documented API; not yet exercised against the live service from this codebase.' : 'Currently writing emails to a local log — nothing is delivered. Messages are marked “not delivered”.', needs: 'EMAIL_DRIVER=resend, RESEND_API_KEY and a verified sending domain' },
    { key: 'ai', name: `AI assistant (${ai.provider})`, status: ai.active ? 'active' : 'dev_only', verified: !ai.active, detail: ai.active ? 'LLM rewriting on; outputs are fact-checked before use. Adapter verified against a mocked API only.' : 'Deterministic engine in use (fully functional). LLM rewriting is optional.', needs: 'AI_PROVIDER plus ANTHROPIC_API_KEY, or AI_BASE_URL + AI_API_KEY + AI_MODEL' },
    { key: 'api', name: 'Public REST API (API keys)', status: 'active', verified: true, detail: 'Authenticated, scoped, rate-limited API for clients, disputes and pushing credit reports. Verified by automated tests.' },
    { key: 'connect', name: 'Credit Connect (automatic import)', status: 'active', verified: true, detail: 'Consent-gated import pipeline with human review. The sandbox provider runs in development; live providers need partner approval (see Developers).' },
    { key: 'sms', name: 'SMS', status: 'not_built', verified: false, detail: 'Not implemented. Text-message outreach also needs TCPA-compliant opt-in (the consent ledger supports recording it).', needs: 'An SMS provider account (e.g. Twilio) and an integration' },
    { key: 'payments', name: 'Payment processing (Stripe)', status: 'not_built', verified: false, detail: 'Not implemented. Payments are recorded manually. Card collection must also respect the CROA rule against advance fees.', needs: 'Stripe account, Checkout + webhook integration' },
    { key: 'reports', name: 'Live provider adapters (Array, IDIQ, bureaus)', status: 'not_built', verified: false, detail: 'No live adapter exists yet: provider APIs are partner-gated and need a permissible purpose and client authorization. Push reports through the API, or upload them.', needs: 'Approved partner agreement; then one adapter file (docs/CREDIT_CONNECT.md)' },
    { key: 'esign', name: 'Electronic signatures', status: 'not_built', verified: false, detail: 'Not implemented. Consents are captured as typed-name e-signatures in the portal with timestamp, IP and a hash of the exact text shown.', needs: 'A provider such as DocuSign / Dropbox Sign if wet-ink-equivalent signing is needed' },
    { key: 'mail', name: 'Certified mail', status: 'not_built', verified: false, detail: `Not implemented. ${PRODUCT.name} produces the approved PDF; a person mails it and records the tracking number.`, needs: 'A print-and-mail provider (e.g. Lob) account' },
    { key: 'crm', name: 'External CRM sync', status: 'not_built', verified: false, detail: 'Not implemented. Client data can be exported as JSON per client.' },
  ];
}
