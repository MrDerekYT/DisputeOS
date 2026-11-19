import { describe, expect, it } from 'vitest';
import { DEFAULT_A, DEFAULT_CNAME, hostRoute, hstsFor, isPlatformHost, parseDomain, pointingRecord } from '@/lib/domain-rules';
import { addDomain, domainState, removeDomain, type VercelConfig } from '@/lib/vercel-domains';

const APP = 'https://disputeos.com';

describe('which domains an agency may connect', () => {
  const ok = (input: string) => { const r = parseDomain(input, APP); return r.ok ? r.domain : `refused: ${r.error}`; };
  const refused = (input: string, appUrl: string = APP) => parseDomain(input, appUrl).ok === false;

  it('normalises what people type or paste', () => {
    expect(ok('www.Acme-Credit.com')).toBe('www.acme-credit.com');
    expect(ok('  https://acme-credit.com/  ')).toBe('acme-credit.com');
    expect(ok('acme-credit.com.')).toBe('acme-credit.com');
    expect(ok('clients.acme.co.uk')).toBe('clients.acme.co.uk');
    // International names are stored in their ASCII form.
    expect(ok('crédito-méxico.com')).toBe('xn--crdito-mxico-cebg.com');
  });

  it('refuses names that are not a public domain someone could own', () => {
    for (const bad of ['', 'localhost', 'acme', '127.0.0.1', '10.0.0.5', '2130706433', '0x7f.1', '[::1]', 'acme.local', 'intranet.internal', 'site.test',
      '*.acme.com', 'acme.com:8080', 'user@acme.com', 'acme..com', '-acme.com', 'acme-.com', 'acme.c', 'acme.123', 'a b.com', 'acme.com?x=1', `${'a'.repeat(64)}.com`, `${'a.'.repeat(130)}com`]) {
      expect(refused(bad), bad).toBe(true);
    }
  });

  it('refuses the hosting provider’s addresses and the platform’s own domain, above and below it', () => {
    for (const bad of ['disputeos-mu.vercel.app', 'anything.vercel.app', 'vercel.com', 'cname.vercel-dns.com', 'old.now.sh',
      'disputeos.com', 'www.disputeos.com', 'app.disputeos.com', 'a.b.disputeos.com']) expect(refused(bad), bad).toBe(true);
    // A platform on a subdomain protects its parent too; a different domain that merely ends the same is fine.
    expect(refused('example.com', 'https://app.example.com')).toBe(true);
    expect(ok('notdisputeos.com')).toBe('notdisputeos.com');
    expect(ok('disputeos.com.mx')).toBe('disputeos.com.mx');
  });
});

describe('platform host or agency domain', () => {
  it('treats APP_URL’s host, its www twin, deployment addresses, localhost and bare IPs as the platform', () => {
    for (const h of ['disputeos.com', 'www.disputeos.com', 'DisputeOS.com:443', 'disputeos-mu.vercel.app', 'disputeos-git-x-team.vercel.app', 'localhost:3000', '127.0.0.1:3000', '[::1]:3000', '', null]) {
      expect(isPlatformHost(h, APP), String(h)).toBe(true);
    }
    for (const h of ['www.acme-credit.com', 'acme-credit.com:443', 'app.disputeos.com', 'disputeos.com.evil.example']) expect(isPlatformHost(h, APP), h).toBe(false);
  });

  it('never treats a host as an agency domain when APP_URL is missing or unusable', () => {
    for (const appUrl of [undefined, '', 'not a url']) {
      expect(isPlatformHost('www.acme-credit.com', appUrl)).toBe(true);
      expect(hostRoute('www.acme-credit.com', '/app', appUrl)).toEqual({ kind: 'platform' });
    }
  });

  it('leaves every path alone on the platform host', () => {
    for (const p of ['/', '/app', '/login', '/a/some-agency', '/start/some-agency', '/portal/login', '/sitemap.xml']) expect(hostRoute('disputeos.com', p, APP)).toEqual({ kind: 'platform' });
  });

  it('on an agency domain serves its site, enquiry form and portal, and sends everything else to the platform', () => {
    const r = (p: string) => hostRoute('www.acme-credit.com', p, `${APP}/`);
    expect(r('/')).toEqual({ kind: 'rewrite', path: '/a/_host' });
    expect(r('/start')).toEqual({ kind: 'rewrite', path: '/start/_host' });
    expect(r('/robots.txt')).toEqual({ kind: 'rewrite', path: '/domain/robots.txt' });
    expect(r('/sitemap.xml')).toEqual({ kind: 'rewrite', path: '/domain/sitemap.xml' });
    for (const p of ['/portal', '/portal/login', '/portal/documents', '/api/domain-check', '/_next/data/x.json', '/favicon.ico', '/opengraph-image.png']) expect(r(p), p).toEqual({ kind: 'pass' });
    // Staff tools, sign-up, the product's pages and other agencies' addresses are never served on an agency's domain.
    // A client's two-step verification and password reset stay on the agency's host: the session cookie is host-only.
    for (const p of ['/mfa', '/mfa/setup', '/forgot-password', '/reset-password']) expect(r(p), p).toEqual({ kind: 'pass' });
    for (const p of ['/app', '/app/clients', '/app/clients/export.csv', '/login', '/signup', '/mfa/other', '/mfax', '/pricing', '/a/another-agency', '/a/_host/x', '/start/another-agency', '/domain/sitemap.xml', '/portalx']) {
      expect(r(p), p).toEqual({ kind: 'redirect', origin: APP });
    }
  });
});

