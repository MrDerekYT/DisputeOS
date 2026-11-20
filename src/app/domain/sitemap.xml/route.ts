import { publicSiteBySlug, siteHome } from '@/lib/agency-site';
import { requestAgencySlug } from '@/lib/request-host';

export const dynamic = 'force-dynamic';

/**
 * sitemap.xml on an agency's own domain (the middleware rewrites /sitemap.xml here): that agency's site and nothing
 * else. An unknown host, or a site that is not published, gets "not found".
 */
export async function GET() {
  const site = await publicSiteBySlug(await requestAgencySlug());
  if (!site?.domain) return new Response('Not found', { status: 404 });
  const en = siteHome(site);
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
<url><loc>${en}</loc><xhtml:link rel="alternate" hreflang="en" href="${en}"/><xhtml:link rel="alternate" hreflang="es" href="${en}?lang=es"/><changefreq>monthly</changefreq></url>
</urlset>
`;
  return new Response(xml, { headers: { 'Content-Type': 'application/xml; charset=utf-8' } });
}
