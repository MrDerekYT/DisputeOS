import Link from 'next/link';
import type { Metadata } from 'next';
import type { CSSProperties } from 'react';
import {
  ArrowRight, Ban, Check, Columns3, Compass, FileText, FolderUp, Gavel, History, Home, Hourglass, Languages, ListChecks, LockKeyhole, MessageCircle, MessagesSquare, Palette, Scale,
  ScanSearch, ScrollText, ShieldCheck, Smartphone, Sparkles, UserCheck, UserRound, Users,
} from 'lucide-react';
import { Badge, OrgMark } from '@/components/ui';
import { Band, CtaBand, FaqList, JsonLd, MarketingFrame, WRAP, WindowsIllustration } from '@/components/marketing-site';
import { brandCss } from '@/lib/brand';
import { TRIAL_DAYS } from '@/lib/plans';
import { PRODUCT } from '@/lib/product';
import { pageMeta, siteUrl, type Faq } from '@/lib/site';
import { cn } from '@/lib/util';

const DESCRIPTION =
  'Run a credit repair agency on one platform: report import and three-bureau comparison, a dispute and letter workflow where a person approves everything, investigation deadlines you can see, and a client portal in English and Spanish.';

export const generateMetadata = (): Metadata => pageMeta({
  title: `Credit Repair Software for Agencies | Disputes, Letters & Client Portal | ${PRODUCT.name}`,
  description: DESCRIPTION,
  path: '/',
});

const FEATURES: { icon: typeof Users; title: string; body: string }[] = [
  { icon: Users, title: 'A real client CRM', body: 'One profile per client: contact details, consents, documents, notes, tasks, messages and a full activity timeline. Nothing lives in a spreadsheet.' },
  { icon: ScanSearch, title: 'Three-bureau comparison', body: 'Upload reports and see Experian, Equifax and TransUnion side by side. Differences are flagged for review, never labelled “inaccurate” automatically.' },
  { icon: Gavel, title: 'Dispute pipeline', body: 'Every dispute moves from draft to resolved through named stages, with rounds, evidence, and its 30 or 45 day investigation window drawn against today.' },
  { icon: FileText, title: 'Letter center', body: 'Editable templates, live merge fields, PDF export, version history and a manager approval step. Editing an approved letter sends it back to draft.' },
  { icon: Sparkles, title: 'AI you can check', body: 'A suggestion is shown beside the current text with the changed lines marked, and is thrown away if a number or date changes. It is billed in credits, and a person approves every word.' },
  { icon: MessagesSquare, title: 'A portal clients actually use', body: 'Clients see their progress, upload what you ask for, read approved letters and message you. They can only ever see their own record.' },
];

const STAGES: { name: string; note?: string; human?: boolean }[] = [
  { name: 'Draft' },
  { name: 'In review', note: 'a person reads it', human: true },
  { name: 'Approved', note: 'a named approver', human: true },
  { name: 'Submitted' },
  { name: 'Investigating', note: 'the 30-day window' },
  { name: 'Response' },
  { name: 'Resolved' },
];

const NEVER: string[] = [
  'Promise a score increase or guarantee a deletion',
  'Label an item “inaccurate” just because bureaus differ',
  'Invent identity theft, payment history or any fact',
  'Send a letter without a named human approving it',
  'Let one business, or one client, see another’s records',
];

const FAQS: Faq[] = [
  { q: `Does ${PRODUCT.name} pull credit reports for me?`, a: 'No. Reports come in by upload (a text-based PDF, HTML, text or the CSV template) or through the API, and a person reviews what was read before anything is analysed. There is no live connection to a bureau or a monitoring service today.' },
  { q: 'Does it mail the letters?', a: 'No. It produces the approved PDF; your team mails it and records the date, method and tracking number. A delivery is shown as “Recorded by staff” because no carrier has confirmed it.' },
  { q: 'Can the AI send something on its own?', a: 'No. AI only suggests wording from the report data already on file. Every suggestion is an editable draft, and letters need a manager to approve the exact text before they can be marked as sent.' },
  { q: 'Do I need AI credits to use it?', a: 'No. Without credits, or with no AI provider connected, letters and notes use the standard wording. Credits are only spent when an AI result is actually returned to you.' },
  { q: 'What do my clients see?', a: 'Your business name and colour, their next step, the stage of each dispute in plain language, their documents and messages, and their rights. English or Spanish, per client.' },
  { q: 'How long is the trial?', a: `${TRIAL_DAYS} days, with no card required. Billing is not switched on yet, so nothing is charged when it ends.` },
];

