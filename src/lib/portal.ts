import { requireClient } from './auth/context';
import { withSystem } from './db';
import { tr, type Lang } from './portal-i18n';

export interface PortalClient {
  id: string; full_name: string; email: string | null; phone: string | null; preferred_language: Lang; stage: string; status: string;
  address: { line1?: string; line2?: string; city?: string; state?: string; zip?: string };
}

/** Every portal page starts here: authenticated as the client, with their own record loaded under row-level security. */
export async function portalContext() {
  const ctx = await requireClient();
  const client = (await ctx.tx((db) => db.row<PortalClient>('select id, full_name, email, phone, preferred_language, stage, status, address from public.clients where id = $1', [ctx.clientId])))!;
  return { ctx, client, lang: client.preferred_language, t: tr(client.preferred_language) };
}

/** The only cross-boundary read: the first name of the client's own assigned specialist (clients cannot read staff rows). */
export async function specialistFirstName(clientId: string): Promise<string | null> {
  const r = await withSystem((db) => db.row<{ n: string }>("select split_part(coalesce(nullif(u.full_name, ''), u.email), ' ', 1) as n from public.clients c join public.users u on u.id = c.assigned_to where c.id = $1", [clientId]));
  return r?.n ?? null;
}

/** The portal language of a signed-in client, for the pages they see outside the portal frame (two-step verification). */
export async function portalLangForUser(userId: string): Promise<Lang> {
  const r = await withSystem((db) => db.row<{ l: string }>('select preferred_language as l from public.clients where portal_user_id = $1', [userId]));
  return r?.l === 'es' ? 'es' : 'en';
}
