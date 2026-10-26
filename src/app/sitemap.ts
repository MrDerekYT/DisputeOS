import type { MetadataRoute } from "next";
import { locales } from "@/i18n/config";
import { SITE_URL } from "@/lib/site";

export default function sitemap(): MetadataRoute.Sitemap {
  return locales.map((l) => ({
    url: `${SITE_URL}/${l}`,
    changeFrequency: "weekly",
    priority: 1,
    alternates: { languages: Object.fromEntries(locales.map((x) => [x, `${SITE_URL}/${x}`])) },
  }));
}
