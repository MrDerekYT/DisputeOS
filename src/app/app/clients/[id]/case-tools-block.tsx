import type { ReactNode } from 'react';
import Link from 'next/link';
import { ChevronDown } from 'lucide-react';
import { ActionForm, Check, Field, Select, SubmitButton } from '@/components/forms';
import { Badge, Section, type Tone } from '@/components/ui';
import type { Ctx } from '@/lib/auth/context';
import { isCollectorAccount } from '@/lib/credit/account-kind';
import { AUDIT_NOTE_TEXT, auditAccounts, bankruptcyFallOff } from '@/lib/credit/bankruptcy-audit';
import { bankruptcyRecordText, loadBankruptcy, loadBankruptcyOnReports, loadCaseLines, loadCollectorNotices, noticeIsFor, type CaseLine } from '@/lib/credit/case-tools';
import { groupAccounts, type AnalysisTradeline } from '@/lib/reports/analysis';
import { MEDICAL_POLICY_SOURCE, medicalBasis, medicalTests, reportSaysMedical, type MedicalTest } from '@/lib/credit/medical-screen';
import { AFTER_PERIOD_NOTE } from '@/lib/credit/validation-clock';
import { businessToday } from '@/lib/letters/service';
import { BUREAU_LABEL, fmtDate, money } from '@/lib/util';
import { recordCollectorNoticeAction, removeCollectorNoticeAction, setBankruptcyAction, setMedicalFlagsAction } from '../case-tools-actions';

const TEST_LABEL: Record<MedicalTest, string> = { paid: 'paid', under_500: 'under $500', under_one_year: 'under one year old' };

function Tool({ title, badge, tone = 'neutral', children }: { title: string; badge: string; tone?: Tone; children: ReactNode }) {
  return (
    <li className="py-3 first:pt-0 last:pb-0">
      <details className="group">
        <summary className="flex cursor-pointer list-none flex-wrap items-center justify-between gap-x-3 gap-y-1.5 rounded-md [&::-webkit-details-marker]:hidden">
          <span className="flex items-center gap-1.5 font-medium">{title} <ChevronDown size={15} aria-hidden className="text-muted transition-transform group-open:rotate-180" /></span>
          <Badge tone={tone}>{badge}</Badge>
        </summary>
        <div className="mt-3 space-y-3 text-sm">{children}</div>
      </details>
    </li>
  );
}

/**
 * Three small tools over data already on file: the collector validation period (FDCPA, a separate clock from any
 * credit-report dispute), the medical collection screen (bureau policy, not law) and the bankruptcy discharge audit.
 * Each one states what was entered or reported and what is worth checking. Their findings appear with the others on
 * the three-bureau comparison, where a person decides what to do; nothing is drafted or sent from here.
 */
