import Link from 'next/link';
import type { Metadata } from 'next';
import { Avatar, EmptyState, PageHeader } from '@/components/ui';
import { ActionForm, Check, Field, Select, SubmitButton, TextArea } from '@/components/forms';
import { requireStaff } from '@/lib/auth/context';
import { KIND_LABEL, TEMPLATES, type LetterKind } from '@/lib/letters/templates';
import { isUuid } from '@/lib/util';
import { createLetterAction } from '../actions';

export const metadata: Metadata = { title: 'New letter' };

export default async function NewLetterPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const ctx = await requireStaff('letters:write');
  const q = (sp.q ?? '').trim().slice(0, 80);
  const PICK_LIMIT = 80;
  // A client linked from their own page or a dispute is loaded directly, so it works however many clients the workspace has.
  const client = sp.clientId && isUuid(sp.clientId)
    ? await ctx.tx((db) => db.row<{ id: string; full_name: string; preferred_language: string }>('select id, full_name, preferred_language from public.clients where id = $1', [sp.clientId]))
    : null;

  if (!client) {
    const clients = await ctx.tx((db) => db.rows<{ id: string; full_name: string }>(
      `select id, full_name from public.clients where status <> 'cancelled' ${q ? "and full_name ilike '%' || $1 || '%'" : ''} order by last_activity_at desc limit ${PICK_LIMIT}`, q ? [q.replace(/[\\%_]/g, '\\$&')] : []));
    return (
      <>
        <PageHeader title="New letter" subtitle="Choose a client" back={{ href: '/app/letters', label: 'Letters' }} />
        <form method="get" className="mb-4 flex flex-wrap items-center gap-3" role="search">
          {sp.templateKey && <input type="hidden" name="templateKey" value={sp.templateKey} />}
          <input name="q" defaultValue={q} placeholder="Search clients by name" className="field min-w-[14rem] flex-1" aria-label="Search clients by name" />
          <button className="btn-secondary" type="submit">Search</button>
          {q && <Link href={`/app/letters/new${sp.templateKey ? `?templateKey=${encodeURIComponent(sp.templateKey)}` : ''}`} className="btn-ghost">Clear</Link>}
        </form>
        {clients.length === 0 ? (
          q ? <EmptyState title="No clients match that name" body="Try a different spelling, or clear the search." />
            : <EmptyState title="No clients yet" body="Add a client first, then create a letter for them." action={<Link href="/app/clients/new" className="btn-primary">Add a client</Link>} />
        ) : (
          <>
            <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{clients.map((c) => (
              <li key={c.id}><Link href={`/app/letters/new?clientId=${c.id}${sp.templateKey ? `&templateKey=${encodeURIComponent(sp.templateKey)}` : ''}`} className="card flex items-center gap-3 p-4 transition hover:border-brand/50"><Avatar name={c.full_name} /><span className="truncate font-medium">{c.full_name}</span></Link></li>))}</ul>
            {clients.length === PICK_LIMIT && <p className="mt-3 text-sm text-muted">Showing the {PICK_LIMIT} {q ? 'most recently active matches' : 'most recently active clients'}. Search by name to find others.</p>}
          </>
        )}
      </>
    );
  }
  const org = await ctx.tx((db) => db.rows<{ id: string; name: string; kind: LetterKind; language: string }>('select id, name, kind, language from public.letter_templates where active order by name'));
  const disputes = await ctx.tx((db) => db.rows<{ id: string; item_label: string; status: string }>("select id, item_label, status from public.disputes where client_id = $1 and status <> 'cancelled' order by created_at desc", [client.id]));
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
