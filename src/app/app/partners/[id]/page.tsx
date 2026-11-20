import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { ArrowLeft, Mail, MapPin, Phone } from 'lucide-react';
import { ActionForm, ConfirmButton, Field, Select, SubmitButton } from '@/components/forms';
import { Badge, DefinitionList, Section, StatusBadge } from '@/components/ui';
import { publicSiteBySlug, siteHome } from '@/lib/agency-site';
import { requireStaff } from '@/lib/auth/context';
import { emailIsLive } from '@/lib/lead-outreach';
import { APPROVAL_COLS, type ApprovalRow } from '@/lib/outreach-approval';
import {
  decidePartnerStep, isPartnerCategory, PARTNER_CATEGORIES, PARTNER_CATEGORY_LABEL, PARTNER_MAX_ATTEMPTS, PARTNER_STATUS_LABEL, PARTNER_STEPS, partnerEmail,
  type PartnerStatus,
} from '@/lib/partner-emails';
import { PARTNER_GUARD_REFUSAL, partnerBlocker, partnerBounceHealth, partnerFailureHold, partnerSettings, partnerState, partnerTimezone } from '@/lib/partner-outreach';
import { dayInZone, fmtDate, isUuid, relTime } from '@/lib/util';
import { markPartnerAction, partnerAskedToStopAction, pausePartnerAction, removePartnerAction, retryPartnerAction, updatePartnerAction } from '../actions';
import { PARTNER_STATUS_TONE, sequenceLine } from '../sequence';

export const metadata: Metadata = { title: 'Partner' };
const CATEGORY_OPTIONS = PARTNER_CATEGORIES.map((value) => ({ value, label: PARTNER_CATEGORY_LABEL[value] }));
/** An email is shown to staff with its opt-out link blanked, so nobody opens a partner's own link from here. */
const forReading = (text: string) => text.replace(/(\/unsubscribe\/partner\/)[\w-]+/g, '$1(this partner’s own link)');

