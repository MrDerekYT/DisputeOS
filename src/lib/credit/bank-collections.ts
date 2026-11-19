/**
 * "Bank account sent to collections": a short guide for an overdrawn or closed bank account. Staff answer a few plain
 * questions with the client, and the steps that apply are laid out as ordinary items with links to the tools that
 * already exist (specialty reports, collector notices, disputes, letters). Nothing is automatic: no dispute or letter
 * is created from here, and nothing is sent.
 *
 * The rule the steps follow: only a detail the client says is inaccurate is disputed. When the client says the record
 * is accurate, no dispute is offered at all (15 U.S.C. § 1679b(a)(1)), and no validation request either (that letter
 * disputes the debt); what is left is a request the bank is free to decline.
 */
import type { Db } from '../db';
import { audit } from '../audit';
import { logEvent } from '../crm';
import { UserError } from '../errors';
import { can, PermissionError, type Role } from '../rbac';
import { agencyByKey, type SpecialtyReportState } from './agencies';
import { FALL_OFF_RULE_TEXT } from './reporting-period';

export const BANK_DETAILS = ['amount', 'dates', 'ownership', 'paid_status'] as const;
export type BankDetail = (typeof BANK_DETAILS)[number];
export const BANK_DETAIL_LABEL: Record<BankDetail, string> = { amount: 'The amount', dates: 'The dates', ownership: 'Whose account it is', paid_status: 'Whether it is shown as paid' };
/** The bureau letter written for each detail (src/lib/letters/library.ts). */
const DETAIL_LETTER: Record<BankDetail, string> = { amount: 'Inaccurate balance', dates: 'Inaccurate payment history or dates', ownership: 'Not my account', paid_status: 'Inaccurate account status' };
type Answer = 'yes' | 'no' | 'unsure';

export interface BankCase { id: string; bankName: string; chargeAccurate: Answer; inaccurateDetails: BankDetail[]; paid: 'yes' | 'no'; onCreditReports: Answer }
export interface BankStep { key: string; title: string; body: string; links?: { href: string; label: string }[] }
/** The two bank-account reporting agencies. */
export const BANK_AGENCIES = ['chexsystems', 'early_warning'] as const;

const list = (xs: string[]) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

/**
 * The steps for one account, from the recorded answers. Pure. `reports` is what is already recorded about the client's
 * ChexSystems and Early Warning disclosures (clients.specialty_reports).
 */
