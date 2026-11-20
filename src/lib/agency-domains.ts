/**
 * An agency's own domain name for its public website and client sign-in (table public.agency_domains, migration 0023).
 *
 * Reads for the Website editor go through the tenant connection (staff of the workspace only). Every write goes
 * through the system connection, from a server action that has already checked settings:manage: a tenant request
 * has no way to mark a domain verified. A domain is routed to a site only when its status is `verified`, and a row
 * becomes verified in exactly two places: here, when the hosting provider reports the domain as verified and correctly
 * configured, and in scripts/verify-domain.mjs, when the platform operator's check passed. Both also need the
 * workspace's ownership record in the domain's DNS. The provider's answer is the same whichever workspace holds the
 * row (every workspace is given the same DNS target), so that record is what says whose domain it is.
 */
import { createHmac } from 'node:crypto';
import { Resolver } from 'node:dns/promises';
import { rateLimit } from './auth/rate-limit';
import { safeEqual } from './crypto';
import { withSystem, type Db } from './db';
import { bareDomain, hostName, isPlatformHost, ownershipHost, ownershipRecord, parseDomain, pointingRecord, type DnsRecord } from './domain-rules';
import { getEnv } from './env';
import { UserError } from './errors';
import { addDomain, domainState, removeDomain, vercelConfig } from './vercel-domains';

export type DomainStatus = 'pending' | 'verified' | 'failed';
export interface DomainDetails {
  /** Who is expected to add the domain at the hosting provider: the app through the API, or the platform operator. */
  source: 'vercel' | 'manual';
  /** This app added the domain to the hosting project (so removing it here removes it there). */
  added?: boolean;
  /** DNS records the hosting provider needs, for the agency to create at its registrar. */
  records: DnsRecord[];
  /** The registered domain the record names are written against, when the hosting provider said which it is. */
  apex?: string;
  error?: string;
  checkedAt?: string;
}
export interface AgencyDomain {
  id: string; domain: string; status: DomainStatus; details: DomainDetails; createdAt: string; verifiedAt: string | null;
  /** The TXT record that ties the domain to this workspace. Worked out when read, never stored. */
  ownership: DnsRecord;
}

// ---------------------------------------------------------------- whose domain it is
/**
 * The value of a workspace's ownership record for a domain: a keyed hash of the two, signed the way the opt-out links
 * are (./partner-outreach.ts), so no workspace can work out another's. scripts/verify-domain.mjs makes the same value.
 */
const signWith = (key: string, orgId: string, domain: string) => createHmac('sha256', Buffer.from(key, 'base64')).update(`domain-owner:${orgId}:${bareDomain(domain)}`).digest('base64url');
export const ownershipValue = (orgId: string, domain: string) => signWith(getEnv().PII_ENCRYPTION_KEY, orgId, domain);

/** The TXT records of a DNS name, one string each; none when it has no such record. Tests pass their own, so none touches the network. */
export type TxtLookup = (name: string) => Promise<string[]>;
const dnsTxt: TxtLookup = async (name) => {
  try {
    // A record longer than 255 bytes arrives in pieces. Two short tries, so a dead resolver does not hold the request for long.
    return (await new Resolver({ timeout: 2000, tries: 2 }).resolveTxt(name)).map((chunks) => chunks.join(''));
  } catch (e) {
    if (['ENODATA', 'ENOTFOUND'].includes((e as { code?: string }).code ?? '')) return [];
    throw e;
  }
};

/**
 * Whether the workspace's ownership record is in the domain's DNS. A value signed with the previous key still counts
 * while that key is configured. A lookup that fails proves nothing either way: `error` says that it failed.
 */
async function ownershipCheck(orgId: string, domain: string, txt: TxtLookup): Promise<{ proved: boolean; error?: string }> {
  const env = getEnv();
  const want = [env.PII_ENCRYPTION_KEY, env.PII_ENCRYPTION_KEY_PREVIOUS].filter((k): k is string => !!k).map((k) => signWith(k, orgId, domain));
  try {
    const found = await txt(ownershipHost(domain));
    return { proved: found.some((v) => want.some((w) => safeEqual(v.trim(), w))) };
  } catch (e) {
    return { proved: false, error: `The domain’s DNS could not be read (${(e as { code?: string }).code ?? 'error'}). Try again in a few minutes.` };
  }
}

