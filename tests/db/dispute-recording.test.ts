import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Ctx } from '@/lib/auth/context';
import type { SessionInfo } from '@/lib/auth/service';
import { addDays, sayDay } from '@/lib/disputes/clock';
import { recordFrivolousNotice, requestProcedureDescription, setConfirmedAccurate } from '@/lib/disputes/escalation';
import { CONFIRMED_ACCURATE_STOP, createDispute, createSpecialtyDispute, draftDisputesFromFindings, recordResponse, startNextRound, transitionDispute, type DActor } from '@/lib/disputes/service';
import { longDate } from '@/lib/letters/render';
import { businessToday, createLetter, currentBody } from '@/lib/letters/service';
import { decideReport, regenerateFindings, storeParsedReport } from '@/lib/reports/service';
import type { ParsedReport, ParsedTradeline } from '@/lib/reports/types';
import { can, type Role } from '@/lib/rbac';
import { addClient, asUser, closePool, makeOrg, withSystem, type TestOrg } from './helpers';

/**
 * How a dispute is recorded: the day a response or a notice arrived (a later letter prints it as the day the client
 * received the results, so nobody's clock stands in for it), which account a finding's dispute is about, and when a
 * specialty agency item may be started again as a first round. Through the real services, actions and page.
 */
const signedIn = vi.hoisted(() => ({ ctx: null as unknown }));
vi.mock('@/lib/auth/context', () => ({
  requireStaff: async (perm?: string) => {
    const ctx = signedIn.ctx as { can(p: string): boolean };
    if (perm && !ctx.can(perm)) throw new Error('REDIRECT /app?denied=1');
    return ctx;
  },
}));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));
vi.mock('next/navigation', async (original) => ({ ...(await original<typeof import('next/navigation')>()), redirect: (to: string) => { throw new Error(`REDIRECT ${to}`); } }));
vi.stubGlobal('React', React);

import { recordResponseAction } from '@/app/app/disputes/actions';
import { frivolousNoticeAction } from '@/app/app/disputes/escalation-actions';
import DisputePage from '@/app/app/disputes/[id]/page';
import NewDisputePage from '@/app/app/disputes/new/page';

let A: TestOrg;
let owner: DActor;
let clientId = '';
let n = 0;
const today = businessToday();
const REASON = 'Experian reports a balance of $640.00. My statement dated September 2, 2026 shows $0.00.';

function signIn(role: Role = 'owner'): void {
  const session: SessionInfo = { sessionId: 's', userId: A.ownerId, orgId: A.orgId, role, email: A.ownerEmail, fullName: 'Test Person', mfaVerified: true, totpEnabled: false, orgName: 'Recording', orgSlug: 'recording', orgMode: 'agency', orgPlan: 'trial' };
  const ctx: Ctx = { session, userId: A.ownerId, orgId: A.orgId, role, tx: (fn) => asUser(A.ownerId, fn), can: (p) => can(role, p), need: () => undefined, meta: { ip: '10.0.0.1', userAgent: 'vitest' } };
  signedIn.ctx = ctx;
}
const form = (fields: Record<string, string>) => { const fd = new FormData(); for (const [k, v] of Object.entries(fields)) fd.set(k, v); return fd; };
const row = (id: string) => withSystem((db) => db.row<{ status: string; outcome: string | null; response_day: string | null; frivolous_missing: string | null }>(
  "select status, outcome, to_char(response_at at time zone 'UTC', 'YYYY-MM-DD') as response_day, frivolous_missing from public.disputes where id = $1", [id]));

/** A bureau dispute recorded as sent `sentDaysAgo` days ago (the gates on the way to "submitted" are covered in workflow.test.ts). */
async function sent(sentDaysAgo = 20): Promise<string> {
  const id = await asUser(owner.userId, (db) => createDispute(db, owner, { clientId, category: 'incorrect_balance', bureau: 'experian', itemLabel: `Acme Bank ••${String(1000 + ++n)}`, fields: ['Balance'], reason: REASON }));
  const sentOn = addDays(today, -sentDaysAgo);
  await withSystem((db) => db.run("update public.disputes set status = 'submitted', submitted_at = $2, due_at = $3 where id = $1", [id, `${sentOn}T12:00:00Z`, `${addDays(sentOn, 33)}T12:00:00Z`]));
  return id;
}

