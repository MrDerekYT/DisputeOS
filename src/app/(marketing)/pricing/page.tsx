import Link from 'next/link';
import type { Metadata } from 'next';
import { Check, Info } from 'lucide-react';
import { Band, CtaBand, FaqList, JsonLd, PageIntro, WRAP } from '@/components/marketing-site';
import { AI_COSTS, AI_FEATURE_LABEL, type AiFeature } from '@/lib/ai/credits';
import { ADD_ONS, PLANS, TRIAL_DAYS, count, usd } from '@/lib/plans';
import { PRODUCT } from '@/lib/product';
import { abs, breadcrumbLd, pageMeta, type Faq } from '@/lib/site';
import { cn } from '@/lib/util';

export const generateMetadata = (): Metadata => pageMeta({
  title: `Pricing: Credit Repair Software Plans with AI Credits Included | ${PRODUCT.name}`,
  description: `Four plans from ${usd(PLANS[0]!.priceMonthly)} a month. Every plan includes every feature and a monthly AI credit allowance, with seats, clients and credit top-ups priced on the page. ${TRIAL_DAYS}-day trial, no card.`,
  path: '/pricing',
});

const INCLUDED = [
  'Report import, review and three-bureau comparison',
  'Dispute and letter workflow with approvals',
  'Investigation windows and deadline tasks',
  'Branded client portal in English and Spanish',
  'Lead form and consent-based follow-up',
  'Roles, audit log and two-step verification',
];

const FAQS: Faq[] = [
  { q: 'Can I buy a plan today?', a: `Not yet. Billing is not switched on, so there is no checkout and nothing is charged. You can start the ${TRIAL_DAYS}-day trial now; plans are billed once billing is switched on, and you will choose one then.` },
  { q: 'Do the plans differ in features?', a: 'No. Every plan includes every feature. Plans differ only in team seats, active clients and the monthly AI credit allowance.' },
  { q: 'What is an AI credit?', a: 'The unit AI wording is billed in. A credit is used only when an AI result is returned to you; the table on this page shows what each result costs. Everything else in the product uses no credits.' },
  { q: 'What happens if I run out of credits?', a: `AI wording switches off and letters and notes use the standard wording. Nothing else stops. A top-up of ${count(ADD_ONS.creditTopUp.credits)} credits is planned at ${usd(ADD_ONS.creditTopUp.price)}.` },
  { q: 'Does a trial workspace include AI credits?', a: 'A new workspace starts with no AI credits. Until buying credits online is connected, credits are added to a workspace by our team. The rest of the product works without them.' },
  { q: 'Is there a setup fee?', a: 'No. There is no setup fee on any plan.' },
  { q: 'What counts as an active client?', a: 'A client your team is currently working with. Leads, and clients whose work is completed or cancelled, do not count.' },
  { q: 'Is postage included?', a: `No. ${PRODUCT.name} does not mail letters; your team mails the approved PDF and pays postage directly.` },
];