/** A static picture of the client portal under a fictional agency's brand. Sample data, labelled as such. */
function PortalIllustration() {
  const css = brandCss('#6d28d9');
  const nav: [typeof Home, string, boolean][] = [[Home, 'Home', true], [ListChecks, 'Items', false], [FolderUp, 'Docs', false], [MessageCircle, 'Messages', false], [UserRound, 'Profile', false]];
  return (
    <figure className="brand-scope mx-auto w-full max-w-[21rem]">
      {css && <style dangerouslySetInnerHTML={{ __html: css }} />}
      <div className="overflow-hidden rounded-[2.25rem] border-[10px] border-raised bg-canvas shadow-pop" aria-hidden>
        <div className="flex items-center justify-between border-b border-line px-4 py-3"><OrgMark name="Sample Credit Co." size={26} /></div>
        <div className="space-y-3 p-4">
          <div><div className="display text-xl">Hello, Alex</div><div className="text-xs text-muted">Here is where your case stands today.</div></div>
          <div className="rounded-2xl bg-surface p-3.5 shadow-card">
            <div className="flex gap-3"><span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-brand-soft text-brand-strong"><Hourglass size={16} /></span>
              <div><div className="text-[0.6875rem] font-semibold text-brand-strong">Your next step · On our side</div><div className="mt-0.5 text-sm font-semibold leading-snug">The investigation is under way</div><div className="mt-1 text-xs text-muted">Day 18 of 30. The next response is expected in about <strong className="text-ink">12 days</strong>.</div></div></div>
            <div className="meter meter-sm mt-3" style={{ '--el': 60, '--left': 40 } as CSSProperties}><i className="meter-el" /><i className="meter-left" /></div>
          </div>
          <div className="rounded-2xl bg-surface p-3.5 shadow-card">
            <div className="mb-2.5 text-[0.6875rem] font-semibold text-muted">Your journey</div>
            <div className="flex items-center">
              {[0, 1, 2, 3].map((i) => <div key={i} className="flex flex-1 items-center last:flex-none">
                <span className={cn('grid h-6 w-6 shrink-0 place-items-center rounded-full text-[0.625rem] font-semibold ring-2', i < 2 ? 'bg-brand text-brand-ink ring-brand' : i === 2 ? 'bg-brand-soft text-brand-strong ring-brand' : 'bg-surface text-faint ring-line')}>{i < 2 ? <Check size={11} /> : i + 1}</span>
                {i < 3 && <span className={cn('h-0.5 flex-1', i < 2 ? 'bg-brand' : 'bg-line')} />}</div>)}
            </div>
            <div className="mt-2 text-xs font-medium">Disputing items</div>
          </div>
        </div>
        <div className="grid grid-cols-5 border-t border-line bg-surface px-1 py-2 text-[0.5625rem] font-medium text-muted">
          {nav.map(([Icon, l, on]) => <div key={l} className={cn('flex flex-col items-center gap-0.5', on && 'text-brand-strong')}><span className={cn('grid h-5 w-9 place-items-center rounded-full', on && 'bg-brand-soft')}><Icon size={14} /></span>{l}</div>)}
        </div>
      </div>
      <figcaption className="mt-4 text-center text-[0.8125rem] text-faint">Illustration with sample data: a fictional agency, not a real client or result.</figcaption>
    </figure>
  );
}

/**
 * A static picture of the three-bureau table for one account: the same layout the comparison page draws. One row
 * differs between bureaus (tinted), and the general reporting period worked out from the reported date has passed
 * (red). Sample data, labelled as such; the dates follow the real rule (first delinquency + 180 days + 7 years).
 */
