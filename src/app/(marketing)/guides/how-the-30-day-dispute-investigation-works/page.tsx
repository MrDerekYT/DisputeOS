import type { Metadata } from 'next';
import { GuideFrame } from '@/components/marketing-site';
import { PRODUCT } from '@/lib/product';
import { guideBySlug, guidePath, pageMeta, type Faq } from '@/lib/site';

const SLUG = 'how-the-30-day-dispute-investigation-works';
const g = guideBySlug(SLUG);

export const generateMetadata = (): Metadata => pageMeta({ title: `${g.title} | ${PRODUCT.name}`, description: g.description, path: guidePath(SLUG), type: 'article' });

const FAQS: Faq[] = [
  { q: 'When does the 30 days start?', a: 'On the day the credit bureau receives the dispute, not the day it was written or mailed. That is why agencies record a delivery date, and why certified mail with tracking is common.' },
  { q: 'When is the deadline 45 days instead of 30?', a: 'In two situations: when the consumer sends additional relevant information during the 30 days, the bureau may take up to 15 more; and when the dispute follows a free annual report from AnnualCreditReport.com, the bureau has 45 days from the start.' },
  { q: 'What if the bureau does not answer in time?', a: 'An item the bureau cannot verify within the period must be deleted or corrected. A missed deadline does not prove that happened, so check an updated report and keep your dated records before taking the next step.' },
  { q: 'Can the same dispute be sent again?', a: 'A bureau may treat a repeat dispute with no new information as frivolous and decline to investigate it. A further round should add something: a new document, a new fact, or a different, accurate reason.' },
];

export default function Guide() {
  return (
    <GuideFrame slug={SLUG} faqs={FAQS}
      productNote={`${PRODUCT.name} starts each dispute’s clock from the recorded receipt date, applies the 30 or 45 day period, and draws every open dispute as a window against today so the next deadline is always visible. A further round cannot be opened without new information.`}>
      <h2>The short version</h2>
      <p>
        When a consumer disputes an item with a credit bureau, the Fair Credit Reporting Act gives the bureau <strong>30 days from the day it receives the dispute</strong> to
        carry out a reasonable reinvestigation and record the result. The rule is in section 611 of the Act (15 U.S.C. § 1681i). Most of what an agency needs to track follows from that one sentence.
      </p>

      <h2>What happens inside the window</h2>
      <ol>
        <li><strong>The bureau receives the dispute.</strong> The clock starts here. Keep proof of the date: a certified mail receipt, a tracking record, or the confirmation from the bureau’s online form.</li>
        <li><strong>Within five business days, the bureau notifies the furnisher.</strong> The furnisher is the company that reported the item, such as a lender or a collection agency. The bureau must pass along all the relevant information the consumer supplied.</li>
        <li><strong>The furnisher investigates and reports back.</strong> It must review the information it was sent and tell the bureau whether the item is accurate, needs correcting, or cannot be verified.</li>
        <li><strong>The bureau records the result.</strong> Information found to be inaccurate, incomplete or unverifiable must be corrected or deleted.</li>
        <li><strong>Within five business days of finishing, the bureau sends the results in writing.</strong> The consumer also gets a free copy of the report if the dispute changed it.</li>
      </ol>

      <h2>When 30 days becomes 45</h2>
      <p>There are two separate reasons the period can be longer, and they are easy to mix up.</p>
      <ul>
        <li><strong>More information arrives during the investigation.</strong> If the consumer sends additional relevant information within the 30 days, the bureau may extend the period by up to 15 days. The extension does not apply if the item has already been found inaccurate or unverifiable.</li>
        <li><strong>The dispute follows a free annual report.</strong> When a consumer disputes after getting the free yearly report through AnnualCreditReport.com, the bureau has 45 days from receipt.</li>
      </ul>
      <p>If neither applies, plan around 30 days.</p>

      <h2>Deadlines at a glance</h2>
      <div className="table-wrap mt-5">
        <table className="table">
          <thead><tr><th scope="col">Step</th><th scope="col">Time allowed</th><th scope="col">Counted from</th></tr></thead>
          <tbody>
            <tr><td>Bureau notifies the furnisher</td><td>5 business days</td><td>Receipt of the dispute</td></tr>
            <tr><td>Bureau completes the reinvestigation</td><td>30 days (45 in the two cases above)</td><td>Receipt of the dispute</td></tr>
            <tr><td>Bureau sends written results</td><td>5 business days</td><td>Completing the reinvestigation</td></tr>
            <tr><td>Bureau gives notice that it will not investigate a frivolous dispute</td><td>5 business days</td><td>Making that decision</td></tr>
            <tr><td>Bureau gives notice that a deleted item was put back</td><td>5 business days</td><td>The reinsertion</td></tr>
          </tbody>
        </table>
      </div>

      <h2>Disputes the bureau may decline</h2>
      <p>
        A bureau can end a reinvestigation if it reasonably decides the dispute is frivolous or irrelevant, for example because the consumer did not give enough information to investigate.
        It must say so within five business days and explain what is missing. Sending the same dispute again with nothing new is the usual way to end up here.
      </p>
      <p>
        This is also where agencies get into trouble with regulators. Disputing every negative item regardless of accuracy, or sending letters that misstate facts, is the conduct the
        Credit Repair Organizations Act prohibits. Dispute what the client believes is inaccurate, say why, and attach what supports it.
      </p>

      <h2>After the result</h2>
      <ul>
        <li><strong>If the item was corrected or deleted,</strong> the consumer can ask the bureau to send the corrected report to anyone who received it in the past six months (two years for employment purposes).</li>
        <li><strong>If the item was verified,</strong> the consumer may add a brief statement of dispute to the file, and may ask the bureau to describe how it verified the item.</li>
        <li><strong>A deleted item can come back</strong> only if the furnisher certifies it is complete and accurate, and the bureau must tell the consumer in writing within five business days.</li>
        <li><strong>The consumer can also dispute directly with the furnisher.</strong> Furnishers have their own duty to investigate, on the same 30-day timetable.</li>
      </ul>

      <h2>What to record on every dispute</h2>
      <ul>
        <li>The item, the bureau, and the specific reason it is believed to be inaccurate.</li>
        <li>The date sent, the method, and the tracking reference.</li>
        <li>The date the bureau received it, which is the date the clock runs from.</li>
        <li>Whether the 30 or 45 day period applies, and the resulting deadline.</li>
        <li>The response: the date it arrived, what it said, and a copy.</li>
        <li>What new information justifies any further round.</li>
      </ul>
      <p>With those six things on file, you can answer a client’s “where are we?” in one sentence, and show your work if anyone asks later.</p>
    </GuideFrame>
  );
}
