import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { CheckCircle2 } from 'lucide-react';
import { AuthLayout } from '@/components/auth-layout';
import { InlineMessage } from '@/components/portal-kit';
import { ActionForm } from '@/components/forms';
import { LeadFields } from '@/components/lead-form';
import { orgBrandBySlug } from '@/lib/org-brand';
import { leadSourceTag } from '@/lib/lead-emails';
import { publicSiteBySlug, sitePath } from '@/lib/agency-site';
import { siteCopy } from '@/lib/agency-site-copy';
import { leadFormPath } from '@/lib/leads';
import { fill, parseLang, qs, tr } from '@/lib/portal-i18n';
import { submitLeadAction } from './actions';

/** The agency's own name in the title and description, so a link shared in a message or on social media previews as theirs. */
export async function generateMetadata({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ lang?: string }> }): Promise<Metadata> {
  const brand = await orgBrandBySlug((await params).slug);
  if (!brand) return { title: 'Get started', robots: { index: false } };
  const es = parseLang((await searchParams).lang) === 'es';
  const title = es ? `Empiece con ${brand.name}` : `Get started with ${brand.name}`;
  const description = es
    ? `Cuéntele a ${brand.name} cuál es su meta y cómo comunicarse con usted. Preguntar no tiene costo ni compromiso, y nadie puede prometer un resultado.`
    : `Tell ${brand.name} what you are working toward and how to reach you. Asking is free and without obligation, and no one can promise a result.`;
  return { title: { absolute: title }, description, robots: { index: false }, openGraph: { title, description, type: 'website', siteName: brand.name }, twitter: { card: 'summary', title, description } };
}

/** An agency's public enquiry form (English, or Spanish with `?lang=es`). It collects contact details only — never SSNs, dates of birth or account numbers. */
export default async function LeadFormPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ sent?: string; lang?: string; src?: string }> }) {
  const { slug } = await params;
  const sp = await searchParams;
  const brand = await orgBrandBySlug(slug);
  if (!brand) notFound();
  const lang = parseLang(sp.lang);
  // `?src=instagram` on the link the person followed: kept through the language switch and stored as the lead's source.
  const src = leadSourceTag(sp.src);
  const t = tr(lang);
  const other = lang === 'es' ? 'en' : 'es';
  const link = 'link';
  // When the agency has published its website, the form links back to it.
  const hasSite = (await publicSiteBySlug(brand.slug)) !== null;
  const footer = (
    <>
      {hasSite && <><Link href={`${sitePath(brand.slug)}${qs({ lang: lang === 'es' && 'es' })}`} className={link}>{fill(siteCopy(lang)('backToSite'), { org: brand.name })}</Link> · </>}
      {t('lead_already')} <Link href={`/portal/login${qs({ org: brand.slug, lang: lang === 'es' && 'es' })}`} className={link}>{t('lead_signIn')}</Link>
      {!sp.sent && <> · <Link href={`${leadFormPath(brand.slug)}${qs({ lang: other === 'es' && 'es', src })}`} lang={other} hrefLang={other} className={link}>{other === 'es' ? 'Español' : 'English'}</Link></>}
    </>
  );
  if (sp.sent) {
    return (
      <AuthLayout portal brand={brand} lang={lang} title={t('lead_thanksTitle')} subtitle={fill(t('lead_thanksSub'), { org: brand.name })} footer={footer}>
        <InlineMessage tone="ok" icon={<CheckCircle2 size={18} />}>{t('lead_thanksNote')}</InlineMessage>
      </AuthLayout>
    );
  }
  return (
    <AuthLayout portal brand={brand} lang={lang} title={t('lead_title')} subtitle={fill(t('lead_sub'), { org: brand.name })} footer={footer}>
      <ActionForm action={submitLeadAction} className="space-y-4">
        <LeadFields slug={brand.slug} orgName={brand.name} lang={lang} src={src} />
      </ActionForm>
      <p className="mt-6 border-t border-line pt-4 text-[0.8125rem] leading-relaxed text-muted">{t('lead_legal')}</p>
    </AuthLayout>
  );
}
