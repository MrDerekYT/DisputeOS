import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { recordCollectorNotice } from '@/lib/credit/case-tools';
import { setConfirmedAccurate } from '@/lib/disputes/escalation';
import { createDispute, recordResponse, type DActor } from '@/lib/disputes/service';
import { recommendLetter } from '@/lib/letters/brief';
import { loadBrief } from '@/lib/letters/brief-load';
import { createLetter, currentBody, markSent, setLetterStatus } from '@/lib/letters/service';
import { decideReport, storeParsedReport } from '@/lib/reports/service';
import type { ParsedReport, ParsedTradeline } from '@/lib/reports/types';
import type { Bureau } from '@/lib/util';
import { addClient, asUser, closePool, makeOrg, uniq, withSystem, type TestOrg } from './helpers';

/**
 * The facts a letter rests on, through the real pipeline: which debt a collector notice recorded by the collector's
 * name belongs to, and the checks run again when a draft is sent for approval and when it is approved, after the file
 * (or the calendar) has moved on since it was drafted.
 */
let A: TestOrg;
let owner: DActor;

const line = (o: Partial<ParsedTradeline> & { creditor_name: string }): ParsedTradeline => ({
  bureau: null, item_type: 'tradeline', original_creditor: null, account_last4: null, account_type: null, account_status: 'Open', payment_status: 'Current',
  balance_cents: null, credit_limit_cents: null, high_balance_cents: null, date_opened: '2019-03-05', date_reported: null, date_of_first_delinquency: null,
  payment_history: null, remarks: null, confidence: 0.99, field_meta: {}, ...o,
});
const collection = (creditor: string, last4: string, cents: number) => line({ creditor_name: creditor, item_type: 'collection', account_last4: last4, account_status: 'Collection', payment_status: null, balance_cents: cents, date_of_first_delinquency: '2025-06-15' });

async function newClient(name: string): Promise<string> {
  const id = await addClient(A.orgId, name);
  await withSystem((db) => db.run(`update public.clients set address = '{"line1":"4821 Larkspur Lane","city":"Columbus","state":"OH","zip":"43215"}' where id = $1`, [id]));
  return id;
}
/** Imports a report through the real service and, unless told otherwise, approves it. Returns the report id. */
async function report(clientId: string, bureau: Bureau, reportDate: string, tradelines: ParsedTradeline[], approved = true): Promise<string> {
  const parsed: ParsedReport = { bureau: null, reportDate, tradelines, inquiries: [], publicRecords: [], identity: [], warnings: [] };
  const [id] = await asUser(owner.userId, (db) => storeParsedReport(db, owner, { clientId, parsed, bureau, source: 'manual' }));
  if (approved) await asUser(owner.userId, (db) => decideReport(db, owner, id!, 'approved'));
  return id!;
}
const rowOn = (reportId: string, last4: string) => withSystem(async (db) => (await db.row<{ id: string }>('select id from public.tradelines where report_id = $1 and account_last4 = $2', [reportId, last4]))!.id);
const create = (d: Parameters<typeof createDispute>[2]) => asUser(owner.userId, (db) => createDispute(db, owner, d));
const letter = async (input: Parameters<typeof createLetter>[2]) => {
  const id = await asUser(owner.userId, (db) => createLetter(db, owner, input));
  return { id, body: (await withSystem((db) => currentBody(db, id)))!.body };
};
const brief = async (clientId: string, disputeId: string) => (await asUser(owner.userId, (db) => loadBrief(db, clientId, disputeId)))!;
const move = (letterId: string, to: 'pending_approval' | 'approved' | 'draft') => asUser(owner.userId, (db) => setLetterStatus(db, owner, letterId, to));
const letterRow = (id: string) => withSystem((db) => db.row<{ status: string; title: string }>('select status, title from public.letters where id = $1', [id]));
const notice = (clientId: string, input: { tradelineId?: string; collectorName?: string; date: string }) =>
  asUser(owner.userId, (db) => recordCollectorNotice(db, owner, { clientId, kind: 'received', ...input }));
const ageNotice = (noticeId: string, date: string) => withSystem((db) => db.run('update public.collector_notices set notice_date = $2 where id = $1', [noticeId, date]));
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
const said = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const COLLECTOR_ADDRESS = 'PO Box 4410\nDublin, OH 43016';

