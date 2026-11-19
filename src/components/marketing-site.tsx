import Link from 'next/link';
import { headers } from 'next/headers';
import type { ReactNode } from 'react';
import { AlertTriangle, ArrowRight, ChevronRight, Clock, Menu, PencilLine, Sparkles, UserRound } from 'lucide-react';
import { COMPLIANCE_FOOTER, Logo, Notice } from '@/components/ui';
import { ThemeToggle } from '@/components/shell-client';
import { PRODUCT } from '@/lib/product';
import { TRIAL_DAYS } from '@/lib/plans';
import { GUIDES, SITE_NAV, abs, breadcrumbLd, faqLd, guideBySlug, guidePath, jsonLdString, organizationLd, type Faq } from '@/lib/site';
import { cn } from '@/lib/util';

/**
 * The public marketing site's shared pieces: header, footer, page frames and the hero illustration.
 * Everything here is a server component and works with JavaScript off (the phone menu is a <details>);
 * the only script-driven control is the theme toggle.
 */

/** Page width and side padding used by every marketing section. */
export const WRAP = 'mx-auto w-full max-w-[77.5rem] px-5 sm:px-10';

/**
 * Structured data for search engines. The strict CSP allows only nonce'd scripts, so the block carries the
 * per-request nonce the middleware sets (the same one the theme script in the root layout uses).
 */
export async function JsonLd({ data }: { data: unknown }) {
  const nonce = (await headers()).get('x-nonce') ?? undefined;
  return <script type="application/ld+json" nonce={nonce} suppressHydrationWarning dangerouslySetInnerHTML={{ __html: jsonLdString(data) }} />;
}

export function MarketingHeader() {
  return (
    <header className={cn(WRAP, 'flex h-[4.75rem] items-center justify-between gap-3')}>
      <Link href="/" aria-label={`${PRODUCT.name} home`} className="shrink-0 rounded-lg"><Logo /></Link>
      <div className="flex items-center gap-1.5">
        <nav aria-label="Primary" className="hidden items-center md:flex">
          {SITE_NAV.map((n) => <Link key={n.href} href={n.href} className="btn-ghost">{n.label}</Link>)}
        </nav>
        <Link href="/login" className="btn-secondary md:ml-2">Sign in</Link>
        <Link href="/signup" className="btn-primary hidden sm:inline-flex">Start free trial</Link>
        <ThemeToggle />
        {/* Phone menu: a native disclosure, so it opens without JavaScript. */}
        <details className="relative md:hidden">
          <summary aria-label="Menu" className="grid h-[2.375rem] w-[2.375rem] cursor-pointer list-none place-items-center rounded-xl text-muted hover:bg-raised hover:text-ink [&::-webkit-details-marker]:hidden">
            <Menu size={20} aria-hidden />
          </summary>
          <nav aria-label="Menu" className="absolute right-0 top-full z-30 mt-2 flex w-56 flex-col gap-0.5 rounded-2xl bg-raised p-2 shadow-pop">
            {SITE_NAV.map((n) => <Link key={n.href} href={n.href} className="rounded-xl px-3 py-2.5 text-[0.9375rem] font-medium text-ink hover:bg-line">{n.label}</Link>)}
            <Link href="/portal/login" className="rounded-xl px-3 py-2.5 text-[0.9375rem] font-medium text-ink hover:bg-line">Client portal</Link>
            <Link href="/signup" className="btn-primary mt-1.5">Start free trial</Link>
          </nav>
        </details>
      </div>
    </header>
  );
}

