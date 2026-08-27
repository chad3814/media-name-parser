/**
 * The `user.role` column, read and written in one place.
 *
 * The column is text rather than an enum because the admin plugin treats it as
 * a string and supports comma-separated multiple roles. Two callers need to
 * agree about what that string means -- the guard that reads it and the
 * promote-admin script that writes it -- and a script that wrote `"admin"`
 * over an existing `"support"` would silently strip a role.
 *
 * Comparing `role === 'admin'` would refuse a legitimate admin reading
 * `support,admin`; `role.includes('admin')` would admit
 * `administrator-readonly`. Splitting on commas and matching whole entries is
 * the only reading that gets both right.
 */

export const ADMIN_ROLE = 'admin';

/** The role the column defaults to, and what it falls back to when emptied. */
const DEFAULT_ROLE = 'user';

export function parseRoles(role: string | null | undefined): readonly string[] {
  if (role === null || role === undefined) return [];
  return role.split(',').map((part) => part.trim()).filter((part) => part.length > 0);
}

export function hasRole(role: string | null | undefined, wanted: string): boolean {
  return parseRoles(role).includes(wanted);
}

export function withRole(role: string | null | undefined, wanted: string): string {
  const roles = parseRoles(role);
  if (roles.includes(wanted)) return roles.join(',');
  return [...roles, wanted].join(',');
}

export function withoutRole(role: string | null | undefined, unwanted: string): string {
  const remaining = parseRoles(role).filter((entry) => entry !== unwanted);
  // Never '': the column is NOT NULL DEFAULT 'user', so an empty string would
  // satisfy the constraint while meaning something no other code understands.
  return remaining.length === 0 ? DEFAULT_ROLE : remaining.join(',');
}