type Row = { id: string; org_id: string; domain: string; status: DomainStatus; verification: Partial<DomainDetails> | null; created_at: string; verified_at: string | null };
const COLS = 'id, org_id, domain, status, verification, created_at, verified_at';
const shape = (r: Row | null): AgencyDomain | null => {
  if (!r) return null;
  const apex = typeof r.verification?.apex === 'string' ? r.verification.apex : undefined;
  return {
    id: r.id, domain: r.domain, status: r.status, createdAt: r.created_at, verifiedAt: r.verified_at,
    details: { source: r.verification?.source === 'vercel' ? 'vercel' : 'manual', added: r.verification?.added === true, records: Array.isArray(r.verification?.records) ? r.verification.records : [pointingRecord(r.domain)], apex, error: r.verification?.error, checkedAt: r.verification?.checkedAt },
    ownership: ownershipRecord(r.domain, ownershipValue(r.org_id, r.domain), apex),
  };
};

/** The workspace's domain, if it has connected one. Pass a tenant transaction: row-level security limits it to staff of that workspace. */
export async function domainForOrg(db: Db, orgId: string): Promise<AgencyDomain | null> {
  return shape(await db.row<Row>(`select ${COLS} from public.agency_domains where org_id = $1`, [orgId]));
}

/** `https://<domain>` of the workspace's verified domain, or null. */
export async function verifiedOrigin(orgId: string): Promise<string | null> {
  const r = await withSystem((db) => db.row<{ domain: string }>("select domain from public.agency_domains where org_id = $1 and status = 'verified'", [orgId]));
  return r ? `https://${r.domain}` : null;
}

// ---------------------------------------------------------------- host -> agency
const TTL_MS = 60_000;
const cache = new Map<string, { slug: string | null; at: number }>();

/**
 * The slug of the agency whose VERIFIED domain this Host is (with or without "www."), or null. Platform hosts never
 * reach the database. Answers are remembered for a minute per server instance, including "no such domain", so a
 * burst of requests for an unknown host costs one query.
 */
export async function agencySlugForHost(host: string | null | undefined): Promise<string | null> {
  if (isPlatformHost(host, getEnv().APP_URL)) return null;
  const name = bareDomain(hostName(host));
  const hit = cache.get(name);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.slug;
  const row = await withSystem((db) => db.row<{ slug: string }>(
    `select o.slug from public.agency_domains d join public.organizations o on o.id = d.org_id
      where regexp_replace(d.domain, '^www\\.', '') = $1 and d.status = 'verified' and o.status = 'active' and o.mode = 'agency'`, [name]));
  if (cache.size > 500) cache.clear();
  cache.set(name, { slug: row?.slug ?? null, at: Date.now() });
  return row?.slug ?? null;
}
export const clearHostCache = () => cache.clear();

/** For the operator's check (scripts/verify-domain.mjs): the row a Host belongs to, whatever its status. */
export async function domainRowForHost(host: string | null | undefined): Promise<{ id: string; domain: string } | null> {
  if (isPlatformHost(host, getEnv().APP_URL)) return null;
  return withSystem((db) => db.row<{ id: string; domain: string }>(
    "select id, domain from public.agency_domains where regexp_replace(domain, '^www\\.', '') = $1", [bareDomain(hostName(host))]));
}

// ---------------------------------------------------------------- changes (call only after checking settings:manage)
/**
 * Writes the outcome of a check to the row the check was made for, by its id. A workspace that removed that domain
 * and connected another one while the check was running has a new row, which this must never mark.
 */
async function save(id: string, status: DomainStatus, details: DomainDetails): Promise<AgencyDomain> {
  const row = await withSystem((db) => db.row<Row>(
    `update public.agency_domains set status = $2, verification = $3::jsonb,
            verified_at = case when $2 = 'verified' then coalesce(verified_at, now()) else null end
      where id = $1 returning ${COLS}`, [id, status, JSON.stringify({ ...details, checkedAt: new Date().toISOString() })]));
  clearHostCache();
  if (!row) throw new UserError('The domain was removed while it was being checked.');
  return shape(row)!;
}

