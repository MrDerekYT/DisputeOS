import type { Metadata } from 'next';
import { CheckCircle2, Clock, KeyRound, ShieldCheck, Workflow } from 'lucide-react';
import { ActionForm, Check, ConfirmButton, Field, SubmitButton } from '@/components/forms';
import { Badge, Notice, PageHeader, Section } from '@/components/ui';
import { API_SCOPES, SCOPE_LABEL } from '@/lib/api/keys';
import { requireStaff } from '@/lib/auth/context';
import { listProviders, type ProviderStatus } from '@/lib/credit/providers';
import { getEnv } from '@/lib/env';
import { fmtDate, relTime } from '@/lib/util';
import { createApiKeyAction, revokeApiKeyAction } from './actions';

export const metadata: Metadata = { title: 'Developers & connections' };

const TONE: Record<ProviderStatus, 'ok' | 'warn' | 'neutral'> = { available: 'ok', sandbox_unavailable: 'neutral', needs_partner_approval: 'warn' };
const LABEL: Record<ProviderStatus, string> = { available: 'Available', sandbox_unavailable: 'Disabled in production', needs_partner_approval: 'Needs partner approval' };

export default async function DevelopersPage() {
  const ctx = await requireStaff('settings:manage');
  const keys = await ctx.tx((db) => db.rows<{ id: string; name: string; prefix: string; scopes: string[]; last_used_at: string | null; revoked_at: string | null; created_at: string; creator: string | null }>(
    `select k.id, k.name, k.prefix, k.scopes, k.last_used_at, k.revoked_at, k.created_at, u.full_name as creator from public.api_keys k left join public.users u on u.id = k.created_by order by k.created_at desc`));
  const base = getEnv().APP_URL;
  const curl = `curl -X POST ${base}/api/v1/clients/<CLIENT_ID>/reports \\
  -H "Authorization: Bearer dosk_xxxxxxxx_…" \\
  -H "Content-Type: application/json" \\
  -d '{
    "external_ref": "pull-2026-03-01-001",
    "reports": [{
      "bureau": "experian", "report_date": "2026-03-01",
      "scores": [{ "model": "VantageScore 3.0", "score": 612 }],
      "tradelines": [{ "creditor_name": "ACME BANK", "account_number": "4111111111111234",
                       "balance_cents": 120000, "payment_status": "Current", "date_opened": "2018-03-01" }]
    }]
  }'`;
  return (
    <>
      <PageHeader title="Developers & connections" back={{ href: '/app/settings', label: 'Settings' }}
        subtitle="Bring credit reports in automatically — with the client’s authorization on file and a person reviewing every import." />

      <div className="mb-6 grid gap-3 md:grid-cols-3">
        {[[ShieldCheck, '1 · Authorization first', 'No report is pulled or accepted unless the client’s written FCRA authorization is recorded. Revoke it and automatic import stops.'],
          [Workflow, '2 · Pull or push', 'Use a provider adapter, or push normalized JSON from any provider, Zapier or your own system through the API.'],
          [CheckCircle2, '3 · A person approves', 'Imports land in “pending review”, exactly like an upload. Nothing is analysed or disputed until someone confirms it.']].map(([Icon, t, b]) => {
          const I = Icon as typeof ShieldCheck;
          return <div key={t as string} className="card flex gap-3 p-4"><I size={18} className="mt-0.5 shrink-0 text-brand" /><div><div className="text-sm font-semibold">{t as string}</div><p className="text-xs text-muted">{b as string}</p></div></div>;
        })}
      </div>

      <Section title="Credit report providers" hint="Only providers with working code and legitimate access appear as available.">
        <ul className="divide-y divide-line">{listProviders().map((p) => (
          <li key={p.key} className="flex flex-col gap-1 py-3 sm:flex-row sm:gap-4">
            <div className="shrink-0 font-medium sm:w-72">{p.name}</div>
            <div className="min-w-0 flex-1 text-sm"><Badge tone={TONE[p.status]}>{LABEL[p.status]}</Badge><p className="mt-1 text-muted">{p.detail}</p>{p.needs && <p className="mt-0.5 text-xs text-faint">Needs: {p.needs}</p>}</div>
          </li>))}</ul>
        <div className="mt-4"><Notice tone="info" title="Why not “just connect” to everything?">Real credit data comes through contracts: Array’s developer docs are partner-gated, IDIQ has no public API docs, and the bureaus require agreements and certificates. We don’t guess endpoints or scrape logins — that would break provider terms and risk client credentials. When you have partner access, an adapter is a single file (see <code>docs/CREDIT_CONNECT.md</code>). Until then, anything you can legitimately receive can be pushed through the API below.</Notice></div>
      </Section>

      <Section title="API keys" className="mt-6" hint="A key acts as its creator, inside your organization, limited to the permissions you choose. Rate limit: 120 requests/minute.">
        {keys.length === 0 ? <p className="mb-4 text-sm text-muted">No keys yet.</p> : (
          <div className="table-wrap mb-5 !shadow-none"><table className="table"><thead><tr><th>Name</th><th>Key</th><th>Permissions</th><th>Last used</th><th></th></tr></thead>
            <tbody>{keys.map((k) => (
              <tr key={k.id} className={k.revoked_at ? 'opacity-50' : ''}>
                <td><div className="font-medium">{k.name}</div><div className="text-xs text-muted">{k.creator ?? '—'} · {fmtDate(k.created_at)}</div></td>
                <td><code className="text-xs">dosk_{k.prefix}_…</code></td>
                <td><div className="flex flex-wrap gap-1">{k.scopes.map((s) => <Badge key={s}>{SCOPE_LABEL[s as keyof typeof SCOPE_LABEL] ?? s}</Badge>)}</div></td>
                <td className="whitespace-nowrap text-muted"><span className="flex items-center gap-1.5"><Clock size={13} />{k.last_used_at ? relTime(k.last_used_at) : 'never'}</span></td>
                <td className="text-right">{k.revoked_at ? <Badge tone="bad">Revoked</Badge> : <form action={revokeApiKeyAction}><input type="hidden" name="id" value={k.id} /><ConfirmButton className="btn-ghost btn-sm text-bad" message="Revoke this key? Anything using it stops working immediately.">Revoke</ConfirmButton></form>}</td>
              </tr>))}</tbody></table></div>
        )}
        <ActionForm action={createApiKeyAction} resetOnSuccess className="space-y-4 rounded-2xl border border-line p-5">
          <h3 className="flex items-center gap-2 font-semibold"><KeyRound size={16} /> Create a key</h3>
          <Field label="Name" name="name" required placeholder="Zapier, provider webhook, …" />
          <fieldset><legend className="label">Permissions</legend><div className="grid gap-2 sm:grid-cols-2">{API_SCOPES.map((s) => <Check key={s} name="scope" value={s} defaultChecked={s === 'reports:write'}><code className="mr-1 text-xs">{s}</code> {SCOPE_LABEL[s]}</Check>)}</div></fieldset>
          <SubmitButton>Create key</SubmitButton>
          <p className="text-xs text-muted">The key is shown once. Only a hash is stored, so it cannot be recovered — create a new one if it is lost.</p>
        </ActionForm>
      </Section>

      <Section title="Push a report" className="mt-6" actions={<a className="btn-secondary btn-sm" href="/api/v1/openapi.json">OpenAPI spec</a>} hint="Requires the client’s written authorization to be recorded first. Retries are safe: re-sending the same external_ref is rejected.">
        <pre className="overflow-x-auto rounded-xl bg-[rgb(20,24,30)] p-4 text-xs leading-relaxed text-neutral-200"><code>{curl}</code></pre>
        <p className="mt-3 text-xs text-muted">Other endpoints: <code>GET/POST /api/v1/clients</code>, <code>GET /api/v1/clients/{'{id}'}</code> (with reports, scores and disputes), <code>GET /api/v1/disputes</code>. Account numbers are reduced to their last four characters on arrival and never stored.</p>
      </Section>
    </>
  );
}
