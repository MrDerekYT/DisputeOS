import type { MetadataRoute } from 'next';
import { NO_INDEX_PATHS, siteUrl } from '@/lib/site';

// Built per request so the sitemap address uses the APP_URL of the running server.
export const dynamic = 'force-dynamic';

/** Public pages are open to search engines; the staff app, the client portal, the API and single-use links are not. */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: '*', allow: '/', disallow: [...NO_INDEX_PATHS] }],
    sitemap: `${siteUrl()}/sitemap.xml`,
  };
}
