import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { findBlockedClaims } from '@/lib/compliance/claims';
import { smsConsentText } from '@/lib/client-updates/service';
import {
  DAILY_CAP, emailText, inQuietHours, inQuietHoursAnywhere, orgTimezone, quietZones, SMS_MAX_CHARS, STATE_ZONES, US_ZONES, smsText, UPDATE_EVENT_LABEL, UPDATE_EVENTS, updateSettings, type UpdateLang,
} from '@/lib/client-updates/templates';
import { getEnv, resetEnvCache } from '@/lib/env';
import { integrationStatus } from '@/lib/integrations';
import { classifyInbound, isE164, sendSms, smsLog, smsStatus, toE164, twilioSignature, twilioWebhookUrl, verifyTwilioSignature } from '@/lib/sms';

const saved = { ...process.env };
afterEach(() => { process.env = { ...saved }; resetEnvCache(); vi.unstubAllGlobals(); });
const useEnv = (env: Record<string, string>) => { process.env = { ...saved, ...env }; resetEnvCache(); };

const LANGS: UpdateLang[] = ['en', 'es'];
// A long business name and a long portal address: the worst case for length.
const VARS = { orgName: 'Northside Credit Advocates & Family Finance Partners LLC', portalUrl: 'https://portal.northside-credit-advocates.example/portal/login?org=northside-credit-advocates-x7q', firstName: 'Jordan Rivera' };

describe('client update templates', () => {
  it('every event has a text and an email in English and Spanish, and the two languages differ', () => {
    for (const e of UPDATE_EVENTS) {
      expect(UPDATE_EVENT_LABEL[e].label).toMatch(/\S/);
      expect(smsText(e, 'en', VARS)).not.toBe(smsText(e, 'es', VARS));
      expect(emailText(e, 'en', VARS).text).not.toBe(emailText(e, 'es', VARS).text);
      expect(emailText(e, 'en', VARS).subject).not.toBe(emailText(e, 'es', VARS).subject);
    }
  });

  it('a text is short, names the sender, carries the portal link and says how to stop and get help', () => {
    for (const e of UPDATE_EVENTS) for (const l of LANGS) {
      const t = smsText(e, l, VARS);
      expect(t.length, `${e}/${l}`).toBeLessThan(SMS_MAX_CHARS);
      expect(t.startsWith('Northside Credit Advocates')).toBe(true);
      expect(t).toContain(VARS.portalUrl);
      expect(t).toMatch(/\bSTOP\b/);
      expect(t).toMatch(/\bHELP\b/);
      expect(t).not.toMatch(/\{\w+\}/); // no unfilled placeholder
    }
  });

  it('a text carries no detail about the file: no figure, amount, bureau, outcome or account wording', () => {
    for (const e of UPDATE_EVENTS) for (const l of LANGS) {
      const words = smsText(e, l, { orgName: 'Acme', portalUrl: 'URL' });
      expect(words, `${e}/${l}`).not.toMatch(/\d|\$|•/);
      expect(words).not.toMatch(/experian|equifax|transunion|account|cuenta|balance|saldo|deleted|removed|eliminad|verified|verificad|corrected|corregid|dispute|disputa|response|respuesta|collection|cobranza/i);
    }
  });

  it('an email may name the stage but never an account number, an amount or an outcome', () => {
    for (const e of UPDATE_EVENTS) for (const l of LANGS) {
      const m = emailText(e, l, { orgName: 'Acme', portalUrl: 'URL', firstName: 'Jordan Rivera' });
      const all = `${m.subject}\n${m.text}`;
      expect(all, `${e}/${l}`).not.toMatch(/\d{4,}|\$|•/);
      expect(all).not.toMatch(/experian|equifax|transunion|deleted|removed|eliminad|was verified|corrected|corregid/i);
      expect(all).toContain('URL');
      expect(all).not.toMatch(/\{\w+\}/);
      expect(m.text).toMatch(l === 'es' ? /^Hola Jordan:/ : /^Hello Jordan,/);
    }
  });

  it('passes the claims guard in both languages, and states the investigation period as "generally"', () => {
    for (const e of UPDATE_EVENTS) for (const l of LANGS) {
      const m = emailText(e, l, VARS);
      expect(findBlockedClaims(smsText(e, l, VARS)), `sms ${e}/${l}`).toEqual([]);
      expect(findBlockedClaims(`${m.subject}\n${m.text}`), `email ${e}/${l}`).toEqual([]);
    }
    expect(emailText('dispute_sent', 'en', VARS).text).toMatch(/generally has about 30 days/);
    expect(emailText('dispute_sent', 'es', VARS).text).toMatch(/generalmente tiene unos 30 días/);
  });

  it('the consent wording says what the TCPA disclosures need, names the business and the number, in both languages', () => {
    const en = smsConsentText('en', 'Acme Credit', '+14155550134');
    expect(en).toMatch(/Acme Credit/);
    expect(en).toMatch(/\+14155550134/);
    for (const re of [/Message frequency varies/, /Message and data rates may apply/, /Reply STOP to stop/, /HELP for help/, /not a condition of service/]) expect(en).toMatch(re);
    const es = smsConsentText('es', 'Acme Credit', '+14155550134');
    for (const re of [/frecuencia de los mensajes varía/, /tarifas de mensajes y datos/, /STOP/, /HELP/, /no es una condición/]) expect(es).toMatch(re);
    expect(findBlockedClaims(`${en}\n${es}`)).toEqual([]);
  });

  it('every switch is off unless the stored settings say exactly true', () => {
    const off = updateSettings(null);
    for (const e of UPDATE_EVENTS) expect(off.switches[e]).toEqual({ sms: false, email: false });
    const s = updateSettings({ client_updates: { switches: { dispute_sent: { sms: true, email: 'yes' }, nonsense: { sms: true } }, window_since: 'not a date' } });
    expect(s.switches.dispute_sent).toEqual({ sms: true, email: false });
    expect(s.windowSince).toBeNull();
    expect(DAILY_CAP.sms).toBeLessThanOrEqual(3);
  });
});

