/**
 * "Personal information on reports": the names, addresses, employers, phone numbers and date of birth a bureau shows
 * for a client that the client says are wrong or not theirs, and the correction letter drafted from them.
 *
 * Where an entry comes from. Names, addresses and employers are read from an imported report (report_identity_items),
 * so staff pick them from what the report shows. Phone numbers and the date of birth are not read by the parser, and
 * the portal does not show report data, so those entries (and everything a client marks in the portal) are typed by a
 * person exactly as the report shows them. The app never fills in an entry or a correction itself.
 *
 * The letter goes through the normal pipeline: an ordinary personal-information dispute to that bureau with an
 * ordinary DRAFT letter, which a person reads, a manager approves and a person mails.
 */
import type { Db } from '../db';
import { audit } from '../audit';
import { logEvent } from '../crm';
import { createDispute, type DActor } from '../disputes/service';
import { UserError } from '../errors';
import { createLetter } from '../letters/service';
import { can, PermissionError } from '../rbac';
import { BUREAU_LABEL, type Bureau } from '../util';

export const PI_BUREAUS: Bureau[] = ['experian', 'equifax', 'transunion'];
export const PI_KINDS = ['name', 'address', 'employer', 'phone', 'date_of_birth'] as const;
export type PiKind = (typeof PI_KINDS)[number];
export const PI_ISSUES = ['not_mine', 'incorrect'] as const;
export type PiIssue = (typeof PI_ISSUES)[number];
/** As the letter and the staff screen say it. The portal's wording is in portal-i18n (pi_*). */
export const PI_KIND_LABEL: Record<PiKind, string> = { name: 'Name', address: 'Address', employer: 'Employer', phone: 'Phone number', date_of_birth: 'Date of birth' };
export const PI_MAX_PER_BUREAU = 20;

export interface PersonalInfoMark { id: string; bureau: Bureau; kind: PiKind; value: string; issue: PiIssue; correctValue: string | null; source: 'staff' | 'client' }
export interface ReportedEntry { bureau: Bureau; kind: 'name' | 'address' | 'employer'; value: string }

