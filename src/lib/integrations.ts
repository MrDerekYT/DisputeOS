import { getEnv } from './env';
import { providerStatus } from './ai/provider';
import { PRODUCT } from './product';
import { smsStatus } from './sms';

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
  const sms = smsStatus();
  return [
    { key: 'db', name: 'PostgreSQL database', status: 'active', verified: true, detail: 'Row-level security enforces tenant isolation. Verified by the automated test suite against PostgreSQL 16.' },
    { key: 'storage', name: 'Document storage', status: 'active', verified: true, detail: env.STORAGE_DRIVER === 'db'
      ? 'Encrypted (AES-256-GCM) files stored in the database (STORAGE_DRIVER=db), so they persist on hosts without a disk and are covered by database backups. An S3-compatible backend is not built yet.'
      : 'Encrypted (AES-256-GCM) files on the server volume. Put STORAGE_DIR on a persistent, access-controlled disk. An S3-compatible backend is not built yet.' },
    { key: 'email', name: 'Email (Resend)', status: emailLive ? 'active' : env.EMAIL_DRIVER === 'log' ? 'dev_only' : env.EMAIL_DRIVER === 'disabled' ? 'manual' : 'needs_credentials', verified: false,
      detail: emailLive ? 'Configured. Implemented to the documented API; not yet exercised against the live service from this codebase.'
        : env.EMAIL_DRIVER === 'disabled' ? 'Email is not connected (EMAIL_DRIVER=disabled). No email is ever sent: no invitations, password-reset links, client emails or lead follow-ups.'
        : 'Currently writing emails to a local log — nothing is delivered. Messages are marked “not delivered”.',
      ...(env.EMAIL_DRIVER === 'disabled' ? { manualPath: 'Invitations show a one-time link for you to pass on yourself. Message clients through the portal. Password reset by email is unavailable: a person who forgets their password cannot recover the account on their own until email is connected.' } : {}),
      needs: 'EMAIL_DRIVER=resend, RESEND_API_KEY and a verified sending domain' },
    { key: 'ai', name: `AI assistant (${ai.provider})`, status: ai.active ? 'active' : 'dev_only', verified: !ai.active, detail: ai.active ? 'LLM rewriting on for workspaces with AI credits; outputs are fact-checked before use. Adapter verified against a mocked API only.' : 'Deterministic engine in use (fully functional). LLM rewriting is optional.', needs: 'AI_PROVIDER plus ANTHROPIC_API_KEY, or AI_BASE_URL + AI_API_KEY + AI_MODEL' },
    { key: 'ai_credits', name: 'AI credits (buying online)', status: 'manual', verified: false,
      detail: 'AI wording is metered: each AI result that is returned costs credits from the workspace balance, and with no credits the standard wording is used. No payment processor is connected, so credits cannot be bought in the app.',
      manualPath: 'The platform operator adds credits from the server with: npm run credits:grant -- <workspace-slug> <amount> [note].  Every grant is written to the credit ledger and the audit log.',
      needs: 'A payment processor account (for example Stripe) with API keys and a webhook secret, plus a checkout and webhook integration that writes purchase rows to the credit ledger' },
    { key: 'api', name: 'Public REST API (API keys)', status: 'active', verified: true, detail: 'Authenticated, scoped, rate-limited API for clients, disputes and pushing credit reports. Verified by automated tests.' },
    { key: 'connect', name: 'Credit Connect (import pipeline)', status: sandbox ? 'dev_only' : 'manual', verified: false,
      detail: sandbox ? 'Consent-gated import pipeline with human review. Only the sandbox provider (SYNTHETIC reports) runs here; nothing is imported automatically from a real provider.' : 'Consent-gated import pipeline with human review. No live provider is connected and the sandbox is switched off here, so nothing is imported automatically.',
      manualPath: 'Upload the client’s report on their Reports tab, or push it through the API (see Developers). It goes through the same consent check and review queue.',
      needs: 'Partner approval and API credentials from a report provider, then one adapter file — see docs/CREDIT_CONNECT.md' },
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
    { key: 'sms', name: 'Text messages (Twilio)', verified: false,
      status: sms.state === 'connected' ? 'active' : sms.state === 'test_only' ? 'dev_only' : sms.state === 'needs_credentials' ? 'needs_credentials' : 'manual',
      detail: sms.state === 'connected' ? 'Configured. Short updates go only to clients who agreed to texts, for the events switched on under Client updates. Implemented to the documented API; not yet exercised against the live service from this codebase.'
        : sms.state === 'test_only' ? 'Texts are written to a local log (SMS_DRIVER=log). Nothing is delivered.'
        : sms.state === 'needs_credentials' ? `Switched on (SMS_DRIVER=twilio) but not connected: ${sms.missing.join(', ')} still to set. No text message is sent.`
        : 'Not connected (SMS_DRIVER=disabled). No text message is ever sent by the app.',
      manualPath: 'Text or call the client from your own phone, then log it on their Messages tab as a call or text. It is saved as a record of a conversation, not as a sent message.',
      needs: 'A Twilio account with a sending number registered for US messaging (A2P 10DLC, or a verified toll-free number), then SMS_DRIVER=twilio, TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_MESSAGING_SERVICE_SID or TWILIO_FROM_NUMBER. Each client must agree to texts first. Steps: docs/INTEGRATIONS.md' },
    { key: 'esign', name: 'External e-signature', status: 'manual', verified: false,
      detail: 'No external e-signature provider (DocuSign, Dropbox Sign) is connected.',
      manualPath: 'Clients sign in the portal by typing their full legal name; the app stores the name, time, IP address and a hash of the exact text shown. Staff can also record a consent signed on paper.',
      needs: 'Only if your attorney requires a third-party signing service: an account with that provider and the integration' },
    { key: 'custom_domain', name: 'Custom domains for agency websites', status: 'manual', verified: false,
      detail: 'Each agency website is hosted at an address on this app (/a/<workspace>). Connecting an agency’s own domain is not automated and cannot be done from the app.',
      manualPath: 'Share the address shown on the Website page. For an agency’s own domain, the platform operator adds the domain at the hosting provider and routes it to that agency’s site address.',
      needs: 'Domain verification, certificates and per-domain routing built into the app (for example through the hosting provider’s domains API)' },
    { key: 'crm', name: 'External CRM sync', status: 'manual', verified: false, detail: 'No CRM sync is connected.', manualPath: 'Export a client’s full record as JSON from their profile, or read clients and disputes through the API.', needs: 'A specific CRM to sync with, and the integration' },
  ];
}
