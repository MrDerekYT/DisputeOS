import { afterAll, describe, expect, it } from 'vitest';
import { EMPTY_SITE, parseSite, publicSiteBySlug, publishedSiteSlugs, saveSite, unpublishSite, type SiteContent } from '@/lib/agency-site';
import { signUp } from '@/lib/auth/service';
import { submitLead } from '@/lib/leads';
import { withTenant } from '@/lib/db';
import { addMember, closePool, makeOrg, PASSWORD, testIp, uniq, withSystem, type TestOrg } from './helpers';

afterAll(closePool);

type Agency = TestOrg & { slug: string; name: string };
async function agency(label: string): Promise<Agency> {
  const o = await makeOrg(label);
  const r = (await withSystem((db) => db.row<{ slug: string; name: string }>('select slug, name from public.organizations where id = $1', [o.orgId])))!;
  return { ...o, ...r };
}
const content = (over: Partial<SiteContent> = {}): SiteContent => ({
  ...EMPTY_SITE, published: true, headline: 'Credit report help in Austin', intro: 'We review your reports with you.',
  services: [{ title: 'Report review', text: 'We explain each entry.' }], faqs: [{ q: 'Can you promise a result?', a: 'No.' }], phone: '512-555-0100', ...over,
});
const save = (a: Agency, c: SiteContent, userId = a.ownerId, orgId = a.orgId) => withTenant(userId, (db) => saveSite(db, orgId, c));
const stored = (orgId: string) => withSystem((db) => db.row<{ settings: Record<string, unknown> }>('select settings from public.organizations where id = $1', [orgId])).then((r) => parseSite(r!.settings));

