/**
 * The three Vercel REST calls custom domains need, with plain fetch (https://vercel.com/docs/rest-api):
 *   POST   /v10/projects/{id}/domains            add a domain to the project
 *   GET    /v9/projects/{id}/domains/{domain}    ownership: `verified`, and the TXT challenge when the domain is
 *                                                already in use on another Vercel account
 *   POST   /v9/projects/{id}/domains/{domain}/verify   ask Vercel to re-check that challenge
 *   GET    /v6/domains/{domain}/config           DNS: `misconfigured`, and the A / CNAME values Vercel recommends
 *   DELETE /v9/projects/{id}/domains/{domain}    remove it from the project
 * `verified` is Vercel's word that this project may use the domain; a domain reaches the app when it is verified AND
 * not misconfigured. Both answers are the same whichever workspace of this app asked, so they do not say whose domain
 * it is: that is settled by the workspace's own TXT record (./agency-domains.ts), which is checked as well.
 * Implemented to the documented API and tested against a mocked fetch; not exercised against the live service.
 */
import { getEnv } from './env';

export interface VercelConfig { token: string; projectId: string; teamId?: string }
type Fetch = typeof fetch;

export const VERCEL_VARS = ['VERCEL_API_TOKEN', 'VERCEL_PROJECT_ID'] as const;

/** The variables still to set before domains can be added automatically. Empty means connected. */
export function vercelMissing(): string[] {
  const env = getEnv();
  return VERCEL_VARS.filter((k) => !env[k]);
}

export function vercelConfig(): VercelConfig | null {
  const env = getEnv();
  if (!env.VERCEL_API_TOKEN || !env.VERCEL_PROJECT_ID) return null;
  return { token: env.VERCEL_API_TOKEN, projectId: env.VERCEL_PROJECT_ID, ...(env.VERCEL_TEAM_ID ? { teamId: env.VERCEL_TEAM_ID } : {}) };
}

export interface Challenge { type: string; domain: string; value: string; reason?: string }
export interface DomainState {
  /** Vercel accepts that this project may use the domain. */
  verified: boolean;
  /** DNS does not point at Vercel yet (or a certificate cannot be issued). */
  misconfigured: boolean;
  apexName: string | null;
  challenges: Challenge[];
  a: string | null;
  cname: string | null;
}
export type VercelResult<T> = { ok: true; value: T } | { ok: false; status: number; error: string };

async function call(cfg: VercelConfig, f: Fetch, method: string, path: string, body?: unknown, query: Record<string, string> = {}): Promise<VercelResult<Record<string, unknown>>> {
  const qs = new URLSearchParams({ ...query, ...(cfg.teamId ? { teamId: cfg.teamId } : {}) }).toString();
  try {
    const res = await f(`https://api.vercel.com${path}${qs ? `?${qs}` : ''}`, {
      method,
      headers: { Authorization: `Bearer ${cfg.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(10_000),
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (res.ok) return { ok: true, value: json };
    const err = json.error as { message?: unknown } | undefined;
    const message = typeof err?.message === 'string' ? err.message.slice(0, 300) : `HTTP ${res.status}`;
    return { ok: false, status: res.status, error: res.status === 401 || res.status === 403 ? `The hosting provider refused the request (${message}). Check VERCEL_API_TOKEN, VERCEL_PROJECT_ID and VERCEL_TEAM_ID.` : message };
  } catch (e) {
    return { ok: false, status: 0, error: `The hosting provider could not be reached (${e instanceof Error ? e.name : 'error'}).` };
  }
}

const proj = (cfg: VercelConfig) => `/projects/${encodeURIComponent(cfg.projectId)}/domains`;
const str = (v: unknown) => (typeof v === 'string' && v ? v : null);

/**
 * Adds the domain to the project. `already` is true when it was on the project before this call — which, for a
 * domain this app has never added, means somebody set it up by hand and it is not this agency's to take.
 */
export async function addDomain(cfg: VercelConfig, domain: string, f: Fetch = fetch): Promise<VercelResult<{ already: boolean }>> {
  const r = await call(cfg, f, 'POST', `/v10${proj(cfg)}`, { name: domain });
  if (r.ok) return { ok: true, value: { already: false } };
  // "If the domain already exists on the project, the request fails with a 400 status code." Other 400s (an invalid
  // name) are told apart by asking for the project domain.
  if (r.status === 400 || r.status === 409) {
    const cur = await call(cfg, f, 'GET', `/v9${proj(cfg)}/${encodeURIComponent(domain)}`);
    if (cur.ok) return { ok: true, value: { already: true } };
  }
  return r;
}

/** Ownership and DNS state as Vercel sees them now. An unverified domain is re-checked first. */
export async function domainState(cfg: VercelConfig, domain: string, f: Fetch = fetch): Promise<VercelResult<DomainState>> {
  const path = `/v9${proj(cfg)}/${encodeURIComponent(domain)}`;
  let pd = await call(cfg, f, 'GET', path);
  if (!pd.ok) return pd;
  if (pd.value.verified !== true) {
    const again = await call(cfg, f, 'POST', `${path}/verify`);
    if (again.ok) pd = again; // a failed re-check just means the challenge is not met yet
  }
  const conf = await call(cfg, f, 'GET', `/v6/domains/${encodeURIComponent(domain)}/config`, undefined, { projectIdOrName: cfg.projectId });
  if (!conf.ok) return conf;
  // "rank=1 is the preferred value to use."
  const best = (list: unknown) => (Array.isArray(list) ? [...list].sort((x, y) => Number(x?.rank ?? 99) - Number(y?.rank ?? 99))[0]?.value : undefined);
  const a = best(conf.value.recommendedIPv4);
  const challenges = Array.isArray(pd.value.verification) ? pd.value.verification as Record<string, unknown>[] : [];
  return { ok: true, value: {
    verified: pd.value.verified === true,
    misconfigured: conf.value.misconfigured !== false,
    apexName: str(pd.value.apexName),
    challenges: pd.value.verified === true ? [] : challenges.flatMap((c) => {
      const [type, name, value] = [str(c.type), str(c.domain), str(c.value)];
      return type && name && value ? [{ type, domain: name, value, ...(str(c.reason) ? { reason: str(c.reason)! } : {}) }] : [];
    }),
    a: str(Array.isArray(a) ? a[0] : a),
    cname: str(best(conf.value.recommendedCNAME))?.replace(/\.$/, '') ?? null,
  } };
}

/** Removes the domain from the project. A domain that is not there counts as removed. */
export async function removeDomain(cfg: VercelConfig, domain: string, f: Fetch = fetch): Promise<VercelResult<null>> {
  const r = await call(cfg, f, 'DELETE', `/v9${proj(cfg)}/${encodeURIComponent(domain)}`);
  return r.ok || r.status === 404 ? { ok: true, value: null } : r;
}
