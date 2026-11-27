/**
 * What the client assistant knows: the workspace's own records, read under the caller's row-level security.
 *
 *   loadRosterNames    every client the caller can see, by name, for finding who a question is about;
 *   loadRoster         one line of facts per client (the most recently active, plus the ones the question names);
 *   loadWorkspaceFacts the counts that answer a question naming nobody;
 *   loadClientFile     one client's file, as short lines.
 *
 * Every query also filters on the organization of the signed-in session. The text built here is the only thing an AI
 * provider is given about a client, and the same lines are shown on the page as "what the assistant read". Contact
 * details are read for the card on the page only: no builder in this file puts them in a line (see ./mask.ts for what
 * is removed from free text, and tests/unit/assistant.test.ts for the check).
 */
import { agreementProgress, docTitle, type SignatureRow } from '../agreements';
import { STATUS_LABEL as CLIENT_STATUS_LABEL } from '../client-progress';
import { isNegative } from '../credit/reporting-period';
import { DOC_KIND_LABEL, STAGE_LABEL } from '../crm';
import { decryptPII } from '../crypto';
import type { Db } from '../db';
import { OUTCOME_LABEL, STATUS_LABEL as DISPUTE_STATUS_LABEL } from '../disputes/workflow';
import type { Redaction } from '../guide/llm';
import { clientIdentifiers, type ClientIdentity } from '../guide/steps';
import { BUREAU_LABEL, fmtDate, money } from '../util';
import { last4, safeLabel, safeText } from './mask';
import type { RosterName } from './match';

/** Names are matched against at most this many clients, the most recently active first. */
export const ROSTER_NAMES_MAX = 5000;
/** Roster lines given to the AI provider, the most recently active first, plus every client the question names. */
export const ROSTER_LINES_MAX = 400;
const NAMES_LISTED = 25;

const OPEN_DISPUTE = "('submitted', 'under_investigation', 'response_received')";
const OVERDUE_DISPUTE = "('submitted', 'under_investigation')";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** A stored code as words: "pending_review" is "Pending review". */
const words = (code: string | null | undefined): string => {
  const t = (code ?? '').replace(/[_-]+/g, ' ').trim();
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : '';
};
const lookup = (map: Record<string, string>, code: string) => map[code] ?? words(code);
const bureauName = (b: string | null) => (b ? lookup(BUREAU_LABEL, b) : 'Bureau not set');

// ---------------------------------------------------------------- roster

export async function loadRosterNames(db: Db, orgId: string): Promise<{ names: RosterName[]; total: number }> {
  const names = await db.rows<RosterName>(
    'select id, full_name from public.clients where org_id = $1 order by last_activity_at desc, id limit $2', [orgId, ROSTER_NAMES_MAX]);
  const total = names.length < ROSTER_NAMES_MAX ? names.length
    : (await db.row<{ n: number }>('select count(*)::int as n from public.clients where org_id = $1', [orgId]))?.n ?? names.length;
  return { names, total };
}

export interface RosterRow {
  id: string; full_name: string; status: string; stage: string; specialist: string | null; last_activity_at: string;
  open_disputes: number; overdue_disputes: number; pending_reports: number; open_tasks: number;
  /** Lines with negative information on the latest approved report from each bureau. */
  negative_items: number;
}

interface NegativeSource { client_id: string; item_type: string; account_status: string | null; payment_status: string | null; payment_history: string | null }

/** The latest approved report from each bureau, for each of `clientIds`: the reports the app treats as the client's current ones. */
const CURRENT_REPORTS = `select distinct on (r.client_id, r.bureau) r.id from public.credit_reports r
  where r.org_id = $1 and r.client_id = any($2::uuid[]) and r.status = 'approved' and r.bureau is not null
  order by r.client_id, r.bureau, coalesce(r.report_date, r.created_at::date) desc, r.created_at desc`;

