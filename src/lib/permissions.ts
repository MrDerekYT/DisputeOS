export const ROLES = ["owner", "admin", "staff", "client"] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = {
  "clients:read": ["owner", "admin", "staff"],
  "clients:write": ["owner", "admin", "staff"],
  "pii:view_full": ["owner", "admin"],
  "disputes:approve_mail": ["owner", "admin", "staff"],
  "billing:manage": ["owner"],
  "members:manage": ["owner", "admin"],
  "audit:read": ["owner", "admin"],
} as const satisfies Record<string, readonly Role[]>;

export type Permission = keyof typeof PERMISSIONS;

export const can = (role: Role | undefined, perm: Permission): boolean =>
  !!role && (PERMISSIONS[perm] as readonly Role[]).includes(role);

/** Staff roles must have an MFA (aal2) session. */
export const requiresMfa = (role: Role): boolean => role !== "client";
