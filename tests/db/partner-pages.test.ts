import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Ctx } from '@/lib/auth/context';
import type { SessionInfo } from '@/lib/auth/service';
import { addDays, isBusinessDay } from '@/lib/business-days';
import { resetEnvCache } from '@/lib/env';
import { leadTextsOfferedBySlug, runLeadTexts } from '@/lib/lead-outreach';
import { submitLead } from '@/lib/leads';
import type { Email, SendResult } from '@/lib/mailer';
import { MAILING_ADDRESS_HELP } from '@/lib/mailing-address';
import { PARTNER_ATTESTATION, type PartnerInput } from '@/lib/partner-import';
import { addPartners, optOutPartner, partnerOptOutToken, runPartnerOutreach } from '@/lib/partner-outreach';
import { markPartner, setReferredBy } from '@/lib/partners';
import { can, type Role } from '@/lib/rbac';
import { addClient, addMember, approveOutreach, asUser, closePool, makeOrg, testIp, uniq, withSystem, type TestOrg } from './helpers';

// The pages are rendered here exactly as the server renders them, with the real queries under row-level security.
// Only the sign-in step is stood in for: `requireStaff` returns a context for a real user of a real test workspace.
const signedIn = vi.hoisted(() => ({ ctx: null as unknown }));
// Like the real one, a role without the permission is sent away before anything runs.
vi.mock('@/lib/auth/context', () => ({
  requireStaff: async (perm?: string) => {
    const ctx = signedIn.ctx as { can(p: string): boolean };
    if (perm && !ctx.can(perm)) throw new Error('REDIRECT /app?denied=1');
    return ctx;
  },
}));
// Outside a request there is no page cache to refresh and nowhere to redirect: the first is a no-op, the second is named.
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));
vi.mock('next/navigation', async (original) => ({ ...(await original<typeof import('next/navigation')>()), redirect: (to: string) => { throw new Error(`REDIRECT ${to}`); } }));
// The test runner compiles JSX to React.createElement, so React has to be in scope when a component renders.
vi.stubGlobal('React', React);

import { leadAskedToStopAction, saveLeadFollowUpAction } from '@/app/app/leads/actions';
import { stopPartnerEmailsAction } from '@/app/unsubscribe/partner/[token]/actions';
import {
  addPartnerAction, importPartnersAction, markPartnerAction, partnerAskedToStopAction, pausePartnerAction, removePartnerAction, retryPartnerAction,
  savePartnerOutreachAction, setReferredByAction, updatePartnerAction,
} from '@/app/app/partners/actions';
import PartnerPage from '@/app/app/partners/[id]/page';
import PartnersPage from '@/app/app/partners/page';
import LeadsPage from '@/app/app/leads/page';
import PartnerUnsubscribePage from '@/app/unsubscribe/partner/[token]/page';
import { ReferredByBlock } from '@/app/app/clients/[id]/referred-by-block';

const saved = { ...process.env };
beforeAll(() => { process.env.SMS_DRIVER = 'log'; resetEnvCache(); });
afterAll(async () => { process.env = { ...saved }; resetEnvCache(); await closePool(); });

type Agency = TestOrg & { slug: string; name: string };
const ADDRESS = '12 Main St, Austin, TX 78701';
const REPLY = 'hello@agency.example.test';
const ON = { partner_outreach_enabled: true, lead_mailing_address: ADDRESS, lead_reply_email: REPLY };
const MON = new Date('2026-03-02T15:00:00Z');

/** A workspace the platform operator has approved for outreach (long before any date used below); `approved: false` is one as sign-up leaves it. */
async function agency(label: string, settings: Record<string, unknown> = {}, approved = true): Promise<Agency> {
  const o = await makeOrg(label);
  const r = (await withSystem((db) => db.row<{ slug: string; name: string }>('update public.organizations set settings = settings || $2::jsonb where id = $1 returning slug, name', [o.orgId, JSON.stringify(settings)])))!;
  if (approved) await approveOutreach(o.orgId, new Date('2025-06-02T15:00:00Z'));
  return { ...o, ...r };
}
function signIn(a: Agency, role: Role = 'owner', userId = a.ownerId, orgMode: 'agency' | 'personal' = 'agency'): Ctx {
  const session: SessionInfo = { sessionId: 's', userId, orgId: a.orgId, role, email: a.ownerEmail, fullName: 'Test Person', mfaVerified: true, totpEnabled: false, orgName: a.name, orgSlug: a.slug, orgMode, orgPlan: 'trial' };
  const ctx: Ctx = { session, userId, orgId: a.orgId, role, tx: (fn) => asUser(userId, fn), can: (p) => can(role, p), need: () => undefined, meta: { ip: '10.0.0.1', userAgent: 'vitest' } };
  signedIn.ctx = ctx;
  return ctx;
}
/** What a person reads on the page: the markup with tags dropped and entities decoded. */
const read = (el: React.ReactNode) => renderToStaticMarkup(el as React.ReactElement).replace(/<!-- -->/g, '')
  .replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ');
const markup = (el: React.ReactNode) => renderToStaticMarkup(el as React.ReactElement);
const P = (name: string, over: Partial<PartnerInput> = {}): PartnerInput => ({
  businessName: name, contactName: 'Dana Whitfield', category: 'real_estate_agent', email: `p-${uniq()}@biz.example.test`, phone: '(512) 555-0134', city: 'Austin', state: 'TX', language: 'en', sourceNote: 'Their office website', ...over,
});
const add = async (a: Agency, rows: PartnerInput[]) => (await asUser(a.ownerId, (db) => addPartners(db, { orgId: a.orgId, userId: a.ownerId }, rows, 'Added by hand.'))).ids;
const sendWith = (result: Partial<SendResult> = {}) => async (_: Email): Promise<SendResult> => ({ ok: true, provider: 'resend', providerRef: 'ref-1', ...result });

