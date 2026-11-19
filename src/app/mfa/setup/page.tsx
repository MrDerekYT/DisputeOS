import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { AuthLayout } from '@/components/auth-layout';
import { ActionForm, Field, SubmitButton } from '@/components/forms';
import { enrollMfaAction } from '@/app/auth-actions';
import { requireSessionAnyStage } from '@/lib/auth/context';
import { beginTotpEnrollment } from '@/lib/auth/service';
import { orgBrandById } from '@/lib/org-brand';
import { portalLangForUser } from '@/lib/portal';
import { fill, tr } from '@/lib/portal-i18n';
import { PRODUCT } from '@/lib/product';

export const metadata: Metadata = { title: 'Set up two-step verification' };

export default async function MfaSetupPage() {
  const s = await requireSessionAnyStage();
  if (s.totpEnabled) redirect(s.mfaVerified ? (s.role === 'client' ? '/portal' : '/app') : '/mfa');
  const enrol = await beginTotpEnrollment(s.userId);
  if ('ok' in enrol) redirect('/mfa');
  const grouped = enrol.secret.replace(/(.{4})/g, '$1 ').trim();
  // For a client this is optional and reached from their profile: agency branding, their language, and a way back.
  const isClient = s.role === 'client';
  const lang = isClient ? await portalLangForUser(s.userId) : 'en';
  const brand = isClient ? await orgBrandById(s.orgId) : null;
  const t = tr(lang);
  return (
    <AuthLayout
      portal={isClient} brand={brand} lang={lang}
      title={t('mfa_setupTitle')}
      subtitle={isClient ? t('mfa_setupSub') : `${PRODUCT.name} holds sensitive financial and identity records, so staff accounts require two-step verification.`}
      footer={isClient ? <Link href="/portal/profile" className="font-medium text-brand-strong hover:underline">{t('mfa_notNow')}</Link> : undefined}
    >
      <ol className="mb-6 space-y-4 text-sm">
        <li><span className="font-semibold">1.</span> {t('mfa_s1')}</li>
        <li>
          <span className="font-semibold">2.</span> {t('mfa_s2')}
          <code className="mt-2 block select-all break-all rounded-xl border border-line bg-raised px-3.5 py-3 font-mono text-base tracking-wider" data-testid="totp-secret">{grouped}</code>
          <span className="mt-1 block text-xs text-muted">{fill(t('mfa_s2meta'), { email: s.email })}</span>
        </li>
        <li><span className="font-semibold">3.</span> {t('mfa_s3')}</li>
      </ol>
      <ActionForm action={enrollMfaAction} className="space-y-4">
        <input type="hidden" name="lang" value={lang} />
        <Field label={t('mfa_code')} name="code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} pattern="\d{6}" required />
        <SubmitButton className="w-full" pendingText={t('mfa_verifying')}>{t('twoStep')}</SubmitButton>
      </ActionForm>
    </AuthLayout>
  );
}
