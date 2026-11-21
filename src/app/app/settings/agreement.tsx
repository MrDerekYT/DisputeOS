import { ActionForm, Field, SubmitButton, TextArea } from '@/components/forms';
import { Notice, Section } from '@/components/ui';
import { loadAgency } from '@/lib/agreements';
import type { requireStaff } from '@/lib/auth/context';
import { savedTermsIssue, TERMS_LIMITS } from '@/lib/compliance/agreement-terms';
import { isRendered, renderConsent } from '@/lib/compliance/disclosures';
import { MAILING_ADDRESS_MAX } from '@/lib/mailing-address';
import { cn, dayInZone, fmtDate, isUuid } from '@/lib/util';
import { saveAgreementAction } from './agreement-actions';

type Ctx = Awaited<ReturnType<typeof requireStaff>>;
const str = (v: unknown) => (typeof v === 'string' ? v : '');

/**
 * Settings → Client agreement: the agency's terms for the service agreement its clients sign. The agreement itself is
 * built from them with fixed parts the agency cannot change (src/lib/compliance/disclosures.ts): the no-guarantee
 * paragraph, the no-payment-before-service sentence, the § 1679d(b)(4) statement in bold above the signature and the
 * Notice of Cancellation. Shown to owners and admins (the page checks settings:manage).
 */