describe('quiet hours (9 p.m. to 8 a.m. in the agency timezone)', () => {
  const NY = 'America/New_York';
  it('holds texts from 21:00 until 08:00 local time', () => {
    // 14 January: New York is UTC-5.
    expect(inQuietHours(new Date('2026-01-15T01:59:00Z'), NY)).toBe(false); // 20:59
    expect(inQuietHours(new Date('2026-01-15T02:00:00Z'), NY)).toBe(true); // 21:00
    expect(inQuietHours(new Date('2026-01-15T05:00:00Z'), NY)).toBe(true); // midnight
    expect(inQuietHours(new Date('2026-01-15T12:59:00Z'), NY)).toBe(true); // 07:59
    expect(inQuietHours(new Date('2026-01-15T13:00:00Z'), NY)).toBe(false); // 08:00
    expect(inQuietHours(new Date('2026-01-15T17:00:00Z'), NY)).toBe(false); // noon
  });
  it('follows daylight saving time and the configured zone, not UTC', () => {
    // 15 July: New York is UTC-4, Los Angeles UTC-7.
    expect(inQuietHours(new Date('2026-07-15T12:00:00Z'), NY)).toBe(false); // 08:00 EDT
    expect(inQuietHours(new Date('2026-07-15T11:59:00Z'), NY)).toBe(true); // 07:59 EDT
    expect(inQuietHours(new Date('2026-07-15T12:00:00Z'), 'America/Los_Angeles')).toBe(true); // 05:00 PDT
    expect(inQuietHours(new Date('2026-07-16T03:30:00Z'), 'America/Los_Angeles')).toBe(false); // 20:30 PDT
    expect(inQuietHours(new Date('2026-07-16T03:30:00Z'), NY)).toBe(true); // 23:30 EDT
  });
  it('judges a text where the client is: the workspace zone and every zone of the client’s state, narrowest window', () => {
    const LA = 'America/Los_Angeles';
    expect(quietZones(NY, 'CA')).toEqual([NY, LA]);
    expect(quietZones(NY, ' ny ')).toEqual([NY]);
    expect(quietZones(LA, 'TX')).toEqual([LA, 'America/Chicago', 'America/Denver']); // a state in two zones counts in both
    expect(quietZones(NY, null)).toEqual([NY, LA]); // no state on the address: Eastern and Pacific
    expect(quietZones('America/Chicago', 'California')).toEqual(['America/Chicago', NY, LA]); // not a postal abbreviation: treated as unknown
    // 15 July. 8:30 a.m. Eastern is 5:30 a.m. Pacific: a New York workspace does not text a California client yet.
    const early = new Date('2026-07-15T12:30:00Z');
    expect(inQuietHoursAnywhere(early, quietZones(NY, 'NY'))).toBe(false);
    expect(inQuietHoursAnywhere(early, quietZones(NY, 'CA'))).toBe(true);
    expect(inQuietHoursAnywhere(new Date('2026-07-15T15:00:00Z'), quietZones(NY, 'CA'))).toBe(false); // 8:00 Pacific
    // 8:30 p.m. Pacific is 11:30 p.m. Eastern: a Los Angeles workspace does not text a New York client that late.
    const late = new Date('2026-07-16T03:30:00Z');
    expect(inQuietHoursAnywhere(late, quietZones(LA, 'CA'))).toBe(false);
    expect(inQuietHoursAnywhere(late, quietZones(LA, 'NY'))).toBe(true);
    // Every state and territory maps to real zones the runtime knows.
    expect(Object.keys(STATE_ZONES)).toHaveLength(56);
    for (const z of new Set(Object.values(STATE_ZONES).flat())) expect(() => new Intl.DateTimeFormat('en-US', { timeZone: z }), z).not.toThrow();
  });
  it('uses the workspace’s own zone when it has chosen one of the offered zones, otherwise the deployment default', () => {
    expect(orgTimezone({ timezone: 'America/Los_Angeles' }, NY)).toBe('America/Los_Angeles');
    for (const bad of [{}, null, { timezone: 'Mars/Olympus' }, { timezone: 7 }]) expect(orgTimezone(bad as Record<string, unknown> | null, NY)).toBe(NY);
    for (const z of US_ZONES) expect(() => new Intl.DateTimeFormat('en-US', { timeZone: z.value })).not.toThrow();
  });
});

