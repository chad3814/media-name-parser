import { getAuth } from './server';
import { hasRole, parseRoles, ADMIN_ROLE } from './roles';
import { forbidden, unauthorized, unavailable } from '../http/problem';
import { logFailure } from '../http/log';

export interface CurrentUser {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly roles: readonly string[];
  readonly isAdmin: boolean;
}

export type Guard<T> =
  | { readonly ok: true; readonly user: T }
  | { readonly ok: false; readonly response: Response };

export async function getCurrentUser(headers: Headers): Promise<CurrentUser | null> {
  const session = await getAuth().api.getSession({ headers });
  if (session === null) return null;
  // `role` is contributed by the admin plugin, so it is absent from Better
  // Auth's base user type. Reading it through a narrow record type is the
  // deserialization exception: the value is a database column, not app state.
  const withRoleColumn = session.user as unknown as { readonly role?: string | null };
  const role = withRoleColumn.role ?? null;
  return {
    id: session.user.id,
    email: session.user.email,
    name: session.user.name,
    roles: parseRoles(role),
    isAdmin: hasRole(role, ADMIN_ROLE),
  };
}

export async function requireUser(headers: Headers): Promise<Guard<CurrentUser>> {
  try {
    const user = await getCurrentUser(headers);
    if (user === null) return { ok: false, response: unauthorized('sign in to continue') };
    return { ok: true, user };
  } catch (error) {
    // A 5xx with no corresponding log line cannot be diagnosed from outside.
    logFailure('requireUser', error);
    return { ok: false, response: unavailable('the session could not be read') };
  }
}

/**
 * Admin or a refusal.
 *
 * A signed-in non-admin gets 403, not 401: they authenticated successfully and
 * telling them to authenticate again is a lie. 404 was considered -- not
 * revealing the route exists -- and rejected, because the route's existence is
 * not a secret worth protecting and 403 tells an honest user with the wrong
 * role something actionable.
 */
export async function requireAdmin(headers: Headers): Promise<Guard<CurrentUser>> {
  const guard = await requireUser(headers);
  if (!guard.ok) return guard;
  if (!guard.user.isAdmin) {
    return { ok: false, response: forbidden('this area requires the admin role') };
  }
  return guard;
}
