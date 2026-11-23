import Link from 'next/link';
import { ActionForm, Check, ConfirmButton, Field, Select, SubmitButton } from '@/components/forms';
import { Badge, Section } from '@/components/ui';
import { MonthPicker, monthLabel } from '@/components/work-statement';
import type { requireStaff } from '@/lib/auth/context';
import { loadChargeCheck } from '@/lib/billing/records';
import { agencyZone } from '@/lib/agreements';
import { isMonth, monthsBack, sayDay } from '@/lib/business-days';
import { PRODUCT } from '@/lib/product';
import { dayInZone } from '@/lib/util';
import { recordPaymentAction, setSoldByPhoneAction } from '../../billing/actions';

type Ctx = Awaited<ReturnType<typeof requireStaff>>;

/**
 * Where staff record a payment: the charge check for the chosen work period, then the payment form. "Hold" does not
 * block the payment; it makes the person read the reasons and confirm, and the confirmation goes to the audit log.
 * The check and its legal basis are in src/lib/billing/eligibility.ts.
 */
export async function ChargeBlock({ id, ctx, period, subscription }: { id: string; ctx: Ctx; period?: string; subscription?: { id: string; price_cents: number } | null }) {
  // Counted on the agency's own calendar day (Settings → Client updates → time zone), like the cancellation period the
  // client's Notice of Cancellation states and the service gate (src/lib/agreements.ts).
  const { thisMonth, month, check } = await ctx.tx(async (db) => {
    const tz = await agencyZone(db, ctx.orgId);
    const thisMonth = dayInZone(tz).slice(0, 7);
    const month = isMonth(period) && period <= thisMonth ? period : thisMonth;
    return { thisMonth, month, check: await loadChargeCheck(db, id, month, tz) };
  });
  if (!check) return null;
  const hold = check.status === 'hold';
  const months = monthsBack(thisMonth, '2000-01', 12);
  return (
    <>
      <Section title="Charge check" hint="Whether recording a charge today for work in the chosen month fits the federal timing rules for credit repair organizations.">
        <MonthPicker months={months.includes(month) ? months : [month, ...months]} month={month} label="Work period" show="Check" keep={{ tab: 'billing' }} />
        <div className="mt-4 flex flex-wrap items-center gap-2" data-charge-check={check.status}>
          <Badge tone={hold ? 'warn' : 'neutral'} dot>{hold ? 'Hold' : 'No hold found'}</Badge>
          <span className="text-sm text-muted">{monthLabel(month)}</span>
        </div>
        {hold ? (
          <ul className="mt-3 list-disc space-y-1.5 pl-5 text-sm">{check.reasons.map((r) => <li key={r.code}>{r.text}</li>)}</ul>
        ) : (
          <p className="mt-3 text-sm">On record: a signed service agreement, signed more than 3 business days ago (the cancellation period ran through {check.cancellationEndsOn ? sayDay(check.cancellationEndsOn) : '—'}); {check.workCount} {check.workCount === 1 ? 'letter' : 'letters'} recorded as sent in this period; and the client is not marked cancelled. Whether that work is the whole of the service you agreed to perform is for you to judge.</p>
        )}
        {check.phoneSale === 'not_answered' && <p className="mt-2 text-sm text-muted">How this client was sold has not been answered{ctx.can('billing:write') ? ' (below)' : ''}, so the phone-sale rule was not considered.</p>}
        <p className="mt-3 text-xs text-muted">This check covers two timing rules only: no charge before the service is fully performed (15 U.S.C. § 1679b(b)) and none inside the 3-business-day cancellation period (15 U.S.C. § 1679e(a)); some states set a longer period. The rule for services sold by phone (16 CFR 310.4(a)(2)) is considered only when the client is marked as sold by phone. “No hold found” describes the record; it is not a finding that a charge is lawful, and it is not legal advice. Pricing and billing practices are your agency’s responsibility; {PRODUCT.name} does not recommend a fee model.</p>
        <p className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-sm"><Link className="link" href={`/app/clients/${id}/statement?period=${month}`}>Work statement</Link><Link className="link" href={`/app/clients/${id}/evidence`}>Evidence pack</Link></p>
      </Section>
      {ctx.can('billing:write') && (
        <>
          <Section title="Record a payment">
            <ActionForm action={recordPaymentAction} resetOnSuccess className="space-y-3">
              <input type="hidden" name="clientId" value={id} /><input type="hidden" name="subscriptionId" value={subscription?.id ?? ''} /><input type="hidden" name="period" value={month} />
              <Field label="Amount ($)" name="amount" inputMode="decimal" required defaultValue={subscription ? (subscription.price_cents / 100).toFixed(2) : ''} hint={`For work in ${monthLabel(month)}.`} />
              <Select label="Method" name="method" defaultValue="card" options={[{ value: 'card', label: 'Card' }, { value: 'ach', label: 'ACH / bank' }, { value: 'check', label: 'Check' }, { value: 'cash', label: 'Cash' }, { value: 'other', label: 'Other' }]} />
              <Field label="Note" name="note" />
              <Check name="performed" required>This payment is for services <strong>already performed</strong>. (Credit repair organizations may not collect payment in advance.)</Check>
              {hold ? (
                <>
                  <input type="hidden" name="ackHold" value="on" />
                  <ConfirmButton className="btn-secondary" message={`This charge is on hold:\n\n${check.reasons.map((r) => `• ${r.text}`).join('\n\n')}\n\nRecord the payment anyway? Your acknowledgement is written to the audit log.`}>Record payment on hold</ConfirmButton>
                </>
              ) : <SubmitButton>Record payment</SubmitButton>}
            </ActionForm>
          </Section>
          <Section plain title="How this client was sold">
            <ActionForm action={setSoldByPhoneAction} className="space-y-3">
              <input type="hidden" name="clientId" value={id} />
              <Select label="Was the service sold on a phone call?" name="soldByPhone" defaultValue={check.soldByPhone == null ? '' : check.soldByPhone ? 'yes' : 'no'}
                options={[{ value: '', label: 'Not answered' }, { value: 'no', label: 'No' }, { value: 'yes', label: 'Yes, sold by phone' }]}
                hint="If yes, a different federal rule may govern when you can be paid, and the charge check adds a caution. Until this is answered, that rule is not considered." />
              <SubmitButton variant="secondary">Save</SubmitButton>
            </ActionForm>
          </Section>
        </>
      )}
    </>
  );
}
