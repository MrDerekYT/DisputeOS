import type { Metadata } from 'next';
import Link from 'next/link';
import { AuthLayout } from '@/components/auth-layout';
import { ActionForm, Field, SubmitButton } from '@/components/forms';
import { acceptInviteAction } from '@/app/auth-actions';
import { getInvite } from '@/lib/auth/service';
import { titleCase } from '@/lib/util';
import { orgBrandById } from '@/lib/org-brand';
import { fill, tr } from '@/lib/portal-i18n';
import { PRODUCT } from '@/lib/product';

export const metadata: Metadata = { title: 'Accept invitation' };

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const inv = await getInvite(token);
  if (!inv) {
    return (
      <AuthLayout title="Invitation not valid" subtitle="It may have expired or already been used. Ask your contact for a new one." footer={<Link href="/login" className="btn-primary btn-lg w-full">Go to sign in</Link>}>
        <></>
      </AuthLayout>
    );
  }
  const isClient = inv.role === 'client';
  const brand = isClient ? await orgBrandById(inv.orgId) : null;
  // A client is greeted in the language their specialist recorded for them; staff invitations stay in English.
  const lang = isClient ? inv.clientLang : 'en';
  const t = tr(lang);
  return (
    <AuthLayout
      portal={isClient}
      brand={brand}
      lang={lang}
      title={isClient ? `${t('inv_welcome')}${inv.clientName ? `, ${inv.clientName.split(' ')[0]}` : ''}` : `Join ${inv.orgName}`}
      subtitle={isClient ? fill(t('inv_sub'), { org: inv.orgName }) : `You have been invited as ${titleCase(inv.role)}. Set a password to get started.`}
    >
      <ActionForm action={acceptInviteAction} className="space-y-4">
        <input type="hidden" name="token" value={token} />
        <input type="hidden" name="lang" value={lang} />
        <div>
          <label className="label" htmlFor="inviteEmail">{t('email')}</label>
          <input id="inviteEmail" className="field !bg-raised text-muted" value={inv.email} readOnly aria-readonly />
        </div>
        <Field label={t('inv_name')} name="fullName" defaultValue={inv.clientName ?? ''} autoComplete="name" required />
        <Field label={t('password')} name="password" type="password" autoComplete="new-password" required hint={isClient ? t('inv_pwHint') : `At least 10 characters. If you already have a ${PRODUCT.name} account with this email, enter its current password.`} />
        <SubmitButton className="btn-lg w-full" pendingText={t('inv_settingUp')}>{t('inv_accept')}</SubmitButton>
      </ActionForm>
    </AuthLayout>
  );
}
