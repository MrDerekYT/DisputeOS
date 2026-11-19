import Link from 'next/link';
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { CheckCircle2 } from 'lucide-react';
import { AuthLayout } from '@/components/auth-layout';
import { ActionForm, Field, SubmitButton } from '@/components/forms';
import { InlineMessage } from '@/components/portal-kit';
import { loginAction } from '@/app/auth-actions';
import { currentSession } from '@/lib/auth/context';
import { PRODUCT } from '@/lib/product';

export const metadata: Metadata = { title: 'Sign in' };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string; reset?: string }> }) {
  const sp = await searchParams;
  const s = await currentSession();
  if (s) redirect(s.role === 'client' ? '/portal' : '/app');
  return (
    <AuthLayout
      title="Welcome back"
      subtitle={`Sign in to your ${PRODUCT.name} workspace.`}
      footer={<>New to {PRODUCT.name}? <Link href="/signup" className="link">Start a free trial</Link>. Are you a client? <Link href="/portal/login" className="link">Client portal</Link></>}
    >
      {sp.reset && <InlineMessage tone="ok" role="status" icon={<CheckCircle2 size={18} />} className="mb-5">Password updated. Sign in with your new password.</InlineMessage>}
      <ActionForm action={loginAction} className="space-y-4">
        <input type="hidden" name="next" value={sp.next ?? ''} />
        <Field label="Email" name="email" type="email" autoComplete="username" required />
        <div>
          <Field label="Password" name="password" type="password" autoComplete="current-password" required />
          <p className="mt-2 text-right text-[0.8125rem]"><Link href="/forgot-password" className="rounded-md text-muted underline underline-offset-4 hover:text-ink">Forgot password?</Link></p>
        </div>
        <SubmitButton className="btn-lg w-full" pendingText="Signing in…">Sign in</SubmitButton>
      </ActionForm>
    </AuthLayout>
  );
}
