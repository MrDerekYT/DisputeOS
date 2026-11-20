/**
 * Rules for agency custom domains that need no database and no Node API, so the edge middleware can use them too:
 * what counts as the platform's own host, which domain names an agency may connect, and what a request on a custom
 * domain is allowed to reach.
 */

/** The internal slug the middleware rewrites to: "the agency whose verified domain is this request's Host". */
export const HOST_SLUG = '_host';

/** Host header -> bare lower-case hostname (no port, no trailing dot). */
export function hostName(host: string | null | undefined): string {
  const h = (host ?? '').trim().toLowerCase();
  if (h.startsWith('[')) return h.slice(0, h.indexOf(']') + 1); // IPv6 literal
  return h.replace(/:\d+$/, '').replace(/\.$/, '');
}

/** A domain and its www twin are one name for routing and for uniqueness. */
export const bareDomain = (domain: string) => domain.replace(/^www\./, '');

function appHost(appUrl: string | null | undefined): string | null {
  try { return appUrl ? hostName(new URL(appUrl).host) : null; } catch { return null; }
}

const IP = /^(\[.*\]|\d{1,3}(\.\d{1,3}){3})$/;
/** Hosting-provider addresses of the platform itself (production alias and preview deployments). */
const PLATFORM_SUFFIXES = ['.vercel.app', '.vercel.dev', '.now.sh', '.localhost'];

/**
 * True when the request is for the platform itself: APP_URL's host (with or without www), a deployment address of
 * the hosting provider, localhost or a bare IP address. With no usable APP_URL every host is the platform, so a
 * misconfigured server never redirects anywhere.
 */
export function isPlatformHost(host: string | null | undefined, appUrl: string | null | undefined): boolean {
  const h = hostName(host);
  const app = appHost(appUrl);
  if (!h || !app) return true;
  if (h === 'localhost' || IP.test(h) || PLATFORM_SUFFIXES.some((s) => h.endsWith(s))) return true;
  return bareDomain(h) === bareDomain(app);
}

const CLIENT_AUTH_PATHS = ['/mfa', '/mfa/setup', '/forgot-password', '/reset-password'];

export type HostRoute =
  | { kind: 'platform' }
  /** Serve the request as it is (the client portal, static files, the API). */
  | { kind: 'pass' }
  /** Serve this internal path instead; the page resolves the Host to an agency on the server. */
  | { kind: 'rewrite'; path: string }
  /** Staff tools, sign-up and the product's own pages live on the platform host only. */
  | { kind: 'redirect'; origin: string };

/**
 * What a request may reach, decided from its Host and path alone. On an agency's domain: "/" is its website, "/start"
 * its enquiry form, "/portal/…" the client portal, "/mfa" and the password reset finish a client's sign-in, and everything else (the staff app, staff sign-in, sign-up, the
 * product's marketing pages, other agencies' /a/<slug> addresses) is sent to the platform host.
 */
export function hostRoute(host: string | null | undefined, path: string, appUrl: string | null | undefined): HostRoute {
  if (isPlatformHost(host, appUrl)) return { kind: 'platform' };
  if (path === '/') return { kind: 'rewrite', path: `/a/${HOST_SLUG}` };
  if (path === '/start') return { kind: 'rewrite', path: `/start/${HOST_SLUG}` };
  if (path === '/robots.txt' || path === '/sitemap.xml') return { kind: 'rewrite', path: `/domain${path}` };
  if (path === '/portal' || path.startsWith('/portal/') || path.startsWith('/api/') || path.startsWith('/_next/')) return { kind: 'pass' };
  // Two-step verification and the password reset are part of the client's sign-in. The session cookie is host-only,
  // so these have to be served on the agency's host: on the platform host the client would have no session.
  if (CLIENT_AUTH_PATHS.includes(path)) return { kind: 'pass' };
  if (/^\/[^/]+\.[a-z0-9]+$/i.test(path)) return { kind: 'pass' }; // top-level static files: icons, link-preview image
  return { kind: 'redirect', origin: new URL(appUrl!).origin };
}

const HSTS_AGE = 'max-age=63072000';
/**
 * Strict-Transport-Security for a response. "includeSubDomains; preload" is a promise about every name under a
 * domain, so it is made only for the platform's own host. On an agency's domain it would force HTTPS, for two years,
 * on subdomains this app does not serve (the agency's mail, shop or an older site).
 */