export function MarketingFooter() {
  const col = 'space-y-2.5 text-sm';
  const a = 'text-muted underline-offset-4 hover:text-ink hover:underline';
  return (
    <footer className="mt-24 border-t border-line">
      <div className={cn(WRAP, 'grid gap-10 py-12 sm:grid-cols-2 lg:grid-cols-[1.4fr_1fr_1.4fr_1fr]')}>
        <div>
          <Logo size={24} />
          <p className="mt-3 max-w-xs text-sm text-muted">Software for credit repair agencies: reports, disputes, letters, deadlines and a client portal.</p>
        </div>
        <nav aria-label="Product">
          <h2 className="mb-3 font-sans text-sm font-semibold tracking-normal">Product</h2>
          <ul className={col}>
            <li><Link className={a} href="/features">Features</Link></li>
            <li><Link className={a} href="/pricing">Pricing</Link></li>
            <li><Link className={a} href="/security">Security</Link></li>
          </ul>
        </nav>
        <nav aria-label="Guides">
          <h2 className="mb-3 font-sans text-sm font-semibold tracking-normal">Guides</h2>
          <ul className={col}>
            {GUIDES.map((g) => <li key={g.slug}><Link className={a} href={guidePath(g.slug)}>{g.title}</Link></li>)}
          </ul>
        </nav>
        <nav aria-label="Account">
          <h2 className="mb-3 font-sans text-sm font-semibold tracking-normal">Account</h2>
          <ul className={col}>
            <li><Link className={a} href="/signup">Start free trial</Link></li>
            <li><Link className={a} href="/login">Sign in</Link></li>
            <li><Link className={a} href="/portal/login">Client portal</Link></li>
          </ul>
        </nav>
      </div>
      <div className="border-t border-line">
        <p className={cn(WRAP, 'py-6 text-xs leading-relaxed text-muted')}>{COMPLIANCE_FOOTER}</p>
      </div>
    </footer>
  );
}

/** Header, main landmark and footer around a public page. Every page also gets the Organization structured data. */
export function MarketingFrame({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen overflow-x-clip">
      <MarketingHeader />
      <main id="main">{children}</main>
      <MarketingFooter />
      <JsonLd data={organizationLd()} />
    </div>
  );
}

/** The opening of an inner page: one title, one paragraph. */
export function PageIntro({ title, lede, children }: { title: ReactNode; lede: ReactNode; children?: ReactNode }) {
  return (
    <section className={cn(WRAP, 'pb-4 pt-10 sm:pt-16')}>
      <h1 className="display max-w-[18em] text-[2.25rem] sm:text-5xl">{title}</h1>
      <p className="mt-5 max-w-2xl text-lg leading-relaxed text-muted">{lede}</p>
      {children}
    </section>
  );
}

/** A titled block of content separated by space and a rule, not a box. */
export function Band({ id, title, lede, children, className }: { id?: string; title: ReactNode; lede?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section id={id} className={cn(WRAP, 'scroll-mt-6 pt-16 sm:pt-20', className)}>
      <h2 className="display max-w-[20em] text-[1.75rem] sm:text-4xl">{title}</h2>
      {lede && <p className="mt-4 max-w-2xl text-[1.0625rem] leading-relaxed text-muted">{lede}</p>}
      <div className="mt-9">{children}</div>
    </section>
  );
}

/** The closing call to action. One primary action; clients get a quiet link to their portal. */
export function CtaBand({ title = 'See it with your own files.', body }: { title?: string; body?: ReactNode }) {
  return (
    <section className={cn(WRAP, 'pt-20')}>
      <div className="night flex flex-col items-start gap-6 rounded-2xl bg-rail px-6 py-10 sm:px-10 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h2 className="display text-[1.75rem] sm:text-[2rem]">{title}</h2>
          <p className="mt-2 max-w-xl text-muted">{body ?? `The trial runs ${TRIAL_DAYS} days and needs no card. Bring a report and work one client from import to an approved letter.`}</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Link href="/signup" className="btn-primary btn-lg">Start free trial <ArrowRight size={18} aria-hidden /></Link>
          <Link href="/pricing" className="btn-secondary btn-lg">See pricing</Link>
        </div>
      </div>
    </section>
  );
}

