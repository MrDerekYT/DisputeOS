'use client';

import Link from 'next/link';
import { useActionState, useEffect, useRef, useState, type ReactNode } from 'react';
import { AlertCircle, AlertTriangle, CheckCircle2, Info } from 'lucide-react';
import { Field, restoreForm, Select, SubmitButton, type ActionState } from '@/components/forms';
import { CopyButton } from '@/components/shell-client';
import { quickAddClientAction } from '../quick-add-actions';

const TONES = {
  ok: { box: 'bg-ok-soft', icon: CheckCircle2, color: 'text-ok' },
  info: { box: 'bg-info-soft', icon: Info, color: 'text-info' },
  warn: { box: 'bg-warn-soft', icon: AlertTriangle, color: 'text-warn' },
  bad: { box: 'bg-bad-soft', icon: AlertCircle, color: 'text-bad' },
} as const;
/** How each outcome of quickAddClientAction is shown: green only when the email service took the welcome email. */
const OUTCOME_TONE: Record<string, keyof typeof TONES> = { sent: 'ok', link: 'info', email_failed: 'warn', unconfirmed: 'warn', added: 'warn' };
/** Outcomes whose message sends the person to the client's page for the welcome link: the link opens that card. */
const NEXT_ON_WELCOME_CARD = new Set(['unconfirmed', 'added', 'duplicate']);

/** Something the person should know before the button is pressed. */
function Note({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div role="note" className="mt-4 flex gap-3 rounded-xl bg-warn-soft px-4 py-3 text-sm">
      <AlertTriangle size={18} aria-hidden className="mt-0.5 shrink-0 text-warn" />
      <p className="min-w-0 text-ink/85"><span className="font-semibold text-ink">{title}</span> {children}</p>
    </div>
  );
}

/**
 * "Invite a client": first name, last name, email, an optional phone number and the client's language. One button
 * creates the client and sends the welcome email; everything that follows is shown here, on the same page, and the
 * form is empty again for the next client. `emailLive` is whether this deployment can really send email: when it
 * cannot, the page says so before the button is pressed, and the button says what it does instead. `terms` is whether
 * the agency's client agreement terms are ready: when they are not, a client can be invited but cannot sign the
 * service agreement yet, and the page says that before the button is pressed too.
 *
 * What the button did is brought into view: on a laptop the result is below the bottom of the screen otherwise, and
 * an emptied form looks the same whether the email went out or not.
 *
 * When the email did not go out, the one-time link is shown to copy (the same control the client page uses), with a
 * link that opens the staff member's own messaging app when a phone number was typed. When nothing was added (a
 * mistyped email, a client who is already here), what was typed is put back.
 */
export function QuickAdd({ emailLive, canSetUp, terms = 'ready' }: { emailLive: boolean; canSetUp: boolean; terms?: 'ready' | 'missing' | 'stale' }) {
  const [state, run] = useActionState(quickAddClientAction, undefined);
  const form = useRef<HTMLFormElement>(null);
  const last = useRef<FormData | null>(null);
  const result = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // React clears the form once the action finishes. That is right after a client was added; after a refusal the
    // person should not have to type it all again.
    if (form.current && last.current && state?.error) restoreForm(form.current, last.current);
    if (state) { result.current?.scrollIntoView({ block: 'start', behavior: 'smooth' }); result.current?.focus({ preventScroll: true }); }
  }, [state]);

  return (
    <section aria-labelledby="quick-add-title" className="card card-pad">
      <h2 id="quick-add-title" className="text-lg font-semibold leading-snug">Invite a client</h2>
      <p className="mt-1 text-sm text-muted">
        {emailLive
          ? 'Their name and email are all you need. They get a welcome email with a one-time link, set a password, and fill in their details, agreements and ID themselves.'
          : 'Their name and email are all you need. They use a one-time welcome link to set a password and fill in their details, agreements and ID themselves.'}
      </p>
      {!emailLive && (
        <Note title="Email is not connected yet.">
          No welcome email will be sent. The client is added, and you get the welcome link to send them yourself.
          {canSetUp ? <> To connect email, open <Link href="/app/setup" className="link">Get set up</Link>.</> : ' An owner or admin can connect it from Get set up.'}
        </Note>
      )}
      {terms !== 'ready' && (
        <Note title={terms === 'missing' ? 'Your client agreement terms are not saved yet.' : 'Your client agreement terms need a change.'}>
          {terms === 'missing'
            ? 'A client you invite now can fill in their details and upload their ID, but cannot sign the service agreement until the terms are saved.'
            : 'They no longer pass the checks. A client you invite now can fill in their details and upload their ID, but cannot sign the service agreement until the terms are changed.'}
          {canSetUp
            ? <> <Link href="/app/settings#agreement" className="link">Open Settings → Client agreement</Link></>
            : ` Ask an owner or admin to ${terms === 'missing' ? 'save' : 'change'} them in Settings → Client agreement.`}
        </Note>
      )}
      <form ref={form} action={run} className="mt-5" onSubmit={(e) => { last.current = new FormData(e.currentTarget); }}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="First name" name="firstName" required autoComplete="off" maxLength={79} />
          <Field label="Last name" name="lastName" required autoComplete="off" maxLength={79} />
          <Field label="Email" name="email" type="email" required autoComplete="off" maxLength={254} className="sm:col-span-2"
            hint={emailLive ? 'The welcome email goes here, and their portal account is made for it.' : 'Their portal account is made for this address.'} />
          <Field label="Phone" name="phone" type="tel" autoComplete="off" maxLength={30}
            hint={emailLive ? 'Optional.' : 'Optional. With it, you can text them the link from your phone.'} />
          <Select label="Language" name="preferredLanguage" defaultValue="en" options={[{ value: 'en', label: 'English' }, { value: 'es', label: 'Español' }]}
            hint={emailLive ? 'For the welcome email and their portal.' : 'For their welcome page and their portal.'} />
        </div>
        <div className="mt-6 flex justify-end">
          {emailLive
            ? <SubmitButton pendingText="Sending…">Send welcome email</SubmitButton>
            : <SubmitButton pendingText="Adding…">Add client and get the link</SubmitButton>}
        </div>
      </form>

      {/* Scrolled to when it changes: clear of the bar that stays at the top of the screen, with the card's edge under it. */}
      <div ref={result} id="quick-add-result" tabIndex={-1} aria-live="polite" className="scroll-mb-6 scroll-mt-24 empty:hidden"><QuickAddResult state={state} /></div>
    </section>
  );
}

