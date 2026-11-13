import Link from 'next/link';
import type { ReactNode } from 'react';
import {
  ArrowRight, BadgeCheck, Ban, BarChart3, Check, Compass, FileSearch, FileText, FolderUp, Gavel, HandHelping, Home, Hourglass, Languages, ListChecks, LockKeyhole,
  MessageCircle, MessagesSquare, Palette, Scale, ScanSearch, ScrollText, ShieldCheck, Smartphone, UserRound, Users, Zap,
} from 'lucide-react';
import { COMPLIANCE_FOOTER, Logo, OrgMark } from '@/components/ui';
import { ThemeToggle } from '@/components/shell-client';
import { brandCss } from '@/lib/brand';
import { PRODUCT } from '@/lib/product';

/** A static picture of the client portal under a fictional agency's brand. Sample data, labelled as such. */
function PortalIllustration() {
  const css = brandCss('#6d28d9');
  return (
    <figure className="brand-scope mx-auto w-full max-w-[22rem]">
      {css && <style dangerouslySetInnerHTML={{ __html: css }} />}
      <div className="overflow-hidden rounded-[2.25rem] border-[10px] border-[rgb(28,31,38)] bg-canvas shadow-pop" aria-hidden>
        <div className="flex items-center justify-between border-b border-line px-4 py-3"><OrgMark name="Sample Credit Co." size={26} /></div>
        <div className="space-y-3 p-4">
          <div><div className="font-display text-xl font-semibold">Hello, Alex</div><div className="text-xs text-muted">Here is where your case stands today.</div></div>
          <div className="rounded-2xl border border-line bg-surface p-3.5">
            <div className="flex gap-3"><span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-brand-soft text-brand-strong"><Hourglass size={16} /></span>
              <div><div className="text-[10px] font-semibold uppercase tracking-wide text-brand-strong">Your next step · On our side</div><div className="mt-0.5 text-sm font-semibold leading-snug">The investigation is under way</div><div className="mt-1 text-xs text-muted">The next response is expected around <strong className="text-ink">Apr 14</strong> (12 days away).</div></div></div>
          </div>
          <div className="rounded-2xl border border-line bg-surface p-3.5">
            <div className="mb-2.5 text-[10px] font-semibold uppercase tracking-wide text-muted">Your journey</div>
            <div className="flex items-center">
              {[0, 1, 2, 3].map((i) => <div key={i} className="flex flex-1 items-center last:flex-none">
                <span className={`grid h-6 w-6 shrink-0 place-items-center rounded-full text-[10px] font-semibold ring-2 ${i < 2 ? 'bg-brand text-brand-ink ring-brand' : i === 2 ? 'bg-brand-soft text-brand-strong ring-brand' : 'bg-surface text-faint ring-line'}`}>{i < 2 ? <Check size={11} /> : i + 1}</span>
                {i < 3 && <span className={`h-0.5 flex-1 ${i < 2 ? 'bg-brand' : 'bg-line'}`} />}</div>)}
            </div>
            <div className="mt-2 text-xs font-medium">Disputing items</div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            {[['Items sent', '6'], ['Still under review', '4']].map(([l, v]) => <div key={l} className="rounded-xl bg-raised p-2.5"><div className="font-display text-xl font-semibold">{v}</div><div className="text-[10px] text-muted">{l}</div></div>)}
          </div>
        </div>
        <div className="grid grid-cols-5 border-t border-line bg-surface px-1 py-2 text-[9px] font-medium text-muted">
          {[[Home, 'Home', true], [ListChecks, 'Items', false], [FolderUp, 'Docs', false], [MessageCircle, 'Messages', false], [UserRound, 'Profile', false]].map(([Icon, l, on]) => {
            const I = Icon as typeof Home;
            return <div key={l as string} className={`flex flex-col items-center gap-0.5 ${on ? 'text-brand-strong' : ''}`}><span className={`grid h-5 w-9 place-items-center rounded-full ${on ? 'bg-brand-soft' : ''}`}><I size={14} /></span>{l as string}</div>;
          })}
        </div>
      </div>
      <figcaption className="mt-3 text-center text-xs text-muted">Illustration with sample data — a fictional agency, not a real client or result.</figcaption>
    </figure>
  );
}

