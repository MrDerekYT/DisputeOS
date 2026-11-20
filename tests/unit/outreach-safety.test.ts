import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { inQuietHours, inQuietHoursAnywhere, leadQuietZones, MARKETING_WINDOW, quietZones, STATE_ZONES, UPDATE_WINDOW } from '@/lib/client-updates/templates';
import { leadTextBlocker, outreachSettings } from '@/lib/lead-outreach';
import { decideLeadText, LEAD_SMS_NEEDS_PHONE, LEAD_TEXT_DAILY_CAP, linkInName, type LeadTextState } from '@/lib/lead-texts';
import { APPROVAL_NEEDED, isNewlyApproved, NEW_WORKSPACE_DAILY_EMAILS, NEW_WORKSPACE_DAYS, outreachApproval, outreachApproved } from '@/lib/outreach-approval';
import { partnerBlocker, partnerSettings } from '@/lib/partner-outreach';
import { resendEvent, resendSignature, verifyResendWebhook, WEBHOOK_TOLERANCE_SEC } from '@/lib/resend-webhook';
import { toE164, toUsE164 } from '@/lib/sms';
import { usAreaCodeState } from '@/lib/us-phone';

const read = (file: string) => readFileSync(path.join(process.cwd(), file), 'utf8');

// ================================================================ which numbers a marketing text may go to
describe('lead texts go to US numbers only', () => {
  it('a number is accepted only when its area code belongs to a state, DC or Puerto Rico', () => {
    expect(toUsE164('(212) 555-0142')).toBe('+12125550142');
    expect(toUsE164('1-512-555-0134')).toBe('+15125550134');
    expect(toUsE164('+1 808 555 0100')).toBe('+18085550100');
    expect(toUsE164('787-555-0100')).toBe('+17875550100');
    expect(usAreaCodeState('+12125550142')).toBe('NY');
    expect(usAreaCodeState('+15125550134')).toBe('TX');
    expect(usAreaCodeState('+18085550100')).toBe('HI');
    expect(usAreaCodeState('+19075550100')).toBe('AK');
    expect(usAreaCodeState('+17875550100')).toBe('PR');
    expect(usAreaCodeState('+12025550100')).toBe('DC');
  });

  it('a number in another country is refused, although it is a valid number: this is what stops the form texting the world', () => {
    for (const abroad of ['+237 6 77 12 34 56', '+44 7911 123456', '+8801712345678', '+52 55 1234 5678', '+234 803 123 4567', '+91 98765 43210']) {
      expect(toE164(abroad), abroad).not.toBeNull(); // a real, well-formed number
      expect(toUsE164(abroad), abroad).toBeNull(); // and still not one we text
    }
  });

  it('"+1" is not enough: Canada, the Caribbean, toll-free, premium and pay-per-call numbers are refused', () => {
    for (const no of [
      '+1 876 555 1234', // Jamaica
      '+1 809 555 1234', '+1 829 555 1234', // Dominican Republic
      '+1 242 555 1234', // Bahamas
      '+1 268 555 1234', // Antigua
      '+1 473 555 1234', // Grenada
      '+1 416 555 1234', '+1 604 555 1234', '+1 514 555 1234', // Canada
      '(900) 555-1234', // premium rate
      '(800) 555-1234', '(888) 555-1234', '(833) 555-1234', // toll-free
      '(500) 555-1234', '(700) 555-1234', // personal and carrier services
      '(212) 976-1234', // pay-per-call exchange
      '+1 671 555 1234', '+1 340 555 1234', // Guam and the US Virgin Islands: not texted (see the report)
    ]) {
      expect(toUsE164(no), no).toBeNull();
    }
    for (const bad of ['', null, undefined, '555-0134', '212-555-0142 ext 4', 'call me', '+12125550', '12125550142999']) expect(toUsE164(bad as string | null | undefined)).toBeNull();
  });

  it('every area code in the list is three digits starting 2-9, appears once, and no state is missing', () => {
    const src = read('src/lib/us-phone.ts');
    const table = /US_AREA_CODES_BY_STATE: Record<string, string> = \{([\s\S]*?)\n\};/.exec(src)![1]!;
    const entries = [...table.matchAll(/([A-Z]{2}): '([\d ]+)'/g)].map((m) => [m[1]!, m[2]!.split(' ')] as const);
    expect(entries.map(([st]) => st).sort()).toEqual([...new Set(entries.map(([st]) => st))].sort());
    expect(entries).toHaveLength(52); // 50 states, DC and Puerto Rico
    const codes = entries.flatMap(([, list]) => list);
    expect(new Set(codes).size).toBe(codes.length);
    for (const code of codes) expect(code, code).toMatch(/^[2-9]\d{2}$/);
    // None of the easily-recognised non-US ranges slipped in: N11, toll-free, premium, and the 5XX/7XX service codes.
    for (const code of codes) expect(code, code).not.toMatch(/^(\d11|8(00|33|44|55|66|77|88)|900|[57]00|5(21|22|23|24|25|26|27|28|29|33|44|66|77|88))$/);
    // Every state we can place has its time zones on file, so quiet hours can be judged where the number is from.
    for (const [st] of entries) expect(STATE_ZONES[st], st).toBeTruthy();
    // The file says plainly that the list was not checked against the published assignments.
    expect(src).toMatch(/was not checked against NANPA/);
  });

  const T0 = new Date('2026-03-02T20:00:00Z');
  const lead = (over: Partial<LeadTextState> = {}): LeadTextState => ({
    status: 'lead', consented: true, optedOut: false, replied: false, contacted: false, consentPhone: '+15125550134', phone: '+15125550134', receivedAt: T0,
    eligibleFrom: new Date(T0.getTime() - 86_400_000), texts: [], ...over,
  });

  it('a consent recorded for a number that is not a US one never produces a text', () => {
    expect(decideLeadText(lead(), T0)).toEqual({ kind: 'send', step: 'text_welcome' });
    for (const phone of ['+237677123456', '+447911123456', '+18765551234', '+14165551234', '+19005551234']) {
      expect(decideLeadText(lead({ consentPhone: phone, phone }), T0), phone).toEqual({ kind: 'stop', reason: 'not_us_number' });
    }
  });

  it('the form says a US mobile number is needed, with an example, in both languages', () => {
    expect(LEAD_SMS_NEEDS_PHONE.en).toMatch(/enter a US mobile number with its area code, such as \(212\) 555-0142/);
    expect(LEAD_SMS_NEEDS_PHONE.es).toMatch(/número de celular de EE\. UU\./);
    // Both public forms check the number with the US rule before a lead is created, and so does the record of the consent.
    for (const file of ['src/lib/leads.ts', 'src/lib/lead-outreach.ts']) expect(read(file), file).toMatch(/toUsE164\(/);
  });

  it('one workspace sends a bounded number of lead texts a day', () => {
    expect(LEAD_TEXT_DAILY_CAP).toBeGreaterThan(0);
    expect(LEAD_TEXT_DAILY_CAP).toBeLessThanOrEqual(50);
  });
});

// ================================================================ when a marketing text may go
describe('lead texts are held to the hours of the person, not of the office', () => {
  const at = (iso: string) => new Date(iso);

  it('marketing texts keep to 9:00-20:00, an hour inside the service-update window on both sides', () => {
    expect(MARKETING_WINDOW).toEqual({ from: 9, until: 20 });
    expect(MARKETING_WINDOW.from).toBeGreaterThan(UPDATE_WINDOW.from);
    expect(MARKETING_WINDOW.until).toBeLessThan(UPDATE_WINDOW.until);
    // 8:30 a.m. Eastern: fine for an update to a client, too early for a marketing text.
    const early = at('2026-03-03T13:30:00Z');
    expect(inQuietHours(early, 'America/New_York')).toBe(false);
    expect(inQuietHours(early, 'America/New_York', MARKETING_WINDOW)).toBe(true);
    // 8:15 p.m. Eastern: the same.
    const late = at('2026-03-04T01:15:00Z');
    expect(inQuietHours(late, 'America/New_York')).toBe(false);
    expect(inQuietHours(late, 'America/New_York', MARKETING_WINDOW)).toBe(true);
  });

  it('the zones of the number’s area code are added to the workspace’s and to both coasts', () => {
    expect(leadQuietZones('America/New_York', null, 'HI')).toEqual(['America/New_York', 'America/Los_Angeles', 'Pacific/Honolulu']);
    expect(leadQuietZones('America/Chicago', null, 'AK')).toEqual(['America/Chicago', 'America/New_York', 'America/Los_Angeles', 'America/Anchorage', 'America/Adak']);
    // A state on the record is used as well as the area code, never instead of it.
    expect(leadQuietZones('America/New_York', 'TX', 'HI')).toEqual(['America/New_York', 'America/Chicago', 'America/Denver', 'Pacific/Honolulu']);
    expect(leadQuietZones('America/New_York', null, 'NY')).toEqual(quietZones('America/New_York', null));
  });

  it('the old 17:00 UTC run texted a Hawaii number at 7 a.m. and an Alaska number at 8 a.m.; both are now held', () => {
    const run17 = at('2026-03-03T17:00:00Z'); // 12:00 Eastern, 09:00 Pacific, 08:00 Alaska, 07:00 Hawaii
    expect(inQuietHoursAnywhere(run17, leadQuietZones('America/New_York', null, 'NY'), MARKETING_WINDOW)).toBe(false);
    expect(inQuietHoursAnywhere(run17, leadQuietZones('America/New_York', null, 'HI'), MARKETING_WINDOW)).toBe(true);
    expect(inQuietHoursAnywhere(run17, leadQuietZones('America/New_York', null, 'AK'), MARKETING_WINDOW)).toBe(true);
  });

  it('the scheduled run at 20:00 UTC is inside the window for every state, in winter and in summer', () => {
    const states = Object.keys(STATE_ZONES).filter((st) => !['GU', 'MP', 'AS', 'VI'].includes(st));
    expect(states).toHaveLength(52);
    for (const day of ['2026-01-13', '2026-03-03', '2026-07-14', '2026-11-03']) {
      const run = at(`${day}T20:00:00Z`);
      for (const st of states) {
        for (const orgTz of ['America/New_York', 'America/Los_Angeles', 'Pacific/Honolulu', 'America/Puerto_Rico']) {
          expect(inQuietHoursAnywhere(run, leadQuietZones(orgTz, null, st), MARKETING_WINDOW), `${day} ${st} ${orgTz}`).toBe(false);
        }
      }
      // The morning run (09:00 UTC) never sends a marketing text: it is before 9 a.m. everywhere in the country.
      for (const st of states) expect(inQuietHoursAnywhere(at(`${day}T09:00:00Z`), leadQuietZones('America/New_York', null, st), MARKETING_WINDOW), `${day} ${st}`).toBe(true);
    }
    // And that is the schedule the deployment runs.
    const crons = (JSON.parse(read('vercel.json')) as { crons: { path: string; schedule: string }[] }).crons;
    expect(crons.map((c) => c.schedule).sort()).toEqual(['0 20 * * *', '0 9 * * *']);
  });
});

// ================================================================ the operator's approval
describe('a workspace is approved by the operator before anything unattended goes out', () => {
  const approved = { name: 'Bright Path Credit', outreach_approved_at: '2026-01-05T00:00:00Z', outreach_approved_name: 'Bright Path Credit' };

  it('a new workspace is not approved; an approval is for the business name it was given for', () => {
    expect(outreachApproval(null)).toBe('not_approved');
    expect(outreachApproval({ name: 'Bright Path Credit', outreach_approved_at: null, outreach_approved_name: null })).toBe('not_approved');
    expect(outreachApproval(approved)).toBe('approved');
    expect(outreachApproved(approved)).toBe(true);
    // Renamed after approval: the name is in every subject, From line and text, so it has to be looked at again.
    const renamed = { ...approved, name: 'Chase Bank Fraud Department' };
    expect(outreachApproval(renamed)).toBe('renamed');
    expect(outreachApproved(renamed)).toBe(false);
    expect(APPROVAL_NEEDED.not_approved).toMatch(/nothing is sent until then/);
    expect(APPROVAL_NEEDED.renamed).toMatch(/approve it again/);
  });

  it('partner emails and lead texts are both blocked until then, whatever the workspace switched on', () => {
    const partner = partnerSettings({ partner_outreach_enabled: true, lead_mailing_address: '12 Main St, Austin, TX 78701', lead_reply_email: 'hello@brightpath.example' });
    const fresh = { name: 'Bright Path Credit', outreach_approved_at: null, outreach_approved_name: null };
    expect(partnerBlocker(partner, true, fresh)).toBe('not_approved');
    expect(partnerBlocker(partner, true, { ...approved, name: 'Another Name LLC' })).toBe('not_approved');
    expect(partnerBlocker(partner, true, approved)).toBeNull();
    const texts = outreachSettings({ lead_followup_enabled: true, lead_followup_since: '2026-01-01T00:00:00Z', lead_text_followup: true, lead_mailing_address: '12 Main St', lead_reply_email: 'hello@brightpath.example' });
    expect(leadTextBlocker(texts, true, fresh)).toBe('not_approved');
    expect(leadTextBlocker(texts, true, null)).toBe('not_approved');
    expect(leadTextBlocker(texts, true, approved)).toBeNull();
    // An approved name that carries a web address still sends nothing: each text would be the link.
    const linked = { name: 'Acme chase-verify.example', outreach_approved_at: '2026-01-05T00:00:00Z', outreach_approved_name: 'Acme chase-verify.example' };
    expect(leadTextBlocker(texts, true, linked)).toBe('name_link');
  });

  it('a tenant cannot approve itself: the columns are written only by the operator’s command, through the system connection', () => {
    const migration = read('db/migrations/0028_partner_outreach.sql');
    expect(migration).toMatch(/add column if not exists outreach_approved_at timestamptz/);
    expect(migration).toMatch(/add column if not exists outreach_approved_name text/);
    // The tenant role is granted UPDATE on named columns of organizations only; nothing grants it these two.
    expect(migration).not.toMatch(/grant[^;]*outreach_approved/i);
    const script = read('scripts/approve-outreach.mjs');
    expect(script).toMatch(/outreach_approved_at/);
    expect((JSON.parse(read('package.json')) as { scripts: Record<string, string> }).scripts['outreach:approve']).toBe('node scripts/approve-outreach.mjs');
    // No page or action of the app writes them.
    for (const file of ['src/app/app/partners/actions.ts', 'src/app/app/leads/actions.ts', 'src/app/app/settings/actions.ts', 'src/lib/partner-outreach.ts', 'src/lib/lead-outreach.ts']) {
      expect(read(file), file).not.toMatch(/set[^;`]*outreach_approved_(at|name)\s*=/);
    }
  });

  it('a newly approved workspace sends at a lower daily rate for its first two weeks', () => {
    const now = new Date('2026-03-10T12:00:00Z');
    expect(isNewlyApproved({ ...approved, outreach_approved_at: '2026-03-01T12:00:00Z' }, now)).toBe(true);
    expect(isNewlyApproved({ ...approved, outreach_approved_at: '2026-02-01T12:00:00Z' }, now)).toBe(false);
    expect(isNewlyApproved({ ...approved, outreach_approved_at: null }, now)).toBe(false);
    expect(NEW_WORKSPACE_DAYS).toBe(14);
    expect(NEW_WORKSPACE_DAILY_EMAILS).toBeLessThan(40);
  });
});

// ================================================================ a business name is not a link
describe('a business name that carries a web address', () => {
  it('is caught, and an ordinary name with full stops is not', () => {
    expect(linkInName('Acme chase-verify.example')).toBe('chase-verify.example');
    expect(linkInName('Visit www.fix-it-now.test today')).toBe('www.fix-it-now.test');
    expect(linkInName('Pay at https://pay.example/x')).toBe('https://pay.example/x');
    expect(linkInName('URGENT - your escrow account is on hold, sign in at secure-escrow-verify.example')).toBe('secure-escrow-verify.example');
    for (const fine of ['Bright Path Credit', 'St. Mary Credit Services', 'A.B. Smith & Co.', 'J. P. Rivera Credit Repair LLC', 'Bright Path Credit, Inc.', 'Crédito Ñandú S.A.', 'No. 1 Credit Help']) expect(linkInName(fine), fine).toBeNull();
  });
});

// ================================================================ bounce and complaint reports
describe('Resend webhook: only a signed request is believed', () => {
  const secret = `whsec_${Buffer.from('a-test-signing-secret-of-32-bytes').toString('base64')}`;
  const body = JSON.stringify({ type: 'email.bounced', data: { email_id: 'e3b0c442-98fc-4c14-9afb-f4c8996fb924' } });
  const now = 1_780_000_000_000;
  const ts = String(now / 1000);
  const sig = resendSignature(secret, 'msg_1', ts, body);
  const headers = (over: Partial<{ id: string | null; timestamp: string | null; signature: string | null }> = {}) => ({ id: 'msg_1', timestamp: ts, signature: `v1,${sig}`, ...over });

  it('the signature is HMAC-SHA256 over "id.timestamp.body" with the secret’s bytes, as Svix documents', () => {
    // Worked by hand with node:crypto, independent of the function under test.
    const expected = createHmac('sha256', Buffer.from('a-test-signing-secret-of-32-bytes')).update(`msg_1.${ts}.${body}`).digest('base64');
    expect(sig).toBe(expected);
    expect(verifyResendWebhook(secret, headers(), body, now)).toBe(true);
    // Several signatures may be listed (key rotation): any one that matches is enough.
    expect(verifyResendWebhook(secret, headers({ signature: `v1,AAAA v1,${sig}` }), body, now)).toBe(true);
  });

  it('a changed body, another id, a wrong secret, a missing header or an old timestamp is refused', () => {
    expect(verifyResendWebhook(secret, headers(), body.replace('bounced', 'complained'), now)).toBe(false);
    expect(verifyResendWebhook(secret, headers({ id: 'msg_2' }), body, now)).toBe(false);
    expect(verifyResendWebhook(`whsec_${Buffer.from('another-secret').toString('base64')}`, headers(), body, now)).toBe(false);
    expect(verifyResendWebhook(undefined, headers(), body, now)).toBe(false);
    expect(verifyResendWebhook('', headers(), body, now)).toBe(false);
    for (const missing of [{ id: null }, { timestamp: null }, { signature: null }, { signature: '' }, { signature: sig }, { signature: `v2,${sig}` }, { timestamp: 'yesterday' }]) expect(verifyResendWebhook(secret, headers(missing), body, now)).toBe(false);
    // A captured request cannot be replayed later (or sent with a clock set ahead).
    expect(verifyResendWebhook(secret, headers(), body, now + (WEBHOOK_TOLERANCE_SEC + 1) * 1000)).toBe(false);
    expect(verifyResendWebhook(secret, headers(), body, now - (WEBHOOK_TOLERANCE_SEC + 1) * 1000)).toBe(false);
    expect(verifyResendWebhook(secret, headers(), body, now + (WEBHOOK_TOLERANCE_SEC - 1) * 1000)).toBe(true);
  });

  it('only a bounce or a spam complaint with an email id is acted on', () => {
    expect(resendEvent(body)).toEqual({ kind: 'bounced', emailId: 'e3b0c442-98fc-4c14-9afb-f4c8996fb924' });
    expect(resendEvent(JSON.stringify({ type: 'email.complained', data: { email_id: 'abc' } }))).toEqual({ kind: 'complained', emailId: 'abc' });
    for (const other of ['{"type":"email.delivered","data":{"email_id":"abc"}}', '{"type":"email.opened","data":{"email_id":"abc"}}', '{"type":"email.bounced","data":{}}', '{"type":"email.bounced"}', 'not json', '', 'null', '[]']) expect(resendEvent(other), other).toBeNull();
  });

  it('the endpoint answers 404 until a signing secret is configured and checks the signature before anything else', () => {
    const route = read('src/app/api/webhooks/resend/route.ts');
    expect(route).toMatch(/if \(!secret\) return new NextResponse\('Not found', \{ status: 404 \}\)/);
    expect(route.indexOf('verifyResendWebhook(')).toBeLessThan(route.indexOf('recordPartnerDeliveryEvent('));
    expect(route).toMatch(/status: 403/);
  });
});

// ================================================================ the opt-out link
describe('partner opt-out: a link that is fetched does nothing; a person, or the mail program’s one-click, does', () => {
  it('the page a link opens only reads; the opt-out happens on a POST', () => {
    const page = read('src/app/unsubscribe/partner/[token]/page.tsx');
    // The page shows the state and a button. It never calls the function that opts a partner out.
    expect(page).toMatch(/partnerOptOutInfo\(/);
    expect(page).not.toMatch(/\boptOutPartner\(/);
    expect(page).toMatch(/<form action=\{/);
    const action = read('src/app/unsubscribe/partner/[token]/actions.ts');
    expect(action).toMatch(/'use server'/);
    expect(action).toMatch(/optOutPartner\(/);
    const api = read('src/app/api/unsubscribe/partner/[token]/route.ts');
    expect(api).toMatch(/export async function POST/);
    // A GET to the one-click address changes nothing either: it sends the person to the page.
    const get = /export async function GET[\s\S]*?\n\}/.exec(api)![0];
    expect(get).not.toMatch(/optOutPartner\(/);
    expect(get).toMatch(/redirect|303/);
  });

  it('every partner email carries the one-click headers mail programs act on (RFC 8058)', () => {
    const sender = read('src/lib/partner-outreach.ts');
    expect(sender).toMatch(/'List-Unsubscribe': `<\$\{partnerOneClickUrl\(/);
    expect(sender).toMatch(/'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click'/);
    expect(read('src/lib/mailer.ts')).toMatch(/headers/);
  });
});