/** Questions and answers shown in full (no script, nothing hidden), with matching FAQPage structured data. */
export function FaqList({ faqs }: { faqs: readonly Faq[] }) {
  return (
    <>
      <dl className="grid gap-x-12 gap-y-8 md:grid-cols-2">
        {faqs.map((f) => (
          <div key={f.q}>
            <dt className="text-[1.0625rem] font-semibold">{f.q}</dt>
            <dd className="mt-2 leading-relaxed text-muted">{f.a}</dd>
          </div>
        ))}
      </dl>
      <JsonLd data={faqLd(faqs)} />
    </>
  );
}

/* ------------------------------------------------------------------------------------------------------------------
   Hero illustration: three sample disputes on one calendar, and a sample AI suggestion. Sample data, labelled so.
   The axis dates are counted from the day the page is served, so the picture never shows a stale month.
------------------------------------------------------------------------------------------------------------------ */

const DAY = 86_400_000;
/** The axis spans 45 days back to 30 days ahead, so today sits at 60%. */
const AXIS = [-45, -30, -15, 15, 30];
const NOW_PCT = 60;
const pctOf = (offsetDays: number) => ((offsetDays + 45) / 75) * 100;

export function WindowsIllustration() {
  const now = Date.now();
  const short = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  const chip = 'inline-flex min-h-[1.5rem] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 text-xs font-semibold';
  const rows: { name: string; bureau: string; tag: ReactNode; bars: ReactNode }[] = [
    {
      name: 'Sample Collections', bureau: 'Experian',
      tag: <span className={cn(chip, 'bg-bad-soft text-bad')}><AlertTriangle size={13} aria-hidden />6 days overdue</span>,
      // Submitted 36 days ago: a 30-day window, then 6 days past the deadline.
      bars: <>
        <i className="absolute inset-y-0 rounded-l-[5px] bg-faint" style={{ left: `${pctOf(-36)}%`, width: `${pctOf(-6) - pctOf(-36)}%` }} />
        <i className="hatch-bad absolute inset-y-0 rounded-r-[5px]" style={{ left: `${pctOf(-6)}%`, width: `${NOW_PCT - pctOf(-6)}%` }} />
      </>,
    },
    {
      name: 'Sample Card Co.', bureau: 'TransUnion',
      tag: <span className={cn(chip, 'bg-raised text-muted')}><Clock size={13} aria-hidden />21 days left</span>,
      // Submitted 9 days ago: 9 days elapsed (solid), 21 to come (outlined).
      bars: <span className="absolute inset-y-0 overflow-hidden rounded-[5px] bg-brand-soft shadow-[inset_0_0_0_1px_rgb(var(--brand)/0.55)]" style={{ left: `${pctOf(-9)}%`, width: `${pctOf(21) - pctOf(-9)}%` }}>
        <i className="absolute inset-y-0 left-0 w-[30%] bg-brand" />
      </span>,
    },
    {
      name: 'Sample Bank', bureau: 'Experian',
      tag: <span className={cn(chip, 'bg-raised text-muted')}><PencilLine size={13} aria-hidden />Ready for review</span>,
      // Not submitted: the window would start today, so it is only a dashed outline.
      bars: <i className="absolute inset-y-0 rounded-[5px] border-[1.5px] border-dashed border-faint" style={{ left: `${NOW_PCT}%`, width: `${pctOf(30) - NOW_PCT}%` }} />,
    },
  ];
  return (
    <figure className="relative">
      <div aria-hidden className="lg:pb-48">
        <div className="rounded-[1.25rem] bg-surface px-5 pb-6 pt-5 text-sm shadow-pop sm:px-6">
          <div className="display text-lg">Investigation windows</div>
          <p className="mt-0.5 text-[0.8125rem] text-muted">Every open dispute on one calendar, so nothing passes its deadline quietly.</p>
          <div className="relative mt-9">
            <div className="relative h-[22px] text-xs text-faint">
              {AXIS.map((d, i) => (
                <span key={d} className={cn('absolute top-0 whitespace-nowrap', i === 0 ? '' : i === AXIS.length - 1 ? '-translate-x-full' : '-translate-x-1/2', (i === 1 || i === 3) && 'hidden sm:inline')} style={{ left: `${pctOf(d)}%` }}>
                  {short.format(new Date(now + d * DAY))}
                </span>
              ))}
            </div>
            <div className="relative">
              {[0, 20, 40, 60, 80, 100].map((p) => <span key={p} className="absolute inset-y-0 w-px bg-line/60" style={{ left: `${p}%` }} />)}
              <span className="absolute -top-1.5 bottom-0 z-[1] w-px bg-now/45" style={{ left: `${NOW_PCT}%` }} />
              <span className="absolute -top-[27px] z-[3] -translate-x-1/2 whitespace-nowrap rounded-full bg-now px-2 py-px text-xs font-bold text-canvas" style={{ left: `${NOW_PCT}%` }}>Today</span>
              <ul>
                {rows.map((r, i) => (
                  <li key={r.name} className={cn('relative pb-3 pt-[11px]', i > 0 && 'border-t border-line/60')}>
                    <div className="relative z-[4] mb-2 flex items-center justify-between gap-3">
                      <span className="min-w-0 truncate bg-surface pr-2"><b className="font-semibold">{r.name}</b> <span className="text-muted">{r.bureau}</span></span>
                      {r.tag}
                    </div>
                    <div className="relative h-4">
                      {r.bars}
                      <span className="absolute -bottom-[5px] -top-[5px] z-[3] -ml-[1.5px] w-[3px] rounded-[3px] bg-now shadow-glow" style={{ left: `${NOW_PCT}%` }} />
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
        <div className="relative z-[5] mx-3 -mt-4 rounded-2xl bg-raised px-[18px] py-4 text-sm shadow-pop lg:absolute lg:-right-3 lg:bottom-0 lg:mx-0 lg:mt-0 lg:w-[24rem]">
          {/* What the product really shows: the current text and the suggestion side by side, changed lines marked in the margin. */}
          <div className="text-xs font-semibold text-muted">Current text</div>
          <p className="mt-1 border-l-2 border-line pl-2.5 leading-[1.55] text-muted">Experian reports a balance of $1,240.00. I dispute this balance.</p>
          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs font-semibold text-muted"><span className="tag-ai"><Sparkles size={13} aria-hidden />AI suggestion</span>changed lines are marked</div>
          <p className="mt-1.5 border-l-2 border-ai pl-2.5 leading-[1.55]">Experian reports a balance of $1,240.00. Please verify this balance with the furnisher and correct it if it is not accurate.</p>
          <p className="mt-2.5 text-[0.8125rem] text-muted">If a number or a date changes, the suggestion is discarded.</p>
          <div className="mt-3 flex items-center gap-2 border-t border-line pt-3 text-[0.8125rem] text-muted"><UserRound size={14} aria-hidden className="shrink-0" />Nothing is sent until a named person approves it.</div>
        </div>
      </div>
      <figcaption className="mt-4 text-[0.8125rem] text-faint lg:absolute lg:bottom-24 lg:left-1 lg:mt-0 lg:w-44">Illustration with sample data. Not real clients or results.</figcaption>
    </figure>
  );
}

/* ------------------------------------------------------------------------------------------------------------------
   Guides
------------------------------------------------------------------------------------------------------------------ */

/** Reading styles for long-form guide text. Headings, lists and links only: no cards. */
const PROSE = [
  'max-w-[44rem] text-[1.0625rem] leading-[1.7]',
  '[&_h2]:mt-12 [&_h2]:scroll-mt-6 [&_h2]:text-[1.625rem] [&_h2]:font-semibold [&_h2]:leading-tight',
  '[&_h3]:mt-8 [&_h3]:text-lg [&_h3]:font-semibold',
  '[&_p]:mt-4 [&_p]:text-ink/90',
  '[&_ul]:mt-4 [&_ul]:list-disc [&_ul]:space-y-2 [&_ul]:pl-5 [&_ol]:mt-4 [&_ol]:list-decimal [&_ol]:space-y-2 [&_ol]:pl-5 [&_li]:text-ink/90',
  '[&_li::marker]:text-faint',
  '[&_strong]:font-semibold [&_strong]:text-ink',
].join(' ');

const longDate = (iso: string) => new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${iso}T12:00:00Z`));

/**
 * The frame around one guide: breadcrumb, title, the "not legal advice" note, the text, optional questions, and one
 * line on where the product fits. Adds Article and BreadcrumbList structured data.
 */
export function GuideFrame({ slug, children, faqs, productNote }: { slug: string; children: ReactNode; faqs?: readonly Faq[]; productNote: ReactNode }) {
  const g = guideBySlug(slug);
  const others = GUIDES.filter((x) => x.slug !== slug);
  return (
    <>
      <article className={cn(WRAP, 'pt-8 sm:pt-12')}>
        <nav aria-label="Breadcrumb" className="flex flex-wrap items-center gap-1 text-sm text-muted">
          <Link href="/guides" className="underline-offset-4 hover:text-ink hover:underline">Guides</Link>
          <ChevronRight size={14} aria-hidden />
          <span aria-current="page">{g.kicker}</span>
        </nav>
        <h1 className="display mt-5 max-w-[20em] text-[2.125rem] sm:text-[2.75rem]">{g.title}</h1>
        <p className="mt-4 max-w-2xl text-lg leading-relaxed text-muted">{g.description}</p>
        <p className="mt-4 text-sm text-muted">{g.minutes} minute read · Reviewed <time dateTime={g.reviewed}>{longDate(g.reviewed)}</time></p>
        <div className="mt-6 max-w-[44rem]">
          <Notice tone="neutral">General information for credit repair businesses, not legal advice. Federal law is summarised here; your state may add its own rules. Have an attorney confirm what applies to you.</Notice>
        </div>
        <div className={PROSE}>{children}</div>
        <aside className="mt-12 max-w-[44rem] border-l-2 border-brand pl-5">
          <h2 className="font-sans text-base font-semibold tracking-normal">Where {PRODUCT.name} fits</h2>
          <p className="mt-2 leading-relaxed text-muted">{productNote}</p>
          <p className="mt-3"><Link href="/features" className="link">See what the product does</Link></p>
        </aside>
      </article>
      {faqs && faqs.length > 0 && <Band title="Common questions"><FaqList faqs={faqs} /></Band>}
      <Band title="More guides">
        <ul className="grid gap-8 md:grid-cols-2">
          {others.map((o) => <li key={o.slug}><GuideLink slug={o.slug} /></li>)}
        </ul>
      </Band>
      <CtaBand />
      <JsonLd data={{
        '@context': 'https://schema.org', '@type': 'Article', headline: g.title, description: g.description,
        dateModified: g.reviewed, datePublished: g.reviewed, mainEntityOfPage: abs(guidePath(g.slug)),
        author: { '@type': 'Organization', name: PRODUCT.name }, publisher: { '@type': 'Organization', name: PRODUCT.name },
      }} />
      <JsonLd data={breadcrumbLd([{ name: 'Home', path: '/' }, { name: 'Guides', path: '/guides' }, { name: g.title, path: guidePath(g.slug) }])} />
    </>
  );
}

/** A guide as a link: kicker, title, summary. */
export function GuideLink({ slug }: { slug: string }) {
  const g = guideBySlug(slug);
  return (
    <Link href={guidePath(g.slug)} className="group block rounded-lg">
      <span className="eyebrow">{g.kicker} · {g.minutes} min</span>
      <span className="display mt-1.5 block text-[1.375rem] group-hover:text-brand-strong">{g.title}</span>
      <span className="mt-2 block leading-relaxed text-muted">{g.description}</span>
      <span className="mt-3 inline-flex items-center gap-1 text-sm font-semibold text-brand-strong">Read the guide <ArrowRight size={15} aria-hidden /></span>
    </Link>
  );
}
