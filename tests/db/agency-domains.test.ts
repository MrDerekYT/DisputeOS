import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { agencySlugForHost, clearHostCache, connectDomain, disconnectDomain, domainForOrg, domainRowForHost, refreshDomain, verifiedOrigin } from '@/lib/agency-domains';
import { EMPTY_SITE, publicSiteBySlug, publishedSiteSlugs, saveSite, siteHome } from '@/lib/agency-site';
import { withTenant } from '@/lib/db';
import { resetEnvCache } from '@/lib/env';
import { integrationStatus } from '@/lib/integrations';
import { addMember, addPortalClient, closePool, makeOrg, uniq, withSystem, type TestOrg } from './helpers';

afterAll(closePool);
afterEach(() => { for (const k of ['VERCEL_API_TOKEN', 'VERCEL_PROJECT_ID', 'VERCEL_TEAM_ID']) delete process.env[k]; resetEnvCache(); clearHostCache(); });

type Agency = TestOrg & { slug: string };
async function agency(label: string): Promise<Agency> {
  const o = await makeOrg(label);
  const r = (await withSystem((db) => db.row<{ slug: string }>('select slug from public.organizations where id = $1', [o.orgId])))!;
  return { ...o, ...r };
}
const name = (sub = 'www') => `${sub}.agency-${uniq()}.com`;
/** What the operator's script does once its check passed (scripts/verify-domain.mjs). */
const operatorVerifies = async (domain: string) => { await withSystem((db) => db.run("update public.agency_domains set status = 'verified', verified_at = now() where domain = $1", [domain])); clearHostCache(); };
const useVercel = () => { process.env.VERCEL_API_TOKEN = 'tok_test'; process.env.VERCEL_PROJECT_ID = 'prj_1'; resetEnvCache(); };

/** A stand-in for the Vercel API: `state` is what the provider would answer for the domain. No network. */
function vercel(state: { onProject?: boolean; verified?: boolean; misconfigured?: boolean; down?: boolean; challenge?: boolean }) {
  const calls: string[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    const method = init?.method ?? 'GET';
    calls.push(`${method} ${path}`);
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
    if (state.down) throw new TypeError('fetch failed');
    const domain = decodeURIComponent(path.split('/domains/')[1]?.split('/')[0] ?? '');
    const pd = { name: domain, apexName: domain.split('.').slice(-2).join('.'), verified: state.verified === true,
      ...(state.challenge ? { verification: [{ type: 'TXT', domain: `_vercel.${domain.split('.').slice(-2).join('.')}`, value: 'vc-domain-verify=abc', reason: 'pending_domain_verification' }] } : {}) };
    if (method === 'POST' && path === '/v10/projects/prj_1/domains') {
      if (state.onProject) return json({ error: { message: 'already in use' } }, 400);
      state.onProject = true;
      return json(pd);
    }
    if (path.startsWith('/v6/domains/')) return json({ misconfigured: state.misconfigured !== false, recommendedIPv4: [{ rank: 1, value: ['216.198.79.1'] }], recommendedCNAME: [{ rank: 1, value: 'abc.vercel-dns-017.com' }] });
    if (method === 'DELETE') { state.onProject = false; return json({}); }
    if (path.endsWith('/verify')) return state.verified ? json(pd) : json({ error: { message: 'not verified' } }, 400);
    return state.onProject ? json(pd) : json({ error: { message: 'not found' } }, 404);
  }) as typeof fetch;
  return { f, calls };
}

const ageClaim = (domain: string) => withSystem((db) => db.run("update public.agency_domains set created_at = now() - interval '25 hours' where domain = $1", [domain]));

