import type { Metadata } from 'next';
import Link from 'next/link';
import { AlertTriangle, ArrowRight, Check, CheckCircle2, Clock3, Download, FileUp, Hourglass, ListChecks, MessageCircle, PenLine, Scale, Search, XCircle } from 'lucide-react';
import { ActionForm, SubmitButton } from '@/components/forms';
import { DatedRow, PortalBlock, PortalTitle } from '@/components/portal-kit';
import { ScoreHistory, type ScoreRow } from '@/components/score-history';
import { DayMeter, Notice, StatFigure } from '@/components/ui';
import { CLIENT_STAGES, DOC_KINDS } from '@/lib/crm';
import { dayWindow, windowStart, windowText } from '@/lib/day-meter';
import { intakeSummary } from '@/lib/intake';
import { loadIntake } from '@/lib/intake-load';
import { loadWelcome } from '@/lib/onboarding';
import { portalContext, specialistFirstName } from '@/lib/portal';
import { nextStep, portalHero, type NextKey } from '@/lib/portal-next-step';
import { fill, type PortalKey } from '@/lib/portal-i18n';
import { cn, daysUntil, fmtDate, relTimeIn } from '@/lib/util';
import { portalUploadAction } from '../actions';
import { cancelledCopy, copyLabel, portalLongDay } from '../cancel-agreement';
import { PortalFileInput } from '../file-input';
import { SIGN_HREF, welcomeAskCopy } from '../welcome-ask';
import { CollectorNotices } from './collector-notices';

export const metadata: Metadata = { title: 'Your case' };

