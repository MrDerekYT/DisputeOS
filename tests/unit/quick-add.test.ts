import { describe, expect, it } from 'vitest';
import { textHrefFor } from '@/app/app/clients/new/quick-add';
import { welcomeTextHref } from '@/lib/welcome-link';

/**
 * "Text it from your phone" (New client → Invite a client, when the welcome link is passed on by hand): a link that
 * opens the staff member's own messaging app with the client's number and the welcome link already typed.
 */
describe('the text link for a welcome link sent by hand', () => {
  const link = 'https://app.example.com/invite/aB3_x-9?utm=1&x=y#top';
  const body = (href: string) => decodeURIComponent(href.slice(href.indexOf('body=') + 5));

  it('carries the number in international form and the link in the message, both encoded', () => {
    const href = welcomeTextHref('(813) 555-0142', { lang: 'en', fullName: 'Dana Whitfield', link })!;
    expect(href.startsWith('sms:+18135550142?body=')).toBe(true);
    expect(body(href)).toBe(`Hello Dana, here is your link to set up your client portal. It works once and expires in 7 days: ${link}`);
    // Nothing in the message can be read as part of the address: no raw space, &, ?, #, + or = after "body=".
    expect(href.slice(href.indexOf('body=') + 5)).toMatch(/^[A-Za-z0-9%._~!'()*-]+$/);
    expect(href).toContain('https%3A%2F%2Fapp.example.com%2Finvite%2FaB3_x-9%3Futm%3D1%26x%3Dy%23top');
  });

  it('reads a number as people type it, and one from another country only with its + and country code', () => {
    const to = (phone: string) => welcomeTextHref(phone, { lang: 'en', fullName: 'Dana Whitfield', link })?.split('?')[0];
    expect(to('813-555-0142')).toBe('sms:+18135550142');
    expect(to('1 813 555 0142')).toBe('sms:+18135550142');
    expect(to('+1 (813) 555-0142')).toBe('sms:+18135550142');
    expect(to('+44 7911 123456')).toBe('sms:+447911123456');
  });

  it('is in the client’s language, with their first name only when it reads as one', () => {
    expect(body(welcomeTextHref('8135550142', { lang: 'es', fullName: 'Luz Marín', link })!)).toBe(`Hola Luz: este es su enlace para configurar su portal de cliente. Funciona una sola vez y vence en 7 días: ${link}`);
    expect(welcomeTextHref('8135550142', { lang: 'es', fullName: 'Luz Marín', link })).toContain('d%C3%ADas');
    expect(body(welcomeTextHref('8135550142', { lang: 'en', fullName: 'www.claim-your-refund.example Team', link })!)).toBe(`Hello, here is your link to set up your client portal. It works once and expires in 7 days: ${link}`);
    expect(body(welcomeTextHref('8135550142', { lang: 'es', fullName: '4U Credit', link })!)).toMatch(/^Hola: este es su enlace/);
  });

  it('says which business it is from, so it does not read like a text from a stranger', () => {
    const from = (orgName: string, lang: 'en' | 'es' = 'en', fullName = 'Dana Whitfield') => body(welcomeTextHref('8135550142', { lang, fullName, orgName, link })!);
    expect(from('Bright Path Credit')).toBe(`Hello Dana, this is Bright Path Credit. Here is your link to set up your client portal. It works once and expires in 7 days: ${link}`);
    expect(from('Bright Path Credit', 'es', 'Luz Marín')).toBe(`Hola Luz: le escribe Bright Path Credit. Este es su enlace para configurar su portal de cliente. Funciona una sola vez y vence en 7 días: ${link}`);
    // Without a first name that reads as one, the business is still named.
    expect(from('Bright Path Credit', 'en', '4U Credit')).toBe(`Hello, this is Bright Path Credit. Here is your link to set up your client portal. It works once and expires in 7 days: ${link}`);
    // A name is one line of text, however it was saved, and it is encoded like the rest of the message.
    expect(from('  Smith &\n Sons  Credit? #1 ')).toBe(`Hello Dana, this is Smith & Sons Credit? #1. Here is your link to set up your client portal. It works once and expires in 7 days: ${link}`);
    expect(welcomeTextHref('8135550142', { lang: 'en', fullName: 'Dana Whitfield', orgName: 'Smith & Sons Credit? #1', link })!.slice('sms:+18135550142?body='.length)).toMatch(/^[A-Za-z0-9%._~!'()*-]+$/);
    // A name that ends in a full stop does not make two.
    expect(from('Acme Credit Inc.')).toBe(`Hello Dana, this is Acme Credit Inc. Here is your link to set up your client portal. It works once and expires in 7 days: ${link}`);
  });

  it('leaves the business name out when the name carries wording the welcome email would be held back for, or there is none', () => {
    const plain = `Hello Dana, here is your link to set up your client portal. It works once and expires in 7 days: ${link}`;
    for (const orgName of ['Guaranteed Credit Results', '100% Success Credit', 'CPN Experts', 'We Will Remove It Credit', '', '   ', undefined]) {
      expect(body(welcomeTextHref('8135550142', { lang: 'en', fullName: 'Dana Whitfield', orgName, link })!), String(orgName)).toBe(plain);
    }
    expect(body(welcomeTextHref('8135550142', { lang: 'es', fullName: 'Luz Marín', orgName: 'Guaranteed Credit Results', link })!)).toBe(`Hola Luz: este es su enlace para configurar su portal de cliente. Funciona una sola vez y vence en 7 días: ${link}`);
  });

  it('is the standard form, with the one separator Apple devices read swapped when the page is open on one', () => {
    const href = welcomeTextHref('(813) 555-0142', { lang: 'en', fullName: 'Dana Whitfield', link })!;
    // RFC 5724: sms:<number>?body=<text>. Nothing else in the link holds "?body=": the message is encoded.
    expect(href.split('?body=')).toHaveLength(2);
    const android = 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36';
    const windows = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
    const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1';
    const ipad = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15'; // an iPad says it is a Mac
    for (const ua of [android, windows, '']) expect(textHrefFor(ua, href), ua).toBe(href);
    for (const ua of [iphone, ipad]) {
      expect(textHrefFor(ua, href), ua).toBe(href.replace('?body=', '&body='));
      expect(textHrefFor(ua, href).startsWith('sms:+18135550142&body=Hello%20Dana%2C')).toBe(true);
      expect(body(textHrefFor(ua, href))).toBe(body(href));
    }
  });

  it('is not offered when there is no number, or what was typed cannot be read as one', () => {
    for (const phone of [undefined, null, '', '   ', '555-0142', 'call the office', '813-555-0142 ext 204', '113-555-0142', '+1']) {
      expect(welcomeTextHref(phone, { lang: 'en', fullName: 'Dana Whitfield', link }), String(phone)).toBeNull();
    }
  });
});
