import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/site";

// Only the public marketing page is indexable; client data pages never are.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: "*", allow: ["/en$", "/es$"], disallow: ["/en/", "/es/", "/api/"] }],
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}
