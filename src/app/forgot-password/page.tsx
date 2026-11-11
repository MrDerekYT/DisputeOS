import Link from 'next/link';
import type { Metadata } from 'next';
import { AuthLayout } from '@/components/auth-layout';
import { ActionForm, Field, SubmitButton } from '@/components/forms';
import { forgotPasswordAction } from '@/app/auth-actions';

export const metadata: Metadata = { title: 'Reset password' };

export default function ForgotPasswordPage() {
  return (
    <AuthLayout title="Reset your password" subtitle="Enter your email and we will send you a link." footer={<Link href="/login" className="font-medium text-brand-strong hover:underline">Back to sign in</Link>}>
      <ActionForm action={forgotPasswordAction} className="space-y-4">
        <Field label="Email" name="email" type="email" autoComplete="email" required />
        <SubmitButton className="w-full" pendingText="Sending…">Send reset link</SubmitButton>
      </ActionForm>
    </AuthLayout>
  );
}
