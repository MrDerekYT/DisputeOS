/**
 * Role-based access control. The database enforces tenant isolation and coarse role tiers (RLS);
 * this map is the application-level source of truth for what each role may do, used by server actions and the UI.
 */
export const ROLES = ['owner', 'admin', 'manager', 'specialist', 'client'] as const;
export type Role = (typeof ROLES)[number];
export const STAFF_ROLES: Role[] = ['owner', 'admin', 'manager', 'specialist'];

export type Permission =
  | 'clients:read' | 'clients:write' | 'clients:assign' | 'clients:delete'
  | 'reports:write'
  | 'disputes:write' | 'disputes:approve'
  | 'letters:write' | 'letters:approve'
  | 'comms:send'
  | 'tasks:manage'
  | 'billing:read' | 'billing:write'
  | 'analytics:read' | 'analytics:team'
  | 'automations:manage' | 'automations:approve'
  | 'team:manage' | 'settings:manage' | 'audit:read';

const SPECIALIST: Permission[] = [
  'clients:read', 'clients:write', 'reports:write', 'disputes:write', 'letters:write', 'comms:send', 'tasks:manage', 'analytics:read',
];
const MANAGER: Permission[] = [
  ...SPECIALIST, 'clients:assign', 'disputes:approve', 'letters:approve', 'billing:read', 'billing:write', 'analytics:team', 'automations:approve',
];
const ADMIN: Permission[] = [...MANAGER, 'clients:delete', 'automations:manage', 'team:manage', 'settings:manage', 'audit:read'];

const MATRIX: Record<Role, ReadonlySet<Permission>> = {
  owner: new Set(ADMIN),
  admin: new Set(ADMIN),
  manager: new Set(MANAGER),
  specialist: new Set(SPECIALIST),
  client: new Set(),
};

export const can = (role: Role | undefined | null, perm: Permission): boolean => (role ? MATRIX[role].has(perm) : false);
export const isStaffRole = (role: string | undefined | null): role is Role => !!role && (STAFF_ROLES as string[]).includes(role);

/** Which roles `actor` may grant. Nobody can mint an owner; admins cannot create other admins. */
export function grantableRoles(actor: Role): Role[] {
  if (actor === 'owner') return ['admin', 'manager', 'specialist'];
  if (actor === 'admin') return ['manager', 'specialist'];
  return [];
}

export class PermissionError extends Error {
  constructor(public perm: Permission) {
    super(`Not permitted: ${perm}`);
  }
}
