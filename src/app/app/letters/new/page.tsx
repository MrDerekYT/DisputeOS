import Link from 'next/link';
import type { Metadata } from 'next';
import { Avatar, PageHeader } from '@/components/ui';
import { ActionForm, Check, Field, Select, SubmitButton, TextArea } from '@/components/forms';
import { requireStaff } from '@/lib/auth/context';
import { KIND_LABEL, TEMPLATES, type LetterKind } from '@/lib/letters/templates';
import { isUuid } from '@/lib/util';
import { createLetterAction } from '../actions';

export const metadata: Metadata = { title: 'New letter' };

export default async function NewLetterPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const ctx = await requireStaff('letters:write');
  const clients = await ctx.tx((db) => db.rows<{ id: string; full_name: string; preferred_language: string }>("select id, full_name, preferred_language from public.clients where status <> 'cancelled' order by last_activity_at desc limit 80"));
  const org = await ctx.tx((db) => db.rows<{ id: string; name: string; kind: LetterKind; language: string }>('select id, name, kind, language from public.letter_templates where active order by name'));
  const disputes = sp.clientId && isUuid(sp.clientId)
    ? await ctx.tx((db) => db.rows<{ id: string; item_label: string; status: string }>("select id, item_label, status from public.disputes where client_id = $1 and status <> 'cancelled' order by created_at desc", [sp.clientId]))
    : [];
  const client = clients.find((c) => c.id === sp.clientId);

  if (!client) {
    return (
      <>
        <PageHeader title="New letter" subtitle="Choose a client" back={{ href: '/app/letters', label: 'Letters' }} />
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{clients.map((c) => (
          <li key={c.id}><Link href={`/app/letters/new?clientId=${c.id}${sp.templateKey ? `&templateKey=${sp.templateKey}` : ''}`} className="card flex items-center gap-3 p-4 transition hover:border-brand/50"><Avatar name={c.full_name} /><span className="truncate font-medium">{c.full_name}</span></Link></li>))}</ul>
      </>
    );
  }
  const options = [
    ...TEMPLATES.map((t) => ({ value: t.key, label: `${KIND_LABEL[t.kind]} — ${t.language === 'es' ? 'Español' : 'English'}` })),
    ...org.map((t) => ({ value: `org:${t.id}`, label: `★ ${t.name}` })),
  ];
  return (
    <>
      <PageHeader title="New letter" subtitle={`For ${client.full_name}`} back={{ href: '/app/letters', label: 'Letters' }} />
      <ActionForm action={createLetterAction} className="card card-pad mx-auto max-w-2xl space-y-5">
        <input type="hidden" name="clientId" value={client.id} />
        <Select label="Template" name="templateKey" required defaultValue={sp.templateKey ?? (client.preferred_language === 'es' ? 'bureau_dispute_es' : 'bureau_dispute_en')} options={options}
          hint={`${client.full_name} prefers ${client.preferred_language === 'es' ? 'Spanish' : 'English'}.`} />
        <Select label="Related dispute" name="disputeId" defaultValue={sp.disputeId ?? ''} placeholder="None — a standalone letter" options={disputes.map((d) => ({ value: d.id, label: `${d.item_label} (${d.status.replace(/_/g, ' ')})` }))}
          hint="Linking a dispute fills in the account, reason, bureau address and enclosures automatically." />
        <details className="rounded-xl border border-line p-4">
          <summary className="cursor-pointer text-sm font-medium">Standalone letter details</summary>
          <div className="mt-4 space-y-4">
            <Field label="Recipient name" name="recipientName" />
            <Field label="Recipient address" name="recipientAddress" />
            <TextArea label="Reason / message" name="reason" rows={4} />
          </div>
        </details>
        <Check name="includeSsn">Include the last four digits of the client’s SSN (some bureaus ask for it)</Check>
        <p className="text-xs text-muted">The letter is created as a draft. You will review and edit it, then a manager approves it before it can be downloaded as final.</p>
        <div className="flex justify-end"><SubmitButton pendingText="Creating…">Create draft</SubmitButton></div>
      </ActionForm>
    </>
  );
}