const clean = (v: string | null | undefined, max = 300) => (v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

export async function loadMarks(db: Db, clientId: string): Promise<PersonalInfoMark[]> {
  return db.rows<PersonalInfoMark>(
    'select id, bureau, kind, value, issue, correct_value as "correctValue", source from public.personal_info_marks where client_id = $1 order by bureau, kind, created_at', [clientId]);
}

/** What the newest approved report of each bureau shows in its personal information section. Staff only (row-level security). */
export async function loadReportedEntries(db: Db, clientId: string): Promise<ReportedEntry[]> {
  return db.rows<ReportedEntry>(
    `select distinct i.bureau, i.kind, i.value from public.report_identity_items i
      where i.client_id = $1 and i.report_id in (
        select distinct on (bureau) id from public.credit_reports where client_id = $1 and status = 'approved' and bureau is not null
         order by bureau, coalesce(report_date, created_at::date) desc, created_at desc)
      order by i.bureau, i.kind, i.value`, [clientId]);
}

export interface NewMark { bureau: string; kind: string; value: string; issue: string; correctValue?: string | null }

/**
 * Records that one entry on one bureau's report is not the client's, or is not correct. Runs as staff or as the client
 * (row-level security decides which rows either may write). Marking the same entry again replaces the earlier answer.
 * Returns false when nothing was written: the client listed an entry that staff already marked, and a client cannot
 * replace an answer staff gave, so that answer stands. The caller must not report it as saved.
 */
export async function addMark(db: Db, who: { orgId: string; userId: string; source: 'staff' | 'client' }, clientId: string, input: NewMark): Promise<boolean> {
  if (!(PI_BUREAUS as string[]).includes(input.bureau)) throw new UserError('Choose the bureau.');
  if (!(PI_KINDS as readonly string[]).includes(input.kind)) throw new UserError('Choose what kind of entry it is.');
  const value = clean(input.value);
  if (!value) throw new UserError('Enter the entry as the report shows it.');
  // A date of birth is the client's or it is wrong; "not mine" does not apply to it.
  const issue: PiIssue = input.kind === 'date_of_birth' ? 'incorrect' : input.issue === 'incorrect' ? 'incorrect' : 'not_mine';
  const correct = issue === 'incorrect' ? clean(input.correctValue) || null : null;
  const count = await db.row<{ n: number }>('select count(*)::int as n from public.personal_info_marks where client_id = $1 and bureau = $2', [clientId, input.bureau]);
  if ((count?.n ?? 0) >= PI_MAX_PER_BUREAU) throw new UserError(`Up to ${PI_MAX_PER_BUREAU} entries can be listed for one bureau.`);
  // The entry keeps the spelling it was first recorded with (the report's own), however it is typed the second time.
  const earlier = await db.row<{ value: string }>('select value from public.personal_info_marks where client_id = $1 and bureau = $2 and kind = $3 and lower(btrim(value)) = lower($4)', [clientId, input.bureau, input.kind, value]);
  const shown = earlier?.value ?? value;
  // Staff replace any earlier answer; for a client, row-level security limits this to an answer they gave themselves.
  await db.run('delete from public.personal_info_marks where client_id = $1 and bureau = $2 and kind = $3 and lower(btrim(value)) = lower($4)', [clientId, input.bureau, input.kind, value]);
  const written = await db.run(
    `insert into public.personal_info_marks (org_id, client_id, bureau, kind, value, issue, correct_value, source, created_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     on conflict (client_id, bureau, kind, lower(btrim(value))) do nothing`,
    [who.orgId, clientId, input.bureau, input.kind, shown, issue, correct, who.source, who.userId]);
  return written > 0;
}

export async function removeMark(db: Db, clientId: string, markId: string): Promise<void> {
  await db.run('delete from public.personal_info_marks where id = $1 and client_id = $2', [markId, clientId]);
}

/**
 * The marked entries as the letter lists them. Pure. Each line repeats the entry as the report shows it and what the
 * client says about it; a correction appears only when a person entered one.
 */
export function personalInfoReason(marks: Pick<PersonalInfoMark, 'kind' | 'value' | 'issue' | 'correctValue'>[]): string {
  return marks.map((m) => {
    const label = PI_KIND_LABEL[m.kind];
    const said = m.issue === 'not_mine' ? 'this entry is not mine.'
      : `this entry is not correct.${m.correctValue ? ` The correct ${label.toLowerCase()} is “${m.correctValue}”.` : ''}`;
    return `- ${label} shown as “${m.value}”: ${said}`;
  }).join('\n');
}

const OPEN = ['draft', 'ready_for_review', 'approved', 'submitted', 'under_investigation', 'on_hold'];

/**
 * One click: drafts the personal-information correction for one bureau from the entries marked for it. Creates an
 * ordinary dispute and an ordinary DRAFT letter; nothing is sent. Refused when nothing is marked for that bureau, or
 * while an earlier correction to the same bureau is still open.
 */
export async function draftPersonalInfoLetter(db: Db, actor: DActor, clientId: string, bureau: Bureau, orgName?: string): Promise<{ disputeId: string; letterId: string }> {
  if (!can(actor.role, 'disputes:write')) throw new PermissionError('disputes:write');
  if (!can(actor.role, 'letters:write')) throw new PermissionError('letters:write');
  if (!PI_BUREAUS.includes(bureau)) throw new UserError('Choose the bureau.');
  const marks = (await loadMarks(db, clientId)).filter((m) => m.bureau === bureau);
  if (!marks.length) throw new UserError(`Nothing is marked as wrong on the ${BUREAU_LABEL[bureau]} report. Mark the entries first.`);
  const open = await db.row("select 1 from public.disputes where client_id = $1 and category = 'personal_info' and bureau = $2 and status = any($3)", [clientId, bureau, OPEN]);
  if (open) throw new UserError(`A personal information correction to ${BUREAU_LABEL[bureau]} is already in progress for this client.`);
  const reason = personalInfoReason(marks);
  if (reason.length > 4000) throw new UserError('Too many entries for one letter. Remove some and draft a second letter afterwards.');
  const disputeId = await createDispute(db, actor, { clientId, category: 'personal_info', bureau, reason, fields: ['Personal information'], itemLabel: 'Personal information' });
  const letterId = await createLetter(db, actor, { clientId, disputeId, templateKey: 'personal_info_correction_en', orgName });
  await logEvent(db, actor, clientId, 'personal_info', `Personal information correction drafted for ${BUREAU_LABEL[bureau]} (${marks.length} entr${marks.length === 1 ? 'y' : 'ies'})`, { dispute_id: disputeId, letter_id: letterId });
  await audit(db, { orgId: actor.orgId, actorId: actor.userId, action: 'client.personal_info_letter', entityType: 'client', entityId: clientId, ip: actor.meta?.ip, meta: { bureau, entries: marks.length } });
  return { disputeId, letterId };
}