beforeAll(async () => {
  A = await makeOrg('Recording');
  owner = { orgId: A.orgId, userId: A.ownerId, role: 'owner' };
  clientId = await addClient(A.orgId, 'Robin Ash');
  await withSystem((db) => db.run(`update public.clients set address = '{"line1":"9 Elm St","city":"Dayton","state":"OH","zip":"45402"}' where id = $1`, [clientId]));
});
afterAll(closePool);

describe('the day a response arrived', () => {
  it('is required for every outcome except “no response”: the moment it is recorded never stands in for it', async () => {
    const id = await sent();
    for (const outcome of ['deleted', 'updated', 'verified', 'unresolved'] as const) {
      await expect(asUser(owner.userId, (db) => recordResponse(db, owner, id, { outcome }))).rejects.toThrow(/^Enter the date the response was received\.$/);
    }
    expect(await row(id)).toMatchObject({ status: 'submitted', outcome: null, response_day: null });
    // "No response" has no day of arrival to give.
    const none = await sent();
    await asUser(owner.userId, (db) => recordResponse(db, owner, none, { outcome: 'no_response' }));
    expect(await row(none)).toMatchObject({ status: 'response_received', outcome: 'no_response' });
  });

  it('is a real day, not in the future and not before the dispute was sent', async () => {
    const id = await sent(20);
    const record = (receivedOn: string) => asUser(owner.userId, (db) => recordResponse(db, owner, id, { outcome: 'verified', receivedOn }));
    for (const bad of ['2026-02-30', '2026-13-01', '2026-00-10']) await expect(record(bad), bad).rejects.toThrow(/^Enter the date the response was received as a valid date\.$/);
    await expect(record(addDays(today, 2))).rejects.toThrow(/^The date the response was received cannot be in the future\.$/);
    await expect(record(addDays(today, -21))).rejects.toThrow(`The date the response was received cannot be before the dispute was sent (${sayDay(addDays(today, -20))}).`);
    expect(await row(id)).toMatchObject({ status: 'submitted', outcome: null, response_day: null });
    await record(addDays(today, -20)); // the day it was sent is possible (a reply by email, for one)
    expect(await row(id)).toMatchObject({ status: 'response_received', outcome: 'verified', response_day: addDays(today, -20) });
  });

  it('is the day the later letter says the results arrived', async () => {
    const id = await sent(40);
    const received = addDays(today, -9);
    await asUser(owner.userId, (db) => recordResponse(db, owner, id, { outcome: 'verified', receivedOn: received }));
    const letterId = await asUser(owner.userId, (db) => requestProcedureDescription(db, owner, id));
    const body = (await withSystem((db) => currentBody(db, letterId)))!.body;
    expect(body).toContain(`Your results, which I received on ${longDate(new Date(`${received}T00:00:00Z`))}, state that the information was verified.`);
  });

  it('a “frivolous or irrelevant” notice needs the day it arrived too', async () => {
    const id = await sent(30);
    const notice = (receivedOn?: string | null) => asUser(owner.userId, (db) => recordFrivolousNotice(db, owner, id, { missing: 'A copy of a government-issued photo ID', receivedOn }));
    await expect(notice()).rejects.toThrow(/^Enter the date the notice was received\.$/);
    await expect(notice(null)).rejects.toThrow(/^Enter the date the notice was received\.$/);
    await expect(notice(addDays(today, 3))).rejects.toThrow(/^The date the notice was received cannot be in the future\.$/);
    await expect(notice(addDays(today, -31))).rejects.toThrow(/^The date the notice was received cannot be before the dispute was sent/);
    expect(await row(id)).toMatchObject({ status: 'submitted', outcome: null, response_day: null, frivolous_missing: null });
    await notice(addDays(today, -4));
    expect(await row(id)).toMatchObject({ status: 'response_received', outcome: 'frivolous', response_day: addDays(today, -4) });
    // The next round says when the notice came, and it is that day.
    await asUser(owner.userId, (db) => transitionDispute(db, owner, id, 'resolved'));
    const next = await asUser(owner.userId, (db) => startNextRound(db, owner, id, { reason: 'Experian still reports a balance of $640.00 for this account.', newInformation: 'A copy of my government-issued photo ID is enclosed, as the notice asked.' }));
    const letterId = await asUser(owner.userId, (db) => createLetter(db, owner, { clientId, disputeId: next }));
    expect((await withSystem((db) => currentBody(db, letterId)))!.body).toContain(`Your notice, which I received on ${longDate(new Date(`${addDays(today, -4)}T00:00:00Z`))}, said that you needed more information before you would investigate.`);
  });

  it('the two forms refuse a missing date with a plain message, and say when it is recorded', async () => {
    signIn();
    const id = await sent();
    expect(await recordResponseAction(undefined, form({ id, outcome: 'verified', receivedOn: '', completedOn: '', notes: '' }))).toEqual({ error: 'Enter the date the response was received.' });
    expect(await recordResponseAction(undefined, form({ id, outcome: 'updated' }))).toEqual({ error: 'Enter the date the response was received.' });
    expect((await row(id))!.outcome).toBeNull();
    expect(await recordResponseAction(undefined, form({ id, outcome: 'updated', receivedOn: addDays(today, -2) }))).toEqual({ ok: 'Response recorded.' });
    expect(await row(id)).toMatchObject({ outcome: 'updated', response_day: addDays(today, -2) });
    expect(await recordResponseAction(undefined, form({ id: await sent(), outcome: 'no_response' }))).toEqual({ ok: 'Response recorded.' });

    const other = await sent();
    expect(await frivolousNoticeAction(undefined, form({ id: other, missing: 'A recent utility bill', receivedOn: '' }))).toEqual({ error: 'Enter the date the notice was received.' });
    expect((await row(other))!.outcome).toBeNull();
    expect((await frivolousNoticeAction(undefined, form({ id: other, missing: 'A recent utility bill', receivedOn: addDays(today, -1) })))!.ok).toMatch(/^Recorded\./);
  });

  it('the dispute page asks for the date as a required field, and records “no response” on its own', async () => {
    signIn();
    const id = await sent();
    const html = renderToStaticMarkup(await DisputePage({ params: Promise.resolve({ id }) }) as React.ReactElement);
    const record = html.slice(html.indexOf('2 · Record the outcome'));
    const input = /Date response received[\s\S]*?<input([^>]*)>/.exec(record)![1]!;
    expect(input).toMatch(/name="receivedOn"/);
    expect(input).toMatch(/\brequired=""/);
    expect(input).toContain(`max="${today}"`);
    // The outcome list is for a response that arrived; "no response" is a button of its own with no date to give.
    const outcomes = /<select[^>]*name="outcome"[^>]*>([\s\S]*?)<\/select>/.exec(record)![1]!;
    expect(outcomes).not.toMatch(/no_response|frivolous/);
    expect(outcomes).toMatch(/value="verified"/);
    expect(record).toMatch(/<input type="hidden" name="outcome" value="no_response"\/>[\s\S]*?Record no response/);
  });
});

