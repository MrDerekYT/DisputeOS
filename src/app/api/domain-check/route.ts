import { headers } from 'next/headers';
import { domainRowForHost } from '@/lib/agency-domains';

export const dynamic = 'force-dynamic';

/**
 * Answers "does this Host reach this deployment, and which connected domain is it?" for the platform operator's
 * check (scripts/verify-domain.mjs), which compares the id with the database. Says nothing on the platform's own
 * host or for a host nobody has connected. The id is not a secret: it grants nothing.
 */
export async function GET() {
  const row = await domainRowForHost((await headers()).get('host'));
  if (!row) return Response.json({ error: 'not_found' }, { status: 404 });
  return Response.json({ id: row.id, domain: row.domain }, { headers: { 'Cache-Control': 'no-store' } });
}
