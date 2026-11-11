import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clientCare } from '@/lib/client-care';
import { orgBrandBySlug, portalLoginPath } from '@/lib/org-brand';
import { addClient, asUser, closePool, makeOrg, uniq, withSystem, type TestOrg } from './helpers';

let org: TestOrg;
let slug: string;

beforeAll(async () => {
  org = await makeOrg('Brand');
  slug = (await withSystem((db) => db.row<{ slug: string }>("update public.organizations set settings = settings || '{\"brand_color\":\"#7c3aed\"}' where id = $1 returning slug", [org.orgId])))!.slug;
});
afterAll(closePool);

describe('branded client sign-in link', () => {
  it('shows an active agency’s name and colour', async () => {
    const b = await orgBrandBySlug(slug);
    expect(b).toMatchObject({ slug, color: '#7c3aed' });
    expect(b!.name).toMatch(/^Brand /);
    expect(portalLoginPath(slug)).toBe(`/portal/login?org=${slug}`);
  });

  it('reveals nothing for personal workspaces, suspended agencies or malformed slugs', async () => {
    const personal = await makeOrg('Personal');
    const pslug = (await withSystem((db) => db.row<{ slug: string }>("update public.organizations set mode = 'personal' where id = $1 returning slug", [personal.orgId])))!.slug;
    expect(await orgBrandBySlug(pslug)).toBeNull();

    const gone = await makeOrg('Suspended');
    const sslug = (await withSystem((db) => db.row<{ slug: string }>("update public.organizations set status = 'suspended' where id = $1 returning slug", [gone.orgId])))!.slug;
    expect(await orgBrandBySlug(sslug)).toBeNull();

    for (const bad of ["x' or '1'='1", '../admin', '', 'UPPER', 'a'.repeat(80)]) expect(await orgBrandBySlug(bad), bad).toBeNull();
  });

  it('ignores a stored colour that is not a plain hex value', async () => {
    const o = await makeOrg('BadColour');
    const s = (await withSystem((db) => db.row<{ slug: string }>("update public.organizations set settings = settings || '{\"brand_color\":\"red;}body{display:none\"}' where id = $1 returning slug", [o.orgId])))!.slug;
    expect((await orgBrandBySlug(s))!.color).toBeNull();
  });
});

describe('client care queues on the dashboard', () => {
  it('lists unanswered messages, client uploads to review and clients who have not heard from the team', async () => {
    const waiting = await addClient(org.orgId, `Waiting ${uniq()}`);
    const answered = await addClient(org.orgId, `Answered ${uniq()}`);
    const quiet = await addClient(org.orgId, `Quiet ${uniq()}`);
    const recent = await addClient(org.orgId, `Recent ${uniq()}`);
    await withSystem(async (db) => {
      await db.run("insert into public.communications (org_id, client_id, direction, channel, body, status) values ($1, $2, 'inbound', 'portal', 'Any news on my Experian item?', 'received')", [org.orgId, waiting]);
      await db.run("insert into public.communications (org_id, client_id, direction, channel, body, status, read_at) values ($1, $2, 'inbound', 'portal', 'Thanks!', 'received', now())", [org.orgId, answered]);
      await db.run("insert into public.documents (org_id, client_id, kind, file_name, mime_type, size_bytes, sha256, storage_key, source) values ($1, $2, 'id', 'license.png', 'image/png', 10, 'x', 'k', 'client')", [org.orgId, waiting]);
      await db.run("insert into public.documents (org_id, client_id, kind, file_name, mime_type, size_bytes, sha256, storage_key, source) values ($1, $2, 'id', 'staff-scan.pdf', 'application/pdf', 10, 'x', 'k2', 'staff')", [org.orgId, waiting]);
      await db.run("update public.clients set created_at = now() - interval '20 days' where id = any($1)", [[quiet, recent, waiting, answered]]);
      await db.run("insert into public.communications (org_id, client_id, direction, channel, body, status) values ($1, $2, 'outbound', 'portal', 'Update: letters went out today.', 'sent')", [org.orgId, recent]);
    });

    const care = await asUser(org.ownerId, (db) => clientCare(db));
    expect(care.messages.map((m) => m.client_id)).toEqual([waiting]);
    expect(care.uploads.map((u) => u.file_name)).toEqual(['license.png']);
    const quietIds = care.quiet.map((q) => q.id);
    expect(quietIds).toContain(quiet);
    expect(quietIds).not.toContain(recent);
    expect(care.counts.messages).toBe(1);
    expect(care.total).toBe(care.counts.messages + care.counts.uploads + care.counts.quiet + care.counts.leads);
  });

  it('respects row-level security: another organization sees none of it', async () => {
    const other = await makeOrg('Other');
    const care = await asUser(other.ownerId, (db) => clientCare(db));
    expect(care.total).toBe(0);
  });
});
