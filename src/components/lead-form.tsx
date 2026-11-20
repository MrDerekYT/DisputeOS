import type { ReactNode } from 'react';
import { Check, Field, Select, SubmitButton, TextArea } from '@/components/forms';
import { LEAD_GOALS } from '@/lib/leads';
import { leadSmsConsentText } from '@/lib/lead-texts';
import { fill, tr, type Lang, type PortalKey } from '@/lib/portal-i18n';

/**
 * The fields of an agency's public enquiry form: the same ones on /start/<slug> and on the agency's website. Put it
 * inside an ActionForm whose action calls submitLead. It collects contact details only, and includes the honeypot
 * and the consent box that submitLead requires.
 *
 * `offerTexts` adds a second box, for text messages. It is separate from the "you may contact me" box, never ticked
 * for the person, optional, and worded on its own (the wording is the consent that gets stored). It is only shown
 * when the agency has switched text follow-up on and a text service is connected; without a tick no text is sent.
 */
export function LeadFields({ slug, orgName, lang, src, offerTexts, children }: { slug: string; orgName: string; lang: Lang; src?: string | null; offerTexts?: boolean; children?: ReactNode }) {
  const t = tr(lang);
  return (
    <>
      <input type="hidden" name="slug" value={slug} />
      <input type="hidden" name="lang" value={lang} />
      {src && <input type="hidden" name="src" value={src} />}
      {/* Honeypot: hidden from people, filled by bots. */}
      <div className="hidden" aria-hidden><label>Company website<input name="company_website" tabIndex={-1} autoComplete="off" /></label></div>
      <Field label={t('inv_name')} name="fullName" autoComplete="name" required maxLength={120} />
      <Field label={t('email')} name="email" type="email" autoComplete="email" required maxLength={200} />
      <Field label={t('phone')} name="phone" type="tel" autoComplete="tel" maxLength={30} hint={t('lead_optional')} />
      <Select label={t('lead_goal')} name="goal" placeholder={t('lead_choose')} options={Object.keys(LEAD_GOALS).map((value) => ({ value, label: t(`goal_${value}` as PortalKey) }))} />
      <Select label={t('lead_lang')} name="language" defaultValue={lang} options={[{ value: 'en', label: 'English' }, { value: 'es', label: 'Español' }]} />
      <TextArea label={t('lead_message')} name="message" rows={3} maxLength={1000} hint={t('lead_messageHint')} />
      <Check name="consent">{fill(t('lead_consent'), { org: orgName })}</Check>
      {offerTexts && <Check name="smsConsent">{leadSmsConsentText(lang, orgName)}</Check>}
      {children}
      <SubmitButton className="btn-lg w-full" pendingText={t('sending')}>{t('send')}</SubmitButton>
    </>
  );
}
