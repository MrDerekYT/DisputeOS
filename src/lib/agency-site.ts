/**
 * An agency's public website, hosted by this app at /a/<slug>. The content lives in organizations.settings under one
 * key (`website`), so the tenant policies on organizations already decide who may change it (owners and admins of
 * that workspace, nobody else).
 *
 * Everything an agency types is plain text: it is never parsed as HTML or markdown, React escapes it on output, and
 * it must pass the marketing claims guard before it is saved. The legal notices, the "how it works" steps and the
 * enquiry form are fixed copy the agency cannot edit (src/lib/agency-site-copy.ts).
 */
import { z } from 'zod';
import { findMarketingClaims } from './compliance/claims';
import { withSystem, type Db } from './db';
import { UserError } from './errors';
import { outreachSettings } from './lead-outreach';
import { orgBrandBySlug, type OrgBrand } from './org-brand';
import { abs } from './site';

export const SITE_LIMITS = { headline: 80, intro: 300, serviceTitle: 60, serviceText: 200, about: 1500, phone: 30, email: 200, hours: 120, area: 120, question: 140, answer: 500, items: 6 } as const;

/** Plain text only. Angle brackets are refused so nobody expects markup to work; everything else is shown as typed. */
const plain = (max: number) => z.string().trim().max(max, `Keep it under ${max} characters`).regex(/^[^<>]*$/, 'Use plain text, without < or >');
const oneLine = (max: number) => plain(max).regex(/^[^\r\n]*$/, 'Keep it on one line');

export const siteSchema = z.object({
  published: z.boolean().default(false),
  headline: oneLine(SITE_LIMITS.headline).default(''),
  intro: plain(SITE_LIMITS.intro).default(''),
  services: z.array(z.object({ title: oneLine(SITE_LIMITS.serviceTitle).min(1, 'Give each service a title'), text: plain(SITE_LIMITS.serviceText).default('') })).max(SITE_LIMITS.items).default([]),
  about: plain(SITE_LIMITS.about).default(''),
  phone: oneLine(SITE_LIMITS.phone).regex(/^[0-9+().\-\s]*$/, 'Use digits and + ( ) - only').default(''),
  email: z.union([z.literal(''), z.string().trim().toLowerCase().email('Enter a valid email address').max(SITE_LIMITS.email)]).default(''),
  hours: oneLine(SITE_LIMITS.hours).default(''),
  area: oneLine(SITE_LIMITS.area).default(''),
  faqs: z.array(z.object({ q: oneLine(SITE_LIMITS.question).min(1, 'Each question needs its text'), a: plain(SITE_LIMITS.answer).min(1, 'Each question needs an answer') })).max(SITE_LIMITS.items).default([]),
});
export type SiteContent = z.infer<typeof siteSchema>;
export const EMPTY_SITE: SiteContent = siteSchema.parse({});

/** The stored content, re-validated. Anything that no longer fits the schema reads as an empty, unpublished site. */
export function parseSite(settings: unknown): SiteContent {
  const raw = settings && typeof settings === 'object' ? (settings as Record<string, unknown>).website : null;
  const r = siteSchema.safeParse(raw ?? {});
  return r.success ? r.data : EMPTY_SITE;
}

export interface SiteIssue { field: string; why: string; excerpt: string }

/** Every prohibited claim in the agency's text, with the field it is in. Empty means the text may be saved. */
export function siteIssues(c: SiteContent): SiteIssue[] {
  const fields: [string, string][] = [
    ['Headline', c.headline], ['Introduction', c.intro], ['About', c.about], ['Hours', c.hours], ['Service area', c.area],
    ...c.services.map((s, i): [string, string] => [`Service ${i + 1}`, `${s.title}. ${s.text}`]),
    ...c.faqs.map((f, i): [string, string] => [`Question ${i + 1}`, `${f.q}. ${f.a}`]),
  ];
  return fields.flatMap(([field, text]) => findMarketingClaims(text).map((i) => ({ field, why: i.why, excerpt: i.excerpt })));
}

/**
 * Validates what the editor sent (structure, then claims) and returns content that is safe to store. Throws UserError.
 * Pass the workspace name to have it checked too when the content is published.
 */
export function checkSite(raw: unknown, orgName?: string): SiteContent {
  const r = siteSchema.safeParse(raw);
  if (!r.success) {
    const issue = r.error.issues[0];
    throw new UserError(`${siteFieldLabel(issue?.path ?? [])}: ${issue?.message ?? 'invalid value'}`);
  }
  const issue = siteIssues(r.data)[0];
  if (issue) throw new UserError(`${issue.field}: “${issue.excerpt}” cannot be published. ${issue.why}`);
  if (r.data.published && !r.data.headline) throw new UserError('Add a headline before you publish: it is the title of your site.');
  if (r.data.published && orgName != null) {
    const nameIssue = orgNameIssue(orgName);
    if (nameIssue) throw new UserError(nameIssue);
  }
  return r.data;
}

/**
 * The workspace name is the site's title, its footer and its name in search results, so a published site needs a name
 * that passes the same claims check as the text. Returns the message to show, or null when the name is fine.
 */
export function orgNameIssue(orgName: string): string | null {
  const issue = findMarketingClaims(orgName)[0];
  return issue ? `Your business name, “${orgName}”, cannot be shown on a published site: “${issue.excerpt}”. ${issue.why} Change the name in Settings.` : null;
}

