import Link from 'next/link';
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { AuthLayout } from '@/components/auth-layout';
import { ActionForm, Field, SubmitButton } from '@/components/forms';
import { loginAction } from '@/app/auth-actions';
import { currentSession } from '@/lib/auth/context';
import { orgBrandBySlug } from '@/lib/org-brand';

export const metadata: Metadata = { title: 'Client portal sign in' };

export default async function PortalLogin({ searchParams }: { searchParams: Promise<{ error?: string; org?: string }> }) {
  const sp = await searchParams;
  const s = await currentSession();
  if (s) redirect(s.role === 'client' ? '/portal' : '/app');
  const brand = await orgBrandBySlug(sp.org);
  return (
    <AuthLayout
      portal
      brand={brand}
      title={brand ? 'Welcome back' : 'Your client portal'}
      subtitle={brand ? `Sign in to see your progress with ${brand.name}, upload documents and message your specialist.` : 'Check progress, upload documents and message your specialist.'}
      footer={brand ? undefined : <>Work here? <Link href="/login" className="font-medium text-brand-strong hover:underline">Staff sign in</Link></>}
    >
      {sp.error === 'no-record' && <p className="mb-4 rounded-xl bg-warn-soft px-3.5 py-2.5 text-sm text-warn" role="alert">We could not find a client record for this account. Contact your specialist.</p>}
      <ActionForm action={loginAction} className="space-y-4">
        <input type="hidden" name="portal" value="true" />
        <Field label="Email" name="email" type="email" autoComplete="username" required />
        <Field label="Password" name="password" type="password" autoComplete="current-password" required />
        <p className="text-right text-xs"><Link href="/forgot-password" className="text-muted hover:underline">Forgot password?</Link></p>
        <SubmitButton className="w-full" pendingText="Signing in…">Sign in</SubmitButton>
      </ActionForm>
      <p className="mt-6 text-xs text-muted">New here? {brand ? brand.name : 'Your specialist'} will email you an invitation to create your portal account.</p>
    </AuthLayout>
  );
}
