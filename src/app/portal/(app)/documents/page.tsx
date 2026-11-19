import type { Metadata } from 'next';
import { Download } from 'lucide-react';
import { ActionForm, Select, SubmitButton } from '@/components/forms';
import { Badge, EmptyState, Notice, Section } from '@/components/ui';
import { DOC_KINDS } from '@/lib/crm';
import { parseMonitoring } from '@/lib/monitoring';
import { portalContext } from '@/lib/portal';
import type { PortalKey } from '@/lib/portal-i18n';
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
      <h1 className="font-display text-3xl font-semibold">{t('documents')}</h1>
      {sp.uploaded && <Notice tone="ok" title={t('uploadedOk')}>{t('uploadedOkBody')}</Notice>}
      <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
        <div className="space-y-6">
          {reqs.length > 0 && <Section title={t('requested')}><ul className="divide-y divide-line text-sm">{reqs.map((r) => <li key={r.id} className="flex items-center justify-between gap-3 py-2.5"><span>{kindLabel(r.kind)}{r.note && <span className="text-muted"> — {r.note}</span>}</span>{r.fulfilled_document_id ? <Badge tone="ok">{t('received')}</Badge> : <Badge tone="warn">{t('requested')}</Badge>}</li>)}</ul></Section>}
          <Section title={t('uploaded')}>
            {docs.length === 0 ? <EmptyState title={t('noDocs')} /> : <ul className="divide-y divide-line">{docs.map((d) => <li key={d.id} className="flex flex-col gap-1 py-3 text-sm sm:flex-row sm:items-center sm:justify-between sm:gap-3"><a href={`/api/documents/${d.id}`} className="flex min-w-0 items-center gap-2 font-medium hover:underline"><Download size={14} className="shrink-0 text-muted" /><span className="truncate">{d.file_name}</span></a><span className="shrink-0 text-xs text-muted">{kindLabel(d.kind)} · {fmtDate(d.created_at, lang)}</span></li>)}</ul>}
          </Section>
        </div>
        <div className="space-y-6">
        <Section title={t('freeReportTitle')}>
          <ol className="list-decimal space-y-1.5 pl-5 text-sm"><li>{t('freeReport1')} <a className="font-medium text-brand-strong underline" href="https://www.annualcreditreport.com" target="_blank" rel="noopener noreferrer">AnnualCreditReport.com</a></li><li>{t('freeReport2')}</li><li>{t('freeReport3')}</li></ol>
          <p className="mt-3 text-xs text-muted">{t('freeReportNote')}</p>
        </Section>
        {monitoring && (
          <div className="rounded-xl border border-line bg-raised p-4 text-sm">
            <div className="font-medium">{monitoringLabel} — {t('monitoringOptional')}</div>
            <p className="mt-1 text-xs text-muted">{t('monitoringBody')}</p>
            {monitoring.paid && <p className="mt-2">{org!.name} {t('monitoringDisclosure')}</p>}
            <a className="mt-2 inline-block font-medium text-brand-strong underline" href={monitoring.url} target="_blank" rel="noopener noreferrer sponsored">{t('monitoringOpen')} {monitoringLabel}</a>
          </div>
        )}
        <Section title={t('upload')}>
          <ActionForm action={portalUploadAction} resetOnSuccess className="space-y-3">
            <Select label={t('docType')} name="kind" defaultValue="other" options={KINDS.map((k) => ({ value: k, label: kindLabel(k) }))} />
            <div><label className="label" htmlFor="pfile">{t('chooseFile')}</label><PortalFileInput id="pfile" tooLarge={t('e_fileTooLarge')} /><p className="hint">{t('uploadHelp')}</p></div>
            <SubmitButton pendingText="…">{t('upload')}</SubmitButton>
          </ActionForm>
        </Section>
        </div>
      </div>
    </div>
  );
}
