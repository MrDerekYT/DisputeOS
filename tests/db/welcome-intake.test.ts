import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cancelAgreement, cancellationBlock, deletionBlock, loadClientAgreements, renderFor, signAgreement, type Signer } from '@/lib/agreements';
import { acceptInvite, createInviteToken, getInvite, inviteNotice } from '@/lib/auth/service';
import { addDays, cancellationEndsOn, sayDay } from '@/lib/business-days';
import { storedTerms, type AgreementTerms } from '@/lib/compliance/agreement-terms';
import { isRendered, type ConsentKind, type RenderedConsent } from '@/lib/compliance/disclosures';
import { transitionDispute, type DActor } from '@/lib/disputes/service';
import { markSent } from '@/lib/letters/service';
import { loadOnboarding } from '@/lib/onboarding';
import { dayInZone } from '@/lib/util';
import { expireWelcomeLinks, issueWelcomeLink, welcomeClient, welcomeLinkProblem } from '@/lib/welcome-link';
import { recordConsentRows } from './consents';
import { addClient, addDispute, addMember, asUser, closePool, makeOrg, PASSWORD, testIp, uniq, withSystem, type TestOrg } from './helpers';

/**
 * The client welcome: the link, the details a client may give once, signing exactly what was shown and in order, no
 * service while the cancellation period runs, cancelling from the portal, and keeping the signed statement 2 years.
 * Through the real services, as the signed-in staff member or client, under row-level security.
 */
const TERMS: AgreementTerms = {
  legalName: 'Bright Path Credit LLC', address: '500 Bayshore Blvd, Suite 210, Tampa, FL 33606',
  services: 'We review your three credit reports with you, prepare dispute letters for the items you choose, track each investigation and report every response to you in your portal.',
  paymentTerms: 'A monthly fee of $99.00, charged on the 1st of each month for the work fully performed in the month before.',
  totalCents: 59_400, duration: 'About 6 months from the date you sign.', additional: '', updatedAt: '2026-11-20T15:00:00.000Z', updatedBy: 'test',
};
const saveTerms = (orgId: string, t: AgreementTerms = TERMS) =>
  withSystem((db) => db.run("update public.organizations set settings = settings || jsonb_build_object('agreement', $2::jsonb) where id = $1", [orgId, JSON.stringify(storedTerms(t))]));
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const NY = 'America/New_York';

let A: TestOrg;
let B: TestOrg;
beforeAll(async () => {
  A = await makeOrg('Welcome');
  B = await makeOrg('OtherAgency');
  await saveTerms(A.orgId);
});
afterAll(closePool);

/** A portal client of `org`, with no date of birth or SSN on file unless `identity`. */
async function portalClient(org: TestOrg, name = 'Dana Whitfield', identity = false) {
  const user = await addMember(org.orgId, 'client', 'portal');
  const clientId = await addClient(org.orgId, name, { portalUserId: user.id, identity });
  await withSystem((db) => db.run('update public.clients set assigned_to = $2 where id = $1', [clientId, org.ownerId]));
  const who: Signer = { orgId: org.orgId, clientId, userId: user.id, ip: '203.0.113.7', userAgent: 'vitest', by: 'client' };
  return { userId: user.id, clientId, who };
}
const shownNow = async (userId: string, orgId: string, clientId: string, kind: ConsentKind, now = new Date()) => {
  const a = await asUser(userId, (db) => loadClientAgreements(db, orgId, clientId, now));
  const r = renderFor(a!, kind);
  if (!isRendered(r)) throw new Error(`${kind} not ready`);
  return r as RenderedConsent;
};
/** Signs the four required agreements in order, as the client, at `now`. */
async function signAll(c: Awaited<ReturnType<typeof portalClient>>, org: TestOrg, now = new Date()) {
  for (const kind of ['esign', 'croa_disclosure', 'croa_contract', 'fcra_authorization'] as const) {
    const r = await shownNow(c.userId, org.orgId, c.clientId, kind, now);
    await asUser(c.userId, (db) => signAgreement(db, c.who, { kind, signedName: 'Dana Whitfield', shown: r.sha256, lang: 'en' }, now));
  }
}
const consentRows = (clientId: string) => withSystem((db) => db.rows<{ kind: string; revoked_at: string | null }>('select kind, revoked_at from public.client_consents where client_id = $1 order by signed_at', [clientId]));