describe('Partners pages render from real data', () => {
  it('an agency with no partners sees an empty list, the switch off and the forms to add partners', async () => {
    const a = await agency('PagesEmpty');
    signIn(a);
    const page = read(await PartnersPage({ searchParams: Promise.resolve({}) }));
    expect(page).toContain('Partners');
    expect(page).toContain('They are emailed only: this system never texts or calls a partner.');
    expect(page).toContain('No partners yet');
    expect(page).toMatch(/On your list 0 /);
    expect(page).toMatch(/Automatic email sequence .* Off /);
    expect(page).toContain('0 sent · 0 not sent · 0 opted out · 0 of 40 in the last 24 hours');
    expect(page).toContain('Replies are not read automatically.');
    expect(page).toContain('Send the email sequence to partners automatically');
    expect(page).toContain('Add one partner');
    expect(page).toContain('Import a list');
    expect(page).toContain('I compiled this myself from public business contact details and my own business contacts.');
    // The wording is fixed: the page says so, and offers no switch that would let a model write any of it.
    expect(page).toContain('No AI writes any part of it.');
    expect(markup(await PartnersPage({ searchParams: Promise.resolve({}) }))).not.toMatch(/name="ai"|AI wording/);
    expect(page).toContain('The platform operator approves each workspace before its sequence can send, and again after a change of business name.');
    // A personal workspace has no partners at all.
    signIn(a, 'owner', a.ownerId, 'personal');
    expect(read(await PartnersPage({ searchParams: Promise.resolve({}) }))).toContain('Partners are for agency workspaces');
  });

  it('lists every partner with its real status, sequence line and referral count, and filters and searches', async () => {
    const a = await agency('PagesList', ON);
    const [fresh, emailed, optedOut, refused, replied] = await add(a, [P('Fresh Realty'), P('Emailed Motors', { category: 'car_dealership' }), P('Opted Out Tax', { category: 'tax_preparer', city: 'Dallas' }), P('Refused Lending'), P('Replied Homes')]) as [string, string, string, string, string];
    for (const id of [emailed, optedOut, replied]) expect((await runPartnerOutreach(a.orgId, { live: true, send: sendWith(), now: MON, partnerId: id })).sent).toBe(1);
    expect((await runPartnerOutreach(a.orgId, { live: true, send: sendWith({ ok: false, error: 'domain not verified' }), now: MON, partnerId: refused })).failed).toBe(1);
    await optOutPartner(partnerOptOutToken(optedOut));
    await asUser(a.ownerId, (db) => markPartner(db, { orgId: a.orgId, userId: a.ownerId }, replied, 'replied'));
    const client = await addClient(a.orgId, 'Referred Person');
    await asUser(a.ownerId, (db) => setReferredBy(db, { orgId: a.orgId, userId: a.ownerId }, client, replied));

    signIn(a);
    const page = read(await PartnersPage({ searchParams: Promise.resolve({}) }));
    for (const name of ['Fresh Realty', 'Emailed Motors', 'Opted Out Tax', 'Refused Lending', 'Replied Homes']) expect(page).toContain(name);
    expect(page).toMatch(/On your list 5 /);
    expect(page).toMatch(/In sequence 1 /);
    expect(page).toMatch(/Replied or interested 1 /);
    expect(page).toMatch(/Clients referred 1 /);
    // Email is not connected in this environment, and the page says so instead of implying anything is going out.
    expect(page).toContain('On, but not sending');
    expect(page).toContain('Email is not connected, so nothing is being sent.');
    expect(page).toContain('3 sent · 1 not sent · 1 opted out');
    expect(page).toContain('Nothing sent. The sequence is not running');
    expect(page).toContain('1 of 3 sent. The sequence is not running');
    expect(page).toContain('Opted out: never emailed again');
    expect(page).toContain('Stopped: an email was not sent. Open to see why');
    expect(page).toContain('Stopped: a reply is on file');
    expect(page).toContain('Car dealership');
    expect(page).toContain('Dallas, TX');
    // "They replied" is offered where emails went out and no reply is on file yet: for the partner still in the sequence,
    // and for the one who opted out of the emails (they may still write or call; recording it sends nothing).
    const html = markup(await PartnersPage({ searchParams: Promise.resolve({}) }));
    expect(html.match(/>They replied</g)).toHaveLength(2);
    expect(html).toContain(`href="/app/partners/${fresh}"`);

    const filtered = read(await PartnersPage({ searchParams: Promise.resolve({ status: 'opted_out' }) }));
    expect(filtered).toContain('Opted Out Tax');
    expect(filtered).not.toContain('Fresh Realty');
    const found = read(await PartnersPage({ searchParams: Promise.resolve({ q: 'motors' }) }));
    expect(found).toContain('Emailed Motors');
    expect(found).not.toContain('Replied Homes');
    expect(read(await PartnersPage({ searchParams: Promise.resolve({ q: 'nobody-by-this-name' }) }))).toContain('No partners match');

    // A specialist can add and mark partners but cannot switch the sequence on or off; another agency sees none of these.
    const specialist = await addMember(a.orgId, 'specialist');
    signIn(a, 'specialist', specialist.id);
    const asSpecialist = read(await PartnersPage({ searchParams: Promise.resolve({}) }));
    expect(asSpecialist).toContain('An owner or admin can switch this on or off.');
    expect(asSpecialist).not.toContain('Send the email sequence to partners automatically');
    expect(asSpecialist).toContain('Add one partner');
    const b = await agency('PagesOther');
    signIn(b);
    const other = read(await PartnersPage({ searchParams: Promise.resolve({}) }));
    expect(other).toContain('No partners yet');
    expect(other).not.toContain('Fresh Realty');
    // A workspace nobody at the operator has approved yet: switched on, and the page says plainly why nothing goes out.
    const fresh2 = await agency('PagesFresh', ON, false);
    signIn(fresh2);
    const waiting = read(await PartnersPage({ searchParams: Promise.resolve({}) }));
    expect(waiting).toContain('On, but not sending');
    expect(waiting).toContain('This workspace has not been approved for automatic outreach yet. The platform operator approves each workspace before automatic emails to leads or partners, or any text message, go out; nothing is sent until then.');
    expect(waiting).not.toContain('Email is not connected, so nothing is being sent.');
    // Approved, then renamed: the page asks for a new approval instead of sending under a name nobody looked at.
    await approveOutreach(fresh2.orgId, new Date('2025-06-02T15:00:00Z'));
    await withSystem((db) => db.run("update public.organizations set name = 'Another Name LLC' where id = $1", [fresh2.orgId]));
    expect(read(await PartnersPage({ searchParams: Promise.resolve({}) }))).toContain('Your business name changed after this workspace was approved for automatic outreach.');
    await expect(PartnerPage({ params: Promise.resolve({ id: fresh }) })).rejects.toThrow(); // "not found" for a partner of another agency
  });

  it('when the email service keeps refusing, the page says the sequence is holding and why', async () => {
    const a = await agency('PagesHold', ON);
    await add(a, [P('First Realty'), P('Second Realty'), P('Third Realty')]);
    // The next business day, so the attempts count as recent whenever this test runs.
    let next = addDays(new Date().toISOString().slice(0, 10), 1);
    while (!isBusinessDay(next)) next = addDays(next, 1);
    expect(await runPartnerOutreach(a.orgId, { live: true, send: sendWith({ ok: false, error: 'domain not verified' }), now: new Date(`${next}T15:00:00Z`) })).toMatchObject({ failed: 2, held: 'failures' });
    signIn(a);
    const page = read(await PartnersPage({ searchParams: Promise.resolve({}) }));
    expect(page).toContain('The email service refused the last 2 emails (domain not verified). Nothing more is tried for 24 hours, or until you open one of those partners and press “Try again”.');
    expect(page.match(/Stopped: an email was not sent\. Open to see why/g)).toHaveLength(2);
    expect(page).toContain('Nothing sent. The sequence is not running'); // the third partner was not tried, and is not stopped
  });

  it('with email connected, the page names what is in the way: the website address, the mailing address, or too many bounces', async () => {
    // Email reads as connected for this test, so nothing else is in the way. Rendering a page sends nothing.
    Object.assign(process.env, { EMAIL_DRIVER: 'resend', RESEND_API_KEY: 're_test_key_for_vitest' });
    resetEnvCache();
    try {
      const page = async () => read(await PartnersPage({ searchParams: Promise.resolve({}) }));
      // The address of a site on the platform keeps the name the workspace signed up with.
      const a = await agency('Free Credit Help', { ...ON, website: { published: true, headline: 'Credit report help' } });
      await withSystem((db) => db.run('update public.organizations set name = $2 where id = $1', [a.orgId, `Hill Credit ${uniq()}`]));
      await approveOutreach(a.orgId, new Date('2025-06-02T15:00:00Z'));
      const [waiting] = await add(a, [P('Waiting Realty')]) as [string];
      signIn(a);
      const blocked = await page();
      expect(blocked).toContain('On, but not sending');
      expect(blocked).toContain(`The address of your website (http://localhost:3000/a/${a.slug}) cannot be printed in these emails. Only a first consultation may be called free. Do not call credit repair, reports, scores or results free. (“free”) The introduction and the follow-up link to your published site. Connect your own domain on the Website page, or unpublish the site.`);
      expect(blocked).toContain('Nothing sent. The sequence is not running');
      expect(blocked).not.toContain('On and sending');
      // The partner's own page says the same: due, but not going out.
      const own = read(await PartnerPage({ params: Promise.resolve({ id: waiting }) }));
      expect(own).toContain('Due, but the sequence is not running');
      expect(own).not.toContain('Goes out with the next scheduled run');
      // Unpublished, the emails carry no link and nothing is in the way.
      await withSystem((db) => db.run("update public.organizations set settings = jsonb_set(settings, '{website,published}', 'false'::jsonb) where id = $1", [a.orgId]));
      expect(await page()).toContain('On and sending');
      expect(read(await PartnerPage({ params: Promise.resolve({ id: waiting }) }))).toContain('Goes out with the next scheduled run');

      // Saved text that is not a postal address (from before the forms refused it) reads as none. The page says why,
      // and the form shows the saved text so it can be corrected.
      const c = await agency('PagesAddressJunk', { ...ON, lead_mailing_address: 'URGENT: sign in at https://secure-escrow-verify.example/login today' });
      signIn(c);
      expect(await page()).toContain('The saved mailing address cannot be used, so nothing is sent. A mailing address cannot contain a web address.');
      const formHtml = markup(await PartnersPage({ searchParams: Promise.resolve({}) }));
      expect(formHtml).toMatch(/<input[^>]*maxLength="160"[^>]*name="address" value="URGENT: sign in at https:\/\/secure-escrow-verify\.example\/login today"\/>/);
      // A promise is refused by the address rule itself, with the reason.
      const g = await agency('PagesAddressPromise', { ...ON, lead_mailing_address: '100 Guarantee Blvd, Tampa, FL 33606' });
      signIn(g);
      expect(await page()).toContain('The saved mailing address cannot be used, so nothing is sent. A mailing address cannot carry a promise or an offer: Results cannot be guaranteed.');

      // Too many bounces: counted since the approval, and the page says it does not start again by itself.
      const d = await agency('PagesBounces', ON);
      const ids = await add(d, Array.from({ length: 8 }, (_, i) => P(`Bounce Realty ${i}`)));
      expect((await runPartnerOutreach(d.orgId, { live: true, send: sendWith(), now: MON })).sent).toBe(8);
      for (const id of ids.slice(0, 3)) await asUser(d.ownerId, (db) => markPartner(db, { orgId: d.orgId, userId: d.ownerId }, id, 'bounced'));
      signIn(d);
      const SENTENCE = '3 addresses have bounced since this workspace was approved, against 8 emails sent. The sequence is holding, and it does not start again by itself. Check where the list came from and remove the partners not yet emailed whose addresses are not real. Then ask the platform operator to approve the workspace again.';
      const held = await page();
      expect(held).toContain('On, but holding');
      expect(held).toContain(SENTENCE);
      expect(held).not.toContain('in the last 30 days bounced');
      // A month later nothing has changed: the hold is still on and the page still says so.
      await withSystem((db) => db.run("update public.partner_events set created_at = created_at - interval '31 days' where org_id = $1 and kind = 'bounced'", [d.orgId]));
      expect(await page()).toContain(SENTENCE);
      expect(await page()).toContain('When too many addresses bounce, everything holds until the platform operator approves the workspace again.');
    } finally {
      process.env.EMAIL_DRIVER = saved.EMAIL_DRIVER;
      delete process.env.RESEND_API_KEY;
      resetEnvCache();
    }
  });

  it('a step that did not go through says which kind it was: refused by this app’s own check, or never answered by the email service', async () => {
    const a = await agency('PagesNotThrough', ON);
    // A city on file from before cities were checked when a partner is added.
    const [soil, unanswered] = await add(a, [P('Soil Realty', { city: 'Free Soil', state: 'MI' }), P('Quiet Realty')]) as [string, string];
    expect((await runPartnerOutreach(a.orgId, { live: true, send: sendWith(), now: MON, partnerId: soil })).failed).toBe(1);
    expect(await runPartnerOutreach(a.orgId, { live: true, send: sendWith({ ok: false, error: 'The operation was aborted due to timeout', unconfirmed: true }), now: MON, partnerId: unanswered })).toMatchObject({ sent: 0, failed: 0, held: 'no_answer' });
    signIn(a);

    const guard = read(await PartnerPage({ params: Promise.resolve({ id: soil }) }));
    expect(guard).toContain('This app did not send it, and the email service was never asked: the message would contain a claim that is not allowed (Only a first consultation may be called free. Do not call credit repair, reports, scores or results free.). Something on this record reads as a claim. Check the city and the contact name under “Edit details”, then ask for another try. Nothing further is sent to this partner until then.');
    expect(guard).not.toContain('The email service did not accept it');
    expect(guard).toContain('Try again');
    // The form on that page refuses the city for the same reason, and takes the record without it.
    const VALID = { id: soil, businessName: 'Soil Realty', category: 'real_estate_agent', state: 'MI', language: 'en' };
    const fd = (o: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.set(k, v); return f; };
    expect(await updatePartnerAction(undefined, fd({ ...VALID, city: 'Free Soil' }))).toEqual({ error: 'This city cannot be printed in the emails: “Free” would read as a claim they may not make. Leave the city empty for this partner.' });
    expect(await updatePartnerAction(undefined, fd({ ...VALID, city: '' }))).toEqual({ ok: 'Saved.' });
    await retryPartnerAction(fd({ id: soil }));
    expect((await runPartnerOutreach(a.orgId, { live: true, send: sendWith(), now: MON, partnerId: soil })).sent).toBe(1);

    const quiet = read(await PartnerPage({ params: Promise.resolve({ id: unanswered }) }));
    expect(quiet).toContain('Introduction Not confirmed as sent');
    expect(quiet).toContain('It was handed to the email service, and it is not known whether the service accepted it (The operation was aborted due to timeout). It may or may not have arrived, so it is not sent again. Contact this partner yourself.');
    expect(quiet).toContain('Stopped: one email was not confirmed as sent. Contact them yourself');
    expect(quiet).toContain('Read the email'); // what may have arrived can be read
    expect(quiet).not.toContain('Try again');
    expect(quiet).not.toContain('The email service did not accept it');
    expect(quiet).toContain('Introduction email: the email service did not answer (The operation was aborted due to timeout), so it may or may not have arrived. It is not sent again. The sequence stopped for this partner.');
    // The list says the same in its one line, and nowhere is an email marked as written by AI.
    const list = read(await PartnersPage({ searchParams: Promise.resolve({}) }));
    expect(list).toContain('Stopped: one email was not confirmed as sent. Contact them yourself');
    for (const text of [guard, quiet, list]) expect(text).not.toContain('Reworded by AI');
  });

  it('a partner page shows the email as it was sent, the next one, the timeline and the honest buttons', async () => {
    const a = await agency('PagesDetail', ON);
    const [emailed, optedOut, refused] = await add(a, [P('Emailed Realty'), P('Gone Realty'), P('Refused Realty')]) as [string, string, string];
    expect((await runPartnerOutreach(a.orgId, { live: true, send: sendWith(), now: MON, partnerId: emailed })).sent).toBe(1);
    expect((await runPartnerOutreach(a.orgId, { live: true, send: sendWith({ ok: false, error: 'domain not verified' }), now: MON, partnerId: refused })).failed).toBe(1);
    await optOutPartner(partnerOptOutToken(optedOut));
    const client = await addClient(a.orgId, 'Referred Person');
    await asUser(a.ownerId, (db) => setReferredBy(db, { orgId: a.orgId, userId: a.ownerId }, client, emailed));

    signIn(a);
    const page = read(await PartnerPage({ params: Promise.resolve({ id: emailed }) }));
    expect(page).toContain('Emailed Realty');
    expect(page).toContain('In sequence');
    expect(page).toContain('Introduction Sent Mar 2, 2026');
    expect(page).toContain(`Subject: Introducing ${a.name}: credit report help for your buyers`);
    expect(page).toContain('I am contacting you because you work as a real estate agent in Austin, TX.');
    expect(page).toContain(`${a.name} · ${ADDRESS}`);
    // The partner's own opt-out link is never shown to staff: opening it would opt the partner out for good.
    expect(page).not.toContain(partnerOptOutToken(emailed));
    expect(page).toContain('/unsubscribe/partner/(this partner’s own link)');
    // The follow-up is previewed exactly as the standard wording would send it.
    expect(page).toContain('Preview the standard wording');
    expect(page).toContain(`Subject: Following up: ${a.name} and your buyers`);
    expect(page).toContain('Replies and bounce notices arrive outside this system, so they are recorded here by you.');
    expect(page).toContain(`A partner’s answer goes to your reply address (${REPLY}). This system cannot read that mailbox.`);
    for (const button of ['They replied', 'Interested', 'Not interested', 'Bounced', 'Pause the sequence', 'Asked to stop']) expect(page).toContain(button);
    expect(page).not.toContain('Remove'); // something was sent, so the record stays
    expect(page).toContain('It never texts or calls them');
    expect(page).toContain('(512) 555-0134 (for your reference only)');
    expect(page).toContain('Introduction email sent automatically');
    expect(page).toContain('Added by hand.');
    expect(page).toContain('Referred Person');
    expect(page).toContain('1 linked to this partner.');
    expect(page).toContain('confirmed on');

    const gone = read(await PartnerPage({ params: Promise.resolve({ id: optedOut }) }));
    expect(gone).toMatch(/This partner opted out of the emails on [A-Z][a-z]{2} \d{1,2}, \d{4}\. The address is never emailed again, and this cannot be changed\./);
    expect(gone).toContain('Opted out: never emailed again');
    // They can still write or call: that they replied or are interested can be recorded, and nothing else can be done to the record.
    expect(gone).toContain('They can still write or call you. If they do, record it here: it sends nothing and does not lift the email stop.');
    for (const button of ['They replied', 'Interested', 'Not interested']) expect(gone).toContain(button);
    for (const button of ['Bounced', 'Pause the sequence', 'Asked to stop', 'Try again', 'Edit details', 'Remove']) expect(gone).not.toContain(button);
    expect(gone).toContain('Opted out from an email (the link, or the mail program’s unsubscribe button). No further email is sent to this address.');

    const failed = read(await PartnerPage({ params: Promise.resolve({ id: refused }) }));
    expect(failed).toContain('The email service did not accept it: domain not verified.');
    expect(failed).toContain('Try again');
    expect(failed).toContain('Stopped: an email was not sent.');
    await expect(PartnerPage({ params: Promise.resolve({ id: 'not-a-uuid' }) })).rejects.toThrow();
  });

  it('“Referred by” on a client appears only when the agency has partners, and shows the one linked', async () => {
    const a = await agency('PagesReferred');
    const client = await addClient(a.orgId, 'Some Client');
    const ctx = signIn(a);
    expect(await ReferredByBlock({ ctx, clientId: client })).toBeNull();
    const [one, two] = await add(a, [P('Alpha Realty'), P('Beta Motors')]) as [string, string];
    const before = markup(await ReferredByBlock({ ctx, clientId: client }));
    expect(before).toContain('No partner recorded.');
    expect(before).toContain(`<option value="${one}">Alpha Realty</option>`);
    expect(before).toContain(`<option value="${two}">Beta Motors</option>`);
    await asUser(a.ownerId, (db) => setReferredBy(db, { orgId: a.orgId, userId: a.ownerId }, client, two));
    const after = markup(await ReferredByBlock({ ctx, clientId: client }));
    expect(after).toContain(`href="/app/partners/${two}"`);
    expect(after).toMatch(new RegExp(`<option value="${two}" selected="">Beta Motors</option>`));
    // Nothing for a personal workspace.
    expect(await ReferredByBlock({ ctx: signIn(a, 'owner', a.ownerId, 'personal'), clientId: client })).toBeNull();
  });

  it('the partner opt-out page asks first, in the partner’s language; only the button opts out; and a link that does not verify is explained', async () => {
    const a = await agency('PagesOptOut', ON);
    const [en, es] = await add(a, [P('English Realty'), P('Casa Linda', { language: 'es' })]) as [string, string];
    const status = () => withSystem((db) => db.rows<{ status: string }>('select status from public.partners where id = any($1::uuid[]) order by business_name desc', [[en, es]])).then((r) => r.map((x) => x.status));
    const pageFor = async (id: string) => read(await PartnerUnsubscribePage({ params: Promise.resolve({ token: partnerOptOutToken(id) }) }));

    // Opening the link, as a person or as a mail gateway that fetches every link: a question and one button. Nothing changes.
    const asked = await pageFor(en);
    expect(asked).toContain(`Stop emails from ${a.name}?`);
    expect(asked).toContain('Yes, stop these emails');
    expect(asked).toContain('To change nothing, just close this page.');
    expect(asked).not.toContain('Done: no more emails');
    const html = markup(await PartnerUnsubscribePage({ params: Promise.resolve({ token: partnerOptOutToken(en) }) }));
    expect(html).toContain(`<input type="hidden" name="token" value="${partnerOptOutToken(en)}"/>`);
    expect(html.match(/<button[^>]*type="submit"/g)).toHaveLength(1);
    const preguntado = await pageFor(es);
    expect(preguntado).toContain(`¿Dejar de recibir correos de ${a.name}?`);
    expect(preguntado).toContain('Sí, dejar de recibir estos correos');
    for (let i = 0; i < 3; i++) await pageFor(en);
    expect(await status()).toEqual(['new', 'new']);

    // Pressing the button is the opt-out. The page then confirms, and opening it again still does.
    const form = new FormData();
    form.set('token', partnerOptOutToken(en));
    await expect(stopPartnerEmailsAction(form)).rejects.toThrow(`REDIRECT /unsubscribe/partner/${partnerOptOutToken(en)}`);
    const done = await pageFor(en);
    expect(done).toContain('Done: no more emails');
    expect(done).toContain(`${a.name} will not email this address again.`);
    expect(done).not.toContain('Yes, stop these emails');
    expect(await status()).toEqual(['opted_out', 'new']); // only the one who pressed it
    // A token that does not verify changes nothing, whichever way it arrives.
    const bad = new FormData();
    bad.set('token', `${partnerOptOutToken(es).slice(0, -2)}xx`);
    await expect(stopPartnerEmailsAction(bad)).rejects.toThrow(/REDIRECT/);
    expect(await status()).toEqual(['opted_out', 'new']);
    expect(read(await PartnerUnsubscribePage({ params: Promise.resolve({ token: 'nonsense' }) }))).toContain('This link is not valid or has expired');
    form.set('token', partnerOptOutToken(es));
    await expect(stopPartnerEmailsAction(form)).rejects.toThrow(/REDIRECT/);
    expect(await pageFor(es)).toContain(`${a.name} no volverá a escribir a esta dirección.`);
    expect(await status()).toEqual(['opted_out', 'opted_out']);
  });
});

