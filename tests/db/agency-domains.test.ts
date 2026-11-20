import { execFileSync } from 'node:child_process';
import { Resolver } from 'node:dns/promises';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { agencySlugForHost, clearHostCache, connectDomain, disconnectDomain, domainForOrg, domainRowForHost, ownershipValue, refreshDomain, verifiedOrigin, type TxtLookup } from '@/lib/agency-domains';
import { EMPTY_SITE, publicSiteBySlug, publishedSiteSlugs, saveSite, siteHome } from '@/lib/agency-site';
import { withTenant } from '@/lib/db';
import { ownershipHost } from '@/lib/domain-rules';
import { getEnv, resetEnvCache } from '@/lib/env';
import { integrationStatus } from '@/lib/integrations';
import { addMember, addPortalClient, closePool, makeOrg, uniq, withSystem, type TestOrg } from './helpers';

/**
 * A stand-in for DNS: the TXT records that exist, by name. `connect` and `check` below use it. The two places that run
 * the app's own lookup, or the operator's script, stand in for the resolver itself. No test touches the network.
 */
const dns = new Map<string, string[]>();
let dnsFails = '';
const txt: TxtLookup = async (host) => {
  if (dnsFails) throw Object.assign(new Error(`queryTxt ${dnsFails} ${host}`), { code: dnsFails });
  return dns.get(host) ?? [];
};
/** The agency creates the TXT record its Website page shows for this domain. */
const publish = (orgId: string, domain: string) => { dns.set(ownershipHost(domain), [ownershipValue(orgId, domain)]); };
const connect = (orgId: string, input: string, f?: typeof fetch) => connectDomain(orgId, input, f, txt);
const check = (orgId: string, f?: typeof fetch) => refreshDomain(orgId, f, txt);

const RESTORED = ['APP_URL', 'PII_ENCRYPTION_KEY', 'PII_ENCRYPTION_KEY_PREVIOUS'] as const;
const envBefore = Object.fromEntries(RESTORED.map((k) => [k, process.env[k]]));
afterAll(closePool);
afterEach(() => {
  for (const k of ['VERCEL_API_TOKEN', 'VERCEL_PROJECT_ID', 'VERCEL_TEAM_ID']) delete process.env[k];
  for (const k of RESTORED) { if (envBefore[k] === undefined) delete process.env[k]; else process.env[k] = envBefore[k]; }
  resetEnvCache(); clearHostCache(); dns.clear(); dnsFails = '';
});

