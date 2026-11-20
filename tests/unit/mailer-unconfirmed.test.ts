import net from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { resetEnvCache } from '@/lib/env';
import { sendEmail } from '@/lib/mailer';

// The Resend driver, with the HTTP call stood in for. Nothing leaves the machine: every request below goes to a
// stand-in function or to a socket opened by this file on 127.0.0.1.
const saved = { ...process.env };
const realFetch = globalThis.fetch;
beforeAll(() => { Object.assign(process.env, { EMAIL_DRIVER: 'resend', RESEND_API_KEY: 're_test_key_for_vitest' }); resetEnvCache(); });
afterEach(() => { vi.unstubAllGlobals(); });
afterAll(() => { process.env = { ...saved }; resetEnvCache(); });

const MAIL = { to: 'dana@hillrealty.example', subject: 'Introducing Bright Path Credit', text: 'Hello Dana,' };
/** What Node's fetch throws when the network fails: a TypeError whose `cause` carries the system error code. */
const networkError = (code: string) => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(code), { code }) });
const failWith = (e: unknown) => vi.stubGlobal('fetch', async () => { throw e; });
const listening = (server: net.Server) => new Promise<number>((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port)));

describe('email service: a send with no answer is "outcome unknown", not a refusal', () => {
  it('a timeout, or a connection that drops after it was made, may have delivered the email', async () => {
    // What AbortSignal.timeout gives when the service does not answer in time.
    failWith(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
    expect(await sendEmail(MAIL)).toEqual({ ok: false, provider: 'resend', error: 'The operation was aborted due to timeout', unconfirmed: true });
    // Among them errors that can also strike a connection that already carried the request (a route that went away).
    for (const code of ['ECONNRESET', 'UND_ERR_SOCKET', 'EPIPE', 'UND_ERR_HEADERS_TIMEOUT', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH']) {
      failWith(networkError(code));
      expect(await sendEmail(MAIL), code).toEqual({ ok: false, provider: 'resend', error: 'fetch failed', unconfirmed: true });
    }
    // An error that says nothing about how far the request got is treated the same way.
    failWith(new Error('something else'));
    expect(await sendEmail(MAIL)).toMatchObject({ ok: false, unconfirmed: true });
  });

  it('when no connection was ever made nothing can have been delivered, so that is a plain failure', async () => {
    for (const code of ['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'UND_ERR_CONNECT_TIMEOUT']) {
      failWith(networkError(code));
      expect(await sendEmail(MAIL), code).toEqual({ ok: false, provider: 'resend', error: 'fetch failed' });
    }
  });

  it('an answer from the service is believed: a refusal is a refusal, an acceptance carries its id', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ message: 'The example.com domain is not verified.' }), { status: 403 }));
    expect(await sendEmail(MAIL)).toEqual({ ok: false, provider: 'resend', error: 'The example.com domain is not verified.' });
    // A request the service turned down, too many requests at once included: nothing was accepted.
    for (const status of [400, 401, 404, 422, 429]) {
      vi.stubGlobal('fetch', async () => new Response('{}', { status }));
      expect(await sendEmail(MAIL), String(status)).toEqual({ ok: false, provider: 'resend', error: `HTTP ${status}` });
    }
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ id: 're_123' }), { status: 200 }));
    expect(await sendEmail(MAIL)).toEqual({ ok: true, provider: 'resend', providerRef: 're_123' });
  });

  it('a 5xx answer does not say whether the email was accepted (a gateway in front of the service may send it), so it is "outcome unknown"', async () => {
    for (const status of [500, 502, 503, 504]) {
      vi.stubGlobal('fetch', async () => new Response('bad gateway', { status }));
      expect(await sendEmail(MAIL), String(status)).toEqual({ ok: false, provider: 'resend', error: `HTTP ${status}`, unconfirmed: true });
    }
    // The service's own message is kept when it gives one.
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ message: 'Internal server error' }), { status: 500 }));
    expect(await sendEmail(MAIL)).toEqual({ ok: false, provider: 'resend', error: 'Internal server error', unconfirmed: true });
  });

  it('holds with the errors Node really produces: a socket closed after the request was read, and a refused connection', async () => {
    // A server that reads the request and hangs up without answering: the request arrived, the answer never did.
    const rude = net.createServer((socket) => { socket.once('data', () => socket.destroy()); });
    const port = await listening(rude);
    vi.stubGlobal('fetch', (_url: string, init: RequestInit) => realFetch(`http://127.0.0.1:${port}/emails`, init));
    const dropped = await sendEmail(MAIL);
    expect(dropped).toMatchObject({ ok: false, provider: 'resend', unconfirmed: true });
    await new Promise((resolve) => rude.close(resolve));
    // The same port with nothing listening on it any more: the connection is refused, so nothing was sent.
    const refused = await sendEmail(MAIL);
    expect(refused).toMatchObject({ ok: false, provider: 'resend' });
    expect(refused.unconfirmed).toBeUndefined();
  });
});
