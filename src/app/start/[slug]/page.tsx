import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { CheckCircle2 } from 'lucide-react';
import { AuthLayout } from '@/components/auth-layout';
import { ActionForm, Check, Field, Select, SubmitButton, TextArea } from '@/components/forms';
import { orgBrandBySlug } from '@/lib/org-brand';
import { LEAD_GOALS, leadFormPath } from '@/lib/leads';
import { fill, parseLang, qs, tr, type PortalKey } from '@/lib/portal-i18n';
import { submitLeadAction } from './actions';

export const metadata: Metadata = { title: 'Get started', robots: { index: false } };

/** An agency's public enquiry form (English, or Spanish with `?lang=es`). It collects contact details only — never SSNs, dates of birth or account numbers. */
export default async function LeadFormPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ sent?: string; lang?: string }> }) {
  const { slug } = await params;
  const sp = await searchParams;
  const brand = await orgBrandBySlug(slug);
  if (!brand) notFound();
  const lang = parseLang(sp.lang);
  const t = tr(lang);
  const other = lang === 'es' ? 'en' : 'es';
  const link = 'font-medium text-brand-strong hover:underline';
  const footer = (
    <>
      {t('lead_already')} <Link href={`/portal/login${qs({ org: brand.slug, lang: lang === 'es' && 'es' })}`} className={link}>{t('lead_signIn')}</Link>
      {!sp.sent && <> · <Link href={`${leadFormPath(brand.slug)}${qs({ lang: other === 'es' && 'es' })}`} lang={other} hrefLang={other} className={link}>{other === 'es' ? 'Español' : 'English'}</Link></>}
    </>
  );
  if (sp.sent) {
    return (
      <AuthLayout portal brand={brand} lang={lang} title={t('lead_thanksTitle')} subtitle={fill(t('lead_thanksSub'), { org: brand.name })} footer={footer}>
        <p className="flex items-start gap-2.5 rounded-xl bg-ok-soft p-3.5 text-sm"><CheckCircle2 size={18} className="mt-0.5 shrink-0 text-ok" aria-hidden /> {t('lead_thanksNote')}</p>
      </AuthLayout>
    );
  }
  return (
    <AuthLayout portal brand={brand} lang={lang} title={t('lead_title')} subtitle={fill(t('lead_sub'), { org: brand.name })} footer={footer}>
      <ActionForm action={submitLeadAction} className="space-y-4">
        <input type="hidden" name="slug" value={brand.slug} />
        <input type="hidden" name="lang" value={lang} />
        {/* Honeypot: hidden from people, filled by bots. */}
        <div className="hidden" aria-hidden><label>Company website<input name="company_website" tabIndex={-1} autoComplete="off" /></label></div>
        <Field label={t('inv_name')} name="fullName" autoComplete="name" required maxLength={120} />
        <Field label={t('email')} name="email" type="email" autoComplete="email" required maxLength={200} />
        <Field label={t('phone')} name="phone" type="tel" autoComplete="tel" maxLength={30} hint={t('lead_optional')} />
        <Select label={t('lead_goal')} name="goal" placeholder={t('lead_choose')} options={Object.keys(LEAD_GOALS).map((value) => ({ value, label: t(`goal_${value}` as PortalKey) }))} />
        <Select label={t('lead_lang')} name="language" defaultValue={lang} options={[{ value: 'en', label: 'English' }, { value: 'es', label: 'Español' }]} />
        <TextArea label={t('lead_message')} name="message" rows={3} maxLength={1000} hint={t('lead_messageHint')} />
        <Check name="consent">{fill(t('lead_consent'), { org: brand.name })}</Check>
        <SubmitButton className="w-full" pendingText={t('sending')}>{t('send')}</SubmitButton>
      </ActionForm>
      <p className="mt-5 text-xs leading-relaxed text-muted">{t('lead_legal')}</p>
    </AuthLayout>
  );
}
