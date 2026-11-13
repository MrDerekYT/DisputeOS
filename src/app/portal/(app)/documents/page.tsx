import type { Metadata } from 'next';
import { Download } from 'lucide-react';
import { ActionForm, Select, SubmitButton } from '@/components/forms';
import { Badge, EmptyState, Notice, Section } from '@/components/ui';
import { DOC_KIND_LABEL } from '@/lib/crm';
import { portalContext } from '@/lib/portal';
import { fmtDate } from '@/lib/util';
import { portalUploadAction } from '../../actions';

export const metadata: Metadata = { title: 'Documents' };
const KINDS = ['id', 'proof_of_address', 'ssn_proof', 'bureau_response', 'ftc_report', 'police_report', 'other'] as const;

export default async function PortalDocuments({ searchParams }: { searchParams: Promise<{ uploaded?: string }> }) {
  const sp = await searchParams;
  const { ctx, t, lang } = await portalContext();
  const { docs, reqs } = await ctx.tx(async (db) => ({
    docs: await db.rows<{ id: string; kind: string; file_name: string; created_at: string; source: string }>('select id, kind, file_name, created_at, source from public.documents order by created_at desc'),
    reqs: await db.rows<{ id: string; kind: string; note: string | null; fulfilled_document_id: string | null }>('select id, kind, note, fulfilled_document_id from public.document_requests order by created_at desc'),
  }));
  return (
    <div className="space-y-6">
      <h1 className="font-display text-3xl font-semibold">{t('documents')}</h1>
      {sp.uploaded && <Notice tone="ok" title={t('uploadedOk')}>{t('uploadedOkBody')}</Notice>}
      <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
        <div className="space-y-6">
          {reqs.length > 0 && <Section title={t('requested')}><ul className="divide-y divide-line text-sm">{reqs.map((r) => <li key={r.id} className="flex items-center justify-between gap-3 py-2.5"><span>{DOC_KIND_LABEL[r.kind] ?? r.kind}{r.note && <span className="text-muted"> — {r.note}</span>}</span>{r.fulfilled_document_id ? <Badge tone="ok">{t('received')}</Badge> : <Badge tone="warn">{t('requested')}</Badge>}</li>)}</ul></Section>}
          <Section title={t('uploaded')}>
            {docs.length === 0 ? <EmptyState title={t('noDocs')} /> : <ul className="divide-y divide-line">{docs.map((d) => <li key={d.id} className="flex items-center justify-between gap-3 py-3 text-sm"><a href={`/api/documents/${d.id}`} className="flex min-w-0 items-center gap-2 font-medium hover:underline"><Download size={14} className="shrink-0 text-muted" /><span className="truncate">{d.file_name}</span></a><span className="shrink-0 text-xs text-muted">{DOC_KIND_LABEL[d.kind] ?? d.kind} · {fmtDate(d.created_at, lang)}</span></li>)}</ul>}
          </Section>
        </div>
        <Section title={t('upload')}>
          <ActionForm action={portalUploadAction} resetOnSuccess className="space-y-3">
            <Select label={t('docType')} name="kind" defaultValue="other" options={KINDS.map((k) => ({ value: k, label: DOC_KIND_LABEL[k]! }))} />
            <div><label className="label" htmlFor="pfile">{t('chooseFile')}</label><input id="pfile" name="file" type="file" required accept=".pdf,.png,.jpg,.jpeg" className="field !p-2 text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-brand-soft file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-brand-strong" /><p className="hint">{t('uploadHelp')}</p></div>
            <SubmitButton pendingText="…">{t('upload')}</SubmitButton>
          </ActionForm>
        </Section>
      </div>
    </div>
  );
}
