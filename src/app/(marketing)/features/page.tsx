import Link from 'next/link';
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { AiTag, DayMeter } from '@/components/ui';
import { Band, CtaBand, JsonLd, PageIntro } from '@/components/marketing-site';
import { AI_COSTS, AI_FEATURE_LABEL, type AiFeature } from '@/lib/ai/credits';
import { PRODUCT } from '@/lib/product';
import { breadcrumbLd, pageMeta } from '@/lib/site';

export const generateMetadata = (): Metadata => pageMeta({
  title: `Credit Repair Software Features: Reports, Disputes, Letters, Portal | ${PRODUCT.name}`,
  description: 'What the product does today: report import and review, three-bureau comparison, findings, a dispute and letter workflow with human approval, investigation windows, a client portal in English and Spanish, leads, AI wording billed in credits, and an audit log.',
  path: '/features',
});

const JUMP = [
  ['#reports', 'Reports'], ['#disputes', 'Disputes and letters'], ['#deadlines', 'Deadlines'], ['#ai', 'AI'], ['#portal', 'Client portal'],
  ['#leads', 'Leads'], ['#team', 'Team and controls'], ['#manual', 'What is manual'],
] as const;

function Points({ items }: { items: [string, ReactNode][] }) {
  return (
    <dl className="grid gap-x-12 gap-y-8 md:grid-cols-2 lg:grid-cols-3">
      {items.map(([t, b]) => (
        <div key={t}>
          <dt className="font-semibold">{t}</dt>
          <dd className="mt-1.5 text-[0.9375rem] leading-relaxed text-muted">{b}</dd>
        </div>
      ))}
    </dl>
  );
}

const DAY = 86_400_000;