describe('agency website', () => {
  it('a published site loads its own content, by its own slug only', async () => {
    const [a, b] = [await agency('SiteA'), await agency('SiteB')];
    await withSystem((db) => db.run("update public.organizations set settings = settings || jsonb_build_object('brand_color', '#0f766e', 'lead_mailing_address', '12 Main St, Austin, TX 78701') where id = $1", [a.orgId]));
    await save(a, content());
    await save(b, content({ headline: 'Second agency', phone: '' }));

    const site = (await publicSiteBySlug(a.slug))!;
    expect(site.brand).toEqual({ name: a.name, slug: a.slug, color: '#0f766e' });
    expect(site.content).toMatchObject({ headline: 'Credit report help in Austin', phone: '512-555-0100' });
    expect(site.address).toBe('12 Main St, Austin, TX 78701');
    const other = (await publicSiteBySlug(b.slug))!;
    expect(other.brand.name).toBe(b.name);
    expect(other.content.headline).toBe('Second agency');
    expect(other.address).toBe('');
    // Saving the site keeps the workspace's other settings.
    expect((await withSystem((db) => db.row<{ r: number }>("select (settings->>'retention_days')::int as r from public.organizations where id = $1", [a.orgId])))!.r).toBe(2555);
    const listed = await publishedSiteSlugs();
    expect(listed).toEqual(expect.arrayContaining([a.slug, b.slug]));
  });

  it('an unpublished site returns nothing and is not listed for the sitemap', async () => {
    const a = await agency('SiteDraft');
    expect(await publicSiteBySlug(a.slug)).toBeNull(); // never edited
    await save(a, content({ published: false }));
    expect(await publicSiteBySlug(a.slug)).toBeNull();
    expect(await publishedSiteSlugs()).not.toContain(a.slug);
    await save(a, content());
    expect((await publicSiteBySlug(a.slug))!.content.published).toBe(true);
    await save(a, content({ published: false }));
    expect(await publicSiteBySlug(a.slug)).toBeNull();
    expect(await publishedSiteSlugs()).not.toContain(a.slug);
    for (const bad of ['', 'no-such-agency-zz', '../etc', 'A B', null, undefined]) expect(await publicSiteBySlug(bad)).toBeNull();
  });

  it('a suspended agency and a personal workspace never have a site, even with published content stored', async () => {
    const a = await agency('SiteGone');
    await save(a, content());
    await withSystem((db) => db.run("update public.organizations set status = 'suspended' where id = $1", [a.orgId]));
    expect(await publicSiteBySlug(a.slug)).toBeNull();
    expect(await publishedSiteSlugs()).not.toContain(a.slug);

    const r = await signUp({ email: `solo-${uniq()}@test.dev`, password: PASSWORD, fullName: 'Solo Person', orgName: `Solo ${uniq()}`, mode: 'personal' }, { ip: testIp() });
    if (!r.ok) throw new Error(r.error);
    await expect(withTenant(r.userId, (db) => saveSite(db, r.orgId, content()))).rejects.toThrow(/no website/);
    const slug = (await withSystem((db) => db.row<{ slug: string }>("update public.organizations set settings = settings || $2::jsonb where id = $1 returning slug", [r.orgId, JSON.stringify({ website: content() })])))!.slug;
    expect(await publicSiteBySlug(slug)).toBeNull();
    expect(await publishedSiteSlugs()).not.toContain(slug);
  });

  it('one agency cannot edit another agency’s site, and only an owner or admin can edit their own', async () => {
    const [a, b] = [await agency('SiteMine'), await agency('SiteTheirs')];
    await save(b, content({ headline: 'Theirs' }));
    // A's owner, acting on B's workspace: row-level security matches no row, so nothing changes.
    await expect(save(a, content({ headline: 'Hijacked' }), a.ownerId, b.orgId)).rejects.toThrow(/no website/);
    expect((await stored(b.orgId)).headline).toBe('Theirs');
    expect((await publicSiteBySlug(b.slug))!.content.headline).toBe('Theirs');

    const specialist = await addMember(a.orgId, 'specialist');
    await expect(save(a, content(), specialist.id)).rejects.toThrow(/no website/);
    expect(await publicSiteBySlug(a.slug)).toBeNull();
    const admin = await addMember(a.orgId, 'admin');
    await save(a, content({ headline: 'Mine' }), admin.id);
    expect((await publicSiteBySlug(a.slug))!.content.headline).toBe('Mine');
  });

  it('refuses prohibited claims at the point of saving, so they are never stored', async () => {
    const a = await agency('SiteClaims');
    await expect(save(a, content({ headline: 'We guarantee a higher score' }))).rejects.toThrow(/Headline/);
    await expect(save(a, content({ about: 'Eliminamos todas sus deudas negativas.' }))).rejects.toThrow(/About/);
    expect(await stored(a.orgId)).toEqual(EMPTY_SITE);
  });

  it('unpublishing always works and never rewrites the saved text, even when that text would no longer pass a check', async () => {
    const [a, b] = [await agency('SiteOff'), await agency('SiteOffOther')];
    await save(b, content());
    // Text that an older rule set let through, and a field longer than today's limit: saving either is refused now.
    const old = { ...content(), about: 'We guarantee results. ' + 'x'.repeat(2000) };
    await withSystem((db) => db.run("update public.organizations set settings = settings || $2::jsonb where id = $1", [a.orgId, JSON.stringify({ website: old })]));
    await expect(save(a, { ...content(), about: 'We guarantee results.' })).rejects.toThrow(/About/);
    const raw = () => withSystem((db) => db.row<{ w: Record<string, unknown> }>("select settings->'website' as w from public.organizations where id = $1", [a.orgId])).then((r) => r!.w);
    expect((await raw()).published).toBe(true);
    // Another agency's owner cannot take it down; its own owner can.
    await withTenant(b.ownerId, (db) => unpublishSite(db, a.orgId));
    expect((await raw()).published).toBe(true);
    await withTenant(a.ownerId, (db) => unpublishSite(db, a.orgId));
    expect(await raw()).toEqual({ ...old, published: false });
    expect(await publishedSiteSlugs()).not.toContain(a.slug);
    expect((await publicSiteBySlug(b.slug))!.content.published).toBe(true);
    // A workspace that never saved a site has nothing to switch off, and gains no website key.
    const c = await agency('SiteNever');
    await withTenant(c.ownerId, (db) => unpublishSite(db, c.orgId));
    expect((await withSystem((db) => db.row<{ has: boolean }>("select settings ? 'website' as has from public.organizations where id = $1", [c.orgId])))!.has).toBe(false);
  });

  it('will not publish under a business name that is itself a prohibited claim, but still saves a draft', async () => {
    const a = await agency('SiteName');
    await withSystem((db) => db.run("update public.organizations set name = 'Guaranteed 800 Score Credit Repair' where id = $1", [a.orgId]));
    await expect(save(a, content())).rejects.toThrow(/business name.*Guaranteed 800 Score Credit Repair.*Settings/);
    expect(await publicSiteBySlug(a.slug)).toBeNull();
    await save(a, content({ published: false }));
    expect((await stored(a.orgId)).headline).toBe('Credit report help in Austin');
    await withSystem((db) => db.run("update public.organizations set name = 'Northside Credit Services' where id = $1", [a.orgId]));
    await save(a, content());
    expect((await publicSiteBySlug(a.slug))!.brand.name).toBe('Northside Credit Services');
  });

  it('an enquiry sent from the site is recorded with the source "website"', async () => {
    const a = await agency('SiteLead');
    const email = `site-lead-${uniq()}@example.test`;
    expect(await submitLead(a.slug, { fullName: 'Pat Visitor', email, language: 'es', consent: true }, { ip: testIp(), src: 'website' })).toEqual({ ok: true });
    const c = (await withSystem((db) => db.row<{ source: string; status: string }>('select source, status from public.clients where org_id = $1 and email = $2', [a.orgId, email])))!;
    expect(c).toEqual({ source: 'website', status: 'lead' });
  });
});