describe('the welcome link', () => {
  it('a new link ends the earlier unused ones: only the latest works, and an old one still says which agency sent it', async () => {
    const c = await addClient(A.orgId, 'Lee Moreno', { status: 'lead' });
    const client = (await asUser(A.ownerId, (db) => welcomeClient(db, c)))!;
    expect(welcomeLinkProblem(client)).toBeNull();
    const actor = { orgId: A.orgId, userId: A.ownerId, ip: '10.0.0.1' };
    const first = await asUser(A.ownerId, (db) => issueWelcomeLink(db, actor, client, 'copy'));
    const second = await asUser(A.ownerId, (db) => issueWelcomeLink(db, actor, client, 'email'));
    const token = (link: string) => link.split('/invite/')[1]!;
    expect(first.expired).toBe(0);
    expect(second.expired).toBe(1);
    expect(await getInvite(token(first.link))).toBeNull();
    expect(await getInvite(token(second.link))).toMatchObject({ clientId: c, role: 'client', orgId: A.orgId });
    expect(await inviteNotice(token(first.link))).toMatchObject({ role: 'client', orgId: A.orgId, clientLang: 'en' });
    expect(await inviteNotice(`never-issued-${uniq()}-${uniq()}-${uniq()}`)).toBeNull();
    // A link to copy is logged when it is made; an emailed one only once the email service took it (logWelcomeEmail).
    const events = await withSystem((db) => db.rows<{ via: string }>("select meta->>'via' as via from public.client_events where client_id = $1 and kind = 'portal_invited' order by created_at", [c]));
    expect(events.map((e) => e.via)).toEqual(['copy']);

    // Accepting it links the client, saves the language they chose on the page, and the welcome steps begin.
    const r = await acceptInvite(token(second.link), { fullName: 'Lee Moreno', password: PASSWORD, lang: 'es' }, { ip: testIp() });
    expect(r.ok).toBe(true);
    const row = await withSystem((db) => db.row<{ preferred_language: string; portal_user_id: string | null; status: string }>('select preferred_language, portal_user_id, status from public.clients where id = $1', [c]));
    expect(row).toMatchObject({ preferred_language: 'es', status: 'onboarding' });
    expect(row!.portal_user_id).toBeTruthy();
    expect(welcomeLinkProblem((await asUser(A.ownerId, (db) => welcomeClient(db, c)))!)).toMatch(/already has portal access/);
    expect(await asUser(A.ownerId, (db) => loadOnboarding(db, c))).toMatchObject({ current: 'details', agreements: { signed: 0, total: 4 } });
  });

  it('staff of another agency can neither see the client, nor read, end or make a link for them', async () => {
    const c = await addClient(A.orgId, 'Pat Quinn', { status: 'lead' });
    const mine = await asUser(A.ownerId, async (db) => issueWelcomeLink(db, { orgId: A.orgId, userId: A.ownerId }, (await welcomeClient(db, c))!, 'copy'));
    expect(await asUser(B.ownerId, (db) => welcomeClient(db, c))).toBeNull();
    expect(welcomeLinkProblem(null)).toBe('Client not found.');
    expect(await asUser(B.ownerId, (db) => db.rows('select id from public.invites where client_id = $1', [c]))).toEqual([]);
    expect(await asUser(B.ownerId, (db) => expireWelcomeLinks(db, c))).toBe(0);
    await expect(asUser(B.ownerId, (db) => createInviteToken(db, { orgId: A.orgId, email: 'pat@example.test', role: 'client', clientId: c, invitedBy: B.ownerId }))).rejects.toThrow(/row-level security/);
    // A link B makes in its own workspace for A's client cannot attach anyone to that client, even with the client's email.
    const patEmail = (await withSystem((db) => db.row<{ email: string }>('select email from public.clients where id = $1', [c])))!.email;
    const theirs = await asUser(B.ownerId, (db) => createInviteToken(db, { orgId: B.orgId, email: patEmail, role: 'client', clientId: c, invitedBy: B.ownerId }));
    expect(await getInvite(theirs)).toBeNull();
    expect((await acceptInvite(theirs, { fullName: 'Pat Quinn', password: PASSWORD }, { ip: testIp() })).ok).toBe(false);
    expect((await withSystem((db) => db.row<{ p: string | null }>('select portal_user_id as p from public.clients where id = $1', [c])))!.p).toBeNull();
    expect(await getInvite(mine.link.split('/invite/')[1]!)).toMatchObject({ clientId: c });
  });
});

