import Link from 'next/link';
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { AuthLayout } from '@/components/auth-layout';
import { ActionForm, Field, SubmitButton } from '@/components/forms';
import { loginAction } from '@/app/auth-actions';
import { currentSession } from '@/lib/auth/context';
import { orgBrandBySlug } from '@/lib/org-brand';
import { fill, parseLang, qs, tr } from '@/lib/portal-i18n';
import { portalLogoutAction } from '../actions';

export const metadata: Metadata = { title: 'Client portal sign in' };

export default async function PortalLogin({ searchParams }: { searchParams: Promise<{ error?: string; org?: string; reset?: string; lang?: string }> }) {
  const sp = await searchParams;
  const s = await currentSession();
  // A signed-in client whose record is gone is sent here by requireClient(). Sending them back to /portal would loop
  // forever, so they stay on this page, see why, and can sign out.
  const noRecord = sp.error === 'no-record';
  if (s && !(noRecord && s.role === 'client')) redirect(s.role === 'client' ? '/portal' : '/app');
  const brand = await orgBrandBySlug(sp.org);
  const lang = parseLang(sp.lang);
  const t = tr(lang);
  const other = lang === 'es' ? 'en' : 'es';
  return (
    <AuthLayout
      portal
      brand={brand}
      lang={lang}
      title={brand ? t('li_welcomeBack') : t('li_title')}
      subtitle={brand ? fill(t('li_subBrand'), { org: brand.name }) : t('li_sub')}
      footer={<>
        {!brand && <>{t('li_workHere')} <Link href="/login" className="font-medium text-brand-strong hover:underline">{t('li_staff')}</Link> · </>}
        <Link href={`/portal/login${qs({ org: brand?.slug, lang: other === 'es' && 'es' })}`} lang={other} hrefLang={other} className="font-medium text-brand-strong hover:underline">{other === 'es' ? 'Español' : 'English'}</Link>
      </>}
    >
      {noRecord && (
        <div className="mb-4 rounded-xl bg-warn-soft px-3.5 py-2.5 text-sm text-warn" role="alert">
          <p>{t('li_noRecord')}</p>
          {s && <form action={portalLogoutAction} className="mt-2"><button type="submit" className="font-medium underline underline-offset-4">{t('signOut')}</button></form>}
        </div>
      )}
      {sp.reset && <p className="mb-4 rounded-xl bg-ok-soft px-3.5 py-2.5 text-sm text-ok" role="status">{t('li_reset')}</p>}
      <ActionForm action={loginAction} className="space-y-4">
        <input type="hidden" name="portal" value="true" />
        <input type="hidden" name="lang" value={lang} />
        <Field label={t('email')} name="email" type="email" autoComplete="username" required />
        <Field label={t('password')} name="password" type="password" autoComplete="current-password" required />
        <p className="text-right text-xs"><Link href={`/forgot-password${qs({ portal: '1', org: brand?.slug, lang: lang === 'es' && 'es' })}`} className="text-muted hover:underline">{t('li_forgot')}</Link></p>
        <SubmitButton className="w-full" pendingText={t('li_signingIn')}>{t('li_signIn')}</SubmitButton>
      </ActionForm>
      <p className="mt-6 text-xs text-muted">{fill(t('li_newHere'), { org: brand ? brand.name : t('li_yourSpecialist') })}</p>
    </AuthLayout>
  );
}
