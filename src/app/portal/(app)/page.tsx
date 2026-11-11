import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowRight, Check, CheckCircle2, Clock3, FileUp, Hourglass, MessageCircle, PenLine, Scale, Search } from 'lucide-react';
import { ActionForm, SubmitButton } from '@/components/forms';
import { SplitBar } from '@/components/charts';
import { ScoreHistory, type ScoreRow } from '@/components/score-history';
import { Badge, Section } from '@/components/ui';
import { CONSENT_DOCS } from '@/lib/compliance/disclosures';
import { DOC_KIND_LABEL, CLIENT_STAGES } from '@/lib/crm';
import { portalContext, specialistFirstName } from '@/lib/portal';
import { nextStep, type NextKey } from '@/lib/portal-next-step';
import type { PortalKey } from '@/lib/portal-i18n';
import { cn, daysUntil, fmtDate, relTimeIn } from '@/lib/util';
import { portalUploadAction } from '../actions';

export const metadata: Metadata = { title: 'Your case' };

const STEPS = ['intake', 'analysis', 'disputing', 'monitoring'] as const;
const NEXT_ICON: Record<NextKey, typeof Check> = { sign: PenLine, upload: FileUp, review: Search, wait: Hourglass, prep: Clock3, done: CheckCircle2 };

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
    requests: await db.rows<{ id: string; kind: string; note: string | null; due_at: string | null }>('select id, kind, note, due_at from public.document_requests where fulfilled_document_id is null order by created_at'),
    consents: await db.rows<{ kind: string }>('select kind from public.client_consents where revoked_at is null'),
    events: await db.rows<{ id: string; note: string | null; to_status: string | null; kind: string; created_at: string }>('select id, note, to_status, kind, created_at from public.dispute_events order by created_at desc limit 6'),
    scores: await db.rows<ScoreRow>('select bureau, model, score, scored_on from public.credit_scores order by scored_on'),
    msgs: await db.rows<{ id: string; body: string; created_at: string }>("select id, body, created_at from public.communications where direction = 'outbound' order by created_at desc limit 2"),
  }));
  const specialist = await specialistFirstName(client.id);
  const first = client.full_name.split(' ')[0];
  const needSign = CONSENT_DOCS.filter((c) => c.required && !d.consents.some((k) => k.kind === c.kind));
  const stageIdx = Math.min(CLIENT_STAGES.indexOf(client.stage as (typeof CLIENT_STAGES)[number]), STEPS.length - 1);
  const s = d.stats!;
  const stLabel = (k: string | null) => (k ? t(`st_${k}` as PortalKey) : '');
  const next = nextStep({ needSign: needSign.length > 0, needDocs: d.requests.length > 0, reviewing: s.reviewing > 0, nextDue: s.next_due, stage: client.stage });
  const days = s.next_due ? daysUntil(s.next_due) : null;
  const NextIcon = NEXT_ICON[next.key];

  return (
    <div className="space-y-6">
      <div><h1 className="font-display text-3xl font-semibold sm:text-4xl">{t('hello')}, {first}</h1><p className="mt-1 text-muted">{t('welcomeSub')}{specialist && ` · ${t('specialist')}: ${specialist}`}</p></div>

      {/* One clear answer to "what happens now?" — computed only from this client's real records. */}
      <section aria-labelledby="next-step" className={cn('card overflow-hidden p-5 sm:p-6', next.mine && 'ring-1 ring-brand/40')}>
        <div className="flex items-start gap-4">
          <span className={cn('grid h-11 w-11 shrink-0 place-items-center rounded-2xl', next.mine ? 'bg-brand text-brand-ink' : 'bg-brand-soft text-brand-strong')}><NextIcon size={20} aria-hidden /></span>
          <div className="min-w-0 flex-1">
            <p className="text-xs font-semibold uppercase tracking-wide text-brand-strong">{t('nextStep')} · {next.mine ? t('forYou') : t('forUs')}</p>
            <h2 id="next-step" className="mt-1 font-display text-2xl font-semibold leading-tight">{t(`ns_${next.key}_t` as PortalKey)}</h2>
            <p className="mt-1.5 text-muted">
              {t(`ns_${next.key}_b` as PortalKey)}
              {next.key === 'wait' && s.next_due && <> <strong className="font-semibold text-ink">{fmtDate(s.next_due, lang)}</strong>{days != null && days >= 0 && <> ({days === 0 ? t('today') : `${days} ${t('daysAway')}`})</>}.</>}
            </p>
            {next.key === 'wait' && days != null && days < 0 && <p className="mt-1 text-sm text-muted">{t('ns_late')}</p>}
            <div className="mt-4 flex flex-wrap gap-2">
              {next.key === 'sign' && <Link href="/portal/profile#agreements" className="btn-primary">{t('sign')} <ArrowRight size={16} aria-hidden /></Link>}
              {next.key === 'upload' && <a href="#needs" className="btn-primary">{t('uploadNow')} <ArrowRight size={16} aria-hidden /></a>}
              <Link href="/portal/messages" className={next.mine ? 'btn-ghost' : 'btn-secondary'}><MessageCircle size={16} aria-hidden /> {specialist ? `${t('messageTo')} ${specialist}` : t('messageTeam')}</Link>
            </div>
          </div>
        </div>
      </section>

      <section className="card p-5 sm:p-6" aria-label={t('journey')}>
        <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-muted">{t('journey')}</h2>
        <ol className="grid grid-cols-4 gap-2 text-center">
          {STEPS.map((k, i) => (
            <li key={k} className="relative flex flex-col items-center gap-2" aria-current={i === stageIdx ? 'step' : undefined}>
              {i > 0 && <span aria-hidden className={cn('absolute right-1/2 top-[1.125rem] z-0 h-0.5 w-[calc(100%+0.5rem)] -translate-y-1/2', i <= stageIdx ? 'bg-brand' : 'bg-line')} />}
              <span className={cn('relative z-10 grid h-9 w-9 place-items-center rounded-full text-sm font-semibold ring-2', i < stageIdx ? 'bg-brand text-brand-ink ring-brand' : i === stageIdx ? 'bg-brand-soft text-brand-strong ring-brand' : 'bg-surface text-faint ring-line')}>{i < stageIdx ? <Check size={16} aria-hidden /> : i + 1}</span>
              <span className={cn('text-xs leading-tight sm:text-sm', i === stageIdx ? 'font-semibold' : 'text-muted')}>{t(`s_${k}` as PortalKey)}</span>
            </li>))}
        </ol>
        {stageIdx >= 0 && <p className="mt-5 rounded-xl bg-raised p-3.5 text-sm">{t(`sd_${client.stage === 'graduated' ? 'graduated' : STEPS[stageIdx]}` as PortalKey)}</p>}
      </section>

      <Section title={t('needFromYou')} id="needs">
        {d.requests.length === 0 && needSign.length === 0 ? <p className="text-sm text-muted">{t('nothingNeeded')}</p> : (
          <ul className="space-y-3">
            {needSign.map((c) => <li key={c.kind}><Link href="/portal/profile#agreements" className="flex items-center justify-between gap-3 rounded-xl border border-warn/40 bg-warn-soft/50 p-3.5 text-sm"><span className="flex items-center gap-2.5"><PenLine size={16} className="text-warn" aria-hidden /><span className="font-medium">{c.title}</span></span><Badge tone="warn">{t('sign')}</Badge></Link></li>)}
            {d.requests.map((r) => (
              <li key={r.id} className="rounded-xl border border-line p-3.5">
                <div className="mb-2 flex items-center gap-2.5 text-sm"><FileUp size={16} className="text-brand" aria-hidden /><span className="font-medium">{DOC_KIND_LABEL[r.kind] ?? r.kind}</span>{r.due_at && <span className="text-xs text-muted">· {fmtDate(r.due_at, lang)}</span>}</div>
                {r.note && <p className="mb-2 text-sm text-muted">{r.note}</p>}
                <ActionForm action={portalUploadAction} resetOnSuccess className="flex flex-wrap items-end gap-2">
                  <input type="hidden" name="kind" value={r.kind} />
                  <div className="min-w-[12rem] flex-1"><label className="sr-only" htmlFor={`f-${r.id}`}>{t('chooseFile')}</label><input id={`f-${r.id}`} name="file" type="file" required accept=".pdf,.png,.jpg,.jpeg" className="field !p-2 text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-brand-soft file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-brand-strong" /></div>
                  <SubmitButton>{t('upload')}</SubmitButton>
                </ActionForm>
              </li>))}
          </ul>
        )}
      </Section>

      <Section title={t('progress')}>
        {s.sent === 0 ? <p className="text-sm text-muted">{t('noDisputes')}</p> : (
          <>
            <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
              {([[t('itemsSent'), s.sent], [t('changed'), s.deleted + s.updated], [t('verified'), s.verified], [t('waiting'), s.waiting]] as const).map(([l, v]) => <div key={l} className="rounded-xl bg-raised p-3"><div className="font-display text-3xl font-semibold tabular-nums">{v}</div><div className="text-xs text-muted">{l}</div></div>)}
            </div>
            <SplitBar parts={[{ label: t('changed'), value: s.deleted + s.updated, className: 'bg-ok' }, { label: t('verified'), value: s.verified, className: 'bg-faint' }, { label: t('waiting'), value: s.waiting, className: 'bg-brand' }]} />
            <p className="mt-4"><Link href="/portal/disputes" className="inline-flex items-center gap-1.5 text-sm font-medium text-brand-strong hover:underline">{t('disputes')} <ArrowRight size={14} aria-hidden /></Link></p>
          </>
        )}
        <p className="mt-4 text-xs text-muted">{t('progressNote')}</p>
      </Section>

      {d.scores.length > 0 && <Section title={t('scoresTitle')}><ScoreHistory rows={d.scores} note={t('scoresNote')} lang={client.preferred_language} /></Section>}

      <div className="grid gap-6 lg:grid-cols-2">
        <Section title={t('latest')}>
          {d.events.length === 0 && d.msgs.length === 0 ? <p className="text-sm text-muted">{t('noUpdates')}</p> : (
            <ul className="space-y-3 text-sm">
              {d.msgs.map((m) => <li key={m.id} className="rounded-xl bg-brand-soft/60 p-3"><div className="mb-0.5 text-xs text-muted">{t('team')} · {relTimeIn(m.created_at, lang)}</div><p className="whitespace-pre-wrap">{m.body}</p></li>)}
              {d.events.map((e) => <li key={e.id} className="flex gap-3"><span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-brand" /><div><div>{e.kind === 'status_changed' ? stLabel(e.to_status) : e.note}</div><div className="text-xs text-muted">{fmtDate(e.created_at, lang)}</div></div></li>)}
            </ul>)}
        </Section>

        <Section title={t('rightsTitle')} hint={t('rightsIntro')}>
          <ul className="space-y-2.5 text-sm">
            {(['r_free', 'r_diy', 'r_accurate', 'r_time', 'r_cancel'] as const).map((k) => <li key={k} className="flex gap-2.5"><Scale size={15} className="mt-0.5 shrink-0 text-brand" aria-hidden /><span>{t(k)}</span></li>)}
          </ul>
          <p className="mt-4 flex flex-wrap gap-x-4 gap-y-1 text-sm">
            <a className="font-medium text-brand-strong hover:underline" href="https://www.annualcreditreport.com" target="_blank" rel="noopener noreferrer">AnnualCreditReport.com</a>
            <a className="font-medium text-brand-strong hover:underline" href={lang === 'es' ? 'https://www.consumerfinance.gov/es/' : 'https://www.consumerfinance.gov/consumer-tools/credit-reports-and-scores/'} target="_blank" rel="noopener noreferrer">{t('rightsMore')}</a>
          </p>
        </Section>
      </div>
    </div>
  );
}
