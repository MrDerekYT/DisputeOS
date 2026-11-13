import Link from 'next/link';
import type { Metadata } from 'next';
import { AuthLayout } from '@/components/auth-layout';
import { ActionForm, Check, Field, Select, SubmitButton } from '@/components/forms';
import { signUpAction } from '@/app/auth-actions';
import { PRODUCT } from '@/lib/product';

export const metadata: Metadata = { title: 'Start your free trial' };

export default function SignUpPage() {
  return (
    <AuthLayout
      title="Start your 14-day trial"
      subtitle="Set up your workspace in a couple of minutes. No card required."
      footer={<>Already have an account? <Link href="/login" className="font-medium text-brand-strong underline-offset-4 hover:underline">Sign in</Link></>}
    >
      <ActionForm action={signUpAction} className="space-y-4">
        <Field label="Your name" name="fullName" autoComplete="name" required />
        <Field label="Business name" name="orgName" autoComplete="organization" required />
        <Select
          label={`How will you use ${PRODUCT.name}?`}
          name="mode"
          defaultValue="agency"
          options={[{ value: 'agency', label: 'I run a credit repair business (staff, clients, portal)' }, { value: 'personal', label: 'I am repairing my own credit' }]}
        />
        <Field label="Work email" name="email" type="email" autoComplete="email" required />
        <Field label="Password" name="password" type="password" autoComplete="new-password" required hint="At least 10 characters. A passphrase works well." />
        <Field label="State (optional)" name="stateCode" maxLength={2} placeholder="e.g. FL" hint="Some states regulate credit services organizations. We will remind you to check your obligations." />
        <Check name="terms" required>
          I understand {PRODUCT.name} is software, not legal advice, and that I am responsible for complying with the laws that apply to my business.
        </Check>
        <SubmitButton className="w-full" pendingText="Creating workspace…">Create workspace</SubmitButton>
      </ActionForm>
    </AuthLayout>
  );
}
