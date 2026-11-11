import Link from 'next/link';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Avatar, Badge, EmptyState, Notice, PageHeader, Section } from '@/components/ui';
import { ActionForm, Check, Field, Select, SubmitButton, TextArea } from '@/components/forms';
import { requireStaff } from '@/lib/auth/context';
import { consentStatus } from '@/lib/compliance/disclosures';
import { draftReason } from '@/lib/disputes/reasons';
import { CATEGORIES, FIELD_OPTIONS, FINDING_TO_CATEGORY } from '@/lib/disputes/workflow';
import type { Evidence } from '@/lib/reports/analysis';
import { BUREAU_LABEL, BUREAUS, isUuid, type Bureau } from '@/lib/util';
import { createDisputeAction } from '../actions';

export const metadata: Metadata = { title: 'New dispute' };

interface TL { id: string; bureau: Bureau; creditor_name: string; account_last4: string | null; item_type: string; balance_cents: number | null }

export default async function NewDisputePage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const ctx = await requireStaff('disputes:write');

  // ---- Step 1: choose a client
  if (!sp.clientId || !isUuid(sp.clientId)) {
    const clients = await ctx.tx((db) => db.rows<{ id: string; full_name: string; email: string | null; n: number }>(
      `select c.id, c.full_name, c.email, (select count(*)::int from public.tradelines t where t.client_id = c.id) as n from public.clients c where c.status <> 'cancelled' order by c.last_activity_at desc limit 60`));
    return (
      <>
        <PageHeader title="New dispute" subtitle="Step 1 of 3 · Choose the client" back={{ href: '/app/disputes', label: 'Disputes' }} />
        {clients.length === 0 ? <EmptyState title="No clients yet" action={<Link href="/app/clients/new" className="btn-primary">Add a client</Link>} /> : (
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {clients.map((c) => (
              <li key={c.id}><Link href={`/app/disputes/new?clientId=${c.id}`} className="card flex items-center gap-3 p-4 transition hover:border-brand/50">
                <Avatar name={c.full_name} /><span className="min-w-0"><span className="block truncate font-medium">{c.full_name}</span><span className="block text-xs text-muted">{c.n} account{c.n === 1 ? '' : 's'} on file</span></span>
              </Link></li>
            ))}
          </ul>
        )}
      </>
    );
  }

  const data = await ctx.tx(async (db) => {
    const client = await db.row<{ id: string; full_name: string; assigned_to: string | null }>('select id, full_name, assigned_to from public.clients where id = $1', [sp.clientId]);
    if (!client) return null;
    const tradelines = await db.rows<TL>("select id, bureau, creditor_name, account_last4, item_type, balance_cents from public.tradelines t where client_id = $1 and exists (select 1 from public.credit_reports r where r.id = t.report_id and r.status = 'approved') order by creditor_name, bureau", [sp.clientId]);
    const finding = sp.findingId && isUuid(sp.findingId)
      ? await db.row<{ id: string; category: string; title: string; explanation: string; evidence: Evidence[]; tradeline_ids: string[]; basis: string }>('select id, category, title, explanation, evidence, tradeline_ids, basis from public.findings where id = $1 and client_id = $2', [sp.findingId, sp.clientId])
      : null;
    const consents = await db.rows<{ kind: string; signed_at: string; revoked_at: string | null }>('select kind, signed_at, revoked_at from public.client_consents where client_id = $1', [sp.clientId]);
    return { client, tradelines, finding, consents };
  });
  if (!data) notFound();
  const { client, tradelines, finding, consents } = data;
  const cs = consentStatus(consents);

  const tradelineId = sp.tradelineId ?? (finding?.tradeline_ids.find((id) => tradelines.some((t) => t.id === id)) ?? '');
  const category = sp.category ?? (finding ? FINDING_TO_CATEGORY[finding.category] : undefined);
  const tl = tradelines.find((t) => t.id === tradelineId);

  // ---- Step 2: what are we disputing?
  if (!category || !CATEGORIES[category]) {
    return (
      <>
        <PageHeader title="New dispute" subtitle={`Step 2 of 3 · What is being disputed for ${client.full_name}?`} back={{ href: '/app/disputes/new', label: 'Choose client' }} />
        <form method="get" className="card card-pad mx-auto max-w-2xl space-y-5">
          <input type="hidden" name="clientId" value={client.id} />
          <Select label="Account or item" name="tradelineId" defaultValue={tradelineId} placeholder="No specific account (e.g. personal information)"
            options={tradelines.map((t) => ({ value: t.id, label: `${t.creditor_name}${t.account_last4 ? ` ••${t.account_last4}` : ''} — ${BUREAU_LABEL[t.bureau]}${t.item_type === 'collection' ? ' (collection)' : ''}` }))}
            hint={tradelines.length ? undefined : 'No approved reports yet. Upload and approve a report first, or continue without an account.'} />
          <Select label="Type of dispute" name="category" required defaultValue={tl?.item_type === 'collection' ? 'unverifiable_collection' : ''} placeholder="Choose…"
            options={Object.entries(CATEGORIES).map(([k, v]) => ({ value: k, label: v.label }))} />
          <div className="flex justify-end"><button className="btn-primary" type="submit">Continue</button></div>
        </form>
      </>
    );
  }

  // ---- Step 3: reason + details
  const cat = CATEGORIES[category]!;
  const evidence: Evidence[] = finding?.evidence ?? [];
  const reason = draftReason({ category, creditor: tl?.creditor_name ?? 'the account', last4: tl?.account_last4, bureau: tl?.bureau ?? null, evidence });

  return (
    <>
      <PageHeader title="New dispute" subtitle={`Step 3 of 3 · ${client.full_name} · ${cat.label}`} back={{ href: `/app/disputes/new?clientId=${client.id}`, label: 'Change item' }} />
      <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
        <ActionForm action={createDisputeAction} className="card card-pad space-y-5">
          <input type="hidden" name="clientId" value={client.id} /><input type="hidden" name="category" value={category} />
          <input type="hidden" name="tradelineId" value={tl?.id ?? ''} /><input type="hidden" name="findingId" value={finding?.id ?? ''} />

          {tl ? (
            <div className="rounded-xl bg-raised p-3.5 text-sm"><span className="text-muted">Item:</span> <strong>{tl.creditor_name}{tl.account_last4 && ` ••${tl.account_last4}`}</strong> <span className="text-muted">· reported by {BUREAU_LABEL[tl.bureau]}</span></div>
          ) : <p className="text-sm text-muted">No specific account selected.</p>}

          {cat.target === 'bureau' && !tl && (
            <Select label="Bureau" name="bureau" required placeholder="Choose…" options={BUREAUS.map((b) => ({ value: b, label: BUREAU_LABEL[b] }))} />
          )}
          {cat.target !== 'bureau' && <Field label="Who is this addressed to?" name="recipientName" required defaultValue={tl?.creditor_name} hint={cat.target === 'collector' ? 'The collection agency’s name.' : 'The creditor / furnisher’s name.'} />}

          <fieldset>
            <legend className="label">Specific information to be reviewed</legend>
            <div className="grid gap-2 sm:grid-cols-2">{FIELD_OPTIONS.map((f) => <Check key={f} name="fields" value={f} defaultChecked={f === 'Balance' && category === 'incorrect_balance'}>{f}</Check>)}</div>
          </fieldset>

          <TextArea label="Reason" name="reason" rows={8} required defaultValue={reason}
            hint="Drafted from the report data and phrased as a request to verify. Edit it so it reflects what is true for this client — and only dispute what you believe is inaccurate or unverifiable." />
          <p className="text-xs text-muted">{cat.hint}</p>
          <Check name="makeLetter" defaultChecked>Also draft the letter (you will review and edit it before anything can be approved)</Check>
          <div className="flex justify-end gap-3"><SubmitButton pendingText="Creating…">Create dispute draft</SubmitButton></div>
        </ActionForm>

        <aside className="space-y-4">
          {finding && (
            <Section title="Why this was suggested">
              <div className="mb-2"><Badge tone={finding.basis === 'user_provided' ? 'info' : finding.basis === 'verified_fact' ? 'ok' : 'warn'}>{finding.basis.replace(/_/g, ' ')}</Badge></div>
              <p className="text-sm font-medium">{finding.title}</p>
              <p className="mt-1 text-sm text-muted">{finding.explanation}</p>
              <ul className="mt-3 space-y-1 text-xs text-muted">{evidence.map((e, i) => <li key={i}>• {e.bureau ? BUREAU_LABEL[e.bureau] : e.source}: {e.field} — {e.value}</li>)}</ul>
            </Section>
          )}
          {cs.missing.length > 0 && <Notice tone="warn" title="Consents missing">This client still needs: {cs.missing.join(', ').replace(/_/g, ' ')}. You can draft now, but submission is blocked until they are recorded.</Notice>}
          <Notice tone="info" title="Before you dispute">
            Dispute only information you have reason to believe is inaccurate, incomplete or unverifiable. Repeating a dispute without new information can be treated as frivolous. Nothing is sent until a person approves it.
          </Notice>
        </aside>
      </div>
    </>
  );
}
