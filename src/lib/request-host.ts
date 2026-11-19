import { headers } from 'next/headers';
import { agencySlugForHost } from './agency-domains';
import { HOST_SLUG } from './domain-rules';

/** The agency whose verified custom domain this request came in on, or null on the platform's own host. */
export async function requestAgencySlug(): Promise<string | null> {
  return agencySlugForHost((await headers()).get('host'));
}

/**
 * Resolves the `[slug]` of /a/<slug> and /start/<slug>. The middleware rewrites "/" and "/start" on a custom domain
 * to the internal slug "_host", which means "whichever agency owns this Host"; an unknown host resolves to null and
 * the page answers "not found". `onDomain` tells the page to link to "/" and "/portal/login" instead of /a/<slug>.
 */
export async function resolveSlugParam(slug: string): Promise<{ slug: string | null; onDomain: boolean }> {
  return slug === HOST_SLUG ? { slug: await requestAgencySlug(), onDomain: true } : { slug, onDomain: false };
}