describe('agency custom domains', () => {
  it('an old claim that never verified does not lock the name: the next workspace takes it over, at the provider too', async () => {
    const [squatter, owner] = [await agency('Squat'), await agency('RealOwner')];
    const domain = name();
    // Without the provider: the stale pending row gives way, on either form of the name.
    await connectDomain(squatter.orgId, domain);
    await ageClaim(domain);
    const bare = domain.replace(/^www\./, '');
    expect(await connectDomain(owner.orgId, bare)).toMatchObject({ domain: bare, status: 'pending' });
    expect(await withTenant(squatter.ownerId, (db) => domainForOrg(db, squatter.orgId))).toBeNull();
    await disconnectDomain(owner.orgId);

    // With the provider: the stale claim is re-checked, removed from the hosting project, and the new one added.
    useVercel();
    const v = vercel({ verified: false });
    expect((await connectDomain(squatter.orgId, domain, v.f)).details.added).toBe(true);
    await ageClaim(domain);
    v.calls.length = 0;
    expect(await connectDomain(owner.orgId, domain, v.f)).toMatchObject({ domain, status: 'pending', details: { added: true } });
    expect(v.calls.filter((c) => c.startsWith('DELETE'))).toHaveLength(1);
    expect(v.calls.filter((c) => c.startsWith('POST') && !c.endsWith('/verify'))).toHaveLength(1);
    expect(await withTenant(squatter.ownerId, (db) => domainForOrg(db, squatter.orgId))).toBeNull();
  });

  it('an old claim whose DNS has become good is verified for its holder instead of being handed to a newcomer', async () => {
    const [first, second] = [await agency('FirstClaim'), await agency('SecondClaim')];
    const domain = name();
    useVercel();
    const state = { verified: false, misconfigured: true } as Parameters<typeof vercel>[0];
    const v = vercel(state);
    await connectDomain(first.orgId, domain, v.f);
    await ageClaim(domain);
    state.verified = true; state.misconfigured = false; // the holder's DNS records went live, but nobody pressed "Check now"
    await expect(connectDomain(second.orgId, domain, v.f)).rejects.toThrow('already connected to another workspace');
    expect(await agencySlugForHost(domain)).toBe(first.slug);
    expect(v.calls.filter((c) => c.startsWith('DELETE'))).toHaveLength(0);
  });

  it('saves a domain as pending when the hosting provider is not connected, and never routes it until verified', async () => {
    const a = await agency('DomA');
    const domain = name();
    const d = await connectDomain(a.orgId, `https://${domain.toUpperCase()}/`);
    expect(d).toMatchObject({ domain, status: 'pending', verifiedAt: null, details: { source: 'manual', records: [{ type: 'CNAME', name: 'www', value: 'cname.vercel-dns.com' }] } });
    expect(await agencySlugForHost(domain)).toBeNull();
    expect(await verifiedOrigin(a.orgId)).toBeNull();
    // "Check now" has nothing to check by itself: the row stays pending.
    expect((await refreshDomain(a.orgId)).status).toBe('pending');
    expect(await agencySlugForHost(domain)).toBeNull();
    // The operator's check can find the pending row for that host, on either form of the name.
    expect((await domainRowForHost(`${domain}:443`))?.domain).toBe(domain);
    expect(await domainRowForHost('localhost:3000')).toBeNull();
    expect(integrationStatus().find((i) => i.key === 'custom_domain')).toMatchObject({ status: 'manual' });

    await operatorVerifies(domain);
    expect(await agencySlugForHost(domain)).toBe(a.slug);
    expect(await agencySlugForHost(domain.replace(/^www\./, '').toUpperCase() + ':443')).toBe(a.slug);
    expect(await verifiedOrigin(a.orgId)).toBe(`https://${domain}`);
  });

  it('a host resolves only to the agency that owns it', async () => {
    const [a, b] = [await agency('DomOwnA'), await agency('DomOwnB')];
    const [da, db] = [name(), name('clients')];
    await connectDomain(a.orgId, da);
    await connectDomain(b.orgId, db);
    await operatorVerifies(da);
    await operatorVerifies(db);
    expect(await agencySlugForHost(da)).toBe(a.slug);
    expect(await agencySlugForHost(db)).toBe(b.slug);
    expect(await agencySlugForHost(`other.${da}`)).toBeNull();
    expect(await agencySlugForHost(name())).toBeNull();
    // The platform's own hosts never resolve to an agency.
    for (const h of ['localhost:3000', '127.0.0.1', 'disputeos-mu.vercel.app', null]) expect(await agencySlugForHost(h)).toBeNull();
    // A suspended workspace's domain stops routing.
    await withSystem((x) => x.run("update public.organizations set status = 'suspended' where id = $1", [b.orgId]));
    clearHostCache();
    expect(await agencySlugForHost(db)).toBeNull();
  });

  it('one agency cannot claim a domain, or the www twin of a domain, that another agency has', async () => {
    const [a, b] = [await agency('ClaimA'), await agency('ClaimB')];
    const domain = name();
    await connectDomain(a.orgId, domain);
    // A claim made in the last day is protected while its owner creates the DNS records; a verified one always is.
    await expect(connectDomain(b.orgId, domain)).rejects.toThrow('started connecting that domain in the last day');
    await expect(connectDomain(b.orgId, domain.replace(/^www\./, ''))).rejects.toThrow('started connecting that domain in the last day');
    await operatorVerifies(domain);
    await withSystem((db) => db.run("update public.agency_domains set created_at = now() - interval '30 days' where domain = $1", [domain]));
    await expect(connectDomain(b.orgId, domain)).rejects.toThrow('already connected to another workspace');
    await expect(connectDomain(b.orgId, domain.replace(/^www\./, ''))).rejects.toThrow('already connected to another workspace');
    await expect(connectDomain(a.orgId, name())).rejects.toThrow('already has a domain');
    expect(await withSystem((db) => db.rows('select 1 from public.agency_domains where org_id = $1', [b.orgId]))).toHaveLength(0);
    // Not even the database accepts the twin, whoever writes it.
    await expect(withSystem((db) => db.run('insert into public.agency_domains (org_id, domain) values ($1, $2)', [b.orgId, domain.replace(/^www\./, '')]))).rejects.toMatchObject({ code: '23505' });
    // Invalid names and personal workspaces are refused before anything is written.
    await expect(connectDomain(b.orgId, '127.0.0.1')).rejects.toThrow('not a valid domain');
    await expect(connectDomain(b.orgId, 'disputeos-mu.vercel.app')).rejects.toThrow('hosting provider');
    await withSystem((db) => db.run("update public.organizations set mode = 'personal' where id = $1", [b.orgId]));
    await expect(connectDomain(b.orgId, name())).rejects.toThrow('agency workspaces');
    // After the owner removes it, the name is free again.
    expect(await disconnectDomain(a.orgId)).toEqual({ domain, leftAtProvider: true });
    expect(await disconnectDomain(a.orgId)).toBeNull();
  });

  it('row-level security: staff read only their own workspace’s domain, and nobody writes it from a tenant request', async () => {
    const [a, b] = [await agency('RlsA'), await agency('RlsB')];
    const [da, db] = [name(), name()];
    await connectDomain(a.orgId, da);
    await connectDomain(b.orgId, db);
    const specialist = await addMember(a.orgId, 'specialist');
    const client = await addPortalClient(a.orgId);

    expect((await withTenant(a.ownerId, (x) => domainForOrg(x, a.orgId)))?.domain).toBe(da);
    expect((await withTenant(specialist.id, (x) => domainForOrg(x, a.orgId)))?.domain).toBe(da);
    expect(await withTenant(a.ownerId, (x) => domainForOrg(x, b.orgId))).toBeNull();
    expect(await withTenant(a.ownerId, (x) => x.rows('select domain from public.agency_domains'))).toEqual([{ domain: da }]);
    expect(await withTenant(client.userId, (x) => x.rows('select domain from public.agency_domains'))).toEqual([]);

    // Even the owner cannot mark the domain verified, replace it, add one or delete one directly.
    await expect(withTenant(a.ownerId, (x) => x.run("update public.agency_domains set status = 'verified', verified_at = now() where org_id = $1", [a.orgId]))).rejects.toMatchObject({ code: '42501' });
    await expect(withTenant(a.ownerId, (x) => x.run('update public.agency_domains set domain = $2 where org_id = $1', [a.orgId, name()]))).rejects.toMatchObject({ code: '42501' });
    await expect(withTenant(a.ownerId, (x) => x.run('delete from public.agency_domains where org_id = $1', [a.orgId]))).rejects.toMatchObject({ code: '42501' });
    await expect(withTenant(specialist.id, (x) => x.run('insert into public.agency_domains (org_id, domain) values ($1, $2)', [a.orgId, name()]))).rejects.toMatchObject({ code: '42501' });
    expect(await agencySlugForHost(da)).toBeNull();
    // The table itself refuses "verified" without its date, and a name that is not a lower-case hostname.
    await expect(withSystem((x) => x.run("update public.agency_domains set status = 'verified' where org_id = $1", [a.orgId]))).rejects.toMatchObject({ code: '23514' });
    await expect(withSystem((x) => x.run("update public.agency_domains set domain = 'WWW.Example.com' where org_id = $1", [a.orgId]))).rejects.toMatchObject({ code: '23514' });
  });

  it('with the hosting provider connected: adds the domain, shows what DNS it needs, and verifies only on the provider’s word', async () => {
    useVercel();
    expect(integrationStatus().find((i) => i.key === 'custom_domain')).toMatchObject({ status: 'active', verified: false });
    const a = await agency('VercelA');
    const domain = name();
    const state = { verified: false, misconfigured: true, challenge: true } as Parameters<typeof vercel>[0];
    const v = vercel(state);
    const d = await connectDomain(a.orgId, domain, v.f);
    expect(v.calls[0]).toBe('POST /v10/projects/prj_1/domains');
    expect(d).toMatchObject({ status: 'pending', details: { source: 'vercel', added: true, records: [
      { type: 'CNAME', name: 'www', value: 'abc.vercel-dns-017.com' }, { type: 'TXT', name: '_vercel', value: 'vc-domain-verify=abc' }] } });
    expect(await agencySlugForHost(domain)).toBeNull();

    // Ownership proven but DNS still wrong: not verified.
    Object.assign(state, { verified: true, challenge: false });
    expect((await refreshDomain(a.orgId, v.f)).status).toBe('pending');
    // "Check now" does not add the domain a second time.
    expect(v.calls.filter((c) => c.startsWith('POST /v10'))).toHaveLength(1);

    state.misconfigured = false;
    const ok = await refreshDomain(a.orgId, v.f);
    expect(ok).toMatchObject({ status: 'verified', details: { records: [{ type: 'CNAME', name: 'www' }] } });
    expect(ok.verifiedAt).not.toBeNull();
    expect(await agencySlugForHost(domain)).toBe(a.slug);

    // A provider outage changes nothing; the provider saying DNS no longer points here takes the domain out of routing.
    expect(await refreshDomain(a.orgId, vercel({ down: true }).f)).toMatchObject({ status: 'verified', details: { error: expect.stringContaining('could not be reached') } });
    state.misconfigured = true;
    expect((await refreshDomain(a.orgId, v.f)).status).toBe('pending');
    expect(await agencySlugForHost(domain)).toBeNull();

    // Removing it removes it from the hosting project; if the provider refuses, the row stays.
    await expect(disconnectDomain(a.orgId, vercel({ down: true }).f)).rejects.toThrow('nothing was changed');
    expect((await withTenant(a.ownerId, (x) => domainForOrg(x, a.orgId)))?.domain).toBe(domain);
    expect(await disconnectDomain(a.orgId, v.f)).toEqual({ domain, leftAtProvider: false });
    expect(v.calls.at(-1)).toBe(`DELETE /v9/projects/prj_1/domains/${domain}`);
    expect(state.onProject).toBe(false);
  });

  it('a provider failure or a domain already set up by hand is shown as failed, never as connected', async () => {
    useVercel();
    const a = await agency('VercelFail');
    const domain = name();
    const down = await connectDomain(a.orgId, domain, vercel({ down: true }).f);
    expect(down).toMatchObject({ status: 'failed', details: { added: false, error: expect.stringContaining('could not be reached') } });
    // Already on the project, but not added by this app: not this agency's to take, and removing it here leaves the project alone.
    const byHand = vercel({ onProject: true, verified: true, misconfigured: false });
    expect(await refreshDomain(a.orgId, byHand.f)).toMatchObject({ status: 'failed', details: { added: false, error: expect.stringContaining('already set up') } });
    expect(await agencySlugForHost(domain)).toBeNull();
    expect(await disconnectDomain(a.orgId, byHand.f)).toEqual({ domain, leftAtProvider: false });
    expect(byHand.calls.some((c) => c.startsWith('DELETE'))).toBe(false);
  });

  it('a site with a verified domain uses it as its canonical address and leaves the platform sitemap', async () => {
    const a = await agency('CanonA');
    await withTenant(a.ownerId, (db) => saveSite(db, a.orgId, { ...EMPTY_SITE, published: true, headline: 'Credit report help' }));
    const domain = name();
    await connectDomain(a.orgId, domain);
    const before = (await publicSiteBySlug(a.slug))!;
    expect(before.domain).toBeNull();
    expect(siteHome(before)).toBe(`http://localhost:3000/a/${a.slug}`);
    expect(await publishedSiteSlugs()).toContain(a.slug);

    await operatorVerifies(domain);
    const after = (await publicSiteBySlug(a.slug))!; // the platform address keeps working
    expect(after.domain).toBe(domain);
    expect(siteHome(after)).toBe(`https://${domain}`);
    expect(await publishedSiteSlugs()).not.toContain(a.slug);
  });
});