export default async function PartnerPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const ctx = await requireStaff('clients:read');
  const data = await ctx.tx(async (db) => {
    const p = await db.row<{
      id: string; business_name: string; contact_name: string | null; category: string; email: string; phone: string | null; city: string | null; state: string | null; language: 'en' | 'es';
      source_note: string | null; status: PartnerStatus; paused: boolean; opted_out_at: string | null; created_at: string; attested_at: string; attested_name: string | null;
    }>(
      `select p.id, p.business_name, p.contact_name, p.category, p.email, p.phone, p.city, p.state, p.language, p.source_note, p.status, (p.paused_at is not null) as paused,
              p.opted_out_at, p.created_at, p.attested_at, u.full_name as attested_name
         from public.partners p left join public.users u on u.id = p.attested_by where p.id = $1`, [id]);
    if (!p) return null;
    const org = (await db.row<ApprovalRow & { slug: string; settings: Record<string, unknown> }>(`select ${APPROVAL_COLS}, slug, settings from public.organizations where id = $1`, [ctx.orgId]))!;
    return {
      p,
      org,
      sends: await db.rows<{ step: string; status: string; attempts: number; subject: string | null; body: string | null; error: string | null; at: string }>(
        'select step, status, attempts, subject, body, error, coalesce(sent_at, claimed_at) as at from public.partner_outreach where partner_id = $1 order by created_at', [id]),
      events: await db.rows<{ id: string; summary: string; created_at: string; actor: string | null }>(
        'select e.id, e.summary, e.created_at, u.full_name as actor from public.partner_events e left join public.users u on u.id = e.actor_id where e.partner_id = $1 order by e.created_at desc limit 100', [id]),
      referred: await db.rows<{ id: string; full_name: string; status: string }>(
        'select c.id, c.full_name, c.status from public.partner_referrals r join public.clients c on c.id = r.client_id where r.partner_id = $1 order by r.created_at desc limit 100', [id]),
      hold: (await partnerFailureHold(db, ctx.orgId)) ?? ((await partnerBounceHealth(db, ctx.orgId, org.outreach_approved_at)).hold ? 'bounces' : null),
    };
  });
  if (!data) notFound();
  const { p, org, sends, events, referred, hold } = data;

  const settings = partnerSettings(org.settings);
  const tz = partnerTimezone(org.settings);
  const today = dayInZone(tz, new Date());
  const decision = decidePartnerStep(partnerState({ status: p.status, paused: p.paused, opted_out: !!p.opted_out_at, outreach: sends.map((s) => ({ step: s.step, status: s.status, attempts: s.attempts, at: s.at })) }, tz), today);
  // The agency's published website is linked from the emails, so its address is part of the next one and of the check on the wording.
  const nextStep = decision.kind === 'stop' ? null : decision.step;
  const site = nextStep ? await publicSiteBySlug(org.slug) : null;
  const siteUrl = site ? siteHome(site) : null;
  // Not sending: the sequence is off or missing something, or it is holding (the email service refused messages, or too many addresses bounced).
  const blocker = partnerBlocker(settings, emailIsLive(), org, siteUrl) ?? (hold ? 'holding' : null);
  const sentCount = sends.filter((s) => s.status === 'sent').length;
  const line = sequenceLine(decision, !blocker, sentCount);
  const canWrite = ctx.can('clients:write');
  // The email stop is the opt-out stamp. The status may say something else since (they replied, are interested).
  const optedOut = !!p.opted_out_at;
  const category = isPartnerCategory(p.category) ? p.category : 'other';
  const place = [p.city, p.state].filter(Boolean).join(', ');
  const canRetry = sends.some((s) => s.status === 'failed' && s.attempts < PARTNER_MAX_ATTEMPTS);
  const canRemove = p.status === 'new' && sends.length === 0 && referred.length === 0;
  // The next email exactly as the standard wording would send it for this partner, with the opt-out link blanked.
  const preview = nextStep ? partnerEmail(nextStep, p.language, {
    contactName: p.contact_name, category, city: p.city, state: p.state, orgName: org.name, address: settings.address || '(your mailing address)',
    optOutUrl: '(this partner’s own opt-out link)', siteUrl,
  }) : null;

  const mark = (value: string, label: string, title: string) => p.status !== value && (
    <form action={markPartnerAction}><input type="hidden" name="id" value={id} /><input type="hidden" name="mark" value={value} /><button type="submit" className="btn-secondary btn-sm" title={title}>{label}</button></form>
  );

  return (
    <>
      <header className="mb-6">
        <Link href="/app/partners" className="mb-3 inline-flex items-center gap-1 text-[0.8125rem] font-medium text-muted hover:text-ink"><ArrowLeft size={14} aria-hidden /> Partners</Link>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <h1 className="display text-[1.75rem] [overflow-wrap:anywhere] sm:text-[2rem]">{p.business_name}</h1>
          <Badge tone={PARTNER_STATUS_TONE[p.status] ?? 'neutral'} dot>{PARTNER_STATUS_LABEL[p.status] ?? p.status}{p.paused ? ' · paused' : ''}</Badge>
          {optedOut && p.status !== 'opted_out' && <Badge tone="warn">Opted out of email</Badge>}
        </div>
        <p className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted">
          <span>{[p.contact_name, PARTNER_CATEGORY_LABEL[category]].filter(Boolean).join(' · ')}</span>
          <span className="flex min-w-0 items-center gap-1.5"><Mail size={14} aria-hidden className="shrink-0" /><span className="[overflow-wrap:anywhere]">{p.email}</span></span>
          {p.phone && <span className="flex items-center gap-1.5" title="Kept for your reference. Never texted or called by this system."><Phone size={14} aria-hidden className="shrink-0" />{p.phone}</span>}
          {place && <span className="flex items-center gap-1.5"><MapPin size={14} aria-hidden className="shrink-0" />{place}</span>}
        </p>
      </header>

      <div className="grid gap-x-8 gap-y-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Section title="Email sequence" hint={<span className={line.tone === 'bad' ? 'text-bad' : line.tone === 'warn' ? 'text-warn' : line.tone === 'ok' ? 'text-ok' : undefined}>{line.text}</span>}>
            <ol className="divide-y divide-line/70">
              {PARTNER_STEPS.map((st) => {
                const s = sends.find((x) => x.step === st.key);
                const isNext = nextStep === st.key;
                return (
                  <li key={st.key} className="py-3 first:pt-0 last:pb-0">
                    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-sm">
                      <span className="font-medium">{st.label}</span>
                      <span className="text-[0.8125rem] text-muted">
                        {s?.status === 'sent' ? `Sent ${fmtDate(s.at)}`
                          : s?.status === 'failed' ? <span className="text-bad">Not sent</span>
                          : s?.status === 'sending' ? <span className="text-bad">Not confirmed as sent</span>
                          : s?.status === 'retry' ? 'Another try goes out with the next scheduled run'
                          : isNext && decision.kind === 'wait' ? `Due ${fmtDate(decision.dueOn)}`
                          : isNext && decision.kind === 'send' ? (blocker ? 'Due, but the sequence is not running' : 'Goes out with the next scheduled run')
                          : decision.kind === 'stop' ? (decision.reason === 'paused' ? 'Paused' : 'Not sent') : 'Not yet due'}
                      </span>
                    </div>
                    {s?.status === 'failed' && (s.error?.startsWith(PARTNER_GUARD_REFUSAL)
                      ? <p className="mt-1 text-[0.8125rem] text-bad [overflow-wrap:anywhere]">This app did not send it, and the email service was never asked: {s.error}. Something on this record reads as a claim. Check the city and the contact name under “Edit details”, then ask for another try. Nothing further is sent to this partner until then.</p>
                      : <p className="mt-1 text-[0.8125rem] text-bad [overflow-wrap:anywhere]">The email service did not accept it: {s.error ?? 'no reason given'}. Nothing further is sent to this partner until you ask for another try.</p>)}
                    {s?.status === 'sending' && <p className="mt-1 text-[0.8125rem] text-muted [overflow-wrap:anywhere]">It was handed to the email service, and it is not known whether the service accepted it{s.error ? ` (${s.error})` : ''}. It may or may not have arrived, so it is not sent again. Contact this partner yourself.</p>}
                    {s?.body && (
                      <details className="mt-1.5">
                        <summary className="link cursor-pointer text-[0.8125rem]">{s.status === 'sent' ? 'Read the email as it was sent' : 'Read the email'}</summary>
                        <div className="mt-2 rounded-xl bg-raised p-3.5 text-[0.8125rem] leading-relaxed">
                          <p className="font-semibold">Subject: {s.subject}</p>
                          <p className="mt-2 whitespace-pre-wrap [overflow-wrap:anywhere]">{forReading(s.body)}</p>
                        </div>
                      </details>
                    )}
                    {!s && isNext && preview && (
                      <details className="mt-1.5">
                        <summary className="link cursor-pointer text-[0.8125rem]">Preview the standard wording</summary>
                        <div className="mt-2 rounded-xl bg-raised p-3.5 text-[0.8125rem] leading-relaxed">
                          <p className="font-semibold">Subject: {preview.subject}</p>
                          <p className="mt-2 whitespace-pre-wrap [overflow-wrap:anywhere]">{preview.text}</p>
                        </div>
                      </details>
                    )}
                  </li>
                );
              })}
            </ol>
            {canWrite && canRetry && (
              <form action={retryPartnerAction} className="mt-4 border-t border-line pt-4">
                <input type="hidden" name="id" value={id} />
                <ConfirmButton className="btn-secondary btn-sm" message="Try the email that was not sent again? Do this only when the reason above has been fixed, for example your sending domain is now verified.">Try again</ConfirmButton>
              </form>
            )}
          </Section>

          <Section plain title="Timeline">
            {events.length === 0 ? <p className="text-sm text-muted">Nothing yet.</p> : (
              <ol className="space-y-3">{events.map((e) => (
                <li key={e.id} className="flex gap-3 text-sm"><span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-line-strong" aria-hidden /><div className="min-w-0"><div className="[overflow-wrap:anywhere]">{e.summary}</div><div className="text-xs text-muted">{e.actor ?? 'System'} · {relTime(e.created_at)}</div></div></li>))}
              </ol>
            )}
          </Section>
        </div>

        <div className="space-y-6">
          <Section title="Record what happened" hint="Replies and bounce notices arrive outside this system, so they are recorded here by you.">
            {optedOut ? (
              <>
                <p className="text-sm text-muted">This partner opted out of the emails on {fmtDate(p.opted_out_at)}. The address is never emailed again, and this cannot be changed.</p>
                {canWrite && (
                  <>
                    <p className="mt-3 text-[0.8125rem] leading-relaxed text-muted">They can still write or call you. If they do, record it here: it sends nothing and does not lift the email stop.</p>
                    <div className="mt-3 flex flex-wrap gap-2">
                      {mark('replied', 'They replied', 'Records that they answered. No email is sent')}
                      {mark('interested', 'Interested', 'Records that they want to refer clients. No email is sent')}
                      {mark('not_interested', 'Not interested', 'Records that they declined. No email is sent')}
                    </div>
                  </>
                )}
              </>
            ) : !canWrite ? <p className="text-sm text-muted">Your role can view partners but not change them.</p> : (
              <>
                <p className="text-[0.8125rem] leading-relaxed text-muted">A partner’s answer goes to your reply address ({settings.replyTo || 'none saved yet'}). This system cannot read that mailbox. Each button below stops the automatic emails to this partner.</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {mark('replied', 'They replied', 'Records that they answered, and stops the automatic emails')}
                  {mark('interested', 'Interested', 'Records that they want to refer clients, and stops the automatic emails')}
                  {mark('not_interested', 'Not interested', 'Records that they declined, and stops the automatic emails')}
                  {mark('bounced', 'Bounced', 'Records that an email to this address came back undelivered, and stops the automatic emails')}
                </div>
                <div className="mt-4 flex flex-wrap gap-2 border-t border-line pt-4">
                  {(p.status === 'new' || p.status === 'in_sequence' || p.paused) && (
                    <form action={pausePartnerAction}><input type="hidden" name="id" value={id} /><input type="hidden" name="paused" value={p.paused ? '0' : '1'} /><button type="submit" className="btn-ghost btn-sm">{p.paused ? 'Resume the sequence' : 'Pause the sequence'}</button></form>
                  )}
                  <form action={partnerAskedToStopAction}><input type="hidden" name="id" value={id} /><ConfirmButton className="btn-ghost btn-sm" message={`Record that ${p.business_name} asked not to be emailed? This address is never emailed again, and this cannot be undone.`}>Asked to stop</ConfirmButton></form>
                  {canRemove && <form action={removePartnerAction}><input type="hidden" name="id" value={id} /><ConfirmButton className="btn-ghost btn-sm" message={`Remove ${p.business_name} from your list? Nothing was sent to them.`}>Remove</ConfirmButton></form>}
                </div>
                <p className="mt-3 text-xs text-muted">This system only emails partners. It never texts or calls them; phone them yourself if you wish.</p>
              </>
            )}
          </Section>

          <Section plain title="Details">
            <DefinitionList items={[
              ['Contact', p.contact_name], ['Category', PARTNER_CATEGORY_LABEL[category]], ['Business email', p.email], ['Business phone', p.phone ? `${p.phone} (for your reference only)` : null],
              ['Place', place || null], ['Email language', p.language === 'es' ? 'Español' : 'English'], ['Where the contact came from', p.source_note],
              ['Added', `${fmtDate(p.created_at)}${p.attested_name ? ` by ${p.attested_name}` : ''}`],
            ]} />
            <p className="mt-3 text-xs text-muted">{p.attested_name ?? 'The person who added it'} confirmed on {fmtDate(p.attested_at)} that this is a public business contact or one of your own contacts.</p>
            {canWrite && !optedOut && (
              <details className="mt-4">
                <summary className="link cursor-pointer text-sm">Edit details</summary>
                <ActionForm action={updatePartnerAction} className="mt-3 space-y-3">
                  <input type="hidden" name="id" value={id} />
                  <Field label="Business name" name="businessName" required maxLength={160} defaultValue={p.business_name} />
                  <Field label="Contact name" name="contactName" maxLength={120} defaultValue={p.contact_name} />
                  <Select label="Category" name="category" required defaultValue={category} options={CATEGORY_OPTIONS} />
                  <div className="grid grid-cols-[1fr_5.5rem] gap-3"><Field label="City" name="city" maxLength={40} defaultValue={p.city} /><Field label="State" name="state" maxLength={2} defaultValue={p.state} /></div>
                  <Field label="Business phone" name="phone" type="tel" maxLength={30} defaultValue={p.phone} hint="For your own reference. Never texted or called by this system." />
                  <Select label="Language of the emails" name="language" defaultValue={p.language} options={[{ value: 'en', label: 'English' }, { value: 'es', label: 'Español' }]} />
                  <Field label="Where this contact came from" name="sourceNote" maxLength={300} defaultValue={p.source_note} />
                  <SubmitButton variant="secondary">Save</SubmitButton>
                  <p className="text-xs text-muted">The email address cannot be changed: add a new partner for a different address.</p>
                </ActionForm>
              </details>
            )}
          </Section>

          <Section plain title="Clients referred" hint={`${referred.length} linked to this partner. Set it on a client’s page, under “Referred by”.`}>
            {referred.length === 0 ? <p className="text-sm text-muted">None yet.</p> : (
              <ul className="space-y-2 text-sm">{referred.map((c) => (
                <li key={c.id} className="flex items-center justify-between gap-3"><Link href={`/app/clients/${c.id}`} className="min-w-0 truncate font-medium hover:underline">{c.full_name}</Link><StatusBadge status={c.status} /></li>))}
              </ul>
            )}
          </Section>
        </div>
      </div>
    </>
  );
}