const FEATURES: { icon: ReactNode; title: string; body: string }[] = [
  { icon: <Users size={20} />, title: 'A real client CRM', body: 'One profile per client: contact details, consents, documents, notes, tasks, messages and a full activity timeline — nothing lives in a spreadsheet.' },
  { icon: <ScanSearch size={20} />, title: 'Three-bureau comparison', body: 'Upload reports and see Experian, Equifax and TransUnion side by side. Differences are flagged for review, never labelled “inaccurate” automatically.' },
  { icon: <Gavel size={20} />, title: 'Dispute pipeline', body: 'Draft → review → approved → submitted → investigating → response → resolved. Rounds, FCRA deadlines, evidence and a tamper-proof audit trail.' },
  { icon: <FileText size={20} />, title: 'Letter center', body: 'Editable templates, live merge fields, PDF export, version history and a manager approval step before anything leaves the building.' },
  { icon: <HandHelping size={20} />, title: 'AI that shows its work', body: 'Every suggestion cites the exact report fields behind it. It cannot invent facts, and a person approves every word.' },
  { icon: <MessagesSquare size={20} />, title: 'A portal clients actually use', body: 'Clients see their progress, upload what you ask for, read approved letters and message you — and can only ever see their own record.' },
];

const STAGES = ['Draft', 'In review', 'Approved', 'Submitted', 'Investigating', 'Response', 'Resolved'];

const NEVER: string[] = [
  'Promise a score increase or guarantee a deletion',
  'Label an item “inaccurate” just because bureaus differ',
  'Invent identity theft, payment history or any fact',
  'Send a letter without a named human approving it',
  'Let one business — or one client — see another’s records',
];

