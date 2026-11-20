import { NextResponse, type NextRequest } from 'next/server';
import { buildCsp } from '@/lib/csp';
import { hostRoute, hstsFor } from '@/lib/domain-rules';

const COOKIE = 'dos_session';

/**
 * Edge middleware: CSP nonce + a cheap "has a session cookie at all?" redirect for protected areas.
 * It cannot reach the database, so real authentication, MFA and role checks happen in requireStaff()/requireClient().
 */
export function middleware(req: NextRequest) {
  const path = req.nextUrl.pathname;
  const host = req.headers.get('host');

  // An agency's own domain serves that agency's site, enquiry form and client portal; everything else (the staff
  // app, staff sign-in, sign-up, the product's pages) lives on the platform host. Decided from Host and path only;
  // which agency a host belongs to is resolved on the server (src/lib/request-host.ts).
  const route = hostRoute(host, path, process.env.APP_URL);
  if (route.kind === 'redirect') return NextResponse.redirect(new URL(route.origin + path + req.nextUrl.search));
  const rewritten = () => { const url = req.nextUrl.clone(); url.pathname = (route as { path: string }).path; return url; };

  // A link prefetch gets the host decision and nothing else: it renders no document, so it needs no nonce.
  if (req.headers.has('next-router-prefetch')) return route.kind === 'rewrite' ? NextResponse.rewrite(rewritten()) : NextResponse.next();

  const nonce = btoa(crypto.randomUUID());
  const csp = buildCsp(nonce, process.env.NODE_ENV !== 'production');
  const hasSession = req.cookies.has(COOKIE);

  if (!hasSession && (path === '/app' || path.startsWith('/app/'))) {
    const url = req.nextUrl.clone();
    url.pathname = '/login';
    url.search = '';
    return NextResponse.redirect(url);
  }
  if (!hasSession && path.startsWith('/portal') && path !== '/portal/login') {
    const url = req.nextUrl.clone();
    url.pathname = '/portal/login';
    url.search = '';
    return NextResponse.redirect(url);
  }

  const headers = new Headers(req.headers);
  headers.set('x-nonce', nonce);
  headers.set('Content-Security-Policy', csp);
  const res = route.kind === 'rewrite' ? NextResponse.rewrite(rewritten(), { request: { headers } }) : NextResponse.next({ request: { headers } });
  res.headers.set('Content-Security-Policy', csp);
  res.headers.set('Strict-Transport-Security', hstsFor(host, process.env.APP_URL));
  res.headers.set('Cache-Control', path.startsWith('/app') || path.startsWith('/portal') ? 'private, no-store' : res.headers.get('Cache-Control') ?? 'no-cache');
  return res;
}

export const config = {
  // Prefetches are matched too: which host may reach which path has to hold for every request.
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
