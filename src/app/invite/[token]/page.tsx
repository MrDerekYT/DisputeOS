import type { Metadata } from 'next';
import Link from 'next/link';
import { AuthLayout } from '@/components/auth-layout';
import { ActionForm, Field, SubmitButton } from '@/components/forms';
import { acceptInviteAction } from '@/app/auth-actions';
import { getInvite, inviteNotice } from '@/lib/auth/service';
import { titleCase } from '@/lib/util';
import { orgBrandById, portalLoginPath } from '@/lib/org-brand';
import { ONBOARDING_STEPS } from '@/lib/onboarding';
import { fill, parseLang, qs, tr, type PortalKey } from '@/lib/portal-i18n';
import { PRODUCT } from '@/lib/product';

export const metadata: Metadata = { title: 'Accept invitation' };

export default async function InvitePage({ params, searchParams }: { params: Promise<{ token: string }>; searchParams: Promise<{ lang?: string }> }) {
  const { token } = await params;
  const sp = await searchParams;
  const inv = await getInvite(token);
  if (!inv) return linkNotValid(token, sp.lang);
  const isClient = inv.role === 'client';
  const brand = isClient ? await orgBrandById(inv.orgId) : null;
  // A client is greeted in the language their specialist recorded for them, or the one they switch to here; the one
  // they accept in becomes their portal's language. Staff invitations stay in English.
  const lang = isClient ? (sp.lang ? parseLang(sp.lang) : inv.clientLang) : 'en';
  const t = tr(lang);
  const other = lang === 'es' ? 'en' : 'es';
  const first = inv.clientName?.trim().split(/\s+/)[0];
  return (
    <AuthLayout
      portal={isClient}
      brand={brand}
      lang={lang}
      title={isClient ? (first ? fill(t('inv_title'), { first }) : t('inv_titleNoName')) : `Join ${inv.orgName}`}
      subtitle={isClient ? fill(t('inv_lead'), { org: inv.orgName }) : `You have been invited as ${titleCase(inv.role)}. Set a password to get started.`}
      footer={isClient ? <Link href={`/invite/${encodeURIComponent(token)}${qs({ lang: other })}`} lang={other} hrefLang={other} className="link">{other === 'es' ? 'Español' : 'English'}</Link> : undefined}
    >
      {isClient && (
        <section aria-labelledby="steps-title" className="mb-7 rounded-2xl bg-raised p-4 sm:p-5">
          <h2 id="steps-title" className="text-[0.9375rem] font-semibold">{t('inv_stepsTitle')}</h2>
          <ol className="mt-3 space-y-2.5 text-sm">
            {ONBOARDING_STEPS.map((k, i) => (
              <li key={k} className="flex gap-3">
                <span aria-hidden className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-brand text-xs font-semibold text-brand-ink">{i + 1}</span>
                <span className="min-w-0"><span className="block font-medium">{t(`wl_s_${k}` as PortalKey)}</span><span className="block text-[0.8125rem] text-muted">{t(`wl_sd_${k}` as PortalKey)}</span></span>
              </li>))}
          </ol>
          <p className="mt-3 text-[0.8125rem] text-muted">{t('inv_stepsTime')}</p>
        </section>
      )}
      <ActionForm action={acceptInviteAction} className="space-y-4">
        <input type="hidden" name="token" value={token} />
        <input type="hidden" name="lang" value={lang} />
        <div>
          <label className="label" htmlFor="inviteEmail">{t('email')}</label>
          <input id="inviteEmail" className="field !bg-raised text-muted" value={inv.email} readOnly aria-readonly />
        </div>
        <Field label={t('inv_name')} name="fullName" defaultValue={inv.clientName ?? ''} autoComplete="name" required />
        <Field label={t('password')} name="password" type="password" autoComplete="new-password" required hint={isClient ? t('inv_pwHint') : `At least 10 characters. If you already have a ${PRODUCT.name} account with this email, enter its current password.`} />
        <Field label={isClient ? t('inv_confirm') : 'Confirm password'} name="confirm" type="password" autoComplete="new-password" required />
        <SubmitButton className="btn-lg w-full" pendingText={t('inv_settingUp')}>{t('inv_accept')}</SubmitButton>
      </ActionForm>
    </AuthLayout>
  );
}

/**
 * A link that no longer works. A client's link that was used, expired or replaced gets a kind message in their language
 * and the way to their agency's own sign-in page; anything else gets the plain staff message.
 */
async function linkNotValid(token: string, asked?: string) {
  const n = await inviteNotice(token);
  if (n?.role === 'client') {
    const lang = asked ? parseLang(asked) : n.clientLang;
    const t = tr(lang);
    const brand = await orgBrandById(n.orgId);
    const signIn = n.orgMode === 'agency' ? portalLoginPath(n.orgSlug) : '/portal/login';
    const href = `${signIn}${lang === 'es' ? `${signIn.includes('?') ? '&' : '?'}lang=es` : ''}`;
    return (
      <AuthLayout portal brand={brand} lang={lang} title={t('inv_usedTitle')} subtitle={fill(t('inv_usedBody'), { org: n.orgName })}
        footer={<Link href={href} className="btn-primary btn-lg w-full">{t('li_signIn')}</Link>}>
        <></>
      </AuthLayout>
    );
  }
  if (n) {
    return (
      <AuthLayout title="Invitation not valid" subtitle="It may have expired or already been used. Ask your contact for a new one." footer={<Link href="/login" className="btn-primary btn-lg w-full">Go to sign in</Link>}>
        <></>
      </AuthLayout>
    );
  }
  // A link that was never issued (often one cut short by an email program): say nothing about any agency.
  const lang = parseLang(asked);
  const t = tr(lang);
  return (
    <AuthLayout portal lang={lang} title={t('inv_badTitle')} subtitle={t('inv_badBody')}
      footer={<><Link href={`/portal/login${qs({ lang: lang === 'es' && 'es' })}`} className="btn-primary btn-lg w-full">{t('fp_portalLink')}</Link><p className="mt-4 text-center">{t('li_workHere')} <Link href="/login" className="link">{t('li_staff')}</Link></p></>}>
      <></>
    </AuthLayout>
  );
}
