import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { CheckCircle2 } from 'lucide-react';
import { ActionForm } from '@/components/forms';
import { LeadFields } from '@/components/lead-form';
import { JsonLd } from '@/components/marketing-site';
import { InlineMessage } from '@/components/portal-kit';
import { OrgMark } from '@/components/ui';
import { publicSiteBySlug, siteLd, sitePath } from '@/lib/agency-site';
import { siteCopy, type SiteKey } from '@/lib/agency-site-copy';
import { brandCss } from '@/lib/brand';
import { portalLoginPath } from '@/lib/org-brand';
import { fill, parseLang, qs, tr } from '@/lib/portal-i18n';
import { PRODUCT } from '@/lib/product';
import { abs, faqLd, siteUrl } from '@/lib/site';
import { submitSiteLeadAction } from './actions';

type Props = { params: Promise<{ slug: string }>; searchParams: Promise<{ lang?: string; sent?: string }> };
const WRAP = 'mx-auto w-full max-w-5xl px-5 sm:px-10';
const BAND = 'scroll-mt-24 border-t border-line py-12 sm:py-16';
const H2 = 'display text-[1.625rem] sm:text-[2rem]';

/** Title, description, canonical address and link preview come from the agency's own content; a site that is not published is not indexed. */
export async function generateMetadata({ params, searchParams }: Props): Promise<Metadata> {
  const site = await publicSiteBySlug((await params).slug);
  if (!site) return { title: 'Page not found', robots: { index: false } };
  const lang = parseLang((await searchParams).lang);
  const { brand, content: c } = site;
  const title = c.headline ? `${brand.name}: ${c.headline}` : brand.name;
  const description = c.intro || fill(siteCopy(lang)('description'), { org: brand.name });
  const en = abs(sitePath(brand.slug));
  const url = lang === 'es' ? `${en}?lang=es` : en;
  return {
    metadataBase: new URL(siteUrl()),
    title: { absolute: title },
    description,
    alternates: { canonical: url, languages: { en, es: `${en}?lang=es` } },
    openGraph: { type: 'website', url, title, description, siteName: brand.name, locale: lang === 'es' ? 'es_US' : 'en_US' },
    twitter: { card: 'summary', title, description },
  };
}

/**
 * An agency's own website: its name, mark and colour, its own text, the fixed "how it works" steps and legal notices,
 * and its enquiry form. Server-rendered; the menu, the questions and the form all work without JavaScript.
 */
