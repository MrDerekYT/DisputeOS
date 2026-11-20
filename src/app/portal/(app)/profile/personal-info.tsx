import { ActionForm, Field, Select, SubmitButton } from '@/components/forms';
import { Badge, Section } from '@/components/ui';
import type { Ctx } from '@/lib/auth/context';
import { loadMarks, PI_BUREAUS, PI_KINDS } from '@/lib/credit/personal-info';
import type { PortalKey } from '@/lib/portal-i18n';
import { BUREAU_LABEL } from '@/lib/util';
import { portalAddPersonalInfoAction, portalRemovePersonalInfoAction } from '../../personal-info-actions';

/**
 * The client's own list of entries on their credit reports that are wrong or not theirs. The portal does not show
 * report data, so each entry is typed as the report shows it. Staff draft the correction letter (in English) from it.
 */
export async function PersonalInfoCard({ ctx, clientId, t }: { ctx: Ctx; clientId: string; t: (k: PortalKey) => string }) {
  const marks = await ctx.tx((db) => loadMarks(db, clientId));
  return (
    <Section title={t('pi_title')} id="personal-info" hint={t('pi_intro')}>
      {marks.length === 0 ? <p className="text-sm text-muted">{t('pi_none')}</p> : (
        <ul className="divide-y divide-line text-[0.9375rem]">
          {marks.map((m) => (
            <li key={m.id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 py-2.5 first:pt-0">
              <span className="min-w-0 [overflow-wrap:anywhere]">
                <span className="text-muted">{BUREAU_LABEL[m.bureau]} · {t(`pi_k_${m.kind}` as PortalKey)}:</span> {m.value}
                <span className="text-muted"> · {m.issue === 'not_mine' ? t('pi_saidNotMine') : `${t('pi_saidIncorrect')}${m.correctValue ? `, ${t('pi_shouldBe')} ${m.correctValue}` : ''}`}</span>
              </span>
              {m.source === 'client' ? (
                <ActionForm action={portalRemovePersonalInfoAction}>
                  <input type="hidden" name="markId" value={m.id} />
                  <SubmitButton variant="ghost" className="btn-sm">{t('pi_remove')}</SubmitButton>
                </ActionForm>
              ) : <Badge>{t('pi_byTeam')}</Badge>}
            </li>
          ))}
        </ul>
      )}
      <details className="mt-3 border-t border-line pt-3">
        <summary className="link cursor-pointer text-sm">{t('pi_add')}</summary>
        <ActionForm action={portalAddPersonalInfoAction} resetOnSuccess className="mt-3 space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Select label={t('pi_bureau')} name="bureau" options={PI_BUREAUS.map((b) => ({ value: b, label: BUREAU_LABEL[b] }))} />
            <Select label={t('pi_kind')} name="kind" options={PI_KINDS.map((k) => ({ value: k, label: t(`pi_k_${k}` as PortalKey) }))} />
          </div>
          <Field label={t('pi_value')} name="value" required maxLength={300} />
          <div className="grid gap-3 sm:grid-cols-2">
            <Select label={t('pi_issue')} name="issue" options={[{ value: 'not_mine', label: t('pi_notMine') }, { value: 'incorrect', label: t('pi_incorrect') }]} />
            <Field label={t('pi_correct')} name="correctValue" maxLength={300} />
          </div>
          <SubmitButton variant="secondary">{t('save')}</SubmitButton>
        </ActionForm>
      </details>
    </Section>
  );
}