describe('Strict-Transport-Security', () => {
  it('promises includeSubDomains and preload only for the platform host, never for an agency domain', () => {
    expect(hstsFor('disputeos.com', APP)).toBe('max-age=63072000; includeSubDomains; preload');
    expect(hstsFor('www.disputeos.com:443', APP)).toBe('max-age=63072000; includeSubDomains; preload');
    expect(hstsFor('acme-credit.com', APP)).toBe('max-age=63072000');
    expect(hstsFor('www.acme-credit.com', APP)).toBe('max-age=63072000');
    // With no usable APP_URL the host cannot be told apart, so the narrower promise is made.
    expect(hstsFor('acme-credit.com', undefined)).toBe('max-age=63072000');
  });
});

describe('the DNS record that points a domain at the platform', () => {
  it('is an A record for a root domain and a CNAME for a subdomain', () => {
    expect(pointingRecord('acme-credit.com')).toEqual({ type: 'A', name: '@', value: DEFAULT_A });
    expect(pointingRecord('www.acme-credit.com')).toEqual({ type: 'CNAME', name: 'www', value: DEFAULT_CNAME });
    expect(pointingRecord('clients.portal.acme-credit.com')).toEqual({ type: 'CNAME', name: 'clients.portal', value: DEFAULT_CNAME });
  });
  it('uses the registered domain and the values the provider reports', () => {
    expect(pointingRecord('acme.co.uk', { apex: 'acme.co.uk', a: '216.198.79.1' })).toEqual({ type: 'A', name: '@', value: '216.198.79.1' });
    expect(pointingRecord('www.acme.co.uk', { apex: 'acme.co.uk', cname: 'abc123.vercel-dns-017.com' })).toEqual({ type: 'CNAME', name: 'www', value: 'abc123.vercel-dns-017.com' });
  });
});

// ---------------------------------------------------------------- Vercel client, against a mocked fetch (no network)
type Call = { method: string; url: string; body?: unknown; auth?: string };
function mock(routes: Record<string, { status?: number; json?: unknown } | Error>) {
  const calls: Call[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(String(input));
    calls.push({ method: init?.method ?? 'GET', url: `${u.pathname}${u.search}`, body: init?.body ? JSON.parse(String(init.body)) : undefined, auth: (init?.headers as Record<string, string>)?.Authorization });
    const r = routes[`${init?.method ?? 'GET'} ${u.pathname}`];
    if (!r) return new Response(JSON.stringify({ error: { code: 'not_found', message: 'Not found' } }), { status: 404 });
    if (r instanceof Error) throw r;
    return new Response(JSON.stringify(r.json ?? {}), { status: r.status ?? 200 });
  }) as typeof fetch;
  return { f, calls };
}
const CFG: VercelConfig = { token: 'tok_test', projectId: 'prj_1', teamId: 'team_9' };
const D = 'www.acme-credit.com';
const PD = `/v9/projects/prj_1/domains/${D}`;

