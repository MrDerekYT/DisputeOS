import { sha256Hex } from '../crypto';

/**
 * Consent documents shown to clients and recorded in the consent ledger (version + SHA-256 of the exact text).
 *
 * IMPORTANT — NOT LEGAL ADVICE: the CROA "Consumer Credit File Rights" statement must use the wording required by
 * 15 U.S.C. § 1679c(a), and contract content is regulated federally and by state law (several states require
 * registration, bonding and specific contract terms). The text below is a reference draft. Have your attorney
 * review and, where needed, replace it before you onboard real clients.
 */
export type ConsentKind = 'croa_disclosure' | 'croa_contract' | 'fcra_authorization' | 'esign' | 'communications' | 'data_processing';

export interface ConsentDoc {
  kind: ConsentKind;
  title: string;
  version: string;
  required: boolean; // required before a dispute can be submitted
  text: string;
}

export const CONSENT_DOCS: ConsentDoc[] = [
  {
    kind: 'croa_disclosure',
    title: 'Consumer Credit File Rights (CROA disclosure)',
    version: '2026-01-draft',
    required: true,
    text: `You have a right to dispute inaccurate information in your credit report by contacting the credit bureau directly. However, neither you nor any credit repair company or credit repair organization has the right to have accurate, current, and verifiable information removed from your credit report. The credit bureau must remove accurate, negative information from your report only if it is over 7 years old. Bankruptcy information can be reported for 10 years.

You have a right to obtain a copy of your credit report from a credit bureau. You may be charged a reasonable fee. There is no fee, however, if you have been turned down for credit, employment, insurance, or a rental dwelling because of information in your credit report within the preceding 60 days.

You have a right to sue a credit repair organization that violates the Credit Repair Organizations Act. You have the right to cancel your contract with any credit repair organization for any reason within 3 business days from the date you signed it.

If the credit bureau's reinvestigation does not resolve the dispute to your satisfaction, you may send a brief statement to the credit bureau, to be kept in your file, explaining why you think the record is inaccurate.`,
  },
  {
    kind: 'croa_contract',
    title: 'Service agreement',
    version: '2026-01-draft',
    required: true,
    text: `This agreement describes the services your credit repair organization will perform, how long they are expected to take, the total cost, and your right to cancel within 3 business days of signing without penalty or obligation.

No result is guaranteed. Outcomes depend on what the credit bureaus and the companies reporting the information find after investigation. You will not be charged for credit repair services before they are fully performed.

[Your attorney-approved contract terms go here — replace this reference text in Settings → Compliance.]`,
  },
  {
    kind: 'fcra_authorization',
    title: 'Authorization to review credit reports and dispute on my behalf',
    version: '2026-01-draft',
    required: true,
    text: `I authorize this organization to review the credit reports I provide, and to prepare and, with my approval, submit disputes about information in my credit files to the consumer reporting agencies and the companies that report on my accounts. I understand I may withdraw this authorization at any time.`,
  },
  {
    kind: 'esign',
    title: 'Electronic records and signatures',
    version: '2026-01-draft',
    required: false,
    text: `I agree to receive disclosures and sign documents electronically, and I understand I can request paper copies.`,
  },
  {
    kind: 'communications',
    title: 'Communication preferences',
    version: '2026-01-draft',
    required: false,
    text: `I agree to be contacted about my account by email and through the client portal. Text messages will be sent only if I separately opt in to SMS.`,
  },
  {
    kind: 'data_processing',
    title: 'How my information is used',
    version: '2026-01-draft',
    required: false,
    text: `My identity and credit information is stored encrypted, used only to provide the services I requested, and is shared only with the credit bureaus and companies involved in my disputes.`,
  },
];

export const consentDoc = (kind: ConsentKind) => CONSENT_DOCS.find((d) => d.kind === kind)!;
export const consentHash = (d: ConsentDoc) => sha256Hex(d.text);
export const REQUIRED_CONSENTS: ConsentKind[] = CONSENT_DOCS.filter((d) => d.required).map((d) => d.kind);

/** Business days between two dates (Mon–Fri; federal holidays are not modelled). */
export function businessDaysBetween(from: Date, to: Date): number {
  let n = 0;
  const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  const end = Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate());
  while (d.getTime() < end) {
    d.setUTCDate(d.getUTCDate() + 1);
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) n++;
  }
  return n;
}

export interface ConsentStatus {
  missing: ConsentKind[];
  /** Contract signed less than 3 business days ago: the client can still cancel without penalty. */
  inCancellationWindow: boolean;
}

export function consentStatus(rows: { kind: string; signed_at: string; revoked_at: string | null }[], now = new Date()): ConsentStatus {
  const active = rows.filter((r) => !r.revoked_at);
  const missing = REQUIRED_CONSENTS.filter((k) => !active.some((r) => r.kind === k));
  const contract = active.filter((r) => r.kind === 'croa_contract').map((r) => new Date(r.signed_at)).sort((a, b) => b.getTime() - a.getTime())[0];
  return { missing, inCancellationWindow: !!contract && businessDaysBetween(contract, now) < 3 };
}
