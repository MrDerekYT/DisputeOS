/**
 * A short, deterministic action plan for one client, built only from that client's own records.
 * Same input, same plan: no AI, no estimates. It never predicts a score or an outcome — the card usage step is
 * plain arithmetic on reported balances and limits, and dispute steps are optional and limited to information the
 * client believes is inaccurate.
 */
import { snapshot, type WAccount } from './credit/what-if';
import type { Db } from './db';
import { loadServiceStatus } from './agreements';
import { CONSENT_DOCS } from './compliance/disclosures';
import { loadIntake } from './intake-load';
import { intakeSummary } from './intake';
import { BUREAU_LABEL, fmtDate, money, type Bureau } from './util';
import { agencyByKey, CONCERN_AGENCIES, specialtyReportStates } from './credit/agencies';
import { openValidationWindows } from './credit/case-tools';

export interface PlanStep { key: string; title: string; detail: string; href?: string; tone: 'ok' | 'warn' | 'info' | 'neutral' }

export interface PlanInput {
  clientId: string;
  firstName: string;
  /** Personal workspace: the owner is working on their own credit, so steps say "you" instead of the client's name. */
  self?: boolean;
  /** Reports on file that are usable or awaiting review; rejected ones do not count. */
  reports: number;
  reportsPendingReview: number;
  /**
   * Titles of the documents the service needs that are not in force: what the server's gate refuses a submission
   * without (src/lib/agreements.ts, loadServiceStatus). Always empty in a personal workspace.
   */
  missingConsents: string[];
  /** Labels of required identity documents that are not accepted yet (missing, awaiting review, rejected or out of date). */
  missingIdentityDocs?: string[];
  findingsToReview: number;
  /** Creditor names of collection accounts on the latest approved reports that have no dispute yet. */
  collections: string[];
  /** Accounts from the single most recent approved report (one bureau, so nothing is counted twice). */
  accounts: WAccount[];
  /** Bureau of that report; the card usage step names it and links to the same report in the what-if view. */
  accountsBureau?: Bureau | null;
  disputesOverdue: number;
  disputesDueSoon: number;
  lettersToSend: number;
  /** Short names of the specialty reports (ChexSystems, LexisNexis) still to request. Filled only when staff marked a banking or background concern. */
  specialtyToRequest?: string[];
  /** Collector notices whose 30-day validation period (12 CFR 1006.34(b)(5)) is still open, soonest end first. */
  validationWindows?: { collector: string; endsOn: string; daysLeft: number }[];
}

export const MAX_PLAN_STEPS = 6;
export const USAGE_THRESHOLD_PCT = 30;

const n = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/** Smallest payment (in cents) that brings revolving usage strictly under 30% of the reported limits. */
export function payToGetUnder30(balanceCents: number, limitCents: number): number {
  const highestBalanceUnder = Math.ceil((limitCents * USAGE_THRESHOLD_PCT) / 100) - 1;
  return Math.max(0, balanceCents - highestBalanceUnder);
}

