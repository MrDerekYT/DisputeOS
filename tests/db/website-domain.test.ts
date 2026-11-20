import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { connectDomain, ownershipValue, type TxtLookup } from '@/lib/agency-domains';
import type { Ctx } from '@/lib/auth/context';
import type { SessionInfo } from '@/lib/auth/service';
import { resetEnvCache } from '@/lib/env';
import { can } from '@/lib/rbac';
import { asUser, closePool, makeOrg, uniq, withSystem } from './helpers';

// The section is rendered exactly as the server renders it, with the real query under row-level security. Only the
// sign-in step is stood in for; nothing here reaches the hosting provider or DNS (no provider API is configured).
const signedIn = vi.hoisted(() => ({ ctx: null as unknown }));
vi.mock('@/lib/auth/context', () => ({ requireStaff: async () => signedIn.ctx }));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));
// The test runner compiles JSX to React.createElement, so React has to be in scope when a component renders.
vi.stubGlobal('React', React);

import { DomainSection } from '@/app/app/website/domain-section';

beforeAll(() => { for (const k of ['VERCEL_API_TOKEN', 'VERCEL_PROJECT_ID']) delete process.env[k]; resetEnvCache(); });
afterAll(closePool);

const noDns: TxtLookup = async () => [];
/** What a person reads on the page: the markup with tags dropped and entities decoded. */
const read = (el: React.ReactNode) => renderToStaticMarkup(el as React.ReactElement).replace(/<!-- -->/g, '')
  .replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ');

describe('“Your own domain” on the Website page', () => {
  it('shows the workspace’s TXT record with the other DNS records, and says the domain is not verified until it is there', async () => {
    const o = await makeOrg('WebsiteDomain');
    const session: SessionInfo = { sessionId: 's', userId: o.ownerId, orgId: o.orgId, role: 'owner', email: o.ownerEmail, fullName: 'Test Person', mfaVerified: true, totpEnabled: false, orgName: 'WebsiteDomain', orgSlug: 'websitedomain', orgMode: 'agency', orgPlan: 'trial' };
    const ctx: Ctx = { session, userId: o.ownerId, orgId: o.orgId, role: 'owner', tx: (fn) => asUser(o.ownerId, fn), can: (p) => can('owner', p), need: () => undefined, meta: { ip: '10.0.0.1', userAgent: 'vitest' } };
    signedIn.ctx = ctx;
    const bare = `agency-${uniq()}.com`;
    const domain = `www.${bare}`;

    expect(read(await DomainSection({ ctx }))).not.toContain('TXT');
    await connectDomain(o.orgId, domain, undefined, noDns);
    const pending = read(await DomainSection({ ctx }));
    expect(pending).toContain('Not connected yet');
    expect(pending).toContain('Create these records where you manage the domain’s DNS');
    // One table: the record that points the domain here, then the record that ties it to this workspace.
    expect(pending).toMatch(new RegExp(`Type\\s+Name\\s+Value\\s+CNAME\\s+www\\s+cname\\.vercel-dns\\.com\\s+TXT\\s+_disputeos\\s+${ownershipValue(o.orgId, domain)}\\s`));
    expect(pending).toContain(`The TXT record named _disputeos (in full: _disputeos.${bare}) proves the domain is yours: only someone who manages its DNS can create it. Your domain is not verified, and so not connected, until that record is there.`);
    expect(pending).toContain('The CNAME value above is the hosting provider’s general one. The platform operator confirms the exact value when adding your domain. The TXT record is exactly as shown.');

    // Once it is verified the records are no longer shown.
    await withSystem((db) => db.run("update public.agency_domains set status = 'verified', verified_at = now() where org_id = $1", [o.orgId]));
    const live = read(await DomainSection({ ctx }));
    expect(live).toContain(`Your site is at https://${domain}`);
    expect(live).not.toContain('_disputeos');
  });
});
