import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/site";

// App pages are kept out of search results by their noindex meta tag, which crawlers must be able to fetch.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: "*", allow: "/", disallow: ["/api/"] }],
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}