export function buildPlan(x: PlanInput): PlanStep[] {
  const tab = (k: string) => `/app/clients/${x.clientId}?tab=${k}`;
  const who = x.self ? 'you' : x.firstName;
  const doNot = x.self ? 'do not' : 'does not';
  const steps: PlanStep[] = [];

  if (x.reports === 0) {
    steps.push({ key: 'get-reports', tone: 'warn', href: tab('reports'), title: 'Get the free credit reports',
      detail: `No credit report is on file yet. ${x.self ? 'You' : x.firstName} can request free reports from all three bureaus at AnnualCreditReport.com, then upload or import them here.` });
  } else if (x.reportsPendingReview > 0) {
    steps.push({ key: 'review-reports', tone: 'warn', href: tab('reports'), title: `Check ${n(x.reportsPendingReview, 'imported report')}`,
      detail: 'Confirm the accounts were read correctly and approve the report. Findings and the steps below use approved reports only.' });
  }

  // A personal workspace is no credit repair organization and makes no agreement with itself: nothing to collect.
  if (!x.self && x.missingConsents.length > 0) {
    steps.push({ key: 'consents', tone: 'warn', href: `${tab('overview')}#compliance`, title: `Collect ${n(x.missingConsents.length, 'required consent')}`,
      detail: `Not on file: ${x.missingConsents.join('; ')}. A dispute cannot be submitted until these are signed.` });
  }

  // A dated window under the FDCPA, separate from any credit-report dispute. Shown early because the date does not move.
  const win = x.validationWindows?.[0];
  if (win) {
    steps.push({ key: 'validation-period', tone: 'warn', href: `${tab('reports')}#case-tools`, title: `Collector notice from ${win.collector}: validation period ends ${fmtDate(win.endsOn)}`,
      detail: `${win.daysLeft === 0 ? 'Today is the last day' : `${n(win.daysLeft, 'day')} left`} to send a written validation request within the period. This applies only if ${who} ${x.self ? 'question' : 'questions'} the debt; it is a different deadline from a dispute with a credit bureau.` });
  }

  const idDocs = x.missingIdentityDocs ?? [];
  if (idDocs.length > 0) {
    steps.push({ key: 'identity-docs', tone: 'warn', href: `${tab('documents')}#intake`, title: `Collect ${n(idDocs.length, 'identity document')}`,
      detail: `Not accepted yet: ${idDocs.join('; ')}. Credit bureaus usually ask for these with a mailed dispute, so it helps to have them on file before the first letter goes out.` });
  }

  const specialty = x.specialtyToRequest ?? [];
  if (specialty.length > 0) {
    steps.push({ key: 'specialty-reports', tone: 'info', href: `${tab('reports')}#specialty`, title: `Request the ${specialty.join(' and ')} ${specialty.length === 1 ? 'report' : 'reports'}`,
      detail: `These are free to request and are separate from the three credit reports. ${x.self ? 'You' : x.firstName} can ask each agency directly; the links are under Specialty reports. They show what is on file, which is the place to start.` });
  }

  if (x.findingsToReview > 0) {
    steps.push({ key: 'findings', tone: 'info', href: `/app/clients/${x.clientId}/compare`, title: `Review ${n(x.findingsToReview, 'finding')}`,
      detail: 'Each finding shows the reported values it is based on. Accept only the ones that point to information that looks inaccurate; dismiss the rest.' });
  }

  if (x.collections.length > 0) {
    const names = x.collections.slice(0, 3).join(', ') + (x.collections.length > 3 ? ` and ${x.collections.length - 3} more` : '');
    steps.push({ key: 'collections', tone: 'info', href: tab('reports'), title: `Look at ${n(x.collections.length, 'collection account')}`,
      detail: `Reported by ${names}. If ${who} ${doNot} recognise a debt, consider asking the collector to validate it. If the account is reported accurately, there is nothing to dispute.` });
  }

  const s = snapshot(x.accounts);
  if (s.utilizationPct != null && s.revolvingBalanceCents * 100 >= s.revolvingLimitCents * USAGE_THRESHOLD_PCT) {
    const pay = payToGetUnder30(s.revolvingBalanceCents, s.revolvingLimitCents);
    steps.push({ key: 'card-usage', tone: 'info', href: `/app/clients/${x.clientId}/what-if${x.accountsBureau ? `?bureau=${x.accountsBureau}` : ''}`, title: `Card usage is ${s.utilizationPct}% of reported limits`,
      detail: `${money(s.revolvingBalanceCents)} owed on ${money(s.revolvingLimitCents)} of limits across ${n(s.revolvingAccounts, 'open card')}${x.accountsBureau ? ` on the latest ${BUREAU_LABEL[x.accountsBureau]} report` : ''}. `
        + `Paying ${money(pay)} toward these balances would put usage under ${USAGE_THRESHOLD_PCT}%. This is arithmetic on reported figures, not a prediction of any credit score.` });
  }

  if (x.disputesOverdue > 0) {
    steps.push({ key: 'follow-up', tone: 'warn', href: tab('disputes'), title: `Follow up on ${n(x.disputesOverdue, 'dispute')} past the response date`,
      detail: 'No response has been recorded. Check the mail for a reply and record it, or consider sending a follow-up.' });
  } else if (x.disputesDueSoon > 0) {
    steps.push({ key: 'follow-up', tone: 'info', href: tab('disputes'), title: `${n(x.disputesDueSoon, 'response')} due within 7 days`,
      detail: 'Watch the mail for the reply and record it when it arrives. You may follow up if the response date passes.' });
  }

  if (x.lettersToSend > 0) {
    steps.push({ key: 'send-letters', tone: 'warn', href: tab('letters'), title: `Send ${n(x.lettersToSend, 'approved letter')}`,
      detail: 'Approved but not marked as sent. The response clock starts only once a letter is actually sent.' });
  }

  if (steps.length === 0) {
    return [{ key: 'caught-up', tone: 'ok', href: tab('reports'), title: 'All caught up', detail: 'Nothing is waiting right now. The next check is when a new credit report arrives.' }];
  }
  return steps.slice(0, MAX_PLAN_STEPS);
}