export default function Landing() {
  return (
    <div className="min-h-screen">
      <header className="mx-auto flex max-w-7xl items-center justify-between px-5 py-5 sm:px-8">
        <Link href="/" aria-label={`${PRODUCT.name} home`}><Logo /></Link>
        <nav aria-label="Primary" className="flex items-center gap-1 sm:gap-2">
          <a href="#features" className="btn-ghost hidden md:inline-flex">Features</a>
          <a href="#clients" className="btn-ghost hidden lg:inline-flex">Client experience</a>
          <a href="#compliance" className="btn-ghost hidden md:inline-flex">Compliance</a>
          <Link href="/portal/login" className="btn-ghost hidden sm:inline-flex">Client portal</Link>
          <Link href="/login" className="btn-secondary">Sign in</Link>
          <Link href="/signup" className="btn-primary hidden sm:inline-flex">Start free trial</Link>
          <ThemeToggle />
        </nav>
      </header>

      <main id="main">
        {/* Hero */}
        <section className="mx-auto grid max-w-7xl items-center gap-12 px-5 pb-16 pt-8 sm:px-8 lg:grid-cols-[1.05fr_1fr] lg:pb-24 lg:pt-14">
          <div className="animate-rise">
            <p className="badge mb-5 bg-brand-soft text-brand-strong"><BadgeCheck size={14} /> Built for credit repair professionals</p>
            <h1 className="font-display text-4xl font-semibold leading-[1.08] sm:text-5xl lg:text-[3.4rem]">
              Credit repair, run like a <em className="text-brand not-italic underline decoration-brand/30 decoration-4 underline-offset-[6px]">practice</em> your clients can trust.
            </h1>
            <p className="mt-6 max-w-xl text-lg leading-relaxed text-muted">
              {PRODUCT.name} gives your team one place to manage clients, analyze reports across all three bureaus, run every dispute through a documented workflow, and keep clients informed — with compliance built in, not bolted on.
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <Link href="/signup" className="btn-primary !min-h-[3rem] !px-6 !text-base">Start your 14-day trial <ArrowRight size={18} /></Link>
              <Link href="/portal/login" className="btn-secondary !min-h-[3rem] !px-6 !text-base">I’m a client</Link>
            </div>
            <ul className="mt-8 flex flex-wrap gap-x-6 gap-y-2 text-sm text-muted">
              <li className="flex items-center gap-1.5"><ShieldCheck size={16} className="text-brand" /> Human-approved correspondence</li>
              <li className="flex items-center gap-1.5"><LockKeyhole size={16} className="text-brand" /> Encrypted documents</li>
              <li className="flex items-center gap-1.5"><ScrollText size={16} className="text-brand" /> Full audit trail</li>
            </ul>
          </div>

          {/* Product preview (illustrative) */}
          <div className="relative animate-rise [animation-delay:120ms]" aria-hidden>
            <div className="absolute -inset-4 -z-10 rounded-[2rem] bg-brand/10 blur-2xl" />
            <div className="card overflow-hidden shadow-pop">
              <div className="flex items-center gap-1.5 border-b border-line bg-raised px-4 py-2.5">
                <span className="h-2.5 w-2.5 rounded-full bg-bad/60" /><span className="h-2.5 w-2.5 rounded-full bg-warn/60" /><span className="h-2.5 w-2.5 rounded-full bg-ok/60" />
                <span className="ml-3 text-xs text-muted">Dispute pipeline</span>
              </div>
              <div className="grid grid-cols-3 gap-3 p-4">
                {[
                  { h: 'Ready for review', items: [['Sample Bank', 'Experian · balance'], ['Sample Collections', 'Equifax · validation']], tone: 'bg-warn-soft text-warn' },
                  { h: 'Investigating', items: [['Sample Card Co.', 'TransUnion · 21 days left']], tone: 'bg-info-soft text-info' },
                  { h: 'Resolved', items: [['Sample Lender', 'Experian · updated'], ['Sample Utility', 'Equifax · deleted']], tone: 'bg-ok-soft text-ok' },
                ].map((col) => (
                  <div key={col.h} className="min-w-0">
                    <div className={`mb-2 truncate rounded-lg px-2 py-1 text-[11px] font-semibold ${col.tone}`}>{col.h}</div>
                    <div className="space-y-2">
                      {col.items.map(([a, b]) => (
                        <div key={a} className="rounded-xl border border-line bg-surface p-2.5 shadow-card">
                          <div className="truncate text-xs font-semibold">{a}</div>
                          <div className="mt-0.5 truncate text-[11px] text-muted">{b}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
              <div className="border-t border-line bg-raised px-4 py-2 text-[11px] text-muted">Illustration with sample data — not real clients or results.</div>
            </div>
          </div>
        </section>

        {/* Stage strip */}
        <section aria-label="Dispute workflow" className="border-y border-line bg-surface">
          <div className="mx-auto flex max-w-7xl items-center gap-2 overflow-x-auto px-5 py-5 sm:px-8">
            {STAGES.map((s, i) => (
              <div key={s} className="flex shrink-0 items-center gap-2 text-sm">
                <span className="grid h-6 w-6 place-items-center rounded-full bg-brand-soft text-xs font-semibold text-brand-strong">{i + 1}</span>
                <span className="font-medium">{s}</span>
                {i < STAGES.length - 1 && <span className="mx-1 text-faint">→</span>}
              </div>
            ))}
          </div>
        </section>

        {/* Features */}
        <section id="features" className="mx-auto max-w-7xl px-5 py-20 sm:px-8">
          <div className="max-w-2xl">
            <p className="eyebrow text-brand">Everything in one place</p>
            <h2 className="mt-2 font-display text-3xl font-semibold sm:text-4xl">The whole client journey, from intake to graduation.</h2>
          </div>
          <div className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map((f) => (
              <article key={f.title} className="card card-pad transition hover:-translate-y-0.5 hover:shadow-pop">
                <div className="mb-4 grid h-10 w-10 place-items-center rounded-xl bg-brand-soft text-brand-strong">{f.icon}</div>
                <h3 className="text-lg font-semibold">{f.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-muted">{f.body}</p>
              </article>
            ))}
          </div>
        </section>

        {/* Client experience */}
        <section id="clients" className="mx-auto max-w-7xl px-5 pb-20 sm:px-8">
          <div className="grid items-center gap-12 lg:grid-cols-[1fr_0.85fr]">
            <div>
              <p className="eyebrow text-brand">Client experience</p>
              <h2 className="mt-2 font-display text-3xl font-semibold sm:text-4xl">Your brand in front. Your clients never left guessing.</h2>
              <p className="mt-4 max-w-xl text-muted">Most client calls come down to “what’s happening with my file?” The portal answers that before they have to ask — under your name, not ours.</p>
              <ul className="mt-8 space-y-4">
                {[
                  [Palette, 'Your name and colour', 'The portal and its sign-in page carry your business name and brand colour. Text contrast is adjusted automatically, so any colour stays readable.'],
                  [Compass, 'One clear next step', 'Every visit opens with what happens now: something to sign, a document to upload, or when the next response is expected — from real dates, never estimates of results.'],
                  [Languages, 'Plain language, English and Spanish', 'Statuses are written for consumers, not credit professionals, and each client sees the portal in their own language.'],
                  [Smartphone, 'Built for the phone in their pocket', 'App-style navigation, uploads straight from the camera roll, and agreements signed in a couple of minutes.'],
                  [Scale, 'Their rights, up front', 'Free weekly reports, disputing on their own at no cost, and the 3-day cancellation right are explained in the portal.'],
                ].map(([Icon, t, b]) => {
                  const I = Icon as typeof Palette;
                  return <li key={t as string} className="flex gap-4"><span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-brand-soft text-brand-strong"><I size={18} aria-hidden /></span><div><h3 className="font-semibold">{t as string}</h3><p className="mt-1 text-sm text-muted">{b as string}</p></div></li>;
                })}
              </ul>
            </div>
            <PortalIllustration />
          </div>
        </section>

        {/* Goals */}
        <section className="mx-auto max-w-7xl px-5 pb-20 sm:px-8">
          <div className="card p-8 sm:p-10">
            <p className="eyebrow text-brand">Why clients come to you</p>
            <h2 className="mt-2 font-display text-3xl font-semibold">A home. A car. A better card rate.</h2>
            <p className="mt-3 max-w-2xl text-muted">Your enquiry form asks each person what they are working toward, so your specialist starts from the goal — and every client sees honest progress toward accurate reports. Lenders make their own decisions; {PRODUCT.name} never promises an approval or a score.</p>
            <ul className="mt-6 flex flex-wrap gap-2 text-sm">{['Buying a home', 'Getting a car', 'Qualifying for a credit card', 'Renting an apartment', 'Lower interest rates', 'Starting a business'].map((g) => <li key={g} className="rounded-full border border-line bg-raised px-3.5 py-1.5 font-medium">{g}</li>)}</ul>
          </div>
        </section>

        {/* How */}
        <section className="bg-surface">
          <div className="mx-auto grid max-w-7xl gap-10 px-5 py-20 sm:px-8 lg:grid-cols-[1fr_1.2fr]">
            <div>
              <p className="eyebrow text-brand">How it works</p>
              <h2 className="mt-2 font-display text-3xl font-semibold sm:text-4xl">Fewer clicks between a report and a reviewed dispute.</h2>
              <p className="mt-4 text-muted">Automation handles reminders, deadlines and follow-ups. People handle every decision that matters.</p>
            </div>
            <ol className="space-y-4">
              {[
                [FileSearch, 'Import', `Upload a report PDF or CSV. ${PRODUCT.name} extracts accounts, balances, dates and payment history — and shows its confidence on every field.`],
                [ScanSearch, 'Review & compare', 'Confirm what was read, then compare each account across bureaus. Potential discrepancies come with the evidence behind them.'],
                [Gavel, 'Dispute', 'Choose the item, the reason and the evidence. Draft the letter from a template, edit it, and send it for approval.'],
                [Zap, 'Track', 'Investigation deadlines, responses and outcomes are tracked automatically, with follow-up tasks created for your team.'],
              ].map(([Icon, t, b], i) => {
                const I = Icon as typeof FileSearch;
                return (
                  <li key={t as string} className="card flex gap-4 p-5">
                    <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-brand text-brand-ink"><I size={18} /></span>
                    <div>
                      <h3 className="font-semibold">{i + 1}. {t as string}</h3>
                      <p className="mt-1 text-sm text-muted">{b as string}</p>
                    </div>
                  </li>
                );
              })}
            </ol>
          </div>
        </section>

        {/* Compliance */}
        <section id="compliance" className="mx-auto max-w-7xl px-5 py-20 sm:px-8">
          <div className="card grid gap-10 overflow-hidden p-8 sm:p-12 lg:grid-cols-2">
            <div>
              <p className="eyebrow text-brand">Honest by design</p>
              <h2 className="mt-2 font-display text-3xl font-semibold">What {PRODUCT.name} will never do.</h2>
              <p className="mt-4 text-muted">The rules that keep a credit repair business out of trouble are enforced by the product, not left to memory.</p>
              <Link href="/signup" className="btn-primary mt-6">See it in action <ArrowRight size={16} /></Link>
            </div>
            <ul className="space-y-3">
              {NEVER.map((n) => (
                <li key={n} className="flex items-start gap-3 rounded-xl bg-raised p-3.5 text-sm">
                  <Ban size={18} className="mt-0.5 shrink-0 text-bad" /> {n}
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* Business */}
        <section className="mx-auto max-w-7xl px-5 pb-20 sm:px-8">
          <div className="grid gap-5 sm:grid-cols-3">
            {[
              [BarChart3, 'Real analytics', 'Dashboards come straight from your own data — never placeholders.'],
              [Users, 'Teams & roles', 'Owners, admins, managers and specialists, each with exactly the access they need.'],
              [LockKeyhole, 'Isolated by the database', 'Tenant isolation is enforced by PostgreSQL row-level security, not just app code.'],
            ].map(([Icon, t, b]) => {
              const I = Icon as typeof Users;
              return (
                <div key={t as string} className="flex gap-4 p-2">
                  <I size={22} className="mt-0.5 shrink-0 text-brand" />
                  <div><h3 className="font-semibold">{t as string}</h3><p className="mt-1 text-sm text-muted">{b as string}</p></div>
                </div>
              );
            })}
          </div>
        </section>
      </main>

      <footer className="border-t border-line bg-surface">
        <div className="mx-auto flex max-w-7xl flex-col gap-4 px-5 py-8 text-sm text-muted sm:px-8 md:flex-row md:items-center md:justify-between">
          <Logo size={22} />
          <p className="max-w-2xl text-xs leading-relaxed">{COMPLIANCE_FOOTER}</p>
        </div>
      </footer>
    </div>
  );
}