describe('date of birth and SSN: the client may write them once', () => {
  const GUARD = /portal users may only update phone, address and preferred language/;
  it('fills them while empty, never changes them after, and everything else stays protected', async () => {
    const c = await portalClient(A, 'Rae Okafor');
    const set = (sql: string, p: unknown[] = []) => asUser(c.userId, (db) => db.run(`update public.clients set ${sql} where id = $1`, [c.clientId, ...p] as never[]));
    expect(await set('dob_encrypted = $2', ['v1.first'])).toBe(1);
    expect(await set('ssn_last4 = $2, ssn_encrypted = $3', ['4321', 'v1.ssn'])).toBe(1);
    await expect(set('dob_encrypted = $2', ['v1.second'])).rejects.toThrow(GUARD);
    await expect(set('dob_encrypted = null')).rejects.toThrow(GUARD);
    await expect(set('ssn_last4 = $2', ['9999'])).rejects.toThrow(GUARD);
    await expect(set('ssn_encrypted = $2', ['v1.other'])).rejects.toThrow(GUARD);
    for (const sql of ["full_name = 'Someone Else'", "status = 'cancelled'", "email = 'x@y.test'", "tags = '{vip}'", 'banking_concern = true']) await expect(set(sql), sql).rejects.toThrow(GUARD);
    expect(await set("phone = '813-555-0142', preferred_language = 'es'")).toBe(1);
    const row = await withSystem((db) => db.row<{ dob_encrypted: string; ssn_last4: string; ssn_encrypted: string }>('select dob_encrypted, ssn_last4, ssn_encrypted from public.clients where id = $1', [c.clientId]));
    expect(row).toEqual({ dob_encrypted: 'v1.first', ssn_last4: '4321', ssn_encrypted: 'v1.ssn' });
    // Staff are not limited by the guard: they can still correct a wrong value.
    expect(await asUser(A.ownerId, (db) => db.run("update public.clients set ssn_last4 = '1111' where id = $1", [c.clientId]))).toBe(1);
  });
});