export default async function AgencySitePage({ params, searchParams }: Props) {
  const site = await publicSiteBySlug((await params).slug);
  if (!site) notFound();
  const sp = await searchParams;
  const lang = parseLang(sp.lang);
  const { brand, content: c, address } = site;
  const s = siteCopy(lang);
  const t = tr(lang);
  const css = brandCss(brand.color);
  const other = lang === 'es' ? 'en' : 'es';
  const here = sitePath(brand.slug);
  const signIn = `${portalLoginPath(brand.slug)}${lang === 'es' ? '&lang=es' : ''}`;
  const contact: [SiteKey, string, string | null][] = [
    ['phone', c.phone, c.phone ? `tel:${c.phone.replace(/[^0-9+]/g, '')}` : null], ['email', c.email, c.email ? `mailto:${c.email}` : null], ['hours', c.hours, null], ['area', c.area, null],
  ];
  const hasContact = contact.some(([, v]) => v);
  const nav: [string, SiteKey][] = [
    ...(c.services.length ? [['#services', 'nav_services'] as [string, SiteKey]] : []),
    ['#how', 'nav_how'],
    ...(c.about ? [['#about', 'nav_about'] as [string, SiteKey]] : []),
    ...(c.faqs.length ? [['#faq', 'nav_faq'] as [string, SiteKey]] : []),
    ['#contact', 'nav_contact'],
  ];
  return (
    <div className="brand-scope min-h-screen" lang={lang}>
      {css && <style dangerouslySetInnerHTML={{ __html: css }} />}
      <JsonLd data={siteLd(site, lang)} />
      {c.faqs.length > 0 && <JsonLd data={faqLd(c.faqs)} />}

      <header className={`${WRAP} flex min-h-[4.75rem] flex-wrap items-center justify-between gap-x-4 gap-y-2 py-3`}>
        <Link href={`${here}${qs({ lang: lang === 'es' && 'es' })}`} className="min-w-0 rounded-lg"><OrgMark name={brand.name} /></Link>
        <div className="flex items-center gap-1.5">
          <nav aria-label={s('menu')} className="hidden items-center lg:flex">
            {nav.map(([href, k]) => <a key={href} href={href} className="btn-ghost">{s(k)}</a>)}
          </nav>
          <Link href={`${here}${qs({ lang: other === 'es' && 'es' })}`} lang={other} hrefLang={other} className="btn-ghost">{other === 'es' ? 'Español' : 'English'}</Link>
          <Link href={signIn} className="btn-secondary">{s('signIn')}</Link>
        </div>
      </header>

      <main id="main">
        <section className={`${WRAP} py-14 sm:py-20`}>
          <h1 className="display max-w-3xl text-[2.25rem] sm:text-[3.25rem]">{c.headline || brand.name}</h1>
          {c.intro && <p className="mt-5 max-w-2xl whitespace-pre-line text-lg leading-relaxed text-muted">{c.intro}</p>}
          <div className="mt-8 flex flex-wrap gap-2.5">
            <a href="#contact" className="btn-primary btn-lg">{s('cta')}</a>
          </div>
        </section>

        {c.services.length > 0 && (
          <section id="services" className={BAND}>
            <div className={WRAP}>
              <h2 className={H2}>{s('nav_services')}</h2>
              <ul className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {c.services.map((item, i) => (
                  <li key={i} className="card card-pad">
                    <h3 className="text-lg font-semibold leading-snug">{item.title}</h3>
                    {item.text && <p className="mt-2 whitespace-pre-line text-[0.9375rem] leading-relaxed text-muted">{item.text}</p>}
                  </li>
                ))}
              </ul>
            </div>
          </section>
        )}

        <section id="how" className={BAND}>
          <div className={WRAP}>
            <h2 className={H2}>{s('how_title')}</h2>
            <ol className="mt-8 grid gap-x-8 gap-y-7 sm:grid-cols-2 lg:grid-cols-4">
              {([1, 2, 3, 4] as const).map((n) => (
                <li key={n}>
                  <span aria-hidden className="grid h-9 w-9 place-items-center rounded-full bg-brand font-display text-sm font-semibold text-brand-ink">{n}</span>
                  <h3 className="mt-3 font-semibold">{s(`how_${n}t`)}</h3>
                  <p className="mt-1.5 text-[0.9375rem] leading-relaxed text-muted">{s(`how_${n}`)}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        {c.about && (
          <section id="about" className={BAND}>
            <div className={WRAP}>
              <h2 className={H2}>{s('nav_about')}</h2>
              <p className="mt-6 max-w-3xl whitespace-pre-line text-base leading-relaxed text-muted">{c.about}</p>
            </div>
          </section>
        )}

        {c.faqs.length > 0 && (
          <section id="faq" className={BAND}>
            <div className={WRAP}>
              <h2 className={H2}>{s('faq_title')}</h2>
              <div className="mt-6 max-w-3xl divide-y divide-line border-y border-line">
                {c.faqs.map((f, i) => (
                  <details key={i} className="group py-4">
                    <summary className="cursor-pointer font-semibold marker:text-muted">{f.q}</summary>
                    <p className="mt-2 whitespace-pre-line text-[0.9375rem] leading-relaxed text-muted">{f.a}</p>
                  </details>
                ))}
              </div>
            </div>
          </section>
        )}

        <section id="contact" className={BAND}>
          <div className={`${WRAP} grid gap-10 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1fr)]`}>
            <div>
              <h2 className={H2}>{s('form_title')}</h2>
              <p className="mt-3 text-[0.9375rem] leading-relaxed text-muted">{s('form_sub')}</p>
              {hasContact && (
                <dl className="mt-7 space-y-3 text-[0.9375rem]">
                  {contact.filter(([, v]) => v).map(([k, v, href]) => (
                    <div key={k}>
                      <dt className="text-[0.8125rem] font-medium text-muted">{s(k)}</dt>
                      <dd className="mt-0.5 break-words">{href ? <a href={href} className="link">{v}</a> : v}</dd>
                    </div>
                  ))}
                </dl>
              )}
            </div>
            <div className="card card-pad">
              {sp.sent ? (
                <div>
                  <h3 className="text-lg font-semibold">{t('lead_thanksTitle')}</h3>
                  <p className="mt-1 text-[0.9375rem] text-muted">{fill(t('lead_thanksSub'), { org: brand.name })}</p>
                  <InlineMessage tone="ok" role="status" icon={<CheckCircle2 size={18} />} className="mt-4">{t('lead_thanksNote')}</InlineMessage>
                </div>
              ) : (
                <ActionForm action={submitSiteLeadAction} className="space-y-4">
                  <LeadFields slug={brand.slug} orgName={brand.name} lang={lang} />
                </ActionForm>
              )}
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-line py-10">
        <div className={`${WRAP} text-[0.8125rem] leading-relaxed text-muted`}>
          <h2 className="text-sm font-semibold text-ink">{s('legal_title')}</h2>
          <ul className="mt-3 max-w-3xl space-y-2">
            <li>{s('legal_1')}</li>
            <li>{s('legal_2')}</li>
            <li>{fill(s('legal_3'), { org: brand.name })}</li>
          </ul>
          <address className="mt-6 not-italic">
            <span className="font-semibold text-ink">{brand.name}</span>
            {address && <><br />{address}</>}
          </address>
          <p className="mt-6 flex flex-wrap gap-x-4 gap-y-1">
            <Link href={signIn} className="link">{s('signIn')}</Link>
            {PRODUCT.showPoweredBy && <span>{s('poweredBy')} {PRODUCT.name}</span>}
          </p>
        </div>
      </footer>
    </div>
  );
}
