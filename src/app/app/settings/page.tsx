import Link from 'next/link';
import type { Metadata } from 'next';
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, CircleDashed, Hand, Wrench } from 'lucide-react';
import { ActionForm, BrandColorField, Check, Field, SubmitButton } from '@/components/forms';
import { Badge, DefinitionList, Notice, PageHeader, Section } from '@/components/ui';
import { requireStaff } from '@/lib/auth/context';
import { CONSENT_DOCS } from '@/lib/compliance/disclosures';
import { getEnv } from '@/lib/env';
import { integrationStatus, type IntegrationStatus } from '@/lib/integrations';
import { DEFAULT_BRAND_HEX } from '@/lib/brand';
import { cn, fmtDate, titleCase } from '@/lib/util';
import { CopyButton } from '@/components/shell-client';
import { ShareLink } from '@/components/staff-kit';
import { portalLoginPath } from '@/lib/org-brand';
import { leadFormPath } from '@/lib/leads';
import { changePasswordAction, signOutEverywhereAction, updateOrgAction } from './actions';
import { SETUP_ANCHOR } from '@/lib/setup/checklist';
import { ClientUpdatesSection } from './client-updates';

export const metadata: Metadata = { title: 'Settings' };

const STATUS: Record<IntegrationStatus, { label: string; tone: 'ok' | 'warn' | 'neutral' | 'bad'; icon: typeof CheckCircle2 }> = {
  active: { label: 'Active', tone: 'ok', icon: CheckCircle2 }, dev_only: { label: 'Test stand-in only', tone: 'warn', icon: AlertTriangle },
  needs_credentials: { label: 'Needs credentials', tone: 'warn', icon: Wrench }, manual: { label: 'Manual path in use', tone: 'neutral', icon: Hand }, not_built: { label: 'Not built', tone: 'neutral', icon: CircleDashed },
};

