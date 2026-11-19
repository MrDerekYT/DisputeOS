import type { Metadata } from 'next';
import { GuideFrame } from '@/components/marketing-site';
import { PRODUCT } from '@/lib/product';
import { guideBySlug, guidePath, pageMeta, type Faq } from '@/lib/site';

const SLUG = 'how-to-start-a-credit-repair-business';
const g = guideBySlug(SLUG);

export const generateMetadata = (): Metadata => pageMeta({ title: `${g.title} | ${PRODUCT.name}`, description: g.description, path: guidePath(SLUG), type: 'article' });

const FAQS: Faq[] = [
  { q: 'Can I charge a setup or first-work fee?', a: 'Not before the work it pays for is done. CROA bars a credit repair organization from charging or receiving money for a service before that service is fully performed. Calling an advance payment a setup, audit or first-work fee does not change that.' },
  { q: 'Do I need a license to start a credit repair business?', a: 'There is no federal license. Many states require credit services organizations to register and post a surety bond, and some add contract terms or restrict fees further. Check with your state attorney general or financial regulator before taking a client.' },
  { q: 'Can a client waive the three-day cancellation right?', a: 'No. CROA says any waiver of its protections is void and cannot be enforced, and that trying to obtain one is itself a violation.' },
  { q: 'Can I promise a client a result?', a: 'No. Nobody can lawfully remove accurate, current, verifiable information from a credit report, and a promise of a specific outcome is the kind of misleading statement CROA prohibits. Describe the work you will do, not the result.' },
];

export default function Guide() {
  return (
    <GuideFrame slug={SLUG} faqs={FAQS}
      productNote={`${PRODUCT.name} keeps a consent ledger for the disclosure, contract and authorization, blocks dispute submission until all three are on file, warns inside the three-business-day cancellation window, and asks you to confirm a service was already performed before a payment is recorded. The consent documents it ships with are reference drafts for your attorney to review.`}>
      <h2>Start with the law, not the logo</h2>
      <p>
        The business side of a credit repair company is ordinary: a legal entity, a bank account, a way to find clients. What makes this industry different is that a federal
        statute, the <strong>Credit Repair Organizations Act</strong> (CROA, 15 U.S.C. § 1679 and following), governs the first conversation you have with every client. Get
        these five things right before you take anyone on.
      </p>

      <h2>1. Give the required disclosure first</h2>
      <p>
        Before any contract is signed, you must give the consumer a written statement titled “Consumer Credit File Rights Under State and Federal Law.” The wording is set
        out in the statute and should be used as written. It tells the consumer that they can dispute inaccurate information themselves for free, that accurate negative
        information generally cannot be removed, and that they can cancel your contract within three business days.
      </p>
      <ul>
        <li>It must be a separate document, not a paragraph inside the contract.</li>
        <li>Keep a copy signed by the consumer, acknowledging they received it, for two years.</li>
      </ul>

      <h2>2. Use a written contract with the required terms</h2>
      <p>No services may be provided until there is a written, dated contract signed by the consumer. It must include:</p>
      <ul>
        <li>The terms and conditions of payment, including the total of all payments.</li>
        <li>A full, detailed description of the services you will perform, including any guarantees of performance and an estimate of the date the work will be finished or how long it will take.</li>
        <li>Your business name and principal business address.</li>
        <li>A conspicuous statement in bold type, next to the signature line, that the consumer may cancel without penalty or obligation before midnight of the third business day after signing.</li>
      </ul>

      <h2>3. Honour the three-business-day cancellation right</h2>
      <p>
        The consumer may cancel for any reason before midnight of the third business day after signing. The contract must come with a “Notice of Cancellation” form, in
        duplicate, that they can sign and return. <strong>Do not start work during those three days.</strong> The statute does not allow services to begin until the period has passed.
      </p>

      <h2>4. Do not take payment before the work is done</h2>
      <p>
        This is the rule that shapes your pricing. A credit repair organization may not charge or receive money or anything of value for a service before that service is
        <strong> fully performed</strong>. In practice agencies bill in arrears: for work completed in the previous period, or per completed service.
      </p>
      <p>
        If you sell by phone, the FTC’s Telemarketing Sales Rule is stricter still. It bars requesting payment until the promised time frame has passed and you have given the
        consumer a credit report, issued more than six months after the results were achieved, showing those results. Ask your attorney whether the way you sell is covered.
      </p>

      <h2>5. Never mislead a bureau, a creditor or a client</h2>
      <p>CROA prohibits, for you and for anything you advise a client to do:</p>
      <ul>
        <li>Making an untrue or misleading statement to a credit bureau or a creditor about the consumer’s creditworthiness.</li>
        <li>Advising a consumer to change their identification to hide accurate information. This is what “new credit identity” and CPN schemes are.</li>
        <li>Making an untrue or misleading statement about your own services.</li>
        <li>Any act that amounts to fraud or deception in offering or selling credit repair.</li>
      </ul>
      <p>
        The practical rule: dispute only what the client believes is inaccurate or incomplete, say truthfully why, and never tell a client an outcome is certain. Regulators
        have penalised companies for disputing every negative item regardless of accuracy.
      </p>

      <h2>What your state may add</h2>
      <p>
        CROA is the floor. Many states have their own credit services organization laws, and they vary a great deal. Common additions are registration with the state, a
        surety bond, extra contract wording, a longer cancellation period and tighter limits on fees. A few states restrict the business much more heavily. If you serve
        clients in more than one state, each client’s state matters, not only yours.
      </p>
      <p>Two places to confirm what applies: your state attorney general’s consumer protection office, and an attorney who works with consumer finance businesses.</p>

      <h2>A first-month checklist</h2>
      <ol>
        <li>Form the business and open a separate bank account.</li>
        <li>Find out whether your state, and your clients’ states, require registration or a bond, and complete it before signing anyone.</li>
        <li>Have an attorney review your disclosure, contract and cancellation notice.</li>
        <li>Decide how you will bill after the work is performed, and write that into the contract.</li>
        <li>Write down how you take a client on: disclosure, then contract, then the three-day wait, then work.</li>
        <li>Review your marketing for promises. Remove anything about guaranteed deletions, point increases or time frames you cannot control.</li>
        <li>Choose how you will keep records: signed documents, what was disputed and why, when it was sent and what came back.</li>
      </ol>

      <h2>Why the records matter</h2>
      <p>
        A consumer can sue under CROA for actual damages, punitive damages and attorney’s fees, and the FTC and state attorneys general can enforce it too. The time limit to
        bring a claim is five years. A dated record of what each client was given, signed and charged is the best protection an honest agency has.
      </p>
    </GuideFrame>
  );
}