export async function CaseToolsBlock({ ctx, clientId }: { ctx: Ctx; clientId: string }) {
  const today = businessToday();
  const d = await ctx.tx(async (db) => {
    const lines = await loadCaseLines(db, clientId);
    return { notices: await loadCollectorNotices(db, clientId, today), lines, bankruptcy: await loadBankruptcy(db, clientId), onReports: await loadBankruptcyOnReports(db, clientId, lines) };
  });
  const canWrite = ctx.can('clients:write');
  const canDispute = ctx.can('disputes:write');
  // A collector's account: listed under collections, or labelled one by a person (src/lib/credit/account-kind.ts). A
  // creditor's own account "in collection" is negative but has no collector, so it has no validation period here.
  const collections = d.lines.filter((t) => isCollectorAccount(t));
  const label = (t: { creditor_name: string; account_last4: string | null }) => `${t.creditor_name}${t.account_last4 ? ` ••${t.account_last4}` : ''}`;
  // One row per collection account however many bureaus report it, matched as the three-bureau comparison matches them
  // (number, or open date, original creditor and amounts when a report prints no number), leaving out the accounts a
  // notice was already recorded for, on this report or an earlier one.
  const byId = new Map(collections.map((t) => [t.id, t]));
  const accounts = groupAccounts(collections.map((t) => ({ ...t, date_reported: null, user_provided: {} }) as AnalysisTradeline & CaseLine))
    .map((g) => Object.values(g.byBureau).map((t) => byId.get(t!.id)!).filter(Boolean));
  const toRecord = accounts.filter((ls) => !d.notices.some((n) => noticeIsFor(n, ls))).map((ls) => ({ key: ls.map((t) => t.id).join('|'), lines: ls, first: ls[0]! }));
  const bk = d.onReports.record;

  const open = d.notices.filter((n) => n.period.open);
  const soonest = [...open].sort((a, b) => a.period.endsOn.localeCompare(b.period.endsOn))[0];
  const medical = collections.map((t) => ({ t, basis: medicalBasis(t), tests: medicalTests(t, today) }));
  // A name alone is a suggestion: it is not counted, not ticked, and makes no finding until staff tick it.
  const medicalToCheck = medical.filter((m) => (m.basis === 'staff' || m.basis === 'report') && m.tests.length).length;
  const audit = d.bankruptcy ? auditAccounts(d.bankruptcy, d.lines) : [];
  const auditToCheck = audit.filter((r) => r.notes.length).length;
  const fallOff = d.bankruptcy ? bankruptcyFallOff(d.bankruptcy) : null;

  return (
    <Section plain id="case-tools" title="Collections and bankruptcy"
      hint={<>What was entered or reported, and what is worth checking. Findings from these appear in the <Link className="link" href={`/app/clients/${clientId}/compare#findings`}>three-bureau comparison</Link>, where a person decides what to do.</>}>
      <ul className="divide-y divide-line/70">
        <Tool title="Collector notices (validation period)" tone={soonest ? (soonest.period.daysLeft <= 7 ? 'warn' : 'info') : 'neutral'}
          badge={soonest ? `${soonest.period.daysLeft === 0 ? 'Last day today' : `${soonest.period.daysLeft} day${soonest.period.daysLeft === 1 ? '' : 's'} left`}` : d.notices.length ? 'Period ended' : accounts.length ? `${accounts.length} collection${accounts.length === 1 ? '' : 's'} on the reports` : 'None recorded'}>
          <p className="text-muted">
            A separate clock from a credit-report dispute: this is the Fair Debt Collection Practices Act deadline for writing to the <strong className="font-medium text-ink">collector</strong>, not a bureau.
            The validation period generally ends 30 days after the client receives the collector’s notice (12 CFR 1006.34(b)(5)). The notice itself states the end date the collector uses: go by the notice if it differs.
          </p>
          {d.notices.length > 0 && (
            <ul className="divide-y divide-line/70 rounded-xl border border-line px-3.5">
              {d.notices.map((n) => (
                <li key={n.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-3">
                  <span className="min-w-0">
                    <span className="font-medium [overflow-wrap:anywhere]">{n.collectorName}</span>
                    <span className="block text-[0.8125rem] text-muted">
                      {n.period.presumed ? `Sent ${fmtDate(n.date)} · receipt presumed ${fmtDate(n.period.receivedOn)} (5 days later, not counting weekends and legal public holidays)` : `Received ${fmtDate(n.date)}`}
                    </span>
                  </span>
                  <span className="flex flex-wrap items-center gap-2">
                    <Badge tone={n.period.open ? (n.period.daysLeft <= 7 ? 'warn' : 'info') : 'neutral'}>
                      {n.period.open ? `Validation period ends ${fmtDate(n.period.endsOn)}` : `Validation period ended ${fmtDate(n.period.endsOn)}`}
                    </Badge>
                    {n.period.open && canDispute && n.tradelineId && n.isCollection && (
                      <Link className="btn-secondary btn-sm" href={`/app/disputes/new?clientId=${clientId}&tradelineId=${n.tradelineId}&category=unverifiable_collection`}>Draft validation request</Link>
                    )}
                    {canWrite && (
                      <ActionForm action={removeCollectorNoticeAction}>
                        <input type="hidden" name="clientId" value={clientId} /><input type="hidden" name="noticeId" value={n.id} />
                        <SubmitButton variant="ghost" className="btn-sm">Remove</SubmitButton>
                      </ActionForm>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {open.length > 0 && (
            <p className="text-[0.8125rem] text-muted">
              A validation request is drafted as a letter to the collector, reviewed and approved like any other letter, and is for a debt the client questions. What counts is the day it is sent; still allow for mailing time and keep proof of mailing.
              {open.some((n) => !(n.tradelineId && n.isCollection)) && ' A letter can be drafted here once the collection account is on an approved report.'}
            </p>
          )}
          {d.notices.some((n) => !n.period.open) && <p className="text-[0.8125rem] text-muted">{AFTER_PERIOD_NOTE}</p>}
          {canWrite && toRecord.length > 0 && (
            <div className="space-y-2 border-t border-line pt-3">
              <p className="text-[0.8125rem] text-muted">
                {toRecord.length === 1 ? 'The collection' : `The ${toRecord.length} collections`} on the reports, already chosen. When the client has a notice from the collector, enter the date on it: only the client’s notice shows that date, so it is never filled in for them.
              </p>
              <ul className="divide-y divide-line/70 rounded-xl border border-line px-3.5">
                {toRecord.map(({ key, lines, first }) => (
                  <li key={key} className="py-3">
                    <ActionForm action={recordCollectorNoticeAction} resetOnSuccess className="grid gap-x-3 gap-y-2 sm:grid-cols-[minmax(0,1fr)_auto_auto_auto] sm:items-end">
                      <input type="hidden" name="clientId" value={clientId} /><input type="hidden" name="tradelineId" value={first.id} />
                      <span className="min-w-0 self-center">
                        <span className="block font-medium [overflow-wrap:anywhere]">{label(first)}</span>
                        <span className="block text-[0.8125rem] text-muted">
                          {lines.map((t) => BUREAU_LABEL[t.bureau]).join(', ')}{first.balance_cents != null ? ` · ${money(first.balance_cents)}` : ''}{first.original_creditor ? ` · original creditor ${first.original_creditor}` : ''}
                        </span>
                      </span>
                      <Select label="The notice was" name="kind" defaultValue="received" options={[{ value: 'received', label: 'Received by the client' }, { value: 'sent', label: 'Sent (receipt presumed)' }]} />
                      <Field label="Date on the notice" name="date" type="date" required max={today} />
                      <SubmitButton variant="secondary" className="btn-sm">Record</SubmitButton>
                    </ActionForm>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {canWrite && (
            <details className="group/other border-t border-line pt-3">
              <summary className="flex w-fit cursor-pointer list-none items-center gap-1 rounded-md text-[0.8125rem] font-semibold text-brand-strong [&::-webkit-details-marker]:hidden">
                A collector that is not on a report <ChevronDown size={14} aria-hidden className="transition-transform group-open/other:rotate-180" />
              </summary>
              <ActionForm action={recordCollectorNoticeAction} resetOnSuccess className="mt-3 grid gap-3 sm:grid-cols-3">
                <input type="hidden" name="clientId" value={clientId} />
                <Field label="Collector name" name="collectorName" required maxLength={200} />
                <Select label="The notice was" name="kind" defaultValue="received" options={[{ value: 'received', label: 'Received by the client' }, { value: 'sent', label: 'Sent by the collector (receipt is presumed)' }]} />
                <Field label="Date on the notice" name="date" type="date" required max={today} />
                <div className="sm:col-span-3"><SubmitButton variant="secondary">Record notice</SubmitButton></div>
              </ActionForm>
            </details>
          )}
        </Tool>

        {collections.length > 0 && (
          <Tool title="Medical collections" tone={medicalToCheck ? 'warn' : 'neutral'} badge={medicalToCheck ? `${medicalToCheck} worth checking` : 'Nothing flagged'}>
            <p className="text-muted">
              The three nationwide bureaus have said they generally do not report medical collections that are paid, that had an initial balance under $500, or that are less than one year old ({MEDICAL_POLICY_SOURCE}).
              This is bureau policy, not law: a federal rule on medical debt reporting was vacated by a court on July 11, 2025. Check the dates and amounts against the client’s records.
            </p>
            <ActionForm action={setMedicalFlagsAction} className="space-y-2.5">
              <input type="hidden" name="clientId" value={clientId} />
              {medical.map(({ t, basis, tests }) => (
                <div key={t.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
                  <input type="hidden" name="listed" value={t.id} />
                  <Check name="medical" value={t.id} defaultChecked={basis === 'staff' || basis === 'report'}>
                    <span className="font-medium">{label(t)}</span> <span className="text-muted">· {BUREAU_LABEL[t.bureau]}{t.balance_cents != null ? ` · ${money(t.balance_cents)}` : ''} · this is a medical debt</span>
                  </Check>
                  <span className="flex flex-wrap gap-1.5">
                    {t.medical_flag == null && reportSaysMedical(t) && <Badge tone="info">Report says medical</Badge>}
                    {t.medical_flag == null && basis === 'name' && <Badge tone="info">Name suggests medical: tick it if it is</Badge>}
                    {(basis === 'staff' || basis === 'report') && tests.length > 0 && <Badge tone="warn">Worth checking: {tests.map((k) => TEST_LABEL[k]).join(', ')}</Badge>}
                  </span>
                </div>
              ))}
              <p className="hint">Ticked automatically when the report’s account type, remarks or original creditor say medical. When only the collector’s name suggests it, the account is marked but left for you to tick. Untick any that are not medical, tick the ones the client’s records show are, and save.</p>
              {canWrite && <SubmitButton variant="secondary">Save medical debts</SubmitButton>}
            </ActionForm>
          </Tool>
        )}

        <Tool title="Bankruptcy" tone={auditToCheck ? 'warn' : d.bankruptcy ? 'info' : bk || d.onReports.accounts ? 'warn' : 'neutral'}
          badge={d.bankruptcy ? `Chapter ${d.bankruptcy.chapter}${d.bankruptcy.dischargedOn ? (auditToCheck ? ` · ${auditToCheck} worth checking` : ' · discharged') : ' · no discharge date'}` : bk ? 'On a report: not recorded' : d.onReports.accounts ? 'Mentioned on the reports' : 'None recorded'}>
          <p className="text-muted">Entered by staff from the client’s bankruptcy papers. No court record is read, and only those papers show which debts were discharged.</p>
          {!d.bankruptcy && bk && (
            <p>
              Filled in below from the reports: {bankruptcyRecordText(bk)}.{bk.chapter ? '' : ' Its chapter is not 7 or 13, so choose it from the papers.'} Check it against the client’s papers, add the discharge date if there is one, and save.
            </p>
          )}
          {!d.bankruptcy && !bk && d.onReports.accounts > 0 && (
            <p>{d.onReports.accounts === 1 ? 'An account' : `${d.onReports.accounts} accounts`} on the reports {d.onReports.accounts === 1 ? 'is' : 'are'} reported as included in a bankruptcy, but no bankruptcy record is on them. If the client filed, enter it from their papers.</p>
          )}
          {d.bankruptcy && fallOff && (
            <p>
              The bankruptcy itself may generally be reported until <span className="font-medium tabular-nums">{fmtDate(fallOff.statute)}</span>, 10 years from the filing date (15 U.S.C. § 1681c(a)(1)).
              {fallOff.policy && <> Experian and TransUnion say they remove a Chapter 13 bankruptcy 7 years after filing, which would be <span className="font-medium tabular-nums">{fmtDate(fallOff.policy)}</span>: their own policy, not the statute.</>}
            </p>
          )}
          {d.bankruptcy?.dischargedOn && (audit.length === 0 ? (
            <p className="text-muted">No account on the latest approved reports has a date before the filing date.</p>
          ) : (
            <>
              <p className="text-muted">Accounts dated before the filing. A discharged account is generally expected to show a zero balance and a status that reflects the bankruptcy, with no new delinquency after the filing.</p>
              <ul className="divide-y divide-line/70 rounded-xl border border-line px-3.5">
                {audit.map((r) => (
                  <li key={r.line.id} className="py-2.5">
                    <span className="font-medium [overflow-wrap:anywhere]">{label(r.line)}</span> <span className="text-[0.8125rem] text-muted">· {BUREAU_LABEL[r.line.bureau]}</span>
                    <span className="block text-[0.8125rem] text-muted">
                      {r.result === 'not_checked' ? 'Reported in good standing with no mention of the bankruptcy. Not checked: it may not have been part of it.'
                        : r.notes.length ? `Worth checking: ${r.notes.map((k) => AUDIT_NOTE_TEXT[k](r.line)).join('; ')}.`
                          : 'Zero or no balance shown, and the status mentions the bankruptcy.'}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          ))}
          {d.bankruptcy && !d.bankruptcy.dischargedOn && <p className="text-muted">Accounts are compared once a discharge date is entered.</p>}
          {canWrite && (
            <ActionForm action={setBankruptcyAction} className="grid gap-3 border-t border-line pt-3 sm:grid-cols-3">
              <input type="hidden" name="clientId" value={clientId} />
              <Select label="Chapter" name="chapter" defaultValue={d.bankruptcy?.chapter ?? bk?.chapter ?? ''} placeholder="No bankruptcy" options={[{ value: '7', label: 'Chapter 7' }, { value: '13', label: 'Chapter 13' }]} />
              <Field label="Filing date" name="filedOn" type="date" defaultValue={d.bankruptcy?.filedOn ?? (bk?.filedOn && bk.filedOn <= today ? bk.filedOn : undefined)} max={today} />
              <Field label="Discharge date" name="dischargedOn" type="date" defaultValue={d.bankruptcy?.dischargedOn} max={today} hint="Leave empty if not discharged." />
              <div className="sm:col-span-3"><SubmitButton variant="secondary">Save bankruptcy</SubmitButton></div>
            </ActionForm>
          )}
        </Tool>
      </ul>
    </Section>
  );
}
