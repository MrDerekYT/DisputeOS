import type { MetadataRoute } from 'next';
import { publishedSiteSlugs, sitePath } from '@/lib/agency-site';
import { abs } from '@/lib/site';

// Read from the database on every request: a site appears when it is published and disappears when it is unpublished.
export const dynamic = 'force-dynamic';

/**
 * The published agency websites, at /a/sitemap.xml. Kept apart from the product's own sitemap so that one never
 * depends on the database. Unpublished sites and personal workspaces are never listed.
 */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  return (await publishedSiteSlugs()).map((slug) => {
    const en = abs(sitePath(slug));
    return { url: en, changeFrequency: 'monthly' as const, priority: 0.5, alternates: { languages: { en, es: `${en}?lang=es` } } };
  });
}
