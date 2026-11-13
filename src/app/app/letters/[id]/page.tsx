import Link from 'next/link';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Download, History, Sparkles } from 'lucide-react';
import { ActionForm, ConfirmButton, Field, Select, SubmitButton } from '@/components/forms';
import { AiSuggest } from '@/components/ai-suggest';
import { LetterEditor } from '@/components/letter-editor';
import { DeliveryRecord, Notice, PageHeader, Section, StatusBadge } from '@/components/ui';
import { providerStatus } from '@/lib/ai/provider';
import { requireStaff } from '@/lib/auth/context';
import { approvalBlockers } from '@/lib/letters/service';
import { fmtDate, isUuid, relTime } from '@/lib/util';
import { aiAcceptLetterAction, aiSuggestLetterAction, letterStatusAction, markSentAction, restoreVersionAction, saveLetterAction } from '../actions';
import { PRODUCT } from '@/lib/product';

export const metadata: Metadata = { title: 'Letter' };

export default async function LetterPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const ctx = await requireStaff('clients:read');
  const data = await ctx.tx(async (db) => {
    const l = await db.row<{ id: string; title: string; status: string; client_id: string; client_name: string; dispute_id: string | null; current_version: number; recipient_name: string; approved_at: string | null; approver: string | null; sent_at: string | null; sent_on: string | null; sent_method: string | null; tracking_number: string | null; delivery_source: string; carrier_delivered_at: string | null; recorder: string | null; language: string }>(
      `select l.id, l.title, l.status, l.client_id, c.full_name as client_name, l.dispute_id, l.current_version, l.recipient_name, l.approved_at, u.full_name as approver, l.sent_at, l.sent_on, l.sent_method, l.tracking_number, l.delivery_source, l.carrier_delivered_at, sr.full_name as recorder, l.language
         from public.letters l join public.clients c on c.id = l.client_id left join public.users u on u.id = l.approved_by left join public.users sr on sr.id = l.sent_recorded_by where l.id = $1`, [id]);
    if (!l) return null;
    const versions = await db.rows<{ version: number; source: string; change_note: string | null; created_at: string; author: string | null; body: string }>(
      `select v.version, v.source, v.change_note, v.created_at, u.full_name as author, v.body from public.letter_versions v left join public.users u on u.id = v.author_id where v.letter_id = $1 order by v.version desc`, [id]);
    return { l, versions };
  });
  if (!data) notFound();
  const { l, versions } = data;
  const body = versions[0]!.body;
  const blockers = approvalBlockers(body);
  const locked = l.status === 'sent' || l.status === 'void';
  const ai = providerStatus();
  const today = new Date().toISOString().slice(0, 10);

  return (
    <>
      <PageHeader title={l.title} back={{ href: l.dispute_id ? `/app/disputes/${l.dispute_id}` : '/app/letters', label: l.dispute_id ? 'Dispute' : 'Letters' }}
        subtitle={<>For <Link className="underline" href={`/app/clients/${l.client_id}`}>{l.client_name}</Link> · to {l.recipient_name} · version {l.current_version}</>}
        actions={<><StatusBadge status={l.status} /><a className="btn-secondary" href={`/api/letters/${l.id}/pdf`}><Download size={15} /> PDF</a></>} />

      {l.status === 'draft' && <div className="mb-4"><Notice tone="warn" title="Draft">Not yet approved. The PDF is watermarked as a draft until a manager approves it.</Notice></div>}
      {l.status === 'approved' && <div className="mb-4"><Notice tone="ok" title="Approved">Approved by {l.approver ?? 'a manager'} on {fmtDate(l.approved_at)}. Mail it, then record that it was sent.</Notice></div>}
      {l.status === 'sent' && <div className="mb-4"><DeliveryRecord sentOn={l.sent_on ?? l.sent_at} method={l.sent_method} tracking={l.tracking_number} source={l.delivery_source} recordedBy={l.recorder} carrierDeliveredAt={l.carrier_delivered_at} /></div>}

      <div className="grid gap-6 2xl:grid-cols-[1fr_20rem]">
        <LetterEditor id={l.id} initial={body} locked={locked} save={saveLetterAction} />

        <aside className="space-y-5">
          <Section title="Approval">
            {blockers.length > 0 && <ul className="mb-3 space-y-1 text-sm text-warn">{blockers.map((b) => <li key={b}>• {b}</li>)}</ul>}
            <div className="space-y-2">
              {l.status === 'draft' && (
                <ActionForm action={letterStatusAction}><input type="hidden" name="id" value={l.id} /><input type="hidden" name="to" value="pending_approval" /><SubmitButton className="w-full">Send for approval</SubmitButton></ActionForm>
              )}
              {l.status === 'pending_approval' && (
                <>
                  {ctx.can('letters:approve') ? (
                    <ActionForm action={letterStatusAction}><input type="hidden" name="id" value={l.id} /><input type="hidden" name="to" value="approved" /><SubmitButton className="w-full">Approve this exact text (v{l.current_version})</SubmitButton></ActionForm>
                  ) : <p className="text-sm text-muted">Waiting for a manager or admin to approve.</p>}
                  <ActionForm action={letterStatusAction}><input type="hidden" name="id" value={l.id} /><input type="hidden" name="to" value="draft" /><SubmitButton className="w-full" variant="secondary">Return to draft</SubmitButton></ActionForm>
                </>
              )}
              {l.status === 'approved' && (
                <ActionForm action={markSentAction} className="space-y-3">
                  <input type="hidden" name="id" value={l.id} />
                  <Select label="How was it sent?" name="method" defaultValue="certified_mail" options={[{ value: 'certified_mail', label: 'Certified mail' }, { value: 'first_class_mail', label: 'First-class mail' }, { value: 'portal', label: 'Online portal' }, { value: 'manual', label: 'Other' }]} />
                  <Field label="Date sent" name="sentOn" type="date" defaultValue={today} max={today} required />
                  <Field label="Tracking reference" name="tracking" hint="Optional. For example the certified-mail number." maxLength={80} />
                  <SubmitButton className="w-full">Record as sent</SubmitButton>
                  <p className="text-xs text-muted">{PRODUCT.name} does not mail anything. This records that a person did; it is not a carrier confirmation.</p>
                </ActionForm>
              )}
              {!locked && (
                <ActionForm action={letterStatusAction}><input type="hidden" name="id" value={l.id} /><input type="hidden" name="to" value="void" />
                  <ConfirmButton className="btn-ghost btn-sm w-full text-bad" message="Void this letter? It cannot be reopened.">Void letter</ConfirmButton></ActionForm>
              )}
            </div>
            <p className="mt-3 text-xs text-muted">Editing an approved letter returns it to draft: what is mailed must be exactly what was approved.</p>
          </Section>

          {!locked && (
            <Section title="AI wording help">
              <p className="mb-3 flex items-start gap-2 text-sm text-muted"><Sparkles size={15} className="mt-0.5 shrink-0 text-brand" />{ai.note}</p>
              <AiSuggest id={l.id} suggest={aiSuggestLetterAction} accept={aiAcceptLetterAction} />
              <p className="mt-2 text-xs text-muted">The AI only sees the connecting wording. Names, amounts, dates, account references, bureau names and dispute statements are hidden from it and put back unchanged. You compare before and after, and nothing is saved until you accept. An accepted suggestion is a new draft that still needs approval.</p>
            </Section>
          )}

          <Section title="Version history" actions={<History size={16} className="text-muted" />}>
            <ol className="space-y-3">{versions.map((v) => (
              <li key={v.version} className="text-sm">
                <div className="flex items-center justify-between gap-2"><span className="font-medium">v{v.version}{v.version === l.current_version && <span className="ml-1.5 text-xs font-normal text-brand-strong">current</span>}</span>
                  <span className="flex gap-2"><a className="text-xs underline" href={`/api/letters/${l.id}/pdf?version=${v.version}`}>PDF</a>
                    {!locked && v.version !== l.current_version && <form action={restoreVersionAction}><input type="hidden" name="id" value={l.id} /><input type="hidden" name="version" value={v.version} /><button className="text-xs underline" type="submit">Restore</button></form>}</span></div>
                <div className="text-xs text-muted">{v.source.replace(/_/g, ' ')} · {v.author ?? 'System'} · {relTime(v.created_at)}{v.change_note ? ` · ${v.change_note}` : ''}</div>
              </li>))}</ol>
          </Section>
        </aside>
      </div>
    </>
  );
}