const STEPS = ['intake', 'analysis', 'disputing', 'monitoring'] as const;
const NEXT_ICON: Record<NextKey, typeof Check> = { sign: PenLine, upload: FileUp, intake: ListChecks, review: Search, wait: Hourglass, prep: Clock3, done: CheckCircle2 };
export default async function PortalHome() {
  const { ctx, client, t, lang } = await portalContext();
  const d = await ctx.tx(async (db) => ({
    // "Sent" means actually mailed (submitted_at set) — an approved letter that hasn't gone out yet is not counted.
    stats: await db.row<{ sent: number; deleted: number; updated: number; verified: number; waiting: number; reviewing: number; next_due: string | null }>(
      `select count(*) filter (where submitted_at is not null)::int as sent,
              count(*) filter (where outcome = 'deleted')::int as deleted, count(*) filter (where outcome = 'updated')::int as updated,
              count(*) filter (where outcome = 'verified')::int as verified,
              count(*) filter (where status in ('submitted','under_investigation','response_received'))::int as waiting,
              count(*) filter (where status = 'response_received')::int as reviewing,
              min(due_at) filter (where status in ('submitted','under_investigation')) as next_due
         from public.disputes`),
    // The dispute behind `next_due`: its own sent date and deadline, so the window is drawn from real dates.
    nextWindow: await db.row<{ submitted_at: string | null; due_at: string; deadline_extended: boolean }>(
      "select submitted_at, due_at, deadline_extended from public.disputes where status in ('submitted','under_investigation') and due_at is not null order by due_at limit 1"),
    requests: await db.rows<{ id: string; kind: string; note: string | null; due_at: string | null }>('select id, kind, note, due_at from public.document_requests where fulfilled_document_id is null order by created_at'),
    // The identity documents a bureau normally asks for, from this client's own uploads (row-level security).
    intake: intakeSummary(await loadIntake(db, ctx.clientId)),
    events: await db.rows<{ id: string; note: string | null; to_status: string | null; kind: string; created_at: string }>('select id, note, to_status, kind, created_at from public.dispute_events order by created_at desc limit 6'),
    scores: await db.rows<ScoreRow>('select bureau, model, score, scored_on from public.credit_scores order by scored_on'),
    msgs: await db.rows<{ id: string; body: string; created_at: string }>("select id, body, created_at from public.communications where direction = 'outbound' order by created_at desc limit 2"),
    welcome: await loadWelcome(db, ctx.clientId),
  }));
  const specialist = await specialistFirstName(client.id);
  const first = client.full_name.split(' ')[0];
  // A graduated client is past the last step, so every step shows as done.
  const stageIdx = client.stage === 'graduated' ? STEPS.length : Math.min(CLIENT_STAGES.indexOf(client.stage as (typeof CLIENT_STAGES)[number]), STEPS.length - 1);
  const kindLabel = (k: string) => ((DOC_KINDS as readonly string[]).includes(k) ? t(`kind_${k}` as PortalKey) : k);
  const s = d.stats!;
  const stLabel = (k: string | null) => (k ? t(`st_${k}` as PortalKey) : '');
  const ob = d.welcome?.ob ?? null;
  const ag = d.welcome?.ag ?? null;
  const org = ag?.agency.agencyName || ctx.session.orgName;
  // What the team or the bureaus are doing, or a document the team asked for. The agreements, the details and the ID
  // documents are the welcome steps' (`ob.ask`).
  const next = nextStep({ needSign: false, needDocs: d.requests.length > 0, reviewing: s.reviewing > 0, nextDue: s.next_due, stage: client.stage });
  const hero = portalHero({ cancelledOn: ob?.agreements.cancelledOn ?? null, ask: ob?.ask ?? null, next });
  const cancelled = hero.kind === 'cancelled';
  const copy = cancelled && ag ? cancelledCopy(ag.rows) : null;
  // One clock for the sentence and the bar, so they can never disagree.
  const now = new Date();
  const days = s.next_due ? daysUntil(s.next_due, now) : null;
  const welcome = hero.kind === 'welcome' ? welcomeAskCopy(hero.ask) : null;
  const NextIcon = cancelled ? XCircle : welcome ? welcome.icon : NEXT_ICON[next.key];
  const heroMine = welcome ? welcome.mine : next.mine;
  // The investigation window is drawn in the hero only when the hero is about it; otherwise it goes under Progress.
  const heroWait = hero.kind === 'next' && hero.key === 'wait';
  // What the welcome steps ask, listed under "What we need from you" whatever the hero is. Nothing once the client
  // cancelled their service agreement: they are not pressed to go on.
  const asked = ob && !cancelled ? ob.agreements.asked : [];
  const askDetails = !!ob && !cancelled && !ob.details.done;
  const askIntake = !cancelled && d.intake.needed.length > 0;
  // Counted from receipt (the deadline minus its 30 or 45 days), so "Day N of 30" matches the legal window.
  const win = d.nextWindow ? dayWindow(windowStart(d.nextWindow.due_at, d.nextWindow.deadline_extended), d.nextWindow.due_at, now) : null;
  const winText = win ? windowText(win, lang) : null;
  const messageLabel = specialist ? `${t('messageTo')} ${specialist}` : t('messageTeam');

  return (
    <div className="space-y-7 sm:space-y-9">
      <PortalTitle sub={<>{t('welcomeSub')}{specialist && <> {fill(t('specialistIs'), { name: specialist })}</>}</>}>{t('hello')}, {first}</PortalTitle>

      {/* Phones read top to bottom in the numbered order; wide screens get the same blocks in two columns. */}
      <div className="flex flex-col gap-9 lg:grid lg:grid-cols-[minmax(0,1fr)_19rem] lg:items-start lg:gap-x-12">
        <div className="contents lg:block lg:space-y-10">
          {/* One clear answer to "what happens now?" — computed only from this client's real records. Dark in both themes. */}
          <section aria-labelledby="next-step" className="night order-1 rounded-[1.25rem] border border-line bg-surface p-5 shadow-pop sm:p-7">
            <p className="inline-flex min-h-[1.75rem] items-center gap-2 rounded-full bg-brand-soft px-3 text-[0.8125rem] font-semibold text-brand-strong">
              <NextIcon size={15} aria-hidden className="shrink-0" /> {cancelled ? t('cx_badge') : <>{t('nextStep')} · {heroMine ? t('forYou') : t('forUs')}</>}
            </p>
            <h2 id="next-step" className="display mt-3.5 text-[1.625rem] sm:text-[2rem]">{t(cancelled ? 'cx_done_t' : welcome ? welcome.title : (`ns_${next.key}_t` as PortalKey))}</h2>
            <p className="mt-2 max-w-xl text-[0.9375rem] text-muted">
              {hero.kind === 'cancelled' ? fill(t('cx_done_b'), { date: portalLongDay(hero.on, lang), org }) : fill(t(welcome ? welcome.body : (`ns_${next.key}_b` as PortalKey)), { org })}
              {heroWait && s.next_due && <> <strong className="font-semibold text-ink">{fmtDate(s.next_due, lang)}</strong>{days != null && days >= 0 && <> ({days === 0 ? t('today') : `${days} ${t(days === 1 ? 'dayAway' : 'daysAway')}`})</>}.</>}
            </p>
            {copy && ag && <p className="mt-3"><a href={`/api/consents/${copy.id}/pdf`} className="link inline-flex items-center gap-1.5 text-[0.9375rem]"><Download size={15} aria-hidden className="shrink-0" /> {copyLabel(copy, ag.agency.tz, t, lang, 'cx_copy', 'cx_paperText')}</a></p>}
            {heroWait && days != null && days < 0 && <p className="mt-1.5 max-w-xl text-sm text-muted">{t('ns_late')}</p>}

            {/* The investigation window of the dispute whose answer is due first, from its own stored deadline. */}
            {heroWait && win && winText && d.nextWindow && (
              <div className="mt-6">
                <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-1">
                  {win.day != null && win.totalDays != null ? (
                    <p className="display text-[2.5rem] leading-none">
                      {fill(t('win_day'), { d: win.day })} <span className="font-sans text-base font-medium tracking-normal text-muted">{fill(t('win_of'), { n: win.totalDays })}</span>
                    </p>
                  ) : <p className="text-sm font-medium text-muted">{t('win_title')}</p>}
                  <p className={cn('inline-flex items-center gap-1.5 pb-0.5 text-sm font-semibold', win.state === 'overdue' ? 'text-bad' : 'text-ink')}>
                    {win.state === 'overdue' && <AlertTriangle size={15} aria-hidden />}{winText.status}
                  </p>
                </div>
                <DayMeter dueAt={d.nextWindow.due_at} extended={d.nextWindow.deadline_extended} now={now} lang={lang} variant="ticks" showText={false} className="mt-3" />
                <div className="mt-2 flex flex-wrap justify-between gap-x-4 gap-y-0.5 text-[0.8125rem] text-muted">
                  <span>{d.nextWindow.submitted_at && fill(t('win_sent'), { date: fmtDate(d.nextWindow.submitted_at, lang) })}</span>
                  <span>{fill(t('win_expected'), { date: fmtDate(d.nextWindow.due_at, lang) })}</span>
                </div>
              </div>
            )}

            <div className="mt-6 flex flex-col gap-2.5 sm:flex-row">
              {welcome?.button && welcome.href && <Link href={welcome.href} className="btn-primary btn-lg">{t(welcome.button)} <ArrowRight size={17} aria-hidden /></Link>}
              {hero.kind === 'next' && next.key === 'upload' && <a href="#needs" className="btn-primary btn-lg">{t('uploadNow')} <ArrowRight size={17} aria-hidden /></a>}
              <Link href="/portal/messages" className={cn('btn-quiet btn-lg', (cancelled || !heroMine) && 'sm:min-w-[16rem]')}><MessageCircle size={17} aria-hidden /> {messageLabel}</Link>
            </div>
          </section>

          <PortalBlock id="needs" title={t('needFromYou')} className="order-3">
            {d.requests.length === 0 && asked.length === 0 && !askDetails && !askIntake ? <Notice tone="ok">{t('nothingNeeded')}</Notice> : (
              <ul className="space-y-3">
                {askDetails && (
                  <li>
                    <Link href="/portal/welcome" className="card flex items-center justify-between gap-3 p-4 text-[0.9375rem] transition-colors hover:bg-raised">
                      <span className="flex min-w-0 items-center gap-3"><ListChecks size={18} className="shrink-0 text-warn" aria-hidden /><span className="font-semibold">{t('wl_hero_t')}</span></span>
                      <span className="inline-flex shrink-0 items-center gap-1 text-sm font-semibold text-brand-strong">{t('wl_hero_btn')} <ArrowRight size={15} aria-hidden /></span>
                    </Link>
                  </li>)}
                {asked.map((c) => (
                  <li key={c.kind}>
                    {c.ready ? (
                      <Link href={SIGN_HREF} className="card flex items-center justify-between gap-3 p-4 text-[0.9375rem] transition-colors hover:bg-raised">
                        <span className="flex min-w-0 items-center gap-3"><PenLine size={18} className="shrink-0 text-warn" aria-hidden /><span className="font-semibold">{t(`consent_${c.kind}_title` as PortalKey)}</span></span>
                        <span className="inline-flex shrink-0 items-center gap-1 text-sm font-semibold text-brand-strong">{t('sign')} <ArrowRight size={15} aria-hidden /></span>
                      </Link>
                    ) : (
                      // Not ready to sign yet: the agency is finishing its agreement, so there is nothing to click.
                      <div className="card flex flex-wrap items-center justify-between gap-x-3 gap-y-1 p-4 text-[0.9375rem]">
                        <span className="flex min-w-0 items-center gap-3"><Clock3 size={18} className="shrink-0 text-muted" aria-hidden /><span className="font-semibold">{t(`consent_${c.kind}_title` as PortalKey)}</span></span>
                        <span className="text-sm text-muted">{fill(t('ns_prepItem'), { org })}</span>
                      </div>
                    )}
                  </li>))}
                {askIntake && (
                  <li>
                    <Link href="/portal/documents#checklist" className="card flex items-center justify-between gap-3 p-4 text-[0.9375rem] transition-colors hover:bg-raised">
                      <span className="flex min-w-0 items-center gap-3"><ListChecks size={18} className="shrink-0 text-warn" aria-hidden />
                        <span className="min-w-0"><span className="block font-semibold">{t('ck_title')}</span><span className="block text-[0.8125rem] text-muted">{fill(t('ck_progress'), { n: d.intake.provided, total: d.intake.total })}</span></span></span>
                      <span className="inline-flex shrink-0 items-center gap-1 text-sm font-semibold text-brand-strong">{t('ck_open')} <ArrowRight size={15} aria-hidden /></span>
                    </Link>
                  </li>)}
                {d.requests.map((r) => (
                  <li key={r.id} className="card p-4">
                    <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[0.9375rem]"><FileUp size={18} className="shrink-0 text-brand" aria-hidden /><span className="font-semibold">{kindLabel(r.kind)}</span>{r.due_at && <span className="text-[0.8125rem] text-muted">· {fmtDate(r.due_at, lang)}</span>}</div>
                    {r.note && <p className="mt-1.5 text-sm text-muted">{r.note}</p>}
                    <ActionForm action={portalUploadAction} resetOnSuccess className="mt-3">
                      <input type="hidden" name="kind" value={r.kind} />
                      <div className="flex flex-wrap items-end gap-2.5">
                        <div className="min-w-[12rem] flex-1"><label className="sr-only" htmlFor={`f-${r.id}`}>{t('chooseFile')}</label><PortalFileInput id={`f-${r.id}`} lang={lang} /></div>
                        <SubmitButton>{t('upload')}</SubmitButton>
                      </div>
                    </ActionForm>
                  </li>))}
              </ul>
            )}
          </PortalBlock>

          <PortalBlock id="progress" title={t('progress')} className="order-4">
            {s.sent === 0 ? <p className="text-[0.9375rem] text-muted">{t('noDisputes')}</p> : (
              <>
                <div className="grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-4">
                  <StatFigure label={t('itemsSent')} value={s.sent} />
                  <StatFigure label={t('waiting')} value={s.waiting} />
                  <StatFigure label={t('changed')} value={s.deleted + s.updated} />
                  <StatFigure label={t('verified')} value={s.verified} />
                </div>
                {/* When the hero is about something else, the open window still has a place on the page. */}
                {!heroWait && d.nextWindow && (
                  <div className="mt-6">
                    <p className="mb-1.5 text-[0.8125rem] font-medium text-muted">{t('expectBy')} {fmtDate(d.nextWindow.due_at, lang)}</p>
                    <DayMeter dueAt={d.nextWindow.due_at} extended={d.nextWindow.deadline_extended} now={now} lang={lang} variant="ticks" />
                  </div>
                )}
                <p className="mt-5"><Link href="/portal/disputes" className="link inline-flex items-center gap-1.5 text-sm">{t('disputes')} <ArrowRight size={14} aria-hidden /></Link></p>
              </>
            )}
            <p className="mt-5"><Link href="/portal/statement" className="link inline-flex items-center gap-1.5 text-sm">{t('ws_link')} <ArrowRight size={14} aria-hidden /></Link></p>
            <p className="mt-3"><Link href="/portal/protect" className="link inline-flex items-center gap-1.5 text-sm">{t('pf_link')} <ArrowRight size={14} aria-hidden /></Link></p>
            <p className="mt-4 max-w-2xl text-[0.8125rem] leading-relaxed text-muted">{t('progressNote')}</p>
          </PortalBlock>

          <CollectorNotices ctx={ctx} clientId={client.id} t={t} lang={lang} className="order-4" />

          {d.scores.length > 0 && <PortalBlock id="scores" title={t('scoresTitle')} className="order-5"><ScoreHistory rows={d.scores} note={t('scoresNote')} lang={client.preferred_language} /></PortalBlock>}

          <PortalBlock id="latest" title={t('latest')} className="order-6">
            {d.events.length === 0 && d.msgs.length === 0 ? <p className="text-[0.9375rem] text-muted">{t('noUpdates')}</p> : (
              <ul className="divide-y divide-line">
                {d.msgs.map((m) => (
                  <li key={m.id} className="py-3">
                    <div className="flex items-center gap-1.5 text-[0.8125rem] font-medium text-muted"><MessageCircle size={14} aria-hidden /> {t('team')} · {relTimeIn(m.created_at, lang)}</div>
                    <p className="mt-1 whitespace-pre-wrap text-[0.9375rem] [overflow-wrap:anywhere]">{m.body}</p>
                  </li>))}
                {d.events.map((e) => <DatedRow key={e.id} date={fmtDate(e.created_at, lang)}>{e.kind === 'status_changed' ? stLabel(e.to_status) : e.note}</DatedRow>)}
              </ul>)}
          </PortalBlock>
        </div>

        <div className="contents lg:block lg:space-y-10">
          <PortalBlock id="journey" title={t('journey')} className="order-2">
            <ol>
              {STEPS.map((k, i) => {
                const state = i < stageIdx ? 'done' : i === stageIdx ? 'here' : 'later';
                return (
                  <li key={k} className="relative flex gap-3.5 pb-5 last:pb-0" aria-current={state === 'here' ? 'step' : undefined}>
                    {i < STEPS.length - 1 && <span aria-hidden className={cn('absolute bottom-0 left-[0.6875rem] top-6 w-0.5 -translate-x-1/2', state === 'done' ? 'bg-brand' : 'bg-line')} />}
                    <span aria-hidden className={cn('relative mt-0.5 grid h-[1.375rem] w-[1.375rem] shrink-0 place-items-center rounded-full border-2',
                      state === 'done' ? 'border-brand bg-brand text-brand-ink' : state === 'here' ? 'border-brand bg-canvas' : 'border-line-strong bg-canvas')}>
                      {state === 'done' ? <Check size={13} strokeWidth={3} /> : state === 'here' ? <span className="h-2 w-2 rounded-full bg-brand" /> : null}
                    </span>
                    <div className="min-w-0">
                      <div className={cn('text-[0.9375rem] font-semibold', state === 'later' && 'text-muted')}>{t(`s_${k}` as PortalKey)}</div>
                      <div className="text-[0.8125rem] text-muted">{t(state === 'done' ? 'j_done' : state === 'here' ? 'j_here' : 'j_later')}</div>
                      {state === 'here' && <p className="mt-1.5 text-sm text-muted">{t(`sd_${k}` as PortalKey)}</p>}
                    </div>
                  </li>);
              })}
            </ol>
            {client.stage === 'graduated' && <p className="mt-4 text-sm text-muted">{t('sd_graduated')}</p>}
          </PortalBlock>

          <PortalBlock id="rights" title={t('rightsTitle')} hint={t('rightsIntro')} className="order-7">
            <ul className="space-y-3.5 text-[0.9375rem]">
              {(['r_free', 'r_diy', 'r_accurate', 'r_time', 'r_cancel'] as const).map((k) => <li key={k} className="flex gap-3"><Scale size={17} className="mt-0.5 shrink-0 text-brand" aria-hidden /><span>{t(k)}</span></li>)}
            </ul>
            <p className="mt-5 flex flex-col items-start gap-2 text-sm">
              <a className="link" href="https://www.annualcreditreport.com" target="_blank" rel="noopener noreferrer">AnnualCreditReport.com</a>
              <a className="link" href={lang === 'es' ? 'https://www.consumerfinance.gov/es/' : 'https://www.consumerfinance.gov/consumer-tools/credit-reports-and-scores/'} target="_blank" rel="noopener noreferrer">{t('rightsMore')}</a>
            </p>
          </PortalBlock>
        </div>
      </div>
    </div>
  );
}
