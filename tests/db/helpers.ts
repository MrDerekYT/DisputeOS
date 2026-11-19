import { randomUUID } from 'node:crypto';
import { withSystem, withTenant, closePool, type Db } from '@/lib/db';
import { signUp } from '@/lib/auth/service';
import type { Role } from '@/lib/rbac';

export const PASSWORD = 'Correct-Horse-Battery-9';
export const uniq = () => randomUUID().slice(0, 8);
export const testIp = () => `10.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`;

export interface TestOrg {
  orgId: string;
  ownerId: string;
  ownerEmail: string;
}

/** Fresh tenant through the real sign-up path. Tests never truncate shared tables, so they stay independent. */
export async function makeOrg(label = 'Org'): Promise<TestOrg> {
  const email = `owner-${uniq()}@test.dev`;
  const r = await signUp({ email, password: PASSWORD, fullName: `${label} Owner`, orgName: `${label} ${uniq()}`, mode: 'agency' }, { ip: testIp() });
  if (!r.ok) throw new Error(r.error);
  return { orgId: r.orgId, ownerId: r.userId, ownerEmail: email };
}

export async function addMember(orgId: string, role: Role, label: string = role): Promise<{ id: string; email: string }> {
  const email = `${label}-${uniq()}@test.dev`;
  return withSystem(async (db) => {
    const u = await db.row<{ id: string }>(
      "insert into public.users (email, password_hash, full_name) values ($1, 'x', $2) returning id", [email, `${label} person`]);
    await db.run('insert into public.memberships (org_id, user_id, role) values ($1, $2, $3)', [orgId, u!.id, role]);
    return { id: u!.id, email };
  });
}

export async function addClient(orgId: string, name = 'Test Client', opts: { portalUserId?: string; status?: string } = {}): Promise<string> {
  return withSystem(async (db) => {
    const r = await db.row<{ id: string }>(
      'insert into public.clients (org_id, full_name, email, portal_user_id, status) values ($1, $2, $3, $4, $5) returning id',
      [orgId, name, `c-${uniq()}@client.dev`, opts.portalUserId ?? null, opts.status ?? 'active'],
    );
    return r!.id;
  });
}

export async function addPortalClient(orgId: string, name = 'Portal Client') {
  const user = await addMember(orgId, 'client', 'portal');
  const clientId = await addClient(orgId, name, { portalUserId: user.id });
  return { userId: user.id, clientId };
}

export async function addDispute(orgId: string, clientId: string, status = 'draft', label = 'Acme Bank ••1234 (Experian)'): Promise<string> {
  return withSystem(async (db) => {
    const r = await db.row<{ id: string }>(
      `insert into public.disputes (org_id, client_id, item_label, bureau, recipient_name, category, reason, status)
       values ($1, $2, $3, 'experian', 'Experian', 'incorrect_balance', 'Balance differs from my statement', $4) returning id`,
      [orgId, clientId, label, status],
    );
    return r!.id;
  });
}

export const asUser = <T>(userId: string, fn: (db: Db) => Promise<T>) => withTenant(userId, fn);
export { withSystem, closePool };