export function bankCollectionSteps(c: BankCase, x: { clientId: string; reports: Record<string, SpecialtyReportState> }): { accurate: boolean; steps: BankStep[] } {
  const base = `/app/clients/${x.clientId}?tab=reports`;
  const steps: BankStep[] = [];
  const agencies = BANK_AGENCIES.map((k) => agencyByKey(k)!);
  const details = c.chargeAccurate === 'yes' ? [] : c.inaccurateDetails;
  const accurate = c.chargeAccurate === 'yes';

  // 1. The specialty reports: a closed bank account is reported there, not only (or not at all) to the credit bureaus.
  const waiting = agencies.filter((a) => x.reports[a.key]?.status !== 'received');
  steps.push(waiting.length ? {
    key: 'reports', title: `Request the ${list(waiting.map((a) => a.shortName))} report${waiting.length > 1 ? 's' : ''}`,
    body: `A closed or overdrawn bank account is generally reported to a bank-account reporting agency, whether or not it also appears on a credit report. The client asks for each free disclosure themselves. ${waiting.map((a) => `${a.shortName}: ${a.disclosure.how.en}`).join(' ')} Record each one under “Specialty reports” when it is requested and when it arrives.`,
    links: [{ href: `${base}#specialty`, label: 'Specialty reports' }],
  } : {
    key: 'reports', title: 'The ChexSystems and Early Warning reports are on file',
    body: `Read how ${c.bankName} appears on each one before anything else: the amount, the dates and whether it is shown as paid.`,
    links: [{ href: `${base}#specialty`, label: 'Specialty reports' }],
  });

  // 2. The collector's notice starts a separate, 30-day clock.
  steps.push({
    key: 'notice', title: 'Record the collector’s notice, if one has arrived',
    body: `When a debt collector first writes to the client about this account, record the date. The validation period generally ends 30 days after the client receives that notice, and it is a separate deadline from any credit-report dispute. ${accurate
      ? 'The client says this debt is accurate, so no validation request is sent about it: that letter disputes the debt.'
      : 'If the client questions the debt, a validation request can be drafted as soon as the notice is recorded, whether or not the collection is on a credit report yet. It cites the 30-day right only while that period is open.'}`,
    links: [{ href: `${base}#case-tools`, label: 'Collector notices' }],
  });

  if (c.chargeAccurate === 'unsure') {
    steps.push({
      key: 'confirm', title: 'Confirm the details with the client’s own records',
      body: `Ask the client for the closing statement from ${c.bankName} or the collector’s notice, and compare the amount, the dates and whether it was paid with what is reported. Nothing is disputed until the client can say which detail is wrong.`,
    });
  } else if (!accurate && details.length === 0) {
    steps.push({
      key: 'which', title: 'Ask which detail is inaccurate',
      body: 'The client says the record is not accurate, but no detail is recorded yet. Ask whether it is the amount, the dates, whose account it is, or whether it is shown as paid, then record the answer here. A dispute names the specific detail and the client’s reason.',
    });
  }

  if (details.length) {
    // 3. Dispute only what the client says is inaccurate, with whoever reports it.
    const what = list(details.map((d) => BANK_DETAIL_LABEL[d].toLowerCase()));
    if (c.onCreditReports !== 'no') {
      steps.push({
        key: 'bureau', title: 'Dispute the inaccurate detail with the credit bureau',
        body: `${c.onCreditReports === 'unsure' ? 'If a collection account for this debt is on the client’s credit reports, start' : 'Start'} a dispute from that account on the report. Dispute only what the client says is inaccurate (${what}), in the client’s own reason, with a copy of any record that shows it. Letters to use: ${list(details.map((d) => `“${DETAIL_LETTER[d]}”`))}.`,
        links: [{ href: `/app/disputes/new?clientId=${x.clientId}`, label: 'New dispute' }],
      });
    }
    steps.push({
      key: 'specialty', title: 'Dispute the same detail with ChexSystems or Early Warning, where it is reported',
      body: `Once the disclosure has arrived and shows the account, enter the item exactly as the disclosure prints it and state what is inaccurate (${what}). The letter is the account-record dispute for that agency. Details the client agrees with are left alone.`,
      links: agencies.map((a) => ({ href: `/app/disputes/new?clientId=${x.clientId}&agency=${a.key}`, label: `${a.shortName} item` })),
    });
  }

  if (accurate) {
    // 4. Accurate: say so plainly. No dispute is offered; only requests the bank may decline, and the client's statement.
    steps.push({
      key: 'accurate', title: 'The record is accurate, so there is nothing to dispute',
      body: 'The client says the overdraft and the amounts are reported correctly. Accurate information is not disputed, and no dispute is offered for this account. What remains is a request the bank is free to decline.',
    });
    steps.push(c.paid === 'yes' ? {
      key: 'update', title: 'Ask that the reporting show the account as paid',
      body: `A request to ${c.bankName}, or to the collector that was paid, to update what it reports so that it reflects the payment accurately: the balance and the paid status. It asks for an accurate update and nothing else.`,
      links: [{ href: `/app/letters/new?clientId=${x.clientId}&templateKey=payment_update_en`, label: 'Request to update a paid account' }],
    } : {
      key: 'update', title: 'A paid-account update applies once the account is paid',
      body: 'The account is recorded as not paid, so there is no payment for the reporting to reflect yet. If the client pays it, a request to update the reporting can be drafted then. Whether to pay is the client’s decision.',
    });
    steps.push({
      key: 'goodwill', title: 'A goodwill request',
      body: `A courtesy letter to ${c.bankName} that accepts the record is accurate and asks it to consider an adjustment. No right is asserted; the bank decides and may decline.`,
      links: [{ href: `/app/letters/new?clientId=${x.clientId}&templateKey=goodwill_en`, label: 'Goodwill request' }],
    });
    // 15 U.S.C. § 1681i(b): the statement of dispute follows a reinvestigation that did not resolve a dispute. Nothing is
    // disputed in this branch, so it is not offered as a right here; whether an agency takes a general statement is its
    // own practice, which is not confirmed at a source (src/lib/credit/protections.ts), so the client is told to ask.
    steps.push({
      key: 'statement', title: 'A consumer statement, and when it applies',
      body: 'A consumer may generally file a brief statement of dispute when a reinvestigation did not resolve a dispute. Nothing is disputed here, so that does not apply to this account as it stands. Some agencies also accept a general statement from a consumer: the client can ask ChexSystems or Early Warning whether it does. A statement does not change how the account is reported.',
      links: [{ href: `${base}#protections`, label: 'Freezes, alerts and opt-outs' }],
    });
    // 5. When such records generally stop being reported. A period is stated only where it has a recorded source.
    const sourced = agencies.filter((a) => a.recordRetention);
    const unsourced = agencies.filter((a) => !a.recordRetention);
    steps.push({
      key: 'period', title: 'How long the record is reported',
      body: [
        ...sourced.map((a) => `${a.shortName}: ${a.recordRetention!.text} (read on its site on ${a.recordRetention!.verifiedOn}).`),
        unsourced.length ? `${list(unsourced.map((a) => a.shortName))} ${unsourced.length > 1 ? 'each publish' : 'publishes'} how long a closed-account record is kept. That period is not stated here because it has not been confirmed at its source: read it on the agency’s own site, or on the disclosure itself.` : '',
        `On a credit report, a collection account is generally reported for ${FALL_OFF_RULE_TEXT.seven_years_plus_180_days} (15 U.S.C. § 1681c). The dates worked out for this client’s accounts are under “Aging off”.`,
      ].filter(Boolean).join(' '),
      links: [...unsourced.map((a) => ({ href: a.disclosure.url, label: `${a.shortName} site` })), { href: `${base}#aging-off`, label: 'Aging off' }],
    });
  }
  return { accurate, steps };
}

