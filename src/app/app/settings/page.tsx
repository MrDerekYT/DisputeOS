import Link from 'next/link';
import type { Metadata } from 'next';
import { AlertTriangle, CheckCircle2, CircleDashed, Wrench } from 'lucide-react';
import { ActionForm, Field, SubmitButton } from '@/components/forms';
import { Badge, DefinitionList, Notice, PageHeader, Section } from '@/components/ui';
import { requireStaff } from '@/lib/auth/context';
import { CONSENT_DOCS } from '@/lib/compliance/disclosures';
import { getEnv } from '@/lib/env';
import { integrationStatus, type IntegrationStatus } from '@/lib/integrations';
import { fmtDate, titleCase } from '@/lib/util';
import { CopyButton } from '@/components/shell-client';
import { portalLoginPath } from '@/lib/org-brand';
import { leadFormPath } from '@/lib/leads';
import { changePasswordAction, signOutEverywhereAction, updateOrgAction } from './actions';

export const metadata: Metadata = { title: 'Settings' };

const STATUS: Record<IntegrationStatus, { label: string; tone: 'ok' | 'warn' | 'neutral' | 'bad'; icon: typeof CheckCircle2 }> = {
  active: { label: 'Active', tone: 'ok', icon: CheckCircle2 }, dev_only: { label: 'Development mode', tone: 'warn', icon: AlertTriangle },
  needs_credentials: { label: 'Needs credentials', tone: 'warn', icon: Wrench }, not_built: { label: 'Not built', tone: 'neutral', icon: CircleDashed },
};