export default async function SettingsPage() {
  // Everyone on the team can manage their own password and sessions here; workspace settings stay with owners and admins.
  const ctx = await requireStaff();
  const env = getEnv();
  const security = (
          <Section title="Your security">
            <ActionForm action={changePasswordAction} className="space-y-3">
              <Field label="Current password" name="current" type="password" autoComplete="current-password" required />
              <Field label="New password" name="next" type="password" autoComplete="new-password" required hint="10+ characters." />
              <Field label="Confirm new password" name="confirm" type="password" autoComplete="new-password" required />
              <SubmitButton variant="secondary">Change password</SubmitButton>
            </ActionForm>
            <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4 text-sm">
              <span className="flex flex-wrap items-center gap-2">Two-step verification: {ctx.session.totpEnabled ? <Badge tone="ok">On</Badge> : <><Badge tone="warn">Off</Badge><Link href="/mfa/setup" className="link">Turn on</Link></>}</span>
              <form action={signOutEverywhereAction}><button className="btn-secondary btn-sm">Sign out of all devices</button></form>
            </div>
            <p className="mt-3 text-xs text-muted">Staff sessions end after {env.STAFF_IDLE_MINUTES} minutes idle, or 12 hours.</p>
          </Section>
  );
  if (!ctx.can('settings:manage')) {
    return (
      <>
        <PageHeader title="Settings" subtitle="Your sign-in and security. Workspace settings are managed by an owner or admin." />
        <div className="max-w-xl">{security}</div>
      </>
    );
  }
  const { org, eligible, sessions } = await ctx.tx(async (db) => {
    const o = await db.row<{ name: string; slug: string; state_code: string | null; plan: string; plan_status: string; trial_ends_at: string | null; settings: { retention_days?: number; brand_color?: string; monitoring_url?: string; monitoring_label?: string; monitoring_paid?: boolean }; created_at: string; mode: string }>('select name, slug, state_code, plan, plan_status, trial_ends_at, settings, created_at, mode from public.organizations where id = $1', [ctx.orgId]);
    const days = o?.settings.retention_days ?? 2555;
    const e = await db.rows<{ id: string; full_name: string; status: string; last_activity_at: string }>(
      "select id, full_name, status, last_activity_at from public.clients where status in ('completed','cancelled') and last_activity_at < now() - ($1 || ' days')::interval order by last_activity_at limit 20", [String(days)]);
    return { org: o!, eligible: e, sessions: 0 };
  });
  void sessions;
  const integrations = integrationStatus();
  const agency = org.mode === 'agency';
  const sections = [['organization', 'Organization'], ...(agency ? [['links', 'Links']] : []), ['security', 'Security'], ...(agency ? [['updates', 'Client updates']] : []), ['integrations', 'Integrations'], ['records', 'Compliance and data']] as [string, string][];
  return (
    <>
      <PageHeader title="Settings" subtitle="Organization, security, compliance and integrations." />
      {/* In-page navigation, pinned under the top bar, so a long page is five short stops instead of one scroll. */}
      <nav aria-label="Settings sections" className="sticky top-[3.6875rem] z-20 -mx-4 mb-6 flex gap-1.5 overflow-x-auto border-b border-line bg-canvas px-4 py-2 sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8">
        {sections.map(([id, label]) => <a key={id} href={`#${id}`} className="flex min-h-[2.25rem] shrink-0 items-center rounded-full px-3.5 text-sm font-medium text-muted transition-colors hover:bg-raised hover:text-ink">{label}</a>)}
      </nav>

      <div className="grid gap-6 xl:grid-cols-2 xl:items-start">
        <Section id="organization" title="Organization">
          <ActionForm action={updateOrgAction} className="space-y-4">
            <Field label="Business name" name="name" defaultValue={org.name} required />
            <Field label="State of operation" name="stateCode" defaultValue={org.state_code} maxLength={2} hint="Many states regulate credit services organizations (registration, bonding, contract terms). Confirm your obligations with an attorney." />
            <Field label="Keep client records for (days) after they complete or cancel" name="retentionDays" type="number" min={365} max={3650} defaultValue={org.settings.retention_days ?? 2555} hint="Used to list clients eligible for deletion. Nothing is deleted automatically." />
            <BrandColorField initial={org.settings.brand_color} fallback={DEFAULT_BRAND_HEX} />
            <div className="space-y-3 border-t border-line pt-4">
              <Field label="Credit-monitoring referral link (optional)" name="monitoringUrl" type="url" maxLength={300} defaultValue={org.settings.monitoring_url} placeholder="https://" hint="Shown to clients as an optional paid alternative, below the free AnnualCreditReport.com instructions. It is only a link: nothing is imported from it. Leave empty to show nothing." />
              <Field label="Service name" name="monitoringLabel" maxLength={60} defaultValue={org.settings.monitoring_label} placeholder="e.g. SmartCredit" />
              <Check name="monitoringPaid" defaultChecked={org.settings.monitoring_paid !== false}>I may earn a commission from this link</Check>
              <p className="hint">If you earn a commission from this link, clients are told so.</p>
            </div>
            <SubmitButton>Save</SubmitButton>
          </ActionForm>
          <div className="mt-6 border-t border-line pt-4"><DefinitionList items={[['Plan', `${titleCase(org.plan)} (${org.plan_status})`], ['Trial ends', org.trial_ends_at ? fmtDate(org.trial_ends_at) : '—'], ['Created', fmtDate(org.created_at)], ['Workspace id', <code key="s" className="text-xs">{org.slug}</code>]]} /></div>
        </Section>

        <div className="space-y-6">
          {agency && (
            <Section id="links" title="Links you share">
              <ShareLink title="Your clients’ sign-in link" hint="Shows your business name and portal colour. It is also in every portal invitation." url={`${env.APP_URL}${portalLoginPath(org.slug)}`}>
                <CopyButton value={`${env.APP_URL}${portalLoginPath(org.slug)}`} label="Copy link" /><a className="btn-ghost btn-sm" href={portalLoginPath(org.slug)} target="_blank" rel="noopener">Preview</a>
              </ShareLink>
              <div className="mt-5 border-t border-line pt-5">
                <ShareLink title="Your enquiry form for new leads" hint="For your website, social profiles or ads. Each enquiry becomes a lead with a follow-up task. It asks for contact details only — never an SSN." url={`${env.APP_URL}${leadFormPath(org.slug)}`}>
                  <CopyButton value={`${env.APP_URL}${leadFormPath(org.slug)}`} label="Copy link" /><a className="btn-ghost btn-sm" href={leadFormPath(org.slug)} target="_blank" rel="noopener">Preview</a>
                </ShareLink>
              </div>
            </Section>
          )}
          <div id="security" className="scroll-mt-28">{security}</div>
        </div>
      </div>

      {agency && <ClientUpdatesSection ctx={ctx} />}

      <Section plain id="integrations" title="Integrations — what is actually connected" className="mt-8" hint={`What works in this environment (${env.APP_ENV}), read from its configuration. Open a row for the detail and the manual way to finish the job.`}>
        <ul className="divide-y divide-line/70">{integrations.map((i) => { const s = STATUS[i.status]; const Icon = s.icon; return (
          <li key={i.key}>
            <details className="group">
              <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-3 gap-y-1.5 rounded-md py-3 [&::-webkit-details-marker]:hidden">
                <Icon size={16} aria-hidden className={cn('shrink-0', s.tone === 'ok' ? 'text-ok' : s.tone === 'warn' ? 'text-warn' : 'text-faint')} />
                <span className="min-w-0 flex-1 basis-[11rem] font-medium">{i.name}</span>
                <span className="flex flex-wrap items-center gap-2"><Badge tone={s.tone}>{s.label}</Badge>{i.verified ? <Badge tone="ok">Verified</Badge> : (i.status === 'active' || i.status === 'needs_credentials') && <Badge>Not verified live</Badge>}</span>
                <ChevronDown size={16} aria-hidden className="shrink-0 text-muted transition-transform group-open:rotate-180" />
              </summary>
              <div className="pb-4 pl-7 text-sm"><p className="text-muted">{i.detail}</p>{i.manualPath && <p className="mt-1"><span className="font-medium">How to do it today: </span>{i.manualPath}</p>}{i.needs && <p className="mt-1 text-xs text-muted"><span className="font-medium">To connect it: </span>{i.needs}</p>}{SETUP_ANCHOR[i.key] && <p className="mt-2"><Link href={`/app/setup#${SETUP_ANCHOR[i.key]}`} className="link">Set it up step by step</Link></p>}</div>
            </details>
          </li>); })}</ul>
        <p className="mt-4"><Link href="/app/setup" className="link inline-flex items-center gap-1">Get set up: finish email and text messages, and send yourself a test <ChevronRight size={15} aria-hidden /></Link></p>
        <p className="mt-2"><Link href="/app/settings/developers" className="link inline-flex items-center gap-1">Developers &amp; connections: API keys, automatic report import and provider status <ChevronRight size={15} aria-hidden /></Link></p>
      </Section>

      <div id="records" className="mt-8 grid scroll-mt-28 gap-x-8 gap-y-6 xl:grid-cols-2">
        <Section plain title="Compliance documents" hint="The wording clients are shown and sign. Reference drafts — have your attorney review them.">
          <ul className="space-y-2.5 text-sm">{CONSENT_DOCS.map((c) => <li key={c.kind} className="flex items-start justify-between gap-3"><span>{c.title}</span><span className="shrink-0 text-xs text-muted">{c.required ? 'Required · ' : ''}v{c.version}</span></li>)}</ul>
          <div className="mt-4"><Notice tone="warn" title="Not legal advice">The CROA disclosure must use the wording required by 15 U.S.C. § 1679c, contracts must include required terms, and several states require registration or a surety bond. Editing these documents in the app is on the roadmap; today they live in <code>src/lib/compliance/disclosures.ts</code>.</Notice></div>
        </Section>
        <Section plain title="Data retention" hint={`Completed or cancelled clients inactive for ${org.settings.retention_days ?? 2555}+ days. Review before deleting.`}>
          {eligible.length === 0 ? <p className="text-sm text-muted">No clients are past your retention period.</p> : (
            <ul className="divide-y divide-line/70 text-sm">{eligible.map((c) => <li key={c.id} className="flex items-center justify-between py-2"><Link className="hover:underline" href={`/app/clients/${c.id}/edit`}>{c.full_name}</Link><span className="text-xs text-muted">{c.status} · last activity {fmtDate(c.last_activity_at)}</span></li>)}</ul>
          )}
          <p className="mt-3 text-xs text-muted">Deleting a client removes their documents, reports, disputes and letters. Export their data first from the client’s edit page.</p>
        </Section>
      </div>
    </>
  );
}