export async function loadRoster(db: Db, orgId: string, alwaysIds: string[], now: Date, limit = ROSTER_LINES_MAX): Promise<RosterRow[]> {
  const rows = await db.rows<Omit<RosterRow, 'negative_items'>>(
    `with picked as (
       select id from (select id from public.clients where org_id = $1 order by last_activity_at desc, id limit $2) recent
       union
       select id from public.clients where org_id = $1 and id = any($3::uuid[])
     )
     select c.id, c.full_name, c.status, c.stage, u.full_name as specialist, c.last_activity_at,
            (select count(*)::int from public.disputes d where d.client_id = c.id and d.status in ${OPEN_DISPUTE}) as open_disputes,
            (select count(*)::int from public.disputes d where d.client_id = c.id and d.status in ${OVERDUE_DISPUTE} and d.due_at < $4) as overdue_disputes,
            (select count(*)::int from public.credit_reports r where r.client_id = c.id and r.status = 'pending_review') as pending_reports,
            (select count(*)::int from public.tasks t where t.client_id = c.id and t.status = 'open') as open_tasks
       from public.clients c join picked p on p.id = c.id left join public.users u on u.id = c.assigned_to
      where c.org_id = $1
      order by c.last_activity_at desc, c.id`,
    [orgId, limit, alwaysIds, now]);
  if (!rows.length) return [];
  const lines = await db.rows<NegativeSource>(
    `select t.client_id, t.item_type, t.account_status, t.payment_status, t.payment_history from public.tradelines t
      where t.org_id = $1 and t.client_id = any($2::uuid[]) and t.report_id in (${CURRENT_REPORTS})`,
    [orgId, rows.map((r) => r.id)]);
  const negative = new Map<string, number>();
  for (const t of lines) if (isNegative(t)) negative.set(t.client_id, (negative.get(t.client_id) ?? 0) + 1);
  return rows.map((r) => ({ ...r, negative_items: negative.get(r.id) ?? 0 }));
}

// ---------------------------------------------------------------- workspace facts

export interface NamedCount { id: string; name: string; n: number }
export interface WorkspaceFacts {
  total: number;
  byStatus: { status: string; n: number }[];
  /** Clients with a dispute past its due date, the longest overdue first: at most NAMES_LISTED of `overdueClients`. */
  overdue: NamedCount[];
  overdueClients: number;
  /** Clients with a report waiting for review, the longest waiting first: at most NAMES_LISTED of `pendingClients`. */
  pending: NamedCount[];
  pendingClients: number;
}

export async function loadWorkspaceFacts(db: Db, orgId: string, now: Date): Promise<WorkspaceFacts> {
  const byStatus = await db.rows<{ status: string; n: number }>(
    'select status, count(*)::int as n from public.clients where org_id = $1 group by status order by count(*) desc, status', [orgId]);
  const overdue = await db.rows<NamedCount & { of: number }>(
    `select c.id, c.full_name as name, count(*)::int as n, (count(*) over ())::int as of
       from public.disputes d join public.clients c on c.id = d.client_id
      where d.org_id = $1 and c.org_id = $1 and d.status in ${OVERDUE_DISPUTE} and d.due_at < $2
      group by c.id, c.full_name order by min(d.due_at), c.id limit ${NAMES_LISTED}`, [orgId, now]);
  const pending = await db.rows<NamedCount & { of: number }>(
    `select c.id, c.full_name as name, count(*)::int as n, (count(*) over ())::int as of
       from public.credit_reports r join public.clients c on c.id = r.client_id
      where r.org_id = $1 and c.org_id = $1 and r.status = 'pending_review'
      group by c.id, c.full_name order by min(r.created_at), c.id limit ${NAMES_LISTED}`, [orgId]);
  const strip = ({ id, name, n }: NamedCount): NamedCount => ({ id, name, n });
  return {
    total: byStatus.reduce((sum, s) => sum + s.n, 0), byStatus,
    overdue: overdue.map(strip), overdueClients: overdue[0]?.of ?? 0,
    pending: pending.map(strip), pendingClients: pending[0]?.of ?? 0,
  };
}

// ---------------------------------------------------------------- one client's file

