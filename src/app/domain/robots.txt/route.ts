import { headers } from 'next/headers';
import { hostName } from '@/lib/domain-rules';
import { requestAgencySlug } from '@/lib/request-host';
import { NO_INDEX_PATHS } from '@/lib/site';

export const dynamic = 'force-dynamic';

/** robots.txt on an agency's own domain (the middleware rewrites /robots.txt here). Unknown hosts get "not found". */
export async function GET() {
  if (!(await requestAgencySlug())) return new Response('Not found', { status: 404 });
  const host = hostName((await headers()).get('host'));
  const lines = ['User-agent: *', 'Allow: /', ...NO_INDEX_PATHS.map((p) => `Disallow: ${p}`), '', `Sitemap: https://${host}/sitemap.xml`, ''];
  return new Response(lines.join('\n'), { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}