describe('Vercel domains client', () => {
  it('adds a domain to the project, with the token and the team', async () => {
    const { f, calls } = mock({ 'POST /v10/projects/prj_1/domains': { json: { name: D, verified: true } } });
    expect(await addDomain(CFG, D, f)).toEqual({ ok: true, value: { already: false } });
    expect(calls).toEqual([{ method: 'POST', url: '/v10/projects/prj_1/domains?teamId=team_9', body: { name: D }, auth: 'Bearer tok_test' }]);
  });

  it('tells "already on this project" (400) apart from a refused name', async () => {
    const already = mock({ 'POST /v10/projects/prj_1/domains': { status: 400, json: { error: { message: 'already in use' } } }, [`GET ${PD}`]: { json: { name: D, verified: true } } });
    expect(await addDomain(CFG, D, already.f)).toEqual({ ok: true, value: { already: true } });
    const invalid = mock({ 'POST /v10/projects/prj_1/domains': { status: 400, json: { error: { message: 'Invalid domain' } } } });
    expect(await addDomain(CFG, D, invalid.f)).toEqual({ ok: false, status: 400, error: 'Invalid domain' });
  });

  it('reports a rejected token and an unreachable provider as errors, never as success', async () => {
    const denied = mock({ 'POST /v10/projects/prj_1/domains': { status: 403, json: { error: { message: 'Not authorized' } } } });
    const r = await addDomain({ token: 't', projectId: 'prj_1' }, D, denied.f);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/VERCEL_API_TOKEN/);
    expect(denied.calls[0]!.url).toBe('/v10/projects/prj_1/domains'); // no team -> no teamId
    const down = mock({ [`GET ${PD}`]: new TypeError('fetch failed'), [`DELETE ${PD}`]: new TypeError('fetch failed') });
    expect(await domainState(CFG, D, down.f)).toMatchObject({ ok: false, status: 0 });
    expect(await removeDomain(CFG, D, down.f)).toMatchObject({ ok: false });
  });

  it('reads a domain that is verified and correctly configured', async () => {
    const { f, calls } = mock({
      [`GET ${PD}`]: { json: { name: D, apexName: 'acme-credit.com', verified: true } },
      [`GET /v6/domains/${D}/config`]: { json: { misconfigured: false, recommendedIPv4: [{ rank: 2, value: ['76.76.21.21'] }, { rank: 1, value: ['216.198.79.1'] }], recommendedCNAME: [{ rank: 1, value: 'abc.vercel-dns-017.com.' }] } },
    });
    expect(await domainState(CFG, D, f)).toEqual({ ok: true, value: { verified: true, misconfigured: false, apexName: 'acme-credit.com', challenges: [], a: '216.198.79.1', cname: 'abc.vercel-dns-017.com' } });
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([`GET ${PD}?teamId=team_9`, `GET /v6/domains/${D}/config?projectIdOrName=prj_1&teamId=team_9`]);
  });

  it('re-checks an unverified domain and returns its TXT ownership challenge', async () => {
    const challenge = { type: 'TXT', domain: '_vercel.acme-credit.com', value: 'vc-domain-verify=www.acme-credit.com,abc', reason: 'pending_domain_verification' };
    const { f, calls } = mock({
      [`GET ${PD}`]: { json: { name: D, apexName: 'acme-credit.com', verified: false, verification: [challenge] } },
      [`POST ${PD}/verify`]: { status: 400, json: { error: { message: 'missing TXT record' } } },
      [`GET /v6/domains/${D}/config`]: { json: { misconfigured: true } },
    });
    expect(await domainState(CFG, D, f)).toEqual({ ok: true, value: { verified: false, misconfigured: true, apexName: 'acme-credit.com', challenges: [challenge], a: null, cname: null } });
    expect(calls.map((c) => c.method)).toEqual(['GET', 'POST', 'GET']);
  });

  it('treats a missing "misconfigured" answer as not configured', async () => {
    const { f } = mock({ [`GET ${PD}`]: { json: { name: D, verified: true } }, [`GET /v6/domains/${D}/config`]: { json: {} } });
    expect(await domainState(CFG, D, f)).toMatchObject({ ok: true, value: { verified: true, misconfigured: true } });
  });

  it('removes a domain, and counts one that is already gone as removed', async () => {
    const gone = mock({});
    expect(await removeDomain(CFG, D, gone.f)).toEqual({ ok: true, value: null });
    expect(gone.calls[0]).toMatchObject({ method: 'DELETE', url: `${PD}?teamId=team_9` });
    const refused = mock({ [`DELETE ${PD}`]: { status: 500, json: {} } });
    expect(await removeDomain(CFG, D, refused.f)).toEqual({ ok: false, status: 500, error: 'HTTP 500' });
  });
});

describe('middleware on an agency domain', () => {
  it('rewrites the site, keeps the portal on the host and sends staff routes to the platform', async () => {
    const { NextRequest } = await import('next/server');
    const { middleware } = await import('@/middleware');
    const prev = process.env.APP_URL;
    process.env.APP_URL = APP;
    try {
      const go = (url: string, host: string) => middleware(new NextRequest(url, { headers: { host } }));
      const site = go('https://www.acme-credit.com/?lang=es', 'www.acme-credit.com');
      expect(site.headers.get('x-middleware-rewrite')).toBe('https://www.acme-credit.com/a/_host?lang=es');
      expect(site.headers.get('Content-Security-Policy')).toContain("form-action 'self'");
      expect(go('https://www.acme-credit.com/start', 'www.acme-credit.com').headers.get('x-middleware-rewrite')).toBe('https://www.acme-credit.com/start/_host');
      const staff = go('https://www.acme-credit.com/app/clients?q=1', 'www.acme-credit.com');
      expect([staff.status, staff.headers.get('location')]).toEqual([307, 'https://disputeos.com/app/clients?q=1']);
      expect(go('https://www.acme-credit.com/login', 'www.acme-credit.com').headers.get('location')).toBe('https://disputeos.com/login');
      // The portal stays on the agency's host: no session -> its own sign-in page.
      expect(go('https://www.acme-credit.com/portal', 'www.acme-credit.com').headers.get('location')).toBe('https://www.acme-credit.com/portal/login');
      expect(go('https://www.acme-credit.com/portal/login', 'www.acme-credit.com').headers.get('x-middleware-rewrite')).toBeNull();
      // The platform host is untouched.
      const home = go('https://disputeos.com/', 'disputeos.com');
      expect([home.headers.get('x-middleware-rewrite'), home.headers.get('location')]).toEqual([null, null]);
      expect(go('https://disputeos.com/app', 'disputeos.com').headers.get('location')).toBe('https://disputeos.com/login');
    } finally {
      if (prev === undefined) delete process.env.APP_URL; else process.env.APP_URL = prev;
    }
  });
});
