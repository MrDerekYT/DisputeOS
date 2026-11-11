import type { Metadata } from 'next';
import Link from 'next/link';
import { AuthLayout } from '@/components/auth-layout';
import { ActionForm, Field, SubmitButton } from '@/components/forms';
import { acceptInviteAction } from '@/app/auth-actions';
import { getInvite } from '@/lib/auth/service';
import { titleCase } from '@/lib/util';
import { orgBrandById } from '@/lib/org-brand';
import { PRODUCT } from '@/lib/product';

export const metadata: Metadata = { title: 'Accept invitation' };

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const inv = await getInvite(token);
  if (!inv) {
    return (
      <AuthLayout title="Invitation not valid" subtitle="It may have expired or already been used. Ask your contact for a new one." footer={<Link href="/login" className="font-medium text-brand-strong hover:underline">Go to sign in</Link>}>
        <></>
      </AuthLayout>
    );
  }
  const isClient = inv.role === 'client';
  const brand = isClient ? await orgBrandById(inv.orgId) : null;
  return (
    <AuthLayout
      portal={isClient}
      brand={brand}
      title={isClient ? `Welcome${inv.clientName ? `, ${inv.clientName.split(' ')[0]}` : ''}` : `Join ${inv.orgName}`}
      subtitle={isClient ? `${inv.orgName} has invited you to your secure client portal.` : `You have been invited as ${titleCase(inv.role)}. Set a password to get started.`}
    >
      <ActionForm action={acceptInviteAction} className="space-y-4">
        <input type="hidden" name="token" value={token} />
        <div>
          <label className="label">Email</label>
          <input className="field bg-raised" value={inv.email} readOnly aria-readonly />
        </div>
        <Field label="Your name" name="fullName" defaultValue={inv.clientName ?? ''} autoComplete="name" required />
        <Field label="Password" name="password" type="password" autoComplete="new-password" required hint={isClient ? 'At least 10 characters, not used anywhere else. If you already have a portal account with this email, enter that password.' : `At least 10 characters. If you already have a ${PRODUCT.name} account with this email, enter its current password.`} />
        <SubmitButton className="w-full" pendingText="Setting up…">Accept invitation</SubmitButton>
      </ActionForm>
    </AuthLayout>
  );
}
