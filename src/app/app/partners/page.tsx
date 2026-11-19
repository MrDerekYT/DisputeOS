import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { ChevronDown, Handshake, Search } from 'lucide-react';
import { ActionForm, Check, Field, Select, SubmitButton } from '@/components/forms';
import { FilterChips } from '@/components/staff-kit';
import { Badge, EmptyState, Notice, PageHeader, Pagination, Section, Stat } from '@/components/ui';
import { requireStaff } from '@/lib/auth/context';
import { emailIsLive } from '@/lib/lead-outreach';
import { APPROVAL_COLS, APPROVAL_NEEDED, isNewlyApproved, NEW_WORKSPACE_DAILY_EMAILS, NEW_WORKSPACE_DAYS, outreachApproval, type ApprovalRow } from '@/lib/outreach-approval';
import {
  decidePartnerStep, PARTNER_CATEGORIES, PARTNER_CATEGORY_LABEL, PARTNER_DAILY_CAP, PARTNER_FAILURE_HOLD_HOURS, PARTNER_PER_RUN_CAP, PARTNER_RUN_FAILURE_LIMIT, PARTNER_STATUSES, PARTNER_STATUS_LABEL, partnerWordingIssue,
  type PartnerCategory, type PartnerStatus,
} from '@/lib/partner-emails';
import { PARTNER_ATTESTATION, PARTNER_IMPORT_MAX_ROWS } from '@/lib/partner-import';
import { PARTNER_STATE_SQL, partnerBlocker, partnerBounceHealth, partnerFailureHold, partnerSettings, partnerState, partnerTimezone, type PartnerStateRow } from '@/lib/partner-outreach';
import { dayInZone, pageParam, relTime } from '@/lib/util';
import { addPartnerAction, importPartnersAction, markPartnerAction, savePartnerOutreachAction } from './actions';
import { PARTNER_STATUS_TONE, sequenceLine } from './sequence';

export const metadata: Metadata = { title: 'Partners' };
const PAGE_SIZE = 25;
const escapeLike = (s: string) => s.replace(/[\\%_]/g, (m) => `\\${m}`);
const CATEGORY_OPTIONS = PARTNER_CATEGORIES.map((value) => ({ value, label: PARTNER_CATEGORY_LABEL[value] }));
const LANGUAGE_OPTIONS = [{ value: 'en', label: 'English' }, { value: 'es', label: 'Español' }];
const SUMMARY = 'flex w-fit cursor-pointer list-none items-center gap-1 rounded-md text-sm font-semibold text-brand-strong [&::-webkit-details-marker]:hidden';

