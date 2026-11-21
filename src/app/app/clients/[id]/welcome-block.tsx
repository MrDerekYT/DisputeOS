import Link from 'next/link';
import type { ReactNode } from 'react';
import { CheckCircle2, Circle } from 'lucide-react';
import { Badge, Notice, Section } from '@/components/ui';
import { renderFor } from '@/lib/agreements';
import type { requireStaff } from '@/lib/auth/context';
import { sayDay } from '@/lib/business-days';
import { savedTermsIssue } from '@/lib/compliance/agreement-terms';
import { isDraftEraSignature, isRendered } from '@/lib/compliance/disclosures';
import { emailIsLive } from '@/lib/lead-outreach';
import { loadWelcome } from '@/lib/onboarding';
import { cn, fmtDate } from '@/lib/util';
import { WelcomeLinkButtons } from './welcome-link-buttons';

type Ctx = Awaited<ReturnType<typeof requireStaff>>;

const Step = ({ done, children }: { done: boolean; children: ReactNode }) => (
  <li className="flex items-center gap-2">
    {done ? <CheckCircle2 size={15} aria-hidden className="shrink-0 text-ok" /> : <Circle size={15} aria-hidden className="shrink-0 text-faint" />}
    <span className={cn(!done && 'text-muted')}>{children}<span className="sr-only">{done ? ' (done)' : ' (not done yet)'}</span></span>
  </li>
);

const same = (a: string | null | undefined, b: string | null | undefined) => (a ?? '').trim().toLowerCase() === (b ?? '').trim().toLowerCase();

/**
 * The client's welcome link and, once they have joined, how far they are through the welcome steps (from their records:
 * src/lib/onboarding.ts), with the email their portal account signs in with. Replaces the single "Invite to client
 * portal" button.
 */