const CONNECT_LIMIT = { max: 10, windowSec: 86_400 };
/** How long an unverified claim on a name is protected from other workspaces: time to create the DNS records. */
export const CLAIM_HOLD_HOURS = 24;
const TAKEN = 'That domain is already connected to another workspace.';

/**
 * Another workspace holds this name. A verified claim stands. A claim made in the last day stands too, unless the
 * workspace asking already has its ownership record in the domain's DNS: whoever manages the DNS decides. An older
 * claim that never verified proves nothing about who owns the domain, so it must not lock the name: it is re-checked
 * one last time (DNS that became good, with that claimant's own record, belongs to the earlier claimant), and if it is
 * still unverified it is removed, at the provider too when this app added it there. The workspace that takes the name
 * over is not verified by the DNS the earlier claimant created: it needs its own ownership record.
 */
async function releaseStaleClaim(orgId: string, domain: string, f: typeof fetch, txt: TxtLookup): Promise<void> {
  const find = () => withSystem((db) => db.row<Row & { fresh: boolean }>(
    `select ${COLS}, created_at > now() - make_interval(hours => $2) as fresh from public.agency_domains where regexp_replace(domain, '^www\\.', '') = $1`, [bareDomain(domain), CLAIM_HOLD_HOURS]));
  let held = await find();
  if (!held) return;
  if (held.status === 'verified') throw new UserError(TAKEN);
  if (held.fresh) {
    const own = await ownershipCheck(orgId, domain, txt);
    if (!own.proved) {
      throw new UserError(`Another workspace started connecting that domain in the last day. If the domain is yours, try again tomorrow. To connect it now, first create a TXT record named ${ownershipHost(domain)} with the value ${ownershipValue(orgId, domain)} where you manage the domain’s DNS.${own.error ? ` ${own.error}` : ''}`);
    }
  }
  const cfg = vercelConfig();
  if (cfg) {
    await refreshDomain(held.org_id, f, txt);
    held = await find();
    if (!held) return;
    if (held.status === 'verified') throw new UserError(TAKEN);
    if (held.verification?.added === true) {
      const r = await removeDomain(cfg, held.domain, f);
      if (!r.ok) throw new UserError(`That domain is held by an unfinished connection that could not be cleared at the hosting provider: ${r.error}`);
    }
  }
  await withSystem((db) => db.run("delete from public.agency_domains where id = $1 and status <> 'verified'", [held!.id]));
  clearHostCache();
}

/**
 * Saves the domain for the workspace as pending and, when the hosting provider's API is configured, adds it to the
 * project and reads back what DNS it needs. One agency cannot claim a domain (or the www twin of a domain) that
 * another agency has verified, or claimed within the last day: the unique index decides, before the provider is ever
 * called for the new claim. An unverified claim gives way once it is a day old, or at once to a workspace whose
 * ownership record is already in the domain's DNS (releaseStaleClaim).
 */
export async function connectDomain(orgId: string, input: string, f: typeof fetch = fetch, txt: TxtLookup = dnsTxt): Promise<AgencyDomain> {
  const p = parseDomain(input, getEnv().APP_URL);
  if (!p.ok) throw new UserError(p.error);
  const details: DomainDetails = { source: vercelConfig() ? 'vercel' : 'manual', records: [pointingRecord(p.domain)] };
  const limit = await rateLimit(`domain-connect:org:${orgId}`, CONNECT_LIMIT.max, CONNECT_LIMIT.windowSec);
  if (!limit.allowed) throw new UserError('Too many domains were tried from this workspace today. Try again tomorrow.');
  const insert = () => withSystem(async (db) => {
    if (!(await db.row("select 1 from public.organizations where id = $1 and mode = 'agency' and status = 'active'", [orgId]))) throw new UserError('A custom domain is for agency workspaces.');
    await db.run('insert into public.agency_domains (org_id, domain, verification) values ($1, $2, $3::jsonb)', [orgId, p.domain, JSON.stringify(details)]);
  });
  const conflict = (e: unknown) => {
    const pg = e as { code?: string; constraint?: string };
    if (pg.code !== '23505') throw e;
    if (pg.constraint === 'agency_domains_org_id_key') throw new UserError('Your workspace already has a domain. Remove it before connecting another.');
  };
  try {
    await insert();
  } catch (e) {
    conflict(e);
    await releaseStaleClaim(orgId, p.domain, f, txt);
    try { await insert(); } catch (e2) { conflict(e2); throw new UserError(TAKEN); }
  }
  clearHostCache();
  return refreshDomain(orgId, f, txt);
}

