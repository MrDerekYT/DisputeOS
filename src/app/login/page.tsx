import Link from 'next/link';
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { AuthLayout } from '@/components/auth-layout';
import { ActionForm, Field, SubmitButton } from '@/components/forms';
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
      footer={<>New to {PRODUCT.name}? <Link href="/signup" className="font-medium text-brand-strong underline-offset-4 hover:underline">Start a free trial</Link>. Are you a client? <Link href="/portal/login" className="font-medium text-brand-strong underline-offset-4 hover:underline">Client portal</Link></>}
    >
      {sp.reset && <p className="mb-4 rounded-xl bg-ok-soft px-3.5 py-2.5 text-sm text-ok" role="status">Password updated. Sign in with your new password.</p>}
      <ActionForm action={loginAction} className="space-y-4">
        <input type="hidden" name="next" value={sp.next ?? ''} />
        <Field label="Email" name="email" type="email" autoComplete="username" required />
        <div>
          <Field label="Password" name="password" type="password" autoComplete="current-password" required />
          <p className="mt-1.5 text-right text-xs"><Link href="/forgot-password" className="text-muted underline-offset-4 hover:text-ink hover:underline">Forgot password?</Link></p>
        </div>
        <SubmitButton className="w-full" pendingText="Signing in…">Sign in</SubmitButton>
      </ActionForm>
    </AuthLayout>
  );
}