export async function AgreementSection({ ctx }: { ctx: Ctx }) {
  const d = await ctx.tx(async (db) => {
    const agency = await loadAgency(db, ctx.orgId);
    const raw = (agency.settings.agreement ?? {}) as Record<string, unknown>;
    const by = isUuid(agency.terms?.updatedBy) ? await db.row<{ full_name: string }>('select full_name from public.users where id = $1', [agency.terms!.updatedBy]) : null;
    return { agency, raw, by: by?.full_name ?? null };
  });
  const { agency, raw } = d;
  const t = agency.terms;
  // Terms saved before a check was added (or edited by hand) read as not saved: say what to change instead.
  const stale = t ? null : savedTermsIssue(agency.settings);
  const total = typeof raw.total_cents === 'number' ? (raw.total_cents / 100).toFixed(2) : '';
  // What a client would see today, with a sample name, so the agency can read the whole agreement before anyone signs.
  const preview = t ? renderConsent('croa_contract', { agencyName: t.legalName, terms: t, clientName: 'Sample Client', today: dayInZone(agency.tz) }) : null;
  return (
    <Section id="agreement" title="Client agreement" className="mt-8 scroll-mt-28"
      hint="The terms of the service agreement your clients sign, in the portal or on paper. Federal law (15 U.S.C. § 1679d(b)) requires each of these.">
      <div className="mb-5"><Notice tone="warn" title="A starting point, not legal advice">This text is a starting point. Have your attorney review the whole agreement before you use it with clients: federal law sets the minimum, and several states add their own rules (registration, a surety bond, a longer cancellation period, required wording). Your attorney’s text can go under Additional terms.</Notice></div>
      <p className="mb-4 text-sm">{t ? <>Saved{t.updatedAt ? ` ${fmtDate(t.updatedAt)}` : ''}{d.by ? ` by ${d.by}` : ''}. Clients can sign the service agreement.</>
        : stale ? <strong className="font-semibold text-warn">Your saved terms no longer pass the checks, so no client can sign the service agreement until you change them. {stale}</strong>
          : <strong className="font-semibold text-warn">Not saved yet: no client can sign the service agreement until these terms are saved.</strong>}</p>
      <ActionForm action={saveAgreementAction} className="grid gap-4 lg:grid-cols-2">
        <Field label="Legal business name" name="legalName" required maxLength={TERMS_LIMITS.legalName[1]} defaultValue={str(raw.legal_name) || agency.name} hint="As registered. It names the parties and goes on the Notice of Cancellation." />
        <Field label="Principal business address" name="address" required maxLength={MAILING_ADDRESS_MAX} defaultValue={str(raw.address) || str(agency.settings.lead_mailing_address)} placeholder="500 Bayshore Blvd, Suite 210, Tampa, FL 33606" hint="The street address of your main place of business, through state and ZIP. It is printed in the agreement and in its Notice of Cancellation, where a client mails or delivers a notice. A PO Box is accepted, but some states expect a physical address: have your attorney confirm your state’s rules." />
        <TextArea label="Services" name="services" required rows={6} maxLength={TERMS_LIMITS.services[1]} defaultValue={str(raw.services)} className="lg:col-span-2"
          hint="A full and detailed description of what you will do (§ 1679d(b)(2)). Describe the work, never a result. Every field is checked for common promises (removing or deleting items on a credit report, a score change, approval for credit, results in a set time); how you delete your own records, such as a client’s documents, may be stated. The check is a list of rules, not a legal review, so read the text with your attorney." />
        <TextArea label="Payment terms" name="paymentTerms" required rows={4} maxLength={TERMS_LIMITS.paymentTerms[1]} defaultValue={str(raw.payment_terms)}
          hint="When and how the client pays (§ 1679d(b)(1)). No payment may be asked for or taken before the service it pays for is fully performed (§ 1679b(b)): a fee at signing or on the day you sign, within days of signing or of the effective date, today, up front or in advance, before the work starts, at the start of a month for that month’s work, a deposit or a setup or enrollment fee is refused. Charge each payment after the work it pays for, for example at the end of each month for the work performed that month." />
        <div className="space-y-4">
          <Field label="Total of all payments (USD)" name="total" required inputMode="decimal" defaultValue={total} placeholder="594.00" hint="Everything the client will pay under the agreement, to you or anyone else. A client on another plan can have their own payment terms and total, set on their client page before they sign." />
          <Field label="How long the services should take" name="duration" required maxLength={TERMS_LIMITS.duration[1]} defaultValue={str(raw.duration)} placeholder="About 6 months from the date you sign" hint="An estimate of the time needed (§ 1679d(b)(2)(B))." />
        </div>
        <TextArea label="Additional terms (optional)" name="additional" rows={5} maxLength={TERMS_LIMITS.additional[1]} defaultValue={str(raw.additional)} className="lg:col-span-2"
          hint="Your attorney’s text, printed after the fixed parts. It cannot remove or change them." />
        <div className="lg:col-span-2"><SubmitButton>Save client agreement</SubmitButton></div>
      </ActionForm>
      <div className="mt-6 border-t border-line pt-4 text-sm">
        <p className="font-medium">Every agreement also carries, word for word:</p>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-muted">
          <li>the parties (your legal name and address, the client’s name) and the date;</li>
          <li>a no-guarantee paragraph: no promise of removal or of a score change, and accurate, current and verifiable information cannot be removed;</li>
          <li>that no payment is asked for or accepted before the service is fully performed;</li>
          <li>right above the client’s signature, in bold, the statement of § 1679d(b)(4);</li>
          <li>the Notice of Cancellation of § 1679e(b), in bold, with your name, your address and the last day of the cancellation period filled in.</li>
        </ul>
        <p className="mt-2 text-muted">Clients sign, in this order: the consent to electronic records, the Consumer Credit File Rights statement (§ 1679c), this agreement, and the authorization to review their reports and dispute. The exact text each one saw is kept with their signature.</p>
        <p className="mt-2 text-muted">The payment terms and total above go into every client’s agreement, except for a client whose own payment terms and total an owner, admin or manager set on the client page (Agreement payment terms) before they sign.</p>
      </div>
      {preview && isRendered(preview) && (
        <details className="mt-4">
          <summary className="link cursor-pointer text-sm">Read the agreement as a client sees it today (sample client)</summary>
          <div lang="en" className="mt-3 max-h-[32rem] space-y-3 overflow-y-auto rounded-xl bg-raised p-4 text-sm leading-relaxed">
            <p className="font-semibold">{preview.doc.title}</p>
            {preview.blocks.map((b, i) => <p key={i} className={cn('whitespace-pre-wrap [overflow-wrap:anywhere]', b.bold && 'font-bold')}>{b.text}</p>)}
          </div>
        </details>
      )}
    </Section>
  );
}
