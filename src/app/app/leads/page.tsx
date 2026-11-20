import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { ChevronDown, Search, UserPlus } from 'lucide-react';
import { ActionForm, Check, ConfirmButton, Field, SubmitButton } from '@/components/forms';
import { CopyButton } from '@/components/shell-client';
import { Badge, EmptyState, Notice, PageHeader, Pagination, Section, Stat, type Tone } from '@/components/ui';
import { ShareLink } from '@/components/staff-kit';
import { requireStaff } from '@/lib/auth/context';
import { getEnv } from '@/lib/env';
import { decideLeadStep, DEFAULT_LEAD_SOURCE, LEAD_SOURCE_TAGS, LEAD_STEPS, LEAD_WINDOW_DAYS, type LeadDecision } from '@/lib/lead-emails';
import { DELIVERED_BY_TEAM_SQL, emailIsLive, EMAIL_STEPS_SQL, LEAD_TEXT_STATE_SQL, leadState, leadTextBlocker, leadTextState, outreachBlocker, outreachSettings, TEXT_STEPS_SQL, type LeadTextStateRow } from '@/lib/lead-outreach';
import { mailingAddressIssue, MAILING_ADDRESS_MAX } from '@/lib/mailing-address';
import { APPROVAL_COLS, APPROVAL_NEEDED, outreachApproval, type ApprovalRow } from '@/lib/outreach-approval';
import { decideLeadText, LEAD_TEXT_STEPS } from '@/lib/lead-texts';
import { smsUsable } from '@/lib/sms';
import { parseSite, sitePath } from '@/lib/agency-site';
import { leadFormPath } from '@/lib/leads';
import { fmtDate, pageParam, relTime } from '@/lib/util';
import { leadAskedToStopAction, leadRepliedAction, saveLeadFollowUpAction, setLeadStatusAction } from './actions';

export const metadata: Metadata = { title: 'Leads' };
const PAGE_SIZE = 25;
const escapeLike = (s: string) => s.replace(/[\\%_]/g, (m) => `\\${m}`);
const sourceLabel = (s: string | null) => (!s ? 'Added by your team' : s === DEFAULT_LEAD_SOURCE ? 'Enquiry form (no tag)' : s);
/** The enquiry form stores "Goal: Buying a home. <their message>" in the client's goals. */
const goalOf = (goals: string | null) => /^Goal: ([^.]+)\./.exec(goals ?? '')?.[1] ?? null;
// Sent or logged by a person (or a workspace automation) — everything except the automatic lead emails, and not
// email that failed or was never delivered because no email service is connected.
const PERSONAL_CONTACT = `exists (select 1 from public.communications m where m.client_id = c.id and ${DELIVERED_BY_TEAM_SQL}
  and not exists (select 1 from public.lead_outreach o where o.communication_id = m.id))`;
const FROM_FORM = "exists (select 1 from public.client_events e where e.client_id = c.id and e.kind = 'lead_created')";

/** What the "Follow-up" column says for one lead: always derived from the same rule the scheduled job uses. */
function followUp(d: LeadDecision, sending: boolean, sent: number, optOutReason: string | null = null): { text: string; tone: Tone } {
  const label = (k: string) => LEAD_STEPS.find((s) => s.key === k)?.label.toLowerCase() ?? k;
  if (d.kind === 'stop') {
    switch (d.reason) {
      // The email service reports a bounce or a spam complaint about a follow-up email; both end the follow-up.
      case 'opted_out': return { text: optOutReason === 'bounce' ? 'An email bounced: no more automatic email' : optOutReason === 'complaint' ? 'Marked an email as spam: no more automatic email' : 'Opted out of automatic email', tone: 'warn' };
      case 'no_consent': return { text: 'No automatic email — added by your team', tone: 'neutral' };
      case 'no_email': return { text: 'No email address', tone: 'neutral' };
      case 'replied': return { text: 'Stopped — a reply is on file', tone: 'ok' };
      case 'contacted': return { text: 'Stopped — your team is in touch', tone: 'ok' };
      case 'done': return { text: 'All 3 automatic emails sent', tone: 'neutral' };
      case 'failed': return { text: 'An automatic email failed', tone: 'bad' };
      case 'unconfirmed': return { text: 'Stopped — one email was not confirmed as sent; contact them yourself', tone: 'bad' };
      case 'expired': return { text: sent ? `${sent} of 3 sent — enquiry is over ${LEAD_WINDOW_DAYS} days old` : `No automatic email — enquiry is over ${LEAD_WINDOW_DAYS} days old`, tone: 'neutral' };
      case 'before_switch': return { text: 'No automatic email — came in before it was switched on', tone: 'neutral' };
      default: return { text: '—', tone: 'neutral' };
    }
  }
  if (!sending) return { text: sent ? `${sent} of 3 sent — paused` : 'Nothing sent — automatic email is not running', tone: 'neutral' };
  if (d.kind === 'wait') return { text: `${sent} of 3 sent — ${label(d.step)} due ${fmtDate(d.dueAt)}`, tone: 'info' };
  return { text: `${sent} of 3 sent — ${label(d.step)} goes out at the next scheduled run`, tone: 'info' };
}

