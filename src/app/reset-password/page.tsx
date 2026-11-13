import Link from 'next/link';
import type { Metadata } from 'next';
import { AuthLayout } from '@/components/auth-layout';
import { ActionForm, Field, SubmitButton } from '@/components/forms';
import { resetPasswordAction } from '@/app/auth-actions';

export const metadata: Metadata = { title: 'Choose a new password' };

export default async function ResetPasswordPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token } = await searchParams;
  if (!token) {
    return (
      <AuthLayout title="Link not valid" subtitle="This reset link is missing its token." footer={<Link href="/forgot-password" className="font-medium text-brand-strong hover:underline">Request a new link</Link>}>
        <></>
      </AuthLayout>
    );
  }
  return (
    <AuthLayout title="Choose a new password" subtitle="Signing in again will be required on all devices.">
      <ActionForm action={resetPasswordAction} className="space-y-4">
        <input type="hidden" name="token" value={token} />
        <Field label="New password" name="password" type="password" autoComplete="new-password" required hint="At least 10 characters." />
        <Field label="Confirm new password" name="confirm" type="password" autoComplete="new-password" required />
        <SubmitButton className="w-full" pendingText="Saving…">Update password</SubmitButton>
      </ActionForm>
    </AuthLayout>
  );
}
