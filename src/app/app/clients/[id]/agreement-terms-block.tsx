import Link from 'next/link';
import { ActionForm, Field, SubmitButton, TextArea } from '@/components/forms';
import { Badge, Notice, Section } from '@/components/ui';
import { loadClientAgreements } from '@/lib/agreements';
import type { requireStaff } from '@/lib/auth/context';
import { dollars, TERMS_LIMITS } from '@/lib/compliance/agreement-terms';
import { signedPayment } from '@/lib/compliance/disclosures';
import { fmtDate } from '@/lib/util';
import { clearClientTermsAction, saveClientTermsAction } from '../actions';

type Ctx = Awaited<ReturnType<typeof requireStaff>>;

const interval = (v: string) => (v === 'one_time' ? 'one time' : `per ${v}`);

/**
 * The payment terms and total of all payments in this client's service agreement (15 U.S.C. § 1679d(b)(1)), exactly
 * as the client sees them or signed them: the agency's (Settings → Client agreement), or this client's own, which an
 * owner, admin or manager sets here before the client signs (an agency with several plans). Locked while an agreement
 * is in force: the figures are then the ones it was signed with, read from its stored text. Not shown in a personal
 * workspace, which has no service agreement.
 */
export async function AgreementTermsBlock({ ctx, clientId, first }: { ctx: Ctx; clientId: string; first: string }) {
  const d = await ctx.tx(async (db) => ({
    a: await loadClientAgreements(db, ctx.orgId, clientId),
    contract: await db.row<{ text_shown: string | null; signed_at: string }>(
      "select text_shown, signed_at from public.client_consents where client_id = $1 and kind = 'croa_contract' and revoked_at is null order by signed_at desc limit 1", [clientId]),
    // Billing roles only (row-level security): the plan the client is billed on, to compare with the figures above.
    plan: await db.row<{ name: string; price_cents: number; interval: string }>(
      "select p.name, p.price_cents, p.interval from public.client_subscriptions s join public.service_plans p on p.id = s.plan_id where s.client_id = $1 and s.status = 'active' order by s.created_at desc limit 1", [clientId]),
  }));
  const a = d.a;
  if (!a || a.agency.personal) return null;
  const own = a.ownTerms;
  const agency = a.agency.terms;
  // What the client sees now: their own figures when set, otherwise the agency's (none until the agency saves its terms).
  const shown = own ?? (agency ? { paymentTerms: agency.paymentTerms, totalCents: agency.totalCents } : null);
  const signed = d.contract?.text_shown ? signedPayment(d.contract.text_shown) : null;
  const canEdit = ctx.can('billing:write');
  return (
    <Section id="agreement-terms" title="Agreement payment terms" hint="What the service agreement states the client will pay (15 U.S.C. § 1679d(b)(1))."
      plain={!!d.contract} fold={d.contract ? { summary: <>Signed {fmtDate(d.contract.signed_at)}{signed ? <> · total of all payments {signed.total}</> : ''}</> } : undefined}>
      <div className="scroll-mt-28 space-y-3 text-sm">
        {d.contract ? (
          <>
            <p className="flex flex-wrap items-center gap-2"><Badge tone="ok" dot>Signed</Badge><span className="text-muted">The agreement in force, signed {fmtDate(d.contract.signed_at)}, states:</span></p>
            {signed ? (
              <dl className="space-y-1.5">
                <div><dt className="text-xs text-muted">Payment terms</dt><dd className="whitespace-pre-wrap [overflow-wrap:anywhere]">{signed.paymentTerms}</dd></div>
                <div><dt className="text-xs text-muted">Total of all payments</dt><dd className="font-medium tabular-nums">{signed.total}</dd></div>
              </dl>
            ) : <p className="text-muted">It was signed before the current agreement and states no payment terms.</p>}
            <p className="text-xs text-muted">These cannot be changed while the agreement is in force. To change them, revoke it in the <a href="#compliance" className="link">compliance record</a>, set the new figures here, and have {first} sign a new one.</p>
          </>
        ) : (
          <>
            <p className="flex flex-wrap items-center gap-2">
              <Badge tone={own ? 'info' : 'neutral'}>{own ? `${first}’s own terms` : 'Your agency’s terms'}</Badge>
              <span className="text-muted">{shown ? `${first} will sign the service agreement with:` : 'Not set yet.'}</span>
            </p>
            {shown && (
              <dl className="space-y-1.5">
                <div><dt className="text-xs text-muted">Payment terms</dt><dd className="whitespace-pre-wrap [overflow-wrap:anywhere]">{shown.paymentTerms}</dd></div>
                <div><dt className="text-xs text-muted">Total of all payments</dt><dd className="font-medium tabular-nums">{dollars(shown.totalCents)}</dd></div>
              </dl>
            )}
            {a.ownTermsIssue && <Notice tone="warn" title="These terms cannot be used">{a.ownTermsIssue} Change them before {first} signs: until then the service agreement cannot be signed.</Notice>}
            {!agency && (
              <p className="text-xs text-muted">Your client agreement terms are not saved yet, so no service agreement can be signed. {ctx.can('settings:manage') ? <Link href="/app/settings#agreement" className="link">Settings → Client agreement</Link> : 'An owner or admin saves them in Settings → Client agreement.'}</p>
            )}
          </>
        )}
        {d.plan && <p className="text-xs text-muted">Billing: {d.plan.name}, {dollars(d.plan.price_cents)} {interval(d.plan.interval)}. Check that the agreement’s figures match what {first} will be billed.</p>}
        {!d.contract && (canEdit ? (
          <details>
            <summary className="link cursor-pointer">{own ? `Change ${first}’s payment terms` : `Set ${first}’s own payment terms`}</summary>
            <ActionForm action={saveClientTermsAction} className="mt-3 space-y-3">
              <input type="hidden" name="clientId" value={clientId} />
              <TextArea label="Payment terms" name="paymentTerms" required rows={4} maxLength={TERMS_LIMITS.paymentTerms[1]} defaultValue={shown?.paymentTerms ?? ''}
                hint="When and how this client pays. No payment may be asked for before the service it pays for is fully performed (§ 1679b(b))." />
              <Field label="Total of all payments (USD)" name="total" required inputMode="decimal" defaultValue={shown ? (shown.totalCents / 100).toFixed(2) : ''} placeholder="594.00"
                hint="Everything this client will pay under the agreement, to you or anyone else." />
              <SubmitButton variant="secondary">Save {first}’s terms</SubmitButton>
            </ActionForm>
            {own && (
              <ActionForm action={clearClientTermsAction} className="mt-3">
                <input type="hidden" name="clientId" value={clientId} />
                <SubmitButton variant="ghost">Use your agency’s terms instead</SubmitButton>
              </ActionForm>
            )}
          </details>
        ) : <p className="text-xs text-muted">An owner, admin or manager can set this client’s own payment terms before they sign.</p>)}
      </div>
    </Section>
  );
}