describe('Leads page with text follow-up', () => {
  it('shows the text switch, and a line about texts only for a lead who agreed to them on the form', async () => {
    const a = await agency('PagesLeads', { lead_followup_enabled: true, lead_followup_since: new Date(Date.now() - 60_000).toISOString(), lead_mailing_address: ADDRESS, lead_reply_email: REPLY, lead_text_followup: true });
    const number = `+1512${2 + Math.floor(Math.random() * 7)}55${String(Math.floor(Math.random() * 10_000)).padStart(4, '0')}`;
    const enquire = (name: string, over: Record<string, unknown>) => submitLead(a.slug, { fullName: name, email: `lead-${uniq()}@example.test`, language: 'en', consent: true, ...over }, { ip: testIp(), defer: () => undefined });
    expect(await enquire('Texted Lead', { phone: number, smsConsent: true })).toEqual({ ok: true });
    expect(await enquire('Email Lead', {})).toEqual({ ok: true });

    signIn(a);
    const before = read(await LeadsPage({ searchParams: Promise.resolve({}) }));
    expect(before).toContain('A text is only ever sent to someone who separately agreed to texts on the form.');
    expect(before).toContain('Also text people who separately agree to text messages on the form');
    expect(before).toContain('Text follow-up: on · 0 sent. Texts go to US mobile numbers only, between 9 a.m. and 8 p.m. where the person is.');
    expect(before).toContain('Texts need their own consent.');
    expect(before.match(/Texts: 0 of 2 sent/g)).toHaveLength(1); // only the lead who ticked the box
    expect(before).toContain('Texted Lead');
    expect(before).toContain('Email Lead');

    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    expect((await runLeadTexts(a.orgId, { now: new Date(`${tomorrow}T20:00:00Z`) })).sent).toBe(1);
    const after = read(await LeadsPage({ searchParams: Promise.resolve({}) }));
    expect(after).toContain('Text follow-up: on · 1 sent.');
    expect(after.match(/Texts: 1 of 2 sent/g)).toHaveLength(1);
    // The email counters count emails only: a text sent is not an email sent.
    expect(after).toContain('0 sent · 0 failed · 0 opted out');

    // "Asked to stop": no automatic message of any kind follows, and the text consent they gave on the form is withdrawn
    // with it, so it cannot carry over if they become a client.
    const lead = (await withSystem((db) => db.row<{ id: string }>("select id from public.clients where org_id = $1 and full_name = 'Texted Lead'", [a.orgId])))!.id;
    const fd = new FormData();
    fd.set('id', lead);
    await leadAskedToStopAction(fd);
    expect(await withSystem((db) => db.row('select (outreach_opt_out_at is not null) as stopped from public.clients where id = $1', [lead]))).toEqual({ stopped: true });
    expect(await withSystem((db) => db.rows('select source, revoked_via, (revoked_at is not null) as revoked from public.sms_consents where client_id = $1', [lead]))).toEqual([{ source: 'enquiry_form', revoked_via: 'asked_to_stop', revoked: true }]);
    expect((await withSystem((db) => db.rows<{ summary: string }>("select summary from public.client_events where client_id = $1 and kind = 'lead_opt_out'", [lead]))).map((e) => e.summary))
      .toEqual(['Asked not to be contacted automatically (recorded by the team). No automatic follow-up email or text follows; their agreement to text messages was withdrawn.']);
    await withSystem((db) => db.run("update public.lead_outreach set created_at = created_at - interval '4 days', sent_at = sent_at - interval '4 days' where client_id = $1", [lead]));
    expect((await runLeadTexts(a.orgId, { now: new Date(`${tomorrow}T20:00:00Z`) })).sent).toBe(0);
    // Pressed again, it records nothing twice.
    await leadAskedToStopAction(fd);
    expect(await withSystem((db) => db.row<{ n: number }>("select count(*)::int as n from public.client_events where client_id = $1 and kind = 'lead_opt_out'", [lead]))).toEqual({ n: 1 });
  });

  it('a workspace that is not approved shows no text box on its form, and the Leads page says why', async () => {
    const a = await agency('PagesLeadsFresh', { lead_followup_enabled: true, lead_followup_since: new Date(Date.now() - 60_000).toISOString(), lead_mailing_address: ADDRESS, lead_reply_email: REPLY, lead_text_followup: true }, false);
    signIn(a);
    const page = read(await LeadsPage({ searchParams: Promise.resolve({}) }));
    expect(page).toContain('Text follow-up: on, but not running. This workspace has not been approved for automatic outreach yet.');
    expect(page).toContain('The text box is not shown on your form.');
    expect(await leadTextsOfferedBySlug(a.slug)).toBe(false);
  });
});

