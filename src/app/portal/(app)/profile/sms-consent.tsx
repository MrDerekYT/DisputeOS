import { ActionForm, Check, SubmitButton } from '@/components/forms';
import { Badge, Section } from '@/components/ui';
import type { Ctx } from '@/lib/auth/context';
import { smsConsentHistory, smsConsentText } from '@/lib/client-updates/service';
import { fill, type Lang, type PortalKey } from '@/lib/portal-i18n';
import { smsUsable, toE164 } from '@/lib/sms';
import { fmtDate } from '@/lib/util';
import { portalSmsOptInAction, portalSmsOptOutAction } from '../../sms-actions';

/**
 * Text message updates: the client agrees or withdraws here. Shown when texts can be sent at all, or when there is a
 * consent to withdraw. The consent wording on screen is exactly what is stored with the record.
 */
export async function SmsConsentCard({ ctx, clientId, phone, lang, t }: { ctx: Ctx; clientId: string; phone: string | null; lang: Lang; t: (k: PortalKey) => string }) {
  const history = await ctx.tx((db) => smsConsentHistory(db, clientId));
  const active = history.find((h) => !h.revoked_at);
  if (!active && !smsUsable()) return null;
  const e164 = toE164(phone);
  const changed = !!active && e164 !== active.phone;
  const last = history[0];
  return (
    <Section title={t('sms_title')} id="sms">
      <div className="flex flex-wrap items-center gap-2"><Badge tone={active && !changed ? 'ok' : 'neutral'}>{active && !changed ? t('sms_on') : t('sms_off')}</Badge></div>
      <p className="mt-2 text-sm text-muted">{t('sms_intro')}</p>
      {active && !changed && (
        <>
          <p className="mt-3 text-sm">{fill(t(active.source === 'staff' ? 'sms_staffRecorded' : 'sms_onSince'), { date: fmtDate(active.granted_at, lang), phone: active.phone })}</p>
          <ActionForm action={portalSmsOptOutAction} className="mt-3"><SubmitButton variant="secondary">{t('sms_turnOff')}</SubmitButton></ActionForm>
        </>
      )}
      {(!active || changed) && (
        <>
          {changed && e164 && <p className="mt-3 text-sm">{fill(t('sms_phoneChanged'), { phone: e164 })}</p>}
          {!active && last?.revoked_via === 'sms_stop' && last.revoked_at && <p className="mt-3 text-sm">{fill(t('sms_stopped'), { date: fmtDate(last.revoked_at, lang) })}</p>}
          {e164 ? (
            <ActionForm action={portalSmsOptInAction} className="mt-3 space-y-3">
              <p className="rounded-xl bg-raised p-3.5 text-sm leading-relaxed [overflow-wrap:anywhere]">{smsConsentText(lang, ctx.session.orgName, e164)}</p>
              <Check name="agree" required>{t('sms_agree')}</Check>
              <SubmitButton>{t('sms_turnOn')}</SubmitButton>
            </ActionForm>
          ) : <p className="mt-3 text-sm">{t('sms_needPhone')}</p>}
          {changed && <ActionForm action={portalSmsOptOutAction} className="mt-3"><SubmitButton variant="ghost">{t('sms_turnOff')}</SubmitButton></ActionForm>}
        </>
      )}
    </Section>
  );
}
