import { describe, expect, it } from 'vitest';
import { findBlockedClaims } from '@/lib/compliance/claims';
import { fromHeader } from '@/lib/mailer';
import { decideLeadStep, greetingName, leadEmail, leadSourceTag, LEAD_STEPS, type LeadOutreachState } from '@/lib/lead-emails';

const DAY = 86_400_000;
const T0 = new Date('2026-03-02T15:00:00Z');
const at = (days: number) => new Date(T0.getTime() + days * DAY);
const lead = (over: Partial<LeadOutreachState> = {}): LeadOutreachState => ({
  status: 'lead', hasEmail: true, consented: true, optedOut: false, replied: false, contacted: false, receivedAt: T0, eligibleFrom: at(-1), outreach: [], ...over,
});
const sent = (step: string, day: number) => ({ step, status: 'sent', at: at(day), attempts: 1 });
const vars = { firstName: 'Pat', orgName: 'Bright Path Credit', address: '12 Main St, Austin, TX 78701', optOutUrl: 'https://app.example.test/unsubscribe/abc' };

describe('automatic lead emails: wording', () => {
  for (const lang of ['en', 'es'] as const) {
    for (const { key } of LEAD_STEPS) {
      it(`${key} (${lang}) passes the claims guard and carries the agency name, postal address and opt-out link`, () => {
        const m = leadEmail(key, lang, vars);
        expect(findBlockedClaims(`${m.subject}\n${m.text}`)).toEqual([]);
        expect(m.subject).toContain('Bright Path Credit');
        expect(m.text).toContain('Bright Path Credit · 12 Main St, Austin, TX 78701');
        expect(m.text).toContain(vars.optOutUrl);
        expect(m.text).not.toMatch(/\{\w+\}/);
        // Never a number of points, a time frame or a price.
        expect(m.text.replace(vars.address, '')).not.toMatch(/\d/);
      });
    }
  }

  it('says plainly that no result can be promised and that disputing yourself is free', () => {
    const en = leadEmail('welcome', 'en', vars).text;
    expect(en).toMatch(/no one can honestly promise/);
    expect(en).toMatch(/dispute inaccurate information with the credit bureaus yourself, at no cost/);
    expect(leadEmail('welcome', 'es', vars).text).toMatch(/nadie puede prometer/);
  });

  it('keeps a multi-line address or name on one line', () => {
    const m = leadEmail('final', 'en', { ...vars, address: '12 Main St\nAustin, TX', orgName: 'Bright\nPath' });
    expect(m.text).toContain('Bright Path · 12 Main St Austin, TX');
    expect(m.subject).not.toMatch(/\n/);
  });

  it('greets by a plain first name only: a link or anything else typed as a name never reaches the email', () => {
    expect(greetingName('Pat Lead')).toBe('Pat');
    expect(greetingName("  María-José O'Neil ")).toBe('María-José');
    expect(greetingName("O'Brien")).toBe("O'Brien");
    for (const bad of ['https://evil.example/claim', 'www.evil.example Pat', 'evil.example', 'Pat123', 'Claim:$500 now', '<b>Pat</b>', 'a'.repeat(31), '-Pat', '']) expect(greetingName(bad), bad).toBe('');
    for (const lang of ['en', 'es'] as const) for (const { key } of LEAD_STEPS) {
      const m = leadEmail(key, lang, { ...vars, firstName: 'https://evil.example/claim now' });
      expect(`${m.subject}\n${m.text}`).not.toMatch(/evil|claim/);
      expect(m.text.startsWith(lang === 'es' ? 'Hola qué tal:' : 'Hi there,')).toBe(true);
    }
  });

  it('says in every email that a reply alone does not stop the emails and the link does', () => {
    for (const { key } of LEAD_STEPS) {
      expect(leadEmail(key, 'en', vars).text).toMatch(/does not stop these automatic emails by itself\. The link above does\.$/);
      expect(leadEmail(key, 'es', vars).text).toMatch(/por sí sola no detiene estos correos automáticos\. El enlace anterior sí\.$/);
    }
  });

  it('names the agency on the From line while keeping the platform sending address', () => {
    expect(fromHeader('DisputeOS <no-reply@mail.example.test>', 'Bright Path Credit')).toBe('"Bright Path Credit" <no-reply@mail.example.test>');
    expect(fromHeader('no-reply@mail.example.test', 'Bright Path')).toBe('"Bright Path" <no-reply@mail.example.test>');
    expect(fromHeader('DisputeOS <no-reply@mail.example.test>', 'Evil" <a@b.example>\r\nBcc: x@y.example')).toBe('"Evil a@b.example Bcc: x@y.example" <no-reply@mail.example.test>');
    expect(fromHeader('DisputeOS <no-reply@mail.example.test>')).toBe('DisputeOS <no-reply@mail.example.test>');
    expect(fromHeader('DisputeOS <no-reply@mail.example.test>', ' "<>" ')).toBe('DisputeOS <no-reply@mail.example.test>');
  });
});

