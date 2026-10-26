import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get('code');
  if (code) {
    const supabase = await createClient();
    await supabase.auth.exchangeCodeForSession(code);
  }
  // Fixed destination: never redirect to a caller-supplied URL (open-redirect safe).
  return NextResponse.redirect(new URL('/dashboard', request.nextUrl.origin));
}