describe('phone numbers (E.164)', () => {
  it('reads US numbers as typed and refuses what it cannot be sure of', () => {
    expect(toE164('(415) 555-0134')).toBe('+14155550134');
    expect(toE164('415.555.0134')).toBe('+14155550134');
    expect(toE164('1 415 555 0134')).toBe('+14155550134');
    expect(toE164('+1 (415) 555-0134')).toBe('+14155550134');
    expect(toE164('+44 20 7946 0958')).toBe('+442079460958');
    for (const bad of ['', null, undefined, '555-0134', '415 555 0134 ext 9', '015 555 0134', '415 155 0134', '+0 415 555 0134', '44 20 7946 0958', '+1234567', '+1234567890123456'])
      expect(toE164(bad as string | null), String(bad)).toBeNull();
  });
  it('isE164 accepts only the international form', () => {
    expect(isE164('+14155550134')).toBe(true);
    for (const bad of ['14155550134', '+1 415 555 0134', '+014155550134', '+1415555013x', 42]) expect(isE164(bad)).toBe(false);
  });
});

describe('Twilio request signature', () => {
  // The worked example in Twilio's documentation ("Explore the algorithm yourself", https://www.twilio.com/docs/usage/security):
  // this URL, these POST fields and the Auth Token 12345 give the signature below.
  const URL_ = 'https://example.com/myapp.php?foo=1&bar=2';
  const PARAMS = { Digits: '1234', To: '+18005551212', From: '+14158675310', Caller: '+14158675310', CallSid: 'CA1234567890ABCDE' };
  const DOCUMENTED = 'L/OH5YylLD5NRKLltdqwSvS0BnU=';

  it('reproduces the signature in Twilio’s documentation', () => {
    expect(twilioSignature('12345', URL_, PARAMS)).toBe(DOCUMENTED);
    expect(verifyTwilioSignature('12345', URL_, PARAMS, DOCUMENTED)).toBe(true);
  });
  it('rejects a changed field, an added field, another URL, another token and a missing header', () => {
    expect(verifyTwilioSignature('12345', URL_, { ...PARAMS, From: '+14158675311' }, DOCUMENTED)).toBe(false);
    expect(verifyTwilioSignature('12345', URL_, { ...PARAMS, Body: 'STOP' }, DOCUMENTED)).toBe(false);
    expect(verifyTwilioSignature('12345', 'https://example.com/myapp.php?foo=1', PARAMS, DOCUMENTED)).toBe(false);
    expect(verifyTwilioSignature('54321', URL_, PARAMS, DOCUMENTED)).toBe(false);
    expect(verifyTwilioSignature('12345', URL_, PARAMS, null)).toBe(false);
    expect(verifyTwilioSignature('12345', URL_, PARAMS, '')).toBe(false);
    expect(verifyTwilioSignature(undefined, URL_, PARAMS, DOCUMENTED)).toBe(false);
  });
  it('the webhook address is built from APP_URL', () => {
    useEnv({ APP_ENV: 'test', APP_URL: 'https://app.example.test/' });
    expect(twilioWebhookUrl()).toBe('https://app.example.test/api/webhooks/twilio');
  });
});

