import Link from 'next/link';
import { ActionForm, Select, SubmitButton } from '@/components/forms';
import { CopyButton } from '@/components/shell-client';
import { Badge, Section, type Tone } from '@/components/ui';
import type { Ctx } from '@/lib/auth/context';
import { DAILY_CAP, orgTimezone, UPDATE_EVENT_LABEL, UPDATE_EVENTS, updateSettings, US_ZONES, type UpdateChannel, type UpdateEvent } from '@/lib/client-updates/templates';
import { getEnv } from '@/lib/env';
import { emailIsLive } from '@/lib/lead-outreach';
import { smsStatus, twilioWebhookUrl } from '@/lib/sms';
import { relTime } from '@/lib/util';
import { reviewInboundSmsAction, saveClientUpdatesAction } from './client-updates-actions';

interface ChannelView { label: string; badge: string; tone: Tone; usable: boolean; note: string }

/** What the configuration really allows, in words: connected, not connected (and what is missing), a test stand-in, or off. */
function channelViews(): Record<UpdateChannel, ChannelView> {
  const env = getEnv();
  const sms = smsStatus();
  const smsView: ChannelView = sms.state === 'connected' ? { label: 'Text messages', badge: 'Connected', tone: 'ok', usable: true, note: 'Sent through Twilio.' }
    : sms.state === 'test_only' ? { label: 'Text messages', badge: 'Test stand-in', tone: 'warn', usable: true, note: 'Texts are written to a local log. Nothing is delivered.' }
    : sms.state === 'needs_credentials' ? { label: 'Text messages', badge: 'Not connected', tone: 'warn', usable: false, note: `Still to set: ${sms.missing.join(', ')}.` }
    : { label: 'Text messages', badge: 'Not connected', tone: 'neutral', usable: false, note: 'No text message provider is set up (SMS_DRIVER=disabled). No text is ever sent.' };
  const emailView: ChannelView = emailIsLive() ? { label: 'Email', badge: 'Connected', tone: 'ok', usable: true, note: 'Sent through Resend.' }
    : env.EMAIL_DRIVER === 'log' ? { label: 'Email', badge: 'Test stand-in', tone: 'warn', usable: true, note: 'Emails are written to a local log. Nothing is delivered.' }
    : env.EMAIL_DRIVER === 'resend' ? { label: 'Email', badge: 'Not connected', tone: 'warn', usable: false, note: 'Still to set: RESEND_API_KEY.' }
    : { label: 'Email', badge: 'Not connected', tone: 'neutral', usable: false, note: 'Email is switched off (EMAIL_DRIVER=disabled). No email is ever sent.' };
  return { sms: smsView, email: emailView };
}

const EVENT_NAME = (e: string) => UPDATE_EVENT_LABEL[e as UpdateEvent]?.label ?? e;