describe('a dispute drafted in bulk from a finding', () => {
  const line = (o: Partial<ParsedTradeline> & { creditor_name: string }): ParsedTradeline => ({
    bureau: null, item_type: 'tradeline', original_creditor: null, account_last4: null, account_type: null, account_status: 'Open', payment_status: 'Current',
    balance_cents: null, credit_limit_cents: null, high_balance_cents: null, date_opened: null, date_reported: null, date_of_first_delinquency: null,
    payment_history: null, remarks: null, confidence: 0.99, field_meta: {}, ...o,
  });

  let c = '';
  let collection = '';
  let findings: { id: string; dedupe_key: string; tradeline_ids: string[] }[] = [];

  beforeAll(async () => {
    c = await addClient(A.orgId, 'Kim Ortega');
    // The original creditor's account comes first on the report; the findings name the collection first.
    const parsed: ParsedReport = { bureau: null, reportDate: '2026-10-20', inquiries: [], publicRecords: [], identity: [], warnings: [], tradelines: [
      line({ creditor_name: 'FIRST HORIZON BANK', account_last4: '4410', account_status: 'Charged off', payment_status: 'Charge-off', balance_cents: 98000, date_opened: '2020-05-05', date_of_first_delinquency: '2023-01-15' }),
      line({ creditor_name: 'NORTHSTAR RECOVERY', item_type: 'collection', original_creditor: 'FIRST HORIZON BANK', account_last4: '7003', account_status: 'Collection', payment_status: null, balance_cents: 98000, date_opened: '2024-11-01', date_of_first_delinquency: '2024-06-01' }),
    ] };
    const [reportId] = await asUser(owner.userId, (db) => storeParsedReport(db, owner, { clientId: c, parsed, bureau: 'experian', source: 'manual' }));
    await asUser(owner.userId, (db) => decideReport(db, owner, reportId!, 'approved'));
    await asUser(owner.userId, (db) => regenerateFindings(db, owner, c, 'Kim Ortega', '9 Elm St'));
    const rows = await withSystem((db) => db.rows<{ id: string; creditor_name: string }>('select id, creditor_name from public.tradelines where client_id = $1', [c]));
    collection = rows.find((t) => t.creditor_name === 'NORTHSTAR RECOVERY')!.id;
    expect(rows[0]!.creditor_name).toBe('FIRST HORIZON BANK'); // the order the bulk drafting used to pick from
    findings = await withSystem((db) => db.rows<{ id: string; dedupe_key: string; tradeline_ids: string[] }>("select id, dedupe_key, tradeline_ids from public.findings where client_id = $1 and (dedupe_key like 'reage-oc:%' or dedupe_key like 'dup-oc:%') order by dedupe_key", [c]));
    expect(findings.map((f) => f.dedupe_key.split(':')[0])).toEqual(['dup-oc', 'reage-oc']);
    for (const f of findings) expect(f.tradeline_ids[0]).toBe(collection);
  });

  it('the new dispute form says a reason drafted from a finding’s dates comes from the report, and drafts none for a request to the creditor', async () => {
    signIn();
    const read = async (q: Record<string, string>) => renderToStaticMarkup(await NewDisputePage({ searchParams: Promise.resolve({ clientId: c, ...q }) }) as React.ReactElement);
    const reAged = await read({ findingId: findings[1]!.id });
    expect(reAged).toContain('(Experian reports June 1, 2024 for the collection; Experian reports January 15, 2023 for the original creditor)');
    expect(reAged).toContain('Drafted from the report data and phrased as a request to verify.');
    expect(reAged).not.toMatch(/cannot be sent for approval/); // it states two reported dates, so the reason check does not hold it
    const creditor = await read({ tradelineId: collection, category: 'furnisher_direct' });
    const field = /<textarea([^>]*)name="reason"([^>]*)>([^<]*)<\/textarea>/.exec(creditor)!;
    expect(field[3]).toBe('');
    expect(`${field[1]}${field[2]}`).toContain('placeholder="What the creditor reports for this account, and what the client’s own records show instead');
    expect(creditor).toContain('Nothing is drafted for this kind of request');
    expect(creditor).not.toMatch(/with the furnisher/);
  });

  it('is about the finding’s own first account, whatever order the report lists them in', async () => {
    const r = await asUser(owner.userId, (db) => draftDisputesFromFindings(db, owner, c, findings.map((f) => f.id)));
    expect(r.skipped).toEqual([]);
    const drafted = await withSystem((db) => db.rows<{ category: string; tradeline_id: string; item_label: string; reason: string }>('select category, tradeline_id, item_label, reason from public.disputes where client_id = $1 order by category', [c]));
    expect(drafted.map((d) => [d.category, d.tradeline_id, d.item_label])).toEqual([
      ['duplicate', collection, 'NORTHSTAR RECOVERY ••7003 (Experian)'],
      ['incorrect_dates', collection, 'NORTHSTAR RECOVERY ••7003 (Experian)'],
    ]);
    // And the reasons read as a person would write them: dates written out, no creditor's name among the dates.
    expect(drafted[1]!.reason).toBe('Please verify the date of first delinquency reported for NORTHSTAR RECOVERY (account ending 7003) (Experian reports June 1, 2024 for the collection; Experian reports January 15, 2023 for the original creditor) with the furnisher and correct it if needed.');
    expect(drafted[0]!.reason).toMatch(/^NORTHSTAR RECOVERY \(account ending 7003\) appears to be reported more than once[\s\S]* make sure the debt is not reported as owed twice\.$/);
  });
});