beforeAll(async () => {
  A = await makeOrg('Recheck');
  owner = { orgId: A.orgId, userId: A.ownerId, role: 'owner' };
});
afterAll(closePool);

describe('a collector notice recorded by the collector’s name only', () => {
  it('is used for neither debt while the client has two collections with that collector, and the recommendation says how to link it', async () => {
    const c = await newClient('Marcus Bellamy');
    const exp = await report(c, 'experian', '2026-10-01', [collection('PORTFOLIO RECOVERY ASSOCIATES', '9032', 61240), collection('PORTFOLIO RECOVERY ASSOCIATES', '2764', 20000)]);
    await notice(c, { collectorName: 'Portfolio Recovery Associates', date: daysAgo(9) });
    for (const last4 of ['9032', '2764']) {
      const d = await create({ clientId: c, tradelineId: await rowOn(exp, last4), category: 'unverifiable_collection', reason: `I do not recognize the debt ending ${last4}.` });
      const b = await brief(c, d);
      expect(b.circumstances.notice, last4).toBeNull();
      expect(recommendLetter(b).reason, last4).toMatch(/recorded by name only, and the client has another collection account with that collector on an approved report[\s\S]*link it to the account under “Collections and bankruptcy” on the client’s page\.$/);
      const l = await letter({ clientId: c, disputeId: d, recipientAddress: COLLECTOR_ADDRESS });
      expect(l.body, last4).toContain('I am writing about the debt referenced above. I dispute this debt and ask that you provide validation of it, including:');
      expect(l.body, last4).not.toMatch(/809\(b\)|1692g|which I received on|as the statute provides/);
    }
  });

  it('also counts the other debts the report lists under this account’s own name, when the collector’s name was typed as its notice prints it', async () => {
    const c = await newClient('Keisha Adams');
    const exp = await report(c, 'experian', '2026-10-01', [collection('PORTFOLIO RECOVERY ASSOC', '9032', 61240), collection('PORTFOLIO RECOVERY ASSOC', '2764', 20000)]);
    await notice(c, { collectorName: 'Portfolio Recovery Associates, LLC', date: daysAgo(9) });
    for (const last4 of ['9032', '2764']) {
      const d = await create({ clientId: c, tradelineId: await rowOn(exp, last4), category: 'unverifiable_collection', recipientName: 'Portfolio Recovery Associates, LLC', reason: `I do not recognize the debt ending ${last4}.` });
      expect((await brief(c, d)).circumstances.notice, last4).toBeNull();
      expect((await letter({ clientId: c, disputeId: d, recipientAddress: COLLECTOR_ADDRESS })).body, last4).not.toMatch(/809\(b\)|which I received on/);
    }
  });

  it('counts the same account on another bureau’s report as this one, and only accounts on an approved report', async () => {
    const c = await newClient('Priya Raghunathan');
    const exp = await report(c, 'experian', '2026-10-01', [collection('LVNV FUNDING', '5518', 24510)]);
    await report(c, 'equifax', '2026-10-02', [collection('LVNV FUNDING', '5518', 24510)]);
    const pending = await report(c, 'transunion', '2026-10-03', [collection('LVNV FUNDING', '7777', 9900)], false);
    const day = daysAgo(9);
    await notice(c, { collectorName: 'LVNV Funding', date: day });
    const d = await create({ clientId: c, tradelineId: await rowOn(exp, '5518'), category: 'unverifiable_collection', reason: 'I do not recognize a balance of $245.10.' });
    // The same debt reported by Equifax, and another debt on a report nobody has approved: the notice is this debt's.
    expect((await brief(c, d)).circumstances.notice).toMatchObject({ date: day, open: true });
    expect((await letter({ clientId: c, disputeId: d, recipientAddress: COLLECTOR_ADDRESS })).body).toContain(`which I received on ${said(day)}. Under Section 809(b)`);
    // Once that report is approved, the client has another debt with the collector: the notice could be about it.
    await asUser(owner.userId, (db) => decideReport(db, owner, pending, 'approved'));
    expect((await brief(c, d)).circumstances.notice).toBeNull();
    expect((await letter({ clientId: c, disputeId: d, recipientAddress: COLLECTOR_ADDRESS })).body).not.toMatch(/809\(b\)|which I received on/);
  });

  it('for a debt typed by hand, counts until an account with that collector is on an approved report', async () => {
    const c = await newClient('Priya Raman');
    const day = daysAgo(9);
    await notice(c, { collectorName: 'Summit Account Services', date: day });
    const d = await create({ clientId: c, category: 'unverifiable_collection', recipientName: 'Summit Account Services', itemLabel: 'Summit Account Services ••2040', reason: 'I do not recognize a debt of $273.15 to Gem State Power.' });
    expect((await brief(c, d)).circumstances.notice).toMatchObject({ date: day, open: true });
    expect((await letter({ clientId: c, disputeId: d, recipientAddress: COLLECTOR_ADDRESS })).body).toContain(`which I received on ${said(day)}. Under Section 809(b)`);
    await report(c, 'experian', '2026-10-01', [collection('SUMMIT ACCOUNT SERVICES', '1188', 50000)]);
    const b = await brief(c, d);
    expect(b.circumstances.notice).toBeNull();
    // Still a collection (that collector has written to the client), so the letter is drafted, without the date or the statute.
    expect(b.context.facts).toMatchObject({ isCollection: true, notice: null });
    const l = await letter({ clientId: c, disputeId: d, recipientAddress: COLLECTOR_ADDRESS });
    expect(l.body).toContain('I am writing about the debt referenced above. I dispute this debt and ask that you provide validation of it, including:');
    expect(l.body).not.toMatch(/809\(b\)|which I received on/);
  });
});