/** Settings → Client updates: which short updates clients get by text and email. Everything is off until switched on. */
export async function ClientUpdatesSection({ ctx }: { ctx: Ctx }) {
  const env = getEnv();
  const ch = channelViews();
  const d = await ctx.tx(async (db) => ({
    org: await db.row<{ settings: Record<string, unknown> }>('select settings from public.organizations where id = $1', [ctx.orgId]),
    problems: await db.rows<{ id: string; client_id: string; full_name: string; event: string; channel: string; status: string; error: string | null; created_at: string }>(
      `select u.id, u.client_id, c.full_name, u.event, u.channel, u.status, u.error, u.created_at
         from public.client_updates u join public.clients c on c.id = u.client_id
        where (u.status in ('failed', 'skipped') or (u.status = 'sending' and u.sent_at < now() - interval '15 minutes'))
          and u.created_at > now() - interval '14 days' order by u.created_at desc limit 8`),
    unmatched: await db.rows<{ id: string; from_phone: string; body: string; created_at: string }>(
      "select id, from_phone, body, created_at from public.sms_inbound where client_id is null and reviewed_at is null and kind = 'message' order by created_at desc limit 8"),
  }));
  const s = updateSettings(d.org?.settings);
  const tz = orgTimezone(d.org?.settings, env.APP_TIMEZONE);
  const zones = US_ZONES.some((z) => z.value === tz) ? US_ZONES : [{ value: tz, label: tz }, ...US_ZONES];
  const box = 'h-4 w-4 rounded border-line-strong accent-[rgb(var(--brand))] disabled:cursor-not-allowed disabled:opacity-40';
  return (
    <Section id="updates" title="Client updates" className="mt-8"
      hint="Short messages that tell a client there is something new in their portal. All off until you switch them on. A text never names an account, an amount or a result.">
      <ul className="mb-5 space-y-2 text-sm">
        {(['sms', 'email'] as UpdateChannel[]).map((k) => (
          <li key={k} className="flex flex-wrap items-center gap-x-2.5 gap-y-1"><span className="font-medium">{ch[k].label}</span><Badge tone={ch[k].tone}>{ch[k].badge}</Badge><span className="text-muted">{ch[k].note}</span></li>
        ))}
      </ul>
      <ActionForm action={saveClientUpdatesAction}>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[26rem] text-sm">
            <thead><tr className="text-left text-xs text-muted"><th scope="col" className="pb-2 font-medium">Tell the client when</th><th scope="col" className="w-20 pb-2 text-center font-medium">Text</th><th scope="col" className="w-20 pb-2 text-center font-medium">Email</th></tr></thead>
            <tbody className="divide-y divide-line/70">
              {UPDATE_EVENTS.map((e) => (
                <tr key={e}>
                  <th scope="row" className="py-2.5 pr-3 text-left font-normal"><span className="font-medium">{UPDATE_EVENT_LABEL[e].label}</span><span className="block text-[0.8125rem] text-muted">{UPDATE_EVENT_LABEL[e].when}</span></th>
                  {(['sms', 'email'] as UpdateChannel[]).map((k) => (
                    <td key={k} className="py-2.5 text-center">
                      <input type="checkbox" name={`${e}.${k}`} defaultChecked={ch[k].usable && s.switches[e][k]} disabled={!ch[k].usable} className={box}
                        aria-label={`${UPDATE_EVENT_LABEL[e].label}: ${k === 'sms' ? 'text message' : 'email'}`} title={ch[k].usable ? undefined : `${ch[k].label}: ${ch[k].badge.toLowerCase()}. ${ch[k].note}`} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {(!ch.sms.usable || !ch.email.usable) && <p className="hint">{[!ch.sms.usable && 'Text', !ch.email.usable && 'Email'].filter(Boolean).join(' and ')} cannot be switched on until {!ch.sms.usable && !ch.email.usable ? 'they are' : 'it is'} connected. The setup steps are in docs/INTEGRATIONS.md.</p>}
        <Select className="mt-4 max-w-xs" label="Your time zone" name="timezone" defaultValue={tz} options={zones} hint="Texts are held outside 8 a.m. to 9 p.m. here and in the client’s own state." />
        <div className="mt-4"><SubmitButton>Save client updates</SubmitButton></div>
      </ActionForm>
      <p className="mt-4 text-[0.8125rem] text-muted">
        A text goes only to a client who agreed to texts (in their portal, or recorded by you on their profile), to the number they agreed for, between 8 a.m. and 9 p.m. in your time zone and in the client’s state (no state on file: 11 a.m. to 9 p.m. Eastern).
        At most {DAILY_CAP.sms} texts and {DAILY_CAP.email} emails per client a day. A reply with a stop word (stop, cancel, end, quit, unsubscribe, revoke, opt out) switches texts off at once, and only the client can switch them back on; any other reply pauses their texts until your team has read it. Only clients with a portal sign-in are told.
      </p>

      {env.SMS_DRIVER === 'twilio' && (
        <details className="mt-4">
          <summary className="link cursor-pointer text-sm">Twilio webhook address</summary>
          <p className="mt-2 text-sm text-muted">In Twilio, paste this as the “A message comes in” webhook (HTTP POST) of your number or Messaging Service. It is how a STOP reply and delivery reports reach this app.</p>
          <code className="mt-2 block break-all rounded-lg bg-raised px-3 py-2 text-xs">{twilioWebhookUrl()}</code>
          <div className="mt-2"><CopyButton value={twilioWebhookUrl()} label="Copy address" /></div>
        </details>
      )}

      {d.problems.length > 0 && (
        <details className="mt-4">
          <summary className="link cursor-pointer text-sm">Not sent or not confirmed in the last 14 days ({d.problems.length}{d.problems.length === 8 ? '+' : ''})</summary>
          <ul className="mt-2 divide-y divide-line/70 text-sm">
            {d.problems.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center gap-x-2.5 gap-y-1 py-2">
                <Badge tone={p.status === 'failed' ? 'bad' : p.status === 'sending' ? 'warn' : 'neutral'}>{p.status === 'failed' ? 'Failed' : p.status === 'sending' ? 'Not confirmed' : 'Skipped'}</Badge>
                <Link className="font-medium hover:underline" href={`/app/clients/${p.client_id}?tab=messages`}>{p.full_name}</Link>
                <span className="text-muted">{EVENT_NAME(p.event)} · {p.channel === 'sms' ? 'text' : 'email'} · {relTime(p.created_at)}</span>
                {(p.error || p.status === 'sending') && <span className="basis-full text-[0.8125rem] text-muted [overflow-wrap:anywhere]">{p.error ?? 'It was handed to the provider but the result was never recorded. It is not sent again automatically.'}</span>}
              </li>
            ))}
          </ul>
        </details>
      )}

      {d.unmatched.length > 0 && (
        <details className="mt-4" open>
          <summary className="link cursor-pointer text-sm">Texts we could not match to one client ({d.unmatched.length})</summary>
          <p className="mt-2 text-[0.8125rem] text-muted">The number is on no client record, or on more than one. Nothing was guessed. Find the right client and log the text on their Messages tab if it matters.</p>
          <ul className="mt-2 divide-y divide-line/70 text-sm">
            {d.unmatched.map((m) => (
              <li key={m.id} className="flex flex-wrap items-start justify-between gap-3 py-2">
                <div className="min-w-0"><span className="font-medium">{m.from_phone}</span> <span className="text-muted">· {relTime(m.created_at)}</span><p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{m.body}</p></div>
                <form action={reviewInboundSmsAction}><input type="hidden" name="id" value={m.id} /><button className="btn-ghost btn-sm" type="submit">Mark as reviewed</button></form>
              </li>
            ))}
          </ul>
        </details>
      )}
    </Section>
  );
}