const LABELS: Record<string, string> = { headline: 'Headline', intro: 'Introduction', about: 'About', phone: 'Phone', email: 'Email', hours: 'Hours', area: 'Service area' };
function siteFieldLabel(path: PropertyKey[]): string {
  const [k, i] = path;
  if (k === 'services') return `Service ${typeof i === 'number' ? i + 1 : ''}`.trim();
  if (k === 'faqs') return `Question ${typeof i === 'number' ? i + 1 : ''}`.trim();
  return LABELS[String(k)] ?? 'Website';
}

/**
 * Saves a workspace's site. Call it inside the caller's tenant transaction: row-level security lets only an owner or
 * admin of that workspace update it, so another workspace's id changes nothing and is reported as an error.
 */
export async function saveSite(db: Db, orgId: string, raw: unknown): Promise<SiteContent> {
  const org = await db.row<{ name: string }>("select name from public.organizations where id = $1 and mode = 'agency'", [orgId]);
  if (!org) throw new UserError('This workspace has no website to edit.');
  const content = checkSite(raw, org.name);
  const n = await db.run("update public.organizations set settings = settings || jsonb_build_object('website', $2::jsonb) where id = $1 and mode = 'agency'", [orgId, JSON.stringify(content)]);
  if (n !== 1) throw new UserError('This workspace has no website to edit.');
  return content;
}

/**
 * Takes a site down. Deliberately validates nothing and rewrites nothing: it flips the one flag on whatever is stored,
 * so an agency can always unpublish, whatever a later rule or limit makes of its saved text. Same tenant rules as saveSite.
 */
export async function unpublishSite(db: Db, orgId: string): Promise<void> {
  await db.run("update public.organizations set settings = jsonb_set(settings, '{website,published}', 'false'::jsonb) where id = $1 and mode = 'agency' and settings ? 'website'", [orgId]);
}

export const sitePath = (slug: string) => `/a/${encodeURIComponent(slug)}`;

export interface PublicSite { brand: OrgBrand; content: SiteContent; /** The agency's mailing address (the lead follow-up setting), or '' when none is saved. */ address: string }

/** A published site by its slug. Unpublished sites, personal workspaces and inactive workspaces all read as "no such site". */
export async function publicSiteBySlug(slug: string | null | undefined): Promise<PublicSite | null> {
  const brand = await orgBrandBySlug(slug);
  if (!brand) return null;
  const row = await withSystem((db) => db.row<{ settings: Record<string, unknown> | null }>(
    "select settings from public.organizations where slug = $1 and status = 'active' and mode = 'agency'", [brand.slug]));
  const content = parseSite(row?.settings);
  if (!content.published) return null;
  return { brand, content, address: outreachSettings(row?.settings).address };
}

/** Slugs of every published site, for the sitemap. */
export async function publishedSiteSlugs(): Promise<string[]> {
  const rows = await withSystem((db) => db.rows<{ slug: string }>(
    "select slug from public.organizations where status = 'active' and mode = 'agency' and settings->'website'->>'published' = 'true' order by slug limit 5000"));
  return rows.map((r) => r.slug);
}

/** A first draft the agency can load into the editor. Deliberately plain: it describes the work, never an outcome. */
export function starterSite(orgName: string): Omit<SiteContent, 'published' | 'phone' | 'email' | 'hours' | 'area'> {
  return {
    headline: 'Know what is on your credit reports',
    intro: `${orgName} helps you read your credit reports, find information you believe is inaccurate, and dispute it in writing with the credit bureaus.`,
    services: [
      { title: 'Credit report review', text: 'We go through your reports from the three bureaus with you and explain what each entry means.' },
      { title: 'Dispute letters', text: 'We prepare letters for the items you believe are inaccurate. Nothing is sent until you approve it.' },
      { title: 'Response tracking', text: 'We keep track of each bureau response and its dates, and tell you what it says.' },
    ],
    about: `${orgName} is a credit repair organization. We work with you on your own reports and keep you informed at each step. Replace this paragraph with a few sentences about who you are and where you work.`,
    faqs: [
      { q: 'Can you promise a result?', a: 'No. The credit bureaus and the companies that report to them decide the outcome of every dispute. We can promise careful work and clear updates.' },
      { q: 'Can I dispute information myself?', a: 'Yes. You have the right to dispute inaccurate information with the credit bureaus on your own, at no cost.' },
      { q: 'What do you need from me to begin?', a: 'A copy of your credit reports and a short conversation about what you believe is inaccurate.' },
    ],
  };
}

/** Structured data for search engines: only the fields the agency actually provided. */
export function siteLd(site: PublicSite, lang: 'en' | 'es' = 'en') {
  const { brand, content: c, address } = site;
  return {
    '@context': 'https://schema.org',
    '@type': 'ProfessionalService',
    name: brand.name,
    url: abs(sitePath(brand.slug)) + (lang === 'es' ? '?lang=es' : ''),
    ...(c.intro ? { description: c.intro } : {}),
    ...(c.phone ? { telephone: c.phone } : {}),
    ...(c.email ? { email: c.email } : {}),
    ...(c.area ? { areaServed: c.area } : {}),
    ...(address ? { address: { '@type': 'PostalAddress', streetAddress: address } } : {}),
  };
}