export default async function PartnersPage({ searchParams }: { searchParams: Promise<{ q?: string; status?: string; page?: string }> }) {
  const sp = await searchParams;
  const ctx = await requireStaff('clients:read');
  if (ctx.session.orgMode !== 'agency') {
    return (
      <>
        <PageHeader title="Partners" />
        <Notice title="Partners are for agency workspaces">This is a personal workspace, so it has no referral partners.</Notice>
      </>
    );
  }
  const page = pageParam(sp.page);
  const q = sp.q?.trim().slice(0, 80) ?? '';
  const status = (PARTNER_STATUSES as readonly string[]).includes(sp.status ?? '') ? (sp.status as PartnerStatus) : '';
  const like = q ? `%${escapeLike(q)}%` : '';
  type Row = PartnerStateRow & { id: string; business_name: string; contact_name: string | null; category: PartnerCategory; email: string; city: string | null; state: string | null; referred: number };
  const { org, byStatus, emails, referred, rows, total, lastRun, hold, bounces } = await ctx.tx(async (db) => {
    const org = (await db.row<ApprovalRow & { settings: Record<string, unknown> }>(`select ${APPROVAL_COLS}, settings from public.organizations where id = $1`, [ctx.orgId]))!;
    const byStatus = await db.rows<{ status: string; n: number }>('select status, count(*)::int as n from public.partners group by status');
    const emails = (await db.row<{ sent: number; failed: number; unconfirmed: number; last_day: number; opted_out: number }>(
      `select count(*) filter (where status = 'sent')::int as sent, count(*) filter (where status = 'failed')::int as failed,
              count(*) filter (where status = 'sending' and claimed_at < now() - interval '10 minutes')::int as unconfirmed,
              count(*) filter (where status in ('sending', 'sent') and claimed_at > now() - interval '24 hours')::int as last_day,
              (select count(*) from public.partners where opted_out_at is not null)::int as opted_out
         from public.partner_outreach`))!;
    const referred = (await db.row<{ n: number }>('select count(*)::int as n from public.partner_referrals'))!.n;
    const where = "($1::text = '' or p.business_name ilike $1 or p.contact_name ilike $1 or p.email ilike $1 or p.city ilike $1) and ($2::text = '' or p.status = $2)";
    const rows = await db.rows<Row>(
      `select p.id, p.business_name, p.contact_name, p.category, p.email, p.city, p.state,
              (select count(*)::int from public.partner_referrals r where r.partner_id = p.id) as referred, ${PARTNER_STATE_SQL}
         from public.partners p where ${where} order by p.created_at desc, p.id limit $3 offset $4`, [like, status, PAGE_SIZE, (page - 1) * PAGE_SIZE]);
    const total = (await db.row<{ n: number }>(`select count(*)::int as n from public.partners p where ${where}`, [like, status]))!.n;
    const lastRun = await db.row<{ at: string | null }>('select max(started_at) as at from public.job_runs');
    return { org, byStatus, emails, referred, rows, total, lastRun: lastRun?.at ?? null, hold: await partnerFailureHold(db, ctx.orgId), bounces: await partnerBounceHealth(db, ctx.orgId, org.outreach_approved_at) };
  });

  const n = (s: PartnerStatus) => byStatus.find((b) => b.status === s)?.n ?? 0;
  const all = byStatus.reduce((sum, b) => sum + b.n, 0);
  const settings = partnerSettings(org.settings);
  const live = emailIsLive();
  const blocker = partnerBlocker(settings, live, org);
  const approval = outreachApproval(org);
  const nameIssue = partnerWordingIssue(org.name);
  const now = new Date();
  // What one agency may send in 24 hours: fewer while the workspace is newly approved.
  const dailyCap = isNewlyApproved(org, now) ? NEW_WORKSPACE_DAILY_EMAILS : PARTNER_DAILY_CAP;
  const tz = partnerTimezone(org.settings);
  const today = dayInZone(tz, now);
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  /** This list with one thing changed; a new search or filter starts again at page 1. */
  const href = (over: { q?: string; status?: string; page?: number } = {}) => {
    const next = { q, status: status as string, page: 1, ...over };
    const u = new URLSearchParams();
    if (next.q) u.set('q', next.q);
    if (next.status) u.set('status', next.status);
    if (next.page > 1) u.set('page', String(next.page));
    const s = u.toString();
    return s ? `/app/partners?${s}` : '/app/partners';
  };
  if (page > pages) redirect(href({ page: pages }));
  const canWrite = ctx.can('clients:write');
  // Why the sequence is not sending, in a few words (null when it is, or when it is simply off).
  const why = !settings.enabled ? null
    : approval !== 'approved' ? APPROVAL_NEEDED[approval]
    : blocker === 'no_address' ? 'A postal address is required: nothing is sent until you save one below.'
    : blocker === 'no_reply' ? 'A reply address is required: nothing is sent until you save one below.'
    : !live ? 'Email is not connected, so nothing is being sent.'
    : blocker === 'name_claim' ? `Your business name cannot be used in these emails. ${nameIssue?.why ?? ''} (“${nameIssue?.excerpt ?? ''}”) Change the name in Settings.`
    : null;
  // Holding with nothing else in the way: the email service refused messages, or too many addresses bounced.
  const holding = !blocker && (hold || bounces.hold);

  return (
    <>
      <PageHeader title="Partners" subtitle="Businesses that can refer clients to you: real estate agents, loan officers, mortgage brokers, car dealerships, tax preparers, property managers. You add them yourself. They are emailed only: this system never texts or calls a partner." />

      <div className="grid grid-cols-2 gap-x-6 gap-y-6 lg:grid-cols-4">
        <Stat label="On your list" value={all} sub="Partners you have added" />
        <Stat label="In sequence" value={n('in_sequence')} sub="Emailed and still due another email" />
        <Stat label="Replied or interested" value={n('replied') + n('interested')} tone={n('replied') + n('interested') ? 'ok' : undefined} sub="As recorded by your team" />
        <Stat label="Clients referred" value={referred} sub="Clients linked to a partner" />
      </div>

      <div className="mt-8 grid gap-6 xl:grid-cols-2">
        <Section id="sequence" title="Automatic email sequence" hint="An introduction, a follow-up 4 business days later and a last note 9 business days after the introduction.">
          <p className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 text-sm">
            <Badge tone={blocker ? (settings.enabled ? 'warn' : 'neutral') : holding ? 'warn' : 'ok'} dot>{blocker ? (settings.enabled ? 'On, but not sending' : 'Off') : holding ? 'On, but holding' : 'On and sending'}</Badge>
            {why && <span>{why}{blocker === 'email_not_connected' && <> <Link href="/app/settings#integrations" className="link">See Settings → Integrations</Link></>}</span>}
          </p>
          {!blocker && bounces.hold && (
            <p className="mt-2 text-sm text-warn">{bounces.bounced} of the {Math.max(bounces.sent, bounces.bounced)} addresses emailed in the last 30 days bounced. The sequence is holding: check where the list came from and remove the addresses that are not real, then ask the platform operator to approve the workspace again.</p>
          )}
          {hold && settings.enabled && (
            <p className="mt-2 text-sm text-warn [overflow-wrap:anywhere]">The email service refused the last {PARTNER_RUN_FAILURE_LIMIT} emails ({hold}). Nothing more is tried for {PARTNER_FAILURE_HOLD_HOURS} hours, or until you open one of those partners and press “Try again”.</p>
          )}
          <p className="mt-2 text-[0.8125rem] text-muted">{emails.sent} sent · {emails.failed} not sent{emails.unconfirmed ? ` · ${emails.unconfirmed} not confirmed` : ''} · {emails.opted_out} opted out · {emails.last_day} of {dailyCap} in the last 24 hours{dailyCap < PARTNER_DAILY_CAP ? ` (${PARTNER_DAILY_CAP} after the first ${NEW_WORKSPACE_DAYS} days)` : ''}</p>
          <p className="mt-2 text-[0.8125rem] text-muted">Every email says it is a business solicitation from you, shows your mailing address and has an opt-out link. It describes what you do and never promises a result.</p>
          <details className="group mt-3">
            <summary className={SUMMARY.replace('text-sm', 'text-[0.8125rem]')}>How it works <ChevronDown size={15} aria-hidden className="transition-transform group-open:rotate-180" /></summary>
            <div className="mt-2.5 space-y-2.5 text-[0.8125rem] leading-relaxed text-muted">
              <p>The platform operator approves each workspace before its sequence can send, and again after a change of business name. Once it is approved and switched on, the scheduled runs send the emails. Nobody approves each message. They go out on business days only, at most {PARTNER_PER_RUN_CAP} per run and {PARTNER_DAILY_CAP} in any 24 hours ({NEW_WORKSPACE_DAILY_EMAILS} during the first {NEW_WORKSPACE_DAYS} days), so a list is spread out and never sent at once. The wording is fixed, in English and Spanish, and uses only the category and city you entered. No AI writes any part of it.</p>
              <p>It stops for a partner when you mark that they replied, are interested, are not interested or bounced, when you pause them, or when the email service refuses a message. If the email service refuses {PARTNER_RUN_FAILURE_LIMIT} in a row, everything holds for {PARTNER_FAILURE_HOLD_HOURS} hours and the owners and admins are told why; it also holds when too many addresses bounce. An opt-out is permanent: that address is never emailed again and cannot be added again. The link in the email opens a page with one button, so a mail scanner that opens links does not opt anyone out.</p>
              <p><strong className="font-semibold text-ink">Replies are not read automatically.</strong> An answer goes to your reply address below. This system does not see it. Open the partner and use “They replied”, “Interested” or “Not interested” so no further automatic email goes out.</p>
              <p>{lastRun ? `Scheduled jobs last ran ${relTime(lastRun)}.` : 'Scheduled jobs have not run yet in this workspace; the emails are sent by the scheduled job (see Automations).'}</p>
            </div>
          </details>
          {ctx.can('settings:manage') ? (
            <ActionForm action={savePartnerOutreachAction} className="mt-4 space-y-4 border-t border-line pt-4">
              <Check name="enabled" defaultChecked={settings.enabled}>Send the email sequence to partners automatically</Check>
              <Field label="Mailing address shown in every email" name="address" maxLength={300} defaultValue={settings.address} placeholder="Street, city, state, ZIP" hint="A physical postal address is required in commercial email (CAN-SPAM). It is the same address your lead follow-up uses." />
              <Field label="Reply email address" name="replyTo" type="email" maxLength={254} defaultValue={settings.replyTo} placeholder="you@yourbusiness.com" hint="When a partner answers, the reply goes here." />
              <SubmitButton>Save</SubmitButton>
            </ActionForm>
          ) : <p className="mt-4 border-t border-line pt-4 text-xs text-muted">An owner or admin can switch this on or off.</p>}
        </Section>

        <Section id="add" title="Add partners" hint="Only businesses you found through public business contact details, or already know. No bought lists, and nothing is looked up or collected for you.">
          {canWrite ? (
            <div className="space-y-4">
              <details className="group">
                <summary className={SUMMARY}>Add one partner <ChevronDown size={16} aria-hidden className="transition-transform group-open:rotate-180" /></summary>
                <ActionForm action={addPartnerAction} className="mt-3 space-y-4" resetOnSuccess>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field label="Business name" name="businessName" required maxLength={160} />
                    <Field label="Contact name" name="contactName" maxLength={120} hint="Optional. The first name is used in the greeting." />
                    <Select label="Category" name="category" required placeholder="Choose…" options={CATEGORY_OPTIONS} />
                    <Field label="Business email" name="email" type="email" required maxLength={254} />
                    <Field label="City" name="city" maxLength={40} hint="The city name only. It is printed in the email." />
                    <Field label="State" name="state" maxLength={2} placeholder="TX" hint="Two letters." />
                    <Field label="Business phone" name="phone" type="tel" maxLength={30} hint="Kept for your own reference. It is never texted or called by this system." />
                    <Select label="Language of the emails" name="language" defaultValue="en" options={LANGUAGE_OPTIONS} />
                  </div>
                  <Field label="Where this contact came from" name="sourceNote" maxLength={300} placeholder="e.g. their office website; a business card; a client introduced us" />
                  <Check name="attest" required>{PARTNER_ATTESTATION}</Check>
                  <SubmitButton>Add partner</SubmitButton>
                </ActionForm>
              </details>
              <details className="group border-t border-line pt-4">
                <summary className={SUMMARY}>Import a list <ChevronDown size={16} aria-hidden className="transition-transform group-open:rotate-180" /></summary>
                <ActionForm action={importPartnersAction} className="mt-3 space-y-4" resetOnSuccess>
                  <div>
                    <label className="label" htmlFor="partner-list">Paste your list</label>
                    <textarea id="partner-list" name="list" rows={5} className="field resize-y font-mono text-xs" placeholder={'business name,contact name,email,category,city,state\nHill Realty,Dana Hill,dana@hillrealty.example,real estate agent,Austin,TX'} />
                    <p className="hint">The first line names the columns. “email” is required; business name, contact name, category, city, state, phone, language and source are read when present. Copying from a spreadsheet works. Up to {PARTNER_IMPORT_MAX_ROWS} rows at a time.</p>
                  </div>
                  <div>
                    <label className="label" htmlFor="partner-file">Or choose a .csv file</label>
                    <input id="partner-file" name="file" type="file" accept=".csv,.tsv,.txt,text/csv,text/plain" className="field !p-2 text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-brand-soft file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-brand-strong" />
                  </div>
                  <Select label="Category for rows that have none" name="defaultCategory" placeholder="None: leave those rows out" options={CATEGORY_OPTIONS} hint="A row whose category is not recognised is left out and listed, so nobody is written to as something they are not." />
                  <Check name="attest" required>{PARTNER_ATTESTATION}</Check>
                  <SubmitButton>Import list</SubmitButton>
                </ActionForm>
              </details>
            </div>
          ) : <p className="text-sm text-muted">Your role can view partners but not add them.</p>}
        </Section>
      </div>

      <Section plain className="mt-8" title="Your partners" hint={total ? `${total} ${q || status ? 'matching' : ''} ${total === 1 ? 'partner' : 'partners'}${pages > 1 ? `, ${PAGE_SIZE} per page` : ''}`.replace(/\s+/g, ' ') : undefined}
        actions={(
          <form method="get" className="flex flex-wrap items-center gap-2" role="search">
            {status && <input type="hidden" name="status" value={status} />}
            <div className="relative min-w-[13rem] flex-1">
              <Search size={16} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-faint" aria-hidden />
              <input name="q" defaultValue={q} placeholder="Search by business, contact, email or city" className="field pl-10" aria-label="Search partners" />
            </div>
            <button className="btn-secondary" type="submit">Search</button>
            {q && <Link href={href({ q: '' })} className="btn-ghost">Clear</Link>}
          </form>
        )}>
        {all > 0 && (
          <FilterChips label="Partner status" items={[
            { key: 'all', label: 'All', href: href({ status: '' }), count: all, active: !status },
            ...PARTNER_STATUSES.filter((s) => n(s) > 0 || s === status).map((s) => ({ key: s, label: PARTNER_STATUS_LABEL[s], href: href({ status: s }), count: n(s), active: status === s })),
          ]} />
        )}
        {rows.length === 0 ? (
          q || status ? <EmptyState title="No partners match" body="Try a different search or filter." /> : (
            <EmptyState icon={<Handshake size={20} />} title="No partners yet"
              body="Add the real estate agents, loan officers, mortgage brokers, car dealerships, tax preparers and property managers you already know, or import a list you compiled from public business contact details. Nothing is sent until you switch the sequence on." />
          )
        ) : (
          <div className="table-wrap">
            <table className="table table-stack">
              <thead><tr><th>Business</th><th>Category</th><th>Place</th><th>Status</th><th>Sequence</th><th>Referred</th><th><span className="sr-only">Actions</span></th></tr></thead>
              <tbody>
                {rows.map((p) => {
                  const line = sequenceLine(decidePartnerStep(partnerState(p, tz), today), !blocker && !holding, p.outreach.filter((o) => o.status === 'sent').length);
                  const place = [p.city, p.state].filter(Boolean).join(', ');
                  return (
                    <tr key={p.id}>
                      <td className="cell-main">
                        <Link href={`/app/partners/${p.id}`} className="font-semibold hover:underline">{p.business_name}</Link>
                        <span className="block truncate text-xs text-muted">{[p.contact_name, p.email].filter(Boolean).join(' · ')}</span>
                      </td>
                      <td className="text-muted" data-label="Category">{PARTNER_CATEGORY_LABEL[p.category] ?? p.category}</td>
                      <td className={place ? 'text-muted' : 'cell-none text-muted'} data-label="Place">{place || <span className="text-faint">—</span>}</td>
                      <td data-label="Status"><Badge tone={PARTNER_STATUS_TONE[p.status as PartnerStatus] ?? 'neutral'} dot>{PARTNER_STATUS_LABEL[p.status as PartnerStatus] ?? p.status}{p.paused ? ' · paused' : ''}{p.opted_out && p.status !== 'opted_out' ? ' · opted out of email' : ''}</Badge></td>
                      <td className={`cell-full text-xs sm:max-w-[13rem] ${line.tone === 'bad' ? 'text-bad' : line.tone === 'warn' ? 'text-warn' : line.tone === 'ok' ? 'text-ok' : 'text-muted'}`}>{line.text}</td>
                      <td className={p.referred ? 'tabular-nums text-muted' : 'cell-none text-muted'} data-label="Referred">{p.referred || <span className="text-faint">—</span>}</td>
                      <td className="cell-full sm:min-w-[11rem]">
                        <div className="flex flex-wrap gap-1.5 sm:justify-end">
                          {canWrite && (p.status === 'in_sequence' || p.status === 'finished' || p.status === 'opted_out') && (
                            <form action={markPartnerAction}><input type="hidden" name="id" value={p.id} /><input type="hidden" name="mark" value="replied" /><button type="submit" className="btn-secondary btn-sm" title="Records that they answered, and stops the automatic emails to them">They replied</button></form>
                          )}
                          <Link href={`/app/partners/${p.id}`} className="btn-secondary btn-sm">Open</Link>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <Pagination page={page} pages={pages} hrefFor={(p) => href({ page: p })} />
      </Section>
    </>
  );
}