describe('reply keywords', () => {
  it('recognises the stop words Twilio acts on, and a reply that begins with STOP', () => {
    for (const w of ['STOP', 'stop', ' Stop. ', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT', 'REVOKE', 'OPTOUT', 'STOP please', 'Unsubscribe me']) expect(classifyInbound(w), w).toBe('stop');
    for (const w of ['START', 'start', 'UNSTOP', 'YES']) expect(classifyInbound(w), w).toBe('start');
    for (const w of ['HELP', 'info']) expect(classifyInbound(w), w).toBe('help');
    for (const w of ['Thanks, got it', 'yes I uploaded it', 'I sent the document yesterday', 'When does it start?', 'I need help with the upload', 'Mi número es alto', '']) expect(classifyInbound(w), w).toBe('message');
  });
  it('treats the words 47 CFR 64.1200(a)(10) names as a stop wherever they appear, and plain refusals too', () => {
    // "stop," "quit," "end," "revoke," "opt out," "cancel," or "unsubscribe" are per se reasonable means of revoking consent.
    for (const w of ['opt out', 'Opt-out', 'OPT OUT please', 'cancel please', 'please stop', 'Please STOP texting me!', 'I want to quit', 'i revoke my consent', 'pls unsubscribe', 'end this', 'no more texts', 'No more messages please', "don't text me", 'Do not contact me again', 'remove me from this list', 'wrong number', 'No más mensajes', 'no me escriban', 'Quiero darme de baja', 'ALTO', 'parar'])
      expect(classifyInbound(w), w).toBe('stop');
    // The rule errs towards stopping: a stop word in an innocent sentence still switches texts off (the client can switch them back on).
    for (const w of ['Please do not stop working on my file', 'cancel my appointment', 'the end', 'see you at the end of the week']) expect(classifyInbound(w), w).toBe('stop');
    // A stop word inside another word is not a stop word.
    for (const w of ['I will send it this weekend', 'unstoppable', 'the friend said yes']) expect(classifyInbound(w), w).toBe('message');
  });
  it('trusts the OptOutType Twilio sends when Advanced Opt-Out is on', () => {
    expect(classifyInbound('ALTO', 'STOP')).toBe('stop');
    expect(classifyInbound('whatever', 'START')).toBe('start');
  });
});

describe('SMS driver', () => {
  const PROD = { APP_ENV: 'production', APP_URL: 'https://app.example.test', DATABASE_URL: 'postgres://x', PII_ENCRYPTION_KEY: randomBytes(32).toString('base64'), EMAIL_DRIVER: 'disabled' };
  const TWILIO = { SMS_DRIVER: 'twilio', TWILIO_ACCOUNT_SID: 'ACtest0000000000000000000000000000', TWILIO_AUTH_TOKEN: 'token-for-tests', TWILIO_MESSAGING_SERVICE_SID: 'MGtest0000000000000000000000000000' };

  it('is disabled by default: nothing is sent and the result says so', async () => {
    useEnv({ APP_ENV: 'test' });
    delete process.env.SMS_DRIVER; resetEnvCache();
    expect(getEnv().SMS_DRIVER).toBe('disabled');
    expect(smsStatus().state).toBe('disabled');
    const before = smsLog.length;
    expect(await sendSms({ to: '+14155550134', body: 'hello' })).toEqual({ ok: false, provider: 'disabled', error: 'Text messaging is not connected' });
    expect(smsLog.length).toBe(before);
  });

  it('the log driver is refused in production and staging, like the email log driver', () => {
    useEnv({ ...PROD, SMS_DRIVER: 'log' });
    expect(() => getEnv()).toThrow(/SMS_DRIVER must be twilio/);
    useEnv({ ...PROD, APP_ENV: 'staging', SMS_DRIVER: 'log' });
    expect(() => getEnv()).toThrow(/SMS_DRIVER must be twilio/);
    useEnv({ ...PROD });
    expect(getEnv().SMS_DRIVER).toBe('disabled');
  });

  it('the log driver records the text in development and refuses a number that is not E.164', async () => {
    useEnv({ APP_ENV: 'test', SMS_DRIVER: 'log' });
    expect(smsStatus().state).toBe('test_only');
    const before = smsLog.length;
    expect(await sendSms({ to: '+14155550134', body: 'hello' })).toEqual({ ok: true, provider: 'log' });
    expect(smsLog.at(-1)).toEqual({ to: '+14155550134', body: 'hello' });
    expect((await sendSms({ to: '(415) 555-0134', body: 'hello' })).ok).toBe(false);
    expect((await sendSms({ to: '+14155550134', body: '   ' })).ok).toBe(false);
    expect(smsLog.length).toBe(before + 1);
  });

  it('twilio without its values is "not connected", names what is missing, and calls nobody', async () => {
    useEnv({ ...PROD, SMS_DRIVER: 'twilio' });
    expect(smsStatus()).toEqual({ state: 'needs_credentials', missing: ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_MESSAGING_SERVICE_SID or TWILIO_FROM_NUMBER'] });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const r = await sendSms({ to: '+14155550134', body: 'hello' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not connected: missing TWILIO_ACCOUNT_SID/);
    expect(fetchMock).not.toHaveBeenCalled();
    const sms = integrationStatus().find((i) => i.key === 'sms')!;
    expect(sms.status).toBe('needs_credentials');
    expect(sms.detail).toMatch(/TWILIO_AUTH_TOKEN/);
    useEnv({ ...PROD, ...TWILIO, TWILIO_MESSAGING_SERVICE_SID: '', TWILIO_FROM_NUMBER: '415-555-0134' });
    expect(smsStatus().missing).toEqual(['TWILIO_FROM_NUMBER in E.164 form (for example +15551234567)']);
  });

  it('twilio posts to the Messages endpoint with Basic auth, the Messaging Service and a status callback', async () => {
    useEnv({ ...PROD, ...TWILIO });
    expect(smsStatus()).toEqual({ state: 'connected', missing: [] });
    expect(integrationStatus().find((i) => i.key === 'sms')).toMatchObject({ status: 'active', verified: false });
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ sid: 'SM123', status: 'accepted', error_code: null }), { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await sendSms({ to: '+14155550134', body: 'There is an update.' })).toEqual({ ok: true, provider: 'twilio', providerRef: 'SM123' });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.twilio.com/2010-04-01/Accounts/ACtest0000000000000000000000000000/Messages.json');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).authorization).toBe(`Basic ${Buffer.from('ACtest0000000000000000000000000000:token-for-tests').toString('base64')}`);
    const form = new URLSearchParams(init.body as string);
    expect(Object.fromEntries(form)).toEqual({ To: '+14155550134', Body: 'There is an update.', StatusCallback: 'https://app.example.test/api/webhooks/twilio', MessagingServiceSid: 'MGtest0000000000000000000000000000' });
  });

  it('uses the sending number when there is no Messaging Service, and never throws: a refusal or a network error is a failed result', async () => {
    useEnv({ ...PROD, ...TWILIO, TWILIO_MESSAGING_SERVICE_SID: '', TWILIO_FROM_NUMBER: '+14155550100' });
    const refused = vi.fn(async () => new Response(JSON.stringify({ code: 21610, message: 'Attempt to send to unsubscribed recipient', status: 400 }), { status: 400 }));
    vi.stubGlobal('fetch', refused);
    expect(await sendSms({ to: '+14155550134', body: 'x' })).toEqual({ ok: false, provider: 'twilio', error: 'Attempt to send to unsubscribed recipient (Twilio error 21610)' });
    expect(new URLSearchParams((refused.mock.calls[0] as unknown as [string, RequestInit])[1].body as string).get('From')).toBe('+14155550100');
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('socket hang up'); }));
    expect(await sendSms({ to: '+14155550134', body: 'x' })).toEqual({ ok: false, provider: 'twilio', error: 'socket hang up' });
    const called = vi.fn();
    vi.stubGlobal('fetch', called);
    expect((await sendSms({ to: '4155550134', body: 'x' })).ok).toBe(false);
    expect(called).not.toHaveBeenCalled();
  });
});