describe('signing exactly what was shown, in order', () => {
  it('stores the exact text, its full SHA-256, the language of the page and who signed; the database checks the hash', async () => {
    const c = await portalClient(A);
    const esign = await shownNow(c.userId, A.orgId, c.clientId, 'esign');
    const { id } = await asUser(c.userId, (db) => signAgreement(db, c.who, { kind: 'esign', signedName: 'Dana Whitfield', shown: esign.sha256, lang: 'es' }));
    const row = await withSystem((db) => db.row('select text_shown, text_sha256, page_lang, version, recorded_by, ip, signed_name from public.client_consents where id = $1', [id]));
    expect(row).toEqual({ text_shown: esign.text, text_sha256: sha(esign.text), page_lang: 'es', version: esign.version, recorded_by: null, ip: '203.0.113.7', signed_name: 'Dana Whitfield' });
    expect(esign.text).toContain('Bright Path Credit LLC');
    // A stored hash that is not the hash of the stored text is refused by the database itself.
    await expect(withSystem((db) => db.run("insert into public.client_consents (org_id, client_id, kind, version, signed_name, text_shown, text_sha256, page_lang) values ($1, $2, 'communications', 'x', 'Dana', 'one text', $3, 'en')", [A.orgId, c.clientId, sha('another text')]))).rejects.toThrow(/client_consents_text_hash/);
    // A client cannot write a signature that claims staff recorded it.
    await expect(asUser(c.userId, (db) => db.run("insert into public.client_consents (org_id, client_id, kind, version, signed_name, recorded_by) values ($1, $2, 'communications', 'x', 'Dana', $3)", [A.orgId, c.clientId, A.ownerId]))).rejects.toThrow(/row-level security/);
  });

  it('refuses a text that changed since the page showed it: terms edited meanwhile, or the day rolled over at midnight', async () => {
    const c = await portalClient(A);
    for (const kind of ['esign', 'croa_disclosure'] as const) {
      const r = await shownNow(c.userId, A.orgId, c.clientId, kind);
      await asUser(c.userId, (db) => signAgreement(db, c.who, { kind, signedName: 'Dana', shown: r.sha256, lang: 'en' }));
    }
    const B2 = await makeOrg('TermsChange');
    await saveTerms(B2.orgId);
    const d = await portalClient(B2);
    for (const kind of ['esign', 'croa_disclosure'] as const) {
      const r = await shownNow(d.userId, B2.orgId, d.clientId, kind);
      await asUser(d.userId, (db) => signAgreement(db, d.who, { kind, signedName: 'Dana', shown: r.sha256, lang: 'en' }));
    }
    const opened = await shownNow(d.userId, B2.orgId, d.clientId, 'croa_contract');
    await saveTerms(B2.orgId, { ...TERMS, duration: 'About 4 months from the date you sign.' });
    const changed = asUser(d.userId, (db) => signAgreement(db, d.who, { kind: 'croa_contract', signedName: 'Dana Whitfield', shown: opened.sha256, lang: 'en' }));
    await expect(changed).rejects.toMatchObject({ code: 'changed', message: 'This agreement changed since you opened it. Please read it again.' });
    expect((await consentRows(d.clientId)).map((k) => k.kind)).toEqual(['esign', 'croa_disclosure']);

    // Opened at 11:58 p.m. in the agency's zone, sent at 12:01 a.m.: the date in the agreement is no longer the same.
    const dayOne = '2026-12-07';
    const before = new Date(`${dayOne}T23:58:00-05:00`);
    const after = new Date(`${addDays(dayOne, 1)}T00:01:00-05:00`);
    const late = await shownNow(c.userId, A.orgId, c.clientId, 'croa_contract', before);
    await expect(asUser(c.userId, (db) => signAgreement(db, c.who, { kind: 'croa_contract', signedName: 'Dana Whitfield', shown: late.sha256, lang: 'en' }, after))).rejects.toMatchObject({ code: 'changed' });
    // Read again, it goes through, and carries the new date and the matching last day to cancel.
    const fresh = await shownNow(c.userId, A.orgId, c.clientId, 'croa_contract', after);
    await asUser(c.userId, (db) => signAgreement(db, c.who, { kind: 'croa_contract', signedName: 'Dana Whitfield', shown: fresh.sha256, lang: 'en' }, after));
    expect(fresh.text).toContain('Date: December 8, 2026');
    expect(fresh.text).toContain(`before midnight on December 11, 2026`); // 3 business days after Tuesday 8 December
    expect(cancellationEndsOn('2026-12-08')).toBe('2026-12-11');
  });

  it('refuses documents out of order; staff recording paper keeps the statement → contract → authorization order', async () => {
    const c = await portalClient(A);
    const sign = (kind: ConsentKind, who: Signer = c.who) => shownNow(c.userId, A.orgId, c.clientId, kind).then((r) => asUser(who.by === 'staff' ? A.ownerId : c.userId, (db) => signAgreement(db, who, { kind, signedName: 'Dana Whitfield', shown: r.sha256, lang: 'en' })));
    await expect(sign('croa_disclosure')).rejects.toMatchObject({ code: 'order', before: 'esign' });
    await expect(sign('croa_contract')).rejects.toMatchObject({ code: 'order', before: 'esign' });
    await sign('esign');
    await expect(sign('fcra_authorization')).rejects.toMatchObject({ code: 'order', before: 'croa_disclosure' });
    await sign('croa_disclosure');
    await expect(sign('croa_disclosure')).rejects.toMatchObject({ code: 'already' });
    expect((await consentRows(c.clientId)).map((k) => k.kind)).toEqual(['esign', 'croa_disclosure']);

    const staff: Signer = { orgId: A.orgId, clientId: '', userId: A.ownerId, ip: '10.0.0.1', userAgent: 'vitest', by: 'staff' };
    const paper = await addClient(A.orgId, 'Sam Paper');
    const record = (kind: ConsentKind) => asUser(A.ownerId, (db) => signAgreement(db, { ...staff, clientId: paper }, { kind, signedName: 'Sam Paper', lang: 'en', paperSignedOn: dayInZone(NY) }));
    await expect(record('croa_contract')).rejects.toMatchObject({ code: 'order', before: 'croa_disclosure' });
    const d = await record('croa_disclosure'); // no E-SIGN consent is needed for a paper signature
    await record('croa_contract');
    await record('fcra_authorization');
    const rows = await withSystem((db) => db.rows<{ kind: string; recorded_by: string | null; has_text: boolean }>('select kind, recorded_by, text_shown is not null as has_text from public.client_consents where client_id = $1 order by signed_at', [paper]));
    expect(rows).toEqual(['croa_disclosure', 'croa_contract', 'fcra_authorization'].map((kind) => ({ kind, recorded_by: A.ownerId, has_text: true })));
    expect(d.rendered.doc.kind).toBe('croa_disclosure');
  });

  it('the contract cannot be signed, in the portal or on paper, until the agency has saved its terms', async () => {
    const c = await portalClient(B);
    for (const kind of ['esign', 'croa_disclosure'] as const) {
      const r = await shownNow(c.userId, B.orgId, c.clientId, kind);
      await asUser(c.userId, (db) => signAgreement(db, c.who, { kind, signedName: 'Dana', shown: r.sha256, lang: 'en' }));
    }
    const a = await asUser(c.userId, (db) => loadClientAgreements(db, B.orgId, c.clientId));
    expect(renderFor(a!, 'croa_contract')).toMatchObject({ notReady: true });
    await expect(asUser(c.userId, (db) => signAgreement(db, c.who, { kind: 'croa_contract', signedName: 'Dana', shown: '0'.repeat(64), lang: 'en' }))).rejects.toMatchObject({ code: 'not_ready' });
    await expect(asUser(B.ownerId, (db) => signAgreement(db, { ...c.who, userId: B.ownerId, by: 'staff' }, { kind: 'croa_contract', signedName: 'Dana', lang: 'en', paperSignedOn: dayInZone(NY) }))).rejects.toThrow(/Save them in Settings → Client agreement first/);
  });
});

