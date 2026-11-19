import type { Metadata } from 'next';
import { CheckCircle2, Clock3, Download, FolderUp } from 'lucide-react';
import { ActionForm, Select, SubmitButton } from '@/components/forms';
import { PortalBlock, PortalTitle } from '@/components/portal-kit';
import { Badge, EmptyState, Notice, Section } from '@/components/ui';
import { DOC_KINDS } from '@/lib/crm';
import { parseMonitoring } from '@/lib/monitoring';
import { portalContext } from '@/lib/portal';
import { fill, type PortalKey } from '@/lib/portal-i18n';
import { maxUploadMb } from '@/lib/upload';
import { fmtDate } from '@/lib/util';
import { portalUploadAction } from '../../actions';
import { PortalFileInput } from '../../file-input';

export const metadata: Metadata = { title: 'Documents' };
const KINDS = ['credit_report', 'id', 'proof_of_address', 'ssn_proof', 'bureau_response', 'ftc_report', 'police_report', 'other'] as const;

export default async function PortalDocuments({ searchParams }: { searchParams: Promise<{ uploaded?: string }> }) {
  const sp = await searchParams;
  const { ctx, t, lang } = await portalContext();
  const { docs, reqs, org } = await ctx.tx(async (db) => ({
    org: await db.row<{ name: string; settings: unknown }>('select name, settings from public.organizations where id = $1', [ctx.orgId]),
    docs: await db.rows<{ id: string; kind: string; file_name: string; created_at: string; source: string }>('select id, kind, file_name, created_at, source from public.documents order by created_at desc'),
    reqs: await db.rows<{ id: string; kind: string; note: string | null; fulfilled_document_id: string | null }>('select id, kind, note, fulfilled_document_id from public.document_requests order by created_at desc'),
  }));
  const monitoring = parseMonitoring(org?.settings);
  const monitoringLabel = monitoring?.label ?? t('monitoringDefaultLabel');
  const kindLabel = (k: string) => ((DOC_KINDS as readonly string[]).includes(k) ? t(`kind_${k}` as PortalKey) : k);
  return (
    <div className="space-y-6">
      <PortalTitle>{t('documents')}</PortalTitle>
      {sp.uploaded && <Notice tone="ok" title={t('uploadedOk')}>{t('uploadedOkBody')}</Notice>}
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
          <Section title={t('upload')}>
            <ActionForm action={portalUploadAction} resetOnSuccess className="space-y-4">
              <Select label={t('docType')} name="kind" defaultValue="other" options={KINDS.map((k) => ({ value: k, label: kindLabel(k) }))} />
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