function CompareIllustration() {
  const rows: [label: string, values: [string, string, string], mark?: 'differs' | 'passed'][] = [
    ['Balance', ['$1,240.00', '$980.00', '$1,240.00'], 'differs'],
    ['Payment status', ['Collection', 'Collection', 'Collection']],
    ['Opened', ['Feb 1, 2021', 'Feb 1, 2021', 'Feb 1, 2021']],
    ['First delinquency', ['Feb 14, 2018', 'Feb 14, 2018', 'Feb 14, 2018']],
    ['Generally reportable until', ['Aug 13, 2025', 'Aug 13, 2025', 'Aug 13, 2025'], 'passed'],
  ];
  return (
    <figure className="mx-auto w-full max-w-[36rem]">
      <div className="panel overflow-hidden shadow-pop" aria-hidden>
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line/70 px-4 py-3.5">
          <div className="font-display text-base font-semibold">SAMPLE COLLECTIONS <span className="font-sans font-normal text-muted">••7766</span></div>
          <div className="flex items-center gap-2"><Badge tone="bad">Collection</Badge><Badge tone="warn">1 difference</Badge></div>
        </div>
        <table className="w-full table-fixed text-[0.8125rem] sm:text-sm">
          <colgroup><col className="w-20 sm:w-40" /><col /><col /><col /></colgroup>
          <thead>
            <tr className="border-b border-line/70">
              <td />
              {['Experian', 'Equifax', 'TransUnion'].map((b) => <th key={b} className="px-1.5 py-2.5 text-left font-semibold sm:px-2">{b}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map(([label, values, mark], r) => (
              <tr key={label}>
                <th className={cn('py-1.5 pl-3 pr-1 text-left align-top font-normal text-muted sm:pr-3', mark === 'differs' && 'rounded-l-lg bg-warn-soft text-ink', r === 0 && 'pt-3', r === rows.length - 1 && 'pb-3.5')}>{label === 'First delinquency' ? <><span className="sm:hidden">First delinq.</span><span className="hidden sm:inline">{label}</span></> : label}</th>
                {values.map((v, n) => (
                  <td key={n} className={cn('px-1.5 py-1.5 align-top font-medium tabular-nums sm:px-2', mark === 'differs' && 'bg-warn-soft', mark === 'passed' && 'text-bad', r === 0 && 'pt-3', r === rows.length - 1 && 'pb-3.5')}>
                    {v}{mark === 'passed' && <span className="block text-xs">date has passed</span>}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <figcaption className="mt-4 text-center text-[0.8125rem] text-faint">Illustration with sample data. Not a real client or result.</figcaption>
    </figure>
  );
}

export default function Landing() {
  return (
    <MarketingFrame>
      {/* Hero */}
      <section className={cn(WRAP, 'grid items-center gap-12 pb-12 pt-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.04fr)] lg:gap-14 lg:pt-8')}>
        <div>
          <h1 className="display text-[2.5rem] leading-[1.04] tracking-[-0.03em] sm:text-[3.25rem] xl:text-[3.875rem]">
            Credit repair, run like a <em className="not-italic text-brand">practice</em> your clients can trust.
          </h1>
          <p className="mt-6 max-w-[34em] text-lg leading-relaxed text-muted">
            {PRODUCT.name} is credit repair software for agencies. One place to manage clients, compare reports across all three bureaus, run every dispute through a documented workflow, and keep clients informed, with compliance built in, not bolted on.
          </p>
          <div className="mt-7 flex flex-wrap items-center gap-3">
            <Link href="/signup" className="btn-primary btn-lg">Start your {TRIAL_DAYS}-day trial <ArrowRight size={18} aria-hidden /></Link>
            <Link href="/portal/login" className="btn-secondary btn-lg">I’m a client</Link>
          </div>
          <ul className="mt-7 flex flex-wrap gap-x-5 gap-y-2 text-sm text-muted">
            <li className="flex items-center gap-2"><ShieldCheck size={16} aria-hidden className="text-brand" /> Human-approved correspondence</li>
            <li className="flex items-center gap-2"><LockKeyhole size={16} aria-hidden className="text-brand" /> Encrypted documents</li>
            <li className="flex items-center gap-2"><ScrollText size={16} aria-hidden className="text-brand" /> Full audit trail</li>
          </ul>
        </div>
        <WindowsIllustration />
      </section>

      {/* The workflow, as one line. Filled dots are the steps a person must take. */}
      <section aria-label="Dispute workflow" className="night border-y border-rail-line bg-rail">
        <div className={WRAP}>
          <ol className="grid grid-cols-2 gap-y-5 py-6 sm:grid-cols-4 lg:grid-cols-7">
            {STAGES.map((s) => (
              <li key={s.name} className="relative pr-3 pt-5 text-[0.9375rem] font-semibold">
                <span aria-hidden className="absolute inset-x-0 top-[5px] h-0.5 bg-line" />
                <span aria-hidden className={cn('absolute left-0 top-0 h-3 w-3 rounded-full shadow-[inset_0_0_0_2px_rgb(var(--brand))]', s.human ? 'bg-brand' : 'bg-rail')} />
                {s.name}
                {s.note && <span className="mt-px block text-[0.8125rem] font-normal text-muted">{s.note}</span>}
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* Features */}
      <Band id="features" title="The whole client journey, from intake to graduation.">
        <div className="grid gap-x-12 gap-y-11 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((f) => (
            <article key={f.title}>
              <h3 className="flex items-center gap-2.5 text-lg font-semibold"><f.icon size={20} aria-hidden className="shrink-0 text-brand" />{f.title}</h3>
              <p className="mt-2 text-[0.9375rem] leading-relaxed text-muted">{f.body}</p>
            </article>
          ))}
        </div>
        <p className="mt-10"><Link href="/features" className="link">Everything the product does, and what is still manual</Link></p>
      </Band>

      {/* The comparison, drawn as the product draws it */}
      <Band id="compare" title="Three bureaus, one table."
        lede="Upload each bureau’s report and the same account lines up across all three. What differs is marked for a person to check; the software never calls an item inaccurate.">
        <div className="grid items-center gap-12 lg:grid-cols-[0.85fr_1fr]">
          <ul className="space-y-7">
            {([
              [UserCheck, 'A person approves what was read', 'Each report is read into fields, and a person checks those fields against the original and approves them before the report joins the comparison.'],
              [Columns3, 'Differences marked, not judged', 'A balance, status or date that differs between bureaus is highlighted. A difference alone does not mean anything is inaccurate, and the page says so.'],
              [History, 'Old items stand out', 'When the reported date of first delinquency puts an item past its general reporting period (15 U.S.C. § 1681c), that date is shown in red and the item is flagged for review.'],
            ] as const).map(([Icon, t, b]) => (
              <li key={t} className="flex gap-4">
                <Icon size={20} aria-hidden className="mt-0.5 shrink-0 text-brand" />
                <div><h3 className="font-semibold">{t}</h3><p className="mt-1 text-[0.9375rem] leading-relaxed text-muted">{b}</p></div>
              </li>
            ))}
          </ul>
          <CompareIllustration />
        </div>
      </Band>

      {/* Client experience */}
      <Band id="clients" title="Your brand in front. Your clients never left guessing."
        lede="Most client calls come down to “what’s happening with my file?” The portal answers that before they have to ask, under your name, not ours.">
        <div className="grid items-center gap-12 lg:grid-cols-[1fr_0.8fr]">
          <ul className="space-y-7">
            {([
              [Palette, 'Your name and colour', 'The portal and its sign-in page carry your business name and brand colour. Text contrast is adjusted automatically, so any colour stays readable.'],
              [Compass, 'One clear next step', 'Every visit opens with what happens now: something to sign, a document to upload, or when the next response is expected. Real dates, never estimates of results.'],
              [Languages, 'Plain language, English and Spanish', 'Statuses are written for consumers, not credit professionals, and each client sees the portal in their own language.'],
              [Smartphone, 'Built for the phone in their pocket', 'App-style navigation, uploads straight from the camera roll, and agreements signed in a couple of minutes.'],
              [Scale, 'Their rights, up front', 'Free weekly reports, disputing on their own at no cost, and the three-day cancellation right are explained in the portal.'],
            ] as const).map(([Icon, t, b]) => (
              <li key={t} className="flex gap-4">
                <Icon size={20} aria-hidden className="mt-0.5 shrink-0 text-brand" />
                <div><h3 className="font-semibold">{t}</h3><p className="mt-1 text-[0.9375rem] leading-relaxed text-muted">{b}</p></div>
              </li>
            ))}
          </ul>
          <PortalIllustration />
        </div>
      </Band>

      {/* Leads */}
      <Band title="New enquiries, followed up with consent."
        lede="Each agency gets its own enquiry form. It asks for contact details and what the person is working toward, requires consent, and turns every enquiry into a lead with a follow-up task.">
        <div className="grid gap-x-12 gap-y-8 md:grid-cols-3">
          {[
            ['Know where leads come from', 'Tag the link you share and the Leads page counts enquiries by source.'],
            ['Follow-up that can be stopped', 'When you switch it on and an email service is connected, leads get a welcome and two follow-ups, each with an opt-out link.'],
            ['A credit guide for questions', 'Staff and clients can ask the built-in guide how credit reporting works. Answers come from a vetted knowledge base and never promise an outcome.'],
          ].map(([t, b]) => <div key={t}><h3 className="font-semibold">{t}</h3><p className="mt-1.5 text-[0.9375rem] leading-relaxed text-muted">{b}</p></div>)}
        </div>
      </Band>

      {/* Compliance */}
      <Band id="compliance" title={`What ${PRODUCT.name} will never do.`}
        lede="The rules that keep a credit repair business out of trouble are enforced by the product, not left to memory.">
        <ul className="grid gap-x-12 gap-y-4 md:grid-cols-2">
          {NEVER.map((n) => <li key={n} className="flex items-start gap-3 border-t border-line pt-4"><Ban size={18} aria-hidden className="mt-0.5 shrink-0 text-bad" />{n}</li>)}
        </ul>
        <p className="mt-8"><Link href="/security" className="link">How data is protected, and what has not been audited</Link></p>
      </Band>

      {/* Straight answers */}
      <Band title="Straight answers before you sign up."><FaqList faqs={FAQS} /></Band>

      <CtaBand />

      <JsonLd data={{
        '@context': 'https://schema.org', '@type': 'SoftwareApplication', name: PRODUCT.name, url: siteUrl(),
        applicationCategory: 'BusinessApplication', operatingSystem: 'Web', description: DESCRIPTION,
      }} />
    </MarketingFrame>
  );
}