/**
 * "Check now". With the provider's API: adds the domain if this app has not yet, re-reads ownership and DNS there,
 * and marks the row verified only when the provider says both are good AND the workspace's ownership record is in the
 * domain's DNS. Without the API there is nothing this app can check by itself, so the row is returned as it is (the
 * operator's script is what verifies it).
 */
export async function refreshDomain(orgId: string, f: typeof fetch = fetch, txt: TxtLookup = dnsTxt): Promise<AgencyDomain> {
  const cur = shape(await withSystem((db) => db.row<Row>(`select ${COLS} from public.agency_domains where org_id = $1`, [orgId])));
  if (!cur) throw new UserError('No domain is connected.');
  const cfg = vercelConfig();
  if (!cfg) return cur;
  let d: DomainDetails = { source: 'vercel', added: cur.details.added, records: cur.details.records, apex: cur.details.apex };
  if (!d.added) {
    const add = await addDomain(cfg, cur.domain, f);
    if (!add.ok) return save(cur.id, cur.status === 'verified' ? 'verified' : 'failed', { ...d, error: add.error });
    // On the project already, but not through this app: someone set it up by hand. Only a domain the operator has
    // already verified for this workspace is accepted that way.
    if (add.value.already && cur.status !== 'verified') return save(cur.id, 'failed', { ...d, error: 'This domain is already set up at the hosting provider. Ask the platform operator to connect it for you.' });
    d = { ...d, added: !add.value.already };
  }
  const st = await domainState(cfg, cur.domain, f);
  // A provider outage is not evidence either way: the status stays as it was.
  if (!st.ok) return save(cur.id, cur.status === 'verified' ? 'verified' : 'pending', { ...d, error: st.error });
  const s = st.value;
  const apex = s.apexName ?? cur.domain.split('.').slice(-2).join('.');
  const records: DnsRecord[] = [
    pointingRecord(cur.domain, { apex: s.apexName, a: s.a, cname: s.cname }),
    ...s.challenges.filter((c) => c.type.toUpperCase() === 'TXT').map((c): DnsRecord => ({ type: 'TXT', name: c.domain.endsWith(`.${apex}`) ? c.domain.slice(0, -(apex.length + 1)) : c.domain, value: c.value })),
  ];
  d = { ...d, records, apex: s.apexName ?? undefined };
  if (!s.verified || s.misconfigured) return save(cur.id, 'pending', d);
  // The provider has now said what it would say for any workspace holding this name; the ownership record is what
  // ties the domain to this one. It is asked for when a row becomes verified and not again afterwards: only a row's
  // own workspace re-checks a verified row, so asking again would protect nothing, and after a key rotation it would
  // take a live site down.
  if (cur.status === 'verified') return save(cur.id, 'verified', d);
  const own = await ownershipCheck(orgId, cur.domain, txt);
  return save(cur.id, own.proved ? 'verified' : 'pending', own.error ? { ...d, error: own.error } : d);
}

/**
 * Disconnects the workspace's domain. A domain this app added to the hosting project is removed from it first; if
 * that fails the row stays, so the two never disagree. Returns `leftAtProvider` when the domain may still be on the
 * hosting project (the operator added it by hand, or the API is no longer configured) and has to be removed there.
 */
export async function disconnectDomain(orgId: string, f: typeof fetch = fetch): Promise<{ domain: string; leftAtProvider: boolean } | null> {
  const cur = shape(await withSystem((db) => db.row<Row>(`select ${COLS} from public.agency_domains where org_id = $1`, [orgId])));
  if (!cur) return null;
  const cfg = vercelConfig();
  if (cur.details.added && cfg) {
    const r = await removeDomain(cfg, cur.domain, f);
    if (!r.ok) throw new UserError(`The domain could not be removed at the hosting provider, so nothing was changed: ${r.error}`);
  }
  await withSystem((db) => db.run('delete from public.agency_domains where org_id = $1', [orgId]));
  clearHostCache();
  return { domain: cur.domain, leftAtProvider: cur.details.added ? !cfg : cur.details.source === 'manual' };
}