/** Reads everything buildPlan needs for one client. Run inside the caller's tenant transaction (row-level security applies). */
export async function loadPlanInput(db: Db, clientId: string): Promise<Omit<PlanInput, 'firstName' | 'self'>> {
  const counts = await db.row<{ reports: number; pending: number; findings: number; overdue: number; due_soon: number; letters: number }>(
    `select (select count(*)::int from public.credit_reports where client_id = $1 and status <> 'rejected') as reports,
            (select count(*)::int from public.credit_reports where client_id = $1 and status = 'pending_review') as pending,
            (select count(*)::int from public.findings where client_id = $1 and status = 'suggested') as findings,
            (select count(*)::int from public.disputes where client_id = $1 and status in ('submitted','under_investigation') and due_at < now()) as overdue,
            (select count(*)::int from public.disputes where client_id = $1 and status in ('submitted','under_investigation') and due_at >= now() and due_at < now() + interval '7 days') as due_soon,
            (select count(*)::int from public.letters where client_id = $1 and status = 'approved') as letters`, [clientId]);
  // The documents the gate on submitting and sending requires: none in a personal workspace.
  const service = await loadServiceStatus(db, clientId);
  // Latest approved report per bureau, newest first.
  const latest = await db.rows<{ id: string; bureau: Bureau }>(
    `select id, bureau from (select distinct on (bureau) id, bureau, coalesce(report_date, created_at::date) as d, created_at from public.credit_reports
        where client_id = $1 and status = 'approved' and bureau is not null order by bureau, coalesce(report_date, created_at::date) desc, created_at desc) r
      order by d desc, created_at desc`, [clientId]);
  const ids = latest.map((r) => r.id);
  // Each import inserts new tradeline rows, so "already has a dispute" is matched by account (match_key), not by row.
  const collections = ids.length ? await db.rows<{ creditor_name: string }>(
    `select min(t.creditor_name) as creditor_name from public.tradelines t
      where t.report_id = any($1::uuid[]) and t.item_type = 'collection' and not exists (
        select 1 from public.disputes d join public.tradelines t2 on t2.id = d.tradeline_id
         where t2.id = t.id or (t.match_key <> '' and t2.client_id = t.client_id and t2.bureau = t.bureau and t2.match_key = t.match_key))
      group by lower(t.creditor_name) order by 1`, [ids]) : [];
  const rows = latest[0] ? await db.rows<{ creditor_name: string; account_type: string | null; account_status: string | null; balance_cents: string | null; credit_limit_cents: string | null; date_opened: string | null }>(
    'select creditor_name, account_type, account_status, balance_cents, credit_limit_cents, date_opened from public.tradelines where report_id = $1', [latest[0].id]) : [];
  const c = counts!;
  return {
    clientId, reports: c.reports, reportsPendingReview: c.pending, findingsToReview: c.findings, disputesOverdue: c.overdue, disputesDueSoon: c.due_soon, lettersToSend: c.letters,
    missingConsents: (service?.missing ?? []).map((k) => CONSENT_DOCS.find((d) => d.kind === k)?.title.split(' (')[0] ?? k),
    missingIdentityDocs: intakeSummary(await loadIntake(db, clientId)).notAccepted.map((st) => st.item.label.en),
    collections: collections.map((r) => r.creditor_name),
    accounts: rows.map((r) => ({ creditor: r.creditor_name, type: r.account_type, status: r.account_status, balanceCents: r.balance_cents == null ? null : Number(r.balance_cents), limitCents: r.credit_limit_cents == null ? null : Number(r.credit_limit_cents), opened: r.date_opened })),
    accountsBureau: latest[0]?.bureau ?? null,
    specialtyToRequest: await specialtyToRequest(db, clientId),
    validationWindows: await openValidationWindows(db, clientId),
  };
}

/** The specialty reports to suggest: none unless staff ticked the banking or background concern on the client record. */
async function specialtyToRequest(db: Db, clientId: string): Promise<string[]> {
  const c = await db.row<{ banking_concern: boolean; specialty_reports: unknown }>('select banking_concern, specialty_reports from public.clients where id = $1', [clientId]);
  if (!c?.banking_concern) return [];
  const states = specialtyReportStates(c.specialty_reports);
  return CONCERN_AGENCIES.filter((k) => states[k]?.status === 'not_requested').map((k) => agencyByKey(k)!.shortName);
}
