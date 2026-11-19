import { NextResponse } from 'next/server';
import { rateLimit } from '@/lib/auth/rate-limit';
import { clientIp } from '@/lib/client-ip';
import { optOutPartner, verifyPartnerOptOutToken } from '@/lib/partner-outreach';

export const dynamic = 'force-dynamic';

/**
 * One-click unsubscribe for partner emails (RFC 8058). Every email carries
 *   List-Unsubscribe: <this URL>   and   List-Unsubscribe-Post: List-Unsubscribe=One-Click
 * so a mail program can show its own "unsubscribe" button; pressing it sends a POST here, and that POST is the opt-out.
 * No sign-in: the token is the signed one from the email. A GET (what a link scanner or a curious reader sends) changes
 * nothing and goes to the page that asks first.
 */
export async function POST(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const limit = await rateLimit(`partner-unsubscribe:ip:${clientIp(req.headers) ?? 'unknown'}`, 60, 60);
  if (!limit.allowed) return new NextResponse('Too many requests', { status: 429, headers: { 'retry-after': String(limit.retryAfterSec) } });
  const r = await optOutPartner((await params).token);
  return new NextResponse(r ? 'You will not receive these emails again.' : 'This link is not valid.', { status: r ? 200 : 404, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
}

export async function GET(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const token = (await params).token;
  if (!verifyPartnerOptOutToken(token)) return new NextResponse('This link is not valid.', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  return NextResponse.redirect(new URL(`/unsubscribe/partner/${encodeURIComponent(token)}`, req.url), 303);
}