export default async function LeadsPage({ searchParams }: { searchParams: Promise<{ q?: string; page?: string }> }) {
  const sp = await searchParams;
  const ctx = await requireStaff('clients:read');
  const env = getEnv();
  const page = pageParam(sp.page);
  const q = sp.q?.trim().slice(0, 80) ?? '';
  type Row = LeadTextStateRow & { id: string; full_name: string; email: string | null; goals: string | null; source: string | null; last_contact: string | null; last_contact_auto: boolean; last_contact_channel: string | null; opt_out_reason: string | null };
  const { org, counts, sources, rows, total, emails, lastRun } = await ctx.tx(async (db) => {
    const org = (await db.row<ApprovalRow & { slug: string; mode: string; settings: Record<string, unknown> }>(`select ${APPROVAL_COLS}, slug, mode, settings from public.organizations where id = $1`, [ctx.orgId]))!;
    const counts = (await db.row<{ new_week: number; waiting: number; contacted: number; converted: number }>(
      `select (select count(*) from public.client_events e where e.kind = 'lead_created' and e.created_at > now() - interval '7 days')::int as new_week,
              count(*) filter (where c.status = 'lead' and not ${PERSONAL_CONTACT})::int as waiting,
              count(*) filter (where c.status = 'lead' and ${PERSONAL_CONTACT})::int as contacted,
              count(*) filter (where c.status in ('onboarding', 'active', 'paused', 'completed') and ${FROM_FORM})::int as converted
         from public.clients c`))!;
    const sources = await db.rows<{ source: string | null; n: number; converted: number }>(
      `select c.source, count(*)::int as n, count(*) filter (where c.status in ('onboarding', 'active', 'paused', 'completed'))::int as converted
         from public.clients c where ${FROM_FORM} group by c.source order by n desc, c.source limit 12`);
    const rows = await db.rows<Row>(
      `select c.id, c.full_name, c.email, c.goals, c.source, lc.created_at as last_contact, lc.channel as last_contact_channel,
              exists (select 1 from public.lead_outreach o where o.communication_id = lc.id) as last_contact_auto,
              (select e.meta->>'reason' from public.client_events e where e.client_id = c.id and e.kind = 'lead_opt_out' order by e.created_at desc limit 1) as opt_out_reason,
              ${LEAD_TEXT_STATE_SQL}
         from public.clients c
         left join lateral (select m.id, m.created_at, m.channel from public.communications m where m.client_id = c.id and ${DELIVERED_BY_TEAM_SQL} order by m.created_at desc limit 1) lc on true
        where c.status = 'lead' and ($1::text = '' or c.full_name ilike $1)
        order by c.created_at desc limit $2 offset $3`, [q ? `%${escapeLike(q)}%` : '', PAGE_SIZE, (page - 1) * PAGE_SIZE]);
    // Counted separately from the page of rows, so a page past the end still knows how many leads there are.
    const total = (await db.row<{ n: number }>("select count(*)::int as n from public.clients c where c.status = 'lead' and ($1::text = '' or c.full_name ilike $1)", [q ? `%${escapeLike(q)}%` : '']))!.n;
    const emails = (await db.row<{ sent: number; failed: number; unconfirmed: number; opted_out: number; texts: number }>(
      `select (select count(*) from public.lead_outreach where status = 'sent' and step in (${EMAIL_STEPS_SQL}))::int as sent,
              (select count(*) from public.lead_outreach where status = 'failed' and step in (${EMAIL_STEPS_SQL}))::int as failed,
              (select count(*) from public.lead_outreach where status = 'sending' and step in (${EMAIL_STEPS_SQL}) and (error is not null or created_at < now() - interval '10 minutes'))::int as unconfirmed,
              (select count(*) from public.clients where outreach_opt_out_at is not null)::int as opted_out,
              (select count(*) from public.lead_outreach where status = 'sent' and step in (${TEXT_STEPS_SQL}))::int as texts`))!;
    const lastRun = await db.row<{ at: string | null }>('select max(started_at) as at from public.job_runs');
    return { org, counts, sources, rows, total, emails, lastRun: lastRun?.at ?? null };
  });

  const settings = outreachSettings(org.settings);
  // A saved address that does not have the shape of a postal address reads as none (src/lib/mailing-address.ts). It is
  // still shown in the field, with what is wrong with it, so it can be corrected rather than typed again from nothing.
  const savedAddress = typeof org.settings.lead_mailing_address === 'string' ? org.settings.lead_mailing_address.trim() : '';
  const addressProblem = !settings.address && savedAddress ? mailingAddressIssue(savedAddress) : null;
  const live = emailIsLive();
  const blocker = outreachBlocker(settings, live, org);
  // Text follow-up: its own switch, and only ever for a lead who ticked the text-message box on the form.
  const textsUsable = smsUsable();
  const textBlocker = leadTextBlocker(settings, textsUsable, org);
  const approval = outreachApproval(org);
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const formUrl = `${env.APP_URL}${leadFormPath(org.slug)}`;
  // The agency's published website (which carries the same enquiry form) is the first link to share when there is one.
  const siteUrl = parseSite(org.settings).published ? `${env.APP_URL}${sitePath(org.slug)}` : null;
  const href = (p: number) => `/app/leads?${new URLSearchParams({ ...(q ? { q } : {}), ...(p > 1 ? { page: String(p) } : {}) }).toString()}`;
  // A page past the end (the last lead on it was just converted or dismissed) goes to the last page that has leads.
  if (page > pages) redirect(href(pages));
  const canWrite = ctx.can('clients:write');
  // Why automatic email is not going out, in a few words (null when it is running).
  const notApproved = blocker === 'not_approved' && approval !== 'approved';
  const why = notApproved ? APPROVAL_NEEDED[approval]
    : !live ? 'Email is not connected, so nothing is being sent.'
    : blocker === 'no_address' ? (addressProblem ? `The saved mailing address cannot be used, so no email is sent. ${addressProblem}` : 'A postal address is required: no email is sent until you save one below.')
    : blocker === 'no_reply' ? 'A reply address is required: nothing is sent until you save one below.'
    : null;
  const now = new Date();

  if (org.mode !== 'agency') {
    return (
      <>
        <PageHeader title="Leads" />
        <Notice title="The enquiry form is for agency workspaces">This is a personal workspace, so it has no public enquiry form and no leads.</Notice>
      </>
    );
  }

  return (
    <>
      <PageHeader title="Leads" subtitle="People who asked you to contact them through your enquiry form. Follow-up only ever goes to people who asked to be contacted — no bought lists, no scraping. A text is only ever sent to someone who separately agreed to texts on the form." />

      <div className="grid grid-cols-2 gap-x-6 gap-y-6 lg:grid-cols-4">
        <Stat label="New this week" value={counts.new_week} sub="Enquiries received in the last 7 days" />
        <Stat label="Waiting for first contact" value={counts.waiting} tone={counts.waiting ? 'warn' : undefined} sub="Leads nobody on your team has contacted yet" />
        <Stat label="Contacted" value={counts.contacted} sub="Leads your team has messaged or logged a call with" />
        <Stat label="Became clients" value={counts.converted} sub="Enquiries that are now clients, all time" />
      </div>

      <div className="mt-8 grid gap-6 xl:grid-cols-2">
        <Section title={siteUrl ? 'Share your website' : 'Share your enquiry form'} hint={siteUrl ? 'Put the link in your bio, in ads or on a flyer. Enquiries from your site and from the form land here as leads with a follow-up task.' : 'Put the link in your bio, on your website, in ads or on a flyer. Each enquiry lands here as a lead with a follow-up task.'}
          actions={!siteUrl && ctx.can('settings:manage') ? <Link href="/app/website" className="btn-ghost btn-sm">Set up your website</Link> : undefined}>
          {siteUrl && (
            <div className="mb-5 border-b border-line pb-5">
              <ShareLink url={siteUrl}><CopyButton value={siteUrl} label="Copy website link" /><a className="btn-ghost btn-sm" href={sitePath(org.slug)} target="_blank" rel="noopener">View your site</a></ShareLink>
            </div>
          )}
          <ShareLink title={siteUrl ? 'Enquiry form only' : undefined} url={formUrl}><CopyButton value={formUrl} label="Copy link" /><a className="btn-ghost btn-sm" href={leadFormPath(org.slug)} target="_blank" rel="noopener">Preview</a></ShareLink>
          <div className="mt-5 border-t border-line pt-4">
            <div className="text-sm font-semibold">Tagged links</div>
            <p className="mt-0.5 text-[0.8125rem] text-muted">Use a different link in each place and the lead’s source shows where they found you.</p>
            <ul className="mt-3 space-y-2">
              {LEAD_SOURCE_TAGS.map((tag) => (
                <li key={tag} className="flex items-center justify-between gap-3">
                  <code className="min-w-0 truncate text-xs text-muted">{leadFormPath(org.slug, tag)}</code>
                  <CopyButton value={`${env.APP_URL}${leadFormPath(org.slug, tag)}`} label={`Copy ${tag} link`} />
                </li>
              ))}
            </ul>
          </div>
          <div className="mt-5 border-t border-line pt-4">
            <div className="text-sm font-semibold">Where enquiries came from</div>
            {sources.length === 0 ? <p className="mt-1 text-sm text-muted">No enquiries yet.</p> : (
              <ul className="mt-2 divide-y divide-line/70 text-sm">
                {sources.map((s) => (
                  <li key={s.source ?? ''} className="flex items-center justify-between gap-3 py-1.5">
                    <span className="truncate">{sourceLabel(s.source)}</span>
                    <span className="shrink-0 tabular-nums text-muted">{s.n} {s.n === 1 ? 'enquiry' : 'enquiries'} · {s.converted} became {s.converted === 1 ? 'a client' : 'clients'}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Section>

        <Section id="follow-up" title="Automatic follow-up email" hint="A welcome email right after an enquiry, a follow-up after 2 days and a last note after 6 days.">
          {/* One line says whether it is running and, if not, the one thing in the way. The rest is behind "How it works". */}
          <p className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 text-sm">
            <Badge tone={blocker ? (settings.enabled ? 'warn' : 'neutral') : 'ok'} dot>{blocker ? (settings.enabled ? 'On, but not sending' : 'Off') : 'On and sending'}</Badge>
            {why && <span>{why}{!live && !notApproved && <> <Link href="/app/settings#integrations" className="link">See Settings → Integrations</Link></>}</span>}
          </p>
          <p className="mt-2 text-[0.8125rem] text-muted">{emails.sent} sent · {emails.failed} failed{emails.unconfirmed ? ` · ${emails.unconfirmed} not confirmed` : ''} · {emails.opted_out} opted out</p>
          <p className="mt-2 text-[0.8125rem] text-muted">Only people who sent your form and ticked “you may contact me” get these. Every email carries an opt-out link and your mailing address, and never promises a result.</p>
          <p className="mt-2 text-[0.8125rem] text-muted">
            Text follow-up: {!settings.texts ? 'off.'
              : textBlocker === 'not_approved' && approval !== 'approved' ? `on, but not running. ${APPROVAL_NEEDED[approval]} The text box is not shown on your form.`
              : textBlocker === 'name_link' ? 'on, but not running: your business name contains a web address, and the name starts every text. Change it in Settings.'
              : textBlocker === 'sms_not_connected' ? 'on, but text messaging is not connected, so the text box is not shown on your form and nothing is texted.'
              : textBlocker ? 'on, and starts when follow-up above is running.' : `on · ${emails.texts} sent. Texts go to US mobile numbers only, between 9 a.m. and 8 p.m. where the person is.`}
            {settings.texts && !textsUsable && ctx.can('settings:manage') && <> <Link href="/app/setup" className="link">Get set up</Link></>}
          </p>
          <details className="group mt-3">
            <summary className="flex w-fit cursor-pointer list-none items-center gap-1 rounded-md text-[0.8125rem] font-semibold text-brand-strong [&::-webkit-details-marker]:hidden">How it works <ChevronDown size={15} aria-hidden className="transition-transform group-open:rotate-180" /></summary>
            <div className="mt-2.5 space-y-2.5 text-[0.8125rem] leading-relaxed text-muted">
              <p>It covers enquiries received after you switch it on, and it starts once the platform operator has approved this workspace: your business name is the sender of every email. Nobody approves each message: once it is running, the welcome goes out right after the enquiry and the scheduled runs send the rest. It stops when your team messages the lead or logs a call, when you mark that they replied or asked to stop, when they become a client, or when they use the opt-out link. The wording is fixed, in English and Spanish.</p>
              <p><strong className="font-semibold text-ink">Texts need their own consent.</strong> With text follow-up on, your form shows a second, unticked box for text messages. Only a person who ticks it gets a welcome text and one follow-up text {LEAD_TEXT_STEPS[1].afterDays} days later, at the number they entered; everyone else gets email only. Texts wait through the night, a reply of STOP ends them for good, and a reply by text appears on the lead’s Messages tab.</p>
              <p><strong className="font-semibold text-ink">Replies are not read automatically.</strong> An answer goes to your reply address below — this system does not see it. Use “They replied” on the lead (or “Asked to stop”) so no further automatic email goes out.</p>
              <p>{lastRun ? `Scheduled jobs last ran ${relTime(lastRun)}.` : 'Scheduled jobs have not run yet in this workspace; the follow-up and the last note are sent by the scheduled job (see Automations).'}</p>
            </div>
          </details>
          {ctx.can('settings:manage') ? (
            <ActionForm action={saveLeadFollowUpAction} className="mt-4 space-y-4 border-t border-line pt-4">
              <Check name="enabled" defaultChecked={settings.enabled}>Send automatic follow-up email to new enquiries</Check>
              <Check name="texts" defaultChecked={settings.texts}>Also text people who separately agree to text messages on the form{textsUsable ? '' : ' (text messaging is not connected yet, so nothing is texted and the box is not shown)'}</Check>
              <Field label="Mailing address shown in every email" name="address" maxLength={MAILING_ADDRESS_MAX} defaultValue={settings.address || savedAddress} placeholder="Street, city, state, ZIP" hint="A physical postal address is required in marketing email (CAN-SPAM). Enter yours on one line, from the street number or PO Box to the state and ZIP code." />
              <Field label="Reply email address" name="replyTo" type="email" maxLength={254} defaultValue={settings.replyTo} placeholder="you@yourbusiness.com" hint="When someone answers an automatic email, the reply goes here." />
              <SubmitButton>Save</SubmitButton>
            </ActionForm>
          ) : <p className="mt-4 border-t border-line pt-4 text-xs text-muted">An owner or admin can switch this on or off.</p>}
        </Section>
      </div>

      <Section plain className="mt-8" title="Leads" hint={total ? `${total} ${q ? 'matching' : 'open'} ${total === 1 ? 'lead' : 'leads'}${pages > 1 ? `, ${PAGE_SIZE} per page` : ''}` : undefined}
        actions={(
          <form method="get" className="flex flex-wrap items-center gap-2" role="search">
            <div className="relative min-w-[11rem] flex-1">
              <Search size={16} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-faint" aria-hidden />
              <input name="q" defaultValue={q} placeholder="Search by name" className="field pl-10" aria-label="Search leads by name" />
            </div>
            <button className="btn-secondary" type="submit">Search</button>
            {q && <Link href="/app/leads" className="btn-ghost">Clear</Link>}
          </form>
        )}>
        {rows.length === 0 ? (
          q ? <EmptyState title="No leads match that name" body="Try a different search or clear it." /> : (
            <EmptyState icon={<UserPlus size={20} />} title="No open leads yet"
              body="Copy your enquiry form link above and put it where people find you: your Instagram or TikTok bio, your Facebook page, your website, a flyer. When someone fills it in, they appear here and your team gets a task to contact them."
              action={<CopyButton value={formUrl} label="Copy enquiry form link" />} />
          )
        ) : (
          <div className="table-wrap">
            <table className="table table-stack">
              <thead><tr><th>Name</th><th>Goal</th><th>Source</th><th>Received</th><th>Last contact</th><th>Follow-up</th><th><span className="sr-only">Actions</span></th></tr></thead>
              <tbody>
                {rows.map((l) => {
                  const f = followUp(decideLeadStep(leadState(l, settings.since), now), !blocker, l.outreach.filter((o) => o.status === 'sent').length, l.opt_out_reason);
                  // A line about texts only for a lead who agreed to them on the form, from the same rule the job uses.
                  const textsSent = l.texts.filter((t) => t.status === 'sent').length;
                  const td = l.text_consent_phone || l.texts.length ? decideLeadText(leadTextState(l, settings.since), now) : null;
                  const textLine = !td ? null
                    : td.kind === 'stop' && td.reason === 'failed' ? 'A text was not delivered'
                    : td.kind === 'stop' && td.reason === 'unconfirmed' ? 'A text was not confirmed as sent'
                    : `Texts: ${textsSent} of ${LEAD_TEXT_STEPS.length} sent${td.kind === 'stop' ? '' : textBlocker ? ', not running' : td.kind === 'wait' ? `, next due ${fmtDate(td.dueAt)}` : ', next goes out at the next run'}`;
                  return (
                    <tr key={l.id}>
                      <td className="cell-main">
                        <Link href={`/app/clients/${l.id}`} className="font-semibold hover:underline">{l.full_name}</Link>
                        <span className="block truncate text-xs text-muted">{l.email ?? 'No email address'}</span>
                      </td>
                      <td className={goalOf(l.goals) ? 'text-muted' : 'cell-none text-muted'} data-label="Goal">{goalOf(l.goals) ?? <span className="text-faint">—</span>}</td>
                      <td className="text-muted" data-label="Source">{sourceLabel(l.source)}</td>
                      <td className="whitespace-nowrap text-muted" data-label="Received">{relTime(l.created_at)}</td>
                      <td className="whitespace-nowrap text-muted" data-label="Last contact">{l.last_contact ? <>{relTime(l.last_contact)}{l.last_contact_auto && <span className="block text-xs">{l.last_contact_channel === 'sms' ? 'automatic text' : 'automatic email'}</span>}</> : <span className="text-faint">Not yet</span>}</td>
                      <td className={`cell-full text-xs sm:max-w-[12rem] ${f.tone === 'bad' ? 'text-bad' : f.tone === 'warn' ? 'text-warn' : f.tone === 'ok' ? 'text-ok' : 'text-muted'}`}>{f.text}{textLine && <span className="mt-0.5 block text-muted">{textLine}</span>}</td>
                      <td className="cell-full sm:min-w-[15rem]">
                        <div className="flex flex-wrap gap-1.5 sm:justify-end">
                          <Link href={`/app/clients/${l.id}`} className="btn-secondary btn-sm">Open</Link>
                          {canWrite && (
                            <>
                              {!l.replied && <form action={leadRepliedAction}><input type="hidden" name="id" value={l.id} /><button type="submit" className="btn-secondary btn-sm" title="Records that they answered, and stops automatic email to them">They replied</button></form>}
                              {!l.opted_out && l.has_email && <form action={leadAskedToStopAction}><input type="hidden" name="id" value={l.id} /><ConfirmButton className="btn-ghost btn-sm" message={`Record that ${l.full_name} asked not to be contacted automatically? They get no more automatic follow-up email, and no text now or as a client: their agreement to text messages is withdrawn, and only they can give it again, in the portal. This cannot be switched back on from here.`}>Asked to stop</ConfirmButton></form>}
                              <form action={setLeadStatusAction}><input type="hidden" name="id" value={l.id} /><input type="hidden" name="status" value="onboarding" /><button type="submit" className="btn-secondary btn-sm">Convert to client</button></form>
                              <form action={setLeadStatusAction}><input type="hidden" name="id" value={l.id} /><input type="hidden" name="status" value="cancelled" /><ConfirmButton className="btn-ghost btn-sm" message={`Mark ${l.full_name} as not interested? They leave this list and get no more automatic email. You can still find them in Clients.`}>Mark not interested</ConfirmButton></form>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <Pagination page={page} pages={pages} hrefFor={href} />
      </Section>
    </>
  );
}
