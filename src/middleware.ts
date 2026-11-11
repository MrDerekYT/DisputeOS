import { NextResponse, type NextRequest } from 'next/server';
import { buildCsp } from '@/lib/csp';

const COOKIE = 'dos_session';

/**
 * Edge middleware: CSP nonce + a cheap "has a session cookie at all?" redirect for protected areas.
 * It cannot reach the database, so real authentication, MFA and role checks happen in requireStaff()/requireClient().
 */
export function middleware(req: NextRequest) {
  const nonce = btoa(crypto.randomUUID());
  const csp = buildCsp(nonce, process.env.NODE_ENV !== 'production');
  const path = req.nextUrl.pathname;
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
  const res = NextResponse.next({ request: { headers } });
  res.headers.set('Content-Security-Policy', csp);
  res.headers.set('Cache-Control', path.startsWith('/app') || path.startsWith('/portal') ? 'private, no-store' : res.headers.get('Cache-Control') ?? 'no-cache');
  return res;
}

export const config = {
  matcher: [{ source: '/((?!_next/static|_next/image|favicon.ico|api/webhooks).*)', missing: [{ type: 'header', key: 'next-router-prefetch' }] }],
};
