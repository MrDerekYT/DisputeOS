import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowRight, CheckCircle2, Clock3, Download, FolderUp } from 'lucide-react';
import { ActionForm, Select, SubmitButton } from '@/components/forms';
import { PortalBlock, PortalTitle } from '@/components/portal-kit';
import { Badge, EmptyState, Notice, Section } from '@/components/ui';
import { DOC_KINDS } from '@/lib/crm';
import { INTAKE_OPTIONAL, INTAKE_REQUIRED, intakeItem, intakeStatus, intakeSummary, type IntakeStatus } from '@/lib/intake';
import { loadIntakeDocs } from '@/lib/intake-load';
import { businessToday } from '@/lib/letters/service';
import { parseMonitoring } from '@/lib/monitoring';
import { portalContext } from '@/lib/portal';
import { fill, type PortalKey } from '@/lib/portal-i18n';
import { maxUploadMb } from '@/lib/upload';
import { fmtDate } from '@/lib/util';
import { portalUploadAction } from '../../actions';
import { PortalFileInput } from '../../file-input';

export const metadata: Metadata = { title: 'Documents' };
const KINDS = ['credit_report', 'id', 'proof_of_address', 'ssn_proof', 'bureau_response', 'ftc_report', 'police_report', 'previous_address', 'name_change', 'power_of_attorney', 'specialty_report', 'other'] as const;
const STATE_TONE = { accepted: 'ok', pending: 'info', rejected: 'bad', stale: 'warn', missing: 'warn' } as const;
const stateKey = (s: IntakeStatus): PortalKey => (s.state === 'stale' ? (s.why === 'expired' ? 'ck_expired' : 'ck_old') : `ck_${s.state}`);