describe('a specialty agency item started again as a first round', () => {
  const ITEM = { name: 'First Coast Bank', reference: 'xxxx8841', amount: '$412.50' };
  const REASON_EW = 'The disclosure shows an unpaid balance of $412.50. I paid this in full on April 2, 2025.';
  const start = (item: { name: string; reference?: string | null; amount?: string }, agency = 'early_warning', client = clientId) =>
    asUser(owner.userId, (db) => createSpecialtyDispute(db, owner, { clientId: client, agency, item, reason: REASON_EW }));
  const answer = (id: string, outcome: string, status = 'resolved') => withSystem((db) => db.run(
    "update public.disputes set status = $2, outcome = $3, submitted_at = now() - interval '50 days', due_at = now() - interval '20 days', response_at = now() - interval '22 days' where id = $1", [id, status, outcome]));

  it('is refused while the first is open and after a “verified” result, as for a bureau; the next round is the way', async () => {
    const first = await start(ITEM);
    await expect(start(ITEM)).rejects.toThrow('A “Specialty agency item” dispute about this item with Early Warning is already open (round 1, draft). Continue with that one. Once it is resolved, the same thing is disputed again by starting the next round from it.');
    await answer(first, 'verified');
    const resolved = 'A “Specialty agency item” dispute about this item with Early Warning has already been resolved (round 1). To dispute the same thing again, open that dispute and start the next round, which asks for what is new.';
    await expect(start(ITEM)).rejects.toThrow(resolved);
    // The same item typed another way is the same item: name and reference compared without case or extra spaces.
    await expect(start({ name: '  first   coast BANK ', reference: 'XXXX8841' })).rejects.toThrow(resolved);
    // The next round itself is not refused.
    const second = await asUser(owner.userId, (db) => startNextRound(db, owner, first, { reason: 'Early Warning still shows an unpaid balance of $412.50.', newInformation: 'The bank’s letter dated October 2, 2026 confirms the balance is $0.00.' }));
    expect(await withSystem((db) => db.row('select round, status, agency from public.disputes where id = $1', [second]))).toEqual({ round: 2, status: 'draft', agency: 'early_warning' });
    await expect(start(ITEM)).rejects.toThrow(/already open \(round 2, draft\)/);
  });

  it('is allowed for another item, another agency, another client, after a deletion or a correction, and after a cancellation', async () => {
    const ok = async (p: Promise<string>) => { const id = await p; expect((await withSystem((db) => db.row<{ status: string }>('select status from public.disputes where id = $1', [id])))!.status).toBe('draft'); };
    await ok(start({ ...ITEM, reference: 'xxxx9999' }));
    await ok(start({ name: 'Harbor Credit Union', reference: 'xxxx8841' }));
    await ok(start(ITEM, 'chexsystems'));
    await ok(start(ITEM, 'early_warning', await addClient(A.orgId, 'Lee Park')));
    const item = { name: 'Lakeview Savings', reference: null };
    const gone = await start(item);
    await answer(gone, 'deleted', 'response_received');
    const back = await start(item);
    await answer(back, 'updated');
    const again = await start(item);
    await withSystem((db) => db.run("update public.disputes set status = 'cancelled' where id = $1", [again]));
    await ok(start(item));
  });

  it('is never started again for an item the client confirmed is reported accurately', async () => {
    const item = { name: 'Summit Savings', reference: 'xxxx1200' };
    const first = await start(item);
    await answer(first, 'verified');
    await asUser(owner.userId, (db) => setConfirmedAccurate(db, owner, first, true));
    await expect(start(item)).rejects.toThrow(CONFIRMED_ACCURATE_STOP);
  });
});
