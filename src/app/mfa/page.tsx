import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { AuthLayout } from '@/components/auth-layout';
import { ActionForm, Field, SubmitButton } from '@/components/forms';
import { verifyMfaAction, logoutAction } from '@/app/auth-actions';
import { portalLogoutAction } from '@/app/portal/actions';
import { requireSessionAnyStage } from '@/lib/auth/context';
import { orgBrandById } from '@/lib/org-brand';
import { portalLangForUser } from '@/lib/portal';
import { fill, tr } from '@/lib/portal-i18n';
import { PRODUCT } from '@/lib/product';

export const metadata: Metadata = { title: 'Two-step verification' };

export default async function MfaPage() {
  const s = await requireSessionAnyStage();
  if (!s.totpEnabled) redirect('/mfa/setup');
  if (s.mfaVerified) redirect(s.role === 'client' ? '/portal' : '/app');
  // A client sees their agency's name, their own language, and goes back to their portal sign-in — never the staff one.
  const isClient = s.role === 'client';
  const lang = isClient ? await portalLangForUser(s.userId) : 'en';
  const brand = isClient ? await orgBrandById(s.orgId) : null;
  const t = tr(lang);
  return (
    <AuthLayout portal={isClient} brand={brand} lang={lang} title={t('mfa_enterTitle')}
      subtitle={isClient ? fill(t('mfa_enterSub'), { org: s.orgName }) : `Open your authenticator app and type the 6-digit code for ${PRODUCT.name}.`}>
      <ActionForm action={verifyMfaAction} className="space-y-4">
        <input type="hidden" name="lang" value={lang} />
        <Field label={t('mfa_code')} name="code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} pattern="\d{6}" required />
        <SubmitButton className="w-full" pendingText={t('mfa_verifying')}>{t('mfa_verify')}</SubmitButton>
      </ActionForm>
      <form action={isClient ? portalLogoutAction : logoutAction} className="mt-4"><button className="text-sm text-muted underline-offset-4 hover:underline" type="submit">{t('mfa_other')}</button></form>
    </AuthLayout>
  );
}
