import Link from 'next/link';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Avatar, Badge, EmptyState, Notice, PageHeader, Section } from '@/components/ui';
import { ActionForm, Check, Field, Select, SubmitButton, TextArea } from '@/components/forms';
import { requireStaff } from '@/lib/auth/context';
import { consentStatus } from '@/lib/compliance/disclosures';
import { asWritten, draftReason, REASON_PROMPT, reportedFor } from '@/lib/disputes/reasons';
import { loadReportedRows } from '@/lib/disputes/service';
import { CATEGORIES, categoryForFinding, FIELD_OPTIONS, mustNameAccount } from '@/lib/disputes/workflow';
import { letterForCategory } from '@/lib/letters/brief';
import type { Evidence } from '@/lib/reports/analysis';
import { BUREAU_LABEL, BUREAUS, isUuid } from '@/lib/util';
import { createDisputeAction } from '../actions';
import { SpecialtySteps } from './specialty';

export const metadata: Metadata = { title: 'New dispute' };

export default async function NewDisputePage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const ctx = await requireStaff('disputes:write');

  // ---- Step 1: choose a client
  if (!sp.clientId || !isUuid(sp.clientId)) {
    const q = (sp.q ?? '').trim().slice(0, 80);
    const PICK_LIMIT = 60;
    const clients = await ctx.tx((db) => db.rows<{ id: string; full_name: string; email: string | null; n: number }>(
      `select c.id, c.full_name, c.email, (select count(*)::int from public.tradelines t where t.client_id = c.id) as n from public.clients c
        where c.status <> 'cancelled' ${q ? "and c.full_name ilike '%' || $1 || '%'" : ''} order by c.last_activity_at desc limit ${PICK_LIMIT}`, q ? [q.replace(/[\\%_]/g, '\\$&')] : []));
    return (
      <>
        <PageHeader title="New dispute" subtitle="Step 1 of 3 · Choose the client" back={{ href: '/app/disputes', label: 'Disputes' }} />
        <form method="get" className="mb-4 flex flex-wrap items-center gap-3" role="search">
          <input name="q" defaultValue={q} placeholder="Search clients by name" className="field min-w-[14rem] flex-1" aria-label="Search clients by name" />
          <button className="btn-secondary" type="submit">Search</button>
          {q && <Link href="/app/disputes/new" className="btn-ghost">Clear</Link>}
        </form>
        {clients.length === 0 && q ? <EmptyState title="No clients match that name" body="Try a different spelling, or clear the search." />
        : clients.length === 0 ? <EmptyState title="No clients yet" action={<Link href="/app/clients/new" className="btn-primary">Add a client</Link>} /> : (
          <>
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {clients.map((c) => (
              <li key={c.id}><Link href={`/app/disputes/new?clientId=${c.id}`} className="card flex items-center gap-3 p-4 transition hover:border-brand/50">
                <Avatar name={c.full_name} /><span className="min-w-0"><span className="block truncate font-medium">{c.full_name}</span><span className="block text-xs text-muted">{c.n} account{c.n === 1 ? '' : 's'} on file</span></span>
              </Link></li>
            ))}
          </ul>
          {clients.length === PICK_LIMIT && <p className="mt-3 text-sm text-muted">Showing the {PICK_LIMIT} {q ? 'most recently active matches' : 'most recently active clients'}. Search by name to find others.</p>}
          </>
        )}
      </>
    );
  }

  const data = await ctx.tx(async (db) => {
    const client = await db.row<{ id: string; full_name: string; assigned_to: string | null }>('select id, full_name, assigned_to from public.clients where id = $1', [sp.clientId]);
    if (!client) return null;
    const tradelines = await loadReportedRows(db, client.id);
    const finding = sp.findingId && isUuid(sp.findingId)
      ? await db.row<{ id: string; category: string; dedupe_key: string; title: string; explanation: string; evidence: Evidence[]; tradeline_ids: string[]; basis: string }>('select id, category, dedupe_key, title, explanation, evidence, tradeline_ids, basis from public.findings where id = $1 and client_id = $2', [sp.findingId, sp.clientId])
      : null;
    const consents = await db.rows<{ kind: string; signed_at: string; revoked_at: string | null }>('select kind, signed_at, revoked_at from public.client_consents where client_id = $1', [sp.clientId]);
    return { client, tradelines, finding, consents };
  });
  if (!data) notFound();
  const { client, tradelines, finding, consents } = data;
  const cs = consentStatus(consents);

  // ---- A specialty agency item (ChexSystems, LexisNexis, ...) is typed in by hand; it has its own two steps.
  if (sp.specialty || sp.agency) return <SpecialtySteps client={client} agencyKey={sp.agency} />;

  const tradelineId = sp.tradelineId ?? (finding?.tradeline_ids.find((id) => tradelines.some((t) => t.id === id)) ?? '');
  const category = sp.category ?? (finding ? categoryForFinding(finding) : undefined);
  const tl = tradelines.find((t) => t.id === tradelineId);

  // ---- Step 2: what are we disputing?
  if (!category || !CATEGORIES[category] || CATEGORIES[category].target === 'agency') {
    return (
      <>
        <PageHeader title="New dispute" subtitle={`Step 2 of 3 · What is being disputed for ${client.full_name}?`} back={{ href: '/app/disputes/new', label: 'Choose client' }} />
        <form method="get" className="card card-pad mx-auto max-w-2xl space-y-5">
          <input type="hidden" name="clientId" value={client.id} />
          <Select label="Account or item" name="tradelineId" defaultValue={tradelineId} placeholder="No specific account (e.g. personal information)"
            options={tradelines.map((t) => ({ value: t.id, label: `${t.creditor_name}${t.account_last4 ? ` ••${t.account_last4}` : ''} — ${BUREAU_LABEL[t.bureau]}${t.item_type === 'collection' ? ' (collection)' : ''}` }))}
            hint={tradelines.length ? undefined : 'No approved reports yet. Upload and approve a report first, or continue without an account.'} />
          <Select label="Type of dispute" name="category" required defaultValue={tl?.item_type === 'collection' ? 'unverifiable_collection' : ''} placeholder="Choose…"
            options={Object.entries(CATEGORIES).filter(([, v]) => v.target !== 'agency').map(([k, v]) => ({ value: k, label: v.label }))} />
          <div className="flex justify-end"><button className="btn-primary" type="submit">Continue</button></div>
        </form>
        <p className="mx-auto mt-4 max-w-2xl text-sm text-muted">
          Not on a credit report? <Link className="link" href={`/app/disputes/new?clientId=${client.id}&specialty=1`}>Enter a specialty agency item</Link> (ChexSystems, Early Warning, LexisNexis and others).
        </p>
      </>
    );
  }

  // ---- Step 3: reason + details
  const cat = CATEGORIES[category]!;
  // What the reason is drafted from: the finding's evidence, or with no finding what the approved reports show for
  // this account, exactly as reported: one value per bureau, from that bureau's newest approved report (reportedFor).
  // With no report account the reason says "this account": the person names it in the field above the reason.
  const evidence: Evidence[] = finding?.evidence ?? reportedFor(category, tl, tradelines);
  const reason = draftReason({ category, creditor: tl?.creditor_name ?? '', last4: tl?.account_last4, bureau: tl?.bureau ?? null, evidence });
  const isInquiry = category === 'unauthorized_inquiry';
  // What the hint under the reason says. A drafted reason either states a value read from a report, or is a starting
  // point; a bare request to verify in a letter to a bureau is held by the specificity check until a person adds to it.
  const fromReport = evidence.some((e) => e.source === 'reported' && reason.includes(asWritten(e.value))); // a date as the reason writes it out
  const held = !fromReport && cat.target === 'bureau' && reason.startsWith('Please verify ');
  // The letter a dispute of this kind starts with. Once the dispute exists, its page recommends from the whole file.
  const fits = letterForCategory(category);

  return (
    <>
      <PageHeader title="New dispute" subtitle={`Step 3 of 3 · ${client.full_name} · ${cat.label}`} back={{ href: `/app/disputes/new?clientId=${client.id}`, label: 'Change item' }} />
      <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
        <ActionForm action={createDisputeAction} className="card card-pad space-y-5">
          <input type="hidden" name="clientId" value={client.id} /><input type="hidden" name="category" value={category} />
          <input type="hidden" name="tradelineId" value={tl?.id ?? ''} /><input type="hidden" name="findingId" value={finding?.id ?? ''} />

          {tl ? (
            <div className="rounded-xl bg-raised p-3.5 text-sm"><span className="text-muted">Item:</span> <strong>{tl.creditor_name}{tl.account_last4 && ` ••${tl.account_last4}`}</strong> <span className="text-muted">· reported by {BUREAU_LABEL[tl.bureau]}</span></div>
          ) : category === 'personal_info' ? <p className="text-sm text-muted">No specific account selected.</p> : mustNameAccount(category, false) ? (
            // An account the client knows of that is on no imported report: it has to be named here, or the letter
            // could not say which one it is about.
            <div className="grid gap-4 sm:grid-cols-[1fr_12rem]">
              <Field label={isInquiry ? 'Company that made the inquiry' : 'Account (creditor or collector)'} name="accountName" required maxLength={100} placeholder="As the client’s report or statement shows it" hint="No report account was selected, so name it here. The letter uses this name." />
              <Field label="Account ending" name="accountLast4" maxLength={4} placeholder="1234" autoComplete="off" hint={isInquiry ? 'Leave empty for an inquiry.' : 'Last digits only.'} />
            </div>
          ) : null}

          {cat.target === 'bureau' && !tl && (
            <Select label="Bureau" name="bureau" required placeholder="Choose…" options={BUREAUS.map((b) => ({ value: b, label: BUREAU_LABEL[b] }))} />
          )}
          {cat.target !== 'bureau' && <Field label="Who is this addressed to?" name="recipientName" required defaultValue={tl?.creditor_name} hint={cat.target === 'collector' ? 'The collection agency’s name.' : 'The creditor / furnisher’s name.'} />}
          {cat.target !== 'bureau' && !tl && <Field label="Account ending (optional)" name="accountLast4" maxLength={4} placeholder="1234" autoComplete="off" hint="Last digits of the account number only." className="sm:max-w-[16rem]" />}

          <fieldset>
            <legend className="label">Specific information to be reviewed</legend>
            <div className="grid gap-2 sm:grid-cols-2">{FIELD_OPTIONS.map((f) => <Check key={f} name="fields" value={f} defaultChecked={f === 'Balance' && category === 'incorrect_balance'}>{f}</Check>)}</div>
          </fieldset>

          {reason ? (
            <TextArea label="Reason" name="reason" rows={8} required defaultValue={reason}
              hint={`${fromReport ? 'Drafted from the report data and phrased as a request to verify.' : 'A starting point, phrased as a request to verify. Add what the client told you: figures, dates, what their own records show.'}${held ? ' A letter with only this text cannot be sent for approval.' : ''} Edit it so it reflects what is true for this client — and only dispute what you believe is inaccurate or unverifiable.`} />
          ) : (
            <TextArea label="Reason" name="reason" rows={8} required placeholder={REASON_PROMPT[category]}
              hint="Nothing is drafted for this kind of request: the letter states only what the client told you. Write it in the client’s words, as they would say it to the recipient." />
          )}
          <p className="text-[0.8125rem] text-muted">{cat.hint}</p>
          <Check name="makeLetter" defaultChecked>Also draft the letter (you will review and edit it before anything can be approved)</Check>
          {fits && <p className="text-[0.8125rem] text-muted">Recommended letter: <span className="font-medium text-ink">{fits.name}</span>. {fits.useWhen} You can choose another from the dispute.</p>}
          <div className="flex justify-end gap-3"><SubmitButton pendingText="Creating…">Create dispute draft</SubmitButton></div>
        </ActionForm>

        <aside className="space-y-4">
          {finding && (
            <Section plain title="Why this was suggested">
              <div className="mb-2"><Badge tone={finding.basis === 'user_provided' ? 'info' : finding.basis === 'verified_fact' ? 'ok' : 'warn'}>{finding.basis.replace(/_/g, ' ')}</Badge></div>
              <p className="text-sm font-medium">{finding.title}</p>
              <p className="mt-1 text-sm text-muted">{finding.explanation}</p>
              <ul className="mt-3 space-y-1 text-[0.8125rem] text-muted">{evidence.map((e, i) => <li key={i}>• {e.bureau ? BUREAU_LABEL[e.bureau] : e.source}: {e.field} — {e.value}</li>)}</ul>
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
