import Link from 'next/link';
import { ChevronDown } from 'lucide-react';
import { ActionForm, Check, Field, Select, SubmitButton } from '@/components/forms';
import { Badge, Section } from '@/components/ui';
import type { Ctx } from '@/lib/auth/context';
import { BANK_AGENCIES, BANK_DETAIL_LABEL, BANK_DETAILS, bankCollectionSteps, loadBankCases } from '@/lib/credit/bank-collections';
import { agencyByKey, specialtyReportStates } from '@/lib/credit/agencies';
import { loadSpecialty } from '@/lib/credit/specialty-reports';
import { fmtDate } from '@/lib/util';
import { removeBankCaseAction, saveBankCaseAction } from '../letter-tools-actions';

const YES_NO_UNSURE = [{ value: 'unsure', label: 'Not sure yet' }, { value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }];
const REPORT_STATUS = { not_requested: 'not requested', requested: 'requested', received: 'received' } as const;

/**
 * "Bank account sent to collections": a few plain questions about an overdrawn or closed bank account, and the steps
 * that follow from the answers, each linking to the tool that already does it. A guide only: it creates no dispute and
 * no letter, and when the client says the record is accurate it says so and offers no dispute.
 */
export async function BankCollectionsBlock({ ctx, clientId }: { ctx: Ctx; clientId: string }) {
  const d = await ctx.tx(async (db) => ({ cases: await loadBankCases(db, clientId), specialty: await loadSpecialty(db, clientId) }));
  const reports = d.specialty?.states ?? specialtyReportStates(null);
  const canWrite = ctx.can('clients:write');
  return (
    <Section plain id="bank-collections" title="Bank account sent to collections"
      hint="For an overdrawn or closed bank account. Answer a few questions with the client; the steps that apply are listed. Nothing is drafted or sent from here.">
      {d.cases.length > 0 && (
        <ul className="divide-y divide-line/70">
          {d.cases.map((c) => {
            const { accurate, steps } = bankCollectionSteps(c, { clientId, reports });
            return (
              <li key={c.id} className="py-3 first:pt-0">
                <details className="group">
                  <summary className="flex cursor-pointer list-none flex-wrap items-center justify-between gap-x-3 gap-y-1.5 rounded-md [&::-webkit-details-marker]:hidden">
                    <span className="flex items-center gap-1.5 font-medium [overflow-wrap:anywhere]">{c.bankName} <ChevronDown size={15} aria-hidden className="text-muted transition-transform group-open:rotate-180" /></span>
                    <Badge tone={accurate ? 'neutral' : 'info'}>{accurate ? 'Reported accurately' : `${steps.length} steps`}</Badge>
                  </summary>
                  <ol className="mt-3 space-y-3 text-sm">
                    {steps.map((s, i) => (
                      <li key={s.key} className="flex gap-3">
                        <span aria-hidden className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-raised text-xs font-medium text-muted">{i + 1}</span>
                        <div className="min-w-0">
                          <div className="font-medium">{s.title}</div>
                          <p className="mt-0.5 text-muted">{s.body}</p>
                          {s.links && <p className="mt-1 flex flex-wrap gap-x-4 gap-y-1">{s.links.map((l) => (l.href.startsWith('http')
                            ? <a key={l.href} className="link" href={l.href} target="_blank" rel="noopener noreferrer">{l.label}</a>
                            : <Link key={l.href} className="link" href={l.href}>{l.label}</Link>))}</p>}
                        </div>
                      </li>
                    ))}
                  </ol>
                  {canWrite && (
                    <ActionForm action={removeBankCaseAction} className="mt-3">
                      <input type="hidden" name="clientId" value={clientId} /><input type="hidden" name="caseId" value={c.id} />
                      <SubmitButton variant="ghost" className="btn-sm">Remove this account</SubmitButton>
                    </ActionForm>
                  )}
                </details>
              </li>
            );
          })}
        </ul>
      )}
      {canWrite && (
        <details className={d.cases.length ? 'mt-3 border-t border-line pt-3' : ''}>
          <summary className="link cursor-pointer text-sm">{d.cases.length ? 'Add another account' : 'Start the questions'}</summary>
          <ActionForm action={saveBankCaseAction} resetOnSuccess className="mt-3 space-y-3">
            <input type="hidden" name="clientId" value={clientId} />
            <Field label="Which bank or credit union?" name="bankName" required maxLength={160} />
            <Select label="Does the client say the overdraft or charge was accurate?" name="chargeAccurate" options={YES_NO_UNSURE} />
            <fieldset>
              <legend className="label">If not, which details does the client say are inaccurate?</legend>
              <div className="grid gap-2 sm:grid-cols-2">{BANK_DETAILS.map((k) => <Check key={k} name="details" value={k}>{BANK_DETAIL_LABEL[k]}</Check>)}</div>
            </fieldset>
            <div className="grid gap-3 sm:grid-cols-2">
              <Select label="Has it been paid?" name="paid" options={[{ value: 'no', label: 'No' }, { value: 'yes', label: 'Yes' }]} />
              <Select label="Is a collection account for it on the credit reports?" name="onCreditReports" options={YES_NO_UNSURE} />
            </div>
            <p className="text-[0.8125rem] text-muted">
              Reports the client has asked for: {BANK_AGENCIES.map((k) => `${agencyByKey(k)!.shortName} ${REPORT_STATUS[reports[k]!.status]}${reports[k]!.on ? ` ${fmtDate(reports[k]!.on!)}` : ''}`).join(' · ')}.
              {' '}This is recorded under <a className="link" href="#specialty">Specialty reports</a>.
            </p>
            <SubmitButton variant="secondary">Show the steps</SubmitButton>
          </ActionForm>
        </details>
      )}
    </Section>
  );
}
