import { HEX } from './brand';
import { withSystem } from './db';

/** What a client is allowed to see about an agency before signing in: its public name and portal colour. */
export interface OrgBrand { name: string; slug: string; color: string | null }

const SLUG = /^[a-z0-9][a-z0-9-]{1,62}$/;

type Row = { name: string; slug: string; color: string | null };
const shape = (r: Row | null): OrgBrand | null => (r ? { name: r.name, slug: r.slug, color: r.color && HEX.test(r.color) ? r.color : null } : null);

/**
 * Branding for a public client sign-in link (`/portal/login?org=<slug>`). Only active *agency* workspaces are
 * returned — a personal workspace's name can be a person's name and must not be discoverable by slug.
 */
export async function orgBrandBySlug(slug: string | null | undefined): Promise<OrgBrand | null> {
  if (!slug || !SLUG.test(slug)) return null;
  return shape(await withSystem((db) => db.row<Row>(
    "select name, slug, settings->>'brand_color' as color from public.organizations where slug = $1 and status = 'active' and mode = 'agency'", [slug])));
}

/** Branding for a known organization (e.g. the one that sent a client an invitation). */
export async function orgBrandById(id: string): Promise<OrgBrand | null> {
  return shape(await withSystem((db) => db.row<Row>(
    "select name, slug, settings->>'brand_color' as color from public.organizations where id = $1 and status = 'active'", [id])));
}

/** The link an agency gives its clients: their branded portal sign-in page. */
export const portalLoginPath = (slug: string | null | undefined) => (slug ? `/portal/login?org=${encodeURIComponent(slug)}` : '/portal/login');
