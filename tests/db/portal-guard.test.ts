import { afterAll, describe, expect, it } from 'vitest';
import { addPortalClient, asUser, closePool, makeOrg, withSystem } from './helpers';

afterAll(closePool);

const REFUSED = 'portal users may only update phone, address and preferred language';

describe('what a portal client may change on their own client record (trigger clients_portal_guard, migration 0029)', () => {
  it('phone, address and language, and never the bankruptcy details staff entered', async () => {
    const a = await makeOrg('PortalGuard');
    const c = await addPortalClient(a.orgId, 'Guard Client');
    const other = await addPortalClient(a.orgId, 'Other Client');
    const stored = () => withSystem((db) => db.row<{ chapter: string | null; filed: string | null; discharged: string | null; phone: string | null; lang: string; address: Record<string, string> }>(
      'select bankruptcy_chapter as chapter, bankruptcy_filed_on::text as filed, bankruptcy_discharged_on::text as discharged, phone, preferred_language as lang, address from public.clients where id = $1', [c.clientId]));
    const asClient = (set: string, userId = c.userId) => asUser(userId, (db) => db.run(`update public.clients set ${set} where id = $1`, [c.clientId]));

    // No bankruptcy on file: the client cannot record one for themselves.
    for (const set of ["bankruptcy_chapter = '7'", "bankruptcy_filed_on = '2020-01-01'", "bankruptcy_discharged_on = '2020-06-01'",
      "bankruptcy_chapter = '7', bankruptcy_filed_on = '2020-01-01', bankruptcy_discharged_on = '2020-06-01'"]) {
      await expect(asClient(set), set).rejects.toThrow(REFUSED);
    }
    expect(await stored()).toMatchObject({ chapter: null, filed: null, discharged: null });

    // Staff recorded one: the client cannot change it, clear it or add a discharge date, even together with an allowed field.
    expect(await asUser(a.ownerId, (db) => db.run("update public.clients set bankruptcy_chapter = '13', bankruptcy_filed_on = '2022-03-01' where id = $1", [c.clientId]))).toBe(1);
    for (const set of ["bankruptcy_chapter = '7'", 'bankruptcy_chapter = null', "bankruptcy_filed_on = '2015-01-01'", 'bankruptcy_filed_on = null', "bankruptcy_discharged_on = '2022-09-01'",
      "phone = '555-0100', bankruptcy_discharged_on = '2022-09-01'"]) {
      await expect(asClient(set), set).rejects.toThrow(REFUSED);
    }
    expect(await stored()).toMatchObject({ chapter: '13', filed: '2022-03-01', discharged: null, phone: null });

    // What the portal's profile form saves (src/app/portal/actions.ts) still works, and leaves the rest alone.
    expect(await asUser(c.userId, (db) => db.run('update public.clients set phone = $2, preferred_language = $3, address = $4 where id = $1',
      [c.clientId, '555-0100', 'es', JSON.stringify({ line1: '1 Main St', line2: '', city: 'Austin', state: 'TX', zip: '78701' })]))).toBe(1);
    expect(await stored()).toMatchObject({ phone: '555-0100', lang: 'es', address: { line1: '1 Main St', city: 'Austin', state: 'TX', zip: '78701' }, chapter: '13', filed: '2022-03-01', discharged: null });
    // Writing back the same bankruptcy values is not a change, so a form that sends the whole row is not refused.
    expect(await asClient("phone = '555-0111', bankruptcy_chapter = '13', bankruptcy_filed_on = '2022-03-01', bankruptcy_discharged_on = null")).toBe(1);

    // Another client of the same agency reaches nothing here; staff still record the discharge.
    expect(await asClient("phone = '555-0199'", other.userId)).toBe(0);
    expect(await asUser(a.ownerId, (db) => db.run("update public.clients set bankruptcy_discharged_on = '2022-09-01' where id = $1", [c.clientId]))).toBe(1);
    expect(await stored()).toMatchObject({ chapter: '13', filed: '2022-03-01', discharged: '2022-09-01', phone: '555-0111' });
  });
});