export default function FeaturesPage() {
  // Sample windows for the picture below, counted from the moment the page is served.
  const now = new Date();
  const iso = (offsetDays: number) => new Date(now.getTime() + offsetDays * DAY).toISOString();
  const samples: { label: string; dueAt: string | null }[] = [
    { label: 'Inside the window', dueAt: iso(18) },
    { label: 'Past its deadline', dueAt: iso(-6) },
    { label: 'Not submitted yet', dueAt: null },
  ];
  return (
    <>
      <PageIntro title="What it does today, without the brochure language."
        lede={`${PRODUCT.name} takes a credit repair agency from a client’s first enquiry to a resolved dispute. This page lists what is built, and ends with what your team still does by hand.`}>
        <nav aria-label="On this page" className="mt-8 flex flex-wrap gap-2">
          {JUMP.map(([href, label]) => <a key={href} href={href} className="btn-quiet btn-sm">{label}</a>)}
        </nav>
      </PageIntro>

      <Band id="reports" title="Reports: import, review, compare."
        lede="A report is never analysed until a person has checked what was read from it.">
        <Points items={[
          ['Import by upload or API', 'Upload a text-based PDF, an HTML or text report, or the CSV template. Agencies with their own systems can push reports through the REST API.'],
          ['Confidence on every field', 'Accounts, balances, dates and payment history are extracted with a confidence level per field, so a reviewer knows where to look first.'],
          ['Three bureaus, side by side', 'Experian, Equifax and TransUnion are lined up account by account. Where they differ, the difference is shown with the values behind it.'],
          ['Findings, not verdicts', 'Each difference becomes a finding labelled as a reported fact, client-provided or a potential discrepancy. Nothing is called “inaccurate” automatically.'],
          ['Reported score history', 'Scores that appear on imported reports are kept over time, exactly as reported. Nothing is predicted.'],
          ['An action plan from the client’s own records', 'A short list of next steps built from what is on file: missing consents, reports to review, findings to look at. Same input, same plan.'],
        ]} />
      </Band>

      <Band id="disputes" title="Disputes and letters: a person approves everything."
        lede="Draft, ready for review, approved, submitted, under investigation, response received, resolved. Each step is recorded with who did it.">
        <Points items={[
          ['One item, one reason, its evidence', 'A dispute is tied to a specific item and reason. Several findings can be drafted at once; each stays a draft until someone reviews it.'],
          ['Consent before submission', 'A dispute cannot be submitted until the client’s disclosure, contract and authorization are on file, each with a timestamp.'],
          ['Letters from editable templates', 'A library of letters, one per situation, grouped by who they go to, with live merge fields, a preview, PDF export and version history. Letters are written in English; the client portal is in English and Spanish.'],
          ['Manager approval of the exact text', 'A letter needs a manager’s approval. Editing an approved letter voids the approval and returns it to draft.'],
          ['Another round needs something new', 'A second or later round requires new information, so the same dispute is not simply sent again.'],
          ['A claims guard', 'Guarantees, promised deletions, score promises and “new credit identity” language are rejected in templates, automations and AI output, and flagged in staff-written text.'],
        ]} />
      </Band>

      <Band id="deadlines" title="Deadlines you can see."
        lede="Every submitted dispute is drawn as its investigation window: the days elapsed are solid, the days left are outlined, days past the deadline are hatched, and a line marks today. The words beside the bar always say the same thing.">
        <div className="panel max-w-3xl px-5 py-2 sm:px-6">
          <ul className="divide-y divide-line/70">
            {samples.map((s) => (
              <li key={s.label} className="grid gap-x-6 gap-y-2 py-4 sm:grid-cols-[11rem_1fr] sm:items-center">
                <span className="font-semibold">{s.label}</span>
                <DayMeter dueAt={s.dueAt} extended={false} now={now} />
              </li>
            ))}
          </ul>
        </div>
        <p className="mt-3 text-[0.8125rem] text-faint">Sample dates, counted from today. In the product these come from each dispute’s recorded receipt date and deadline.</p>
        <div className="mt-10">
          <Points items={[
            ['30 and 45 day clocks', 'The window is counted from the date the bureau received the dispute, with the longer clock where it applies.'],
            ['One calendar for the whole book', 'The dashboard shows every open window together, so the dispute closest to its deadline is the first thing you see.'],
            ['Follow-up tasks', 'Due and overdue responses create tasks for the team. Client-facing automations wait in an inbox until a person releases them.'],
          ]} />
        </div>
      </Band>

      <Band id="ai" title={<span className="flex flex-wrap items-center gap-x-3 gap-y-2">AI you can check <AiTag>AI</AiTag></span>}
        lede="AI is optional and narrow. It rewords what is already on file; it does not decide what to dispute and it does not send anything. Wherever a model wrote or suggested something, it carries this mark.">
        <Points items={[
          ['Before and after, side by side', 'A suggestion is shown beside the current text with the changed lines marked, and nothing changes until you accept it. If the output changes a number or a date, or contains a blocked claim, it is discarded.'],
          ['Only wording goes to the AI', 'A letter reaches the AI provider as its greeting, linking sentence and closing, with every fact replaced by a marker; a progress note as its connective sentences, without the client’s name. A credit-guide question is sent with the client’s own details on file, known names, and the common written forms of contact details, Social Security and account numbers, dates, street addresses and amounts masked; anything else typed into it, or written another way, is sent as written.'],
          ['Works with AI switched off', 'With no provider or no credits, letters and notes use the standard wording and nothing is charged.'],
        ]} />
        <div className="mt-10 max-w-xl">
          <h3 className="font-semibold">What a credit buys</h3>
          <table className="mt-3 w-full text-left text-[0.9375rem]">
            <caption className="sr-only">AI credits used per result</caption>
            <thead><tr className="border-b border-line text-[0.8125rem] text-muted"><th scope="col" className="py-2 font-medium">AI result</th><th scope="col" className="py-2 text-right font-medium">Credits</th></tr></thead>
            <tbody>
              {(Object.keys(AI_COSTS) as AiFeature[]).map((k) => (
                <tr key={k} className="border-b border-line/60"><th scope="row" className="py-2.5 font-normal">{AI_FEATURE_LABEL[k]}</th><td className="py-2.5 text-right font-semibold">{AI_COSTS[k]}</td></tr>
              ))}
            </tbody>
          </table>
          <p className="mt-3 text-sm text-muted">Credits are taken only when a result is returned to you. A failed or discarded attempt is refunded. <Link href="/pricing" className="link">Credit allowances by plan</Link></p>
        </div>
      </Band>

      <Band id="portal" title="A client portal under your name."
        lede="Clients sign in to your brand, not ours. Each one sees only their own record, enforced by the database.">
        <Points items={[
          ['One clear next step', 'The home screen opens with what happens now: something to sign, a document to upload, or how far into the investigation window a dispute is.'],
          ['English and Spanish', 'Every status, date and explanation exists in both languages. The language is set per client.'],
          ['Sign, upload, message', 'Agreements are signed by typed name with the time and a hash of the text shown. Documents upload from a phone and are stored encrypted.'],
          ['Their rights, stated plainly', 'The portal explains free weekly reports, the right to dispute on their own at no cost, and the three-day cancellation right.'],
          ['Approved letters only', 'Clients can read the letters sent on their behalf once those letters are approved.'],
          ['A credit guide', 'Clients can ask how credit reporting works. Answers come from a vetted knowledge base; the guide does not promise results.'],
        ]} />
      </Band>

      <Band id="leads" title="Leads, with consent."
        lede="A public enquiry form per agency, and follow-up that respects an opt-out.">
        <Points items={[
          ['A branded enquiry form', 'Contact details and what the person is working toward. Consent is required, and submissions are rate limited.'],
          ['Sources you can count', 'Add a tag to the link you share and the Leads page shows how many enquiries each source produced.'],
          ['Follow-up email', 'A welcome and two follow-ups, sent only when you switch it on and an email service is connected. Every message carries an opt-out link and your postal address.'],
        ]} />
      </Band>

      <Band id="team" title="Team and controls."
        lede="Enough structure for an owner to know who did what.">
        <Points items={[
          ['Four staff roles', 'Owner, admin, manager and specialist, each with its own permissions. Clients are a fifth role that only reaches the portal.'],
          ['Audit log', 'An append-only record of actions. Entries cannot be edited or deleted, even by the application itself.'],
          ['Tenant isolation in the database', 'PostgreSQL row-level security separates one agency from another and one client from another.'],
          ['Two-step verification', 'Authenticator-app codes for any account; an agency can make them mandatory for staff.'],
          ['Export and deletion', 'Export one client’s data as JSON, or delete a client permanently after a typed confirmation.'],
          ['REST API', 'Scoped API keys, an OpenAPI description and idempotent report push for agencies that integrate their own tools.'],
        ]} />
        <p className="mt-8"><Link href="/security" className="link">Security in detail</Link></p>
      </Band>

      <Band id="manual" title="What your team still does by hand."
        lede="We would rather you read this here than find it during the trial.">
        <ul className="grid gap-x-12 gap-y-5 md:grid-cols-2">
          {[
            ['Getting reports', 'There is no live connection to a bureau or monitoring service. Reports are uploaded or pushed through the API. Scanned, image-only reports are not read.'],
            ['Mailing letters', 'The product produces the approved PDF. A person mails it and records the date, method and tracking number.'],
            ['Taking payments', 'There is no card processing. Payments collected elsewhere are recorded by hand, after confirming the service was already performed.'],
            ['Texting clients', 'SMS is not built. Calls and texts made from your own phone can be logged on the client’s record.'],
          ].map(([t, b]) => <li key={t} className="border-t border-line pt-4"><span className="font-semibold">{t}.</span> <span className="text-muted">{b}</span></li>)}
        </ul>
      </Band>

      <CtaBand />
      <JsonLd data={breadcrumbLd([{ name: 'Home', path: '/' }, { name: 'Features', path: '/features' }])} />
    </>
  );
}
