/**
 * A synthetic client, Jordan Rivera: the same file tests/unit/letter-tailor.test.ts drafts its letter from. Nobody real.
 * Used to prove what the AI features send to a provider: by tests/unit/ai-no-pii.test.ts against a recording stand-in,
 * and by tests/live/ai.live.test.ts against the real provider (npm run ai:prove).
 */
import type { ProgressStats } from '@/lib/ai/assistant';
import type { GuideStep } from '@/lib/guide/steps';
import { buildBrief, contextFor, disputeLetterKey, type BriefRecord } from '@/lib/letters/brief';
import { buildValues, mergeTemplate } from '@/lib/letters/render';
import type { SpecificityInput } from '@/lib/letters/specificity';
import { letterTerms } from '@/lib/letters/tailor';
import { templateByKey } from '@/lib/letters/templates';

export const JORDAN_EMAIL = 'jordan.rivera@example.com';
const REASON = 'Experian reports a balance of $1,200.00. My January 2026 statement shows a balance of $900.00. I closed this card when I moved.';

export const JORDAN_RECORD: BriefRecord = {
  today: '2026-11-19', tz: 'America/New_York',
  client: { id: '11111111-1111-4111-8111-111111111111', full_name: 'Jordan Rivera', address: { line1: '123 Main St', line2: 'Unit B', city: 'Tampa', state: 'FL', zip: '33602' }, ssn_last4: '4321', dob: '1985-03-03', bankruptcy_chapter: null, bankruptcy_filed_on: null, bankruptcy_discharged_on: null },
  dispute: {
    id: 'd-1', item_label: 'Acme Bank ••1234 (Experian)', target_type: 'bureau', bureau: 'experian', recipient_name: 'Experian', recipient_address: null, category: 'incorrect_balance', workflow: 'standard', reason: REASON, fields: ['Balance'],
    round: 2, status: 'draft', submitted_at: null, response_at: null, due_at: null, outcome: null, client_confirmed_accurate: false, agency: null, agency_item: null, tradeline_id: 't-1', sent_on: null,
  },
  tradeline: { creditor_name: 'Acme Bank', original_creditor: null, account_last4: '1234', bureau: 'experian', item_type: 'tradeline', account_status: 'Open', payment_status: 'Current', payment_history: 'CCCC', balance_cents: 120000, date_opened: '2019-03-03', date_of_first_delinquency: null, report_date: '2026-10-30', report_status: 'approved' },
  prior: { round: 1, submitted_at: '2026-08-04T15:00:00Z', sent_on: '2026-08-03', response_at: '2026-09-01T16:00:00Z', outcome: 'verified' },
  finding: null, evidence: ['January 2026 statement', 'Letter from my landlord'], identityDocs: [{ key: 'id', label: 'Government-issued photo ID' }, { key: 'proof_of_address', label: 'Proof of current address' }],
  identityTheftReports: [], notices: [], letters: [],
};

/** The letter to Experian drafted from that file, with what the letter tools pass to tailorSafely. */
export function jordanLetter(r: BriefRecord = JORDAN_RECORD) {
  const brief = buildBrief(r, { now: new Date('2026-11-19T12:00:00Z'), includeSsnLast4: true });
  const tpl = templateByKey(disputeLetterKey(brief)!)!;
  const body = mergeTemplate(tpl.body, buildValues(contextFor(brief, tpl)));
  const protectedTerms = letterTerms({
    clientName: r.client.full_name, address: r.client.address, body,
    names: [r.dispute!.recipient_name, r.tradeline!.creditor_name, r.dispute!.item_label], facts: [r.dispute!.reason, r.tradeline!.account_status, r.tradeline!.payment_status],
  });
  const specificity: Omit<SpecificityInput, 'body'> = { category: r.dispute!.category, reason: r.dispute!.reason, fields: r.dispute!.fields, account: { name: r.tradeline!.creditor_name, reference: r.tradeline!.account_last4 } };
  return { body, input: { protectedTerms, seed: brief.seed, specificity } };
}

/** Jordan's dispute counts, as loadDisputeCounts would return them. */
export const jordanProgress = (language: 'en' | 'es'): ProgressStats => ({ firstName: 'Jordan', total: 6, deleted: 2, updated: 1, verified: 1, waiting: 2, draft: 0, language });

/** A guide question typed with everything personal in it. */
export const JORDAN_QUESTION = `Hi, I'm Jordan Rivera (${JORDAN_EMAIL}), born March 3, 1985 (03/03/1985), and I live at 123 Main St, Unit B, Tampa, FL 33602. `
  + 'How long does Experian have to investigate my dispute about my Acme Bank card ending in 1234? My SSN ends in 4321.';

/** Jordan's own steps, with personal detail in them; only their generic labels may be sent. */
export const JORDAN_STEPS: GuideStep[] = [{ key: 'wait', title: 'Experian is investigating Jordan’s Acme Bank dispute', detail: 'Sent August 3, 2026 for account ending 1234.', href: '/portal/disputes' }];
/** What src/lib/guide/steps.ts redacts: the client's name parts (portal); staff on the client's page add the creditors. */
export const JORDAN_REDACT = { portal: ['Jordan', 'Rivera'], staff: ['Jordan', 'Rivera', 'Acme Bank'] };

/**
 * Every piece of the fixture that is personal data: names, the address, account and SSN digits, the date of birth and the
 * email. None of these may appear in anything sent to an AI provider.
 */
export const JORDAN_PII = ['Jordan', 'Rivera', '123 Main', 'Unit B', 'Tampa', '33602', '1234', '4321', '1985', '03/03', 'March 3', JORDAN_EMAIL];

/** The per-request canary in the guide's system prompt is random hex, which could contain a digit run by chance. */
export const withoutCanary = (s: string) => s.replace(/REF-[0-9a-f]{12}/g, 'REF-canary');