export default function PricingPage() {
  const example = PLANS.find((p) => p.highlight) ?? PLANS[0]!;
  return (
    <>
      <PageIntro title="One price per plan. The AI allowance is on the page."
        lede="Every plan includes every feature. You choose by team size, client count and how much AI wording you expect to use.">
        <p className="mt-6 flex max-w-2xl items-start gap-2.5 rounded-xl bg-info-soft px-4 py-3 text-sm" role="note">
          <Info size={18} aria-hidden className="mt-0.5 shrink-0 text-info" />
          <span>Billing is not switched on yet, so nothing is charged. Plans are billed once billing is switched on; these are the planned prices and may change before then.</span>
        </p>
      </PageIntro>

      <section className={cn(WRAP, 'pt-10')} aria-label="Plans">
        <ul className="grid gap-5 sm:grid-cols-2 xl:grid-cols-4">
          {PLANS.map((p) => (
            <li key={p.key} className={cn('panel flex flex-col p-6', p.highlight && 'ring-2 ring-brand')}>
              <h2 className="display text-2xl">{p.name}</h2>
              <p className="mt-1 text-sm text-muted">{p.blurb}</p>
              <p className="mt-6 flex items-baseline gap-1.5">
                <span className="display text-[2.75rem] leading-none">{usd(p.priceMonthly)}</span>
                <span className="text-sm text-muted">per month</span>
              </p>
              <dl className="mt-6 space-y-3 border-t border-line pt-5 text-[0.9375rem]">
                <div className="flex items-baseline justify-between gap-3"><dt className="text-muted">Team seats</dt><dd className="font-semibold">{count(p.seats)}</dd></div>
                <div className="flex items-baseline justify-between gap-3"><dt className="text-muted">Active clients</dt><dd className="font-semibold">{count(p.activeClients)}</dd></div>
                <div className="flex items-baseline justify-between gap-3"><dt className="text-muted">AI credits each month</dt><dd className="font-semibold">{count(p.aiCredits)}</dd></div>
              </dl>
              <Link href="/signup" className={cn(p.highlight ? 'btn-primary' : 'btn-secondary', 'mt-7 w-full')} aria-label={`Start free trial (${p.name})`}>Start free trial</Link>
            </li>
          ))}
        </ul>
        <p className="mt-5 text-sm text-muted">Prices in US dollars, billed monthly. The trial runs {TRIAL_DAYS} days and needs no card.</p>
      </section>

      <Band title="In every plan.">
        <ul className="grid gap-x-12 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
          {INCLUDED.map((i) => <li key={i} className="flex items-start gap-2.5"><Check size={18} aria-hidden className="mt-0.5 shrink-0 text-brand" />{i}</li>)}
        </ul>
        <p className="mt-8"><Link href="/features" className="link">The full feature list, including what is still manual</Link></p>
      </Band>

      <Band title="If you outgrow a plan." lede="Extras cost the same on every plan, and there is no setup fee.">
        <dl className="grid gap-x-12 gap-y-6 sm:grid-cols-3">
          <div className="border-t border-line pt-4"><dt className="text-muted">Extra team seat</dt><dd className="display mt-1 text-2xl">{usd(ADD_ONS.seatMonthly)} <span className="font-sans text-sm font-normal tracking-normal text-muted">per month</span></dd></div>
          <div className="border-t border-line pt-4"><dt className="text-muted">{count(ADD_ONS.clientBlock.clients)} more active clients</dt><dd className="display mt-1 text-2xl">{usd(ADD_ONS.clientBlock.priceMonthly)} <span className="font-sans text-sm font-normal tracking-normal text-muted">per month</span></dd></div>
          <div className="border-t border-line pt-4"><dt className="text-muted">Top-up of {count(ADD_ONS.creditTopUp.credits)} AI credits</dt><dd className="display mt-1 text-2xl">{usd(ADD_ONS.creditTopUp.price)} <span className="font-sans text-sm font-normal tracking-normal text-muted">one time</span></dd></div>
        </dl>
      </Band>

      <Band id="credits" title="How AI credits work."
        lede="AI is optional. It rewords what is already on file, and a credit is taken only when a result is returned to you. A failed or discarded attempt is refunded.">
        <div className="max-w-xl">
          <table className="w-full text-left text-[0.9375rem]">
            <caption className="sr-only">AI credits used per result</caption>
            <thead><tr className="border-b border-line text-[0.8125rem] text-muted"><th scope="col" className="py-2 font-medium">AI result</th><th scope="col" className="py-2 text-right font-medium">Credits</th></tr></thead>
            <tbody>
              {(Object.keys(AI_COSTS) as AiFeature[]).map((k) => (
                <tr key={k} className="border-b border-line/60"><th scope="row" className="py-2.5 font-normal">{AI_FEATURE_LABEL[k]}</th><td className="py-2.5 text-right font-semibold">{AI_COSTS[k]}</td></tr>
              ))}
            </tbody>
          </table>
          <p className="mt-4 text-sm text-muted">
            For scale: the {example.name} allowance of {count(example.aiCredits)} credits covers {count(Math.floor(example.aiCredits / AI_COSTS.letter_suggestion))} letter wording suggestions in a month.
          </p>
        </div>
      </Band>

      <Band title="Pricing questions."><FaqList faqs={FAQS} /></Band>

      <CtaBand title="Start with the trial." body={`${TRIAL_DAYS} days, no card, every feature. Billing is not switched on, so nothing is charged when the trial ends.`} />

      {/* No `offers` here on purpose: the prices in src/lib/plans.ts are proposed, billing is not connected and nothing can
          be bought yet, so they are not published to search engines as live offers. Add them back (with availability)
          once the owner has confirmed the prices and billing is switched on. */}
      <JsonLd data={{
        '@context': 'https://schema.org', '@type': 'SoftwareApplication', name: PRODUCT.name, url: abs('/pricing'),
        applicationCategory: 'BusinessApplication', operatingSystem: 'Web',
      }} />
      <JsonLd data={breadcrumbLd([{ name: 'Home', path: '/' }, { name: 'Pricing', path: '/pricing' }])} />
    </>
  );
}
