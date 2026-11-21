import Link from 'next/link';
import { MessageCircle } from 'lucide-react';
import { ActionForm, Check, Field, SubmitButton } from '@/components/forms';
import { toDay } from '@/lib/business-days';
import { fill, type Lang, type PortalKey } from '@/lib/portal-i18n';
import { portalCancelAgreementAction } from './actions';

/** "December 3, 2026" / "3 de diciembre de 2026" for a calendar day. */
export const portalLongDay = (day: string, lang: Lang) =>
  new Date(`${day}T00:00:00Z`).toLocaleDateString(lang === 'es' ? 'es-US' : 'en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

/**
 * What a link to a signed document's PDF is called. A document the client e-signed is a copy of what they signed
 * (`copy`, for example pr_copy). One the client signed on paper and the agency recorded (recorded_by) is not: its PDF
 * is the app's text of that paper agreement on the day it was recorded, so it is called that, with that day in the
 * agency's zone (`paper`: pr_paperText or cx_paperText).
 */
export const copyLabel = (row: { recorded_by: string | null; signed_at: string }, tz: string, t: (k: PortalKey) => string, lang: Lang, copy: PortalKey = 'pr_copy', paper: PortalKey = 'pr_paperText') =>
  (row.recorded_by ? fill(t(paper), { date: portalLongDay(toDay(row.signed_at, tz), lang) }) : t(copy));

/**
 * The service agreement the client cancelled in the portal, for its copy (the PDF says it was cancelled): the latest
 * one, with its text stored. `rows` newest first, as loadClientAgreements gives them.
 */
export const cancelledCopy = <R extends { kind: string; has_text: boolean; revoked_reason: string | null }>(rows: readonly R[]): R | null =>
  rows.find((r) => r.kind === 'croa_contract' && r.revoked_reason === 'client_cancelled' && r.has_text) ?? null;

/**
 * "Cancel my agreement" while the cancellation period runs (15 U.S.C. § 1679e(a)); afterwards only a way to message the
 * specialist. `endsOn` is the last day of the period, `open` whether today is still inside it (both from the records).
 */
export function CancelAgreement({ endsOn, open, org, t, lang }: { endsOn: string; open: boolean; org: string; t: (k: PortalKey) => string; lang: Lang }) {
  const date = portalLongDay(endsOn, lang);
  if (!open) {
    return (
      <div className="text-sm">
        <p className="text-muted">{fill(t('cx_closed'), { date })}</p>
        <Link href="/portal/messages" className="btn-quiet btn-sm mt-2"><MessageCircle size={15} aria-hidden /> {t('messageTeam')}</Link>
      </div>
    );
  }
  return (
    <section aria-labelledby="cancel-title" className="rounded-2xl border border-line p-4 sm:p-5">
      <h3 id="cancel-title" className="text-[0.9375rem] font-semibold">{t('cx_title')}</h3>
      <p className="mt-1 text-sm text-muted">{fill(t('cx_body'), { date, org })}</p>
      <ActionForm action={portalCancelAgreementAction} className="mt-3 max-w-lg space-y-3">
        <Field label={t('typeName')} name="signedName" autoComplete="name" required />
        <Check name="confirm" required>{t('cx_confirm')}</Check>
        <SubmitButton variant="danger">{t('cx_button')}</SubmitButton>
      </ActionForm>
    </section>
  );
}