export default async function PortalDocuments({ searchParams }: { searchParams: Promise<{ uploaded?: string; item?: string }> }) {
  const sp = await searchParams;
  const { ctx, t, lang } = await portalContext();
  const { docs, reqs, org, intakeDocs } = await ctx.tx(async (db) => ({
    // This client's own identity documents only: row-level security hides everyone else's.
    intakeDocs: await loadIntakeDocs(db, ctx.clientId),
    org: await db.row<{ name: string; settings: unknown }>('select name, settings from public.organizations where id = $1', [ctx.orgId]),
    docs: await db.rows<{ id: string; kind: string; file_name: string; created_at: string; source: string }>('select id, kind, file_name, created_at, source from public.documents order by created_at desc'),
    reqs: await db.rows<{ id: string; kind: string; note: string | null; fulfilled_document_id: string | null }>('select id, kind, note, fulfilled_document_id from public.document_requests order by created_at desc'),
  }));
  const monitoring = parseMonitoring(org?.settings);
  const monitoringLabel = monitoring?.label ?? t('monitoringDefaultLabel');
  const today = businessToday();
  const required = intakeStatus(intakeDocs, today);
  const optional = intakeStatus(intakeDocs, today, INTAKE_OPTIONAL);
  const sum = intakeSummary(required);
  // "Upload" on a checklist row opens the one upload form below with the right type already chosen.
  const picked = sp.item && (KINDS as readonly string[]).includes(sp.item) ? intakeItem(sp.item) : undefined;
  const row = (s: IntakeStatus) => (
    <li key={s.item.key} className="px-4 py-3.5">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
        <span className="min-w-0 text-[0.9375rem] font-semibold [overflow-wrap:anywhere]">{s.item.label[lang]}</span>
        {(s.state !== 'missing' || INTAKE_REQUIRED.includes(s.item)) && <Badge tone={STATE_TONE[s.state]}>{t(stateKey(s))}</Badge>}
      </div>
      {s.state === 'rejected' && s.reason && <p className="mt-1 text-sm [overflow-wrap:anywhere]"><span className="font-medium">{t('ck_reason')}</span> {s.reason}</p>}
      <details className="mt-1.5 text-sm">
        <summary className="cursor-pointer text-muted underline-offset-4 hover:underline">{t('ck_tips')}</summary>
        <p className="mt-2">{s.item.accepts[lang]}</p>
        <ul className="mt-1.5 list-disc space-y-1 pl-5 text-muted">{s.item.tips.map((tip) => <li key={tip.en}>{tip[lang]}</li>)}</ul>
      </details>
      {s.state !== 'accepted' && s.state !== 'pending' && (
        <Link href={`/portal/documents?item=${s.item.key}#upload`} className="btn-primary btn-sm mt-3" aria-label={`${t('upload')}: ${s.item.label[lang]}`}>
          {t(s.state === 'missing' ? 'upload' : 'ck_replace')} <ArrowRight size={15} aria-hidden />
        </Link>
      )}
    </li>
  );
  const kindLabel = (k: string) => ((DOC_KINDS as readonly string[]).includes(k) ? t(`kind_${k}` as PortalKey) : k);
  return (
    <div className="space-y-6">
      <PortalTitle>{t('documents')}</PortalTitle>
      {sp.uploaded && <Notice tone="ok" title={t('uploadedOk')}>{t('uploadedOkBody')}</Notice>}
      <PortalBlock id="checklist" title={t('ck_title')} hint={sum.complete ? t('ck_done') : <>{t('ck_intro')} <strong className="font-semibold text-ink">{fill(t('ck_progress'), { n: sum.provided, total: sum.total })}</strong></>}>
        <ul className="card divide-y divide-line/70">{required.map(row)}</ul>
        <details className="mt-3 text-sm">
          <summary className="cursor-pointer font-medium underline-offset-4 hover:underline">{t('ck_optional')}</summary>
          <ul className="card mt-3 divide-y divide-line/70">{optional.map(row)}</ul>
        </details>
        <p className="mt-3 text-[0.8125rem] text-muted">{t('ck_private')}</p>
      </PortalBlock>
      <div className="grid gap-x-10 gap-y-8 lg:grid-cols-2 lg:items-start">
        <div className="space-y-8">
          {reqs.length > 0 && (
            <PortalBlock id="requested" title={t('requested')}>
              <ul className="card divide-y divide-line/70 text-[0.9375rem]">{reqs.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 px-4 py-3">
                  <span className="min-w-0 [overflow-wrap:anywhere]"><span className="font-semibold">{kindLabel(r.kind)}</span>{r.note && <span className="text-muted"> — {r.note}</span>}</span>
                  {r.fulfilled_document_id ? <Badge tone="ok"><CheckCircle2 size={12} aria-hidden /> {t('received')}</Badge> : <Badge tone="warn"><Clock3 size={12} aria-hidden /> {t('requested')}</Badge>}
                </li>))}</ul>
            </PortalBlock>
          )}
          <Section id="upload" title={t('upload')}>
            <ActionForm key={picked?.key ?? 'any'} action={portalUploadAction} resetOnSuccess className="space-y-4">
              {picked && <p className="text-[0.9375rem]"><span className="text-muted">{t('ck_uploading')}</span> <strong className="font-semibold">{picked.label[lang]}</strong></p>}
              <Select label={t('docType')} name="kind" defaultValue={picked?.key ?? 'other'} options={KINDS.map((k) => ({ value: k, label: kindLabel(k) }))} />
              <div><label className="label" htmlFor="pfile">{t('chooseFile')}</label><PortalFileInput id="pfile" lang={lang} /><p className="hint">{fill(t('uploadHelp'), { max: maxUploadMb() })}</p></div>
              <SubmitButton pendingText="…">{t('upload')}</SubmitButton>
            </ActionForm>
          </Section>
          <PortalBlock id="free-reports" title={t('freeReportTitle')}>
            <ol className="space-y-3 text-[0.9375rem]">
              {[<>{t('freeReport1')} <a className="link" href="https://www.annualcreditreport.com" target="_blank" rel="noopener noreferrer">AnnualCreditReport.com</a></>, t('freeReport2'), t('freeReport3')].map((step, i) => (
                <li key={i} className="flex gap-3"><span aria-hidden className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-raised text-xs font-semibold text-ink">{i + 1}</span><span className="min-w-0">{step}</span></li>))}
            </ol>
            <p className="mt-3 text-[0.8125rem] leading-relaxed text-muted">{t('freeReportNote')}</p>
          </PortalBlock>
        </div>
        <div className="space-y-8">
          <PortalBlock id="uploads" title={t('uploaded')}>
            {docs.length === 0 ? <EmptyState title={t('noDocs')} icon={<FolderUp size={20} />} /> : (
              <ul className="card divide-y divide-line/70">{docs.map((d) => (
                <li key={d.id} className="flex flex-col gap-1 px-4 py-3 text-[0.9375rem]">
                  <a href={`/api/documents/${d.id}`} className="flex min-w-0 items-center gap-2 font-semibold underline-offset-4 hover:underline"><Download size={15} className="shrink-0 text-muted" aria-hidden /><span className="truncate">{d.file_name}</span></a>
                  <span className="pl-[1.4375rem] text-[0.8125rem] text-muted">{kindLabel(d.kind)} · {fmtDate(d.created_at, lang)}</span>
                </li>))}</ul>)}
          </PortalBlock>
          {monitoring && (
            <div className="border-t border-line pt-5 text-sm">
              <div className="font-semibold">{monitoringLabel} — {t('monitoringOptional')}</div>
              <p className="mt-1 text-[0.8125rem] leading-relaxed text-muted">{t('monitoringBody')}</p>
              {monitoring.paid && <p className="mt-2">{org!.name} {t('monitoringDisclosure')}</p>}
              <a className="link mt-2 inline-block" href={monitoring.url} target="_blank" rel="noopener noreferrer sponsored">{t('monitoringOpen')} {monitoringLabel}</a>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
