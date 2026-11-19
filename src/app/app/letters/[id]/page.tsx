import Link from 'next/link';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { AlertTriangle, Download } from 'lucide-react';
import { ActionForm, ConfirmButton, Field, Select, SubmitButton } from '@/components/forms';
import { AiSuggest } from '@/components/ai-suggest';
import { LetterEditor } from '@/components/letter-editor';
import { AiTag, Badge, DeliveryRecord, Notice, PageHeader, Section, StatusBadge } from '@/components/ui';
import { aiUnapproved } from '@/components/staff-kit';
import { AI_COSTS, AI_OFF, getBalance } from '@/lib/ai/credits';
import { providerStatus } from '@/lib/ai/provider';
import { storedSuggestion } from '@/lib/letters/suggest';
import { refusalMessage } from '@/lib/refusals';
import { requireStaff } from '@/lib/auth/context';
import { approvalBlockers, businessToday } from '@/lib/letters/service';
import { BUREAU_LABEL, fmtDate, isUuid, relTime, type Bureau } from '@/lib/util';
import { aiAcceptLetterAction, aiSuggestLetterAction, letterStatusAction, markSentAction, restoreVersionAction, saveLetterAction } from '../actions';
import { PRODUCT } from '@/lib/product';

export const metadata: Metadata = { title: 'Letter' };

const SOURCE_LABEL: Record<string, string> = { template: 'From template', manual_edit: 'Edited by hand', ai_draft: 'AI draft' };

