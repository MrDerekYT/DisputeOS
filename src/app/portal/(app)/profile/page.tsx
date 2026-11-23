import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowRight, CheckCircle2, ChevronDown, Clock3, Download, PenLine } from 'lucide-react';
import { ActionForm, Check, Field, Select, SubmitButton } from '@/components/forms';
import { PortalTitle } from '@/components/portal-kit';
import { Badge, Notice, Section } from '@/components/ui';
import { CONSENT_DOCS, isRendered, type ConsentKind } from '@/lib/compliance/disclosures';
import { renderFor } from '@/lib/agreements';
import { loadWelcome } from '@/lib/onboarding';
import { portalContext } from '@/lib/portal';
import { fill, type PortalKey } from '@/lib/portal-i18n';
import { fmtDate } from '@/lib/util';
import { portalChangePasswordAction, portalSignConsentAction, portalUpdateProfileAction } from '../../actions';
import { CancelAgreement, cancelledCopy, copyLabel, portalLongDay } from '../../cancel-agreement';
import { SIGN_HREF, welcomeAskCopy } from '../../welcome-ask';
import { PersonalInfoCard } from './personal-info';
import { SmsConsentCard } from './sms-consent';

export const metadata: Metadata = { title: 'Profile' };

const NOTICE: Record<string, PortalKey> = { changed: 'wl_a_updated', order: 'a_order', already: 'a_alreadySigned', notReady: 'a_notReady' };