// ---------------------------------------------------------------- the recorded answers

export interface BActor { orgId: string; userId: string; role: Role; meta?: { ip?: string | null } }

export async function loadBankCases(db: Db, clientId: string): Promise<BankCase[]> {
  return db.rows<BankCase>(
    `select id, bank_name as "bankName", charge_accurate as "chargeAccurate", inaccurate_details as "inaccurateDetails", paid, on_credit_reports as "onCreditReports"
       from public.bank_collection_cases where client_id = $1 order by created_at desc`, [clientId]);
}

export async function saveBankCase(db: Db, actor: BActor, clientId: string, input: { bankName: string; chargeAccurate: string; inaccurateDetails: string[]; paid: string; onCreditReports: string }): Promise<string> {
  if (!can(actor.role, 'clients:write')) throw new PermissionError('clients:write');
  const name = input.bankName.replace(/\s+/g, ' ').trim().slice(0, 160);
  if (!name) throw new UserError('Enter the name of the bank or credit union.');
  const answer = (v: string): Answer => (v === 'yes' || v === 'no' ? v : 'unsure');
  const chargeAccurate = answer(input.chargeAccurate);
  // Details are what the client says is wrong, so none are kept when the client says the record is accurate.
  const details = chargeAccurate === 'yes' ? [] : BANK_DETAILS.filter((d) => input.inaccurateDetails.includes(d));
  const client = await db.row<{ id: string }>('select id from public.clients where id = $1', [clientId]);
  if (!client) throw new UserError('Client not found.');
  const row = await db.row<{ id: string }>(
    'insert into public.bank_collection_cases (org_id, client_id, bank_name, charge_accurate, inaccurate_details, paid, on_credit_reports, created_by) values ($1,$2,$3,$4,$5,$6,$7,$8) returning id',
    [actor.orgId, clientId, name, chargeAccurate, details, input.paid === 'yes' ? 'yes' : 'no', answer(input.onCreditReports), actor.userId]);
  await logEvent(db, actor, clientId, 'case_tools', `Bank account sent to collections recorded: ${name}`);
  await audit(db, { orgId: actor.orgId, actorId: actor.userId, action: 'client.bank_case', entityType: 'client', entityId: clientId, ip: actor.meta?.ip, meta: { case_id: row!.id } });
  return row!.id;
}

export async function removeBankCase(db: Db, actor: BActor, clientId: string, caseId: string): Promise<void> {
  if (!can(actor.role, 'clients:write')) throw new PermissionError('clients:write');
  await db.run('delete from public.bank_collection_cases where id = $1 and client_id = $2', [caseId, clientId]);
}