describe('the facts a letter rests on are checked again when it is sent for approval and when it is approved', () => {
  it('a validation request drafted inside the 30 days is not approved after they end, and a new draft leaves the statute out', async () => {
    const c = await newClient('Angela Whitfield');
    const exp = await report(c, 'experian', '2026-10-01', [collection('NORTHSTAR RECOVERY', '9032', 61240)]);
    const row = await rowOn(exp, '9032');
    const d = await create({ clientId: c, tradelineId: row, category: 'unverifiable_collection', reason: 'I do not recognize a balance of $612.40 owed to Riverside Medical Group.' });
    const n = await notice(c, { tradelineId: row, date: daysAgo(25) });
    const l = await letter({ clientId: c, disputeId: d, recipientAddress: COLLECTOR_ADDRESS });
    expect(l.body).toContain('Under Section 809(b) of the Fair Debt Collection Practices Act');
    // The title names the letter, not the statute it cites only within the 30 days.
    expect((await letterRow(l.id))!.title).toBe('Debt validation request — NORTHSTAR RECOVERY ••9032');
    await move(l.id, 'pending_approval');
    // Twenty days later the notice is 45 days old: the validation period ended after the letter was drafted.
    const received = daysAgo(45);
    await ageNotice(n, received);
    const ends = (await brief(c, d)).circumstances.notice!.endsOn;
    const refusal = `This letter cites Section 809(b) of the Fair Debt Collection Practices Act, which applies to a request sent within 30 days of the collector’s notice, and the validation period for the notice received on ${said(received)} generally ended on ${said(ends)}. Draft the letter again.`;
    await expect(move(l.id, 'approved')).rejects.toThrow(refusal);
    expect((await letterRow(l.id))!.status).toBe('pending_approval');
    await move(l.id, 'draft');
    await expect(move(l.id, 'pending_approval')).rejects.toThrow(refusal);
    // Drafted again, the letter asks without citing the statute, and goes through.
    const again = await letter({ clientId: c, disputeId: d, recipientAddress: COLLECTOR_ADDRESS });
    expect(again.body).not.toMatch(/809\(b\)|1692g|as the statute provides/);
    await move(again.id, 'pending_approval');
    await move(again.id, 'approved');
    expect((await letterRow(again.id))!.status).toBe('approved');
  });

  it('an agency’s own validation template is held the same way', async () => {
    const c = await newClient('Rory Finch');
    const exp = await report(c, 'experian', '2026-10-01', [collection('HARBOR RECOVERY', '5521', 31000)]);
    const row = await rowOn(exp, '5521');
    const d = await create({ clientId: c, tradelineId: row, category: 'unverifiable_collection', reason: 'I do not recognize this debt of $310.00.' });
    const n = await notice(c, { tradelineId: row, date: daysAgo(20) });
    const own = await withSystem((db) => db.row<{ id: string }>(
      "insert into public.letter_templates (org_id, base_key, name, kind, language, body) values ($1, 'validation_request_en', $2, 'validation_request', 'en', $3) returning id",
      [A.orgId, `Our validation letter ${uniq()}`, '{{date}}\n\n{{client_name}}\n{{client_address}}\n\n{{recipient_name}}\n{{recipient_address}}\n\nRe: Validation — {{item_label}}\n\nTo whom it may concern:\n\nUnder Section 809(b) of the Fair Debt Collection Practices Act (15 U.S.C. § 1692g(b)), I dispute this debt.\n\n{{reason}}\n\nSincerely,\n\n{{client_name}}'])).then((r) => `org:${r!.id}`);
    const l = await letter({ clientId: c, disputeId: d, templateKey: own, recipientAddress: COLLECTOR_ADDRESS });
    await move(l.id, 'pending_approval');
    await ageNotice(n, daysAgo(60));
    await expect(move(l.id, 'approved')).rejects.toThrow(/This template says the request is made under Section 809\(b\)[\s\S]*Draft the letter again\.$/);
  });

  it('a letter approved inside the 30 days can still be recorded as sent: that records what happened', async () => {
    const c = await newClient('Devon Hart');
    const exp = await report(c, 'experian', '2026-10-01', [collection('MIDLAND CREDIT', '7788', 41250)]);
    const row = await rowOn(exp, '7788');
    const d = await create({ clientId: c, tradelineId: row, category: 'unverifiable_collection', reason: 'I do not recognize the amount of $412.50.' });
    const n = await notice(c, { tradelineId: row, date: daysAgo(28) });
    const l = await letter({ clientId: c, disputeId: d, recipientAddress: COLLECTOR_ADDRESS });
    await move(l.id, 'pending_approval');
    await move(l.id, 'approved');
    await ageNotice(n, daysAgo(40));
    await asUser(owner.userId, (db) => markSent(db, owner, l.id, 'certified_mail', 'CM-1', daysAgo(10)));
    expect((await letterRow(l.id))!.status).toBe('sent');
  });

  it('a follow-up drafted while no response was recorded is not sent for approval once one is', async () => {
    const c = await newClient('Maria Lopez');
    const d = await create({ clientId: c, category: 'incorrect_balance', bureau: 'experian', itemLabel: 'Lakeside Finance ••5501', fields: ['Balance'], reason: 'Experian reports a balance of $85.00 for Lakeside Finance. My receipt dated May 4, 2026 shows I paid it in full.' });
    await withSystem((db) => db.run("update public.disputes set status = 'submitted', submitted_at = now() - interval '60 days', due_at = now() - interval '30 days' where id = $1", [d]));
    const f = await letter({ clientId: c, disputeId: d, templateKey: 'follow_up_en' });
    expect(f.body).toContain('I have no record of receiving the results of your reinvestigation.');
    await asUser(owner.userId, (db) => recordResponse(db, owner, d, { outcome: 'verified', receivedOn: daysAgo(2) }));
    await expect(move(f.id, 'pending_approval')).rejects.toThrow('This letter no longer fits what is on file. A response is recorded for this dispute, so a follow-up for no response does not apply. Draft the letter again.');
    expect((await letterRow(f.id))!.status).toBe('draft');
  });

  it('a letter about an item the client has since confirmed as accurate is not approved', async () => {
    const c = await newClient('Quinn Vale');
    const d = await create({ clientId: c, category: 'incorrect_balance', bureau: 'experian', itemLabel: 'Lakeside Finance ••5502', fields: ['Balance'], reason: 'Experian reports a balance of $85.00 for Lakeside Finance. My receipt dated May 4, 2026 shows I paid it in full.' });
    const l = await letter({ clientId: c, disputeId: d });
    await move(l.id, 'pending_approval');
    await asUser(owner.userId, (db) => setConfirmedAccurate(db, owner, d, true));
    await expect(move(l.id, 'approved')).rejects.toThrow('The client confirmed this item is reported accurately, so no further letter or round is offered for it.');
    // Taken back (the tick was a mistake), the letter is approved as before.
    await asUser(owner.userId, (db) => setConfirmedAccurate(db, owner, d, false));
    await move(l.id, 'approved');
    expect((await letterRow(l.id))!.status).toBe('approved');
  });
});
