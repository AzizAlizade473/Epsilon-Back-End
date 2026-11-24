export type Role = 'super_admin' | 'operations' | 'analyst' | 'partner';
export type Permission =
  | 'analytics:read'
  | 'reviews:moderate'
  | 'restaurants:write'
  | 'notifications:draft'
  | 'notifications:test'
  | 'export'
  | 'pii:reveal'
  | 'admins:manage'
  | 'audit:read';

const OPERATIONS: Permission[] = ['analytics:read', 'reviews:moderate', 'restaurants:write', 'notifications:draft', 'notifications:test', 'export'];

/** Server-side only. `partner` is reserved and has nothing until tenant isolation ships. */
export const PERMISSIONS: Record<Role, readonly Permission[]> = {
  super_admin: [...OPERATIONS, 'pii:reveal', 'admins:manage', 'audit:read'],
  operations: OPERATIONS,
  analyst: ['analytics:read', 'export'],
  partner: [],
};

export const can = (role: Role, permission: Permission) => PERMISSIONS[role].includes(permission);
