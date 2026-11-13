import { getEnv } from './env';
import { providerStatus } from './ai/provider';
import { PRODUCT } from './product';

/**
 * What is actually connected, derived from configuration — not from marketing. `verified` means the integration has
 * been exercised against the real third-party service from this codebase; none of the paid third-party ones have been.
 */
export type IntegrationStatus = 'active' | 'dev_only' | 'needs_credentials' | 'manual' | 'not_built';
/**
 * `status` says what actually happens in THIS environment:
 *   active             connected and in use
 *   dev_only           a development stand-in is in use (a log file, synthetic data); nothing real happens
 *   needs_credentials  built, but switched on without the credentials it needs
 *   manual             no provider is connected; the workflow is completed by a person through `manualPath`
 *   not_built          no integration and no manual path in the product
 * `manualPath` is the supported way to finish the job today; `needs` is the exact remaining dependency.
 */
export interface Integration { key: string; name: string; status: IntegrationStatus; verified: boolean; detail: string; manualPath?: string; needs?: string }

export function integrationStatus(): Integration[] {
  const env = getEnv();
  const ai = providerStatus();
  const emailLive = env.EMAIL_DRIVER === 'resend' && !!env.RESEND_API_KEY;
  const sandbox = env.APP_ENV === 'development' || env.APP_ENV === 'test';
  return [
    { key: 'db', name: 'PostgreSQL database', status: 'active', verified: true, detail: 'Row-level security enforces tenant isolation. Verified by the automated test suite against PostgreSQL 16.' },
    { key: 'storage', name: 'Document storage', status: 'active', verified: true, detail: 'Encrypted (AES-256-GCM) files on the server volume. Put STORAGE_DIR on a persistent, access-controlled disk. An S3-compatible backend is not built yet.' },
    { key: 'email', name: 'Email (Resend)', status: emailLive ? 'active' : env.EMAIL_DRIVER === 'log' ? 'dev_only' : 'needs_credentials', verified: false,
      detail: emailLive ? 'Configured. Implemented to the documented API; not yet exercised against the live service from this codebase.' : 'Currently writing emails to a local log — nothing is delivered. Messages are marked “not delivered”.', needs: 'EMAIL_DRIVER=resend, RESEND_API_KEY and a verified sending domain' },
    { key: 'ai', name: `AI assistant (${ai.provider})`, status: ai.active ? 'active' : 'dev_only', verified: !ai.active, detail: ai.active ? 'LLM rewriting on; outputs are fact-checked before use. Adapter verified against a mocked API only.' : 'Deterministic engine in use (fully functional). LLM rewriting is optional.', needs: 'AI_PROVIDER plus ANTHROPIC_API_KEY, or AI_BASE_URL + AI_API_KEY + AI_MODEL' },
    { key: 'api', name: 'Public REST API (API keys)', status: 'active', verified: true, detail: 'Authenticated, scoped, rate-limited API for clients, disputes and pushing credit reports. Verified by automated tests.' },
    { key: 'connect', name: 'Credit Connect (automatic import)', status: 'active', verified: true, detail: 'Consent-gated import pipeline with human review. The sandbox provider runs in development; live providers need partner approval (see Developers).' },
    { key: 'reports', name: 'Live credit pulls', status: sandbox ? 'dev_only' : 'manual', verified: false,
      detail: sandbox ? 'No live provider is connected. This environment has a sandbox provider that returns clearly labelled SYNTHETIC reports for testing; it is switched off in staging and production.' : 'No live provider is connected, and the sandbox provider is switched off in this environment.',
      manualPath: 'Upload the client’s report (PDF, HTML, text or the CSV template) on their Reports tab, or push it through the API. Either way it needs the client’s written authorization and a person approves it before use.',
      needs: 'A signed partner or reseller agreement with a report provider (for example SmartCredit, IDIQ, MyFreeScoreNow or Array) and the API credentials they issue; then one adapter file — see docs/CREDIT_CONNECT.md' },
    { key: 'mail', name: 'Certified mail', status: 'manual', verified: false,
      detail: `No mail provider is connected. ${PRODUCT.name} never mails anything itself.`,
      manualPath: 'Download the approved letter as a PDF, mail it yourself, then record the method, the date sent and the tracking reference. The record is labelled “Recorded by staff”; nothing is shown as carrier-confirmed.',
      needs: 'A print-and-mail account (for example Lob) with an API key and a sender address, plus the integration that sends approved letters and reads back delivery events' },
    { key: 'payments', name: 'Payments', status: 'manual', verified: false,
      detail: 'No payment processor is connected. No card or bank account is ever charged by the app.',
      manualPath: 'Collect payment outside the app and record it on the client’s Billing tab. Each record requires confirming the service was already performed (the CROA rule against advance fees).',
      needs: 'A Stripe (or similar) account with API keys and a webhook secret, plus a Checkout and webhook integration' },
    { key: 'sms', name: 'SMS', status: 'manual', verified: false,
      detail: 'No SMS provider is connected. No text message is ever sent by the app.',
      manualPath: 'Text or call the client from your own phone, then log it on their Messages tab as a call or text. It is saved as a record of a conversation, not as a sent message.',
      needs: 'An SMS provider account (for example Twilio) with a registered sending number, TCPA-compliant opt-in from each client, and the integration' },
    { key: 'esign', name: 'External e-signature', status: 'manual', verified: false,
      detail: 'No external e-signature provider (DocuSign, Dropbox Sign) is connected.',
      manualPath: 'Clients sign in the portal by typing their full legal name; the app stores the name, time, IP address and a hash of the exact text shown. Staff can also record a consent signed on paper.',
      needs: 'Only if your attorney requires a third-party signing service: an account with that provider and the integration' },
    { key: 'crm', name: 'External CRM sync', status: 'manual', verified: false, detail: 'No CRM sync is connected.', manualPath: 'Export a client’s full record as JSON from their profile, or read clients and disputes through the API.', needs: 'A specific CRM to sync with, and the integration' },
  ];
}
