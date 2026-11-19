import { getEnv } from './env';

/**
 * The caller's IP address, used for rate limits and the audit log.
 *
 * `x-forwarded-for` is a list each proxy APPENDS to, so everything left of the entries written by our own proxies is
 * whatever the client chose to send. We therefore count from the RIGHT: with TRUSTED_PROXY_HOPS=1 (the default, one
 * reverse proxy or load balancer in front of the app) the last entry is the address that proxy saw. Raise the number
 * only when more proxies sit in front (e.g. CDN -> load balancer -> app = 2). The leftmost value is never trusted.
 * `x-real-ip` is used only when there is no x-forwarded-for at all. See docs/SECURITY_AND_COMPLIANCE.md.
 */
export function clientIp(headers: { get(name: string): string | null }, hops: number = getEnv().TRUSTED_PROXY_HOPS): string | null {
  const chain = (headers.get('x-forwarded-for') ?? '').split(',').map((p) => p.trim()).filter(Boolean);
  if (chain.length) return (chain[Math.max(0, chain.length - Math.max(1, hops))] ?? '').slice(0, 64) || null;
  return headers.get('x-real-ip')?.trim().slice(0, 64) || null;
}