export default async function PortalProfile({ searchParams }: { searchParams?: Promise<{ notice?: string }> }) {
  const sp = (await searchParams) ?? {};
  const { ctx, client, t, lang } = await portalContext();
  const { ob, ag } = (await ctx.tx((db) => loadWelcome(db, client.id)))!;
  const consents = ag.rows;
  const org = ag.agency.agencyName || ctx.session.orgName;
  const cancelledOn = ob.agreements.cancelledOn;
  const copy = cancelledOn ? cancelledCopy(consents) : null;
  // What the welcome steps ask now (src/lib/onboarding.ts), in the same words as the portal home. Nothing while the
  // agency finishes its agreement, and nothing once the client cancelled (shown below instead).
  const ask = ob.ask && ob.ask.step !== 'waiting' ? welcomeAskCopy(ob.ask) : null;
  // The next of the four required agreements the client can sign now: its "Review & sign" button.
  const first = ob.agreements.asked[0];
  const signNext: ConsentKind | null = first?.ready ? first.kind : null;
  const notice = sp.notice && Object.hasOwn(NOTICE, sp.notice) ? NOTICE[sp.notice] : undefined;
  const a = client.address;
  return (
    <div className="space-y-6">
      <PortalTitle>{t('profile')}</PortalTitle>
      {ask?.href && ask.button && (
        <Link href={ask.href} className="card flex items-center justify-between gap-3 p-4 text-[0.9375rem] transition-colors hover:bg-raised">
          <span className="min-w-0"><span className="block font-semibold">{t(ask.title)}</span><span className="block text-[0.8125rem] text-muted">{fill(t(ask.body), { org })}</span></span>
          <span className="inline-flex shrink-0 items-center gap-1 text-sm font-semibold text-brand-strong">{t(ask.button)} <ArrowRight size={15} aria-hidden /></span>
        </Link>
      )}
      {cancelledOn && (
        <Notice tone="info" title={t('cx_done_t')}>
          {fill(t('cx_done_b'), { date: portalLongDay(cancelledOn, lang), org })}
          {copy && <> <a href={`/api/consents/${copy.id}/pdf`} className="link">{copyLabel(copy, ag.agency.tz, t, lang, 'cx_copy', 'cx_paperText')}</a></>}
        </Notice>
      )}
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
        {notice && <div className="mb-4"><Notice tone="warn">{t(notice)}</Notice></div>}
        {lang === 'es' && <p className="mb-2 text-sm text-muted">{t('agreementLangNote')}</p>}
        <ul className="divide-y divide-line">
          {CONSENT_DOCS.map((doc) => {
            const rec = consents.find((c) => c.kind === doc.kind && !c.revoked_at);
            // A required agreement counts only as agreementProgress says (src/lib/agreements.ts): one signed on an earlier
            // version is shown as such while the current one is asked.
            const counts = !doc.required || ag.signed.includes(doc.kind);
            const revoked = !rec ? consents.find((c) => c.kind === doc.kind && c.revoked_at) : undefined;
            const cancelledHere = doc.kind === 'croa_contract' && cancelledOn;
            const preparing = ob.agreements.asked.some((x) => x.kind === doc.kind && !x.ready);
            // The four required agreements are signed one at a time, in order, in the welcome steps; the optional two here.
            const r = !rec && !doc.required ? renderFor(ag, doc.kind) : null;
            // A document signed on paper was signed on the date written on it, not on the day the agency recorded it.
            const badge = rec && counts ? <Badge tone="ok"><CheckCircle2 size={12} aria-hidden /> {rec.recorded_by && rec.signed_on ? fill(t('pr_signedPaper'), { date: fmtDate(rec.signed_on, lang) }) : <>{t('signed')} {fmtDate(rec.signed_at, lang)}</>}</Badge>
              : rec ? <Badge>{fill(t('pr_earlier'), { date: fmtDate(rec.signed_at, lang) })}</Badge>
                : cancelledHere ? <Badge>{fill(t('pr_cancelled'), { date: portalLongDay(cancelledOn, lang) })}</Badge>
                  : doc.kind === 'esign' && revoked?.revoked_at ? <Badge>{fill(t('pr_withdrawn'), { date: fmtDate(revoked.revoked_at, lang) })}</Badge>
                    : preparing ? <Badge><Clock3 size={12} aria-hidden /> {fill(t('ns_prepItem'), { org })}</Badge>
                      : <Badge tone="warn"><PenLine size={12} aria-hidden /> {t('notSigned')}</Badge>;
            return (
              <li key={doc.kind} className="py-4 first:pt-0 last:pb-0">
                <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-[0.9375rem] font-semibold">{t(`consent_${doc.kind}_title` as PortalKey)}</h3>{badge}</div>
                {rec?.has_text && <a href={`/api/consents/${rec.id}/pdf`} className="link mt-2 inline-flex items-center gap-1.5 text-sm"><Download size={14} aria-hidden className="shrink-0" /> {copyLabel(rec, ag.agency.tz, t, lang)}</a>}
                {cancelledHere && copy && <a href={`/api/consents/${copy.id}/pdf`} className="link mt-2 inline-flex items-center gap-1.5 text-sm"><Download size={14} aria-hidden className="shrink-0" /> {copyLabel(copy, ag.agency.tz, t, lang, 'cx_copy', 'cx_paperText')}</a>}
                {doc.required && signNext === doc.kind && (
                  <Link href={SIGN_HREF} className="btn-primary btn-sm mt-3">{t('sign')} <ArrowRight size={15} aria-hidden /></Link>
                )}
                {/* After cancelling, signing a new agreement stays possible, but only when the client chooses it. */}
                {cancelledHere && <p className="mt-2"><Link href={SIGN_HREF} className="link text-sm">{t('cx_resign')}</Link></p>}
                {r && isRendered(r) && (
                  <>
                    <details className="group mt-2">
                      <summary className="flex w-fit cursor-pointer list-none items-center gap-1.5 rounded-md text-sm font-semibold text-brand-strong [&::-webkit-details-marker]:hidden">{t('readAgreement')} <ChevronDown size={16} aria-hidden className="transition-transform group-open:rotate-180" /></summary>
                      <p lang="en" className="mt-2.5 whitespace-pre-wrap rounded-xl bg-raised p-3.5 text-sm leading-relaxed text-ink [overflow-wrap:anywhere]">{r.blocks.map((b) => b.text).join('\n\n')}</p>
                    </details>
                    <ActionForm action={portalSignConsentAction} className="mt-4 max-w-lg space-y-3">
                      <input type="hidden" name="kind" value={doc.kind} />
                      <input type="hidden" name="shown" value={r.sha256} />
                      <Field label={t('typeName')} name="signedName" id={`signedName-${doc.kind}`} autoComplete="name" required />
                      <Check name="agree" required>{t('agree')}</Check>
                      <SubmitButton>{t('signNow')}</SubmitButton>
                    </ActionForm>
                  </>
                )}
              </li>);
          })}
        </ul>
        {ag.status.cancellationEndsOn && (
          <div className="mt-6 border-t border-line pt-5">
            <CancelAgreement endsOn={ag.status.cancellationEndsOn} open={ag.status.inCancellationWindow} org={ag.agency.agencyName} t={t} lang={lang} />
          </div>
        )}
      </Section>
    </div>
  );
}
