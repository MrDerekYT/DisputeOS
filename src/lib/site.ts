/**
 * The public marketing site: its address, its pages, and the metadata every page shares (title, description,
 * canonical link, Open Graph and Twitter cards). The sitemap and the navigation are built from the same lists,
 * so a page cannot be linked but missing from the sitemap, or the other way round.
 */
import type { Metadata } from 'next';
import { PRODUCT } from './product';

/**
 * Public origin, without a trailing slash. Read from APP_URL when the request is served — not through getEnv(), which
 * validates every secret and would make a public page depend on the database settings being present.
 */
export function siteUrl(): string {
  const raw = process.env.APP_URL?.trim();
  if (raw) {
    try { return new URL(raw).origin; } catch { /* fall through to the local default */ }
  }
  return 'http://localhost:3000';
}

/** Absolute address of a site path. The home page is the bare origin. */
export const abs = (path: string) => `${siteUrl()}${path === '/' ? '' : path}`;

export interface Guide {
  slug: string;
  title: string;
  /** One or two sentences: the meta description and the summary on the guides page. */
  description: string;
  /** Short label for cards. */
  kicker: string;
  minutes: number;
  /** ISO date the content was last checked. */
  reviewed: string;
}

export const GUIDES: readonly Guide[] = [
  {
    slug: 'how-the-30-day-dispute-investigation-works',
    title: 'How the 30-day dispute investigation works',
    description: 'What a credit bureau must do after it receives a dispute, when 30 days becomes 45, and what your agency should track on every open dispute.',
    kicker: 'FCRA timelines',
    minutes: 8,
    reviewed: '2026-11-19',
  },
  {
    slug: 'how-to-start-a-credit-repair-business',
    title: 'How to start a credit repair business the compliant way',
    description: 'The Credit Repair Organizations Act in plain language: the disclosure, the written contract, the three-day cancellation right, the ban on advance fees, and what your state may add.',
    kicker: 'CROA basics',
    minutes: 10,
    reviewed: '2026-11-19',
  },
  {
    slug: 'how-to-read-a-credit-report',
    title: 'How to read a credit report, section by section',
    description: 'What each part of a credit report means, which dates control how long an item stays, and what to compare across Experian, Equifax and TransUnion before anyone disputes anything.',
    kicker: 'Report basics',
    minutes: 9,
    reviewed: '2026-11-19',
  },
];

export const guidePath = (slug: string) => `/guides/${slug}`;
export const guideBySlug = (slug: string): Guide => {
  const g = GUIDES.find((x) => x.slug === slug);
  if (!g) throw new Error(`unknown guide: ${slug}`);
  return g;
};

/** Header navigation. */
export const SITE_NAV = [
  { href: '/features', label: 'Features' },
  { href: '/pricing', label: 'Pricing' },
  { href: '/security', label: 'Security' },
  { href: '/guides', label: 'Guides' },
] as const;

/** Every indexable public page, for the sitemap. Sign-in and sign-up are linked but add nothing to search. */
export const SITE_PAGES: readonly { path: string; priority: number; changeFrequency: 'weekly' | 'monthly' }[] = [
  { path: '/', priority: 1, changeFrequency: 'weekly' },
  { path: '/features', priority: 0.9, changeFrequency: 'monthly' },
  { path: '/pricing', priority: 0.9, changeFrequency: 'monthly' },
  { path: '/security', priority: 0.6, changeFrequency: 'monthly' },
  { path: '/guides', priority: 0.7, changeFrequency: 'weekly' },
  ...GUIDES.map((g) => ({ path: guidePath(g.slug), priority: 0.7, changeFrequency: 'monthly' as const })),
];

/** Areas that are private or are single-use links: kept out of search engines. */
export const NO_INDEX_PATHS = ['/app', '/portal', '/api/', '/mfa', '/invite', '/reset-password', '/forgot-password', '/unsubscribe'] as const;

/**
 * Metadata for one public page. `title` is used as written (no "· Product" suffix is added), so write the whole
 * title, product name included. Open Graph and Twitter use the site-wide image in src/app/opengraph-image.png.
 */
export function pageMeta({ title, description, path, type = 'website' }: { title: string; description: string; path: string; type?: 'website' | 'article' }): Metadata {
  const url = abs(path);
  return {
    metadataBase: new URL(siteUrl()),
    title: { absolute: title },
    description,
    alternates: { canonical: url },
    openGraph: { type, url, title, description, siteName: PRODUCT.name, locale: 'en_US' },
    twitter: { card: 'summary_large_image', title, description },
  };
}

/** Serialises structured data for a <script type="application/ld+json">; "<" is escaped so no value can close the tag. */
export const jsonLdString = (data: unknown) => JSON.stringify(data).replace(/</g, '\\u003c');

export const organizationLd = () => ({
  '@context': 'https://schema.org',
  '@type': 'Organization',
  name: PRODUCT.name,
  url: siteUrl(),
  description: PRODUCT.description,
});

export const breadcrumbLd = (trail: { name: string; path: string }[]) => ({
  '@context': 'https://schema.org',
  '@type': 'BreadcrumbList',
  itemListElement: trail.map((t, i) => ({ '@type': 'ListItem', position: i + 1, name: t.name, item: abs(t.path) })),
});

export interface Faq { q: string; a: string }
export const faqLd = (faqs: readonly Faq[]) => ({
  '@context': 'https://schema.org',
  '@type': 'FAQPage',
  mainEntity: faqs.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })),
});