export function hstsFor(host: string | null | undefined, appUrl: string | null | undefined): string {
  return appHost(appUrl) && isPlatformHost(host, appUrl) ? `${HSTS_AGE}; includeSubDomains; preload` : HSTS_AGE;
}

const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const RESERVED_TLDS = ['localhost', 'local', 'internal', 'lan', 'home', 'test', 'example', 'invalid', 'onion'];
const PROVIDER_DOMAINS = ['vercel.app', 'vercel.dev', 'vercel.com', 'now.sh', 'vercel-dns.com'];

/**
 * Normalises and checks a domain an agency typed. Accepts a pasted address ("https://www.example.com/") and
 * international names (stored in their ASCII "xn--" form). Refuses anything that is not a public domain name the
 * agency could own: IP addresses, single-label and reserved names, wildcards, the hosting provider's own domains,
 * and the platform's own domain with every name above or below it.
 */
export function parseDomain(input: string, appUrl: string | null | undefined): { ok: true; domain: string } | { ok: false; error: string } {
  const bad = (error: string) => ({ ok: false as const, error });
  const raw = input.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/\.$/, '');
  if (!raw) return bad('Enter your domain, for example www.youragency.com.');
  if (/[\s@:*?#\\]/.test(raw)) return bad('Enter only the domain name, for example www.youragency.com.');
  let domain: string;
  try { domain = new URL(`http://${raw}`).hostname; } catch { return bad('That is not a valid domain name.'); } // IDNA -> xn--
  if (domain.length > 253) return bad('That domain name is too long.');
  const labels = domain.split('.');
  const tld = labels[labels.length - 1] ?? '';
  if (labels.length < 2 || !labels.every((l) => LABEL.test(l)) || !/^[a-z]/.test(tld) || tld.length < 2) return bad('That is not a valid domain name. Use a name such as www.youragency.com.');
  if (RESERVED_TLDS.includes(tld)) return bad('That name is not a public domain.');
  const within = (d: string, parent: string) => d === parent || d.endsWith(`.${parent}`);
  if (PROVIDER_DOMAINS.some((p) => within(domain, p))) return bad('That address belongs to the hosting provider. Enter a domain you own.');
  const app = appHost(appUrl);
  if (app && !IP.test(app) && app !== 'localhost') {
    const a = bareDomain(app);
    const d = bareDomain(domain);
    if (within(d, a) || within(a, d)) return bad('That is the platform’s own domain. Enter a domain you own.');
  }
  return { ok: true, domain };
}

export interface DnsRecord { type: 'A' | 'CNAME' | 'TXT'; name: string; value: string }

/**
 * The hosting provider's general-purpose DNS targets (Vercel: "A 76.76.21.21" for a root domain, "CNAME
 * cname.vercel-dns.com" for a subdomain). When the provider's API is connected, the values it recommends for this
 * project replace these.
 */
export const DEFAULT_A = '76.76.21.21';
export const DEFAULT_CNAME = 'cname.vercel-dns.com';

/** The registered domain record names are written against: the provider's answer when it fits, else the last two labels. */
const apexOf = (domain: string, apex?: string | null) => (apex && (domain === apex || domain.endsWith(`.${apex}`)) ? apex : domain.split('.').slice(-2).join('.'));

/**
 * The record that points a domain at the platform. `apex` is the registered domain when the provider told us;
 * without it, a two-label name (example.com) is treated as a root domain and anything longer as a subdomain.
 */
export function pointingRecord(domain: string, opts: { apex?: string | null; a?: string | null; cname?: string | null } = {}): DnsRecord {
  const apex = apexOf(domain, opts.apex);
  if (domain === apex) return { type: 'A', name: '@', value: opts.a || DEFAULT_A };
  return { type: 'CNAME', name: domain.slice(0, -(apex.length + 1)), value: opts.cname || DEFAULT_CNAME };
}

/**
 * Where the TXT record that ties a domain to one workspace lives: a fixed label in front of the domain without a
 * leading "www." (a domain and its www twin are one name). Only someone who manages the domain's DNS can create it.
 */
export const ownershipHost = (domain: string) => `_disputeos.${bareDomain(domain)}`;

/** That record as the agency creates it: the name is written against the registered domain, like the pointing record's. */
export function ownershipRecord(domain: string, value: string, apex?: string | null): DnsRecord {
  const host = ownershipHost(domain);
  const a = apexOf(domain, apex);
  return { type: 'TXT', name: host.endsWith(`.${a}`) ? host.slice(0, -(a.length + 1)) : host, value };
}
