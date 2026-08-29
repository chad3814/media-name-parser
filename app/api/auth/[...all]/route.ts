import { getAuth } from '../../../../lib/auth/server';
import { notFound } from '../../../../lib/http/problem';

/**
 * Better Auth's own routes: sign-in, callback, sign-out, session.
 *
 * The catch-all segment is `[...all]` rather than `[...nextauth]` -- this is
 * Better Auth, not the Auth.js it replaced, and the name is part of its
 * documented contract.
 *
 * Written out rather than destructured from `toNextJsHandler(getAuth())`,
 * which would build the instance when this module loads. `toNextJsHandler` is
 * a five-line convenience that returns the same `auth.handler` under GET,
 * POST, PATCH, PUT and DELETE; we only ever mount GET and POST.
 */

/**
 * The admin plugin's own endpoints are not served.
 *
 * Registering `admin()` is what gives us the `role` column and the schema our
 * conformance test pins, but it also publishes fifteen user-administration
 * endpoints under this catch-all -- including `impersonate-user`, which mints a
 * session for any user, and `set-role`, which writes the role column directly
 * and so bypasses `lib/auth/roles.ts`. A review verified set-role rewriting
 * `support,admin` to `admin`, which is the strip-a-role bug that module exists
 * to prevent. 1.7.1 offers no option to disable them, so the prefix is refused
 * here. Nothing in this service calls them; a later plan that wants one should
 * unblock that path deliberately rather than remove this guard.
 */
function isBlocked(request: Request): boolean {
  return new URL(request.url).pathname.startsWith('/api/auth/admin/');
}

export async function GET(request: Request): Promise<Response> {
  if (isBlocked(request)) return notFound('no such route');
  return getAuth().handler(request);
}

export async function POST(request: Request): Promise<Response> {
  if (isBlocked(request)) return notFound('no such route');
  return getAuth().handler(request);
}
