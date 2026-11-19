import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import robots from '@/app/robots';
import sitemap from '@/app/sitemap';
import { ADD_ONS, PLANS, TRIAL_DAYS } from '@/lib/plans';
import { GUIDES, NO_INDEX_PATHS, SITE_NAV, SITE_PAGES, abs, faqLd, guidePath, jsonLdString, pageMeta, siteUrl } from '@/lib/site';

const ROOT = path.resolve(__dirname, '../..');
const APP = path.join(ROOT, 'src/app');
const saved = process.env.APP_URL;
afterEach(() => { if (saved === undefined) delete process.env.APP_URL; else process.env.APP_URL = saved; });

/** Every page.tsx under a directory, as [route, file]. Route groups "(name)" do not appear in the address. */
function pages(dir: string, route = ''): [string, string][] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return pages(full, /^\(.*\)$/.test(name) ? route : `${route}/${name}`);
    return name === 'page.tsx' ? [[route || '/', full] as [string, string]] : [];
  });
}

const marketing = [['/', path.join(APP, 'page.tsx')] as [string, string], ...pages(path.join(APP, '(marketing)'))];

describe('proposed plans', () => {
  it('rise together in price, seats, clients and AI credits, with exactly one highlighted', () => {
    for (let i = 1; i < PLANS.length; i++) {
      const [a, b] = [PLANS[i - 1]!, PLANS[i]!];
      for (const k of ['priceMonthly', 'seats', 'activeClients', 'aiCredits'] as const) expect(b[k], `${b.name} ${k}`).toBeGreaterThan(a[k]);
    }
    expect(PLANS.filter((p) => p.highlight)).toHaveLength(1);
    expect(new Set(PLANS.map((p) => p.key)).size).toBe(PLANS.length);
    for (const v of [ADD_ONS.seatMonthly, ADD_ONS.clientBlock.priceMonthly, ADD_ONS.creditTopUp.price, ADD_ONS.creditTopUp.credits]) expect(v).toBeGreaterThan(0);
  });

  it('advertises the trial length the app really gives a new workspace', () => {
    const service = readFileSync(path.join(ROOT, 'src/lib/auth/service.ts'), 'utf8');
    expect(service).toContain(`interval '${TRIAL_DAYS} days'`);
  });
});

describe('site address', () => {
  it('uses the origin of APP_URL and falls back to localhost when it is missing or malformed', () => {
    process.env.APP_URL = 'https://example.test/some/path/';
    expect(siteUrl()).toBe('https://example.test');
    expect(abs('/')).toBe('https://example.test');
    expect(abs('/pricing')).toBe('https://example.test/pricing');
    process.env.APP_URL = 'not a url';
    expect(siteUrl()).toBe('http://localhost:3000');
    delete process.env.APP_URL;
    expect(siteUrl()).toBe('http://localhost:3000');
  });
});

describe('sitemap and robots', () => {
  it('lists exactly the public marketing pages that exist', () => {
    expect(SITE_PAGES.map((p) => p.path).sort()).toEqual(marketing.map(([r]) => r).sort());
    process.env.APP_URL = 'https://example.test';
    const urls = sitemap().map((e) => e.url);
    expect(urls).toContain('https://example.test');
    expect(urls).toContain('https://example.test/pricing');
    expect(new Set(urls).size).toBe(urls.length);
  });

  it('has a page for every guide and every navigation link', () => {
    const routes = new Set(marketing.map(([r]) => r));
    for (const g of GUIDES) expect(routes.has(guidePath(g.slug)), g.slug).toBe(true);
    for (const n of SITE_NAV) expect(routes.has(n.href), n.href).toBe(true);
  });

  it('keeps private areas out of search and never lists them in the sitemap', () => {
    process.env.APP_URL = 'https://example.test';
    const r = robots();
    const rule = Array.isArray(r.rules) ? r.rules[0]! : r.rules;
    expect(rule.disallow).toEqual(expect.arrayContaining(['/app', '/portal', '/api/']));
    expect(r.sitemap).toEqual(['https://example.test/sitemap.xml', 'https://example.test/a/sitemap.xml']);
    for (const p of SITE_PAGES) for (const blocked of NO_INDEX_PATHS) expect(p.path.startsWith(blocked), `${p.path} vs ${blocked}`).toBe(false);
  });
});

describe('page metadata and structured data', () => {
  it('gives each page an absolute canonical address and matching Open Graph address', () => {
    process.env.APP_URL = 'https://example.test';
    const m = pageMeta({ title: 'T', description: 'D', path: '/features' });
    expect(m.alternates?.canonical).toBe('https://example.test/features');
    expect(m.openGraph?.url).toBe('https://example.test/features');
    expect(m.title).toEqual({ absolute: 'T' });
  });

  it('cannot break out of its script tag', () => {
    const s = jsonLdString(faqLd([{ q: 'a </script><script>alert(1)</script>', a: 'b' }]));
    expect(s).not.toContain('<');
    expect(JSON.parse(s).mainEntity[0].name).toBe('a </script><script>alert(1)</script>');
  });

  it('every marketing page sets its own metadata', () => {
    for (const [route, file] of marketing) expect(readFileSync(file, 'utf8'), route).toMatch(/export const generateMetadata\b/);
  });
});

describe('marketing copy rules', () => {
  const files = [...marketing.map(([, f]) => f), path.join(ROOT, 'src/components/marketing-site.tsx')];
  const text = files.map((f) => readFileSync(f, 'utf8')).join('\n');

  it('names the product only through src/lib/product.ts', () => {
    expect(text).not.toMatch(/DisputeOS/);
  });

  it('carries no social proof, ratings or income claims', () => {
    for (const banned of [/trusted by/i, /testimonial/i, /\bstars?\b/i, /aggregateRating/i, /customers? love/i, /six[- ]figure/i, /\bincome\b(?!, bank)/i, /#1\b/, /\bbest credit repair\b/i])
      expect(text, String(banned)).not.toMatch(banned);
  });

  it('never states a guarantee or a promised result as something on offer', () => {
    // Each of these words may appear only where the copy says the product or the law forbids it.
    // The one bare phrase is an entry in the home page's "will never do" list.
    const allowed = /never|\bnot\b|\bno\b|cannot|without|prohibit|reject|blocked|\bbars?\b|remove anything|any guarantees of performance|^\s*'Promise a score increase or guarantee a deletion',$/i;
    for (const line of text.split('\n')) {
      if (/guarantee|point increase|score increase|boost|deleted? in \d+/i.test(line)) expect(line, line.trim().slice(0, 120)).toMatch(allowed);
    }
  });
});
