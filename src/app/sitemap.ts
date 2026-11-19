import type { MetadataRoute } from 'next';
import { GUIDES, SITE_PAGES, abs, guidePath } from '@/lib/site';

// Built per request so the addresses use the APP_URL of the running server, not of the machine that built it.
export const dynamic = 'force-dynamic';

export default function sitemap(): MetadataRoute.Sitemap {
  const reviewed = new Map(GUIDES.map((g) => [guidePath(g.slug), g.reviewed]));
  return SITE_PAGES.map((p) => ({
    url: abs(p.path),
    changeFrequency: p.changeFrequency,
    priority: p.priority,
    ...(reviewed.has(p.path) ? { lastModified: reviewed.get(p.path) } : {}),
  }));
}
