import { ActionForm, Check, SubmitButton } from '@/components/forms';
import { Badge, Section } from '@/components/ui';
import type { Ctx } from '@/lib/auth/context';
import { smsConsentHistory, smsConsentText } from '@/lib/client-updates/service';
import { APPROVAL_COLS, outreachApproved, type ApprovalRow } from '@/lib/outreach-approval';
import { fill, type Lang, type PortalKey } from '@/lib/portal-i18n';
import { smsUsable, toUsE164 } from '@/lib/sms';
import { fmtDate } from '@/lib/util';
import { portalSmsOptInAction, portalSmsOptOutAction } from '../../sms-actions';

/**
 * Text message updates: the client agrees or withdraws here. Shown when a text could really follow, or when there is a
 * consent to withdraw. A text can follow only when a text service is connected and the platform operator has approved
 * the workspace (src/lib/outreach-approval.ts), and only to a US number (src/lib/sms.ts), so the opt-in is offered
 * under those conditions only. The consent wording on screen is exactly what is stored with the record.
 */
export async function SmsConsentCard({ ctx, clientId, phone, lang, t }: { ctx: Ctx; clientId: string; phone: string | null; lang: Lang; t: (k: PortalKey) => string }) {
  const { history, org } = await ctx.tx(async (db) => ({
    history: await smsConsentHistory(db, clientId),
    org: await db.row<ApprovalRow>(`select ${APPROVAL_COLS} from public.organizations where id = $1`, [ctx.orgId]),
  }));
  const active = history.find((h) => !h.revoked_at);
  if (!active && !(smsUsable() && outreachApproved(org))) return null;
  // A consent on file for a number that is not a US one sends nothing, so it reads as off here.
  const e164 = toUsE164(phone);
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
