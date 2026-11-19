import type { Metadata } from 'next';
import Link from 'next/link';
import { CheckCircle2, ChevronDown, PenLine } from 'lucide-react';
import { ActionForm, Check, Field, Select, SubmitButton } from '@/components/forms';
import { PortalTitle } from '@/components/portal-kit';
import { Badge, Section } from '@/components/ui';
import { CONSENT_DOCS } from '@/lib/compliance/disclosures';
import { portalContext } from '@/lib/portal';
import type { PortalKey } from '@/lib/portal-i18n';
import { fmtDate } from '@/lib/util';
import { portalChangePasswordAction, portalSignConsentAction, portalUpdateProfileAction } from '../../actions';
import { PersonalInfoCard } from './personal-info';
import { SmsConsentCard } from './sms-consent';

export const metadata: Metadata = { title: 'Profile' };

export default async function PortalProfile() {
  const { ctx, client, t, lang } = await portalContext();
  const consents = await ctx.tx((db) => db.rows<{ kind: string; signed_at: string; revoked_at: string | null }>('select kind, signed_at, revoked_at from public.client_consents order by signed_at desc'));
  const a = client.address;
  return (
    <div className="space-y-6">
      <PortalTitle>{t('profile')}</PortalTitle>
      <div className="grid gap-6 lg:grid-cols-2 lg:items-start">
        <Section title={t('contact')}>
          <ActionForm action={portalUpdateProfileAction} className="space-y-3">
            <div><label className="label" htmlFor="profileEmail">{t('email')}</label><input id="profileEmail" className="field !bg-raised text-muted" readOnly value={client.email ?? ''} /><p className="hint">{t('emailNote')}</p></div>
            <Field label={t('phone')} name="phone" type="tel" defaultValue={client.phone} autoComplete="tel" />
            <Field label={`${t('address')} 1`} name="line1" defaultValue={a.line1} autoComplete="address-line1" /><Field label={`${t('address')} 2`} name="line2" defaultValue={a.line2} autoComplete="address-line2" />
            <div className="grid grid-cols-[minmax(0,1fr)_4.5rem_6.5rem] gap-3"><Field label={t('city')} name="city" defaultValue={a.city} autoComplete="address-level2" /><Field label={t('state')} name="state" defaultValue={a.state} maxLength={2} autoComplete="address-level1" /><Field label={t('zip')} name="zip" defaultValue={a.zip} autoComplete="postal-code" /></div>
            <Select label={t('language')} name="language" defaultValue={client.preferred_language} options={[{ value: 'en', label: 'English' }, { value: 'es', label: 'Español' }]} />
            <SubmitButton>{t('save')}</SubmitButton>
          </ActionForm>
        </Section>

        <div className="space-y-6">
          <Section title={t('security')}>
            <ActionForm action={portalChangePasswordAction} className="space-y-3">
              <Field label={t('currentPassword')} name="current" type="password" autoComplete="current-password" required />
              <Field label={t('newPassword')} name="next" type="password" autoComplete="new-password" required hint={t('passwordHint')} /><Field label={t('confirmPassword')} name="confirm" type="password" autoComplete="new-password" required />
              <SubmitButton variant="secondary">{t('changePassword')}</SubmitButton>
            </ActionForm>
            <p className="mt-4 text-sm">{ctx.session.totpEnabled ? <Badge tone="ok"><CheckCircle2 size={12} aria-hidden /> {t('twoStepOn')}</Badge> : <Link href="/mfa/setup" className="link">{t('twoStep')}</Link>}</p>
          </Section>
          <SmsConsentCard ctx={ctx} clientId={client.id} phone={client.phone} lang={lang} t={t} />
        </div>
      </div>

      <PersonalInfoCard ctx={ctx} clientId={client.id} t={t} />

      <Section title={t('agreements')} id="agreements">
        {lang === 'es' && <p className="mb-2 text-sm text-muted">{t('agreementLangNote')}</p>}
        <ul className="divide-y divide-line">
          {CONSENT_DOCS.map((doc) => {
            const rec = consents.find((c) => c.kind === doc.kind && !c.revoked_at);
            return (
              <li key={doc.kind} className="py-4 first:pt-0 last:pb-0">
                <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-[0.9375rem] font-semibold">{t(`consent_${doc.kind}_title` as PortalKey)}</h3>{rec ? <Badge tone="ok"><CheckCircle2 size={12} aria-hidden /> {t('signed')} {fmtDate(rec.signed_at, lang)}</Badge> : <Badge tone="warn"><PenLine size={12} aria-hidden /> {t('notSigned')}</Badge>}</div>
                <details className="group mt-2">
                  <summary className="flex w-fit cursor-pointer list-none items-center gap-1.5 rounded-md text-sm font-semibold text-brand-strong [&::-webkit-details-marker]:hidden">{t('readAgreement')} <ChevronDown size={16} aria-hidden className="transition-transform group-open:rotate-180" /></summary>
                  <p className="mt-2.5 whitespace-pre-wrap rounded-xl bg-raised p-3.5 text-sm leading-relaxed text-ink [overflow-wrap:anywhere]">{doc.text}</p>
                </details>
                {!rec && (
                  <ActionForm action={portalSignConsentAction} className="mt-4 max-w-lg space-y-3">
                    <input type="hidden" name="kind" value={doc.kind} />
                    <Field label={t('typeName')} name="signedName" id={`signedName-${doc.kind}`} autoComplete="name" required />
                    <Check name="agree" required>{t('agree')}</Check>
                    <SubmitButton>{t('signNow')}</SubmitButton>
                  </ActionForm>
                )}
              </li>);
          })}
        </ul>
      </Section>
    </div>
  );
}