type Agency = TestOrg & { slug: string; name: string };
async function agency(label: string): Promise<Agency> {
  const o = await makeOrg(label);
  const r = (await withSystem((db) => db.row<{ slug: string; name: string }>('select slug, name from public.organizations where id = $1', [o.orgId])))!;
  return { ...o, ...r };
}
const name = (sub = 'www') => `${sub}.agency-${uniq()}.com`;
/** What the operator's script does once its checks passed (scripts/verify-domain.mjs; the script itself is run further down). */
const operatorVerifies = async (domain: string) => { await withSystem((db) => db.run("update public.agency_domains set status = 'verified', verified_at = now() where domain = $1", [domain])); clearHostCache(); };
const useVercel = () => { process.env.VERCEL_API_TOKEN = 'tok_test'; process.env.VERCEL_PROJECT_ID = 'prj_1'; resetEnvCache(); };
const holder = (orgId: string, ownerId: string) => withTenant(ownerId, (db) => domainForOrg(db, orgId));

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
    await connect(squatter.orgId, domain);
    await ageClaim(domain);
    const bare = domain.replace(/^www\./, '');
    expect(await connect(owner.orgId, bare)).toMatchObject({ domain: bare, status: 'pending' });
    expect(await holder(squatter.orgId, squatter.ownerId)).toBeNull();
    await disconnectDomain(owner.orgId);

    // With the provider: the stale claim is re-checked, removed from the hosting project, and the new one added.
    useVercel();
    const v = vercel({ verified: false });
    expect((await connect(squatter.orgId, domain, v.f)).details.added).toBe(true);
    await ageClaim(domain);
    v.calls.length = 0;
    expect(await connect(owner.orgId, domain, v.f)).toMatchObject({ domain, status: 'pending', details: { added: true } });
    expect(v.calls.filter((c) => c.startsWith('DELETE'))).toHaveLength(1);
    expect(v.calls.filter((c) => c.startsWith('POST') && !c.endsWith('/verify'))).toHaveLength(1);
    expect(await holder(squatter.orgId, squatter.ownerId)).toBeNull();
  });

  it('an old claim whose DNS has become good is verified for its holder instead of being handed to a newcomer', async () => {
    const [first, second] = [await agency('FirstClaim'), await agency('SecondClaim')];
    const domain = name();
    useVercel();
    const state = { verified: false, misconfigured: true } as Parameters<typeof vercel>[0];
    const v = vercel(state);
    await connect(first.orgId, domain, v.f);
    await ageClaim(domain);
    // The holder's DNS records went live, its own TXT record among them, but nobody pressed "Check now".
    state.verified = true; state.misconfigured = false;
    publish(first.orgId, domain);
    await expect(connect(second.orgId, domain, v.f)).rejects.toThrow('already connected to another workspace');
    expect(await agencySlugForHost(domain)).toBe(first.slug);
    expect(v.calls.filter((c) => c.startsWith('DELETE'))).toHaveLength(0);
  });

  it('saves a domain as pending when the hosting provider is not connected, and never routes it until verified', async () => {
    const a = await agency('DomA');
    const domain = name();
    const d = await connect(a.orgId, `https://${domain.toUpperCase()}/`);
    expect(d).toMatchObject({ domain, status: 'pending', verifiedAt: null, details: { source: 'manual', records: [{ type: 'CNAME', name: 'www', value: 'cname.vercel-dns.com' }] } });
    // The page also shows the TXT record that ties the domain to this workspace: the same for the www twin, and for nobody else.
    expect(d.ownership).toEqual({ type: 'TXT', name: '_disputeos', value: ownershipValue(a.orgId, domain) });
    expect(ownershipValue(a.orgId, domain.replace(/^www\./, ''))).toBe(d.ownership.value);
    expect(d.ownership.value).toMatch(/^[\w-]{43}$/);
    expect(ownershipValue((await agency('DomOther')).orgId, domain)).not.toBe(d.ownership.value);
    expect(ownershipValue(a.orgId, name())).not.toBe(d.ownership.value);
    expect(await agencySlugForHost(domain)).toBeNull();
    expect(await verifiedOrigin(a.orgId)).toBeNull();
    // "Check now" has nothing to check by itself: the row stays pending, even with the TXT record in place.
    publish(a.orgId, domain);
    expect((await check(a.orgId)).status).toBe('pending');
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
    await connect(a.orgId, da);
    await connect(b.orgId, db);
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
    await connect(a.orgId, domain);
    // A claim made in the last day is protected while its owner creates the DNS records; a verified one always is.
    await expect(connect(b.orgId, domain)).rejects.toThrow('started connecting that domain in the last day');
    await expect(connect(b.orgId, domain.replace(/^www\./, ''))).rejects.toThrow('started connecting that domain in the last day');
    await operatorVerifies(domain);
    await withSystem((db) => db.run("update public.agency_domains set created_at = now() - interval '30 days' where domain = $1", [domain]));
    await expect(connect(b.orgId, domain)).rejects.toThrow('already connected to another workspace');
    await expect(connect(b.orgId, domain.replace(/^www\./, ''))).rejects.toThrow('already connected to another workspace');
    // Not even with its own TXT record in the DNS: a verified domain is moved only by the workspace that has it.
    publish(b.orgId, domain);
    await expect(connect(b.orgId, domain)).rejects.toThrow('already connected to another workspace');
    await expect(connect(a.orgId, name())).rejects.toThrow('already has a domain');
    expect(await withSystem((db) => db.rows('select 1 from public.agency_domains where org_id = $1', [b.orgId]))).toHaveLength(0);
    // Not even the database accepts the twin, whoever writes it.
    await expect(withSystem((db) => db.run('insert into public.agency_domains (org_id, domain) values ($1, $2)', [b.orgId, domain.replace(/^www\./, '')]))).rejects.toMatchObject({ code: '23505' });
    // Invalid names and personal workspaces are refused before anything is written.
    await expect(connect(b.orgId, '127.0.0.1')).rejects.toThrow('not a valid domain');
    await expect(connect(b.orgId, 'disputeos-mu.vercel.app')).rejects.toThrow('hosting provider');
    await withSystem((db) => db.run("update public.organizations set mode = 'personal' where id = $1", [b.orgId]));
    await expect(connect(b.orgId, name())).rejects.toThrow('agency workspaces');
    // After the owner removes it, the name is free again.
    expect(await disconnectDomain(a.orgId)).toEqual({ domain, leftAtProvider: true });
    expect(await disconnectDomain(a.orgId)).toBeNull();
  });

  it('a claim made in the last day gives way at once to the workspace whose TXT record is in the domain’s DNS', async () => {
    const [squatter, owner] = [await agency('Holds'), await agency('OwnsDns')];
    const domain = name();
    await connect(squatter.orgId, domain);
    // Refused, and told which record would show the domain is its own.
    const refusal = await connect(owner.orgId, domain).then(() => '', (e: Error) => e.message);
    expect(refusal).toContain('Another workspace started connecting that domain in the last day.');
    expect(refusal).toContain(`create a TXT record named ${ownershipHost(domain)} with the value ${ownershipValue(owner.orgId, domain)} where you manage`);
    // Another workspace's record in the DNS does nothing for it; a lookup that fails proves nothing either.
    publish(squatter.orgId, domain);
    await expect(connect(owner.orgId, domain)).rejects.toThrow('started connecting that domain in the last day');
    publish(owner.orgId, domain);
    dnsFails = 'ETIMEOUT';
    await expect(connect(owner.orgId, domain)).rejects.toThrow('DNS could not be read (ETIMEOUT)');
    dnsFails = '';
    // With its own record there, the hold does not stand in its way, on either form of the name.
    expect(await connect(owner.orgId, domain.replace(/^www\./, ''))).toMatchObject({ domain: domain.replace(/^www\./, ''), status: 'pending' });
    expect(await holder(squatter.orgId, squatter.ownerId)).toBeNull();
    // The workspace that lost the name cannot take it back the same way: its record is not there.
    await expect(connect(squatter.orgId, domain)).rejects.toThrow('started connecting that domain in the last day');
    expect((await holder(owner.orgId, owner.ownerId))?.domain).toBe(domain.replace(/^www\./, ''));
  });

  it('row-level security: staff read only their own workspace’s domain, and nobody writes it from a tenant request', async () => {
    const [a, b] = [await agency('RlsA'), await agency('RlsB')];
    const [da, db] = [name(), name()];
    await connect(a.orgId, da);
    await connect(b.orgId, db);
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

  it('with the hosting provider connected: adds the domain, shows what DNS it needs, and verifies only on the provider’s word and the workspace’s own TXT record', async () => {
    useVercel();
    expect(integrationStatus().find((i) => i.key === 'custom_domain')).toMatchObject({ status: 'active', verified: false });
    const [a, other] = [await agency('VercelA'), await agency('VercelOther')];
    const domain = name();
    const state = { verified: false, misconfigured: true, challenge: true } as Parameters<typeof vercel>[0];
    const v = vercel(state);
    const d = await connect(a.orgId, domain, v.f);
    expect(v.calls[0]).toBe('POST /v10/projects/prj_1/domains');
    expect(d).toMatchObject({ status: 'pending', details: { source: 'vercel', added: true, records: [
      { type: 'CNAME', name: 'www', value: 'abc.vercel-dns-017.com' }, { type: 'TXT', name: '_vercel', value: 'vc-domain-verify=abc' }] },
      ownership: { type: 'TXT', name: '_disputeos', value: ownershipValue(a.orgId, domain) } });
    expect(await agencySlugForHost(domain)).toBeNull();

    // The workspace's TXT record is there and the provider accepts the domain, but DNS does not point here yet: not verified.
    publish(a.orgId, domain);
    Object.assign(state, { verified: true, challenge: false });
    expect((await check(a.orgId, v.f)).status).toBe('pending');
    // "Check now" does not add the domain a second time.
    expect(v.calls.filter((c) => c.startsWith('POST /v10'))).toHaveLength(1);

    // The provider says everything is right, which it would say for any workspace holding this name. Without this
    // workspace's TXT record, or with another workspace's in its place, that is not enough.
    state.misconfigured = false;
    dns.clear();
    expect(await check(a.orgId, v.f)).toMatchObject({ status: 'pending', verifiedAt: null });
    publish(other.orgId, domain);
    expect((await check(a.orgId, v.f)).status).toBe('pending');
    expect(await agencySlugForHost(domain)).toBeNull();

    publish(a.orgId, domain);
    const ok = await check(a.orgId, v.f);
    expect(ok).toMatchObject({ status: 'verified', details: { records: [{ type: 'CNAME', name: 'www' }] } });
    expect(ok.verifiedAt).not.toBeNull();
    expect(await agencySlugForHost(domain)).toBe(a.slug);

    // A provider outage changes nothing; the provider saying DNS no longer points here takes the domain out of routing.
    expect(await check(a.orgId, vercel({ down: true }).f)).toMatchObject({ status: 'verified', details: { error: expect.stringContaining('could not be reached') } });
    state.misconfigured = true;
    expect((await check(a.orgId, v.f)).status).toBe('pending');
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
    publish(a.orgId, domain);
    const down = await connect(a.orgId, domain, vercel({ down: true }).f);
    expect(down).toMatchObject({ status: 'failed', details: { added: false, error: expect.stringContaining('could not be reached') } });
    // Already on the project, but not added by this app: not this agency's to take, and removing it here leaves the project alone.
    const byHand = vercel({ onProject: true, verified: true, misconfigured: false });
    expect(await check(a.orgId, byHand.f)).toMatchObject({ status: 'failed', details: { added: false, error: expect.stringContaining('already set up') } });
    expect(await agencySlugForHost(domain)).toBeNull();
    expect(await disconnectDomain(a.orgId, byHand.f)).toEqual({ domain, leftAtProvider: false });
    expect(byHand.calls.some((c) => c.startsWith('DELETE'))).toBe(false);
  });

  it('a site with a verified domain uses it as its canonical address and leaves the platform sitemap', async () => {
    const a = await agency('CanonA');
    await withTenant(a.ownerId, (db) => saveSite(db, a.orgId, { ...EMPTY_SITE, published: true, headline: 'Credit report help' }));
    const domain = name();
    await connect(a.orgId, domain);
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

// The sequences an independent check ran against the earlier code. Each ended with a rival workspace serving the real
// owner's domain, because "the DNS is right" is the same answer whichever workspace holds the row. The provider
// stand-in answers the way that check assumed: a domain nobody else uses is accepted at once (verified), and the DNS
// is right as soon as the name points at the platform.
describe('a domain is verified only for the workspace whose TXT record is in its DNS', () => {
  it('a rival that takes over a stale claim is not verified by the DNS records the real owner creates', async () => {
    const [owner, rival] = [await agency('RealOwner'), await agency('Rival')];
    const domain = name();
    useVercel();
    const state = { verified: true, misconfigured: true } as Parameters<typeof vercel>[0];
    const v = vercel(state);
    // Day 0: the owner connects its domain and is shown the records to create, its own TXT record among them.
    const shown = await connect(owner.orgId, domain, v.f);
    expect(shown).toMatchObject({ status: 'pending', ownership: { type: 'TXT', name: '_disputeos', value: ownershipValue(owner.orgId, domain) } });
    // Day 1: the owner has not created them yet, and a rival connects the same name. The stale claim gives way.
    await ageClaim(domain);
    const taken = await connect(rival.orgId, domain, v.f);
    expect(taken.status).toBe('pending');
    expect(taken.ownership.value).not.toBe(shown.ownership.value);
    expect(await holder(owner.orgId, owner.ownerId)).toBeNull();
    // Day 2: the owner creates the records it was shown. The pointing record is the same for every workspace; the TXT record is its own.
    state.misconfigured = false;
    publish(owner.orgId, domain);
    await expect(check(owner.orgId, v.f)).rejects.toThrow('No domain is connected');
    // The rival presses "Check now". The provider says the DNS is right, and the rival is still not verified.
    expect((await check(rival.orgId, v.f)).status).toBe('pending');
    expect(await agencySlugForHost(domain)).toBeNull();
    // The owner enters its domain again. Its record is in the DNS, so the rival's hold of less than a day does not stop it.
    expect((await connect(owner.orgId, domain, v.f)).status).toBe('verified');
    expect(await agencySlugForHost(domain)).toBe(owner.slug);
    await expect(check(rival.orgId, v.f)).rejects.toThrow('No domain is connected');
    await expect(connect(rival.orgId, domain, v.f)).rejects.toThrow('already connected to another workspace');
    expect(await agencySlugForHost(domain)).toBe(owner.slug);
  });

  it('the owner trying again does not verify the rival that holds the claim', async () => {
    const [owner, rival] = [await agency('RealOwner2'), await agency('Rival2')];
    const domain = name();
    useVercel();
    const state = { verified: true, misconfigured: true } as Parameters<typeof vercel>[0];
    const v = vercel(state);
    await connect(owner.orgId, domain, v.f);
    await ageClaim(domain);
    await connect(rival.orgId, domain, v.f); // the rival takes the stale claim
    await ageClaim(domain);                  // another day passes; the rival does nothing more
    state.misconfigured = false;             // the owner's DNS records go live
    publish(owner.orgId, domain);
    // The rival's claim is re-checked one last time before it is released: the earlier code marked it verified here.
    expect((await connect(owner.orgId, domain, v.f)).status).toBe('verified');
    expect(await agencySlugForHost(domain)).toBe(owner.slug);
    expect(await holder(rival.orgId, rival.ownerId)).toBeNull();
  });

  it('a domain its owner removed is not handed, verified, to the next workspace that types the name', async () => {
    const [owner, rival] = [await agency('OwnerD'), await agency('RivalD')];
    const domain = name();
    useVercel();
    const v = vercel({ verified: true, misconfigured: false }); // the DNS points at the platform throughout
    publish(owner.orgId, domain);
    expect((await connect(owner.orgId, domain, v.f)).status).toBe('verified');
    expect(await agencySlugForHost(domain)).toBe(owner.slug);
    // The owner presses "Remove domain"; its DNS records at the registrar stay as they are.
    expect(await disconnectDomain(owner.orgId, v.f)).toEqual({ domain, leftAtProvider: false });
    // A rival connects the same name one second later.
    expect((await connect(rival.orgId, domain, v.f)).status).toBe('pending');
    expect((await check(rival.orgId, v.f)).status).toBe('pending');
    expect(await agencySlugForHost(domain)).toBeNull();
    // The owner connects it again at once, and is the one verified.
    expect((await connect(owner.orgId, domain, v.f)).status).toBe('verified');
    expect(await agencySlugForHost(domain)).toBe(owner.slug);
  });

  it('a check that was running for one domain never marks the domain the workspace connected meanwhile', async () => {
    const a = await agency('Swap');
    const [own, theirs] = [name(), name()];
    useVercel();
    const v = vercel({ verified: true, misconfigured: false });
    publish(a.orgId, own);
    expect((await connect(a.orgId, own, v.f)).status).toBe('verified');
    // While "Check now" for its own verified domain waits for the provider, the workspace removes that domain and
    // connects one that is not its own, whose DNS points at the platform too.
    let swapped = false;
    const slow = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (!swapped && new URL(String(input)).pathname.startsWith('/v6/domains/')) {
        swapped = true;
        await disconnectDomain(a.orgId, v.f);
        await connect(a.orgId, theirs, v.f);
      }
      return v.f(input, init);
    }) as typeof fetch;
    await expect(check(a.orgId, slow)).rejects.toThrow('removed while it was being checked');
    expect(swapped).toBe(true);
    expect(await holder(a.orgId, a.ownerId)).toMatchObject({ domain: theirs, status: 'pending', verifiedAt: null });
    expect(await agencySlugForHost(theirs)).toBeNull();
  });

  it('a DNS lookup that fails is not evidence either way', async () => {
    useVercel();
    const a = await agency('DnsDown');
    const domain = name();
    const v = vercel({ verified: true, misconfigured: false });
    publish(a.orgId, domain);
    dnsFails = 'ESERVFAIL';
    expect(await connect(a.orgId, domain, v.f)).toMatchObject({ status: 'pending', details: { error: 'The domain’s DNS could not be read (ESERVFAIL). Try again in a few minutes.' } });
    expect(await agencySlugForHost(domain)).toBeNull();
    dnsFails = '';
    const ok = await check(a.orgId, v.f);
    expect(ok.status).toBe('verified');
    expect(ok.details.error).toBeUndefined();
    // Once verified, the record is not asked for again: only the provider's word on where the DNS points takes a site out of routing.
    dnsFails = 'ETIMEOUT';
    dns.clear();
    expect((await check(a.orgId, v.f)).status).toBe('verified');
    expect(await agencySlugForHost(domain)).toBe(a.slug);
  });

  it('the lookup the app makes itself: a record that arrives in pieces is joined, “no such record” is none, and any other failure is not evidence', async () => {
    useVercel();
    const a = await agency('RealLookup');
    const domain = name();
    const v = vercel({ verified: true, misconfigured: false });
    const value = ownershipValue(a.orgId, domain);
    const fails = (code: string) => async () => { throw Object.assign(new Error(`queryTxt ${code}`), { code }); };
    // The resolver itself is stood in for, so the app's own lookup runs (no `txt` is passed) and still nothing touches the network.
    const resolveTxt = vi.spyOn(Resolver.prototype, 'resolveTxt');
    try {
      resolveTxt.mockImplementation(fails('ENOTFOUND'));
      const none = await connectDomain(a.orgId, domain, v.f);
      expect([none.status, none.details.error]).toEqual(['pending', undefined]);
      resolveTxt.mockImplementation(fails('ENODATA'));
      const empty = await refreshDomain(a.orgId, v.f);
      expect([empty.status, empty.details.error]).toEqual(['pending', undefined]);
      resolveTxt.mockImplementation(fails('ESERVFAIL'));
      expect(await refreshDomain(a.orgId, v.f)).toMatchObject({ status: 'pending', details: { error: expect.stringContaining('could not be read (ESERVFAIL)') } });
      // Another record at the same name, and this workspace's value split in two pieces.
      resolveTxt.mockImplementation(async () => [['some-other-service=1'], [value.slice(0, 20), value.slice(20)]]);
      expect((await refreshDomain(a.orgId, v.f)).status).toBe('verified');
      expect(new Set(resolveTxt.mock.calls.map((c) => c[0]))).toEqual(new Set([ownershipHost(domain)]));
    } finally {
      resolveTxt.mockRestore();
    }
  });

  it('a record made with the previous key still counts while that key is configured, and not after', async () => {
    useVercel();
    const a = await agency('Rotate');
    const domain = name();
    const v = vercel({ verified: true, misconfigured: false });
    const made = ownershipValue(a.orgId, domain);
    publish(a.orgId, domain);
    // The operator rotates the key: the one in use becomes the previous one.
    process.env.PII_ENCRYPTION_KEY_PREVIOUS = getEnv().PII_ENCRYPTION_KEY;
    process.env.PII_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64');
    resetEnvCache();
    expect(ownershipValue(a.orgId, domain)).not.toBe(made);
    expect((await connect(a.orgId, domain, v.f)).status).toBe('verified');
    await disconnectDomain(a.orgId, v.f);
    delete process.env.PII_ENCRYPTION_KEY_PREVIOUS;
    resetEnvCache();
    const again = await connect(a.orgId, domain, v.f);
    expect(again).toMatchObject({ status: 'pending', ownership: { value: ownershipValue(a.orgId, domain) } });
    expect(again.ownership.value).not.toBe(made);
  });

  it('a sibling name of the platform’s own host can be saved but not verified: a tenant cannot create the TXT record there', async () => {
    const zone = `platformco-${uniq()}.com`;
    process.env.APP_URL = `https://app.${zone}`;
    useVercel();
    const a = await agency('Sibling');
    // The platform's own DNS answers for every name under its domain, so the provider says the DNS is right.
    const v = vercel({ verified: true, misconfigured: false });
    const d = await connect(a.orgId, `login.${zone}`, v.f);
    expect(d).toMatchObject({ status: 'pending', ownership: { type: 'TXT', name: '_disputeos.login', value: ownershipValue(a.orgId, `login.${zone}`) } });
    expect((await check(a.orgId, v.f)).status).toBe('pending');
    expect(await agencySlugForHost(`login.${zone}`)).toBeNull();
  });
});

describe('npm run domain:verify (the operator’s check when the hosting provider is not connected)', () => {
  const root = resolve(__dirname, '../..');
  // The script reads .env files from the directory it is run in. It is run in an empty one, so it sees only what it is given.
  const nowhere = mkdtempSync(join(os.tmpdir(), 'dos-domain-verify-'));
  type Net = { check?: { status?: number; body?: unknown }; txt?: Record<string, string[]>; txtError?: string; removedMeanwhile?: boolean };
  /** Runs the real script with its two network calls answered from `net` (tests/db/verify-domain-net.mjs). */
  function verify(domain: string, net: Net, env: Record<string, string | undefined> = {}): { code: number; out: string } {
    const vars = { ...process.env, APP_ENV: 'test', PII_ENCRYPTION_KEY: getEnv().PII_ENCRYPTION_KEY, DOMAIN_VERIFY_NET: JSON.stringify(net), ...env };
    try {
      const out = execFileSync(process.execPath, ['--import', pathToFileURL(join(root, 'tests/db/verify-domain-net.mjs')).href, join(root, 'scripts/verify-domain.mjs'), domain],
        { cwd: nowhere, env: vars, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      return { code: 0, out };
    } catch (e) {
      const x = e as { status: number; stdout: string; stderr: string };
      return { code: x.status, out: `${x.stdout}${x.stderr}` };
    }
  }
  const row = async (domain: string) => (await withSystem((db) => db.row<{ id: string; status: string }>('select id, status from public.agency_domains where domain = $1', [domain])))!;

  it('names the workspace, and verifies only when the domain answers for this deployment and holds that workspace’s TXT record', async () => {
    const a = await agency('Manual');
    const domain = name();
    await connect(a.orgId, domain);
    const here = { check: { body: { id: (await row(domain)).id, domain } } };
    const record = { [ownershipHost(domain)]: [ownershipValue(a.orgId, domain)] };
    const checking = `Checking ${domain} for the workspace "${a.name}" (${a.slug}).`;

    // Without the key the app runs with, the TXT record cannot be checked, so nothing is.
    const noKey = verify(domain, { ...here, txt: record }, { PII_ENCRYPTION_KEY: undefined });
    expect(noKey).toMatchObject({ code: 1, out: expect.stringContaining('PII_ENCRYPTION_KEY is not set.') });
    expect(noKey.out).toContain('Nothing was changed.');
    expect(noKey.out).not.toContain('Checking');
    expect(verify(domain, { ...here, txt: record }, { PII_ENCRYPTION_KEY: 'not-a-key' })).toMatchObject({ code: 1, out: expect.stringContaining('is not 32 bytes in base64') });
    // The domain answers for this deployment, but the TXT record is not there.
    const noRecord = verify(domain, here);
    expect(noRecord.code).toBe(1);
    expect(noRecord.out).toContain(checking);
    expect(noRecord.out).toContain(`The TXT record ${ownershipHost(domain)} was not found. It has to hold the value of "${a.name}" (${a.slug}), which is ${ownershipValue(a.orgId, domain)}.`);
    // The lookup fails: not evidence either way.
    expect(verify(domain, { ...here, txtError: 'ETIMEOUT' })).toMatchObject({ code: 1, out: expect.stringContaining(`The TXT record ${ownershipHost(domain)} could not be looked up (ETIMEOUT).`) });
    // The TXT record is there, but the domain does not answer for this deployment.
    expect(verify(domain, { txt: record })).toMatchObject({ code: 1, out: expect.stringContaining(`https://${domain}/api/domain-check it could not be reached (ENOTFOUND)`) });
    expect(verify(domain, { check: { body: { id: 'another-row' } }, txt: record })).toMatchObject({ code: 1, out: expect.stringContaining('answered for a different domain') });
    expect((await row(domain)).status).toBe('pending');
    expect(await agencySlugForHost(domain)).toBeNull();

    // Both: verified, with an audit entry. A record made with the previous key counts while that key is configured.
    const ok = verify(domain, { ...here, txt: record }, { PII_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64'), PII_ENCRYPTION_KEY_PREVIOUS: getEnv().PII_ENCRYPTION_KEY });
    expect(ok).toMatchObject({ code: 0, out: expect.stringContaining(`Verified: ${domain} now serves the website and client sign-in of "${a.name}" (${a.slug}).`) });
    expect(ok.out).toContain(checking);
    clearHostCache();
    expect(await agencySlugForHost(domain)).toBe(a.slug);
    expect(await withSystem((db) => db.rows("select metadata from public.audit_logs where org_id = $1 and action = 'org.domain_verified'", [a.orgId]))).toEqual([{ metadata: { domain } }]);
    expect(verify(name(), here)).toMatchObject({ code: 1, out: expect.stringContaining('No workspace has connected') });

    // A domain that is removed while the script is checking it is not reported as verified.
    const b = await agency('ManualGone');
    const gone = name();
    await connect(b.orgId, gone);
    const late = verify(gone, { check: { body: { id: (await row(gone)).id } }, txt: { [ownershipHost(gone)]: [ownershipValue(b.orgId, gone)] }, removedMeanwhile: true });
    expect(late).toMatchObject({ code: 1, out: expect.stringContaining(`Not verified: ${gone} was removed from "${b.name}" (${b.slug}) while it was being checked. Nothing was changed.`) });
    expect(late.out).not.toContain('Verified:');
    expect(await withSystem((db) => db.rows("select 1 from public.audit_logs where org_id = $1 and action = 'org.domain_verified'", [b.orgId]))).toEqual([]);
  });

  it('does not verify a rival that took over the claim the owner was waiting on', async () => {
    const [owner, rival] = [await agency('RealOwner3'), await agency('Rival3')];
    const domain = name();
    await connect(owner.orgId, domain); // no provider API: the owner waits for the operator
    await ageClaim(domain);             // for more than a day
    expect((await connect(rival.orgId, domain)).status).toBe('pending');
    // The owner's DNS: the name points at this deployment, and the TXT record holds the owner's value.
    const record = { [ownershipHost(domain)]: [ownershipValue(owner.orgId, domain)] };
    const forRival = verify(domain, { check: { body: { id: (await row(domain)).id } }, txt: record });
    expect(forRival.code).toBe(1);
    expect(forRival.out).toContain(`Checking ${domain} for the workspace "${rival.name}" (${rival.slug}).`);
    expect(forRival.out).toContain(`The TXT record ${ownershipHost(domain)} is there, but it does not hold the value of "${rival.name}" (${rival.slug})`);
    expect((await row(domain)).status).toBe('pending');
    expect(await agencySlugForHost(domain)).toBeNull();
    // The owner connects again: its record is in the DNS, so the rival's hold gives way, and the operator's check passes for the owner.
    publish(owner.orgId, domain);
    await connect(owner.orgId, domain);
    expect(await holder(rival.orgId, rival.ownerId)).toBeNull();
    const forOwner = verify(domain, { check: { body: { id: (await row(domain)).id } }, txt: record });
    expect(forOwner).toMatchObject({ code: 0, out: expect.stringContaining(`now serves the website and client sign-in of "${owner.name}" (${owner.slug})`) });
    clearHostCache();
    expect(await agencySlugForHost(domain)).toBe(owner.slug);
  });
});
