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
  // `role`, `banned` and `banExpires` are contributed by the admin plugin, so
  // they are absent from Better Auth's base user type. Reading them through a
  // narrow record type is the deserialization exception: the values are
  // database columns, not app state.
  const withAdminColumns = session.user as unknown as {
    readonly role?: string | null;
    readonly banned?: boolean | null;
    readonly banExpires?: Date | string | null;
  };
  const role = withAdminColumns.role ?? null;

  // The admin plugin enforces `banned` only when a session is *created*
  // (its session-create hook), so setting the column on a user who already
  // holds a live session is otherwise a no-op -- this is the one place that
  // reads it afterward. A permanent ban has `banExpires` null or absent; an
  // expired one has a `banExpires` in the past and no longer applies.
  //
  // Returning `null` -- "no current user" -- rather than a distinct refusal:
  // this fails closed, and every existing caller already handles the
  // no-user case correctly, so a banned user is treated exactly like an
  // unauthenticated one rather than needing a new branch threaded through
  // every guard.
  if (withAdminColumns.banned === true) {
    const banExpires = withAdminColumns.banExpires;
    const expired = banExpires !== null && banExpires !== undefined
      && new Date(banExpires).getTime() <= Date.now();
    if (!expired) return null;
  }

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