// ================================================================ the buttons and forms behind those pages
describe('partner actions, as the forms call them', () => {
  const form = (o: Record<string, string | File>) => { const fd = new FormData(); for (const [k, v] of Object.entries(o)) fd.set(k, v); return fd; };
  const row = (id: string) => withSystem((db) => db.row<{ business_name: string; status: string; paused: boolean; email: string; city: string | null; attested_by: string | null }>(
    'select business_name, status, (paused_at is not null) as paused, email, city, attested_by from public.partners where id = $1', [id]));
  const settings = (a: Agency) => withSystem((db) => db.row<{ settings: Record<string, unknown> }>('select settings from public.organizations where id = $1', [a.orgId])).then((r) => r!.settings);
  const VALID = { businessName: 'Hill Realty', contactName: 'Dana Hill', category: 'real_estate_agent', city: 'Austin', state: 'tx', language: 'en', phone: '512-555-0134', sourceNote: 'Their office website' };

  it('adding one partner needs the confirmation, a category and a valid business email, and an address is listed once', async () => {
    const a = await agency('ActionsAdd');
    signIn(a);
    const email = `dana-${uniq()}@hill.example.test`;
    expect(await addPartnerAction(undefined, form({ ...VALID, email }))).toEqual({ error: expect.stringMatching(/^Tick the box to confirm where these contacts came from/) });
    expect(await addPartnerAction(undefined, form({ ...VALID, email: 'not-an-email', attest: 'on' }))).toEqual({ error: 'Enter a valid email address' });
    expect(await addPartnerAction(undefined, form({ ...VALID, email, category: '', attest: 'on' }))).toEqual({ error: 'Choose a category' });
    expect(await addPartnerAction(undefined, form({ ...VALID, email, attest: 'on' }))).toEqual({ ok: 'Hill Realty was added. Nothing is sent until the email sequence is switched on.' });
    expect(await addPartnerAction(undefined, form({ ...VALID, email: email.toUpperCase(), attest: 'on' }))).toEqual({ error: expect.stringMatching(/already on your partner list/) });
    // Another spelling of the same mailbox is the same partner, and the message says why it was not added.
    expect(await addPartnerAction(undefined, form({ ...VALID, email: email.replace('@', '+second@'), attest: 'on' })))
      .toEqual({ error: 'That email address is already on your partner list, perhaps in another spelling: a “+tag”, and for Gmail the dots, do not make a different mailbox. A mailbox is only ever listed once, and one that opted out stays opted out.' });
    // A city whose name would read as a claim in the email is refused here, with what to do about it.
    expect(await addPartnerAction(undefined, form({ ...VALID, email: `soil-${uniq()}@hill.example.test`, city: 'Free Soil', state: 'MI', attest: 'on' })))
      .toEqual({ error: 'This city cannot be printed in the emails: “Free” would read as a claim they may not make. Leave the city empty for this partner.' });
    const rows = await withSystem((db) => db.rows<{ email: string; state: string; status: string; attested_by: string }>('select email, state, status, attested_by from public.partners where org_id = $1', [a.orgId]));
    expect(rows).toEqual([{ email, state: 'TX', status: 'new', attested_by: a.ownerId }]);
    // The sentence the person ticked is kept on the audit entry, so a later change of wording leaves a record of this one.
    expect(await withSystem((db) => db.rows<{ metadata: Record<string, unknown> }>("select metadata from public.audit_logs where org_id = $1 and action = 'partner.added'", [a.orgId]))).toEqual([{ metadata: { attestation: PARTNER_ATTESTATION } }]);
  });

  it('importing a list: pasted or as a file, with the rows left out named, and never without the confirmation', async () => {
    const a = await agency('ActionsImport');
    signIn(a);
    const u = uniq();
    const list = `business name,email,category\nA Realty,a@a-${u}.example,realtor\nB Motors,b@b-${u}.example,car dealer\nBad Co,nope,realtor\nA again,A@a-${u}.example,realtor`;
    expect(await importPartnersAction(undefined, form({ list }))).toEqual({ error: expect.stringMatching(/^Tick the box/) });
    expect(await importPartnersAction(undefined, form({ list: '', attest: 'on' }))).toEqual({ error: 'Paste your list, or choose a .csv file.' });
    expect(await importPartnersAction(undefined, form({ list, attest: 'on' }))).toEqual({ ok: '2 added. 1 skipped: already on your list or repeated in this one. Left out: line 4 (email: Enter a valid email address). Nothing is sent until the email sequence is switched on.' });
    // The same list as a file adds nothing new; a file with rows that carry no category uses the one chosen on the form.
    expect(await importPartnersAction(undefined, form({ file: new File([list], 'partners.csv', { type: 'text/csv' }), attest: 'on' }))).toEqual({ ok: expect.stringMatching(/^0 added\. 3 skipped/) });
    const bare = `company\temail\nC Tax\tc@c-${u}.example`;
    expect(await importPartnersAction(undefined, form({ file: new File([bare], 'more.tsv'), attest: 'on' }))).toEqual({ error: 'No row could be added. Left out: line 2 (no category).' });
    expect(await importPartnersAction(undefined, form({ file: new File([bare], 'more.tsv'), defaultCategory: 'tax_preparer', attest: 'on' }))).toEqual({ ok: expect.stringMatching(/^1 added\./) });
    expect(await importPartnersAction(undefined, form({ list: 'no header here', attest: 'on' }))).toEqual({ error: expect.stringMatching(/header line/) });
    expect(await withSystem((db) => db.rows<{ email: string; category: string }>('select email, category from public.partners where org_id = $1 order by email', [a.orgId]))).toEqual([
      { email: `a@a-${u}.example`, category: 'real_estate_agent' }, { email: `b@b-${u}.example`, category: 'car_dealership' }, { email: `c@c-${u}.example`, category: 'tax_preparer' },
    ]);
    // Other spellings of mailboxes already listed are skipped and counted, like a repeated address.
    expect(await importPartnersAction(undefined, form({ list: `business name,email,category\nA tagged,a+1@a-${u}.example,realtor\nB tagged,b+sales@b-${u}.example,car dealer\nD Tax,d@d-${u}.example,tax preparer`, attest: 'on' })))
      .toEqual({ ok: '1 added. 2 skipped: already on your list or repeated in this one. Nothing is sent until the email sequence is switched on.' });
    // Every import that added anything keeps the sentence that was ticked.
    const imports = await withSystem((db) => db.rows<{ metadata: Record<string, unknown> }>("select metadata from public.audit_logs where org_id = $1 and action = 'partners.imported' order by id", [a.orgId]));
    expect(imports.length).toBeGreaterThanOrEqual(3);
    for (const i of imports) expect(i.metadata.attestation).toBe(PARTNER_ATTESTATION);
    expect(imports.at(-1)!.metadata).toEqual({ added: 1, already_listed: 2, repeated: 0, left_out: 0, attestation: PARTNER_ATTESTATION });
  });

  it('the buttons on a partner record what happened; the email address never changes; only an untouched partner can be removed', async () => {
    const a = await agency('ActionsButtons', ON);
    const [id, other, gone] = await add(a, [P('Button Realty'), P('Other Realty'), P('Typo Realty')]) as [string, string, string];
    signIn(a);
    await pausePartnerAction(form({ id, paused: '1' }));
    expect(await row(id)).toMatchObject({ status: 'new', paused: true });
    await pausePartnerAction(form({ id, paused: '0' }));
    expect(await row(id)).toMatchObject({ paused: false });
    expect((await runPartnerOutreach(a.orgId, { live: true, send: sendWith({ ok: false, error: 'domain not verified' }), now: MON, partnerId: id })).failed).toBe(1);
    await retryPartnerAction(form({ id }));
    expect((await runPartnerOutreach(a.orgId, { live: true, send: sendWith(), now: MON, partnerId: id })).sent).toBe(1);
    for (const mark of ['replied', 'interested', 'not_interested', 'bounced']) {
      await markPartnerAction(form({ id, mark }));
      expect(await row(id)).toMatchObject({ status: mark });
    }
    await expect(markPartnerAction(form({ id, mark: 'opted_out' }))).rejects.toThrow(); // not something a button can set
    const before = (await row(id))!;
    expect(await updatePartnerAction(undefined, form({ ...VALID, id, businessName: 'Renamed Realty', city: 'Dallas', email: 'changed@elsewhere.example' }))).toEqual({ ok: 'Saved.' });
    expect(await row(id)).toMatchObject({ business_name: 'Renamed Realty', city: 'Dallas', email: before.email });
    await partnerAskedToStopAction(form({ id }));
    expect(await row(id)).toMatchObject({ status: 'opted_out' });
    // They asked not to be emailed and then rang up, interested: that can be recorded, and the opt-out stays whatever is pressed.
    await markPartnerAction(form({ id, mark: 'interested' }));
    expect(await row(id)).toMatchObject({ status: 'interested' });
    expect(await withSystem((db) => db.row('select (opted_out_at is not null) as opted_out from public.partners where id = $1', [id]))).toEqual({ opted_out: true });
    await markPartnerAction(form({ id, mark: 'bounced' }));
    expect(await row(id)).toMatchObject({ status: 'interested' }); // "bounced" is about an address that is being written to
    expect((await runPartnerOutreach(a.orgId, { live: true, send: sendWith(), now: new Date(MON.getTime() + 30 * 86_400_000), partnerId: id })).sent).toBe(0);
    const page = read(await PartnerPage({ params: Promise.resolve({ id }) }));
    expect(page).toContain('Interested Opted out of email'); // both are shown: what they said, and that the address is never emailed
    expect(page).toContain('The address is never emailed again, and this cannot be changed.');
    expect(page).toContain('Marked as interested. This address opted out of the emails and is still never emailed.');
    // Remove: refused for a partner with history, done (and back to the list) for one nothing was sent to.
    await removePartnerAction(form({ id }));
    expect(await row(id)).not.toBeNull();
    await expect(removePartnerAction(form({ id: gone }))).rejects.toThrow('REDIRECT /app/partners');
    expect(await row(gone)).toBeNull();
    // Referred by, from the client page.
    const client = await addClient(a.orgId, 'Some Client');
    expect(await setReferredByAction(undefined, form({ clientId: client, partnerId: other }))).toEqual({ ok: 'Saved.' });
    expect(await withSystem((db) => db.rows('select partner_id from public.partner_referrals where client_id = $1', [client]))).toEqual([{ partner_id: other }]);
    expect(await setReferredByAction(undefined, form({ clientId: client, partnerId: '' }))).toEqual({ ok: 'Cleared.' });
    expect(await withSystem((db) => db.rows('select partner_id from public.partner_referrals where client_id = $1', [client]))).toEqual([]);
  });

  it('the mailing address has to be shaped like a postal address, on the Partners form and on the Leads form', async () => {
    const HELP = MAILING_ADDRESS_HELP;
    const URGENT = 'URGENT: your escrow account is on hold. Sign in at https://secure-escrow-verify.example/login today or the closing is cancelled.';
    const NOT_ADDRESSES: [string, string][] = [
      ['x', HELP], ['n/a', HELP], ['12 Main St, Austin, TX', HELP], [URGENT, `A mailing address cannot contain a web address. ${HELP}`],
      [`${URGENT} P.S. As we discussed at the expo, most local agents already use us.`, HELP], ['As we discussed at the expo most local agents already use us 78701', HELP],
      ['<b>12 Main St, Austin, TX 78701</b>', HELP], ['12 Main St, Austin, TX 78701! Call now', HELP],
    ];
    for (const [label, save] of [['Partners', savePartnerOutreachAction], ['Leads', saveLeadFollowUpAction]] as const) {
      const a = await agency(`ActionsAddress${label}`);
      signIn(a);
      for (const [address, error] of NOT_ADDRESSES) {
        // Refused with the switch on and with it off: such text is never saved.
        expect(await save(undefined, form({ enabled: 'on', address, replyTo: REPLY })), `${label}: ${address}`).toEqual({ error });
        expect(await save(undefined, form({ address, replyTo: REPLY })), `${label}: ${address}`).toEqual({ error });
      }
      expect(await settings(a)).not.toHaveProperty('lead_mailing_address');
      expect(await settings(a)).not.toHaveProperty('lead_reply_email');
      // A postal address is saved, on one line.
      expect(await save(undefined, form({ enabled: 'on', address: '  500 Bayshore Blvd,  Suite 210,\nTampa, FL 33606 ', replyTo: REPLY }))).toMatchObject({ ok: expect.stringMatching(/^Saved/) });
      expect(await settings(a)).toMatchObject({ lead_mailing_address: '500 Bayshore Blvd, Suite 210, Tampa, FL 33606', lead_reply_email: REPLY });
      // It cannot be replaced by a message afterwards (the operator's approval does not cover this line): the address stays.
      await approveOutreach(a.orgId, new Date('2025-06-02T15:00:00Z'));
      expect(await save(undefined, form({ enabled: 'on', address: URGENT, replyTo: REPLY }))).toEqual({ error: `A mailing address cannot contain a web address. ${HELP}` });
      expect(await settings(a)).toMatchObject({ lead_mailing_address: '500 Bayshore Blvd, Suite 210, Tampa, FL 33606' });
    }
    // Left blank, the Partners form keeps the saved address; the Leads form clears it when follow-up is switched off.
    const b = await agency('ActionsAddressBlank', ON);
    signIn(b);
    expect(await savePartnerOutreachAction(undefined, form({ address: '', replyTo: '' }))).toEqual({ ok: 'Saved. The sequence is off.' });
    expect(await settings(b)).toMatchObject({ lead_mailing_address: ADDRESS });
    expect(await saveLeadFollowUpAction(undefined, form({ address: '', replyTo: '' }))).toEqual({ ok: 'Saved. Automatic follow-up is off.' });
    expect(await settings(b)).toMatchObject({ lead_mailing_address: '' });
  });

  it('only an owner or admin can switch the sequence on, it needs both addresses, and it never touches the lead switch', async () => {
    const a = await agency('ActionsSwitch', { lead_followup_enabled: true, lead_followup_since: '2026-01-05T00:00:00.000Z' });
    signIn(a);
    expect(await savePartnerOutreachAction(undefined, form({ enabled: 'on' }))).toEqual({ error: expect.stringMatching(/enter your mailing address and a reply email address/) });
    expect(await savePartnerOutreachAction(undefined, form({ enabled: 'on', address: ADDRESS, replyTo: 'not an address' }))).toEqual({ error: expect.stringMatching(/Enter a valid reply email address/) });
    expect(await settings(a)).not.toHaveProperty('partner_outreach_enabled');
    // An "AI wording" setting left over from an earlier version is removed when the form is saved, and a forged field cannot set it.
    await withSystem((db) => db.run("update public.organizations set settings = settings || '{\"partner_outreach_ai\": true}'::jsonb where id = $1", [a.orgId]));
    expect(await savePartnerOutreachAction(undefined, form({ enabled: 'on', ai: 'on', address: `  ${ADDRESS}  `, replyTo: REPLY.toUpperCase() }))).toEqual({ ok: 'Saved. The sequence is switched on. Partners are emailed by the scheduled runs, on business days, once nothing above is in the way.' });
    expect(await settings(a)).toMatchObject({ partner_outreach_enabled: true, lead_mailing_address: ADDRESS, lead_reply_email: REPLY, lead_followup_enabled: true, lead_followup_since: '2026-01-05T00:00:00.000Z' });
    expect(await settings(a)).not.toHaveProperty('partner_outreach_ai');
    // Saving the switch does not approve anything: that is the operator's, and the form cannot reach it.
    expect(await savePartnerOutreachAction(undefined, form({ enabled: 'on', address: ADDRESS, replyTo: REPLY, outreach_approved_at: '2020-01-01', approved: 'on' }))).toMatchObject({ ok: expect.stringMatching(/^Saved/) });
    expect(await withSystem((db) => db.row<{ at: Date }>('select outreach_approved_at as at from public.organizations where id = $1', [a.orgId]))).toEqual({ at: '2025-06-02T15:00:00.000Z' });
    // Switching it off with the fields left blank keeps the addresses the lead follow-up also uses.
    expect(await savePartnerOutreachAction(undefined, form({ address: '', replyTo: '' }))).toEqual({ ok: 'Saved. The sequence is off.' });
    expect(await settings(a)).toMatchObject({ partner_outreach_enabled: false, lead_mailing_address: ADDRESS, lead_reply_email: REPLY, lead_followup_enabled: true });
    // The lead follow-up form saves its own text switch, and leaves the partner switch alone.
    expect(await saveLeadFollowUpAction(undefined, form({ enabled: 'on', texts: 'on', address: ADDRESS, replyTo: REPLY }))).toMatchObject({ ok: expect.stringMatching(/^Saved/) });
    expect(await settings(a)).toMatchObject({ lead_followup_enabled: true, lead_text_followup: true, lead_followup_since: '2026-01-05T00:00:00.000Z', partner_outreach_enabled: false });
    expect(await saveLeadFollowUpAction(undefined, form({ enabled: 'on', address: ADDRESS, replyTo: REPLY }))).toMatchObject({ ok: expect.stringMatching(/^Saved/) });
    expect(await settings(a)).toMatchObject({ lead_followup_enabled: true, lead_text_followup: false });

    const specialist = await addMember(a.orgId, 'specialist');
    signIn(a, 'specialist', specialist.id);
    await expect(savePartnerOutreachAction(undefined, form({ enabled: 'on', address: ADDRESS, replyTo: REPLY }))).rejects.toThrow('REDIRECT /app?denied=1');
    expect(await settings(a)).toMatchObject({ partner_outreach_enabled: false });
    // A specialist can still add and mark partners.
    expect(await addPartnerAction(undefined, form({ ...VALID, email: `s-${uniq()}@hill.example.test`, attest: 'on' }))).toMatchObject({ ok: expect.any(String) });
  });
});

