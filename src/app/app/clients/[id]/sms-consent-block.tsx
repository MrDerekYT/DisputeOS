import { ActionForm, Check, ConfirmButton, SubmitButton, TextArea } from '@/components/forms';
import { Badge, Section } from '@/components/ui';
import type { Ctx } from '@/lib/auth/context';
import { pendingSmsReplies, smsConsentHistory, smsConsentText } from '@/lib/client-updates/service';
import { TEXTS_NEED_APPROVAL } from '@/lib/client-updates/templates';
import { APPROVAL_COLS, outreachApproval, type ApprovalRow } from '@/lib/outreach-approval';
import { smsUsable, toE164, toUsE164 } from '@/lib/sms';
import { fmtDate } from '@/lib/util';
import { recordSmsConsentAction, reviewSmsReplyAction, revokeSmsConsentAction } from '../sms-actions';

const ENDED: Record<string, string> = { portal: 'turned off by the client in the portal', staff: 'turned off by staff', sms_stop: 'the client replied STOP', asked_to_stop: 'the client asked the team to stop' };

/**
 * Whether this client has agreed to text messages, how, and for which number. Without a consent in force no text is
 * ever sent to them. A consent given in the portal is the client's own act; one recorded here is labelled as recorded
 * by staff and carries the note saying how and when the client agreed.
 *
 * A consent alone does not send a text. The number has to be a US one, and the platform operator has to have approved
 * the workspace for text messages (src/lib/outreach-approval.ts). When either is what holds texts back, it says so here.
 */
export async function SmsConsentBlock({ ctx, clientId, phone, lang }: { ctx: Ctx; clientId: string; phone: string | null; lang: 'en' | 'es' }) {
  const e164 = toE164(phone);
  // Texts go to US numbers only, so a consent can only be recorded for one.
  const usNumber = toUsE164(phone);
  const { history, stopped, replies, org } = await ctx.tx(async (db) => ({
    history: await smsConsentHistory(db, clientId),
    // A STOP can only be undone by the client: no staff form is offered over one (the database refuses it as well).
    stopped: e164 ? !!(await db.row<{ blocked: boolean }>('select app.sms_stop_blocks_staff($1, $2) as blocked', [clientId, e164]))?.blocked : false,
    replies: await pendingSmsReplies(db, clientId),
    org: await db.row<ApprovalRow>(`select ${APPROVAL_COLS} from public.organizations where id = $1`, [ctx.orgId]),
  }));
  const orgName = ctx.session.orgName;
  const active = history.find((h) => !h.revoked_at);
  const last = history[0];
  const mismatch = !!active && e164 !== active.phone;
  const notUs = !!active && !mismatch && !toUsE164(active.phone);
  // Said only where a text service is connected: with none, that is the reason no text goes out (Settings says so).
  const approval = outreachApproval(org);
  const unapproved = smsUsable() && approval !== 'approved' ? TEXTS_NEED_APPROVAL[approval] : null;
  const paused = mismatch || notUs || !!unapproved;
  return (
    <Section plain id="sms-consent" title="Text message consent" hint="No consent on file means no text is ever sent to this client.">
      <div className="flex flex-wrap items-start justify-between gap-3 text-sm">
        <div className="min-w-0">
          {active ? (
            <>
              <div className="flex flex-wrap items-center gap-2"><Badge tone={paused ? 'warn' : 'ok'}>{paused ? 'Paused' : 'On'}</Badge><Badge>{active.source === 'portal' ? 'Given by the client in the portal' : active.source === 'enquiry_form' ? 'Given on the enquiry form' : 'Recorded by staff'}</Badge></div>
              <p className="mt-1.5 text-muted">{fmtDate(active.granted_at)} · for {active.phone}</p>
              {active.note && <p className="mt-1 [overflow-wrap:anywhere]"><span className="font-medium">Staff note: </span>{active.note}</p>}
              {mismatch && <p className="mt-1 text-muted">The number on the client’s record is different now, so nothing is sent. Consent is needed again for the new number.</p>}
              {notUs && <p className="mt-1 text-muted">This is not a US mobile number. Texts are sent to US numbers only, so nothing is sent to it.</p>}
            </>
          ) : (
            <>
              <Badge tone="neutral">Off</Badge>
              {last?.revoked_at && <p className="mt-1.5 text-muted">Ended {fmtDate(last.revoked_at)}: {ENDED[last.revoked_via ?? ''] ?? 'withdrawn'}.</p>}
              {stopped && <p className="mt-1.5 text-muted">{last?.revoked_via === 'sms_stop' || last?.revoked_via === 'asked_to_stop' ? '' : 'This number replied STOP. '}Only the client can turn texts back on, in their portal profile. A consent cannot be recorded here.</p>}
            </>
          )}
          {unapproved && <p className="mt-1.5 text-muted">{unapproved}</p>}
        </div>
        {active && <form action={revokeSmsConsentAction}><input type="hidden" name="clientId" value={clientId} /><ConfirmButton className="text-xs text-muted underline hover:text-ink" message="Turn off text messages for this client? No further text is sent until they agree again.">Turn off</ConfirmButton></form>}
      </div>
      {replies.length > 0 && (
        <div className="mt-3 rounded-xl bg-raised p-3.5 text-sm">
          <p className="font-medium">The client replied by text{active ? '. Texts are paused until you have read it' : ''}</p>
          <ul className="mt-1.5 space-y-1">{replies.map((r) => <li key={r.id} className="[overflow-wrap:anywhere]"><span className="text-muted">{fmtDate(r.created_at)}: </span>“{r.body}”</li>)}</ul>
          <p className="mt-2 text-[0.8125rem] text-muted">If the reply asks you to stop texting in any words, turn texts off. A request to stop has to be honoured however it is worded.</p>
          <form action={reviewSmsReplyAction} className="mt-2.5 flex flex-wrap gap-2">
            <input type="hidden" name="clientId" value={clientId} />
            <button className="btn-secondary btn-sm" type="submit" name="decision" value="stop">It asks to stop: turn texts off</button>
            <button className="btn-ghost btn-sm" type="submit" name="decision" value="keep">It does not: keep texts on</button>
          </form>
        </div>
      )}
      {!active && !stopped && (
        <details className="mt-3">
          <summary className="link cursor-pointer text-sm">Record consent given outside the portal</summary>
          {usNumber ? (
            <ActionForm action={recordSmsConsentAction} className="mt-3 space-y-3">
              <input type="hidden" name="clientId" value={clientId} />
              <p className="rounded-xl bg-raised p-3.5 text-sm leading-relaxed [overflow-wrap:anywhere]">{smsConsentText(lang, orgName, usNumber)}</p>
              <Check name="confirmed" required>I read this wording to the client and they agreed</Check>
              <TextArea label="How and when the client agreed" name="note" rows={2} required maxLength={500} placeholder="e.g. On a call with me on 14 March, about 2 p.m." />
              <SubmitButton variant="secondary">Record consent</SubmitButton>
              <p className="text-xs text-muted">Saved as “recorded by staff” with your note and the wording above. The client can also agree, or withdraw, in their portal profile.</p>
            </ActionForm>
          ) : <p className="mt-2 text-sm text-muted">Save a US mobile number with its area code on the client’s record first, for example (212) 555-0142. Texts are sent to US numbers only.</p>}
        </details>
      )}
    </Section>
  );
}
