import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowRight, Check, CheckCircle2, Download, FileText, MessageCircle, XCircle } from 'lucide-react';
import { ActionForm, Check as Tick, Field, Select, SubmitButton } from '@/components/forms';
import { Badge, Notice } from '@/components/ui';
import { renderFor } from '@/lib/agreements';
import { NOTICE_HEADING } from '@/lib/compliance/croa';
import { isRendered, SIGNING_ORDER, type Block } from '@/lib/compliance/disclosures';
import { INTAKE_REQUIRED, intakeStatus, type IntakeStatus } from '@/lib/intake';
import { loadIntakeDocs } from '@/lib/intake-load';
import { businessToday } from '@/lib/letters/service';
import { isOnboardingStep, loadWelcome, ONBOARDING_STEPS, type OnboardingStep } from '@/lib/onboarding';
import { portalContext, specialistFirstName } from '@/lib/portal';
import { fill, type PortalKey } from '@/lib/portal-i18n';
import { maxUploadBytes, maxUploadMb } from '@/lib/upload';
import { cn, isUuid } from '@/lib/util';
import { portalSaveDetailsAction, portalSignConsentAction, portalUploadAction } from '../actions';
import { CancelAgreement, cancelledCopy, copyLabel, portalLongDay } from '../cancel-agreement';
import { PhotoFileInput } from '../photo-file-input';

export const metadata: Metadata = { title: 'Welcome' };

const STATE_TONE = { accepted: 'ok', pending: 'info', rejected: 'bad', stale: 'warn', missing: 'warn' } as const;
const stateKey = (s: IntakeStatus): PortalKey => (s.state === 'stale' ? (s.why === 'expired' ? 'ck_expired' : 'ck_old') : `ck_${s.state}`);

/** Why the agreements step was shown again after a signature was refused (portalSignConsentAction): known values only. */
const NOTICE: Record<string, PortalKey> = { changed: 'wl_a_updated', order: 'a_order', already: 'a_alreadySigned', notReady: 'a_notReady' };

/** One paragraph of an agreement; the paragraphs the law sets in bold are bold here too. */
const Para = ({ b }: { b: Block }) => <p className={cn('whitespace-pre-wrap [overflow-wrap:anywhere]', b.bold && 'font-bold')}>{b.text}</p>;

/**
 * The client's guided welcome: details, agreements, ID documents, done. Which step is shown comes from the records
 * (src/lib/onboarding.ts), so it can be left and picked up again at any time.
 */