export type SectionKey = 'overview' | 'agreements' | 'reports' | 'negative' | 'findings' | 'disputes' | 'letters' | 'tasks' | 'documents' | 'plan' | 'timeline' | 'notes' | 'messages';
export interface FileSection { key: SectionKey; title: string; lines: string[] }
export interface ClientCounts { openDisputes: number; overdueDisputes: number; negativeItems: number; pendingReports: number; openTasks: number }
export interface ClientContact { email: string | null; phone: string | null; address: string | null }

export interface ClientFile {
  id: string;
  /** The name as it is written in the records text. */
  name: string;
  status: string;
  stage: string;
  counts: ClientCounts;
  /** Shown on the page, straight from the database. Never part of `sections`, so never sent to an AI provider. */
  contact: ClientContact;
  sections: FileSection[];
  /**
   * What the app holds about this client that identifies them (address lines, SSN last four, date of birth in common
   * formats), for masking the same values out of a typed question. It stays on the server: cardOf() leaves it out,
   * and it is never part of the text.
   */
  identifiers: Redaction[];
}

export interface FileOptions {
  /** A personal workspace: the file is the owner's own, with no agreements, no specialist and no plan. */
  personal: boolean;
  /** Whether the caller's role may see plans and payments (billing:read). Without it the section is left out, not shown as empty. */
  billing: boolean;
  now: Date;
}

/** The date of birth on file as YYYY-MM-DD, or null when there is none or it cannot be read. Used only to mask it. */
function storedDay(encrypted: string | null): string | null {
  if (!encrypted) return null;
  try {
    const day = decryptPII(encrypted).trim();
    return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
  } catch {
    return null;
  }
}

type Address = NonNullable<ClientIdentity['address']>;
function addressLine(a: Address | null): string | null {
  if (!a) return null;
  const clean = (s: unknown) => (typeof s === 'string' ? s.trim() : '');
  const parts = [clean(a.line1), clean(a.line2), clean(a.city), [clean(a.state), clean(a.zip)].filter(Boolean).join(' ')].filter(Boolean);
  return parts.length ? parts.join(', ') : null;
}

/**
 * A finding's title as it may be read. The analysis titles a personal-information finding with the value the bureau
 * reports ("Address “…” appears on Experian only"): a reported address is a street address, so it is left out. A
 * reported name or employer stays.
 */
