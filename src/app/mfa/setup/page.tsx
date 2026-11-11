import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { AuthLayout } from '@/components/auth-layout';
import { ActionForm, Field, SubmitButton } from '@/components/forms';
import { enrollMfaAction } from '@/app/auth-actions';
import { requireSessionAnyStage } from '@/lib/auth/context';
import { beginTotpEnrollment } from '@/lib/auth/service';
import { PRODUCT } from '@/lib/product';

export const metadata: Metadata = { title: 'Set up two-step verification' };

export default async function MfaSetupPage() {
  const s = await requireSessionAnyStage();
  if (s.totpEnabled) redirect(s.mfaVerified ? (s.role === 'client' ? '/portal' : '/app') : '/mfa');
  const enrol = await beginTotpEnrollment(s.userId);
  if ('ok' in enrol) redirect('/mfa');
  const grouped = enrol.secret.replace(/(.{4})/g, '$1 ').trim();
  return (
    <AuthLayout
      title="Protect your account"
      subtitle={`${PRODUCT.name} holds sensitive financial and identity records, so staff accounts require two-step verification.`}
    >
      <ol className="mb-6 space-y-4 text-sm">
        <li><span className="font-semibold">1.</span> Open an authenticator app (1Password, Google Authenticator, Authy…) and add a new account using <em>enter a setup key</em>.</li>
        <li>
          <span className="font-semibold">2.</span> Use this key:
          <code className="mt-2 block select-all break-all rounded-xl border border-line bg-raised px-3.5 py-3 font-mono text-base tracking-wider" data-testid="totp-secret">{grouped}</code>
          <span className="mt-1 block text-xs text-muted">Account: {s.email} · Type: time-based · 6 digits</span>
        </li>
        <li><span className="font-semibold">3.</span> Enter the 6-digit code it shows:</li>
      </ol>
      <ActionForm action={enrollMfaAction} className="space-y-4">
        <Field label="6-digit code" name="code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} pattern="\d{6}" required />
        <SubmitButton className="w-full" pendingText="Verifying…">Turn on two-step verification</SubmitButton>
      </ActionForm>
    </AuthLayout>
  );
}