/**
 * The text link for the device the page is open on. The action writes it the standard way, with the message after
 * "?body=", which Android reads. iPhone, iPad and Mac read the message after "&body=" instead.
 */
export const textHrefFor = (userAgent: string, href: string): string => (/iPhone|iPad|iPod|Macintosh/.test(userAgent) ? href.replace('?body=', '&body=') : href);

/**
 * "Text it from your phone". The device is only known in the browser, so the standard link is drawn first and the
 * separator is swapped once the page is running there.
 */
function TextLink({ href }: { href: string }) {
  const [userAgent, setUserAgent] = useState('');
  useEffect(() => { setUserAgent(navigator.userAgent); }, []);
  return <a href={textHrefFor(userAgent, href)} className="btn-secondary btn-sm">Text it from your phone</a>;
}

/** A button whose words hold a client's first name: a long name wraps inside the box instead of running out of it. */
const NAMED = 'btn-secondary btn-sm max-w-full whitespace-normal text-left [overflow-wrap:anywhere]';

/**
 * What the last press of the button did, in the words the action returned, with what to do next: the one-time link to
 * copy or text when the email did not go out, the client's page (opened at its Welcome link card when the message
 * sends the person there for the link), and (only when the link is passed on by hand) the place to enter the client's
 * details yourself.
 */
export function QuickAddResult({ state }: { state: ActionState }) {
  const message = state?.error ?? state?.ok;
  if (!message) return null;
  const data = state?.data ?? {};
  const tone = TONES[state?.error ? 'bad' : OUTCOME_TONE[data.outcome ?? ''] ?? 'info'];
  const Icon = tone.icon;
  return (
    <div role={state?.error ? 'alert' : undefined} className={`mt-5 rounded-xl px-4 py-3.5 text-sm ${tone.box}`}>
      <p className="flex items-start gap-2.5">
        <Icon size={17} aria-hidden className={`mt-0.5 shrink-0 ${tone.color}`} />
        <span className="min-w-0 text-ink [overflow-wrap:anywhere]">{message}</span>
      </p>
      {data.link && (
        <div className="mt-3 rounded-xl bg-surface p-3">
          <code className="block break-all text-xs">{data.link}</code>
          <div className="mt-2 flex flex-wrap gap-2">
            <CopyButton value={data.link} label="Copy link" />
            {data.sms && <TextLink href={data.sms} />}
          </div>
          {data.sms && <p className="mt-2 text-xs text-muted">“Text it from your phone” opens your texting app, so use it with this page open on your phone. On a computer, copy the link.</p>}
        </div>
      )}
      {data.clientId && (
        <div className="mt-3 flex flex-wrap gap-2">
          <Link href={`/app/clients/${data.clientId}${NEXT_ON_WELCOME_CARD.has(data.outcome ?? '') ? '#welcome' : ''}`} className={NAMED}>Open {data.first}’s page</Link>
          {data.link && <Link href={`/app/clients/${data.clientId}/edit`} className={NAMED}>Enter {data.first}’s details yourself</Link>}
        </div>
      )}
    </div>
  );
}