describe('automatic lead emails: which step is due', () => {
  it('welcome at once, follow-up after 2 days, last note after 6, then nothing', () => {
    expect(decideLeadStep(lead(), at(0))).toEqual({ kind: 'send', step: 'welcome' });
    expect(decideLeadStep(lead({ outreach: [sent('welcome', 0)] }), at(1))).toEqual({ kind: 'wait', step: 'followup', dueAt: at(2) });
    expect(decideLeadStep(lead({ outreach: [sent('welcome', 0)] }), at(2))).toEqual({ kind: 'send', step: 'followup' });
    expect(decideLeadStep(lead({ outreach: [sent('welcome', 0), sent('followup', 2)] }), at(5))).toEqual({ kind: 'wait', step: 'final', dueAt: at(6) });
    expect(decideLeadStep(lead({ outreach: [sent('welcome', 0), sent('followup', 2)] }), at(6))).toEqual({ kind: 'send', step: 'final' });
    expect(decideLeadStep(lead({ outreach: [sent('welcome', 0), sent('followup', 2), sent('final', 6)] }), at(7))).toEqual({ kind: 'stop', reason: 'done' });
  });

  it('never sends two emails within 2 days of each other, even when the schedule ran late', () => {
    expect(decideLeadStep(lead({ outreach: [sent('welcome', 5)] }), at(6))).toEqual({ kind: 'wait', step: 'followup', dueAt: at(7) });
    expect(decideLeadStep(lead({ outreach: [sent('welcome', 5), sent('followup', 7)] }), at(8))).toEqual({ kind: 'wait', step: 'final', dueAt: at(9) });
  });

  it('stops for anyone who converted, opted out, replied, was contacted, did not consent or has no email', () => {
    const reason = (over: Partial<LeadOutreachState>) => { const d = decideLeadStep(lead(over), at(3)); return d.kind === 'stop' ? d.reason : d.kind; };
    expect(reason({ status: 'onboarding' })).toBe('not_lead');
    expect(reason({ status: 'cancelled' })).toBe('not_lead');
    expect(reason({ optedOut: true })).toBe('opted_out');
    expect(reason({ consented: false })).toBe('no_consent');
    expect(reason({ hasEmail: false })).toBe('no_email');
    expect(reason({ replied: true })).toBe('replied');
    expect(reason({ contacted: true })).toBe('contacted');
  });

  it('covers only enquiries received after the switch went on, and not ones older than 14 days', () => {
    expect(decideLeadStep(lead({ eligibleFrom: null }), at(0))).toEqual({ kind: 'stop', reason: 'before_switch' });
    expect(decideLeadStep(lead({ eligibleFrom: at(1) }), at(2))).toEqual({ kind: 'stop', reason: 'before_switch' });
    expect(decideLeadStep(lead({ eligibleFrom: 'not a date' }), at(2))).toEqual({ kind: 'stop', reason: 'before_switch' });
    expect(decideLeadStep(lead({ outreach: [sent('welcome', 0)] }), at(15))).toEqual({ kind: 'stop', reason: 'expired' });
  });

  it('retries a failed step, but gives up after 3 attempts', () => {
    const failed = (attempts: number) => lead({ outreach: [{ step: 'welcome', status: 'failed', at: at(0), attempts }] });
    expect(decideLeadStep(failed(2), at(0))).toEqual({ kind: 'send', step: 'welcome' });
    expect(decideLeadStep(failed(3), at(0))).toEqual({ kind: 'stop', reason: 'failed' });
  });

  it('never re-sends a step whose delivery was not confirmed, and sends nothing after it', () => {
    const stuck = { step: 'followup', status: 'sending', at: at(2), attempts: 1 };
    expect(decideLeadStep(lead({ outreach: [sent('welcome', 0), stuck] }), at(2))).toEqual({ kind: 'stop', reason: 'unconfirmed' });
    expect(decideLeadStep(lead({ outreach: [sent('welcome', 0), stuck] }), at(9))).toEqual({ kind: 'stop', reason: 'unconfirmed' });
    expect(decideLeadStep(lead({ outreach: [{ ...stuck, step: 'welcome' }] }), at(0))).toEqual({ kind: 'stop', reason: 'unconfirmed' });
  });
});

describe('enquiry source tag', () => {
  it('accepts short lowercase tags and ignores anything else', () => {
    expect(leadSourceTag('instagram')).toBe('instagram');
    expect(leadSourceTag(' Spring-Flyer-2 ')).toBe('spring-flyer-2');
    for (const bad of ['', 'two words', '<script>', 'a'.repeat(31), 'x_y', undefined, null, 7, ['a']]) expect(leadSourceTag(bad)).toBeNull();
  });
});