export async function WelcomeBlock({ ctx, clientId, first, email, portalUserId }: { ctx: Ctx; clientId: string; first: string; email: string | null; portalUserId: string | null }) {
  const d = await ctx.tx(async (db) => ({
    welcome: await loadWelcome(db, clientId),
    link: await db.row<{ created_at: string; expires_at: string; live: boolean; email: string }>(
      "select created_at, expires_at, expires_at > now() as live, email from public.invites where client_id = $1 and role = 'client' and accepted_at is null order by created_at desc limit 1", [clientId]),
    // How the last link reached the client: logged once it was made to copy, or once the email service took the email.
    sent: await db.row<{ via: string | null; unconfirmed: boolean }>(
      "select meta->>'via' as via, coalesce((meta->>'unconfirmed')::boolean, false) as unconfirmed from public.client_events where client_id = $1 and kind = 'portal_invited' order by created_at desc limit 1", [clientId]),
    joined: portalUserId ? await db.row<{ created_at: string }>("select created_at from public.client_events where client_id = $1 and kind = 'portal_joined' order by created_at desc limit 1", [clientId]) : null,
    // The address the portal account signs in with: the one the accepted link was made for.
    account: portalUserId ? await db.row<{ email: string }>('select email from public.users where id = $1', [portalUserId]) : null,
  }));
  if (!d.welcome) return <></>; // the client is not visible to this staff member
  const { ob, ag } = d.welcome;
  // The statement or service agreement in force that was signed on the 2026-01 drafts (stored without text).
  const drafts = ag.rows.filter(isDraftEraSignature).map((r) => r.kind);
  // Why the service agreement cannot be signed yet, when it cannot: the agency's terms (not saved, or saved before a
  // check they no longer pass), or this client's own payment terms.
  const contractInForce = ag.inForce.includes('croa_contract');
  const savedIssue = savedTermsIssue(ag.agency.settings);
  const notReady = !contractInForce && !isRendered(renderFor(ag, 'croa_contract'));
  const settingsLink = ctx.can('settings:manage') ? <Link href="/app/settings#agreement" className="link">Open Settings → Client agreement</Link> : 'Ask an owner or admin to change them in Settings → Client agreement.';
  const cancelledOn = ob.agreements.cancelledOn;
  return (
    <Section id="welcome" title="Welcome link" hint="One link takes the client through their details, agreements and ID documents.">
      <div className="scroll-mt-28 space-y-3 text-sm">
        {portalUserId ? (
          <>
            {ob.complete ? (
              <p className="flex items-center gap-2"><Badge tone="ok" dot>Finished</Badge><span className="text-muted">Details, all four agreements and the three ID documents are in.</span></p>
            ) : (
              <>
                <p><Badge tone="info" dot>Joined</Badge>{d.joined && <span className="ml-2 text-muted">on {fmtDate(d.joined.created_at)}</span>}</p>
                <ul className="space-y-1.5" aria-label="Welcome steps">
                  <Step done={ob.details.done}>Details {ob.details.done ? 'done' : `(missing: ${ob.details.missing.map((m) => (m === 'dob' ? 'date of birth' : m === 'ssn' ? 'SSN' : 'mailing address')).join(', ')})`}</Step>
                  <Step done={ob.agreements.done}>Agreements: {ob.agreements.signed} of {ob.agreements.total}</Step>
                  <Step done={ob.documents.done}>ID documents: {ob.documents.provided} of {ob.documents.total}</Step>
                </ul>
              </>
            )}
            {d.account && (
              <p className="text-muted">
                Portal account: <span className="text-ink [overflow-wrap:anywhere]">{d.account.email}</span>
                {!same(d.account.email, email) && <> <Badge tone="warn">Not the email on file</Badge> The client’s email on file is {email ?? 'empty'}: the portal account signs in with the address the accepted link was made for.</>}
              </p>
            )}
            {cancelledOn && (
              <Notice tone="warn" title="Agreement cancelled">
                {first} cancelled the service agreement in the portal on {sayDay(cancelledOn)}. The portal shows {first} that it is cancelled and asks for nothing more; {first} can still sign a new one from their Profile.
              </Notice>
            )}
          </>
        ) : !email ? (
          <p className="text-muted">Add the client’s email first: their portal account is made for it. <Link href={`/app/clients/${clientId}/edit`} className="link">Edit client</Link></p>
        ) : (
          <>
            <p className="text-muted">
              {!d.link ? 'Not invited yet.'
                : d.link.live ? <>Link {d.sent?.via === 'email' ? 'emailed' : 'made'} for <span className="text-ink [overflow-wrap:anywhere]">{d.link.email}</span> on {fmtDate(d.link.created_at)}, expires {fmtDate(d.link.expires_at)}.{d.sent?.via === 'email' && d.sent.unconfirmed && ' The email service did not answer, so it may not have arrived.'} Making a new one ends it.</>
                  : `The last link ended on ${fmtDate(d.link.expires_at)} without being used.`}
            </p>
            {ctx.can('clients:write') && <WelcomeLinkButtons clientId={clientId} emailLive={emailIsLive()} />}
          </>
        )}
        {notReady && (
          <Notice tone="warn" title="Service agreement not ready">
            {ag.ownTermsIssue && ag.agency.terms
              ? <>{first}’s own payment terms cannot be used in the service agreement: {ag.ownTermsIssue} Change them under <a href="#agreement-terms" className="link">Agreement payment terms</a>.</>
              : savedIssue
                ? <>{first} cannot sign the service agreement: your saved client agreement terms no longer pass the checks. {savedIssue} {settingsLink}</>
                : <>{first} cannot sign the service agreement until your client agreement terms are saved. {ctx.can('settings:manage') ? <Link href="/app/settings#agreement" className="link">Open Settings → Client agreement</Link> : 'Ask an owner or admin to save them in Settings → Client agreement.'}</>}
          </Notice>
        )}
        {drafts.length > 0 && (
          <Notice tone="warn" title="Signed before the current agreement">
            {drafts.includes('croa_contract') && <>{first}’s service agreement was signed before the current agreement: it has no terms or notice of cancellation. </>}
            {drafts.includes('croa_disclosure') && <>{first}’s Consumer Credit File Rights statement was signed before the current one, which is the full statutory text. </>}
            Revoke {drafts.length > 1 ? 'them' : 'it'} in the <a href="#compliance" className="link">compliance record</a>, then {portalUserId ? `ask ${first} to sign in: the portal asks for` : `send a welcome link (or record a new paper signature) so ${first} signs`} the current {drafts.length > 1 ? 'ones' : 'one'}, the statement before the agreement.
          </Notice>
        )}
      </div>
    </Section>
  );
}