export default async function SettingsPage() {
  const ctx = await requireStaff('settings:manage');
  const env = getEnv();
  const { org, eligible, sessions } = await ctx.tx(async (db) => {
    const o = await db.row<{ name: string; slug: string; state_code: string | null; plan: string; plan_status: string; trial_ends_at: string | null; settings: { retention_days?: number; brand_color?: string }; created_at: string; mode: string }>('select name, slug, state_code, plan, plan_status, trial_ends_at, settings, created_at, mode from public.organizations where id = $1', [ctx.orgId]);
    const days = o?.settings.retention_days ?? 2555;
    const e = await db.rows<{ id: string; full_name: string; status: string; last_activity_at: string }>(
      "select id, full_name, status, last_activity_at from public.clients where status in ('completed','cancelled') and last_activity_at < now() - ($1 || ' days')::interval order by last_activity_at limit 20", [String(days)]);
    return { org: o!, eligible: e, sessions: 0 };
  });
  void sessions;
  const integrations = integrationStatus();
  return (
    <>
      <PageHeader title="Settings" subtitle="Organization, security, compliance and integrations." />
      <div className="grid gap-6 xl:grid-cols-2">
        <Section title="Organization">
          <ActionForm action={updateOrgAction} className="space-y-4">
            <Field label="Business name" name="name" defaultValue={org.name} required />
            <Field label="State of operation" name="stateCode" defaultValue={org.state_code} maxLength={2} hint="Many states regulate credit services organizations (registration, bonding, contract terms). Confirm your obligations with an attorney." />
            <Field label="Keep client records for (days) after they complete or cancel" name="retentionDays" type="number" min={365} max={3650} defaultValue={org.settings.retention_days ?? 2555} hint="Used to list clients eligible for deletion. Nothing is deleted automatically." />
            <div><label className="label" htmlFor="brandColor">Client portal colour</label><div className="flex items-center gap-3"><input id="brandColor" name="brandColor" type="color" defaultValue={org.settings.brand_color ?? '#0f766e'} className="h-11 w-16 cursor-pointer rounded-xl border border-line bg-surface p-1" /><span className="text-xs text-muted">Your clients see their portal in this colour. Text contrast is adjusted automatically.</span></div></div>
            <SubmitButton>Save</SubmitButton>
          </ActionForm>
          {org.mode === 'agency' && (
            <div className="mt-6 rounded-xl border border-line bg-raised p-4">
              <div className="text-sm font-semibold">Your clients’ sign-in link</div>
              <p className="mt-0.5 text-xs text-muted">Shows your business name and portal colour, with no other branding up front. It is also included in every portal invitation.</p>
              <code className="mt-3 block break-all rounded-lg border border-line bg-surface px-3 py-2 text-xs">{env.APP_URL}{portalLoginPath(org.slug)}</code>
              <div className="mt-3 flex flex-wrap gap-2"><CopyButton value={`${env.APP_URL}${portalLoginPath(org.slug)}`} label="Copy link" /><a className="btn-ghost btn-sm" href={portalLoginPath(org.slug)} target="_blank" rel="noopener">Preview</a></div>
            </div>
          )}
          {org.mode === 'agency' && (
            <div className="mt-4 rounded-xl border border-line bg-raised p-4">
              <div className="text-sm font-semibold">Your enquiry form for new leads</div>
              <p className="mt-0.5 text-xs text-muted">Put this link on your website, social profiles or ads. Each enquiry becomes a lead in Clients with a follow-up task. It asks for contact details only — never an SSN.</p>
              <code className="mt-3 block break-all rounded-lg border border-line bg-surface px-3 py-2 text-xs">{env.APP_URL}{leadFormPath(org.slug)}</code>
              <div className="mt-3 flex flex-wrap gap-2"><CopyButton value={`${env.APP_URL}${leadFormPath(org.slug)}`} label="Copy link" /><a className="btn-ghost btn-sm" href={leadFormPath(org.slug)} target="_blank" rel="noopener">Preview</a></div>
            </div>
          )}
          <div className="mt-6 border-t border-line pt-4"><DefinitionList items={[['Plan', `${titleCase(org.plan)} (${org.plan_status})`], ['Trial ends', org.trial_ends_at ? fmtDate(org.trial_ends_at) : '—'], ['Created', fmtDate(org.created_at)], ['Workspace id', <code key="s" className="text-xs">{org.slug}</code>]]} /></div>
        </Section>

        <div className="space-y-6">
          <Section title="Your security">
            <ActionForm action={changePasswordAction} className="space-y-3">
              <Field label="Current password" name="current" type="password" autoComplete="current-password" required />
              <Field label="New password" name="next" type="password" autoComplete="new-password" required hint="10+ characters." />
              <Field label="Confirm new password" name="confirm" type="password" autoComplete="new-password" required />
              <SubmitButton variant="secondary">Change password</SubmitButton>
            </ActionForm>
            <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4 text-sm">
              <span>Two-step verification: {ctx.session.totpEnabled ? <Badge tone="ok">On</Badge> : <Badge tone="warn">Off</Badge>}</span>
              <form action={signOutEverywhereAction}><button className="btn-secondary btn-sm">Sign out of all devices</button></form>
            </div>
            <p className="mt-3 text-xs text-muted">Staff sessions end after {env.STAFF_IDLE_MINUTES} minutes idle, or 12 hours.</p>
          </Section>
        </div>
      </div>

      <div className="mt-6"><Link href="/app/settings/developers" className="card flex items-center justify-between gap-3 p-4 transition hover:border-brand/50"><span><strong>Developers &amp; connections</strong><span className="block text-sm text-muted">API keys, automatic credit-report import and provider status</span></span><span className="text-sm text-brand-strong">Open →</span></Link></div>

      <Section title="Integrations — what is actually connected" className="mt-6" hint="Derived from your configuration. “Verified” means exercised against the real service.">
        <ul className="divide-y divide-line">{integrations.map((i) => { const s = STATUS[i.status]; const Icon = s.icon; return (
          <li key={i.key} className="flex flex-col gap-1 py-3 sm:flex-row sm:items-start sm:gap-4">
            <div className="flex shrink-0 items-center gap-2 sm:w-64"><Icon size={16} className={s.tone === 'ok' ? 'text-ok' : s.tone === 'warn' ? 'text-warn' : 'text-faint'} /><span className="font-medium">{i.name}</span></div>
            <div className="min-w-0 flex-1 text-sm"><div className="flex flex-wrap items-center gap-2"><Badge tone={s.tone}>{s.label}</Badge>{i.verified ? <Badge tone="ok">Verified</Badge> : i.status !== 'not_built' && <Badge>Not verified live</Badge>}</div><p className="mt-1 text-muted">{i.detail}</p>{i.needs && <p className="mt-0.5 text-xs text-faint">Needs: {i.needs}</p>}</div>
          </li>); })}</ul>
      </Section>

      <div className="mt-6 grid gap-6 xl:grid-cols-2">
        <Section title="Compliance documents" hint="The wording clients are shown and sign. Reference drafts — have your attorney review them.">
          <ul className="space-y-2.5 text-sm">{CONSENT_DOCS.map((c) => <li key={c.kind} className="flex items-start justify-between gap-3"><span>{c.title}</span><span className="shrink-0 text-xs text-muted">{c.required ? 'Required · ' : ''}v{c.version}</span></li>)}</ul>
          <div className="mt-4"><Notice tone="warn" title="Not legal advice">The CROA disclosure must use the wording required by 15 U.S.C. § 1679c, contracts must include required terms, and several states require registration or a surety bond. Editing these documents in the app is on the roadmap; today they live in <code>src/lib/compliance/disclosures.ts</code>.</Notice></div>
        </Section>
        <Section title="Data retention" hint={`Completed or cancelled clients inactive for ${org.settings.retention_days ?? 2555}+ days. Review before deleting.`}>
          {eligible.length === 0 ? <p className="text-sm text-muted">No clients are past your retention period.</p> : (
            <ul className="divide-y divide-line text-sm">{eligible.map((c) => <li key={c.id} className="flex items-center justify-between py-2"><Link className="hover:underline" href={`/app/clients/${c.id}/edit`}>{c.full_name}</Link><span className="text-xs text-muted">{c.status} · last activity {fmtDate(c.last_activity_at)}</span></li>)}</ul>
          )}
          <p className="mt-3 text-xs text-muted">Deleting a client removes their documents, reports, disputes and letters. Export their data first from the client’s edit page.</p>
        </Section>
      </div>
    </>
  );
}