describe('no service while the cancellation period runs', () => {
  it('a dispute cannot be recorded as submitted, nor a letter as sent, until the period is over; then both are allowed', async () => {
    const owner: DActor = { orgId: A.orgId, userId: A.ownerId, role: 'owner' };
    const clientId = await addClient(A.orgId, 'Morgan Lee');
    await recordConsentRows(A.orgId, clientId, new Date()); // the service agreement signed just now
    const today = dayInZone(NY);
    const ends = sayDay(cancellationEndsOn(today));
    const letter = (disputeId: string | null) => withSystem((db) => db.row<{ id: string }>("insert into public.letters (org_id, client_id, dispute_id, kind, title, recipient_name, status) values ($1, $2, $3, 'dispute', 'Dispute letter', 'Experian', 'approved') returning id", [A.orgId, clientId, disputeId])).then((r) => r!.id);
    const dispute = await addDispute(A.orgId, clientId, 'approved');
    await letter(dispute);
    const loose = await letter(null);

    const submit = () => asUser(A.ownerId, (db) => transitionDispute(db, owner, dispute, 'submitted', { sentMethod: 'certified_mail' }));
    await expect(submit()).rejects.toThrow(`Morgan Lee can still cancel their service agreement: the cancellation period runs through ${ends}. No dispute can be recorded as submitted before it ends`);
    await expect(asUser(A.ownerId, (db) => markSent(db, owner, loose, 'certified_mail'))).rejects.toThrow(`Morgan Lee can still cancel their service agreement: the cancellation period runs through ${ends}. No letter can be recorded as sent before it ends`);
    expect(await asUser(A.ownerId, (db) => cancellationBlock(db, clientId, 'submit'))).toMatch(/15 U\.S\.C\. § 1679d\(a\)\(2\)/);

    // Signed more than 3 business days ago: the period is over.
    await withSystem((db) => db.run("update public.client_consents set signed_at = now() - interval '10 days' where client_id = $1", [clientId]));
    expect(await asUser(A.ownerId, (db) => cancellationBlock(db, clientId, 'submit'))).toBeNull();
    await submit();
    await asUser(A.ownerId, (db) => markSent(db, owner, loose, 'certified_mail'));
    const s = await withSystem((db) => db.row<{ d: string; l: string }>('select (select status from public.disputes where id = $1) as d, (select status from public.letters where id = $2) as l', [dispute, loose]));
    expect(s).toEqual({ d: 'submitted', l: 'sent' });
  });
});