export default async function LetterPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ error?: string }> }) {
  const { id } = await params;
  const sp = await searchParams;
  if (!isUuid(id)) notFound();
  const ctx = await requireStaff('clients:read');
  const data = await ctx.tx(async (db) => {
    const l = await db.row<{ id: string; title: string; status: string; client_id: string; client_name: string; dispute_id: string | null; current_version: number; recipient_name: string; approved_at: string | null; approver: string | null; sent_at: string | null; sent_on: string | null; sent_method: string | null; tracking_number: string | null; delivery_source: string; carrier_delivered_at: string | null; recorder: string | null; language: string; dispute_status: string | null; dispute_submitted_at: string | null }>(
      `select l.id, l.title, l.status, l.client_id, c.full_name as client_name, l.dispute_id, l.current_version, l.recipient_name, l.approved_at, u.full_name as approver, l.sent_at, l.sent_on, l.sent_method, l.tracking_number, l.delivery_source, l.carrier_delivered_at, sr.full_name as recorder, l.language, d.status as dispute_status, d.submitted_at as dispute_submitted_at
         from public.letters l join public.clients c on c.id = l.client_id left join public.users u on u.id = l.approved_by left join public.users sr on sr.id = l.sent_recorded_by left join public.disputes d on d.id = l.dispute_id where l.id = $1`, [id]);
    if (!l) return null;
    const versions = await db.rows<{ version: number; source: string; change_note: string | null; created_at: string; author: string | null; body: string }>(
      `select v.version, v.source, v.change_note, v.created_at, u.full_name as author, v.body from public.letter_versions v left join public.users u on u.id = v.author_id where v.letter_id = $1 order by v.version desc`, [id]);
    return { l, versions, credits: await getBalance(ctx.orgId, db), kept: await storedSuggestion(db, id, versions[0]?.version ?? 0) };
  });
  if (!data) notFound();
  const { l, versions, credits, kept } = data;
  const body = versions[0]!.body;
  const blockers = approvalBlockers(body);
  const locked = l.status === 'sent' || l.status === 'void';
  // A letter for a dispute that has not been submitted yet is recorded as sent from the dispute, which also starts the response deadline.
  const viaDispute = !!l.dispute_id && !l.dispute_submitted_at && l.dispute_status !== 'cancelled';
  const ai = providerStatus();
  const today = businessToday(); // the agency's calendar day (APP_TIMEZONE), not the UTC date
  // How the current text came to be (letter_versions.source). An AI draft carries the AI mark until a person approves that exact text.
  const currentSource = versions.find((v) => v.version === l.current_version)?.source ?? null;
  const aiPending = aiUnapproved({ source: currentSource, status: l.status });
  const aiApproved = currentSource === 'ai_draft' && (l.status === 'approved' || l.status === 'sent');

  return (
    <>
      <PageHeader title={l.title} back={{ href: l.dispute_id ? `/app/disputes/${l.dispute_id}` : '/app/letters', label: l.dispute_id ? 'Dispute' : 'Letters' }}
        subtitle={<>For <Link className="link" href={`/app/clients/${l.client_id}`}>{l.client_name}</Link> · to {BUREAU_LABEL[l.recipient_name.toLowerCase() as Bureau] ?? l.recipient_name} · version {l.current_version}</>}
        actions={<>{aiPending && <AiTag title="This version was worded by AI and has not been approved by a person yet">AI wording, not yet approved</AiTag>}<StatusBadge status={l.status} /><a className="btn-secondary" href={`/api/letters/${l.id}/pdf`}><Download size={15} aria-hidden /> PDF</a></>} />

      {sp.error && <div className="mb-4" role="alert"><Notice tone="warn" title="That did not go through">{refusalMessage(sp.error)}</Notice></div>}
      {l.status === 'draft' && <div className="mb-4"><Notice tone="warn" title="Draft">Not yet approved. The PDF is watermarked as a draft until a manager approves it.{aiPending && ' The wording of this version was suggested by AI and accepted by a teammate: read it in full before it goes for approval.'}</Notice></div>}
      {l.status === 'approved' && <div className="mb-4"><Notice tone="ok" title="Approved">Approved by {l.approver ?? 'a manager'} on {fmtDate(l.approved_at)}.{aiApproved && ' The wording began as an AI draft; a person approved this exact text.'} {viaDispute ? 'Mail it, then record the submission on the dispute. That marks this letter as sent and starts the response deadline.' : 'Mail it, then record that it was sent.'}</Notice></div>}
      {l.status === 'sent' && <div className="mb-4"><DeliveryRecord sentOn={l.sent_on ?? l.sent_at} method={l.sent_method} tracking={l.tracking_number} source={l.delivery_source} recordedBy={l.recorder} carrierDeliveredAt={l.carrier_delivered_at} /></div>}

      <div className="grid gap-6 2xl:grid-cols-[1fr_20rem]">
        <LetterEditor id={l.id} initial={body} locked={locked} save={saveLetterAction} />

        <aside className="space-y-5">
          <Section title="Approval">
            {blockers.length > 0 && <ul className="mb-3 space-y-1.5 text-sm">{blockers.map((b) => <li key={b} className="flex gap-2"><AlertTriangle size={15} aria-hidden className="mt-0.5 shrink-0 text-warn" />{b}</li>)}</ul>}
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
              {l.status === 'approved' && viaDispute && (
                <div className="space-y-2">
                  <Link href={`/app/disputes/${l.dispute_id}`} className="btn-primary w-full">Record the submission on the dispute</Link>
                  <p className="text-xs text-muted">{l.dispute_status === 'approved' ? 'Recording it there' : 'Once the dispute is approved, recording the submission there'} marks this letter as sent with the same details and starts the response deadline, so it only has to be entered once.</p>
                </div>
              )}
              {l.status === 'approved' && !viaDispute && (
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
            <Section plain title="AI wording help" actions={<AiTag />}>
              <p className="mb-3 text-sm text-muted">{!ai.active ? AI_OFF.no_provider : credits < AI_COSTS.letter_suggestion ? AI_OFF.no_credits : ai.note}</p>
              <p className="mb-3 text-sm">AI credits: <strong>{credits}</strong> <span className="text-muted">· a suggestion costs {AI_COSTS.letter_suggestion}, charged only when one is returned and kept for this version of the letter, so it is not charged twice.{ctx.can('settings:manage') && <> <Link className="link" href="/app/assistant#ai-credits">Details</Link></>}</span></p>
              <AiSuggest id={l.id} suggest={aiSuggestLetterAction} accept={aiAcceptLetterAction}
                stored={kept ? { before: body, after: kept.body, version: String(versions[0]!.version), provider: kept.provider } : undefined} />
              <p className="mt-2 text-xs text-muted">The AI only sees the connecting wording. Names, amounts, dates, account references, bureau names and dispute statements are hidden from it and put back unchanged. You compare before and after, and nothing is saved until you accept. An accepted suggestion is a new draft that still needs approval.</p>
            </Section>
          )}

          <Section plain title="Version history">
            <ol className="space-y-3.5">{versions.map((v) => {
              const current = v.version === l.current_version;
              // An older AI-worded version keeps its mark: nothing on record says a person approved that text.
              const aiMark = v.source === 'ai_draft' && !(current && aiApproved);
              return (
              <li key={v.version} className="text-sm">
                <div className="flex items-center justify-between gap-2"><span className="flex flex-wrap items-center gap-1.5 font-semibold">v{v.version}{current && <Badge tone="brand">Current</Badge>}{aiMark && <AiTag title="Worded by AI, accepted by staff as a draft">AI wording</AiTag>}{v.source === 'ai_draft' && !aiMark && <Badge tone="ok">AI draft, approved by a person</Badge>}</span>
                  <span className="flex shrink-0 gap-3"><a className="text-xs text-muted underline hover:text-ink" href={`/api/letters/${l.id}/pdf?version=${v.version}`} aria-label={`PDF of version ${v.version}`}>PDF</a>
                    {!locked && v.version !== l.current_version && <form action={restoreVersionAction}><input type="hidden" name="id" value={l.id} /><input type="hidden" name="version" value={v.version} /><button className="text-xs text-muted underline hover:text-ink" type="submit" aria-label={`Restore version ${v.version}`}>Restore</button></form>}</span></div>
                <div className="mt-0.5 text-xs text-muted">{SOURCE_LABEL[v.source] ?? v.source.replace(/_/g, ' ')} · {v.author ?? 'System'} · {relTime(v.created_at)}{v.change_note ? ` · ${v.change_note}` : ''}</div>
              </li>);
            })}</ol>
          </Section>
        </aside>
      </div>
    </>
  );
}
