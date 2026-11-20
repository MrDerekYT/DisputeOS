'use server';

import { revalidatePath } from 'next/cache';
import type { ActionState } from '@/components/forms';
import { run } from '@/lib/action';
import { connectDomain, disconnectDomain, refreshDomain, type AgencyDomain } from '@/lib/agency-domains';
import { audit } from '@/lib/audit';
import { requireStaff, type Ctx } from '@/lib/auth/context';

const log = (ctx: Ctx, action: string, d: Pick<AgencyDomain, 'domain' | 'status'>) =>
  ctx.tx((db) => audit(db, { orgId: ctx.orgId, actorId: ctx.userId, action, entityType: 'organization', entityId: ctx.orgId, ip: ctx.meta.ip, meta: { domain: d.domain, status: d.status } }));

/** `saved` is the answer to "Connect domain" (the domain was stored); a check that finds it still pending is not a success. */
function outcome(d: AgencyDomain, saved: boolean): ActionState {
  if (d.status === 'verified') return { ok: `${d.domain} is connected. Your site and client sign-in now answer there.` };
  if (d.status === 'failed') return { error: d.details.error ?? 'The domain could not be connected.' };
  const waiting = d.details.source === 'manual' ? 'The platform operator still has to add this domain at the hosting provider; it is not live yet.'
    : d.details.error ? `It could not be checked: ${d.details.error}`
    : 'It is not connected yet. Create the DNS records shown, including the TXT record, then check again. DNS changes can take a few hours.';
  return saved ? { ok: `Saved. ${waiting}` } : { error: waiting };
}

/** Connects a domain the agency already owns. The permission check is here; the write itself uses the system connection (src/lib/agency-domains.ts). */
export async function connectDomainAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const ctx = await requireStaff('settings:manage');
  return run(async () => {
    const d = await connectDomain(ctx.orgId, String(fd.get('domain') ?? ''));
    await log(ctx, 'org.domain_connected', d);
    revalidatePath('/app/website');
    return outcome(d, true);
  });
}

/** "Check now": re-reads the status from the hosting provider and looks for the workspace's TXT record in the domain's DNS. Never marks a domain connected on its own word. */
export async function checkDomainAction(): Promise<ActionState> {
  const ctx = await requireStaff('settings:manage');
  return run(async () => {
    const d = await refreshDomain(ctx.orgId);
    revalidatePath('/app/website');
    return outcome(d, false);
  });
}

export async function removeDomainAction(): Promise<ActionState> {
  const ctx = await requireStaff('settings:manage');
  return run(async () => {
    const r = await disconnectDomain(ctx.orgId);
    if (!r) return { ok: 'No domain is connected.' };
    await log(ctx, 'org.domain_removed', { domain: r.domain, status: 'pending' });
    revalidatePath('/app/website');
    return { ok: r.leftAtProvider ? `${r.domain} is disconnected from your site. If the platform operator added it at the hosting provider, ask them to remove it there too.` : `${r.domain} is disconnected. Your site stays at its address on this app.` };
  });
}