describe('the client cancels from the portal', () => {
  it('posts their written notice, revokes only their own agreement, and the specialist is told', async () => {
    const x = await portalClient(A);
    const y = await portalClient(A, 'Dana Whitfield');
    await signAll(x, A);
    await signAll(y, A);
    await expect(asUser(x.userId, (db) => cancelAgreement(db, x.who, 'Someone Else'))).rejects.toMatchObject({ code: 'name' });
    const { messageId } = await asUser(x.userId, (db) => cancelAgreement(db, x.who, 'Dana Whitfield'));
    const contract = async (clientId: string) => (await consentRows(clientId)).find((k) => k.kind === 'croa_contract')!;
    expect((await contract(x.clientId)).revoked_at).not.toBeNull();
    expect((await contract(y.clientId)).revoked_at).toBeNull();
    const m = await withSystem((db) => db.row<{ direction: string; channel: string; subject: string; body: string; author_id: string }>('select direction, channel, subject, body, author_id from public.communications where id = $1', [messageId]));
    expect(m).toMatchObject({ direction: 'inbound', channel: 'portal', subject: 'Notice of cancellation', author_id: x.userId });
    expect(m!.body).toMatch(/^I hereby cancel this transaction\.\n\nDate: \w+ \d{1,2}, \d{4}\nSigned: Dana Whitfield\n/);
    const told = await withSystem((db) => db.row<{ n: number }>("select count(*)::int as n from public.notifications where user_id = $1 and href = $2 and title = 'New message from a client'", [A.ownerId, `/app/clients/${x.clientId}?tab=messages`]));
    expect(told!.n).toBe(1);
    // With nothing left in force there is nothing to cancel, and no second notice is posted.
    await expect(asUser(x.userId, (db) => cancelAgreement(db, x.who, 'Dana Whitfield'))).rejects.toMatchObject({ code: 'not_ready' });
    expect((await withSystem((db) => db.row<{ n: number }>("select count(*)::int as n from public.communications where client_id = $1 and subject = 'Notice of cancellation'", [x.clientId])))!.n).toBe(1);
    // The function revokes only the caller's own agreement: staff are no portal client, so it does nothing for them.
    expect((await asUser(A.ownerId, (db) => db.row<{ n: number }>('select app.cancel_own_contract() as n')))!.n).toBe(0);
    expect((await contract(y.clientId)).revoked_at).toBeNull();
  });

  it('after the period only a message is offered: the agreement cannot be cancelled from the portal', async () => {
    const z = await portalClient(A);
    await signAll(z, A);
    // Signed 10 days ago: the days stored at signing move back too (the last day fixed then is never shortened by a recount).
    await withSystem((db) => db.run("update public.client_consents set signed_at = now() - interval '10 days', signed_on = signed_on - 10, cancellation_ends_on = cancellation_ends_on - 10 where client_id = $1", [z.clientId]));
    await expect(asUser(z.userId, (db) => cancelAgreement(db, z.who, 'Dana Whitfield'))).rejects.toMatchObject({ code: 'not_ready' });
    expect((await consentRows(z.clientId)).every((k) => !k.revoked_at)).toBe(true);
    // Even called directly, the database function leaves an agreement signed that long ago alone.
    expect((await asUser(z.userId, (db) => db.row<{ n: number }>('select app.cancel_own_contract() as n')))!.n).toBe(0);
  });
});

describe('the signed statement is kept 2 years', () => {
  it('deleting a client whose statement was signed less than 2 years ago is refused, with the date and the way to stop work instead', async () => {
    const clientId = await addClient(A.orgId, 'Kept Client');
    await recordConsentRows(A.orgId, clientId, new Date('2026-01-15T15:00:00Z'));
    const msg = await asUser(A.ownerId, (db) => deletionBlock(db, clientId, new Date('2027-06-01T15:00:00Z')));
    expect(msg).toBe('This client signed the Consumer Credit File Rights statement on Jan 15, 2026. Federal law (15 U.S.C. § 1679c(c)) requires you to keep the signed statement for 2 years, so this client can be deleted from Jan 16, 2028. To stop work for them now, set their status to Cancelled instead.');
    expect(await asUser(A.ownerId, (db) => deletionBlock(db, clientId, new Date('2028-01-16T15:00:00Z')))).toBeNull();
    // The database refuses it too, whatever the application does.
    await expect(asUser(A.ownerId, (db) => db.run('delete from public.clients where id = $1', [clientId]))).rejects.toThrow(/must be kept for 2 years \(15 U\.S\.C\. 1679c\(c\)\), so the client cannot be deleted before 2028-01-15/);
    expect((await withSystem((db) => db.row<{ n: number }>('select count(*)::int as n from public.clients where id = $1', [clientId])))!.n).toBe(1);
  });

  it('once 2 years have passed the client can be deleted, and a client with no signed statement any time', async () => {
    const old = await addClient(A.orgId, 'Old Client');
    await recordConsentRows(A.orgId, old, new Date(Date.now() - (2 * 366 + 2) * 86_400_000));
    expect(await asUser(A.ownerId, (db) => deletionBlock(db, old))).toBeNull();
    expect(await asUser(A.ownerId, (db) => db.run('delete from public.clients where id = $1', [old]))).toBe(1);
    const never = await addClient(A.orgId, 'Never Signed');
    expect(await asUser(A.ownerId, (db) => deletionBlock(db, never))).toBeNull();
    expect(await asUser(A.ownerId, (db) => db.run('delete from public.clients where id = $1', [never]))).toBe(1);
  });
});
