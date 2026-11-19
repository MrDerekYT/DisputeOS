import type { Metadata } from 'next';
import { GuideFrame } from '@/components/marketing-site';
import { PRODUCT } from '@/lib/product';
import { guideBySlug, guidePath, pageMeta, type Faq } from '@/lib/site';

const SLUG = 'how-to-read-a-credit-report';
const g = guideBySlug(SLUG);

export const generateMetadata = (): Metadata => pageMeta({ title: `${g.title} | ${PRODUCT.name}`, description: g.description, path: guidePath(SLUG), type: 'article' });

const FAQS: Faq[] = [
  { q: 'Where does a consumer get free credit reports?', a: 'At AnnualCreditReport.com, the site the three nationwide bureaus run to meet their legal duty. Each bureau currently offers a free report there every week.' },
  { q: 'Is a credit score part of the credit report?', a: 'No. A report is the record; a score is a number a scoring company calculates from that record. Free reports from AnnualCreditReport.com do not include a score.' },
  { q: 'Why do the three reports differ?', a: 'Each bureau keeps its own file, and not every creditor reports to all three or on the same day. A difference is a reason to look closer, not proof that one of them is wrong.' },
  { q: 'Does paying a collection remove it?', a: 'Not by itself. A paid collection can stay for the same seven-year period, shown as paid. The three bureaus have chosen to stop reporting paid medical collections, which is a bureau policy and not a general rule for other debts.' },
];

export default function Guide() {
  return (
    <GuideFrame slug={SLUG} faqs={FAQS}
      productNote={`${PRODUCT.name} reads accounts, balances, dates and payment history from an uploaded report, shows its confidence for each field so a person can check it, then lines up the three bureaus account by account. Differences become findings for review; nothing is labelled inaccurate automatically.`}>
      <h2>Three reports, not one</h2>
      <p>
        Experian, Equifax and TransUnion each keep their own file on a consumer. The layout differs between them and between the services that resell their data, but every
        report has the same five parts. Read all three before forming a view: what matters is often the difference between them.
      </p>

      <h2>1. Personal information</h2>
      <p>Names, current and past addresses, date of birth, part of the Social Security number, and sometimes employers. None of it affects a score, but it is worth checking carefully.</p>
      <ul>
        <li>A name variation or an address the client never lived at can be a sign that someone else’s account has been mixed into the file.</li>
        <li>Ask the client about anything unfamiliar before assuming it is an error. People forget old addresses.</li>
      </ul>

      <h2>2. Accounts</h2>
      <p>Also called tradelines. This is most of the report: credit cards, loans, mortgages and other accounts. For each one, look at:</p>
      <ul>
        <li><strong>Who reports it and what kind of account it is.</strong> Revolving (cards), installment (loans), mortgage, or open.</li>
        <li><strong>Whose account it is.</strong> Individual, joint, or authorized user.</li>
        <li><strong>Date opened, credit limit or original amount, and current balance.</strong></li>
        <li><strong>Status.</strong> Open, closed, paid, charged off, in collection.</li>
        <li><strong>Payment history.</strong> A month-by-month grid showing on time, or 30, 60, 90 or more days late.</li>
        <li><strong>Date last reported.</strong> How fresh the information is.</li>
        <li><strong>Date of first delinquency</strong> on negative accounts. This date, not the date of the last payment or the date a collector bought the debt, controls how long the item can stay.</li>
      </ul>

      <h2>3. Collections</h2>
      <p>
        When an original creditor gives up on a debt it may assign or sell it to a collection agency, which can report it as a separate account. One debt can therefore appear
        twice: once from the original creditor and once from the collector. That is allowed, as long as the balance is not counted as owed to both and the dates carry over
        correctly. A collection account should show who the original creditor was.
      </p>

      <h2>4. Public records</h2>
      <p>
        Today this section is almost always about bankruptcy. The three bureaus stopped including civil judgments and tax liens in 2017 and 2018, so those should not appear on
        a current report from them.
      </p>

      <h2>5. Inquiries</h2>
      <ul>
        <li><strong>Hard inquiries</strong> come from applications for credit. They are visible to lenders and stay for two years.</li>
        <li><strong>Soft inquiries</strong> come from the consumer checking their own file, existing creditors reviewing an account, and prescreened offers. Only the consumer sees them.</li>
      </ul>
      <p>An inquiry the client really authorised is accurate, even if they regret the application.</p>

      <h2>How long information stays</h2>
      <div className="table-wrap mt-5">
        <table className="table">
          <thead><tr><th scope="col">Item</th><th scope="col">Usual limit</th><th scope="col">Counted from</th></tr></thead>
          <tbody>
            <tr><td>Late payments</td><td>7 years</td><td>The date of the late payment</td></tr>
            <tr><td>Charge-offs and collections</td><td>7 years</td><td>180 days after the date of first delinquency</td></tr>
            <tr><td>Chapter 7 bankruptcy</td><td>10 years</td><td>The filing date</td></tr>
            <tr><td>Chapter 13 bankruptcy</td><td>7 years, by bureau practice</td><td>The filing date</td></tr>
            <tr><td>Hard inquiries</td><td>2 years</td><td>The date of the inquiry</td></tr>
            <tr><td>Accounts closed in good standing</td><td>Up to 10 years, by bureau practice</td><td>The date closed</td></tr>
          </tbody>
        </table>
      </div>
      <p>The seven and ten year limits come from section 605 of the Fair Credit Reporting Act (15 U.S.C. § 1681c). Selling a debt to a new collector does not restart the clock.</p>

      <h2>What to compare across the three bureaus</h2>
      <p>Line the same account up on all three reports and check that these agree:</p>
      <ul>
        <li>Balance and credit limit.</li>
        <li>Status, and whether it is shown as open or closed.</li>
        <li>Date opened and date of first delinquency.</li>
        <li>The payment history grid, month by month.</li>
        <li>Whether the account appears at all.</li>
      </ul>
      <p>
        A difference is a question, not an answer. Reporting dates differ, and a creditor may report to one bureau and not another. Ask the client what they know, look at
        their statements, and only then decide whether something is inaccurate and worth disputing.
      </p>

      <h2>What you will not find</h2>
      <ul>
        <li><strong>A credit score.</strong> Scores are calculated from the report and sold or provided separately.</li>
        <li><strong>Income, bank balances or savings.</strong></li>
        <li><strong>Race, religion, medical history or criminal record.</strong></li>
      </ul>

      <h2>Before anyone disputes anything</h2>
      <ol>
        <li>Get all three reports. They are free at AnnualCreditReport.com.</li>
        <li>Confirm the personal information with the client.</li>
        <li>Go through each account with the client and mark what they believe is wrong, and why.</li>
        <li>Collect what supports it: statements, letters, payment confirmations.</li>
        <li>Dispute only those items, with the specific reason. Accurate information that is still within its reporting period stays.</li>
      </ol>
    </GuideFrame>
  );
}
