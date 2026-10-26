import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

const PROTECTED = ['/dashboard'];

/**
 * Refreshes the auth session, redirects unauthenticated users away from protected routes,
 * and enforces MFA: users must enroll a factor, and must be at AAL2 for protected routes.
 */
export async function updateSession(request: NextRequest, requestHeaders: Headers, csp: string) {
  let response = NextResponse.next({ request: { headers: requestHeaders } });
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const path = request.nextUrl.pathname;
  const isProtected =
    PROTECTED.some((p) => path === p || path.startsWith(`${p}/`)) || path === '/mfa';

  if (url && key) {
    const supabase = createServerClient(url, key, {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (list) => {
          list.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request: { headers: requestHeaders } });
          list.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
        },
      },
    });
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (isProtected) {
      const redirect = (to: string) => {
        const u = request.nextUrl.clone();
        u.pathname = to;
        u.search = '';
        return NextResponse.redirect(u);
      };
      if (!user) return redirect('/login');
      const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
      if (aal && aal.currentLevel !== 'aal2' && path !== '/mfa') return redirect('/mfa');
    }
  } else if (isProtected && process.env.NODE_ENV === 'production') {
    return new NextResponse('Service misconfigured', { status: 503 });
  }

  response.headers.set('Content-Security-Policy', csp);
  return response;
}
