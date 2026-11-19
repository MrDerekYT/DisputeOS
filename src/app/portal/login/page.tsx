import { emailDisabled } from '@/lib/mailer';
import Link from 'next/link';
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import { AuthLayout } from '@/components/auth-layout';
import { ActionForm, Field, SubmitButton } from '@/components/forms';
import { InlineMessage } from '@/components/portal-kit';
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
        {!brand && <>{t('li_workHere')} <Link href="/login" className="link">{t('li_staff')}</Link> · </>}
        <Link href={`/portal/login${qs({ org: brand?.slug, lang: other === 'es' && 'es' })}`} lang={other} hrefLang={other} className="link">{other === 'es' ? 'Español' : 'English'}</Link>
      </>}
    >
      {noRecord && (
        <InlineMessage tone="warn" role="alert" icon={<AlertTriangle size={18} />} className="mb-5">
          <p>{t('li_noRecord')}</p>
          {s && <form action={portalLogoutAction} className="mt-2"><button type="submit" className="link rounded-md">{t('signOut')}</button></form>}
        </InlineMessage>
      )}
      {sp.reset && <InlineMessage tone="ok" role="status" icon={<CheckCircle2 size={18} />} className="mb-5">{t('li_reset')}</InlineMessage>}
      <ActionForm action={loginAction} className="space-y-4">
        <input type="hidden" name="portal" value="true" />
        <input type="hidden" name="lang" value={lang} />
        <Field label={t('email')} name="email" type="email" autoComplete="username" required />
        <div>
          <Field label={t('password')} name="password" type="password" autoComplete="current-password" required />
          <p className="mt-2 text-right text-[0.8125rem]"><Link href={`/forgot-password${qs({ portal: '1', org: brand?.slug, lang: lang === 'es' && 'es' })}`} className="rounded-md text-muted underline underline-offset-4 hover:text-ink">{t('li_forgot')}</Link></p>
        </div>
        <SubmitButton className="btn-lg w-full" pendingText={t('li_signingIn')}>{t('li_signIn')}</SubmitButton>
      </ActionForm>
      <p className="mt-6 border-t border-line pt-4 text-[0.8125rem] leading-relaxed text-muted">{fill(t(emailDisabled() ? 'li_newHereNoEmail' : 'li_newHere'), { org: brand ? brand.name : t('li_yourSpecialist') })}</p>
    </AuthLayout>
  );
}