export default async function WelcomePage({ searchParams }: { searchParams: Promise<{ step?: string; signed?: string; uploaded?: string; notice?: string }> }) {
  const sp = await searchParams;
  const { ctx, client, t, lang } = await portalContext();
  const d = await ctx.tx(async (db) => ({
    ...(await loadWelcome(db, client.id))!,
    intakeDocs: await loadIntakeDocs(db, client.id),
    // A row of this client's own (row-level security), to offer the copy right after signing.
    signed: sp.signed && isUuid(sp.signed) ? await db.row<{ id: string; kind: string; has_text: boolean }>('select id, kind, text_shown is not null as has_text from public.client_consents where id = $1', [sp.signed]) : null,
  }));
  const specialist = await specialistFirstName(client.id);
  const { ob, ag } = d;
  const org = ag.agency.agencyName || ctx.session.orgName;
  // "Done" is reached once the details and agreements are in; the ID documents may follow later.
  const canFinish = ob.details.done && ob.agreements.done;
  // While the service agreement waits for the agency, the client's way on is their portal, not "Done".
  const waitingForAgency = !ob.agreements.nextReady;
  const asked = isOnboardingStep(sp.step) ? sp.step : null;
  // Without a step asked for, the page opens at what the client can do now (src/lib/onboarding.ts). A client who
  // cancelled their service agreement sees that instead; the steps stay open to them by name (Profile links to the
  // agreement, to sign a new one).
  const cancelledOn = ob.agreements.cancelledOn;
  const opening: OnboardingStep = ob.ask ? (ob.ask.step === 'waiting' ? 'agreements' : ob.ask.step) : ob.current;
  const step: OnboardingStep | null = asked && (asked !== 'done' || canFinish) ? asked : cancelledOn ? null : opening;
  const first = client.full_name.split(' ')[0] ?? client.full_name;
  const pct = Math.round((ob.stepsDone / 3) * 100);
  const doneOf: Record<OnboardingStep, boolean> = { details: ob.details.done, agreements: ob.agreements.done, documents: ob.documents.done, done: ob.complete };

  return (
    <div className="space-y-7">
      <header>
        <h1 className="display text-[1.875rem] sm:text-[2.25rem]">{fill(t('wl_title'), { first })}</h1>
        {step && <div className="mt-4" aria-label={fill(t('wl_progress'), { n: ONBOARDING_STEPS.indexOf(step) + 1, total: ONBOARDING_STEPS.length })} role="group">
          <div className="h-2 overflow-hidden rounded-full bg-line" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label={t('wl_steps')}>
            <div className="h-full rounded-full bg-brand transition-[width]" style={{ width: `${pct}%` }} />
          </div>
          <ol className="mt-3 grid grid-cols-2 gap-2 text-[0.8125rem] sm:grid-cols-4">
            {ONBOARDING_STEPS.map((k, i) => (
              <li key={k}>
                <Link href={`/portal/welcome?step=${k}`} aria-current={k === step ? 'step' : undefined}
                  className={cn('flex items-center gap-1.5 rounded-lg px-2 py-1.5', k === step ? 'bg-brand-soft font-semibold text-brand-strong' : 'text-muted hover:bg-raised')}>
                  {doneOf[k] ? <Check size={14} aria-hidden className="shrink-0" /> : <span aria-hidden className="w-3.5 shrink-0 text-center">{i + 1}</span>}
                  <span className="truncate">{t(`wl_s_${k}` as PortalKey)}</span>
                  {doneOf[k] && <span className="sr-only"> ({t('wl_stepDone')})</span>}
                </Link>
              </li>))}
          </ol>
        </div>}
      </header>

      {!step && cancelledOn && <Cancelled on={cancelledOn} />}
      {step === 'details' && <DetailsStep />}
      {step === 'agreements' && <AgreementsStep />}
      {step === 'documents' && <DocumentsStep />}
      {step === 'done' && <DoneStep />}
    </div>
  );

  function DetailsStep() {
    const a = client.address;
    const need = new Set(ob.details.missing);
    return (
      <section aria-labelledby="details-title" className="card p-5 sm:p-6">
        <h2 id="details-title" className="display text-[1.375rem]">{t('wl_s_details')}</h2>
        <p className="mt-1 text-sm text-muted">{t('wl_d_intro')}</p>
        <ActionForm action={portalSaveDetailsAction} className="mt-5 space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div><label className="label" htmlFor="wlName">{t('wl_d_name')}</label><input id="wlName" className="field !bg-raised text-muted" readOnly value={client.full_name} /></div>
            <div><label className="label" htmlFor="wlEmail">{t('email')}</label><input id="wlEmail" className="field !bg-raised text-muted" readOnly value={client.email ?? ''} /></div>
          </div>
          <p className="text-sm"><Link href="/portal/messages" className="link inline-flex items-center gap-1.5"><MessageCircle size={14} aria-hidden /> {t('wl_notRight')}</Link></p>
          <Field label={t('phone')} name="phone" type="tel" defaultValue={client.phone} autoComplete="tel" />
          <Field label={`${t('address')} 1`} name="line1" defaultValue={a.line1} autoComplete="address-line1" required />
          <Field label={`${t('address')} 2`} name="line2" defaultValue={a.line2} autoComplete="address-line2" />
          <div className="grid grid-cols-[minmax(0,1fr)_4.5rem_6.5rem] gap-3"><Field label={t('city')} name="city" defaultValue={a.city} autoComplete="address-level2" required /><Field label={t('state')} name="state" defaultValue={a.state} maxLength={2} autoComplete="address-level1" required /><Field label={t('zip')} name="zip" defaultValue={a.zip} autoComplete="postal-code" required /></div>
          <Select label={t('language')} name="language" defaultValue={client.preferred_language} options={[{ value: 'en', label: 'English' }, { value: 'es', label: 'Español' }]} />
          <div className="grid gap-4 sm:grid-cols-2">
            {need.has('dob')
              ? <Field label={t('wl_dob')} name="dob" type="date" autoComplete="bday" required hint={t('wl_dobHint')} max={businessToday()} min="1900-01-01" />
              : <div><span className="label">{t('wl_dob')}</span><p className="flex min-h-[2.75rem] items-center gap-2 text-sm"><CheckCircle2 size={16} aria-hidden className="text-ok" /> {t('wl_onFile')}</p></div>}
            {need.has('ssn')
              ? <Field label={t('wl_ssn')} name="ssn" inputMode="numeric" autoComplete="off" required maxLength={11} pattern="\d{3}-?\d{2}-?\d{4}" placeholder="000-00-0000" hint={t('wl_ssnHint')} />
              : <div><span className="label">{t('wl_ssn')}</span><p className="flex min-h-[2.75rem] items-center gap-2 text-sm"><CheckCircle2 size={16} aria-hidden className="text-ok" /> {t('wl_onFile')}</p></div>}
          </div>
          <SubmitButton className="btn-lg">{t('wl_saveContinue')}</SubmitButton>
        </ActionForm>
      </section>
    );
  }

  /** The service agreement the client cancelled: what happened, from the records, and the copy. Nothing more is asked. */
  function Cancelled({ on }: { on: string }) {
    const copy = cancelledCopy(ag.rows);
    return (
      <section aria-labelledby="cancelled-title" className="card p-5 sm:p-6">
        <p className="inline-flex items-center gap-2 text-[0.8125rem] font-semibold text-muted"><XCircle size={15} aria-hidden /> {t('cx_badge')}</p>
        <h2 id="cancelled-title" className="display mt-2 text-[1.375rem]">{t('cx_done_t')}</h2>
        <p className="mt-2 text-[0.9375rem]">{fill(t('cx_done_b'), { date: portalLongDay(on, lang), org })}</p>
        {copy && <p className="mt-3"><a href={`/api/consents/${copy.id}/pdf`} className="link inline-flex items-center gap-1.5 text-sm"><Download size={14} aria-hidden /> {copyLabel(copy, ag.agency.tz, t, lang, 'cx_copy', 'cx_paperText')}</a></p>}
        <div className="mt-5 flex flex-wrap gap-2.5">
          <Link href="/portal" className="btn-primary">{t('wl_done_home')} <ArrowRight size={16} aria-hidden /></Link>
          <Link href="/portal/messages" className="btn-quiet"><MessageCircle size={16} aria-hidden /> {t('messageTeam')}</Link>
        </div>
      </section>
    );
  }

  function AgreementsStep() {
    const next = ob.agreements.next;
    const refused = sp.notice && Object.hasOwn(NOTICE, sp.notice) ? NOTICE[sp.notice] : undefined;
    const r = next ? renderFor(ag, next) : null;
    const n = next ? SIGNING_ORDER.indexOf(next) + 1 : SIGNING_ORDER.length;
    // The contract's Notice of Cancellation is attached below the signature, as a separate form.
    const cut = r && isRendered(r) && r.doc.kind === 'croa_contract' ? r.blocks.map((b) => b.text).lastIndexOf(NOTICE_HEADING) : -1;
    const body = r && isRendered(r) ? (cut >= 0 ? r.blocks.slice(0, cut) : r.blocks) : [];
    const notice = r && isRendered(r) && cut >= 0 ? r.blocks.slice(cut) : [];
    return (
      <section aria-labelledby="agreements-title" className="space-y-5">
        {d.signed && <Notice tone="ok" title={t('wl_a_signed')}>{d.signed.has_text && <a href={`/api/consents/${d.signed.id}/pdf`} className="link inline-flex items-center gap-1.5"><Download size={14} aria-hidden /> {t('wl_a_download')}</a>}</Notice>}
        {refused && <Notice tone="warn">{t(refused)}</Notice>}
        {cancelledOn && <Notice tone="info" title={t('cx_done_t')}>{fill(t('cx_done_b'), { date: portalLongDay(cancelledOn, lang), org })} {fill(t('cx_resignNote'), { org })}</Notice>}
        <div>
          <h2 id="agreements-title" className="display text-[1.375rem]">{t('wl_s_agreements')}</h2>
          <p className="mt-1 text-sm text-muted">{t('wl_a_intro')}</p>
          {lang === 'es' && <p className="mt-2 rounded-xl bg-raised px-3.5 py-2.5 text-sm">{t('agreementLangNote')}</p>}
          <ol className="mt-4 space-y-1.5 text-sm">
            {SIGNING_ORDER.map((k, i) => {
              // Ticked only when it counts as signed (agreementProgress): one signed on an earlier version is asked again.
              const row = ag.signed.includes(k) ? ag.rows.find((x) => x.kind === k && !x.revoked_at) : undefined;
              return (
                <li key={k} className="flex items-start gap-2">
                  {row ? <CheckCircle2 size={16} aria-hidden className="mt-0.5 shrink-0 text-ok" /> : <span aria-hidden className="mt-0.5 grid h-4 w-4 shrink-0 place-items-center text-xs text-muted">{i + 1}</span>}
                  <span className="min-w-0 flex-1">
                    <span className={cn(k === next ? 'font-semibold' : !row && 'text-muted')}>{t(`consent_${k}_title` as PortalKey)}</span>
                    {row?.has_text && <> <a href={`/api/consents/${row.id}/pdf`} className={cn('link text-[0.8125rem]', !row.recorded_by && 'whitespace-nowrap')}>{copyLabel(row, ag.agency.tz, t, lang)}</a></>}
                  </span>
                </li>);
            })}
          </ol>
        </div>

        {!next && (
          <div className="card p-5">
            <p className="flex items-center gap-2 font-semibold"><CheckCircle2 size={18} aria-hidden className="text-ok" /> {t('wl_a_allDone')}</p>
            <Link href={`/portal/welcome?step=${ob.documents.done ? 'done' : 'documents'}`} className="btn-primary mt-4">{t(ob.documents.done ? 'wl_toDone' : 'wl_toDocs')} <ArrowRight size={16} aria-hidden /></Link>
          </div>
        )}

        {next && r && !isRendered(r) && (
          // The agency has not saved its terms: nothing to sign yet. No promise of a message when it is ready (none is sent).
          <div className="card p-5">
            <p className="text-[0.9375rem]">{fill(t('wl_a_notReady'), { org })}{!ob.documents.done && <> {t('wl_a_notReadyDocs')}</>}</p>
            {ob.documents.done
              ? <Link href="/portal" className="btn-secondary mt-4">{t('wl_done_home')} <ArrowRight size={16} aria-hidden /></Link>
              : <Link href="/portal/welcome?step=documents" className="btn-secondary mt-4">{t('wl_toDocs')} <ArrowRight size={16} aria-hidden /></Link>}
          </div>
        )}

        {next && r && isRendered(r) && (
          <article aria-labelledby="doc-title" className="card p-5 sm:p-7">
            <p className="text-[0.8125rem] font-medium text-muted">{fill(t('wl_a_of'), { n, total: SIGNING_ORDER.length })}</p>
            {/* The text is English for everyone (lang="en"), exactly as it is stored with the signature. */}
            <div lang="en">
              <h3 id="doc-title" className="mt-1 text-lg font-semibold">{r.doc.title}</h3>
              <div className="mt-4 space-y-3 text-[0.9375rem] leading-relaxed">{body.map((b, i) => <Para key={i} b={b} />)}</div>
            </div>
            <ActionForm action={portalSignConsentAction} className="mt-6 space-y-3 border-t border-line pt-5">
              <h4 className="text-sm font-semibold">{t('wl_a_signature')}</h4>
              <input type="hidden" name="kind" value={r.doc.kind} />
              <input type="hidden" name="shown" value={r.sha256} />
              <input type="hidden" name="from" value="welcome" />
              {r.doc.kind === 'esign' && (
                <>
                  <a href={`/api/consents/preview/${r.doc.kind}`} target="_blank" rel="noopener" className="btn-secondary btn-sm"><FileText size={15} aria-hidden /> {t('wl_a_pdf')}</a>
                  <Tick name="canRead" required>{t('wl_a_canRead')}</Tick>
                </>
              )}
              <Field label={t('typeName')} name="signedName" autoComplete="name" required />
              <Tick name="agree" required>{t(r.doc.kind === 'croa_disclosure' ? 'wl_a_received' : 'agree')}</Tick>
              <SubmitButton className="btn-lg">{t('signNow')}</SubmitButton>
            </ActionForm>
            {notice.length > 0 && (
              <div lang="en" className="mt-6 space-y-3 rounded-xl border-2 border-dashed border-line-strong p-4 text-[0.9375rem] leading-relaxed">
                {notice.map((b, i) => <Para key={i} b={b} />)}
              </div>
            )}
          </article>
        )}
      </section>
    );
  }

  function DocumentsStep() {
    const statuses = intakeStatus(d.intakeDocs, businessToday(), INTAKE_REQUIRED);
    return (
      <section aria-labelledby="documents-title" className="space-y-5">
        {sp.uploaded && <Notice tone="ok" title={t('wl_doc_uploaded')}>{t('uploadedOkBody')}</Notice>}
        <div>
          <h2 id="documents-title" className="display text-[1.375rem]">{t('wl_s_documents')}</h2>
          <p className="mt-1 text-sm text-muted">{t('wl_doc_intro')} <strong className="font-semibold text-ink">{fill(t('ck_progress'), { n: ob.documents.provided, total: ob.documents.total })}</strong></p>
        </div>
        <ul className="space-y-4">
          {statuses.map((s) => (
            <li key={s.item.key} className="card p-4 sm:p-5">
              <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
                <h3 className="min-w-0 text-[0.9375rem] font-semibold [overflow-wrap:anywhere]">{s.item.label[lang]}</h3>
                <Badge tone={STATE_TONE[s.state]}>{t(stateKey(s))}</Badge>
              </div>
              <p className="mt-1.5 text-sm">{s.item.accepts[lang]}</p>
              <ul className="mt-1.5 list-disc space-y-1 pl-5 text-sm text-muted">{s.item.tips.map((tip) => <li key={tip.en}>{tip[lang]}</li>)}</ul>
              {s.state === 'rejected' && s.reason && <p className="mt-2 text-sm [overflow-wrap:anywhere]"><span className="font-medium">{t('ck_reason')}</span> {s.reason}</p>}
              {s.state !== 'accepted' && s.state !== 'pending' && (
                <ActionForm action={portalUploadAction} className="mt-3">
                  <input type="hidden" name="kind" value={s.item.key} />
                  <input type="hidden" name="returnTo" value="welcome" />
                  <div className="flex flex-wrap items-end gap-2.5">
                    <div className="min-w-[12rem] flex-1">
                      <label className="sr-only" htmlFor={`wf-${s.item.key}`}>{`${t('chooseFile')}: ${s.item.label[lang]}`}</label>
                      <PhotoFileInput id={`wf-${s.item.key}`} maxBytes={maxUploadBytes()} tooLarge={fill(t('e_fileTooLarge'), { max: maxUploadMb() })} preparing={t('wl_doc_preparing')} />
                    </div>
                    <SubmitButton>{t(s.state === 'missing' ? 'upload' : 'ck_replace')}</SubmitButton>
                  </div>
                </ActionForm>
              )}
            </li>))}
        </ul>
        <p className="text-[0.8125rem] text-muted">{fill(t('uploadHelp'), { max: maxUploadMb() })}</p>
        <div className="flex flex-wrap gap-2.5">
          {ob.documents.done
            ? (!canFinish && waitingForAgency
              ? <Link href="/portal" className="btn-primary btn-lg">{t('wl_done_home')} <ArrowRight size={17} aria-hidden /></Link>
              : <Link href="/portal/welcome?step=done" className="btn-primary btn-lg">{t('wl_toDone')} <ArrowRight size={17} aria-hidden /></Link>)
            : <Link href={canFinish ? '/portal/welcome?step=done' : '/portal'} className="btn-quiet btn-lg">{t('wl_doc_later')}</Link>}
        </div>
      </section>
    );
  }

  function DoneStep() {
    const at = (kind: string) => (SIGNING_ORDER as readonly string[]).indexOf(kind);
    const kept = ag.rows.filter((x) => !x.revoked_at && x.has_text && at(x.kind) >= 0).sort((x, y) => at(x.kind) - at(y.kind));
    // What the client e-signed are copies of what they signed. What they signed on paper and the agency recorded is not:
    // its PDF is the app's text of that paper agreement on the day it was recorded, and is listed apart as such.
    const copies = kept.filter((x) => !x.recorded_by);
    const paper = kept.filter((x) => x.recorded_by);
    const ends = ag.status.cancellationEndsOn;
    return (
      <section aria-labelledby="done-title" className="space-y-6">
        <div className="night rounded-[1.25rem] border border-line bg-surface p-6 shadow-pop sm:p-8">
          <h2 id="done-title" className="display text-[1.75rem] sm:text-[2.125rem]">{fill(t('wl_done_title'), { first })}</h2>
          <p className="mt-3 max-w-xl text-[0.9375rem] text-muted">{specialist ? fill(t('wl_done_specialist'), { name: specialist }) : t('wl_done_team')}</p>
          {ends && ag.status.inCancellationWindow && <p className="mt-3 max-w-xl text-[0.9375rem]">{fill(t('wl_done_period'), { date: portalLongDay(ends, lang) })}</p>}
          <Link href="/portal" className="btn-primary btn-lg mt-6">{t('wl_done_home')} <ArrowRight size={17} aria-hidden /></Link>
        </div>
        {!ob.documents.done && <Notice tone="warn">{t('wl_done_docsLater')} <Link href="/portal/welcome?step=documents" className="link">{t('wl_s_documents')}</Link></Notice>}
        {copies.length > 0 && (
          <div>
            <h3 className="text-[0.9375rem] font-semibold">{t('wl_done_copies')}</h3>
            <ul className="mt-2 space-y-1.5 text-sm">{copies.map((x) => <li key={x.id}><a href={`/api/consents/${x.id}/pdf`} className="link inline-flex items-center gap-1.5"><Download size={14} aria-hidden /> {t(`consent_${x.kind}_title` as PortalKey)}</a></li>)}</ul>
          </div>
        )}
        {paper.length > 0 && (
          <div>
            <h3 className="text-[0.9375rem] font-semibold">{t('wl_done_paper')}</h3>
            <ul className="mt-2 space-y-2 text-sm">{paper.map((x) => (
              <li key={x.id}><span className="block font-medium">{t(`consent_${x.kind}_title` as PortalKey)}</span>
                <a href={`/api/consents/${x.id}/pdf`} className="link inline-flex items-center gap-1.5"><Download size={14} aria-hidden className="shrink-0" /> {copyLabel(x, ag.agency.tz, t, lang)}</a></li>))}</ul>
          </div>
        )}
        {ends && <CancelAgreement endsOn={ends} open={ag.status.inCancellationWindow} org={org} t={t} lang={lang} />}
      </section>
    );
  }
}
