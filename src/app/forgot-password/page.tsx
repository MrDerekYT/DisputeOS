import Link from 'next/link';
import type { Metadata } from 'next';
import { AuthLayout } from '@/components/auth-layout';
import { ActionForm, Field, SubmitButton } from '@/components/forms';
import { forgotPasswordAction } from '@/app/auth-actions';
import { orgBrandBySlug } from '@/lib/org-brand';
import { parseLang, qs, tr } from '@/lib/portal-i18n';

export const metadata: Metadata = { title: 'Reset password' };

/** Staff and clients share this page. Arriving from the client portal (`?portal=1`) keeps the agency's branding, the client's language and a way back to the portal. */
export default async function ForgotPasswordPage({ searchParams }: { searchParams: Promise<{ portal?: string; org?: string; lang?: string }> }) {
  const sp = await searchParams;
  const brand = await orgBrandBySlug(sp.org);
  const portal = Boolean(sp.portal || brand);
  const lang = portal ? parseLang(sp.lang) : 'en';
  const t = tr(lang);
  const link = 'link';
  const portalHref = `/portal/login${qs({ org: brand?.slug, lang: lang === 'es' && 'es' })}`;
  return (
    <AuthLayout portal={portal} brand={brand} lang={lang} title={t('fp_title')} subtitle={t('fp_sub')}
      footer={portal
        ? <Link href={portalHref} className={link}>{t('fp_back')}</Link>
        : <><Link href="/login" className={link}>{t('fp_back')}</Link> · <Link href="/portal/login" className={link}>{t('fp_portalLink')}</Link></>}>
      <ActionForm action={forgotPasswordAction} className="space-y-4">
        <input type="hidden" name="lang" value={lang} />
        <Field label={t('email')} name="email" type="email" autoComplete="email" required />
        <SubmitButton className="btn-lg w-full" pendingText={t('sending')}>{t('fp_send')}</SubmitButton>
      </ActionForm>
    </AuthLayout>
  );
}
