import Link from 'next/link';
import { ActionForm, Check, Field, Select, SubmitButton } from '@/components/forms';
import { Badge, Section } from '@/components/ui';
import { AGENCY_KIND_LABEL, SPECIALTY_AGENCIES, type SpecialtyReportState, type SpecialtyReportStatus } from '@/lib/credit/agencies';
import { fmtDate } from '@/lib/util';
import { setBankingConcernAction, setSpecialtyReportAction } from '../specialty-actions';

const STATUS_LABEL: Record<SpecialtyReportStatus, string> = { not_requested: 'Not requested', requested: 'Requested', received: 'Received' };
const TONE: Record<SpecialtyReportStatus, 'neutral' | 'info' | 'ok'> = { not_requested: 'neutral', requested: 'info', received: 'ok' };

/**
 * Reports from specialty agencies (ChexSystems, LexisNexis, ...): how the client requests each one, and where it stands.
 * These reports are kept as files only. Nothing in them is read by the system; a person enters any item to dispute.
 */
export function SpecialtyBlock({ clientId, states, bankingConcern, files, today }: {
  clientId: string; states: Record<string, SpecialtyReportState>; bankingConcern: boolean; files: { id: string; file_name: string }[]; today: string;
}) {
  return (
    <Section id="specialty" title="Specialty reports" hint="Banking, public-record and similar reports. They are not read by the system: items are entered by a person.">
      <ActionForm action={setBankingConcernAction} className="mb-4 flex flex-wrap items-center justify-between gap-3 border-b border-line pb-4">
        <input type="hidden" name="clientId" value={clientId} />
        <Check name="bankingConcern" defaultChecked={bankingConcern}>This client has a banking or background-screening concern</Check>
        <SubmitButton variant="secondary" className="btn-sm">Save</SubmitButton>
      </ActionForm>
      <ul className="divide-y divide-line/70">
        {SPECIALTY_AGENCIES.map((a) => {
          const s = states[a.key] ?? { status: 'not_requested' as const, on: null, documentId: null };
          const file = files.find((f) => f.id === s.documentId);
          return (
            <li key={a.key} className="py-3 first:pt-0 last:pb-0">
              <details className="group">
                <summary className="flex cursor-pointer list-none flex-wrap items-center justify-between gap-x-3 gap-y-1.5 rounded-md [&::-webkit-details-marker]:hidden">
                  <span className="min-w-0"><span className="font-medium">{a.shortName}</span> <span className="text-[0.8125rem] text-muted">· {AGENCY_KIND_LABEL[a.kind].en}</span></span>
                  <Badge tone={TONE[s.status]}>{STATUS_LABEL[s.status]}{s.on ? ` ${fmtDate(s.on)}` : ''}</Badge>
                </summary>
                <div className="mt-3 space-y-3">
                  <p className="text-sm text-muted">{a.reports.en} <a className="link" href={a.disclosure.url} target="_blank" rel="noreferrer">How to request the free report</a>. {a.disclosure.how.en}</p>
                  {file && <a className="link block text-sm" href={`/api/documents/${file.id}`}>{file.file_name}</a>}
                  <ActionForm action={setSpecialtyReportAction} className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
                    <input type="hidden" name="clientId" value={clientId} /><input type="hidden" name="agency" value={a.key} />
                    <Select label="Status" name="status" defaultValue={s.status} options={(Object.keys(STATUS_LABEL) as SpecialtyReportStatus[]).map((k) => ({ value: k, label: STATUS_LABEL[k] }))} />
                    <Field label="Date" name="on" type="date" defaultValue={s.on ?? today} max={today} />
                    <SubmitButton variant="secondary">Save</SubmitButton>
                    {files.length > 0 && <Select className="sm:col-span-3" label="File received (optional)" name="documentId" defaultValue={s.documentId ?? ''} placeholder="None" options={files.map((f) => ({ value: f.id, label: f.file_name }))} />}
                  </ActionForm>
                  <p className="text-[0.8125rem] text-muted">
                    To attach the report, upload it under <Link className="link" href={`/app/clients/${clientId}?tab=documents`}>Documents</Link> as “Specialty report”. To dispute an item on it, <Link className="link" href={`/app/disputes/new?clientId=${clientId}&agency=${a.key}`}>enter the item</Link>.
                  </p>
                </div>
              </details>
            </li>
          );
        })}
      </ul>
    </Section>
  );
}
