import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { AuthLayout } from '@/components/auth-layout';
import { ActionForm, Field, SubmitButton } from '@/components/forms';
import { verifyMfaAction, logoutAction } from '@/app/auth-actions';
import { requireSessionAnyStage } from '@/lib/auth/context';
import { PRODUCT } from '@/lib/product';

export const metadata: Metadata = { title: 'Two-step verification' };

export default async function MfaPage() {
  const s = await requireSessionAnyStage();
  if (!s.totpEnabled) redirect('/mfa/setup');
  if (s.mfaVerified) redirect(s.role === 'client' ? '/portal' : '/app');
  return (
    <AuthLayout title="Enter your code" subtitle={`Open your authenticator app and type the 6-digit code for ${PRODUCT.name}.`}>
      <ActionForm action={verifyMfaAction} className="space-y-4">
        <Field label="6-digit code" name="code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} pattern="\d{6}" required />
        <SubmitButton className="w-full" pendingText="Verifying…">Verify</SubmitButton>
      </ActionForm>
      <form action={logoutAction} className="mt-4"><button className="text-sm text-muted underline-offset-4 hover:underline" type="submit">Use a different account</button></form>
    </AuthLayout>
  );
}