const findingTitle = (f: { title: string; category: string }): string =>
  (f.category === 'personal_info' && /^address\b/i.test(f.title) ? f.title.replace(/“[^”]*”|"[^"]*"/, '“[ADDRESS]”') : f.title);

/**
 * A timeline entry that is replaced whole, or null to read its own words. An upload is written to the timeline with the
 * file's name ("Document uploaded: …", "Client uploaded …"), and a file name can say anything, so only the fact is kept.
 */
const eventText = (e: { kind: string; summary: string }): string | null =>
  (e.kind !== 'document' ? null : /^client uploaded/i.test(e.summary) ? 'A document was uploaded from the portal' : 'A document was uploaded');

const countsLine = (c: ClientCounts): string => [
  `${plural(c.openDisputes, 'open dispute')}${c.overdueDisputes ? ` (${c.overdueDisputes} past ${c.overdueDisputes === 1 ? 'its' : 'their'} due date)` : ''}`,
  plural(c.negativeItems, 'negative item'),
  `${plural(c.pendingReports, 'report')} waiting for review`,
  plural(c.openTasks, 'open task'),
].join(', ');

interface ClientRow {
  id: string; full_name: string; status: string; stage: string; email: string | null; phone: string | null; address: Address | null;
  ssn_last4: string | null; dob_encrypted: string | null; created_at: string; last_activity_at: string; specialist: string | null;
}
interface ReportRow { id: string; bureau: string | null; status: string; report_date: string | null; created_at: string; accounts: number }
interface LineRow {
  report_id: string; bureau: string | null; item_type: string; creditor_name: string; account_last4: string | null; account_type: string | null;
  account_status: string | null; payment_status: string | null; balance_cents: number | null; payment_history: string | null;
}

/**
 * One client's file. Null when the caller cannot see that client (another organization's, or no such id): the read is
 * made under their row-level security and for their own organization.
 */
export async function loadClientFile(db: Db, orgId: string, clientId: string, o: FileOptions): Promise<ClientFile | null> {
  const c = await db.row<ClientRow>(
    `select c.id, c.full_name, c.status, c.stage, c.email, c.phone, c.address, c.ssn_last4, c.dob_encrypted, c.created_at, c.last_activity_at,
            u.full_name as specialist
       from public.clients c left join public.users u on u.id = c.assigned_to where c.org_id = $1 and c.id = $2`, [orgId, clientId]);
  if (!c) return null;
  const ids: Redaction[] = clientIdentifiers({ address: c.address, ssn_last4: c.ssn_last4, dob: storedDay(c.dob_encrypted) });
  const p = [orgId, clientId];
  const free = (s: string | null, max = 300) => safeText(s, ids, max);

  const [consents, reports, findings, findingCounts, disputes, disputeCounts, letters, letterCount, tasks, taskCount, documents, requests, events, notes, messages] = await Promise.all([
    o.personal ? Promise.resolve([] as SignatureRow[]) : db.rows<SignatureRow>(
      'select kind, version, text_shown is not null as has_text, recorded_by, revoked_at from public.client_consents where org_id = $1 and client_id = $2', p),
    db.rows<ReportRow>(
      `select r.id, r.bureau, r.status, r.report_date::text as report_date, r.created_at,
              (select count(*)::int from public.tradelines t where t.report_id = r.id) as accounts
         from public.credit_reports r where r.org_id = $1 and r.client_id = $2 and r.status <> 'rejected'
        order by coalesce(r.report_date, r.created_at::date) desc, r.created_at desc limit 30`, p),
    db.rows<{ title: string; status: string; category: string }>(
      `select title, status, category from public.findings where org_id = $1 and client_id = $2
        order by case status when 'suggested' then 0 when 'accepted' then 1 when 'disputed' then 2 else 3 end, created_at desc limit 10`, p),
    db.rows<{ status: string; n: number }>('select status, count(*)::int as n from public.findings where org_id = $1 and client_id = $2 group by status order by status', p),
    db.rows<{ item_label: string; recipient_name: string | null; status: string; round: number; submitted_at: string | null; due_at: string | null; outcome: string | null }>(
      `select item_label, recipient_name, status, round, submitted_at, due_at, outcome from public.disputes where org_id = $1 and client_id = $2
        order by (status in ('resolved', 'cancelled')), due_at nulls last, created_at desc limit 12`, p),
    db.row<{ n: number; open: number; overdue: number }>(
      `select count(*)::int as n, (count(*) filter (where status in ${OPEN_DISPUTE}))::int as open,
              (count(*) filter (where status in ${OVERDUE_DISPUTE} and due_at < $3))::int as overdue
         from public.disputes where org_id = $1 and client_id = $2`, [...p, o.now]),
    db.rows<{ title: string; status: string; sent_at: string | null; sent_on: string | null }>(
      'select title, status, sent_at, sent_on::text as sent_on from public.letters where org_id = $1 and client_id = $2 order by created_at desc limit 8', p),
    db.row<{ n: number }>('select count(*)::int as n from public.letters where org_id = $1 and client_id = $2', p),
    db.rows<{ title: string; due_at: string | null }>(
      "select title, due_at from public.tasks where org_id = $1 and client_id = $2 and status = 'open' order by due_at nulls last, created_at limit 8", p),
    db.row<{ n: number }>("select count(*)::int as n from public.tasks where org_id = $1 and client_id = $2 and status = 'open'", p),
    db.rows<{ kind: string; review_status: string; n: number }>(
      'select kind, review_status, count(*)::int as n from public.documents where org_id = $1 and client_id = $2 group by kind, review_status order by kind, review_status', p),
    db.rows<{ kind: string; due_at: string | null }>(
      'select kind, due_at from public.document_requests where org_id = $1 and client_id = $2 and fulfilled_document_id is null order by due_at nulls last, created_at limit 10', p),
    db.rows<{ kind: string; summary: string; created_at: string }>(
      'select kind, summary, created_at from public.client_events where org_id = $1 and client_id = $2 order by created_at desc limit 8', p),
    db.rows<{ body: string; created_at: string; author: string | null }>(
      `select n.body, n.created_at, u.full_name as author from public.client_notes n left join public.users u on u.id = n.author_id
        where n.org_id = $1 and n.client_id = $2 order by n.created_at desc limit 5`, p),
    o.personal ? Promise.resolve([] as { direction: string; body: string; created_at: string }[]) : db.rows<{ direction: string; body: string; created_at: string }>(
      `select direction, body, created_at from public.communications
        where org_id = $1 and client_id = $2 and channel = 'portal' and direction in ('inbound', 'outbound') and status not in ('draft', 'pending_approval', 'failed')
        order by created_at desc limit 5`, p),
  ]);

  // The current reports: the latest approved one from each bureau. Their lines are the client's items on file.
  const current = new Map<string, ReportRow>();
  for (const r of reports) if (r.status === 'approved' && r.bureau && !current.has(r.bureau)) current.set(r.bureau, r);
  const waiting = reports.filter((r) => r.status === 'pending_review');
  const lines = current.size ? await db.rows<LineRow>(
    `select report_id, bureau, item_type, creditor_name, account_last4, account_type, account_status, payment_status, balance_cents, payment_history
       from public.tradelines where org_id = $1 and client_id = $2 and report_id = any($3::uuid[]) order by creditor_name, bureau`,
    [...p, [...current.values()].map((r) => r.id)]) : [];
  const negative = lines.filter(isNegative);
  const negativeOn = (reportId: string) => negative.filter((t) => t.report_id === reportId).length;

  const counts: ClientCounts = {
    openDisputes: disputeCounts?.open ?? 0, overdueDisputes: disputeCounts?.overdue ?? 0, negativeItems: negative.length,
    pendingReports: waiting.length, openTasks: taskCount?.n ?? 0,
  };
  const name = safeLabel(c.full_name) || 'No name';
  const sections: FileSection[] = [];
  const add = (key: SectionKey, title: string, body: string[]) => { sections.push({ key, title, lines: body }); };

  add('overview', 'Overview', [
    `Status: ${lookup(CLIENT_STATUS_LABEL, c.status)}. Stage: ${lookup(STAGE_LABEL, c.stage)}.`,
    ...(o.personal ? [] : [c.specialist ? `Specialist: ${safeLabel(c.specialist)}.` : 'No specialist assigned.']),
    `${o.personal ? 'File opened' : 'Client since'} ${fmtDate(c.created_at)}. Last activity: ${fmtDate(c.last_activity_at)}.`,
    `In short: ${countsLine(counts)}.`,
  ]);

  if (!o.personal) {
    const a = agreementProgress(consents);
    add('agreements', 'Agreements', [
      `${a.count} of ${a.total} required agreements signed.${a.next ? ` Next to sign: ${docTitle(a.next)}.` : ' Nothing left to sign.'}`,
    ]);
  }

  add('reports', 'Credit reports', reports.length === 0 ? ['No credit report on file.'] : [
    ...[...current.values()].map((r) => `${bureauName(r.bureau)}, ${r.report_date ? `dated ${fmtDate(r.report_date)}` : `added ${fmtDate(r.created_at)}`} (approved, the current one): ${plural(r.accounts, 'account')}, ${plural(negativeOn(r.id), 'negative item')}.`),
    ...waiting.map((r) => `${bureauName(r.bureau)}, added ${fmtDate(r.created_at)}: waiting for review, ${plural(r.accounts, 'account')} read. Not counted until a person approves it.`),
    ...(current.size === 0 ? ['No approved report yet, so no items are listed.'] : []),
  ]);

  if (current.size) {
    const shown = negative.slice(0, 15);
    add('negative', 'Negative items on the current reports', negative.length === 0 ? ['None on the current reports.'] : [
      ...shown.map((t) => {
        const acct = last4(t.account_last4);
        const status = [t.payment_status, t.account_status].map((s) => safeLabel(words(s), 60)).filter(Boolean).join(' / ');
        const facts = [
          t.item_type === 'collection' ? 'collection' : safeLabel(words(t.account_type), 40).toLowerCase(),
          acct ? `account ending ${acct}` : '',
          `balance ${t.balance_cents == null ? 'not reported' : money(t.balance_cents)}`,
          status ? `reported as ${status}` : '',
        ].filter(Boolean).join(', ');
        return `${safeLabel(t.creditor_name, 80)} (${bureauName(t.bureau)}): ${facts}.`;
      }),
      ...(negative.length > shown.length ? [`${negative.length - shown.length} more not listed here.`] : []),
    ]);
  }

  const findingTotal = findingCounts.reduce((sum, f) => sum + f.n, 0);
  add('findings', 'Findings', findingTotal === 0 ? ['No findings on file.'] : [
    `${plural(findingTotal, 'finding')}: ${findingCounts.map((f) => `${f.n} ${words(f.status).toLowerCase()}`).join(', ')}.`,
    ...findings.map((f) => `“${free(findingTitle(f), 160)}” (${words(f.status).toLowerCase()}).`),
    ...(findingTotal > findings.length ? [`${findingTotal - findings.length} more not listed here.`] : []),
  ]);

  const disputeTotal = disputeCounts?.n ?? 0;
  add('disputes', 'Disputes', disputeTotal === 0 ? ['No disputes on file.'] : [
    `${plural(disputeTotal, 'dispute')} in all: ${counts.openDisputes} open (sent and not resolved)${counts.overdueDisputes ? `, ${counts.overdueDisputes} past ${counts.overdueDisputes === 1 ? 'its' : 'their'} due date` : ''}.`,
    ...disputes.map((d) => {
      const late = (d.status === 'submitted' || d.status === 'under_investigation') && d.due_at !== null && new Date(d.due_at) < o.now;
      const notSent = !d.submitted_at && ['draft', 'ready_for_review', 'approved'].includes(d.status);
      return `${free(d.item_label, 140)}${d.recipient_name ? `, addressed to ${safeLabel(d.recipient_name, 80)}` : ''}: ${lookup(DISPUTE_STATUS_LABEL, d.status)}, round ${d.round}`
        + `${d.submitted_at ? `, sent ${fmtDate(d.submitted_at)}` : notSent ? ', not sent yet' : ''}${d.due_at ? `, reply due ${fmtDate(d.due_at)}${late ? ' (past due)' : ''}` : ''}`
        + `${d.outcome ? `, outcome recorded: ${lookup(OUTCOME_LABEL, d.outcome)}` : ''}.`;
    }),
    ...(disputeTotal > disputes.length ? [`${disputeTotal - disputes.length} more not listed here.`] : []),
  ]);

  const letterTotal = letterCount?.n ?? 0;
  add('letters', 'Letters', letterTotal === 0 ? ['No letters on file.'] : [
    ...letters.map((l) => `“${free(l.title, 140)}”: ${words(l.status)}${l.sent_on || l.sent_at ? `, sent ${fmtDate(l.sent_on ?? l.sent_at)}` : ''}.`),
    ...(letterTotal > letters.length ? [`${letterTotal - letters.length} more not listed here.`] : []),
  ]);

  add('tasks', 'Open tasks', counts.openTasks === 0 ? ['No open tasks.'] : [
    ...tasks.map((t) => `“${free(t.title, 140)}”${t.due_at ? `, due ${fmtDate(t.due_at)}` : ', no due date'}.`),
    ...(counts.openTasks > tasks.length ? [`${counts.openTasks - tasks.length} more not listed here.`] : []),
  ]);

  const byKind = new Map<string, string[]>();
  for (const d of documents) byKind.set(d.kind, [...(byKind.get(d.kind) ?? []), `${d.n} ${d.review_status === 'pending_review' ? 'waiting for review' : words(d.review_status).toLowerCase()}`]);
  add('documents', 'Documents', [
    ...(byKind.size === 0 ? ['No documents on file.'] : [...byKind].map(([kind, parts]) => `${lookup(DOC_KIND_LABEL, kind)}: ${parts.join(', ')}.`)),
    ...(requests.length ? [`Asked for and not received yet: ${requests.map((r) => `${lookup(DOC_KIND_LABEL, r.kind)}${r.due_at ? ` (due ${fmtDate(r.due_at)})` : ''}`).join('; ')}.`] : []),
  ]);

  if (!o.personal && o.billing) {
    const plan = await db.row<{ name: string; price_cents: number; interval: string; status: string; started_at: string }>(
      `select sp.name, sp.price_cents, sp.interval, s.status, s.started_at from public.client_subscriptions s join public.service_plans sp on sp.id = s.plan_id
        where s.org_id = $1 and s.client_id = $2 order by (s.status = 'active') desc, s.created_at desc limit 1`, p);
    const paid = await db.row<{ amount_cents: number; status: string; paid_at: string }>(
      'select amount_cents, status, paid_at from public.payments where org_id = $1 and client_id = $2 order by paid_at desc limit 1', p);
    add('plan', 'Plan and billing', [
      plan ? `Plan: ${safeLabel(plan.name, 80)}, ${money(plan.price_cents)} ${plan.interval === 'month' ? 'per month' : 'one time'}, ${words(plan.status).toLowerCase()} since ${fmtDate(plan.started_at)}.` : 'No plan on file.',
      paid ? `Latest payment recorded: ${money(paid.amount_cents)} on ${fmtDate(paid.paid_at)} (${words(paid.status).toLowerCase()}).` : 'No payment recorded.',
    ]);
  }

  add('timeline', 'Timeline, latest first', events.length === 0 ? ['Nothing on the timeline.'] : events.map((e) => `${fmtDate(e.created_at)}: ${eventText(e) ?? free(e.summary, 200)}`));
  add('notes', o.personal ? 'Notes, latest first, shortened' : 'Staff notes, latest first, shortened',
    notes.length === 0 ? ['No notes.'] : notes.map((n) => `${fmtDate(n.created_at)}${n.author && !o.personal ? `, ${safeLabel(n.author, 60)}` : ''}: “${free(n.body)}”`));
  // A personal workspace has no client portal, so it has no portal messages to show.
  if (!o.personal) {
    add('messages', 'Portal messages, latest first, shortened', messages.length === 0 ? ['No portal messages.']
      : messages.map((m) => `${fmtDate(m.created_at)}, ${m.direction === 'inbound' ? 'the client wrote' : 'staff wrote'}: “${free(m.body)}”`));
  }

  return {
    id: c.id, name, status: lookup(CLIENT_STATUS_LABEL, c.status), stage: lookup(STAGE_LABEL, c.stage), counts,
    contact: { email: c.email?.trim() || null, phone: c.phone?.trim() || null, address: addressLine(c.address) },
    sections, identifiers: ids,
  };
}

// ---------------------------------------------------------------- the text an AI provider is given

/** One client's file as text. It has the sections' lines and nothing else: no contact details. */
export function fileText(f: ClientFile): string {
  return [`FILE: ${f.name}`, ...f.sections.flatMap((s) => [`${s.title}:`, ...s.lines.map((l) => `- ${l}`)])].join('\n');
}

/** The roster's columns, in order. A personal workspace has no specialists, so it has no such column. */
const rosterColumns = (personal: boolean) => ['name', 'status', 'stage', ...(personal ? [] : ['specialist']),
  'last activity', 'open disputes', 'disputes past due', 'negative items', 'reports waiting for review', 'open tasks'].join(' | ');

export function rosterLine(r: RosterRow, personal = false): string {
  return [
    safeLabel(r.full_name) || 'No name', lookup(CLIENT_STATUS_LABEL, r.status), lookup(STAGE_LABEL, r.stage), ...(personal ? [] : [r.specialist ? safeLabel(r.specialist, 60) : 'none']),
    fmtDate(r.last_activity_at), r.open_disputes, r.overdue_disputes, r.negative_items, r.pending_reports, r.open_tasks,
  ].join(' | ');
}

const listed = (rows: NamedCount[], of: number, one: string) =>
  `${rows.map((r) => `${safeLabel(r.name)} (${plural(r.n, one)})`).join(', ')}${of > rows.length ? `, and ${of - rows.length} more` : ''}`;
/** How the people on file are called: clients in an agency, people on file in a personal workspace. */
const people = (personal: boolean) => (personal ? ['person on file', 'people on file'] as const : ['client', 'clients'] as const);

/** The workspace's counts in sentences: what answers a question that names nobody. */
export function factLines(f: WorkspaceFacts, personal: boolean): string[] {
  const who = people(personal);
  if (f.total === 0) return [personal ? 'Nobody is on file in this workspace yet.' : 'This workspace has no clients yet.'];
  return [
    `This workspace has ${plural(f.total, who[0], who[1])}${f.byStatus.length ? `: ${f.byStatus.map((s) => `${s.n} ${lookup(CLIENT_STATUS_LABEL, s.status).toLowerCase()}`).join(', ')}` : ''}.`,
    f.overdueClients ? `With a dispute past its due date (${f.overdueClients}): ${listed(f.overdue, f.overdueClients, 'dispute')}.` : 'No dispute is past its due date.',
    f.pendingClients ? `With a report waiting for review (${f.pendingClients}): ${listed(f.pending, f.pendingClients, 'report')}.` : 'No report is waiting for review.',
  ];
}

export interface RecordsInput {
  facts: WorkspaceFacts;
  roster: RosterRow[];
  files: ClientFile[];
  personal: boolean;
  now: Date;
}

/** Everything the AI provider is given to answer from. */
export function recordsText(x: RecordsInput): string {
  const notListed = Math.max(0, x.facts.total - x.roster.length);
  const who = people(x.personal);
  return [
    `Today is ${fmtDate(x.now)}.`,
    'Open disputes are disputes sent to a bureau or creditor and not resolved yet. Negative items are counted on the latest approved report from each bureau, one for each bureau that reports the item.',
    '',
    'WORKSPACE',
    ...factLines(x.facts, x.personal),
    '',
    `ROSTER: one line for each ${who[0]}, the most recently active first.`,
    rosterColumns(x.personal),
    ...x.roster.map((r) => rosterLine(r, x.personal)),
    ...(notListed ? [`${notListed} more ${notListed === 1 ? `${who[0]} is` : `${who[1]} are`} not listed here, and nothing is known here about ${notListed === 1 ? 'that one' : 'them'}.`] : []),
    '',
    ...(x.files.length
      ? [`FILES READ FOR THIS QUESTION: ${x.files.length}`, ...x.files.flatMap((f) => ['', fileText(f)])]
      : ['NO FILE WAS READ FOR THIS QUESTION: it names nobody on the roster. Only the workspace counts and the roster lines above are known.']),
  ].join('\n');
}

// ---------------------------------------------------------------- the card on the page

export interface ClientCard {
  id: string;
  name: string;
  /** "Active · Disputing" */
  headline: string;
  /** "2 open disputes", "3 negative items"… */
  facts: string[];
  contact: ClientContact;
  sections: FileSection[];
}

export function cardOf(f: ClientFile): ClientCard {
  const c = f.counts;
  return {
    id: f.id, name: f.name, headline: `${f.status} · ${f.stage}`, contact: f.contact, sections: f.sections,
    facts: [
      plural(c.openDisputes, 'open dispute'),
      ...(c.overdueDisputes ? [`${c.overdueDisputes} past due`] : []),
      plural(c.negativeItems, 'negative item'),
      ...(c.pendingReports ? [`${plural(c.pendingReports, 'report')} to review`] : []),
      plural(c.openTasks, 'open task'),
    ],
  };
}
